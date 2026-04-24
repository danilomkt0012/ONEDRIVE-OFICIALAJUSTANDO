/**
 * ============================================================================
 * FAIL-SAFE MODE - MODO À PROVA DE FALHAS
 * ============================================================================
 * 
 * Modo de contingência ativado após múltiplos eventos críticos.
 * Garante continuidade com taxa mínima segura.
 * 
 * Ativação:
 * - 3+ estados CRITICAL em 5 minutos
 * - 5+ circuit breaker trips
 * - Taxa de erro > 2%
 * - Token/template revogado
 * 
 * Comportamento:
 * - Taxa fixa mínima (5 msg/s)
 * - Sem burst
 * - Checkpoint a cada 3 mensagens
 * - Retry desabilitado (evita loop)
 */

export interface FailSafeConfig {
  minRefillRate: number;
  maxConcurrentRequests: number;
  checkpointEveryN: number;
  disableRetry: boolean;
  disableBurst: boolean;
  maxTimeInFailSafeMs: number;
  exitConditions: FailSafeExitConditions;
}

export interface FailSafeExitConditions {
  minSuccessRate: number;
  minStableTimeMs: number;
  maxErrorsInWindow: number;
  windowSizeMs: number;
}

export interface FailSafeState {
  isActive: boolean;
  activatedAt: number | null;
  activationReason: string | null;
  activationCount: number;
  lastDeactivatedAt: number | null;
  timeActiveMs: number;
  canExit: boolean;
}

export interface FailSafeTrigger {
  type: 'critical_count' | 'circuit_breaker_trips' | 'error_rate' | 'validation_failed' | 'manual';
  value: number | string;
  threshold: number | string;
  timestamp: number;
}

const DEFAULT_FAIL_SAFE_CONFIG: FailSafeConfig = {
  minRefillRate: 5,
  maxConcurrentRequests: 2,
  checkpointEveryN: 3,
  disableRetry: true,
  disableBurst: true,
  maxTimeInFailSafeMs: 300000, // 5 minutes max
  exitConditions: {
    minSuccessRate: 99.5,
    minStableTimeMs: 60000,
    maxErrorsInWindow: 1,
    windowSizeMs: 60000
  }
};

export class FailSafeMode {
  private config: FailSafeConfig;
  private state: FailSafeState;
  private triggers: FailSafeTrigger[] = [];
  private recentErrors: number[] = [];
  private recentSuccesses: number[] = [];
  private stableStartTime: number = 0;
  
  // Activation thresholds
  private criticalCountThreshold: number = 3;
  private criticalWindowMs: number = 300000; // 5 minutes
  private circuitBreakerTripThreshold: number = 5;
  private errorRateThreshold: number = 2.0;
  
  private criticalEvents: number[] = [];
  private circuitBreakerTrips: number = 0;
  
  // Callbacks
  private onActivateCallback?: (reason: string, triggers: FailSafeTrigger[]) => void;
  private onDeactivateCallback?: (timeActiveMs: number) => void;

  constructor(config?: Partial<FailSafeConfig>) {
    this.config = { ...DEFAULT_FAIL_SAFE_CONFIG, ...config };
    
    this.state = {
      isActive: false,
      activatedAt: null,
      activationReason: null,
      activationCount: 0,
      lastDeactivatedAt: null,
      timeActiveMs: 0,
      canExit: false
    };
  }

  /**
   * Registra callback de ativação
   */
  onActivate(callback: (reason: string, triggers: FailSafeTrigger[]) => void): void {
    this.onActivateCallback = callback;
  }

  /**
   * Registra callback de desativação
   */
  onDeactivate(callback: (timeActiveMs: number) => void): void {
    this.onDeactivateCallback = callback;
  }

  /**
   * Registra evento crítico (do HealthMonitor)
   */
  recordCriticalEvent(): void {
    this.criticalEvents.push(Date.now());
    
    // Keep only events in window
    const windowStart = Date.now() - this.criticalWindowMs;
    this.criticalEvents = this.criticalEvents.filter(t => t > windowStart);
    
    this.checkActivation();
  }

  /**
   * Registra trip do circuit breaker
   */
  recordCircuitBreakerTrip(): void {
    this.circuitBreakerTrips++;
    this.checkActivation();
  }

  /**
   * Registra resultado de envio
   */
  recordResult(success: boolean): void {
    const now = Date.now();
    
    if (success) {
      this.recentSuccesses.push(now);
    } else {
      this.recentErrors.push(now);
    }
    
    // Keep only last minute
    const oneMinuteAgo = now - 60000;
    this.recentSuccesses = this.recentSuccesses.filter(t => t > oneMinuteAgo);
    this.recentErrors = this.recentErrors.filter(t => t > oneMinuteAgo);
    
    this.checkActivation();
    
    if (this.state.isActive) {
      this.checkExitConditions();
    }
  }

  /**
   * Registra falha de validação (token/template)
   */
  recordValidationFailure(type: string): void {
    this.triggers.push({
      type: 'validation_failed',
      value: type,
      threshold: 'any',
      timestamp: Date.now()
    });
    
    this.activate(`Falha de validação: ${type}`);
  }

