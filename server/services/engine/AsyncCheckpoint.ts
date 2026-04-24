import { logError } from '../../utils/logger';
/**
 * ============================================================================
 * CHECKPOINT E LOGS ASSÍNCRONOS
 * ============================================================================
 * 
 * Sistema de checkpoint e logging que NUNCA bloqueia o loop de envio.
 * Usa fila interna e processamento em background.
 * 
 * Características:
 * - Fire-and-forget para logs
 * - Buffer de checkpoints com flush periódico
 * - Garantia de persistência eventual
 * - Recuperação de estado para retomada
 */

export interface CheckpointData {
  campaignId: string;
  phoneNumberId: string;
  lastProcessedIndex: number;
  successCount: number;
  failedCount: number;
  currentIntervalMs: number;
  tokenBucketState: {
    tokens: number;
    refillRate: number;
  };
  timestamp: number;
  version: number;
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: any;
  timestamp: number;
}

type CheckpointCallback = (checkpoint: CheckpointData) => Promise<void>;

export class AsyncCheckpoint {
  private checkpointBuffer: CheckpointData | null = null;
  private logBuffer: LogEntry[] = [];
  private flushIntervalMs: number;
  private maxLogBuffer: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing: boolean = false;
  private onCheckpointSave?: CheckpointCallback;
  private version: number = 0;
  private lastSavedVersion: number = 0;

  constructor(config: {
    flushIntervalMs?: number;
    maxLogBuffer?: number;
    onCheckpointSave?: CheckpointCallback;
  } = {}) {
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.maxLogBuffer = config.maxLogBuffer ?? 100;
    this.onCheckpointSave = config.onCheckpointSave;
    
    this.startFlushTimer();
  }

  /**
   * Inicia timer de flush periódico
   */
  private startFlushTimer(): void {
    if (this.flushTimer) return;
    
    this.flushTimer = setInterval(() => {
      this.flushAsync();
    }, this.flushIntervalMs);
  }

  /**
   * Salva checkpoint de forma assíncrona (não bloqueia o loop de envio).
   * O checkpoint é gravado imediatamente em background via microtask —
   * não espera o timer periódico, garantindo durabilidade por mensagem.
   */
  saveCheckpoint(data: Omit<CheckpointData, 'timestamp' | 'version'>): void {
    this.version++;

    this.checkpointBuffer = {
      ...data,
      timestamp: Date.now(),
      version: this.version
    };

    // Trigger immediate persist in background (no await — does not block caller)
    if (this.onCheckpointSave && !this.isFlushing) {
      const snapshot = { ...this.checkpointBuffer };
      const savedVersion = snapshot.version;
      this.onCheckpointSave(snapshot).then(() => {
        if (savedVersion > this.lastSavedVersion) {
          this.lastSavedVersion = savedVersion;
        }
      }).catch((err: Error) => {
        logError('AsyncCheckpoint.immediatePersist', { savedVersion }, err);
      });
    }
  }

  /**
   * Log assíncrono (nunca bloqueia)
   */
  log(level: LogEntry['level'], message: string, data?: any): void {
    this.logBuffer.push({
      level,
      message,
      data,
      timestamp: Date.now()
    });
    
    if (this.logBuffer.length >= this.maxLogBuffer) {
      this.flushLogs();
    }
  }

  /**
   * Log de debug
   */
  debug(message: string, data?: any): void {
    this.log('debug', message, data);
  }

  /**
   * Log de info
   */
  info(message: string, data?: any): void {
    this.log('info', message, data);
  }

  /**
   * Log de warning
   */
  warn(message: string, data?: any): void {
    this.log('warn', message, data);
  }

  /**
   * Log de error
   */
  error(message: string, data?: any): void {
    this.log('error', message, data);
  }

  /**
   * Flush assíncrono de checkpoint e logs
   */
  private async flushAsync(): Promise<void> {
    if (this.isFlushing) return;
    
    this.isFlushing = true;
    
    try {
      await Promise.all([
        this.flushCheckpoint(),
        this.flushLogs()
      ]);
    } catch (error) {
      logError('[AsyncCheckpoint] Erro no flush:', {}, error);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Flush checkpoint para storage
   */
  private async flushCheckpoint(): Promise<void> {
    if (!this.checkpointBuffer) return;
    if (this.checkpointBuffer.version <= this.lastSavedVersion) return;
    
    const checkpoint = { ...this.checkpointBuffer };
    
    try {
      if (this.onCheckpointSave) {
        await this.onCheckpointSave(checkpoint);
      }
      
      this.lastSavedVersion = checkpoint.version;
    } catch (error) {
      logError('[AsyncCheckpoint] Erro ao salvar checkpoint:', {}, error);
    }
  }

  /**
   * Flush logs para console (ou storage)
   */
  private async flushLogs(): Promise<void> {
    if (this.logBuffer.length === 0) return;
    
    const logs = [...this.logBuffer];
    this.logBuffer = [];
    
    for (const entry of logs) {
      const timestamp = new Date(entry.timestamp).toISOString().slice(11, 23);
      const prefix = this.getLogPrefix(entry.level);
      
      if (entry.data) {
        console.log(`${prefix} [${timestamp}] ${entry.message}`, entry.data);
      } else {
        console.log(`${prefix} [${timestamp}] ${entry.message}`);
      }
    }
  }

  /**
   * Retorna prefixo de log por nível
   */
  private getLogPrefix(level: LogEntry['level']): string {
    switch (level) {
      case 'debug': return '🔍';
      case 'info': return 'ℹ️';
      case 'warn': return '⚠️';
      case 'error': return '❌';
    }
  }

  /**
   * Força flush imediato (para shutdown)
   */
  async forceFlush(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    await this.flushAsync();
  }

  /**
   * Retorna último checkpoint salvo
   */
  getLastCheckpoint(): CheckpointData | null {
    return this.checkpointBuffer;
  }

  /**
   * Retorna estatísticas
   */
  getStats(): {
    pendingLogs: number;
    lastCheckpointVersion: number;
    lastSavedVersion: number;
    hasPendingCheckpoint: boolean;
  } {
    return {
      pendingLogs: this.logBuffer.length,
      lastCheckpointVersion: this.version,
      lastSavedVersion: this.lastSavedVersion,
      hasPendingCheckpoint: this.checkpointBuffer !== null && 
        this.checkpointBuffer.version > this.lastSavedVersion
    };
  }

  /**
   * Para o sistema de checkpoint
   */
  async stop(): Promise<void> {
    await this.forceFlush();
  }

  /**
   * Define callback de save
   */
  setOnCheckpointSave(callback: CheckpointCallback): void {
    this.onCheckpointSave = callback;
  }
}

/**
 * Logger singleton para uso global
 */
let globalLogger: AsyncCheckpoint | null = null;

export function getGlobalLogger(): AsyncCheckpoint {
  if (!globalLogger) {
    globalLogger = new AsyncCheckpoint({
      flushIntervalMs: 2000,
      maxLogBuffer: 50
    });
  }
  return globalLogger;
}
