import type { DeliveryMetricsTracker } from './DeliveryMetricsTracker';
import type { ResponseRateTracker } from './ResponseRateTracker';

export type ReputationTier = 'HIGH_TRUST' | 'NORMAL' | 'REDUCE_LOAD' | 'DISABLE_TEMP';

export type PhoneLifecycleState = 'NEW' | 'ACTIVE' | 'DEGRADED';

export interface PhoneReputation {
  phoneNumberId: string;
  wabaId: string;
  deliveryRate: number;
  responseRate: number;
  blockRate: number;
  score: number;
  tier: ReputationTier;
  lifecycleState: PhoneLifecycleState;
  totalDelivered: number;
  totalReplies: number;
  disabledUntil: number | null;
  lastUpdated: number;
}

export type ReputationCallback = (phoneNumberId: string, reputation: PhoneReputation) => void;

const LIFECYCLE_ACTIVE_DELIVERED_THRESHOLD = 50;
const LIFECYCLE_ACTIVE_REPLIES_THRESHOLD = 10;
const NEW_PHONE_DEFAULT_SCORE = 0.5;
const NEW_PHONE_MIN_DELIVERED_FOR_DECISIONS = 30;

export class PhoneReputationScore {
  private reputations: Map<string, PhoneReputation> = new Map();
  private deliveryMetrics: DeliveryMetricsTracker;
  private responseRateTracker: ResponseRateTracker;
  private disableDurationMs: number;
  private recoveryTimers: Map<string, NodeJS.Timeout> = new Map();

  private onHighTrustCallbacks: ReputationCallback[] = [];
  private onReduceLoadCallbacks: ReputationCallback[] = [];
  private onDisableTempCallbacks: ReputationCallback[] = [];
  private onRecoverCallbacks: ReputationCallback[] = [];

  constructor(
    deliveryMetrics: DeliveryMetricsTracker,
    responseRateTracker: ResponseRateTracker,
    disableDurationMs: number = 1800000
  ) {
    this.deliveryMetrics = deliveryMetrics;
    this.responseRateTracker = responseRateTracker;
    this.disableDurationMs = disableDurationMs;
  }

  private reputationKey(phoneNumberId: string, wabaId: string): string {
    return `${wabaId}:${phoneNumberId}`;
  }

  private computeScore(deliveryRate: number, responseRate: number, blockRate: number): number {
    return (deliveryRate * 0.4) + (responseRate * 0.4) - (blockRate * 0.2);
  }

  private classifyTier(score: number): ReputationTier {
    if (score > 0.8) return 'HIGH_TRUST';
    if (score >= 0.5) return 'NORMAL';
    if (score >= 0.3) return 'REDUCE_LOAD';
    return 'DISABLE_TEMP';
  }

  private resolveLifecycleState(
    currentState: PhoneLifecycleState | undefined,
    totalDelivered: number,
    totalReplies: number,
    rawScore: number,
    phoneNumberId: string
  ): PhoneLifecycleState {
    if (!currentState || currentState === 'NEW') {
      if (totalDelivered >= LIFECYCLE_ACTIVE_DELIVERED_THRESHOLD || totalReplies >= LIFECYCLE_ACTIVE_REPLIES_THRESHOLD) {
        console.log(`[LIFECYCLE] phoneNumberId=${phoneNumberId} NEW → ACTIVE (delivered=${totalDelivered} replies=${totalReplies})`);
        return 'ACTIVE';
      }
      return 'NEW';
    }

    if (currentState === 'ACTIVE') {
      if (rawScore < 0.3 && totalDelivered >= NEW_PHONE_MIN_DELIVERED_FOR_DECISIONS) {
        console.log(`[LIFECYCLE] phoneNumberId=${phoneNumberId} ACTIVE → DEGRADED (score=${rawScore.toFixed(3)} delivered=${totalDelivered})`);
        return 'DEGRADED';
      }
      return 'ACTIVE';
    }

    if (currentState === 'DEGRADED') {
      if (rawScore >= 0.5) {
        console.log(`[LIFECYCLE] phoneNumberId=${phoneNumberId} DEGRADED → ACTIVE (score=${rawScore.toFixed(3)} — recovered)`);
        return 'ACTIVE';
      }
      return 'DEGRADED';
    }

    return currentState;
  }

