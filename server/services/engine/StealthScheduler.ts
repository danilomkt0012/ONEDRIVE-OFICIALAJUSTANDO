import crypto from 'crypto';

export interface StealthConfig {
  cycleIntervalBaseMs: number;
  cycleIntervalJitterMs: number;
  baseBatchSize: number;
  batchSizeVariation: number;
  microDelayMinMs: number;
  microDelayMaxMs: number;
  rampUpInitialBatch: number;
  rampUpMultiplier: number;
  rampUpSuccessfulCyclesNeeded: number;
  businessHoursStart: number;
  businessHoursEnd: number;
  businessHoursOnly: boolean;
  enableGeographicShuffle: boolean;
}

const DEFAULT_STEALTH_CONFIG: StealthConfig = {
  cycleIntervalBaseMs: 5000,
  cycleIntervalJitterMs: 2000,
  baseBatchSize: 200,
  batchSizeVariation: 25,
  microDelayMinMs: 80,
  microDelayMaxMs: 300,
  rampUpInitialBatch: 50,
  rampUpMultiplier: 2,
  rampUpSuccessfulCyclesNeeded: 2,
  businessHoursStart: 8,
  businessHoursEnd: 20,
  businessHoursOnly: false,
  enableGeographicShuffle: true,
};

export interface PhoneRampUpState {
  phoneId: string;
  isNew: boolean;
  currentBatchLimit: number;
  cyclesCompleted: number;
  consecutiveSuccessfulCycles: number;
  maxBatchLimit: number;
}

export interface LeadWithDDD {
  phone: string;
  ddd: string;
  index: number;
  [key: string]: any;
}

export class StealthScheduler {
  private config: StealthConfig;
  private rampUpStates: Map<string, PhoneRampUpState> = new Map();
  private lastMessageParams: Map<string, string> = new Map();

  constructor(config?: Partial<StealthConfig>) {
    this.config = { ...DEFAULT_STEALTH_CONFIG, ...config };
  }

  getCycleIntervalMs(): number {
    const jitterRange = Math.max(1, Math.floor(this.config.cycleIntervalJitterMs * 2));
    const jitter = crypto.randomInt(0, jitterRange) - this.config.cycleIntervalJitterMs;
    return Math.max(1000, this.config.cycleIntervalBaseMs + jitter);
  }

  getBatchSize(phoneId: string): number {
    const rampUp = this.rampUpStates.get(phoneId);
    if (rampUp && rampUp.isNew) {
      return rampUp.currentBatchLimit;
    }

    const variationRange = Math.max(1, this.config.batchSizeVariation * 2);
    const variation = crypto.randomInt(0, variationRange) - this.config.batchSizeVariation;
    return this.config.baseBatchSize + variation;
  }

  getMicroDelay(): number {
    const range = Math.max(1, Math.floor(this.config.microDelayMaxMs - this.config.microDelayMinMs));
    return this.config.microDelayMinMs + crypto.randomInt(0, range);
  }

