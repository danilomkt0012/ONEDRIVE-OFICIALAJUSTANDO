import { SlidingWindowMetrics } from '../risk/SlidingWindowMetrics';

export interface BurstPhoneState {
  phoneNumberId: string;
  displayPhoneNumber: string;
  batchCeiling: number;
  sentThisRound: number;
  utilityScore: number;
  batchUnlocked: boolean;
  isActive: boolean;
  consecutiveSuccessfulCycles: number;
  totalCyclesSent: number;
}

export interface BurstCycleResult {
  cycleNumber: number;
  totalSent: number;
  totalConfirmed: number;
  confirmationRate: number;
  holdApplied: boolean;
  holdDurationMs: number;
  phoneResults: Array<{
    phoneId: string;
    sent: number;
    confirmed: number;
  }>;
}

export interface BurstLaunchConfig {
  maxPhonesPerBurst: number;
  defaultBatchCeiling: number;
  batchPerCycle: number;
  cycleIntervalMs: number;
  holdIntervalMs: number;
  confirmationThreshold: number;
  utilityScoreUnlockThreshold: number;
  unlockedBatchCeiling: number;
}

const DEFAULT_BURST_CONFIG: BurstLaunchConfig = {
  maxPhonesPerBurst: 5,
  defaultBatchCeiling: 800,
  batchPerCycle: 200,
  cycleIntervalMs: 15000,
  holdIntervalMs: 60000,
  confirmationThreshold: 0.95,
  utilityScoreUnlockThreshold: 95,
  unlockedBatchCeiling: 1600,
};

export class BurstLaunchMode {
  private config: BurstLaunchConfig;
  private phones: Map<string, BurstPhoneState> = new Map();
  private metrics: Map<string, SlidingWindowMetrics> = new Map();
  private cycleCount: number = 0;
  private isActive: boolean = false;
  private killSwitchTriggered: boolean = false;
  private onCycleCompleteCallback?: (result: BurstCycleResult) => void;
  private onKillSwitchCallback?: (reason: string) => void;

  constructor(config?: Partial<BurstLaunchConfig>) {
    this.config = { ...DEFAULT_BURST_CONFIG, ...config };
  }

  initialize(phoneNumbers: Array<{ id: string; displayPhoneNumber: string }>): void {
    this.phones.clear();
    this.metrics.clear();

    const selected = phoneNumbers.slice(0, this.config.maxPhonesPerBurst);

    for (const phone of selected) {
      this.phones.set(phone.id, {
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.displayPhoneNumber,
        batchCeiling: this.config.defaultBatchCeiling,
        sentThisRound: 0,
        utilityScore: 0,
        batchUnlocked: false,
        isActive: true,
        consecutiveSuccessfulCycles: 0,
        totalCyclesSent: 0,
      });

      this.metrics.set(phone.id, new SlidingWindowMetrics(100));
    }

    console.log(`🚀 BurstLaunchMode: ${selected.length} números inicializados (teto: ${this.config.defaultBatchCeiling}/número)`);
  }

  start(): void {
    this.isActive = true;
    this.killSwitchTriggered = false;
    this.cycleCount = 0;
    for (const state of this.phones.values()) {
      state.sentThisRound = 0;
    }
    console.log(`🔥 Burst Mode ATIVADO com ${this.phones.size} números`);
  }

  stop(): void {
    this.isActive = false;
    console.log(`⏹️ Burst Mode DESATIVADO`);
  }

  isRunning(): boolean {
    return this.isActive && !this.killSwitchTriggered;
  }

  getBatchSizeForPhone(phoneId: string): number {
    const state = this.phones.get(phoneId);
    if (!state || !state.isActive) return 0;

    const remaining = state.batchCeiling - state.sentThisRound;
    if (remaining <= 0) return 0;

    const baseBatch = this.config.batchPerCycle;
    return Math.min(baseBatch, remaining);
  }

  recordSendResult(phoneId: string, success: boolean): void {
    const metricsWindow = this.metrics.get(phoneId);
    if (metricsWindow) {
      metricsWindow.add(success ? 1 : 0);
    }

    const state = this.phones.get(phoneId);
    if (state && success) {
      state.sentThisRound++;
      state.totalCyclesSent++;
    }
  }