  /**
   * Verifica se deve ativar
   */
  private checkActivation(): void {
    if (this.state.isActive) return;
    
    const newTriggers: FailSafeTrigger[] = [];
    
    // Check critical event count
    const recentCriticalCount = this.criticalEvents.length;
    if (recentCriticalCount >= this.criticalCountThreshold) {
      newTriggers.push({
        type: 'critical_count',
        value: recentCriticalCount,
        threshold: this.criticalCountThreshold,
        timestamp: Date.now()
      });
    }
    
    // Check circuit breaker trips
    if (this.circuitBreakerTrips >= this.circuitBreakerTripThreshold) {
      newTriggers.push({
        type: 'circuit_breaker_trips',
        value: this.circuitBreakerTrips,
        threshold: this.circuitBreakerTripThreshold,
        timestamp: Date.now()
      });
    }
    
    // Check error rate
    const totalRecent = this.recentSuccesses.length + this.recentErrors.length;
    if (totalRecent >= 20) { // Need enough samples
      const errorRate = (this.recentErrors.length / totalRecent) * 100;
      if (errorRate > this.errorRateThreshold) {
        newTriggers.push({
          type: 'error_rate',
          value: errorRate,
          threshold: this.errorRateThreshold,
          timestamp: Date.now()
        });
      }
    }
    
    // Activate if any trigger fired
    if (newTriggers.length > 0) {
      this.triggers = [...this.triggers, ...newTriggers];
      this.activate(newTriggers.map(t => t.type).join(', '));
    }
  }

  /**
   * Ativa fail-safe mode
   */
  activate(reason: string): void {
    if (this.state.isActive) return;
    
    this.state.isActive = true;
    this.state.activatedAt = Date.now();
    this.state.activationReason = reason;
    this.state.activationCount++;
    this.state.canExit = false;
    
    console.log(`\n🚨 FAIL-SAFE MODE ATIVADO`);
    console.log(`   Motivo: ${reason}`);
    console.log(`   Parâmetros:`);
    console.log(`   - Taxa: ${this.config.minRefillRate} msg/s`);
    console.log(`   - Concorrência: ${this.config.maxConcurrentRequests}`);
    console.log(`   - Checkpoint: a cada ${this.config.checkpointEveryN} msgs`);
    console.log(`   - Retry: ${this.config.disableRetry ? 'DESABILITADO' : 'habilitado'}`);
    console.log(`   - Burst: ${this.config.disableBurst ? 'DESABILITADO' : 'habilitado'}`);
    
    this.onActivateCallback?.(reason, this.triggers);
  }

  /**
   * Verifica condições de saída
   */
  private checkExitConditions(): void {
    if (!this.state.isActive) return;
    
    const now = Date.now();
    const timeActive = now - (this.state.activatedAt || now);
    
    // Check max time
    if (timeActive >= this.config.maxTimeInFailSafeMs) {
      console.log(`\n⏰ Fail-Safe: tempo máximo atingido (${this.config.maxTimeInFailSafeMs / 1000}s)`);
      this.state.canExit = true;
      return;
    }
    
    // Check exit conditions
    const { minSuccessRate, minStableTimeMs, maxErrorsInWindow, windowSizeMs } = this.config.exitConditions;
    
    // Check success rate
    const totalRecent = this.recentSuccesses.length + this.recentErrors.length;
    if (totalRecent < 10) {
      this.stableStartTime = 0;
      return; // Not enough samples
    }
    
    const successRate = (this.recentSuccesses.length / totalRecent) * 100;
    
    // Check errors in window
    const windowStart = now - windowSizeMs;
    const errorsInWindow = this.recentErrors.filter(t => t > windowStart).length;
    
    // All conditions met?
    if (successRate >= minSuccessRate && errorsInWindow <= maxErrorsInWindow) {
      if (this.stableStartTime === 0) {
        this.stableStartTime = now;
      }
      
      const stableTime = now - this.stableStartTime;
      if (stableTime >= minStableTimeMs) {
        this.state.canExit = true;
        console.log(`\n✅ Fail-Safe: condições de saída atingidas (estável há ${stableTime / 1000}s)`);
      }
    } else {
      this.stableStartTime = 0;
    }
  }

  /**
   * Desativa fail-safe mode
   */
  deactivate(): void {
    if (!this.state.isActive) return;
    
    const timeActive = Date.now() - (this.state.activatedAt || Date.now());
    
    this.state.isActive = false;
    this.state.lastDeactivatedAt = Date.now();
    this.state.timeActiveMs += timeActive;
    
    console.log(`\n✅ FAIL-SAFE MODE DESATIVADO`);
    console.log(`   Tempo ativo: ${(timeActive / 1000).toFixed(1)}s`);
    
    // Reset counters
    this.triggers = [];
    this.criticalEvents = [];
    this.circuitBreakerTrips = 0;
    this.stableStartTime = 0;
    
    this.onDeactivateCallback?.(timeActive);
  }

  /**
   * Verifica se está ativo
   */
  isActive(): boolean {
    return this.state.isActive;
  }

  /**
   * Verifica se pode sair
   */
  canExit(): boolean {
    return this.state.canExit;
  }

  /**
   * Retorna configuração efetiva
   */
  getEffectiveConfig(): FailSafeConfig {
    return { ...this.config };
  }

  /**
   * Retorna estado atual
   */
  getState(): FailSafeState {
    const now = Date.now();
    return {
      ...this.state,
      timeActiveMs: this.state.isActive 
        ? this.state.timeActiveMs + (now - (this.state.activatedAt || now))
        : this.state.timeActiveMs
    };
  }

  /**
   * Retorna triggers que causaram ativação
   */
  getTriggers(): FailSafeTrigger[] {
    return [...this.triggers];
  }

  /**
   * Reset completo
   */
  reset(): void {
    this.state = {
      isActive: false,
      activatedAt: null,
      activationReason: null,
      activationCount: 0,
      lastDeactivatedAt: null,
      timeActiveMs: 0,
      canExit: false
    };
    
    this.triggers = [];
    this.criticalEvents = [];
    this.recentErrors = [];
    this.recentSuccesses = [];
    this.circuitBreakerTrips = 0;
    this.stableStartTime = 0;
  }
}

export { DEFAULT_FAIL_SAFE_CONFIG };