  isPhoneNewAndProtected(phoneNumberId: string, wabaId: string): boolean {
    const key = this.reputationKey(phoneNumberId, wabaId);
    const rep = this.reputations.get(key);
    if (!rep) return true;
    if (rep.lifecycleState !== 'NEW') return false;
    return rep.totalDelivered < NEW_PHONE_MIN_DELIVERED_FOR_DECISIONS;
  }

  getLifecycleState(phoneNumberId: string, wabaId: string): PhoneLifecycleState {
    const rep = this.getReputation(phoneNumberId, wabaId);
    return rep?.lifecycleState || 'NEW';
  }

  updateReputation(
    phoneNumberId: string,
    wabaId: string,
    deliveryRate: number,
    responseRate: number,
    blockRate: number,
    totalDelivered: number = 0,
    totalReplies: number = 0
  ): PhoneReputation {
    const key = this.reputationKey(phoneNumberId, wabaId);
    const existing = this.reputations.get(key);

    if (existing?.disabledUntil && Date.now() < existing.disabledUntil) {
      console.log(`[REPUTATION] phoneNumberId=${phoneNumberId} still disabled until ${new Date(existing.disabledUntil).toISOString()}`);
      return existing;
    }

    if (existing?.disabledUntil && Date.now() >= existing.disabledUntil) {
      console.log(`[REPUTATION] phoneNumberId=${phoneNumberId} disable period ended — re-evaluating`);
    }

    const rawScore = this.computeScore(deliveryRate, responseRate, blockRate);
    const currentLifecycle = existing?.lifecycleState;

    const lifecycleState = this.resolveLifecycleState(
      currentLifecycle,
      totalDelivered,
      totalReplies,
      rawScore,
      phoneNumberId
    );

    let effectiveScore: number;
    let effectiveTier: ReputationTier;

    if (lifecycleState === 'NEW') {
      effectiveScore = Math.max(rawScore, NEW_PHONE_DEFAULT_SCORE);
      effectiveTier = this.classifyTier(effectiveScore);
      if (effectiveTier === 'REDUCE_LOAD' || effectiveTier === 'DISABLE_TEMP') {
        effectiveTier = 'NORMAL';
        effectiveScore = NEW_PHONE_DEFAULT_SCORE;
      }
    } else {
      effectiveScore = rawScore;
      effectiveTier = this.classifyTier(effectiveScore);
    }

    const prevTier = existing?.tier;

    const reputation: PhoneReputation = {
      phoneNumberId,
      wabaId,
      deliveryRate,
      responseRate,
      blockRate,
      score: effectiveScore,
      tier: effectiveTier,
      lifecycleState,
      totalDelivered,
      totalReplies,
      disabledUntil: effectiveTier === 'DISABLE_TEMP' ? Date.now() + this.disableDurationMs : null,
      lastUpdated: Date.now(),
    };

    this.reputations.set(key, reputation);

    console.log(`[REPUTATION] phoneNumberId=${phoneNumberId} wabaId=${wabaId} score=${effectiveScore.toFixed(3)} tier=${effectiveTier} lifecycle=${lifecycleState} deliveryRate=${(deliveryRate * 100).toFixed(1)}% responseRate=${(responseRate * 100).toFixed(1)}% blockRate=${(blockRate * 100).toFixed(1)}% totalDelivered=${totalDelivered} totalReplies=${totalReplies}`);

    if (effectiveTier !== prevTier) {
      if (effectiveTier === 'HIGH_TRUST') {
        this.onHighTrustCallbacks.forEach(cb => cb(phoneNumberId, reputation));
      } else if (effectiveTier === 'REDUCE_LOAD') {
        this.onReduceLoadCallbacks.forEach(cb => cb(phoneNumberId, reputation));
      } else if (effectiveTier === 'DISABLE_TEMP') {
        this.onDisableTempCallbacks.forEach(cb => cb(phoneNumberId, reputation));
        this.scheduleRecovery(phoneNumberId, wabaId);
      } else if (effectiveTier === 'NORMAL' && prevTier && prevTier !== 'NORMAL') {
        this.onRecoverCallbacks.forEach(cb => cb(phoneNumberId, reputation));
      }
    }

    return reputation;
  }

