import crypto from 'crypto';

export type BaseType = 'cold' | 'warm' | 'hot';

export interface HumanBehaviorConfig {
  baseDelayMeanMs: number;
  baseDelayStdDevMs: number;
  baseDelayMinMs: number;
  baseDelayMaxMs: number;

  longPauseMinMs: number;
  longPauseMaxMs: number;
  longPauseEveryMin: number;
  longPauseEveryMax: number;

  cyclePauseMinMs: number;
  cyclePauseMaxMs: number;
  cyclePauseEveryMin: number;
  cyclePauseEveryMax: number;

  baseType: BaseType;
  coldBaseDailyLimitPerNumber: number;
  coldBaseRateMultiplier: number;

  templateWeights: Record<string, number>;
  templateCategories: Record<string, 'engagement' | 'conversion' | 'general'>;
}

export interface BaseTypeStrategy {
  rateMultiplier: number;
  dailyLimitPerNumber: number;
  templatePriority: 'engagement' | 'conversion' | 'balanced';
  delayMultiplier: number;
}

const BASE_TYPE_STRATEGIES: Record<BaseType, BaseTypeStrategy> = {
  cold: {
    rateMultiplier: 0.3,
    dailyLimitPerNumber: 500,
    templatePriority: 'engagement',
    delayMultiplier: 1.5,
  },
  warm: {
    rateMultiplier: 0.7,
    dailyLimitPerNumber: 2000,
    templatePriority: 'balanced',
    delayMultiplier: 1.0,
  },
  hot: {
    rateMultiplier: 1.0,
    dailyLimitPerNumber: 10000,
    templatePriority: 'conversion',
    delayMultiplier: 1.0,
  },
};

const DEFAULT_CONFIG: HumanBehaviorConfig = {
  baseDelayMeanMs: 900,
  baseDelayStdDevMs: 200,
  baseDelayMinMs: 600,
  baseDelayMaxMs: 1200,

  longPauseMinMs: 8000,
  longPauseMaxMs: 15000,
  longPauseEveryMin: 50,
  longPauseEveryMax: 80,

  cyclePauseMinMs: 20000,
  cyclePauseMaxMs: 45000,
  cyclePauseEveryMin: 300,
  cyclePauseEveryMax: 500,

  baseType: 'cold',
  coldBaseDailyLimitPerNumber: 500,
  coldBaseRateMultiplier: 0.3,

  templateWeights: {},
  templateCategories: {},
};

interface PhoneState {
  offset: number;
  messageCount: number;
  nextLongPauseAt: number;
  nextCyclePauseAt: number;
  lastTemplateIndex: number;
  dailySentCount: number;
  longPauseEveryMin: number;
  longPauseEveryMax: number;
  cyclePauseEveryMin: number;
  cyclePauseEveryMax: number;
  longPauseDurationMinMs: number;
  longPauseDurationMaxMs: number;
  cyclePauseDurationMinMs: number;
  cyclePauseDurationMaxMs: number;
}

interface BackoffEntry {
  errorCount: number;
  currentBackoffMs: number;
  lastErrorAt: number;
  lastTestAt: number;
  blocked: boolean;
}

function secureRandomFloat(): number {
  return crypto.randomInt(0, 2147483647) / 2147483647;
}

function secureRandomBetween(min: number, max: number): number {
  return min + crypto.randomInt(0, Math.max(1, Math.floor(max - min + 1)));
}

export class HumanBehavior {
  private config: HumanBehaviorConfig;
  private phoneStates: Map<string, PhoneState> = new Map();
  private templateQualityScores: Map<string, number> = new Map();

