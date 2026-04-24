/**
 * ============================================================================
 * FEEDBACK CONTROLLER
 * ============================================================================
 * 
 * Controlador PID-like que ajusta a velocidade de envio baseado em:
 * - RTT observado vs alvo
 * - Taxa de erros
 * - Tendência de latência
 * 
 * Regras de ajuste:
 * - RTT baixo (< 70% alvo) → acelera 10%
 * - RTT alto (> 100% alvo) → desacelera 15%
 * - Erro → desacelera 30% + pausa curta
 * - Nunca zera completamente (mantém taxa mínima)
 */

import { TokenBucket } from './TokenBucket';
import { SlidingWindow, RttStats } from './SlidingWindow';

export interface FeedbackControllerConfig {
  targetRttMs: number;
  accelerationPercent: number;
  decelerationPercent: number;
  errorDecelerationPercent: number;
  minPauseOnErrorMs: number;
  maxPauseOnErrorMs: number;
  consecutiveErrorsForPause: number;
  stressThresholdPercent: number;
}

export type SendingPhase = 'burst' | 'rampUp' | 'stable' | 'rampDown' | 'recovery';

export interface ControllerState {
  phase: SendingPhase;
  currentRateMultiplier: number;
  consecutiveSuccesses: number;
  consecutiveErrors: number;
  totalAdjustments: number;
  lastAdjustmentTime: number;
  isPaused: boolean;
  pauseEndTime: number;
}

export class FeedbackController {
  private config: FeedbackControllerConfig;
  private tokenBucket: TokenBucket;
  private rttWindow: SlidingWindow;
  private state: ControllerState;
  private phaseStartTime: number;
  private burstDurationMs: number = 60000;
  private stableDurationMs: number = 30000;

  constructor(
    tokenBucket: TokenBucket,
    rttWindow: SlidingWindow,
    config: Partial<FeedbackControllerConfig> = {}
  ) {
    this.tokenBucket = tokenBucket;
    this.rttWindow = rttWindow;
    
    this.config = {
      targetRttMs: config.targetRttMs ?? 250,
      accelerationPercent: config.accelerationPercent ?? 10,
      decelerationPercent: config.decelerationPercent ?? 15,
      errorDecelerationPercent: config.errorDecelerationPercent ?? 30,
      minPauseOnErrorMs: config.minPauseOnErrorMs ?? 1000,
      maxPauseOnErrorMs: config.maxPauseOnErrorMs ?? 15000,
      consecutiveErrorsForPause: config.consecutiveErrorsForPause ?? 3,
      stressThresholdPercent: config.stressThresholdPercent ?? 120
    };
    
    this.phaseStartTime = Date.now();
    this.state = {
      phase: 'burst',
      currentRateMultiplier: 1.0,
      consecutiveSuccesses: 0,
      consecutiveErrors: 0,
      totalAdjustments: 0,
      lastAdjustmentTime: Date.now(),
      isPaused: false,
      pauseEndTime: 0
    };
  }

  /**
   * Processa resultado de envio e ajusta velocidade
   */
  onSendResult(success: boolean, rttMs: number): void {
    if (success) {
      this.rttWindow.add(rttMs);
      this.state.consecutiveSuccesses++;
      this.state.consecutiveErrors = 0;
      this.adjustBasedOnRtt();
    } else {
      this.state.consecutiveErrors++;
      this.state.consecutiveSuccesses = 0;
      this.handleError();
    }
    
    this.updatePhase();
  }

  /**
   * Ajusta velocidade baseado no RTT observado
   */
  private adjustBasedOnRtt(): void {
    if (!this.rttWindow.hasEnoughData()) return;
    
    const stats = this.rttWindow.getStats();
    const rttRatio = stats.p95 / this.config.targetRttMs;
    
    const now = Date.now();
    const timeSinceLastAdjust = now - this.state.lastAdjustmentTime;
    if (timeSinceLastAdjust < 1000) return;
    
    if (rttRatio < 0.7) {
      this.tokenBucket.accelerate(this.config.accelerationPercent);
      this.state.currentRateMultiplier *= (1 + this.config.accelerationPercent / 100);
      this.state.totalAdjustments++;
      this.state.lastAdjustmentTime = now;
    } else if (rttRatio > 1.0) {
      const severity = Math.min(2, rttRatio);
      const deceleration = this.config.decelerationPercent * severity;
      this.tokenBucket.decelerate(deceleration);
      this.state.currentRateMultiplier *= (1 - deceleration / 100);
      this.state.totalAdjustments++;
      this.state.lastAdjustmentTime = now;
    }
    
    if (stats.trend === 'increasing' && stats.trendStrength > 0.1) {
      this.tokenBucket.decelerate(5);
      this.state.currentRateMultiplier *= 0.95;
    }
  }

