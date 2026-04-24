import crypto from 'crypto';
import { logError } from '../../utils/logger';
/**
 * ============================================================================
 * RETRY QUEUE NÃO-BLOQUEANTE
 * ============================================================================
 * 
 * Sistema de retry que NUNCA bloqueia slots do pipeline.
 * Leads com falha são re-enfileirados com nextRetryAt.
 * Slots voltam imediatamente para novos leads.
 * 
 * Características:
 * - Fila separada do pipeline principal
 * - Respeita TokenBucket
 * - Máximo de 3 tentativas por lead
 * - Retry só ocorre se circuito CLOSED ou HALF_OPEN
 * - Backoff exponencial entre tentativas
 */

export interface RetryItem<T = any> {
  leadIndex: number;
  leadData: T;
  attempts: number;
  lastError: string;
  lastErrorCode?: number;
  nextRetryAt: number;
  firstAttemptAt: number;
  isRateLimitError: boolean;
}

export interface RetryQueueConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  rateLimitDelayMs: number;
  backoffMultiplier: number;
}

export interface RetryQueueStats {
  queueLength: number;
  totalRetried: number;
  totalExhausted: number;
  totalRecovered: number;
  oldestItemAgeMs: number;
  nextRetryInMs: number;
}

export class RetryQueue<T = any> {
  private config: RetryQueueConfig;
  private queue: RetryItem<T>[] = [];
  private totalRetried: number = 0;
  private totalExhausted: number = 0;
  private totalRecovered: number = 0;
  private isProcessing: boolean = false;
  private processTimer: ReturnType<typeof setTimeout> | null = null;
  
  private onRetryCallback?: (item: RetryItem<T>) => Promise<{ success: boolean; error?: string; isRateLimitError?: boolean }>;
  private onExhaustedCallback?: (item: RetryItem<T>) => void;
  private canRetryCheck?: () => boolean;

  constructor(config?: Partial<RetryQueueConfig>) {
    this.config = {
      maxRetries: config?.maxRetries ?? 3,
      baseDelayMs: config?.baseDelayMs ?? 2000,
      maxDelayMs: config?.maxDelayMs ?? 120000,
      rateLimitDelayMs: config?.rateLimitDelayMs ?? 30000,
      backoffMultiplier: config?.backoffMultiplier ?? 2.0
    };
  }

  /**
   * Define callback de retry
   */
  setRetryCallback(
    callback: (item: RetryItem<T>) => Promise<{ success: boolean; error?: string; isRateLimitError?: boolean }>
  ): void {
    this.onRetryCallback = callback;
  }

  /**
   * Define callback quando tentativas se esgotam
   */
  setExhaustedCallback(callback: (item: RetryItem<T>) => void): void {
    this.onExhaustedCallback = callback;
  }

  /**
   * Define função para verificar se pode fazer retry
   */
  setCanRetryCheck(check: () => boolean): void {
    this.canRetryCheck = check;
  }

  /**
   * Enfileira lead para retry (NÃO BLOQUEIA)
   */
  private isRetryableError(error: string, errorCode?: number, isRateLimitError?: boolean): boolean {
    if (isRateLimitError) return true;

    if (errorCode) {
      if (errorCode === 429) return true;
      if (errorCode >= 500) return true;
    }

    const errorLower = error.toLowerCase();
    if (errorLower.includes('econnaborted') || errorLower.includes('timeout')) return true;
    if (errorLower.includes('429') || errorLower.includes('rate')) return true;
    if (errorLower.includes('5xx') || /\b5\d{2}\b/.test(error)) return true;

    if (errorLower.includes('policy') || errorLower.includes('template') ||
        errorLower.includes('invalid_phone') || errorLower.includes('invalid phone') ||
        errorLower.includes('bloqueio') || errorLower.includes('blocked')) return false;
    if (errorCode === 400) return false;

    return false;
  }

  private static readonly MAX_QUEUE_SIZE = 500;

  enqueue(
    leadIndex: number,
    leadData: T,
    error: string,
    errorCode?: number,
    isRateLimitError: boolean = false,
    previousAttempts: number = 0
  ): boolean {
    if (this.queue.length >= RetryQueue.MAX_QUEUE_SIZE) {
      logError('retryQueue.queueFull', { leadIndex, queueSize: this.queue.length, error, errorCode }, new Error('RetryQueue at capacity — lead dropped'));
      return false;
    }

    if (!this.isRetryableError(error, errorCode, isRateLimitError)) {
      const exhaustedItem: RetryItem<T> = {
        leadIndex,
        leadData,
        attempts: previousAttempts + 1,
        lastError: error,
        lastErrorCode: errorCode,
        nextRetryAt: 0,
        firstAttemptAt: Date.now(),
        isRateLimitError
      };
      this.totalExhausted++;
      this.onExhaustedCallback?.(exhaustedItem);
      return false;
    }

    const attempts = previousAttempts + 1;
    
    if (attempts > this.config.maxRetries) {
      const exhaustedItem: RetryItem<T> = {
        leadIndex,
        leadData,
        attempts,
        lastError: error,
        lastErrorCode: errorCode,
        nextRetryAt: 0,
        firstAttemptAt: Date.now(),
        isRateLimitError
      };
      
      this.totalExhausted++;
      this.onExhaustedCallback?.(exhaustedItem);
      return false;
    }
    
    const delay = this.calculateDelay(attempts, isRateLimitError);
    const nextRetryAt = Date.now() + delay;
    
    const item: RetryItem<T> = {
      leadIndex,
      leadData,
      attempts,
      lastError: error,
      lastErrorCode: errorCode,
      nextRetryAt,
      firstAttemptAt: Date.now(),
      isRateLimitError
    };
    
    this.queue.push(item);
    this.queue.sort((a, b) => a.nextRetryAt - b.nextRetryAt);
    
    this.scheduleNextProcess();
    
    return true;
  }