  refreshFromTrackers(phoneNumberId: string, wabaId: string, campaignId?: string, responseRateTrackerOverride?: ResponseRateTracker): PhoneReputation | null {
    const phoneSnapshot = this.deliveryMetrics.getPhoneSnapshot(phoneNumberId);
    if (!phoneSnapshot) return null;

    const deliveryRate = phoneSnapshot.deliveryRate;
    const blockRate = this.deliveryMetrics.getWindowedBlockRate(phoneNumberId);
    const cumulativeDelivered = phoneSnapshot.delivered;

    let responseRate = 0;
    let cumulativeReplies = 0;
    if (campaignId) {
      const tracker = responseRateTrackerOverride || this.responseRateTracker;
      const campaignSnapshot = tracker.getCampaignLevelSnapshot(campaignId, phoneNumberId);
      if (campaignSnapshot && campaignSnapshot.deliveredCount > 0) {
        responseRate = campaignSnapshot.responseRate;
      }
      const cumulativeStats = tracker.getCumulativeCampaignStats(campaignId, phoneNumberId);
      if (cumulativeStats) {
        cumulativeReplies = cumulativeStats.totalReplies;
      }
    }

    return this.updateReputation(phoneNumberId, wabaId, deliveryRate, responseRate, blockRate, cumulativeDelivered, cumulativeReplies);
  }

  getReputation(phoneNumberId: string, wabaId: string): PhoneReputation | null {
    const key = this.reputationKey(phoneNumberId, wabaId);
    return this.reputations.get(key) || null;
  }

  isDisabled(phoneNumberId: string, wabaId: string): boolean {
    const rep = this.getReputation(phoneNumberId, wabaId);
    if (!rep) return false;
    if (rep.disabledUntil && Date.now() < rep.disabledUntil) return true;
    return false;
  }

  getAllReputations(): PhoneReputation[] {
    return Array.from(this.reputations.values());
  }

  onHighTrust(callback: ReputationCallback): void {
    this.onHighTrustCallbacks.push(callback);
  }

  onReduceLoad(callback: ReputationCallback): void {
    this.onReduceLoadCallbacks.push(callback);
  }

  onDisableTemp(callback: ReputationCallback): void {
    this.onDisableTempCallbacks.push(callback);
  }

  onRecover(callback: ReputationCallback): void {
    this.onRecoverCallbacks.push(callback);
  }

  private scheduleRecovery(phoneNumberId: string, wabaId: string): void {
    const key = this.reputationKey(phoneNumberId, wabaId);
    const existingTimer = this.recoveryTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    console.log(`[REPUTATION] Scheduling recovery for phoneNumberId=${phoneNumberId} in ${this.disableDurationMs / 1000}s`);
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(key);
      console.log(`[REPUTATION] Recovery timer fired for phoneNumberId=${phoneNumberId} — re-evaluating`);
      const rep = this.reputations.get(key);
      if (rep && rep.disabledUntil && Date.now() >= rep.disabledUntil) {
        const refreshed = this.refreshFromTrackers(phoneNumberId, wabaId);
        if (refreshed && refreshed.tier !== 'DISABLE_TEMP') {
          console.log(`[REPUTATION] phoneNumberId=${phoneNumberId} recovered to tier=${refreshed.tier} score=${refreshed.score.toFixed(3)}`);
          this.onRecoverCallbacks.forEach(cb => cb(phoneNumberId, refreshed));
        }
      }
    }, this.disableDurationMs + 1000);

    this.recoveryTimers.set(key, timer);
  }

  reset(): void {
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.recoveryTimers.clear();
    this.reputations.clear();
  }

  destroy(): void {
    this.reset();
    this.onHighTrustCallbacks.length = 0;
    this.onReduceLoadCallbacks.length = 0;
    this.onDisableTempCallbacks.length = 0;
    this.onRecoverCallbacks.length = 0;
  }
}