  constructor(config?: Partial<HumanBehaviorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateTemplateQualityScore(templateName: string, deliveryRate: number): void {
    this.templateQualityScores.set(templateName, deliveryRate);
  }

  static gaussianRandom(mean: number, stdDev: number): number {
    let u = 0, v = 0;
    while (u === 0) u = secureRandomFloat();
    while (v === 0) v = secureRandomFloat();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mean + z * stdDev;
  }

  private getOrCreatePhoneState(phoneId: string): PhoneState {
    let state = this.phoneStates.get(phoneId);
    if (!state) {
      const hash = this.hashString(phoneId);
      const offset = (hash % 5000) + 1000;

      const longPauseVariance = (hash % 10) - 5;
      const cyclePauseVariance = ((hash >> 4) % 10) - 5;
      const longPauseMinJitter = Math.max(5, this.config.longPauseEveryMin + longPauseVariance);
      const longPauseMaxJitter = Math.max(longPauseMinJitter + 5, this.config.longPauseEveryMax + cyclePauseVariance);
      const cyclePauseMinJitter = Math.max(50, this.config.cyclePauseEveryMin + ((hash >> 8) % 30) - 15);
      const cyclePauseMaxJitter = Math.max(cyclePauseMinJitter + 20, this.config.cyclePauseEveryMax + ((hash >> 12) % 40) - 20);

      state = {
        offset,
        messageCount: 0,
        nextLongPauseAt: secureRandomBetween(longPauseMinJitter, longPauseMaxJitter),
        nextCyclePauseAt: secureRandomBetween(cyclePauseMinJitter, cyclePauseMaxJitter),
        lastTemplateIndex: -1,
        dailySentCount: 0,
        longPauseEveryMin: longPauseMinJitter,
        longPauseEveryMax: longPauseMaxJitter,
        cyclePauseEveryMin: cyclePauseMinJitter,
        cyclePauseEveryMax: cyclePauseMaxJitter,
        longPauseDurationMinMs: Math.min(this.config.longPauseMaxMs, this.config.longPauseMinMs + (hash % 1500)),
        longPauseDurationMaxMs: Math.min(this.config.longPauseMaxMs * 1.25, this.config.longPauseMaxMs + ((hash >> 3) % 2000)),
        cyclePauseDurationMinMs: Math.min(this.config.cyclePauseMaxMs, this.config.cyclePauseMinMs + ((hash >> 6) % 5000)),
        cyclePauseDurationMaxMs: Math.min(this.config.cyclePauseMaxMs * 1.25, this.config.cyclePauseMaxMs + ((hash >> 9) % 10000)),
      };
      this.phoneStates.set(phoneId, state);
    }
    return state;
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  getMessageDelay(phoneId: string, messageLength?: number): number {
    const strategy = this.getBaseTypeStrategy();
    const state = this.getOrCreatePhoneState(phoneId);

    let delay = HumanBehavior.gaussianRandom(
      this.config.baseDelayMeanMs * strategy.delayMultiplier,
      this.config.baseDelayStdDevMs
    );

    delay = Math.max(this.config.baseDelayMinMs, Math.min(this.config.baseDelayMaxMs * strategy.delayMultiplier, delay));

    if (messageLength && messageLength > 0) {
      const lengthFactor = Math.min(messageLength / 100, 3.0);
      delay += lengthFactor * 200;
    }

    const hour = new Date().getHours();
    if (hour >= 22 || hour < 7) {
      delay *= 1.8;
    } else if (hour >= 20 || hour < 8) {
      delay *= 1.3;
    } else if (hour >= 12 && hour <= 13) {
      delay *= 1.15;
    }

    const dailyUsageRatio = state.dailySentCount / (strategy.dailyLimitPerNumber || 500);
    if (dailyUsageRatio > 0.8) {
      delay *= 1.5;
    } else if (dailyUsageRatio > 0.6) {
      delay *= 1.2;
    }

    const jitter = (secureRandomFloat() - 0.5) * 400;
    delay += jitter;

    const phoneJitter = (state.offset % 500) - 250;
    delay += phoneJitter;

    return Math.max(this.config.baseDelayMinMs, Math.round(delay));
  }

  async applyMessageDelay(phoneId: string, messageLength?: number): Promise<number> {
    const delay = this.getMessageDelay(phoneId, messageLength);
    await new Promise(resolve => setTimeout(resolve, delay));
    return delay;
  }

  checkAndApplyLongPause(phoneId: string): { shouldPause: boolean; durationMs: number } {
    const state = this.getOrCreatePhoneState(phoneId);
    state.messageCount++;

    if (state.messageCount >= state.nextLongPauseAt) {
      const duration = secureRandomBetween(state.longPauseDurationMinMs, state.longPauseDurationMaxMs);
      state.nextLongPauseAt = state.messageCount + secureRandomBetween(state.longPauseEveryMin, state.longPauseEveryMax);
      return { shouldPause: true, durationMs: duration };
    }

    return { shouldPause: false, durationMs: 0 };
  }

  checkAndApplyCyclePause(phoneId: string): { shouldPause: boolean; durationMs: number } {
    const state = this.getOrCreatePhoneState(phoneId);

    if (state.messageCount >= state.nextCyclePauseAt) {
      const duration = secureRandomBetween(state.cyclePauseDurationMinMs, state.cyclePauseDurationMaxMs);
      state.nextCyclePauseAt = state.messageCount + secureRandomBetween(state.cyclePauseEveryMin, state.cyclePauseEveryMax);
      return { shouldPause: true, durationMs: duration };
    }

    return { shouldPause: false, durationMs: 0 };
  }

  selectTemplate(
    templateCount: number,
    phoneId: string,
    templateNames?: string[],
    rotationMode?: string
  ): number {
    const state = this.getOrCreatePhoneState(phoneId);

    if (templateCount <= 1) {
      state.lastTemplateIndex = 0;
      return 0;
    }

    if (rotationMode === 'sequential') {
      const next = ((state.lastTemplateIndex ?? -1) + 1) % templateCount;
      state.lastTemplateIndex = next;
      return next;
    }

    const strategy = this.getBaseTypeStrategy();
    const weights: number[] = [];
    for (let i = 0; i < templateCount; i++) {
      const name = templateNames?.[i] || `template_${i}`;
      let weight = this.config.templateWeights[name] ?? 1.0;

      if (i === state.lastTemplateIndex) {
        weight = 0;
      }

      const category = this.config.templateCategories[name] || 'general';
      if (strategy.templatePriority === 'engagement' && category === 'engagement') {
        weight *= 2.0;
      } else if (strategy.templatePriority === 'conversion' && category === 'conversion') {
        weight *= 2.0;
      } else if (strategy.templatePriority !== 'balanced' && category === 'general') {
        weight *= 1.0;
      }

      if (this.templateQualityScores.has(name)) {
        const qualityScore = this.templateQualityScores.get(name)!;
        weight *= Math.max(0.2, qualityScore);
      }

      weights.push(Math.max(0, weight));
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight <= 0) {
      const fallback = (state.lastTemplateIndex + 1) % templateCount;
      state.lastTemplateIndex = fallback;
      return fallback;
    }

    let random = secureRandomFloat() * totalWeight;

    for (let i = 0; i < weights.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        state.lastTemplateIndex = i;
        return i;
      }
    }

    const fallback = (state.lastTemplateIndex + 1) % templateCount;
    state.lastTemplateIndex = fallback;
    return fallback;
  }

  getPhoneOffset(phoneId: string): number {
    const state = this.getOrCreatePhoneState(phoneId);
    return state.offset;
  }

  async applyPhoneOffset(phoneId: string): Promise<number> {
    const offset = this.getPhoneOffset(phoneId);
    const jitter = crypto.randomInt(0, 300);
    const totalOffset = offset + jitter;
    await new Promise(resolve => setTimeout(resolve, totalOffset));
    return totalOffset;
  }

  getBaseTypeStrategy(): BaseTypeStrategy {
    const strategy = { ...BASE_TYPE_STRATEGIES[this.config.baseType] };
    if (this.config.baseType === 'cold') {
      strategy.dailyLimitPerNumber = this.config.coldBaseDailyLimitPerNumber;
      strategy.rateMultiplier = this.config.coldBaseRateMultiplier;
    }
    return strategy;
  }

  isOverDailyLimit(_phoneId: string): boolean {
    return false;
  }

  initPhoneDailyCount(phoneId: string, sentToday: number): void {
    const state = this.getOrCreatePhoneState(phoneId);
    state.dailySentCount = sentToday;
  }

  recordSent(phoneId: string): void {
    const state = this.getOrCreatePhoneState(phoneId);
    state.dailySentCount++;
  }

  getEffectiveRate(baseRate: number): number {
    const strategy = this.getBaseTypeStrategy();
    return Math.max(1, Math.round(baseRate * strategy.rateMultiplier));
  }

  async applyTypingSimulation(): Promise<number> {
    const typingMs = secureRandomBetween(300, 1500);
    await new Promise(resolve => setTimeout(resolve, typingMs));
    return typingMs;
  }

  async applyReadingSimulation(): Promise<number> {
    const readingMs = secureRandomBetween(200, 800);
    await new Promise(resolve => setTimeout(resolve, readingMs));
    return readingMs;
  }

  updateConfig(updates: Partial<HumanBehaviorConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getConfig(): HumanBehaviorConfig {
    return { ...this.config };
  }

  pruneInactivePhones(activePhoneIds: Set<string>): void {
    const toRemove: string[] = [];
    this.phoneStates.forEach((_, key) => {
      if (!activePhoneIds.has(key)) {
        toRemove.push(key);
      }
    });
    for (const key of toRemove) {
      this.phoneStates.delete(key);
    }
    this.templateQualityScores.forEach((_, key) => {
      if (this.templateQualityScores.size > 1000) {
        this.templateQualityScores.delete(key);
      }
    });
  }

  resetPhoneState(phoneId: string): void {
    this.phoneStates.delete(phoneId);
  }

  resetAll(): void {
    this.phoneStates.clear();
    this.templateQualityScores.clear();
  }

  getPhoneStats(phoneId: string): { messageCount: number; dailySent: number; offset: number } | null {
    const state = this.phoneStates.get(phoneId);
    if (!state) return null;
    return {
      messageCount: state.messageCount,
      dailySent: state.dailySentCount,
      offset: state.offset,
    };
  }
}

export class TemplatePacingBackoff {
  private backoffMap: Map<string, BackoffEntry> = new Map();
  private initialBackoffMs: number = 60000;
  private maxBackoffMs: number = 600000;
  private rateReduction: number = 0.3;
  private testIntervalMs: number = 30000;

  private makeKey(phoneId: string, templateName: string): string {
    return `${phoneId}::${templateName}`;
  }

  recordPacingError(phoneId: string, templateName: string): void {
    const key = this.makeKey(phoneId, templateName);
    const existing = this.backoffMap.get(key);

    if (existing) {
      existing.errorCount++;
      existing.currentBackoffMs = Math.min(
        existing.currentBackoffMs * 2,
        this.maxBackoffMs
      );
      existing.lastErrorAt = Date.now();
      existing.blocked = true;
    } else {
      this.backoffMap.set(key, {
        errorCount: 1,
        currentBackoffMs: this.initialBackoffMs,
        lastErrorAt: Date.now(),
        lastTestAt: 0,
        blocked: true,
      });
    }
  }

  getBackoffMs(phoneId: string, templateName: string): number {
    const key = this.makeKey(phoneId, templateName);
    const entry = this.backoffMap.get(key);
    if (!entry || !entry.blocked) return 0;

    const elapsed = Date.now() - entry.lastErrorAt;
    const remaining = entry.currentBackoffMs - elapsed;
    return Math.max(0, remaining);
  }

  isBlocked(phoneId: string, templateName: string): boolean {
    const key = this.makeKey(phoneId, templateName);
    const entry = this.backoffMap.get(key);
    if (!entry || !entry.blocked) return false;
    return true;
  }

  shouldTestRelease(phoneId: string, templateName: string): boolean {
    const key = this.makeKey(phoneId, templateName);
    const entry = this.backoffMap.get(key);
    if (!entry || !entry.blocked) return false;

    const elapsed = Date.now() - entry.lastErrorAt;
    if (elapsed < entry.currentBackoffMs) return false;

    const timeSinceLastTest = Date.now() - entry.lastTestAt;
    if (timeSinceLastTest < this.testIntervalMs) return false;

    entry.lastTestAt = Date.now();
    return true;
  }

  recordTestSuccess(phoneId: string, templateName: string): void {
    const key = this.makeKey(phoneId, templateName);
    const entry = this.backoffMap.get(key);
    if (!entry) return;

    entry.currentBackoffMs = Math.max(
      this.initialBackoffMs,
      Math.floor(entry.currentBackoffMs * 0.5)
    );

    if (entry.currentBackoffMs <= this.initialBackoffMs) {
      entry.blocked = false;
      entry.errorCount = 0;
    }
  }

  recordTestFailure(phoneId: string, templateName: string): void {
    this.recordPacingError(phoneId, templateName);
  }

  getRateReduction(): number {
    return this.rateReduction;
  }

  pruneStale(maxAgeMs: number = 3600000): void {
    const cutoff = Date.now() - maxAgeMs;
    const stale: string[] = [];
    this.backoffMap.forEach((entry, key) => {
      if (entry.lastErrorAt < cutoff && !entry.blocked) {
        stale.push(key);
      }
    });
    for (const key of stale) {
      this.backoffMap.delete(key);
    }
  }

  getStats(): { totalEntries: number; blockedEntries: number } {
    let blocked = 0;
    const entries = Array.from(this.backoffMap.values());
    for (const entry of entries) {
      if (entry.blocked) blocked++;
    }
    return {
      totalEntries: this.backoffMap.size,
      blockedEntries: blocked,
    };
  }

  reset(): void {
    this.backoffMap.clear();
  }
}
