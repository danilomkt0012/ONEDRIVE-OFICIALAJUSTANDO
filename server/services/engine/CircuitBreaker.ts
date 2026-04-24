/**
 * ============================================================================
 * CIRCUIT BREAKER PREVENTIVO
 * ============================================================================
 * 
 * Circuit breaker que detecta stress ANTES do erro 135000.
 * Usa múltiplos sinais para antecipar problemas:
 * - Latência crescente
 * - Taxa de erros
 * - Padrão de erros específicos (rate limit)
 * 
 * Estados:
 * - CLOSED: Operando normalmente
 * - HALF_OPEN: Testando retomada com taxa reduzida
 * - OPEN: Pausado, aguardando cooldown
 */

export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export interface CircuitBreakerConfig {
  errorThreshold: number;
  errorWindowSize: number;
  latencyThresholdMs: number;
  consecutiveLatencyIncreases: number;
  cooldownMs: number;
  maxCooldownMs: number;
  cooldownMultiplier: number;
  halfOpenTestCount: number;
  rateReductionOnReopen: number;
  preventiveP95ThresholdMs: number;
  preventiveP95SampleCount: number;
  preventiveP99ThresholdMs: number;
  rateLimitCooldownMs: number;
  rateLimitRateReduction: number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  tripCount: number;
  lastTripTime: number;
  currentCooldownMs: number;
  errorsInWindow: number;
  successesInHalfOpen: number;
  timeInCurrentState: number;
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private errorWindow: boolean[] = [];
  private tripCount: number = 0;
  private lastTripTime: number = 0;
  private currentCooldownMs: number;
  private stateStartTime: number;
  private successesInHalfOpen: number = 0;
  private consecutiveLatencyIncreases: number = 0;
  private lastLatency: number = 0;
  private onTripCallback?: (state: CircuitState) => void;
  private onRecoverCallback?: () => void;
  private onPreventiveActionCallback?: (action: string, reduction: number) => void;
  private latencyWindow: number[] = [];
  private preventiveReductionApplied: number = 0;
  private lastPreventiveActionTime: number = 0;
  private rateLimitErrorCount: number = 0;
  private consecutive429Count: number = 0;
  private consecutive5xxCount: number = 0;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      errorThreshold: config.errorThreshold ?? 5,
      errorWindowSize: config.errorWindowSize ?? 20,
      latencyThresholdMs: config.latencyThresholdMs ?? 500,
      consecutiveLatencyIncreases: config.consecutiveLatencyIncreases ?? 4,
      cooldownMs: config.cooldownMs ?? 10000,
      maxCooldownMs: config.maxCooldownMs ?? 120000,
      cooldownMultiplier: config.cooldownMultiplier ?? 1.5,
      halfOpenTestCount: config.halfOpenTestCount ?? 3,
      rateReductionOnReopen: config.rateReductionOnReopen ?? 50,
      preventiveP95ThresholdMs: config.preventiveP95ThresholdMs ?? 260,
      preventiveP95SampleCount: config.preventiveP95SampleCount ?? 3,
      preventiveP99ThresholdMs: config.preventiveP99ThresholdMs ?? 350,
      rateLimitCooldownMs: config.rateLimitCooldownMs ?? 30000,
      rateLimitRateReduction: config.rateLimitRateReduction ?? 40
    };
    
    this.currentCooldownMs = this.config.cooldownMs;
    this.stateStartTime = Date.now();
  }

  /**
   * Registra resultado de envio
   */
  recordResult(success: boolean, rttMs: number, isRateLimitError: boolean = false, isTemplatePacing: boolean = false): void {
    if (isTemplatePacing) {
      console.log(`📋 Template pacing detectado — CircuitBreaker ignorando volume reduzido`);
      return;
    }

    this.errorWindow.push(!success);

    while (this.errorWindow.length > this.config.errorWindowSize) {
      this.errorWindow.shift();
    }
    
    this.latencyWindow.push(rttMs);
    while (this.latencyWindow.length > 20) {
      this.latencyWindow.shift();
    }
    
    if (success) {
      this.consecutive429Count = 0;
      this.consecutive5xxCount = 0;
      this.updateLatencyTrend(rttMs);
      this.checkPreventiveActions();
      
      if (this.state === 'HALF_OPEN') {
        this.successesInHalfOpen++;
        
        if (this.successesInHalfOpen >= this.config.halfOpenTestCount) {
          this.closeCircuit();
        }
      }
    } else {
      if (isRateLimitError) {
        this.rateLimitErrorCount++;
        this.consecutive429Count++;
        this.consecutive5xxCount = 0;
        if (this.consecutive429Count >= 3) {
          this.tripCircuit('3 consecutive 429 errors');
          return;
        }
        this.tripCircuitForRateLimit();
      } else {
        this.consecutive429Count = 0;
        this.consecutive5xxCount++;
        if (this.consecutive5xxCount >= 3) {
          this.tripCircuit('3 consecutive 5xx errors');
          return;
        }
        if (this.shouldTrip()) {
          this.tripCircuit('Error threshold exceeded');
        }
      }

      const errorRate = this.getErrorRate();
      if (errorRate > 5 && this.errorWindow.length >= 10 && this.state === 'CLOSED') {
        this.tripCircuit(`Error rate ${errorRate.toFixed(1)}% > 5% threshold`);
      }
    }
  }

  /**
   * Ações preventivas baseadas em RTT ANTES do erro
   */
  private checkPreventiveActions(): void {
    if (this.state !== 'CLOSED') return;
    if (this.latencyWindow.length < 5) return;
    
    const now = Date.now();
    if (now - this.lastPreventiveActionTime < 5000) return;
    
    const p95 = this.calculatePercentile(95);
    const p99 = this.calculatePercentile(99);
    
    if (p99 > this.config.preventiveP99ThresholdMs) {
      this.lastPreventiveActionTime = now;
      const reduction = 25;
      this.preventiveReductionApplied = reduction;
      
      console.log(`\n⚠️ PREVENTIVE: p99 RTT ${p99.toFixed(0)}ms > ${this.config.preventiveP99ThresholdMs}ms → cooldown curto (5s)`);
      this.onPreventiveActionCallback?.('p99_high', reduction);
      return;
    }
    
    const recentP95s = this.getRecentP95Samples(this.config.preventiveP95SampleCount);
    const allAboveThreshold = recentP95s.length >= this.config.preventiveP95SampleCount &&
      recentP95s.every(v => v > this.config.preventiveP95ThresholdMs);
    
    if (allAboveThreshold) {
      this.lastPreventiveActionTime = now;
      const reduction = 25;
      this.preventiveReductionApplied = reduction;
      
      console.log(`\n⚠️ PREVENTIVE: p95 RTT ${p95.toFixed(0)}ms > ${this.config.preventiveP95ThresholdMs}ms por ${this.config.preventiveP95SampleCount} amostras → reduzindo ${reduction}%`);
      this.onPreventiveActionCallback?.('p95_sustained', reduction);
    }
  }

  /**
   * Trip especial para erro de rate limit
   */
  private tripCircuitForRateLimit(): void {
    if (this.state === 'OPEN') return;
    
    this.state = 'OPEN';
    this.tripCount++;
    this.lastTripTime = Date.now();
    this.stateStartTime = Date.now();
    
    this.currentCooldownMs = Math.max(
      this.config.rateLimitCooldownMs,
      this.currentCooldownMs
    );
    
    console.log(`\n🔴 CIRCUIT BREAKER OPEN - RATE LIMIT (trip #${this.tripCount})`);
    console.log(`   ⏱️ Cooldown mínimo: ${this.config.rateLimitCooldownMs}ms`);
    console.log(`   📉 Taxa será reduzida para ${100 - this.config.rateLimitRateReduction}%`);
    
    this.onTripCallback?.(this.state);
  }

  /**
   * Calcula percentil da janela de latência
   */
  private calculatePercentile(percentile: number): number {
    if (this.latencyWindow.length === 0) return 0;
    
    const sorted = [...this.latencyWindow].sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  /**
   * Retorna amostras recentes de p95
   */
  private getRecentP95Samples(count: number): number[] {
    const samples: number[] = [];
    const windowSize = 5;
    
    for (let i = 0; i < count && i * windowSize < this.latencyWindow.length; i++) {
      const start = Math.max(0, this.latencyWindow.length - (i + 1) * windowSize);
      const end = this.latencyWindow.length - i * windowSize;
      const window = this.latencyWindow.slice(start, end);
      
      if (window.length >= 3) {
        const sorted = [...window].sort((a, b) => a - b);
        const p95Index = Math.floor(0.95 * sorted.length);
        samples.push(sorted[Math.min(p95Index, sorted.length - 1)]);
      }
    }
    
    return samples;
  }

  /**
   * Atualiza tendência de latência
   */
  private updateLatencyTrend(rttMs: number): void {
    if (this.lastLatency > 0 && rttMs > this.lastLatency * 1.1) {
      this.consecutiveLatencyIncreases++;
    } else {
      this.consecutiveLatencyIncreases = Math.max(0, this.consecutiveLatencyIncreases - 1);
    }
    
    this.lastLatency = rttMs;
  }

  /**
   * Verifica se deve abrir o circuit breaker
   */
  shouldTrip(): boolean {
    if (this.state !== 'CLOSED') return false;
    
    const errorCount = this.errorWindow.filter(e => e).length;
    if (errorCount >= this.config.errorThreshold) {
      return true;
    }
    
    if (this.consecutiveLatencyIncreases >= this.config.consecutiveLatencyIncreases) {
      return true;
    }
    
    if (this.lastLatency > this.config.latencyThresholdMs * 2) {
      return true;
    }
    
    return false;
  }

  /**
   * Detecta stress iminente (antes do trip)
   */
  isUnderStress(): boolean {
    if (this.state !== 'CLOSED') return true;
    
    const errorCount = this.errorWindow.filter(e => e).length;
    const errorRatio = errorCount / Math.max(1, this.errorWindow.length);
    
    if (errorRatio > 0.15) return true;
    
    if (this.consecutiveLatencyIncreases >= 2) return true;
    
    if (this.lastLatency > this.config.latencyThresholdMs) return true;
    
    return false;
  }

  /**
   * Abre o circuit breaker
   */
  private tripCircuit(reason: string): void {
    if (this.state === 'OPEN') return;
    
    this.state = 'OPEN';
    this.tripCount++;
    this.lastTripTime = Date.now();
    this.stateStartTime = Date.now();
    
    if (this.tripCount > 1) {
      this.currentCooldownMs = Math.min(
        this.config.maxCooldownMs,
        this.currentCooldownMs * this.config.cooldownMultiplier
      );
    }
    
    console.log(`\n⚡ CIRCUIT BREAKER OPEN (trip #${this.tripCount})`);
    console.log(`   📋 Motivo: ${reason}`);
    console.log(`   ⏱️ Cooldown: ${this.currentCooldownMs}ms`);
    console.log(`   📊 Erros na janela: ${this.errorWindow.filter(e => e).length}/${this.errorWindow.length}`);
    
    this.onTripCallback?.(this.state);
  }

  /**
   * Tenta transicionar para HALF_OPEN
   */
  async tryHalfOpen(): Promise<boolean> {
    if (this.state !== 'OPEN') return true;
    
    const elapsed = Date.now() - this.lastTripTime;
    
    if (elapsed < this.currentCooldownMs) {
      return false;
    }
    
    this.state = 'HALF_OPEN';
    this.stateStartTime = Date.now();
    this.successesInHalfOpen = 0;
    this.errorWindow = [];
    this.consecutiveLatencyIncreases = 0;
    
    console.log(`\n🟡 CIRCUIT BREAKER HALF_OPEN`);
    console.log(`   🧪 Testando retomada com ${this.config.halfOpenTestCount} requests`);
    
    return true;
  }

  /**
   * Fecha o circuit breaker (operação normal)
   */
  private closeCircuit(): void {
    this.state = 'CLOSED';
    this.stateStartTime = Date.now();
    this.consecutiveLatencyIncreases = 0;
    
    console.log(`\n🟢 CIRCUIT BREAKER CLOSED`);
    console.log(`   ✅ Operação normal retomada`);
    
    this.onRecoverCallback?.();
  }

  /**
   * Aguarda até que possa tentar enviar
   */
  async waitForReady(): Promise<number> {
    if (this.state === 'CLOSED' || this.state === 'HALF_OPEN') {
      return 0;
    }
    
    const elapsed = Date.now() - this.lastTripTime;
    const remaining = this.currentCooldownMs - elapsed;
    
    if (remaining <= 0) {
      await this.tryHalfOpen();
      return 0;
    }
    
    console.log(`   ⏳ Circuit breaker: aguardando ${remaining}ms`);
    await new Promise(resolve => setTimeout(resolve, remaining));
    
    await this.tryHalfOpen();
    return remaining;
  }

  /**
   * Define callbacks
   */
  onTrip(callback: (state: CircuitState) => void): void {
    this.onTripCallback = callback;
  }

  onRecover(callback: () => void): void {
    this.onRecoverCallback = callback;
  }

  onPreventiveAction(callback: (action: string, reduction: number) => void): void {
    this.onPreventiveActionCallback = callback;
  }

  /**
   * Retorna estatísticas
   */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      tripCount: this.tripCount,
      lastTripTime: this.lastTripTime,
      currentCooldownMs: this.currentCooldownMs,
      errorsInWindow: this.errorWindow.filter(e => e).length,
      successesInHalfOpen: this.successesInHalfOpen,
      timeInCurrentState: Date.now() - this.stateStartTime
    };
  }

  /**
   * Retorna estado atual
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Verifica se pode enviar
   */
  canSend(): boolean {
    return this.state !== 'OPEN';
  }

  /**
   * Retorna redução de taxa recomendada após reopen
   */
  getRateReductionPercent(): number {
    if (this.rateLimitErrorCount > 0) {
      return this.config.rateLimitRateReduction;
    }
    
    if (this.tripCount === 0) return this.preventiveReductionApplied;
    
    const baseReduction = this.config.rateReductionOnReopen;
    const additionalReduction = Math.min(30, (this.tripCount - 1) * 10);
    
    return Math.max(baseReduction + additionalReduction, this.preventiveReductionApplied);
  }

  /**
   * Retorna p95 atual
   */
  getCurrentP95(): number {
    return this.calculatePercentile(95);
  }

  /**
   * Retorna p99 atual
   */
  getCurrentP99(): number {
    return this.calculatePercentile(99);
  }

  /**
   * Verifica se teve erro de rate limit
   */
  hadRateLimitError(): boolean {
    return this.rateLimitErrorCount > 0;
  }

  getErrorRate(): number {
    if (this.errorWindow.length === 0) return 0;
    const errorCount = this.errorWindow.filter(e => e).length;
    return (errorCount / this.errorWindow.length) * 100;
  }

  /**
   * Reset completo
   */
  reset(): void {
    this.state = 'CLOSED';
    this.errorWindow = [];
    this.latencyWindow = [];
    this.tripCount = 0;
    this.lastTripTime = 0;
    this.currentCooldownMs = this.config.cooldownMs;
    this.stateStartTime = Date.now();
    this.successesInHalfOpen = 0;
    this.consecutiveLatencyIncreases = 0;
    this.lastLatency = 0;
    this.preventiveReductionApplied = 0;
    this.lastPreventiveActionTime = 0;
    this.rateLimitErrorCount = 0;
    this.consecutive429Count = 0;
    this.consecutive5xxCount = 0;
  }
}