  completeCycle(): BurstCycleResult {
    this.cycleCount++;
    let totalSent = 0;
    let totalConfirmed = 0;
    const phoneResults: BurstCycleResult['phoneResults'] = [];

    for (const [phoneId, state] of this.phones) {
      const metricsWindow = this.metrics.get(phoneId)!;
      const rate = metricsWindow.getRate();
      const count = metricsWindow.getCount();
      const confirmed = metricsWindow.getBlockCount();

      phoneResults.push({
        phoneId,
        sent: count,
        confirmed,
      });

      totalSent += count;
      totalConfirmed += confirmed;

      this.updateUtilityScore(phoneId, rate);
    }

    const confirmationRate = totalSent > 0 ? totalConfirmed / totalSent : 1;
    const holdApplied = confirmationRate < this.config.confirmationThreshold;
    const holdDurationMs = holdApplied ? this.config.holdIntervalMs : 0;

    if (holdApplied) {
      console.log(`⚠️ Burst Cycle #${this.cycleCount}: taxa ${(confirmationRate * 100).toFixed(1)}% < ${this.config.confirmationThreshold * 100}% → HOLD ${holdDurationMs / 1000}s`);
    } else {
      console.log(`✅ Burst Cycle #${this.cycleCount}: taxa ${(confirmationRate * 100).toFixed(1)}% → próximo ciclo imediato`);
    }

    const result: BurstCycleResult = {
      cycleNumber: this.cycleCount,
      totalSent,
      totalConfirmed,
      confirmationRate,
      holdApplied,
      holdDurationMs,
      phoneResults,
    };

    this.onCycleCompleteCallback?.(result);

    for (const m of this.metrics.values()) {
      m.reset();
    }

    return result;
  }

  private updateUtilityScore(phoneId: string, deliveryRate: number): void {
    const state = this.phones.get(phoneId);
    if (!state) return;

    const score = Math.round(deliveryRate * 100);
    state.utilityScore = score;

    if (deliveryRate >= this.config.confirmationThreshold) {
      state.consecutiveSuccessfulCycles++;
    } else {
      state.consecutiveSuccessfulCycles = 0;
    }

    if (score >= this.config.utilityScoreUnlockThreshold && !state.batchUnlocked) {
      state.batchUnlocked = true;
      state.batchCeiling = this.config.unlockedBatchCeiling;
      console.log(`🔓 Número ${state.displayPhoneNumber}: utility-score ${score} ≥ ${this.config.utilityScoreUnlockThreshold} → lote dobrado para ${this.config.unlockedBatchCeiling}`);
    } else if (score < this.config.utilityScoreUnlockThreshold && state.batchUnlocked) {
      state.batchUnlocked = false;
      state.batchCeiling = this.config.defaultBatchCeiling;
      console.log(`🔒 Número ${state.displayPhoneNumber}: utility-score ${score} < ${this.config.utilityScoreUnlockThreshold} → lote reduzido para ${this.config.defaultBatchCeiling}`);
    }
  }

  triggerKillSwitch(reason: string): void {
    this.killSwitchTriggered = true;
    this.isActive = false;

    for (const state of this.phones.values()) {
      state.isActive = false;
    }

    console.log(`🛑 KILL-SWITCH ATIVADO: ${reason}`);
    this.onKillSwitchCallback?.(reason);
  }

  getPhoneStates(): BurstPhoneState[] {
    return Array.from(this.phones.values());
  }

  getActivePhoneCount(): number {
    return Array.from(this.phones.values()).filter(p => p.isActive).length;
  }

  getTotalSentThisRound(): number {
    let total = 0;
    for (const state of this.phones.values()) {
      total += state.sentThisRound;
    }
    return total;
  }

  getTotalCapacity(): number {
    let total = 0;
    for (const state of this.phones.values()) {
      if (state.isActive) total += state.batchCeiling;
    }
    return total;
  }

  getCycleIntervalMs(): number {
    return this.config.cycleIntervalMs;
  }

  onCycleComplete(callback: (result: BurstCycleResult) => void): void {
    this.onCycleCompleteCallback = callback;
  }

  onKillSwitch(callback: (reason: string) => void): void {
    this.onKillSwitchCallback = callback;
  }

  getStats(): {
    isActive: boolean;
    killSwitchTriggered: boolean;
    cycleCount: number;
    phones: BurstPhoneState[];
    totalSent: number;
    totalCapacity: number;
  } {
    return {
      isActive: this.isActive,
      killSwitchTriggered: this.killSwitchTriggered,
      cycleCount: this.cycleCount,
      phones: this.getPhoneStates(),
      totalSent: this.getTotalSentThisRound(),
      totalCapacity: this.getTotalCapacity(),
    };
  }
}
