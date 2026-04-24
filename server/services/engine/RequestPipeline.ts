import { logError } from '../../utils/logger';
/**
 * ============================================================================
 * REQUEST PIPELINE COM OVERLAP
 * ============================================================================
 * 
 * Pipeline que mantém N requests em voo simultaneamente.
 * Nunca bloqueia o loop esperando resposta individual.
 * 
 * Características:
 * - Prefetch de próximos 3-5 leads enquanto request em voo
 * - Semáforo para limitar concorrência por número
 * - Resultado processado assim que disponível
 * - Backpressure quando fila atinge limite
 */

export interface PipelineConfig {
  maxConcurrentRequests: number;
  prefetchCount: number;
  queueHighWaterMark: number;
  drainLowWaterMark: number;
}

export interface PendingRequest<T> {
  id: string;
  promise: Promise<T>;
  startTime: number;
  leadIndex: number;
}

export interface PipelineStats {
  inFlight: number;
  queued: number;
  completed: number;
  avgLatencyMs: number;
  maxConcurrentReached: number;
  backpressureEvents: number;
}

type ResultCallback<T> = (result: T, leadIndex: number, rttMs: number) => void;

export class RequestPipeline<T> {
  private config: PipelineConfig;
  private pending: Map<string, PendingRequest<T>> = new Map();
  private completed: number = 0;
  private totalLatency: number = 0;
  private maxConcurrentReached: number = 0;
  private backpressureEvents: number = 0;
  private isPaused: boolean = false;
  private onResult?: ResultCallback<T>;
  private idCounter: number = 0;

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = {
      maxConcurrentRequests: config.maxConcurrentRequests ?? 12,
      prefetchCount: config.prefetchCount ?? 5,
      queueHighWaterMark: config.queueHighWaterMark ?? 10,
      drainLowWaterMark: config.drainLowWaterMark ?? 3
    };
  }

  /**
   * Define callback para resultados
   */
  setResultCallback(callback: ResultCallback<T>): void {
    this.onResult = callback;
  }

  /**
   * Verifica se pode submeter novo request
   */
  canSubmit(): boolean {
    return this.pending.size < this.config.maxConcurrentRequests && !this.isPaused;
  }

  /**
   * Retorna quantos slots estão disponíveis
   */
  availableSlots(): number {
    if (this.isPaused) return 0;
    return Math.max(0, this.config.maxConcurrentRequests - this.pending.size);
  }

  /**
   * Submete request ao pipeline
   * @returns ID do request para tracking
   */
  submit(
    requestFn: () => Promise<T>,
    leadIndex: number
  ): string | null {
    if (!this.canSubmit()) {
      return null;
    }

    const id = `req_${++this.idCounter}`;
    const startTime = Date.now();

    const wrappedPromise = Promise.resolve()
      .then(() => requestFn())
      .then(result => {
        this.handleCompletion(id, result, null);
        return result;
      })
      .catch(error => {
        this.handleCompletion(id, null as any, error);
        throw error;
      });

    this.pending.set(id, {
      id,
      promise: wrappedPromise,
      startTime,
      leadIndex
    });

    if (this.pending.size > this.maxConcurrentReached) {
      this.maxConcurrentReached = this.pending.size;
    }

    if (this.pending.size >= this.config.queueHighWaterMark) {
      this.isPaused = true;
      this.backpressureEvents++;
    }

    return id;
  }

  /**
   * Submete batch de requests
   */
  submitBatch(
    requests: Array<{ fn: () => Promise<T>; leadIndex: number }>
  ): string[] {
    const ids: string[] = [];
    
    for (const req of requests) {
      const id = this.submit(req.fn, req.leadIndex);
      if (id) {
        ids.push(id);
      } else {
        break;
      }
    }
    
    return ids;
  }

  private onError?: (error: Error, leadIndex: number, rttMs: number) => void;

  setErrorCallback(callback: (error: Error, leadIndex: number, rttMs: number) => void): void {
    this.onError = callback;
  }

  private handleCompletion(id: string, result: T | null, error: Error | null): void {
    const request = this.pending.get(id);
    if (!request) return;

    const rttMs = Date.now() - request.startTime;
    this.totalLatency += rttMs;
    this.completed++;

    this.pending.delete(id);

    if (this.isPaused && this.pending.size <= this.config.drainLowWaterMark) {
      this.isPaused = false;
    }

    try {
      if (result !== null && this.onResult) {
        this.onResult(result, request.leadIndex, rttMs);
      } else if (error && this.onError) {
        this.onError(error, request.leadIndex, rttMs);
      }
    } catch (callbackErr: any) {
      logError('requestPipeline.callbackError', { leadIndex: request.leadIndex }, callbackErr);
    }
  }

  /**
   * Aguarda pelo menos um request completar
   */
  async waitForAny(): Promise<void> {
    if (this.pending.size === 0) return;

    const promises = Array.from(this.pending.values()).map(p => 
      p.promise.catch(() => {})
    );

    await Promise.race(promises);
  }

  /**
   * Aguarda todos os requests completarem
   */
  async waitForAll(): Promise<void> {
    if (this.pending.size === 0) return;

    const promises = Array.from(this.pending.values()).map(p => 
      p.promise.catch(() => {})
    );

    await Promise.all(promises);
  }

  /**
   * Aguarda até ter slots disponíveis
   */
  async waitForSlot(): Promise<void> {
    while (!this.canSubmit() && this.pending.size > 0) {
      await this.waitForAny();
    }
  }

  /**
   * Drena pipeline completamente
   */
  async drain(): Promise<void> {
    await this.waitForAll();
  }

  /**
   * Retorna número de requests em voo
   */
  inFlightCount(): number {
    return this.pending.size;
  }

  /**
   * Retorna estatísticas
   */
  getStats(): PipelineStats {
    return {
      inFlight: this.pending.size,
      queued: 0,
      completed: this.completed,
      avgLatencyMs: this.completed > 0 ? this.totalLatency / this.completed : 0,
      maxConcurrentReached: this.maxConcurrentReached,
      backpressureEvents: this.backpressureEvents
    };
  }

  /**
   * Reseta estatísticas
   */
  reset(): void {
    this.pending.clear();
    this.completed = 0;
    this.totalLatency = 0;
    this.maxConcurrentReached = 0;
    this.backpressureEvents = 0;
    this.isPaused = false;
    this.idCounter = 0;
  }

  /**
   * Força pausa do pipeline
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * Resume pipeline
   */
  resume(): void {
    this.isPaused = false;
  }

  /**
   * Verifica se está pausado
   */
  isPausedState(): boolean {
    return this.isPaused;
  }
}
