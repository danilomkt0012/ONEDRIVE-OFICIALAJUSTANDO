/**
 * ============================================================================
 * MODO SEGURO (SAFE MODE)
 * ============================================================================
 * 
 * Modo de envio conservador ativável por configuração ou automaticamente.
 * Prioriza estabilidade sobre velocidade.
 * 
 * Características:
 * - Concorrência reduzida (3 vs 5)
 * - Taxa máxima reduzida (40 vs 100)
 * - Burst desabilitado (1.5x vs 2.5x)
 * - RTT target mais conservador
 * - Sem aceleração agressiva
 * 
 * Ativação automática:
 * - errorRate > 0.5%
 * - Primeiro erro 135000
 * - Múltiplos erros em sequência
 */

export interface SafeModeConfig {
  enabled: boolean;
  maxConcurrentRequests: number;
  maxRefillRate: number;
  burstMultiplierMax: number;
  rampUpDisabled: boolean;
  rttTargetMs: number;
  autoActivate: boolean;
  autoActivateErrorRate: number;
  autoActivateOnRateLimit: boolean;
  cooldownAfterActivationMs: number;
  autoRecoveryEnabled: boolean;
  autoRecoveryAfterMs: number;
  autoRecoveryMinStableMessages: number;
}

export interface SafeModeState {
  isActive: boolean;
  activatedAt: number | null;
  activationReason: string | null;
  activationCount: number;
  lastDeactivatedAt: number | null;
  autoActivated: boolean;
}

export interface SafeModeStats {
  state: SafeModeState;
  config: SafeModeConfig;
  timeActiveMs: number;
  reductionPercent: number;
}

export const DEFAULT_SAFE_MODE_CONFIG: SafeModeConfig = {
  enabled: false,
  maxConcurrentRequests: 2,
  maxRefillRate: 0.5,
  burstMultiplierMax: 1.0,
  rampUpDisabled: true,
  rttTargetMs: 300,
  autoActivate: true,
  autoActivateErrorRate: 0.5,
  autoActivateOnRateLimit: true,
  cooldownAfterActivationMs: 120000,
  autoRecoveryEnabled: true,
  autoRecoveryAfterMs: 600000,
  autoRecoveryMinStableMessages: 50
};

export const AGGRESSIVE_MODE_CONFIG: SafeModeConfig = {
  enabled: false,
  maxConcurrentRequests: 3,
  maxRefillRate: 0.8,
  burstMultiplierMax: 1.0,
  rampUpDisabled: false,
  rttTargetMs: 250,
  autoActivate: true,
  autoActivateErrorRate: 0.5,
  autoActivateOnRateLimit: true,
  cooldownAfterActivationMs: 120000,
  autoRecoveryEnabled: true,
  autoRecoveryAfterMs: 600000,
  autoRecoveryMinStableMessages: 50
};

export class SafeMode {
  private config: SafeModeConfig;
  private state: SafeModeState;
  private onActivateCallbacks: Array<(reason: string) => void> = [];
  private onDeactivateCallbacks: Array<() => void> = [];
  private totalSent: number = 0;
  private totalErrors: number = 0;
  private rateLimitErrors: number = 0;
  private consecutiveErrors: number = 0;
  private stableMessagesSinceActivation: number = 0;
  private autoRecoveryTimer?: NodeJS.Timeout;

  constructor(config?: Partial<SafeModeConfig>) {
    this.config = { ...DEFAULT_SAFE_MODE_CONFIG, ...config };
    
    this.state = {
      isActive: this.config.enabled,
      activatedAt: this.config.enabled ? Date.now() : null,
      activationReason: this.config.enabled ? 'manual' : null,
      activationCount: this.config.enabled ? 1 : 0,
      lastDeactivatedAt: null,
      autoActivated: false
    };
  }

  /**
   * Verifica se safe mode está ativo
   */
  isActive(): boolean {
    return this.state.isActive;
  }

  /**
   * Ativa safe mode manualmente
   */
  activate(reason: string = 'manual'): void {
    if (this.state.isActive) return;
    
    this.state.isActive = true;
    this.state.activatedAt = Date.now();
    this.state.activationReason = reason;
    this.stableMessagesSinceActivation = 0;
    this.state.activationCount++;
    this.state.autoActivated = reason !== 'manual';
    
    console.log(`\n🛡️ SafeMode ATIVADO: ${reason}`);
    console.log(`   📊 Stats: ${this.totalErrors}/${this.totalSent} erros (${this.getErrorRate().toFixed(2)}%)`);
    console.log(`   ⚙️ Parâmetros: concurrent=${this.config.maxConcurrentRequests}, rate=${this.config.maxRefillRate}, burst=${this.config.burstMultiplierMax}x`);
    
    for (const cb of this.onActivateCallbacks) { try { cb(reason); } catch (_e) { /* skip */ } }
  }

  /**
   * Desativa safe mode
   */
  deactivate(): void {
    if (!this.state.isActive) return;
    
    this.state.isActive = false;
    this.state.lastDeactivatedAt = Date.now();
    
    console.log(`\n✅ SafeMode DESATIVADO após ${this.getTimeActiveMs()}ms`);
    
    for (const cb of this.onDeactivateCallbacks) { try { cb(); } catch (_e) { /* skip */ } }
  }

  /**
   * Registra resultado de envio
   */
  recordResult(success: boolean, isRateLimitError: boolean = false): void {
    this.totalSent++;
    
    if (!success) {
      this.totalErrors++;
      this.consecutiveErrors++;
      this.stableMessagesSinceActivation = 0;
      
      if (isRateLimitError) {
        this.rateLimitErrors++;
      }
      
      this.checkAutoActivation(isRateLimitError);
    } else {
      this.consecutiveErrors = 0;
      
      if (this.state.isActive) {
        this.stableMessagesSinceActivation++;
        this.checkAutoRecovery();
      }
    }
  }

