/**
 * ============================================================================
 * PHONE CONTROLLER INDEPENDENTE
 * ============================================================================
 * 
 * Controlador isolado por número de telefone.
 * Cada número tem seus próprios componentes:
 * - TokenBucket com taxa independente
 * - SlidingWindow de RTT próprio
 * - CircuitBreaker dedicado
 * - RequestPipeline separado
 * 
 * Permite escala quase linear com múltiplos números.
 */

import { TokenBucket, TokenBucketConfig } from './TokenBucket';
import { SlidingWindow } from './SlidingWindow';
import { CircuitBreaker, CircuitState, CircuitBreakerConfig } from './CircuitBreaker';
import { RequestPipeline, PipelineStats } from './RequestPipeline';
import { BurstProfile, BurstState } from './BurstProfile';
import { EtaCalculator, EtaEstimate } from './EtaCalculator';

export interface PhoneControllerConfig {
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: string;
  baseRefillRate: number;
  maxConcurrentRequests: number;
  targetRttMs: number;
  rttThresholdPercent: number;
}

export interface PhoneControllerStats {
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: string;
  totalSent: number;
  successCount: number;
  failedCount: number;
  currentRate: number;
  targetRate: number;
  avgRttMs: number;
  p95RttMs: number;
  inFlightRequests: number;
  circuitState: CircuitState;
  burstState: BurstState;
  eta: EtaEstimate;
  isHealthy: boolean;
  lastErrorTime: number;
  consecutiveSuccesses: number;
}

export interface SendResult {
  success: boolean;
  rttMs: number;
  error?: string;
  isRateLimitError?: boolean;
}

export class PhoneController {
  private config: PhoneControllerConfig;
  private tokenBucket: TokenBucket;
  private rttWindow: SlidingWindow;
  private circuitBreaker: CircuitBreaker;
  private pipeline: RequestPipeline<SendResult>;
  private burstProfile: BurstProfile;
  private etaCalculator: EtaCalculator;
  
  private totalSent: number = 0;
  private successCount: number = 0;
  private failedCount: number = 0;
  private startTime: number = 0;
  private lastErrorTime: number = 0;
  private consecutiveSuccesses: number = 0;
  private consecutiveErrors: number = 0;
  private isActive: boolean = false;
  
  private targetRttMs: number;
  private rttThresholdPercent: number;

  constructor(config: PhoneControllerConfig) {
    this.config = config;
    this.targetRttMs = config.targetRttMs ?? 150;
    this.rttThresholdPercent = config.rttThresholdPercent ?? 20;
    
    const qualityMultiplier = this.getQualityMultiplier();
    const adjustedRate = config.baseRefillRate * qualityMultiplier;
    
    this.tokenBucket = new TokenBucket({
      maxTokens: 5,
      refillRate: Math.min(adjustedRate, 0.8),
      minRefillRate: 0.1,
      maxRefillRate: 0.8,
      burstMultiplier: 1.0
    });
    
    this.rttWindow = new SlidingWindow({
      windowSize: 100
    });
    
    this.circuitBreaker = new CircuitBreaker({
      errorThreshold: 5,
      errorWindowSize: 20,
      latencyThresholdMs: this.targetRttMs * 2,
      consecutiveLatencyIncreases: 4,
      cooldownMs: 10000,
      maxCooldownMs: 120000
    });
    
    this.pipeline = new RequestPipeline({
      maxConcurrentRequests: Math.min(config.maxConcurrentRequests ?? 3, 3),
      prefetchCount: 2,
      queueHighWaterMark: 5,
      drainLowWaterMark: 1
    });
    
    this.burstProfile = new BurstProfile();
    this.etaCalculator = new EtaCalculator();
    
    this.setupCallbacks();
  }

  /**
   * Retorna multiplicador baseado em qualidade do número
   */
  private getQualityMultiplier(): number {
    switch (this.config.qualityRating) {
      case 'GREEN': return 1.2;
      case 'YELLOW': return 1.0;
      case 'RED': return 0.7;
      default: return 1.0;
    }
  }

  /**
   * Configura callbacks internos
   */
  private setupCallbacks(): void {
    this.pipeline.setResultCallback((result, leadIndex, rttMs) => {
      this.onRequestComplete(result, rttMs);
    });
    
    this.circuitBreaker.onTrip(() => {
      this.pipeline.pause();
      this.burstProfile.forceAdaptive();
    });
    
    this.circuitBreaker.onRecover(() => {
      this.pipeline.resume();
    });
  }

  /**
   * Inicia o controlador para uma campanha
   */
  start(totalLeads: number): void {
    this.startTime = Date.now();
    this.totalSent = 0;
    this.successCount = 0;
    this.failedCount = 0;
    this.consecutiveSuccesses = 0;
    this.consecutiveErrors = 0;
    this.isActive = true;
    
    this.tokenBucket.reset();
    this.rttWindow.clear();
    this.circuitBreaker.reset();
    this.pipeline.reset();
    this.burstProfile.reset();
    this.burstProfile.start();
    this.etaCalculator.start(totalLeads);
    
    console.log(`\n📱 PhoneController iniciado: ${this.config.displayPhoneNumber}`);
    console.log(`   🎯 Qualidade: ${this.config.qualityRating}`);
    console.log(`   ⚡ Taxa base: ${this.config.baseRefillRate} msg/s`);
    console.log(`   🔄 Concorrência: ${this.config.maxConcurrentRequests} requests`);
  }

  /**
   * Verifica se pode submeter novo request
   */
  canSubmit(): boolean {
    if (!this.isActive) return false;
    if (!this.circuitBreaker.canSend()) return false;
    if (!this.pipeline.canSubmit()) return false;
    return true;
  }

