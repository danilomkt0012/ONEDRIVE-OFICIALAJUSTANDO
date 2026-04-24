/**
 * ============================================================================
 * HEALTH MONITOR - MONITORAMENTO DE SAÚDE POR NÚMERO
 * ============================================================================
 * 
 * Classifica o estado de saúde do envio em tempo real:
 * - HEALTHY: Sistema operando normalmente
 * - DEGRADED: Sinais de stress, reduzir velocidade
 * - CRITICAL: Risco iminente de falha, pausar envio
 * 
 * Sinais monitorados:
 * - RTT p95/p99 (latência)
 * - Erros por minuto
 * - Trips do circuit breaker
 * - Taxa de sucesso
 */

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export interface HealthThresholds {
  // RTT thresholds
  rttP95HealthyMs: number;
  rttP95DegradedMs: number;
  rttP99HealthyMs: number;
  rttP99DegradedMs: number;
  
  // Error thresholds
  errorsPerMinuteHealthy: number;
  errorsPerMinuteDegraded: number;
  
  // Circuit breaker thresholds
  circuitBreakerTripsHealthy: number;
  circuitBreakerTripsDegraded: number;
  
  // Success rate thresholds
  successRateHealthy: number;
  successRateDegraded: number;
  
  // Stability window (how long to stay healthy before upgrading state)
  stabilityWindowMs: number;
  
  // Minimum samples before evaluating
  minSamplesForEvaluation: number;
}

export interface HealthMetrics {
  rttP95Ms: number;
  rttP99Ms: number;
  errorsPerMinute: number;
  circuitBreakerTrips: number;
  successRate: number;
  totalSent: number;
  totalErrors: number;
}

export interface HealthSnapshot {
  state: HealthState;
  previousState: HealthState;
  metrics: HealthMetrics;
  stateChangedAt: number;
  timeInCurrentState: number;
  degradedReasons: string[];
  criticalReasons: string[];
  recommendation: HealthRecommendation;
}

export interface HealthRecommendation {
  action: 'CONTINUE' | 'SLOW_DOWN' | 'PAUSE' | 'STOP';
  rateMultiplier: number;
  pauseDurationMs: number;
  message: string;
}

export interface HealthEvent {
  timestamp: number;
  previousState: HealthState;
  newState: HealthState;
  reasons: string[];
  metrics: HealthMetrics;
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  rttP95HealthyMs: 250,
  rttP95DegradedMs: 400,
  rttP99HealthyMs: 350,
  rttP99DegradedMs: 500,
  errorsPerMinuteHealthy: 2,
  errorsPerMinuteDegraded: 5,
  circuitBreakerTripsHealthy: 1,
  circuitBreakerTripsDegraded: 3,
  successRateHealthy: 99.0,
  successRateDegraded: 97.0,
  stabilityWindowMs: 30000,
  minSamplesForEvaluation: 10
};

export class HealthMonitor {
  private thresholds: HealthThresholds;
  private currentState: HealthState = 'HEALTHY';
  private previousState: HealthState = 'HEALTHY';
  private stateChangedAt: number = Date.now();
  private lastHealthyAt: number = Date.now();
  private lastDegradedAt: number = 0;
  private lastCriticalAt: number = 0;
  
  // Metrics tracking
  private rttSamples: number[] = [];
  private errorTimestamps: number[] = [];
  private circuitBreakerTrips: number = 0;
  private totalSent: number = 0;
  private totalErrors: number = 0;
  
  // Event history
  private eventHistory: HealthEvent[] = [];
  private maxEventHistory: number = 50;
  
  private onStateChangeCallbacks: Array<(event: HealthEvent) => void> = [];
  private onCriticalCallbacks: Array<(snapshot: HealthSnapshot) => void> = [];
  private onRecoveryCallbacks: Array<(snapshot: HealthSnapshot) => void> = [];