  /**
   * Trata erro de envio
   */
  private handleError(): void {
    this.tokenBucket.decelerate(this.config.errorDecelerationPercent);
    this.state.currentRateMultiplier *= (1 - this.config.errorDecelerationPercent / 100);
    this.state.currentRateMultiplier = Math.max(0.1, this.state.currentRateMultiplier);
    
    if (this.state.consecutiveErrors >= this.config.consecutiveErrorsForPause) {
      const pauseMs = Math.min(
        this.config.maxPauseOnErrorMs,
        this.config.minPauseOnErrorMs * Math.pow(2, this.state.consecutiveErrors - this.config.consecutiveErrorsForPause)
      );
      
      this.state.isPaused = true;
      this.state.pauseEndTime = Date.now() + pauseMs;
      this.state.phase = 'recovery';
    }
  }

  /**
   * Atualiza fase de envio
   */
  private updatePhase(): void {
    const now = Date.now();
    const phaseElapsed = now - this.phaseStartTime;
    
    if (this.state.phase === 'recovery' && !this.state.isPaused) {
      if (this.state.consecutiveSuccesses >= 5) {
        this.state.phase = 'rampUp';
        this.phaseStartTime = now;
      }
    } else if (this.state.phase === 'burst') {
      if (phaseElapsed > this.burstDurationMs) {
        this.state.phase = 'stable';
        this.phaseStartTime = now;
        this.tokenBucket.endBurstPhase();
      }
    } else if (this.state.phase === 'rampUp') {
      if (this.state.currentRateMultiplier >= 0.9 && this.state.consecutiveSuccesses >= 10) {
        this.state.phase = 'stable';
        this.phaseStartTime = now;
      }
    } else if (this.state.phase === 'stable') {
      const stats = this.rttWindow.getStats();
      if (stats.trend === 'increasing' && stats.trendStrength > 0.15) {
        this.state.phase = 'rampDown';
        this.phaseStartTime = now;
      }
    } else if (this.state.phase === 'rampDown') {
      const stats = this.rttWindow.getStats();
      if (stats.trend !== 'increasing' && this.state.consecutiveSuccesses >= 5) {
        this.state.phase = 'stable';
        this.phaseStartTime = now;
      }
    }
  }

  /**
   * Verifica se está em pausa e aguarda se necessário
   */
  async waitIfPaused(): Promise<number> {
    if (!this.state.isPaused) return 0;
    
    const now = Date.now();
    if (now >= this.state.pauseEndTime) {
      this.state.isPaused = false;
      this.state.consecutiveErrors = 0;
      return 0;
    }
    
    const waitTime = this.state.pauseEndTime - now;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    this.state.isPaused = false;
    this.state.consecutiveErrors = 0;
    
    return waitTime;
  }

  /**
   * Detecta stress iminente (antes do erro 135000)
   */
  isUnderStress(): boolean {
    if (!this.rttWindow.hasEnoughData()) return false;
    
    const stats = this.rttWindow.getStats();
    const stressRatio = (this.config.stressThresholdPercent / 100);
    
    if (stats.p95 > this.config.targetRttMs * stressRatio) {
      return true;
    }
    
    if (stats.trend === 'increasing' && stats.trendStrength > 0.2) {
      return true;
    }
    
    return false;
  }

  /**
   * Retorna estado atual do controlador
   */
  getState(): ControllerState {
    return { ...this.state };
  }

  /**
   * Retorna estatísticas de RTT
   */
  getRttStats(): RttStats {
    return this.rttWindow.getStats();
  }

  /**
   * Reset para estado inicial
   */
  reset(): void {
    this.state = {
      phase: 'burst',
      currentRateMultiplier: 1.0,
      consecutiveSuccesses: 0,
      consecutiveErrors: 0,
      totalAdjustments: 0,
      lastAdjustmentTime: Date.now(),
      isPaused: false,
      pauseEndTime: 0
    };
    this.phaseStartTime = Date.now();
    this.rttWindow.clear();
    this.tokenBucket.reset();
  }

  /**
   * Define novo alvo de RTT
   */
  setTargetRtt(targetMs: number): void {
    this.config.targetRttMs = targetMs;
  }
}
