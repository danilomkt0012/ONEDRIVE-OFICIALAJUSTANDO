/**
 * ============================================================================
 * TOKEN BUCKET ADAPTATIVO
 * ============================================================================
 * 
 * Implementação de Token Bucket com refillRate variável e burst permitido.
 * Controla a taxa de envio de mensagens de forma adaptativa baseado em feedback.
 * 
 * Características:
 * - refillRate ajustável em tempo real
 * - Burst inicial permitido (2x capacidade normal)
 * - Nunca bloqueia completamente (sempre mantém taxa mínima)
 * - Thread-safe para uso assíncrono
 */

export interface TokenBucketConfig {
  initialTokens: number;
  maxTokens: number;
  refillRate: number;
  minRefillRate: number;
  maxRefillRate: number;
  burstMultiplier: number;
}

export class TokenBucket {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number;
  private minRefillRate: number;
  private maxRefillRate: number;
  private lastRefillTime: number;
  private burstMultiplier: number;
  private isBurstPhase: boolean = true;
  private burstStartTime: number;
  private burstDurationMs: number = 60000;

  constructor(config: Partial<TokenBucketConfig> = {}) {
    this.maxTokens = config.maxTokens ?? 10;
    this.refillRate = config.refillRate ?? 2.0;
    this.minRefillRate = config.minRefillRate ?? 0.2;
    this.maxRefillRate = config.maxRefillRate ?? 5.0;
    this.burstMultiplier = config.burstMultiplier ?? 1.0;
    this.tokens = config.initialTokens ?? this.maxTokens;
    this.lastRefillTime = Date.now();
    this.burstStartTime = Date.now();
    this.isBurstPhase = false;
  }

  /**
   * Refill tokens baseado no tempo decorrido
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000;
    const tokensToAdd = elapsed * this.refillRate;
    
    const effectiveMax = this.isBurstPhase 
      ? this.maxTokens * this.burstMultiplier 
      : this.maxTokens;
    
    this.tokens = Math.min(effectiveMax, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
    
    if (this.isBurstPhase && (now - this.burstStartTime) > this.burstDurationMs) {
      this.isBurstPhase = false;
    }
  }

  /**
   * Tenta consumir um token
   * @returns true se token disponível, false caso contrário
   */
  tryConsume(): boolean {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    
    return false;
  }

  /**
   * Aguarda até que um token esteja disponível
   * @returns tempo de espera em ms
   */
  async waitForToken(): Promise<number> {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    
    const tokensNeeded = 1 - this.tokens;
    const waitTimeMs = Math.max(1, (tokensNeeded / this.refillRate) * 1000);
    
    const effectiveWait = Math.min(waitTimeMs, 5000);
    
    await new Promise(resolve => setTimeout(resolve, effectiveWait));
    
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
    
    return effectiveWait;
  }

  /**
   * Acelera a taxa de refill em percentual
   */
  accelerate(percent: number): void {
    const factor = 1 + (percent / 100);
    this.refillRate = Math.min(this.maxRefillRate, this.refillRate * factor);
  }

  /**
   * Desacelera a taxa de refill em percentual
   */
  decelerate(percent: number): void {
    const factor = 1 - (percent / 100);
    this.refillRate = Math.max(this.minRefillRate, this.refillRate * factor);
  }

  /**
   * Define taxa de refill diretamente
   */
  setRefillRate(rate: number): void {
    this.refillRate = Math.max(
      this.minRefillRate,
      Math.min(this.maxRefillRate, rate)
    );
  }

  updateMaxRefillRate(newMax: number): void {
    this.maxRefillRate = newMax;
    if (this.refillRate > this.maxRefillRate) {
      this.refillRate = this.maxRefillRate;
    }
  }

  /**
   * Forces the refill rate and both min/max bounds to a specific value,
   * bypassing the normal floor. Used by the warmup subsystem to enforce
   * very low rates (e.g. 0.006 msg/s for a 250-quota number over 12h).
   */
  forceWarmupRate(rate: number): void {
    const r = Math.max(0.0001, rate);
    this.minRefillRate = r;
    this.maxRefillRate = r;
    this.refillRate = r;
  }

  /**
   * Retorna estatísticas atuais
   */
  getStats(): {
    tokens: number;
    refillRate: number;
    maxTokens: number;
    isBurstPhase: boolean;
    effectiveMaxTokens: number;
  } {
    this.refill();
    return {
      tokens: this.tokens,
      refillRate: this.refillRate,
      maxTokens: this.maxTokens,
      isBurstPhase: this.isBurstPhase,
      effectiveMaxTokens: this.isBurstPhase 
        ? this.maxTokens * this.burstMultiplier 
        : this.maxTokens
    };
  }

  /**
   * Reset para estado inicial (novo burst)
   */
  reset(): void {
    this.tokens = this.maxTokens * this.burstMultiplier;
    this.lastRefillTime = Date.now();
    this.isBurstPhase = true;
    this.burstStartTime = Date.now();
  }

  /**
   * Força fim da fase de burst
   */
  endBurstPhase(): void {
    this.isBurstPhase = false;
  }
}
