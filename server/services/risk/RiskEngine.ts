export type RiskAction =
  | 'KEEP'
  | 'REDUCE_20'
  | 'REDUCE_50'
  | 'COOLDOWN'
  | 'PAUSE';

export interface RiskParams {
  blockRateWindow: number;
  errorRateWindow: number;
  consecutiveErrors: number;
  rttAverage: number;
  currentSpeed: number;
}

export interface RiskResult {
  score: number;
  action: RiskAction;
  details: string;
}

export interface RecoveryState {
  isRecovering: boolean;
  recoveryStep: number;
  maxRecoverySteps: number;
  preReductionRate: number;
  currentTargetRate: number;
  recoveryStartedAt: number;
  stepIntervalMs: number;
  finalTargetRate?: number;
}

export class RiskEngine {
  private lastAction: RiskAction = 'KEEP';
  private cooldownUntil: number = 0;
  private cooldownDurationMs: number = 120_000;
  private recoveryState: RecoveryState | null = null;
  private onRecoveryStep?: (step: number, targetRate: number) => void;

  calculateRiskScore(params: RiskParams): number {
    const {
      blockRateWindow,
      errorRateWindow,
      consecutiveErrors,
      rttAverage,
    } = params;

    let score = 0;

    score += blockRateWindow * 40;
    score += errorRateWindow * 30;
    score += consecutiveErrors * 5;
    score += rttAverage > 2000 ? 10 : 0;

    return Math.min(score, 100);
  }

  evaluate(score: number): RiskAction {
    if (score > 80) return 'PAUSE';
    if (score > 60) return 'COOLDOWN';
    if (score > 40) return 'REDUCE_50';
    if (score > 25) return 'REDUCE_20';
    return 'KEEP';
  }

  assess(params: RiskParams): RiskResult {
    if (this.isInCooldown()) {
      return {
        score: 0,
        action: 'KEEP',
        details: `Em cooldown até ${new Date(this.cooldownUntil).toISOString()}`,
      };
    }

    const score = this.calculateRiskScore(params);
    const action = this.evaluate(score);

    if (action === 'COOLDOWN') {
      this.cooldownUntil = Date.now() + this.cooldownDurationMs;
    }

    this.lastAction = action;

    const details = `score=${score.toFixed(1)} blockRate=${(params.blockRateWindow * 100).toFixed(1)}% errorRate=${(params.errorRateWindow * 100).toFixed(1)}% consErrors=${params.consecutiveErrors} rtt=${params.rttAverage.toFixed(0)}ms`;
    return { score, action, details };
  }

  startGradualRecovery(preReductionRate: number, targetRate: number, steps: number = 5, stepIntervalMs: number = 30000): void {
    const startRate = targetRate * 0.3;
    this.recoveryState = {
      isRecovering: true,
      recoveryStep: 0,
      maxRecoverySteps: steps,
      preReductionRate,
      currentTargetRate: startRate,
      recoveryStartedAt: Date.now(),
      stepIntervalMs,
      finalTargetRate: targetRate,
    };
    console.log(`\n🔄 [RiskEngine] Recuperação gradual iniciada: ${startRate.toFixed(1)} → ${targetRate.toFixed(1)} msg/s em ${steps} passos`);
  }

  getNextRecoveryRate(): number | null {
    if (!this.recoveryState || !this.recoveryState.isRecovering) return null;

    const elapsed = Date.now() - this.recoveryState.recoveryStartedAt;
    const expectedStep = Math.floor(elapsed / this.recoveryState.stepIntervalMs);

    if (expectedStep <= this.recoveryState.recoveryStep) return null;

    this.recoveryState.recoveryStep = expectedStep;

    const finalTarget = this.recoveryState.finalTargetRate ?? this.recoveryState.preReductionRate;

    if (this.recoveryState.recoveryStep >= this.recoveryState.maxRecoverySteps) {
      this.recoveryState.isRecovering = false;
      this.recoveryState = null;
      return finalTarget;
    }

    const progress = this.recoveryState.recoveryStep / this.recoveryState.maxRecoverySteps;
    const startRate = finalTarget * 0.3;
    const newRate = startRate + (finalTarget - startRate) * progress;

    this.recoveryState.currentTargetRate = newRate;
    this.onRecoveryStep?.(this.recoveryState.recoveryStep, newRate);

    return newRate;
  }

  isRecovering(): boolean {
    return this.recoveryState?.isRecovering ?? false;
  }

  getRecoveryState(): RecoveryState | null {
    return this.recoveryState ? { ...this.recoveryState } : null;
  }

  setRecoveryStepCallback(callback: (step: number, targetRate: number) => void): void {
    this.onRecoveryStep = callback;
  }

  isInCooldown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  getCooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  getLastAction(): RiskAction {
    return this.lastAction;
  }

  reset(): void {
    this.lastAction = 'KEEP';
    this.cooldownUntil = 0;
    this.recoveryState = null;
  }
}