  constructor(thresholds?: Partial<HealthThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Registra callback para mudança de estado
   */
  onStateChange(callback: (event: HealthEvent) => void): void {
    this.onStateChangeCallbacks.push(callback);
  }

  onCritical(callback: (snapshot: HealthSnapshot) => void): void {
    this.onCriticalCallbacks.push(callback);
  }

  onRecovery(callback: (snapshot: HealthSnapshot) => void): void {
    this.onRecoveryCallbacks.push(callback);
  }

  /**
   * Registra amostra de RTT
   */
  recordRtt(rttMs: number): void {
    this.rttSamples.push(rttMs);
    
    // Keep last 100 samples
    while (this.rttSamples.length > 100) {
      this.rttSamples.shift();
    }
    
    this.evaluateHealth();
  }

  /**
   * Registra resultado de envio
   */
  recordSend(success: boolean, rttMs?: number): void {
    this.totalSent++;
    
    if (!success) {
      this.totalErrors++;
      this.errorTimestamps.push(Date.now());
      
      // Keep only errors from last 5 minutes
      const fiveMinutesAgo = Date.now() - 300000;
      this.errorTimestamps = this.errorTimestamps.filter(t => t > fiveMinutesAgo);
    }
    
    if (rttMs !== undefined) {
      this.recordRtt(rttMs);
    } else {
      this.evaluateHealth();
    }
  }

  /**
   * Registra trip do circuit breaker
   */
  recordCircuitBreakerTrip(): void {
    this.circuitBreakerTrips++;
    this.evaluateHealth();
  }

  /**
   * Calcula métricas atuais
   */
  private calculateMetrics(): HealthMetrics {
    const rttP95 = this.calculatePercentile(95);
    const rttP99 = this.calculatePercentile(99);
    
    // Errors in last minute
    const oneMinuteAgo = Date.now() - 60000;
    const errorsLastMinute = this.errorTimestamps.filter(t => t > oneMinuteAgo).length;
    
    // Success rate
    const successRate = this.totalSent > 0 
      ? ((this.totalSent - this.totalErrors) / this.totalSent) * 100 
      : 100;
    
    return {
      rttP95Ms: rttP95,
      rttP99Ms: rttP99,
      errorsPerMinute: errorsLastMinute,
      circuitBreakerTrips: this.circuitBreakerTrips,
      successRate,
      totalSent: this.totalSent,
      totalErrors: this.totalErrors
    };
  }

  /**
   * Calcula percentil dos RTT samples
   */
  private calculatePercentile(percentile: number): number {
    if (this.rttSamples.length === 0) return 0;
    
    const sorted = [...this.rttSamples].sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  /**
   * Avalia saúde e atualiza estado
   */
  private evaluateHealth(): void {
    if (this.totalSent < this.thresholds.minSamplesForEvaluation) {
      return; // Not enough data
    }
    
    const metrics = this.calculateMetrics();
    const { state, degradedReasons, criticalReasons } = this.classifyHealth(metrics);
    
    if (state !== this.currentState) {
      this.transitionToState(state, degradedReasons, criticalReasons, metrics);
    }
  }

  /**
   * Classifica estado de saúde baseado nas métricas
   */
  private classifyHealth(metrics: HealthMetrics): {
    state: HealthState;
    degradedReasons: string[];
    criticalReasons: string[];
  } {
    const degradedReasons: string[] = [];
    const criticalReasons: string[] = [];
    
    // Check RTT p95
    if (metrics.rttP95Ms > this.thresholds.rttP95DegradedMs) {
      criticalReasons.push(`RTT p95 ${metrics.rttP95Ms.toFixed(0)}ms > ${this.thresholds.rttP95DegradedMs}ms`);
    } else if (metrics.rttP95Ms > this.thresholds.rttP95HealthyMs) {
      degradedReasons.push(`RTT p95 ${metrics.rttP95Ms.toFixed(0)}ms > ${this.thresholds.rttP95HealthyMs}ms`);
    }
    
    // Check RTT p99
    if (metrics.rttP99Ms > this.thresholds.rttP99DegradedMs) {
      criticalReasons.push(`RTT p99 ${metrics.rttP99Ms.toFixed(0)}ms > ${this.thresholds.rttP99DegradedMs}ms`);
    } else if (metrics.rttP99Ms > this.thresholds.rttP99HealthyMs) {
      degradedReasons.push(`RTT p99 ${metrics.rttP99Ms.toFixed(0)}ms > ${this.thresholds.rttP99HealthyMs}ms`);
    }
    
    // Check errors per minute
    if (metrics.errorsPerMinute > this.thresholds.errorsPerMinuteDegraded) {
      criticalReasons.push(`${metrics.errorsPerMinute} erros/min > ${this.thresholds.errorsPerMinuteDegraded}`);
    } else if (metrics.errorsPerMinute > this.thresholds.errorsPerMinuteHealthy) {
      degradedReasons.push(`${metrics.errorsPerMinute} erros/min > ${this.thresholds.errorsPerMinuteHealthy}`);
    }
    
    // Check circuit breaker trips
    if (metrics.circuitBreakerTrips > this.thresholds.circuitBreakerTripsDegraded) {
      criticalReasons.push(`${metrics.circuitBreakerTrips} CB trips > ${this.thresholds.circuitBreakerTripsDegraded}`);
    } else if (metrics.circuitBreakerTrips > this.thresholds.circuitBreakerTripsHealthy) {
      degradedReasons.push(`${metrics.circuitBreakerTrips} CB trips > ${this.thresholds.circuitBreakerTripsHealthy}`);
    }
    
    // Check success rate
    if (metrics.successRate < this.thresholds.successRateDegraded) {
      criticalReasons.push(`Taxa sucesso ${metrics.successRate.toFixed(1)}% < ${this.thresholds.successRateDegraded}%`);
    } else if (metrics.successRate < this.thresholds.successRateHealthy) {
      degradedReasons.push(`Taxa sucesso ${metrics.successRate.toFixed(1)}% < ${this.thresholds.successRateHealthy}%`);
    }
    
    // Determine state
    let state: HealthState;
    if (criticalReasons.length >= 2 || 
        (criticalReasons.length >= 1 && degradedReasons.length >= 2)) {
      state = 'CRITICAL';
    } else if (criticalReasons.length >= 1 || degradedReasons.length >= 2) {
      state = 'DEGRADED';
    } else {
      state = 'HEALTHY';
    }
    
    return { state, degradedReasons, criticalReasons };
  }

  /**
   * Transiciona para novo estado
   */
  private transitionToState(
    newState: HealthState,
    degradedReasons: string[],
    criticalReasons: string[],
    metrics: HealthMetrics
  ): void {
    const event: HealthEvent = {
      timestamp: Date.now(),
      previousState: this.currentState,
      newState,
      reasons: newState === 'CRITICAL' ? criticalReasons : degradedReasons,
      metrics
    };
    
    // Update state
    this.previousState = this.currentState;
    this.currentState = newState;
    this.stateChangedAt = Date.now();
    
    // Update timestamps
    if (newState === 'HEALTHY') {
      this.lastHealthyAt = Date.now();
    } else if (newState === 'DEGRADED') {
      this.lastDegradedAt = Date.now();
    } else if (newState === 'CRITICAL') {
      this.lastCriticalAt = Date.now();
    }
    
    // Record event
    this.eventHistory.push(event);
    while (this.eventHistory.length > this.maxEventHistory) {
      this.eventHistory.shift();
    }
    
    // Log transition
    const stateEmoji = {
      'HEALTHY': '✅',
      'DEGRADED': '⚠️',
      'CRITICAL': '🔴'
    };
    
    console.log(`\n${stateEmoji[newState]} HealthMonitor: ${this.previousState} → ${newState}`);
    if (event.reasons.length > 0) {
      console.log(`   Motivos: ${event.reasons.join(', ')}`);
    }
    
    for (const cb of this.onStateChangeCallbacks) { try { cb(event); } catch (_e) { /* skip */ } }
    
    if (newState === 'CRITICAL') {
      const snapshot = this.getSnapshot();
      for (const cb of this.onCriticalCallbacks) { try { cb(snapshot); } catch (_e) { /* skip */ } }
    } else if (this.previousState === 'CRITICAL') {
      const snapshot = this.getSnapshot();
      for (const cb of this.onRecoveryCallbacks) { try { cb(snapshot); } catch (_e) { /* skip */ } }
    }
  }

  /**
   * Retorna snapshot atual da saúde
   */
  getSnapshot(): HealthSnapshot {
    const metrics = this.calculateMetrics();
    const { degradedReasons, criticalReasons } = this.classifyHealth(metrics);
    
    return {
      state: this.currentState,
      previousState: this.previousState,
      metrics,
      stateChangedAt: this.stateChangedAt,
      timeInCurrentState: Date.now() - this.stateChangedAt,
      degradedReasons,
      criticalReasons,
      recommendation: this.getRecommendation()
    };
  }

  /**
   * Retorna recomendação baseada no estado atual
   */
  getRecommendation(): HealthRecommendation {
    const timeInState = Date.now() - this.stateChangedAt;
    
    switch (this.currentState) {
      case 'HEALTHY':
        return {
          action: 'CONTINUE',
          rateMultiplier: 1.0,
          pauseDurationMs: 0,
          message: 'Sistema operando normalmente'
        };
        
      case 'DEGRADED':
        // Slow down proportionally to time in degraded state
        const degradedMultiplier = Math.max(0.5, 1 - (timeInState / 60000) * 0.3);
        return {
          action: 'SLOW_DOWN',
          rateMultiplier: degradedMultiplier,
          pauseDurationMs: 0,
          message: `Sistema degradado - reduzir taxa para ${(degradedMultiplier * 100).toFixed(0)}%`
        };
        
      case 'CRITICAL':
        // Calculate pause duration based on severity
        const pauseDuration = Math.min(30000, 10000 + this.circuitBreakerTrips * 5000);
        return {
          action: 'PAUSE',
          rateMultiplier: 0.3,
          pauseDurationMs: pauseDuration,
          message: `Sistema crítico - pausar por ${pauseDuration / 1000}s`
        };
        
      default:
        return {
          action: 'CONTINUE',
          rateMultiplier: 1.0,
          pauseDurationMs: 0,
          message: 'Estado desconhecido'
        };
    }
  }

  /**
   * Retorna estado atual
   */
  getState(): HealthState {
    return this.currentState;
  }

  /**
   * Verifica se está saudável
   */
  isHealthy(): boolean {
    return this.currentState === 'HEALTHY';
  }

  /**
   * Verifica se está degradado
   */
  isDegraded(): boolean {
    return this.currentState === 'DEGRADED';
  }

  /**
   * Verifica se está crítico
   */
  isCritical(): boolean {
    return this.currentState === 'CRITICAL';
  }

  /**
   * Verifica se está estável há tempo suficiente para upgrade
   */
  isStableForUpgrade(): boolean {
    if (this.currentState !== 'HEALTHY') return false;
    return (Date.now() - this.stateChangedAt) >= this.thresholds.stabilityWindowMs;
  }

  /**
   * Retorna histórico de eventos
   */
  getEventHistory(): HealthEvent[] {
    return [...this.eventHistory];
  }

  /**
   * Reseta monitor
   */
  reset(): void {
    this.currentState = 'HEALTHY';
    this.previousState = 'HEALTHY';
    this.stateChangedAt = Date.now();
    this.lastHealthyAt = Date.now();
    this.lastDegradedAt = 0;
    this.lastCriticalAt = 0;
    this.rttSamples = [];
    this.errorTimestamps = [];
    this.circuitBreakerTrips = 0;
    this.totalSent = 0;
    this.totalErrors = 0;
    this.eventHistory = [];
  }

  /**
   * Retorna estatísticas
   */
  getStats(): {
    currentState: HealthState;
    totalSent: number;
    totalErrors: number;
    circuitBreakerTrips: number;
    timeInCurrentState: number;
    stateChanges: number;
    lastHealthyAt: number;
    lastCriticalAt: number;
  } {
    return {
      currentState: this.currentState,
      totalSent: this.totalSent,
      totalErrors: this.totalErrors,
      circuitBreakerTrips: this.circuitBreakerTrips,
      timeInCurrentState: Date.now() - this.stateChangedAt,
      stateChanges: this.eventHistory.length,
      lastHealthyAt: this.lastHealthyAt,
      lastCriticalAt: this.lastCriticalAt
    };
  }
}

export { DEFAULT_THRESHOLDS as DEFAULT_HEALTH_THRESHOLDS };