  /**
   * Verifica se deve desativar automaticamente (auto-recovery)
   */
  private checkAutoRecovery(): void {
    if (!this.config.autoRecoveryEnabled) return;
    if (!this.state.isActive) return;
    if (!this.state.autoActivated) return;
    
    const timeActive = this.getTimeActiveMs();
    const hasEnoughTime = timeActive >= this.config.autoRecoveryAfterMs;
    const hasEnoughStable = this.stableMessagesSinceActivation >= this.config.autoRecoveryMinStableMessages;
    const noRecentErrors = this.consecutiveErrors === 0;
    
    if (hasEnoughTime && hasEnoughStable && noRecentErrors) {
      console.log(`\n🔄 AUTO-RECOVERY: SafeMode desativando após ${Math.round(timeActive / 60000)} min estáveis`);
      console.log(`   📊 Mensagens estáveis: ${this.stableMessagesSinceActivation}`);
      this.deactivate();
    }
  }

  /**
   * Verifica se deve ativar automaticamente
   */
  private checkAutoActivation(isRateLimitError: boolean): void {
    if (!this.config.autoActivate) return;
    if (this.state.isActive) return;
    
    if (isRateLimitError && this.config.autoActivateOnRateLimit) {
      this.activate('rate_limit_error');
      return;
    }
    
    if (this.totalSent >= 100) {
      const errorRate = this.getErrorRate();
      if (errorRate > this.config.autoActivateErrorRate) {
        this.activate(`error_rate_${errorRate.toFixed(2)}%`);
        return;
      }
    }
    
    if (this.consecutiveErrors >= 3) {
      this.activate('consecutive_errors');
      return;
    }
  }

  /**
   * Retorna taxa de erro atual
   */
  getErrorRate(): number {
    if (this.totalSent === 0) return 0;
    return (this.totalErrors / this.totalSent) * 100;
  }

  /**
   * Retorna tempo ativo em ms
   */
  getTimeActiveMs(): number {
    if (!this.state.isActive || !this.state.activatedAt) return 0;
    return Date.now() - this.state.activatedAt;
  }

  /**
   * Retorna configuração efetiva (safe ou normal)
   */
  getEffectiveConfig(): {
    maxConcurrentRequests: number;
    maxRefillRate: number;
    burstMultiplierMax: number;
    rttTargetMs: number;
    rampUpDisabled: boolean;
  } {
    if (this.state.isActive) {
      return {
        maxConcurrentRequests: this.config.maxConcurrentRequests,
        maxRefillRate: this.config.maxRefillRate,
        burstMultiplierMax: this.config.burstMultiplierMax,
        rttTargetMs: this.config.rttTargetMs,
        rampUpDisabled: this.config.rampUpDisabled
      };
    }
    
    return {
      maxConcurrentRequests: AGGRESSIVE_MODE_CONFIG.maxConcurrentRequests,
      maxRefillRate: AGGRESSIVE_MODE_CONFIG.maxRefillRate,
      burstMultiplierMax: AGGRESSIVE_MODE_CONFIG.burstMultiplierMax,
      rttTargetMs: AGGRESSIVE_MODE_CONFIG.rttTargetMs,
      rampUpDisabled: AGGRESSIVE_MODE_CONFIG.rampUpDisabled
    };
  }

  /**
   * Define callback de ativação
   */
  onActivate(callback: (reason: string) => void): void {
    this.onActivateCallbacks.push(callback);
  }

  onDeactivate(callback: () => void): void {
    this.onDeactivateCallbacks.push(callback);
  }

  /**
   * Retorna estatísticas
   */
  getStats(): SafeModeStats {
    return {
      state: { ...this.state },
      config: { ...this.config },
      timeActiveMs: this.getTimeActiveMs(),
      reductionPercent: this.state.isActive 
        ? ((AGGRESSIVE_MODE_CONFIG.maxRefillRate - this.config.maxRefillRate) / AGGRESSIVE_MODE_CONFIG.maxRefillRate) * 100
        : 0
    };
  }

  /**
   * Retorna estado atual
   */
  getState(): SafeModeState {
    return { ...this.state };
  }

  /**
   * Atualiza configuração
   */
  updateConfig(config: Partial<SafeModeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Reseta contadores
   */
  reset(): void {
    this.totalSent = 0;
    this.totalErrors = 0;
    this.rateLimitErrors = 0;
    this.consecutiveErrors = 0;
    this.stableMessagesSinceActivation = 0;

    if (this.autoRecoveryTimer) {
      clearTimeout(this.autoRecoveryTimer);
      this.autoRecoveryTimer = undefined;
    }

    if (this.state.autoActivated) {
      this.deactivate();
    }
  }

  /**
   * Verifica se pode desativar após cooldown
   */
  canDeactivate(): boolean {
    if (!this.state.isActive) return false;
    if (!this.state.activatedAt) return false;
    
    const elapsed = Date.now() - this.state.activatedAt;
    if (elapsed < this.config.cooldownAfterActivationMs) return false;
    
    if (this.consecutiveErrors > 0) return false;
    
    const recentErrorRate = this.getErrorRate();
    if (recentErrorRate > this.config.autoActivateErrorRate / 2) return false;
    
    return true;
  }

  /**
   * Tenta desativar se possível
   */
  tryDeactivate(): boolean {
    if (this.canDeactivate()) {
      this.deactivate();
      return true;
    }
    return false;
  }
}