  /**
   * Retorna quantos slots estão disponíveis
   */
  availableSlots(): number {
    if (!this.isActive) return 0;
    if (!this.circuitBreaker.canSend()) return 0;
    return this.pipeline.availableSlots();
  }

  /**
   * Aguarda slot disponível
   */
  async waitForSlot(): Promise<number> {
    const cbWait = await this.circuitBreaker.waitForReady();
    
    if (!this.pipeline.canSubmit()) {
      await this.pipeline.waitForSlot();
    }
    
    const tokenWait = await this.tokenBucket.waitForToken();
    
    return cbWait + tokenWait;
  }

  /**
   * Submete request ao pipeline
   */
  submit(
    requestFn: () => Promise<SendResult>,
    leadIndex: number
  ): string | null {
    if (!this.canSubmit()) return null;
    
    const burstMultiplier = this.burstProfile.getMultiplier();
    
    if (burstMultiplier > 1) {
      const currentRate = this.tokenBucket.getStats().refillRate;
      this.tokenBucket.setRefillRate(currentRate * burstMultiplier);
    }
    
    return this.pipeline.submit(requestFn, leadIndex);
  }

  /**
   * Processa resultado de request
   */
  private onRequestComplete(result: SendResult, rttMs: number): void {
    this.totalSent++;
    
    if (result.success) {
      this.successCount++;
      this.consecutiveSuccesses++;
      this.consecutiveErrors = 0;
      
      this.rttWindow.add(rttMs);
      this.adjustRateByRtt();
      
      if (this.consecutiveSuccesses >= 5 && this.consecutiveSuccesses % 5 === 0) {
        this.burstProfile.onRecovery();
      }
    } else {
      this.failedCount++;
      this.consecutiveErrors++;
      this.consecutiveSuccesses = 0;
      this.lastErrorTime = Date.now();
      
      this.burstProfile.onStressDetected();
      this.tokenBucket.decelerate(20);
    }
    
    this.circuitBreaker.recordResult(result.success, rttMs, result.isRateLimitError);
    this.etaCalculator.recordProgress(this.successCount);
  }

  /**
   * Ajusta taxa baseado em RTT - SINAL PRIMÁRIO
   */
  private adjustRateByRtt(): void {
    if (!this.rttWindow.hasEnoughData()) return;
    
    const stats = this.rttWindow.getStats();
    const threshold = this.targetRttMs * (1 + this.rttThresholdPercent / 100);
    
    if (stats.p95 > threshold) {
      const overage = (stats.p95 - this.targetRttMs) / this.targetRttMs;
      const deceleration = Math.min(25, overage * 100);
      
      this.tokenBucket.decelerate(deceleration);
      this.burstProfile.onStressDetected();
      
      console.log(`   ⚠️ RTT p95 ${stats.p95.toFixed(0)}ms > threshold ${threshold.toFixed(0)}ms → desacelerando ${deceleration.toFixed(1)}%`);
    } else if (stats.p95 < this.targetRttMs * 0.7 && stats.trend !== 'increasing') {
      this.tokenBucket.accelerate(5);
    }
    
    if (stats.trend === 'increasing' && stats.trendStrength > 0.1) {
      this.tokenBucket.decelerate(5);
    }
  }

  /**
   * Aguarda todos os requests em voo completarem
   */
  async drain(): Promise<void> {
    await this.pipeline.drain();
  }

  /**
   * Para o controlador
   */
  stop(): void {
    this.isActive = false;
    this.pipeline.pause();
  }

  /**
   * Retorna estatísticas completas
   */
  getStats(): PhoneControllerStats {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const currentRate = elapsed > 0 ? this.successCount / elapsed : 0;
    const bucketStats = this.tokenBucket.getStats();
    const rttStats = this.rttWindow.getStats();
    const pipelineStats = this.pipeline.getStats();
    
    return {
      phoneNumberId: this.config.phoneNumberId,
      displayPhoneNumber: this.config.displayPhoneNumber,
      qualityRating: this.config.qualityRating,
      totalSent: this.totalSent,
      successCount: this.successCount,
      failedCount: this.failedCount,
      currentRate: Math.round(currentRate * 100) / 100,
      targetRate: bucketStats.refillRate,
      avgRttMs: Math.round(rttStats.avg),
      p95RttMs: Math.round(rttStats.p95),
      inFlightRequests: pipelineStats.inFlight,
      circuitState: this.circuitBreaker.getState(),
      burstState: this.burstProfile.getState(),
      eta: this.etaCalculator.getEstimate(),
      isHealthy: this.circuitBreaker.getState() === 'CLOSED' && this.consecutiveErrors < 3,
      lastErrorTime: this.lastErrorTime,
      consecutiveSuccesses: this.consecutiveSuccesses
    };
  }

  /**
   * Verifica se está saudável
   */
  isHealthy(): boolean {
    return this.circuitBreaker.getState() === 'CLOSED' && this.consecutiveErrors < 3;
  }

  /**
   * Verifica se está ativo
   */
  isRunning(): boolean {
    return this.isActive;
  }

  /**
   * Retorna número de requests em voo
   */
  inFlightCount(): number {
    return this.pipeline.inFlightCount();
  }

  /**
   * Retorna ID do número
   */
  getPhoneNumberId(): string {
    return this.config.phoneNumberId;
  }

  /**
   * Retorna display number
   */
  getDisplayPhoneNumber(): string {
    return this.config.displayPhoneNumber;
  }
}