  async applyMicroDelay(): Promise<void> {
    const delay = this.getMicroDelay();
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  getSequenceDelay(leadParams: string, phoneId: string): number {
    const key = `${phoneId}`;
    const lastParams = this.lastMessageParams.get(key);
    this.lastMessageParams.set(key, leadParams);

    if (lastParams === leadParams) {
      return 50 + crypto.randomInt(0, 200);
    }
    return 0;
  }

  initializeRampUp(phoneId: string, isNew: boolean, maxBatchLimit: number): void {
    this.rampUpStates.set(phoneId, {
      phoneId,
      isNew,
      currentBatchLimit: isNew ? this.config.rampUpInitialBatch : maxBatchLimit,
      cyclesCompleted: 0,
      consecutiveSuccessfulCycles: 0,
      maxBatchLimit,
    });

    if (isNew) {
      console.log(`🌱 Ramp-up iniciado para ${phoneId}: ${this.config.rampUpInitialBatch} msgs/ciclo`);
    }
  }

  recordCycleResult(phoneId: string, successRate: number): void {
    const state = this.rampUpStates.get(phoneId);
    if (!state) return;

    state.cyclesCompleted++;

    if (successRate >= 1.0) {
      state.consecutiveSuccessfulCycles++;
    } else {
      state.consecutiveSuccessfulCycles = 0;
    }

    if (state.isNew && state.consecutiveSuccessfulCycles >= this.config.rampUpSuccessfulCyclesNeeded) {
      const newLimit = Math.min(
        state.currentBatchLimit * this.config.rampUpMultiplier,
        state.maxBatchLimit
      );

      if (newLimit > state.currentBatchLimit) {
        console.log(`📈 Ramp-up ${phoneId}: ${state.currentBatchLimit} → ${newLimit} msgs/ciclo`);
        state.currentBatchLimit = newLimit;
        state.consecutiveSuccessfulCycles = 0;
      }

      if (state.currentBatchLimit >= state.maxBatchLimit) {
        state.isNew = false;
        console.log(`✅ Ramp-up completo para ${phoneId}: limite máximo ${state.maxBatchLimit} atingido`);
      }
    }
  }

  isWithinBusinessHours(): boolean {
    if (!this.config.businessHoursOnly) return true;

    const now = new Date();
    const hour = now.getHours();
    return hour >= this.config.businessHoursStart && hour < this.config.businessHoursEnd;
  }

  getNextBusinessHoursStart(): Date {
    const now = new Date();
    const hour = now.getHours();

    if (hour < this.config.businessHoursStart) {
      const next = new Date(now);
      next.setHours(this.config.businessHoursStart, 0, 0, 0);
      return next;
    }

    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    next.setHours(this.config.businessHoursStart, 0, 0, 0);
    return next;
  }

  shuffleByGeography<T extends { phone: string }>(leads: T[], phoneCount: number): T[] {
    if (!this.config.enableGeographicShuffle || leads.length <= 1) {
      return leads;
    }

    const extractDDD = (phone: string): string => {
      const digits = phone.replace(/\D/g, '');
      const normalized = digits.startsWith('55') ? digits.slice(2) : digits;
      return normalized.substring(0, 2);
    };

    const byDDD: Map<string, T[]> = new Map();
    for (const lead of leads) {
      const ddd = extractDDD(lead.phone);
      if (!byDDD.has(ddd)) byDDD.set(ddd, []);
      byDDD.get(ddd)!.push(lead);
    }

    const dddList = Array.from(byDDD.keys());
    for (const leads of byDDD.values()) {
      for (let i = leads.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);
        [leads[i], leads[j]] = [leads[j], leads[i]];
      }
    }

    const result: T[] = [];
    let dddIndex = 0;
    const dddPointers = new Map<string, number>();
    for (const ddd of dddList) {
      dddPointers.set(ddd, 0);
    }

    while (result.length < leads.length) {
      let found = false;
      for (let i = 0; i < dddList.length; i++) {
        const ddd = dddList[(dddIndex + i) % dddList.length];
        const pointer = dddPointers.get(ddd)!;
        const dddLeads = byDDD.get(ddd)!;

        if (pointer < dddLeads.length) {
          result.push(dddLeads[pointer]);
          dddPointers.set(ddd, pointer + 1);
          dddIndex = (dddIndex + i + 1) % dddList.length;
          found = true;
          break;
        }
      }

      if (!found) break;
    }

    return result;
  }

  updateConfig(updates: Partial<StealthConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getRampUpState(phoneId: string): PhoneRampUpState | undefined {
    return this.rampUpStates.get(phoneId);
  }

  getConfig(): StealthConfig {
    return { ...this.config };
  }

  getStats(): {
    rampUpPhones: number;
    newPhones: number;
    isBusinessHours: boolean;
    config: StealthConfig;
  } {
    const states = Array.from(this.rampUpStates.values());
    return {
      rampUpPhones: states.length,
      newPhones: states.filter(s => s.isNew).length,
      isBusinessHours: this.isWithinBusinessHours(),
      config: this.config,
    };
  }
}

export const stealthScheduler = new StealthScheduler();