  /**
   * Calcula delay com backoff exponencial
   * Delays fixos: 3000ms, 6000ms, 12000ms
   */
  private calculateDelay(attempts: number, isRateLimitError: boolean): number {
    if (isRateLimitError) {
      const rateLimitDelays = [30000, 60000, 120000];
      const baseDelay = rateLimitDelays[Math.min(attempts - 1, rateLimitDelays.length - 1)];
      const jitter = crypto.randomInt(0, Math.max(1, Math.floor(baseDelay * 0.2)));
      return Math.min(baseDelay + jitter, this.config.maxDelayMs);
    }

    const backoffDelays = [3000, 8000, 15000];
    const baseDelay = backoffDelays[Math.min(attempts - 1, backoffDelays.length - 1)];
    const jitter = crypto.randomInt(0, Math.max(1, Math.floor(baseDelay * 0.2)));
    return Math.min(baseDelay + jitter, this.config.maxDelayMs);
  }

  /**
   * Agenda próximo processamento
   */
  private scheduleNextProcess(): void {
    if (this.processTimer) return;
    if (this.queue.length === 0) return;
    
    const now = Date.now();
    const nextItem = this.queue[0];
    const delay = Math.max(0, nextItem.nextRetryAt - now);
    
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      this.processQueue();
    }, delay);
  }

  /**
   * Processa itens prontos na fila
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    if (!this.onRetryCallback) return;
    
    this.isProcessing = true;
    const now = Date.now();
    
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        
        if (item.nextRetryAt > now) {
          break;
        }
        
        if (this.canRetryCheck && !this.canRetryCheck()) {
          await this.sleep(1000);
          continue;
        }
        
        this.queue.shift();
        this.totalRetried++;
        
        try {
          const result = await this.onRetryCallback(item);
          
          if (result.success) {
            this.totalRecovered++;
          } else {
            this.enqueue(
              item.leadIndex,
              item.leadData,
              result.error || item.lastError,
              item.lastErrorCode,
              result.isRateLimitError ?? item.isRateLimitError,
              item.attempts
            );
          }
        } catch (error: any) {
          this.enqueue(
            item.leadIndex,
            item.leadData,
            error.message || 'Unknown error',
            undefined,
            false,
            item.attempts
          );
        }
      }
    } finally {
      this.isProcessing = false;
      this.scheduleNextProcess();
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Força processamento imediato (para drain)
   */
  async processNow(): Promise<void> {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    
    for (const item of this.queue) {
      item.nextRetryAt = Date.now();
    }
    
    await this.processQueue();
  }

  /**
   * Aguarda fila esvaziar completamente
   */
  async drain(): Promise<void> {
    const maxWaitMs = 60000;
    const startTime = Date.now();
    
    while (this.queue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > maxWaitMs) {
        console.warn(`[RetryQueue] Timeout ao drenar fila. ${this.queue.length} itens restantes.`);
        break;
      }
      
      if (!this.isProcessing && this.queue.length > 0) {
        await this.processNow();
      }
      
      await this.sleep(100);
    }
  }

  /**
   * Retorna estatísticas
   */
  getStats(): RetryQueueStats {
    const now = Date.now();
    const oldestItem = this.queue.length > 0 ? this.queue[0] : null;
    
    return {
      queueLength: this.queue.length,
      totalRetried: this.totalRetried,
      totalExhausted: this.totalExhausted,
      totalRecovered: this.totalRecovered,
      oldestItemAgeMs: oldestItem ? now - oldestItem.firstAttemptAt : 0,
      nextRetryInMs: oldestItem ? Math.max(0, oldestItem.nextRetryAt - now) : 0
    };
  }

  /**
   * Verifica se fila está vazia
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Retorna tamanho da fila
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Limpa fila e para processamento
   */
  clear(): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = null;
    }
    
    this.queue = [];
    this.isProcessing = false;
  }

  /**
   * Reseta contadores
   */
  reset(): void {
    this.clear();
    this.totalRetried = 0;
    this.totalExhausted = 0;
    this.totalRecovered = 0;
  }

  /**
   * Retorna itens pendentes (para debug)
   */
  getPendingItems(): RetryItem<T>[] {
    return [...this.queue];
  }
}
