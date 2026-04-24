/**
 * ============================================================================
 * PERFIL DE RAMP-UP GRADUAL (SEM BURST)
 * ============================================================================
 * 
 * Ramp-up gradual e seguro para base fria:
 * - Início a 10 msg/min (~0.17 msg/s)
 * - Aumento de 5 msg/min a cada 5 minutos
 * - Até atingir o alvo (30-50 msg/min)
 * - Só aumenta se taxa de entrega > 60%
 * - Se taxa cair, reduz velocidade
 * - Sem burst em nenhum momento (multiplicador sempre 1.0)
 */

export interface BurstPhase {
  name: string;
  durationMs: number;
  multiplier: number;
  minMultiplier: number;
}

export interface BurstProfileConfig {
  phases: BurstPhase[];
  stressReductionPercent: number;
  recoveryIncrementPercent: number;
  minMultiplier: number;
  maxMultiplier: number;
  rampUpStartMsgPerMin: number;
  rampUpIncrementMsgPerMin: number;
  rampUpIntervalMs: number;
  rampUpTargetMsgPerMin: number;
  rampUpMinDeliveryRate: number;
}

export interface BurstState {
  currentPhase: number;
  phaseName: string;
  multiplier: number;
  effectiveMultiplier: number;
  elapsedMs: number;
  phaseElapsedMs: number;
  phaseRemainingMs: number;
  isStressed: boolean;
  stressReductions: number;
  rampUpCurrentMsgPerMin: number;
  rampUpTargetMsgPerMin: number;
}

export class BurstProfile {
  private config: BurstProfileConfig;
  private startTime: number = 0;
  private isStarted: boolean = false;
  private stressReductions: number = 0;
  private currentStressReduction: number = 0;
  private isStressed: boolean = false;
  private rampUpCurrentMsgPerMin: number;
  private lastRampUpTime: number = 0;

  constructor(config?: Partial<BurstProfileConfig>) {
    const defaultPhases: BurstPhase[] = [
      { name: 'gradual_rampup', durationMs: Infinity, multiplier: 1.0, minMultiplier: 0.5 }
    ];

    this.config = {
      phases: config?.phases ?? defaultPhases,
      stressReductionPercent: config?.stressReductionPercent ?? 20,
      recoveryIncrementPercent: config?.recoveryIncrementPercent ?? 5,
      minMultiplier: config?.minMultiplier ?? 0.5,
      maxMultiplier: config?.maxMultiplier ?? 1.0,
      rampUpStartMsgPerMin: config?.rampUpStartMsgPerMin ?? 10,
      rampUpIncrementMsgPerMin: config?.rampUpIncrementMsgPerMin ?? 5,
      rampUpIntervalMs: config?.rampUpIntervalMs ?? 300000,
      rampUpTargetMsgPerMin: config?.rampUpTargetMsgPerMin ?? 30,
      rampUpMinDeliveryRate: config?.rampUpMinDeliveryRate ?? 0.6,
    };

    this.rampUpCurrentMsgPerMin = this.config.rampUpStartMsgPerMin;
  }

  start(): void {
    this.startTime = Date.now();
    this.isStarted = true;
    this.stressReductions = 0;
    this.currentStressReduction = 0;
    this.isStressed = false;
    this.rampUpCurrentMsgPerMin = this.config.rampUpStartMsgPerMin;
    this.lastRampUpTime = Date.now();
  }

  private getCurrentPhaseIndex(): number {
    return 0;
  }

  getRampUpRateMsgPerMin(currentDeliveryRate?: number): number {
    if (!this.isStarted) return this.config.rampUpStartMsgPerMin;

    const now = Date.now();
    const timeSinceLastRamp = now - this.lastRampUpTime;

    if (timeSinceLastRamp >= this.config.rampUpIntervalMs && !this.isStressed) {
      const deliveryOk = currentDeliveryRate === undefined || currentDeliveryRate >= this.config.rampUpMinDeliveryRate;
      if (this.rampUpCurrentMsgPerMin < this.config.rampUpTargetMsgPerMin && deliveryOk) {
        this.rampUpCurrentMsgPerMin = Math.min(
          this.rampUpCurrentMsgPerMin + this.config.rampUpIncrementMsgPerMin,
          this.config.rampUpTargetMsgPerMin
        );
        this.lastRampUpTime = now;
      } else if (!deliveryOk) {
        this.rampUpCurrentMsgPerMin = Math.max(
          this.config.rampUpStartMsgPerMin,
          Math.floor(this.rampUpCurrentMsgPerMin * 0.8)
        );
        this.lastRampUpTime = now;
      }
    }

    return this.rampUpCurrentMsgPerMin;
  }

  getRampUpRateMsgPerSec(currentDeliveryRate?: number): number {
    return this.getRampUpRateMsgPerMin(currentDeliveryRate) / 60;
  }

  getMultiplier(): number {
    return 1.0;
  }

  onStressDetected(): void {
    this.isStressed = true;
    this.stressReductions++;
    this.currentStressReduction += this.config.stressReductionPercent;
    this.currentStressReduction = Math.min(70, this.currentStressReduction);

    this.rampUpCurrentMsgPerMin = Math.max(
      this.config.rampUpStartMsgPerMin,
      this.rampUpCurrentMsgPerMin - this.config.rampUpIncrementMsgPerMin
    );
    this.lastRampUpTime = Date.now();
  }

  onRecovery(): void {
    if (this.currentStressReduction > 0) {
      this.currentStressReduction -= this.config.recoveryIncrementPercent;
      this.currentStressReduction = Math.max(0, this.currentStressReduction);
      
      if (this.currentStressReduction === 0) {
        this.isStressed = false;
      }
    }
  }

  reduceRampUpRate(): void {
    this.rampUpCurrentMsgPerMin = Math.max(
      this.config.rampUpStartMsgPerMin,
      Math.floor(this.rampUpCurrentMsgPerMin * 0.7)
    );
    this.lastRampUpTime = Date.now();
  }

  getState(): BurstState {
    const now = Date.now();
    const elapsed = this.isStarted ? now - this.startTime : 0;

    return {
      currentPhase: 0,
      phaseName: 'gradual_rampup',
      multiplier: 1.0,
      effectiveMultiplier: 1.0,
      elapsedMs: elapsed,
      phaseElapsedMs: elapsed,
      phaseRemainingMs: -1,
      isStressed: this.isStressed,
      stressReductions: this.stressReductions,
      rampUpCurrentMsgPerMin: this.rampUpCurrentMsgPerMin,
      rampUpTargetMsgPerMin: this.config.rampUpTargetMsgPerMin,
    };
  }

  isInBurstPhase(): boolean {
    return false;
  }

  reset(): void {
    this.startTime = 0;
    this.isStarted = false;
    this.stressReductions = 0;
    this.currentStressReduction = 0;
    this.isStressed = false;
    this.rampUpCurrentMsgPerMin = this.config.rampUpStartMsgPerMin;
    this.lastRampUpTime = 0;
  }

  forceAdaptive(): void {
  }

  timeToAdaptive(): number {
    return 0;
  }
}
