import type { DeliveryMetricsTracker } from './DeliveryMetricsTracker';
import type { ResponseRateTracker, ResponseRateSnapshot } from './ResponseRateTracker';
import type { PhoneReputationScore, PhoneReputation } from './PhoneReputationScore';
import type { RiskEngine, RiskResult } from '../risk/RiskEngine';
import type { TokenBucket } from './TokenBucket';

export type DecisionAction = 'continue' | 'slow_down' | 'pause_campaign' | 'disable_number';

export interface DecisionEvent {
  timestamp: number;
  action: DecisionAction;
  reason: string;
  campaignId: string;
  phoneNumberId?: string;
  metadata?: Record<string, unknown>;
}

export interface DecisionEngineConfig {
  campaignId: string;
  wabaId: string;
  phoneNumberIds: string[];
  phoneWabaMap: Map<string, string>;
  minRefillRate: number;
}

export interface WabaMetrics {
  wabaId: string;
  phoneNumberIds: string[];
  totalSent: number;
  totalDelivered: number;
  totalFailed: number;
  deliveryRate: number;
}

export type OnDecisionCallback = (event: DecisionEvent) => void;
export type OnPauseCampaignCallback = (campaignId: string, reason: string) => void;
export type OnSlowDownCallback = (campaignId: string, phoneNumberId: string, factor: number) => void;
export type OnDisableNumberCallback = (campaignId: string, phoneNumberId: string, reason: string) => void;
export type OnRebalanceCallback = (campaignId: string, weights: Map<string, number>) => void;

const GRADUAL_FACTORS = [0.8, 0.7, 0.5];

export class CampaignDecisionEngine {
  private config: DecisionEngineConfig;
  private deliveryMetrics: DeliveryMetricsTracker;
  private responseRateTracker: ResponseRateTracker;
  private riskEngine: RiskEngine | null;
  private tokenBuckets: Map<string, TokenBucket>;
  private phoneReputationScores: Map<string, PhoneReputationScore> = new Map();
  private decisionLog: DecisionEvent[] = [];
  private maxDecisionLog = 100;
  private onDecisionCallbacks: OnDecisionCallback[] = [];
  private onPauseCampaignCallback?: OnPauseCampaignCallback;
  private onSlowDownCallback?: OnSlowDownCallback;
  private onDisableNumberCallback?: OnDisableNumberCallback;
  private onRebalanceCallback?: OnRebalanceCallback;
  private wabaMetrics: Map<string, WabaMetrics> = new Map();
  private coordinator: { setPhoneWeight: (phoneNumberId: string, weight: number) => void } | null = null;
  private phoneSlowdownCounts: Map<string, number> = new Map();

  constructor(
    config: DecisionEngineConfig,
    deliveryMetrics: DeliveryMetricsTracker,
    responseRateTracker: ResponseRateTracker,
    riskEngine: RiskEngine | null,
    tokenBuckets: Map<string, TokenBucket> = new Map()
  ) {
    this.config = config;
    this.deliveryMetrics = deliveryMetrics;
    this.responseRateTracker = responseRateTracker;
    this.riskEngine = riskEngine;
    this.tokenBuckets = tokenBuckets;

    this.initWabaMetrics();
    this.wireCallbacks();
  }

  private initWabaMetrics(): void {
    for (const phoneId of this.config.phoneNumberIds) {
      const wabaId = this.config.phoneWabaMap.get(phoneId) || this.config.wabaId;
      if (!this.wabaMetrics.has(wabaId)) {
        this.wabaMetrics.set(wabaId, {
          wabaId,
          phoneNumberIds: [],
          totalSent: 0,
          totalDelivered: 0,
          totalFailed: 0,
          deliveryRate: 1.0,
        });
      }
      this.wabaMetrics.get(wabaId)!.phoneNumberIds.push(phoneId);
    }
  }

  setCoordinator(coordinator: { setPhoneWeight: (phoneNumberId: string, weight: number) => void }): void {
    this.coordinator = coordinator;
  }

  private getWabaIdForPhone(phoneNumberId: string): string {
    return this.config.phoneWabaMap.get(phoneNumberId) || this.config.wabaId;
  }

  private isPhoneProtected(phoneNumberId: string): boolean {
    const wabaId = this.getWabaIdForPhone(phoneNumberId);
    for (const [, repScore] of this.phoneReputationScores) {
      if (repScore.isPhoneNewAndProtected(phoneNumberId, wabaId)) {
        return true;
      }
    }
    return false;
  }

  private isPhoneNew(phoneNumberId: string): boolean {
    const wabaId = this.getWabaIdForPhone(phoneNumberId);
    for (const [, repScore] of this.phoneReputationScores) {
      const lifecycle = repScore.getLifecycleState(phoneNumberId, wabaId);
      if (lifecycle === 'NEW') return true;
    }
    return false;
  }

  private getGradualFactor(phoneNumberId: string): number {
    const count = this.phoneSlowdownCounts.get(phoneNumberId) || 0;
    const index = Math.min(count, GRADUAL_FACTORS.length - 1);
    return GRADUAL_FACTORS[index];
  }

  private incrementSlowdownCount(phoneNumberId: string): void {
    const current = this.phoneSlowdownCounts.get(phoneNumberId) || 0;
    this.phoneSlowdownCounts.set(phoneNumberId, current + 1);
  }

  private resetSlowdownCount(phoneNumberId: string): void {
    this.phoneSlowdownCounts.delete(phoneNumberId);
  }

  private wireCallbacks(): void {
    this.deliveryMetrics.onAutoPause((reason) => {
      this.emit('pause_campaign', reason, undefined, { source: 'DeliveryMetrics' });
      this.refreshReputations();
    });

    this.deliveryMetrics.onAutoReduce((templateName, currentRate) => {
      this.refreshReputations();
      for (const phoneId of this.config.phoneNumberIds) {
        if (this.isPhoneProtected(phoneId)) {
          console.log(`[DECISION] SKIP delivery_rate_low for NEW protected phone=${phoneId} (delivered<30)`);
          continue;
        }
        const factor = this.getGradualFactor(phoneId);
        this.emit('slow_down', `delivery_rate_low template=${templateName} rate=${(currentRate * 100).toFixed(1)}%`, phoneId, { source: 'DeliveryMetrics', currentRate, factor });
        this.applySlowDown(phoneId, factor);
        this.incrementSlowdownCount(phoneId);
      }
    });

    this.deliveryMetrics.onLatencyReduce((phoneNumberId, latencyMs) => {
      this.refreshReputations();
      if (this.isPhoneProtected(phoneNumberId)) {
        console.log(`[DECISION] SKIP latency_reduce for NEW protected phone=${phoneNumberId} (delivered<30)`);
        return;
      }
      const factor = this.getGradualFactor(phoneNumberId);
      this.emit('slow_down', `latency_high latencyMs=${latencyMs}ms (>30s)`, phoneNumberId, { source: 'LatencyTracker', latencyMs, factor });
      this.applySlowDown(phoneNumberId, factor);
      this.incrementSlowdownCount(phoneNumberId);
    });

    this.deliveryMetrics.onLatencyWarning((phoneNumberId, latencyMs) => {
      this.refreshReputations();
      if (this.isPhoneProtected(phoneNumberId)) {
        console.log(`[DECISION] SKIP latency_warning for NEW protected phone=${phoneNumberId} (delivered<30)`);
        return;
      }
      const factor = this.isPhoneNew(phoneNumberId)
        ? Math.max(this.getGradualFactor(phoneNumberId), 0.7)
        : this.getGradualFactor(phoneNumberId);
      this.emit('slow_down', `latency_warning latencyMs=${latencyMs}ms (>60s)`, phoneNumberId, { source: 'LatencyTracker', latencyMs, factor });
      this.applySlowDown(phoneNumberId, factor);
      this.incrementSlowdownCount(phoneNumberId);
    });

    this.deliveryMetrics.onLatencyAutoPause((phoneNumberId, latencyMs) => {
      this.emit('pause_campaign', `latency_critical latencyMs=${latencyMs}ms (>=120s) phoneNumberId=${phoneNumberId}`, phoneNumberId, { source: 'LatencyTracker', latencyMs });
    });

    this.responseRateTracker.onReduceRate((snapshot) => {
      this.refreshReputations();
      this.handleLowResponseRate(snapshot, false);
    });

    this.responseRateTracker.onPauseCampaign((snapshot) => {
      this.refreshReputations();
      this.handleLowResponseRate(snapshot, true);
    });

    this.responseRateTracker.onRecoverRate((snapshot) => {
      if (snapshot.phoneNumberId) {
        this.resetSlowdownCount(snapshot.phoneNumberId);
      }
      this.emit('continue', `response_rate_recovered rate=${(snapshot.responseRate * 100).toFixed(1)}%`, snapshot.phoneNumberId, { source: 'ResponseRate' });
      this.refreshReputations();
    });
  }

  private handleLowResponseRate(snapshot: ResponseRateSnapshot, shouldPause: boolean): void {
    const phoneId = snapshot.phoneNumberId;
    const templateLabel = snapshot.templateName !== '_campaign' ? ` template=${snapshot.templateName}` : '';

    if (phoneId && this.isPhoneProtected(phoneId)) {
      console.log(`[DECISION] SKIP response_rate action for NEW protected phone=${phoneId} delivered<30 rate=${(snapshot.responseRate * 100).toFixed(1)}%`);
      return;
    }

    if (phoneId && this.isPhoneNew(phoneId)) {
      if (shouldPause) {
        const factor = this.getGradualFactor(phoneId);
        console.log(`[DECISION] DOWNGRADE pause→slow_down for NEW phone=${phoneId} (delivered 30-49) factor=${factor}`);
        this.emit(
          'slow_down',
          `response_rate_low rate=${(snapshot.responseRate * 100).toFixed(1)}% (<5%) campaignId=${snapshot.campaignId}${templateLabel} [NEW phone: pause downgraded to slow_down]`,
          phoneId,
          { source: 'ResponseRate', responseRate: snapshot.responseRate, templateName: snapshot.templateName, lifecycleOverride: true, factor }
        );
        this.applySlowDown(phoneId, factor);
        this.incrementSlowdownCount(phoneId);
        return;
      }
      const factor = this.getGradualFactor(phoneId);
      this.emit(
        'slow_down',
        `response_rate_low rate=${(snapshot.responseRate * 100).toFixed(1)}% (<10%) campaignId=${snapshot.campaignId}${templateLabel}`,
        phoneId,
        { source: 'ResponseRate', responseRate: snapshot.responseRate, templateName: snapshot.templateName, factor }
      );
      this.applySlowDown(phoneId, factor);
      this.incrementSlowdownCount(phoneId);
      return;
    }

    if (shouldPause) {
      this.emit(
        'pause_campaign',
        `response_rate_critical rate=${(snapshot.responseRate * 100).toFixed(1)}% (<5%) campaignId=${snapshot.campaignId}${templateLabel}`,
        phoneId,
        { source: 'ResponseRate', responseRate: snapshot.responseRate, templateName: snapshot.templateName }
      );
    } else {
      const factor = this.getGradualFactor(phoneId || '');
      this.emit(
        'slow_down',
        `response_rate_low rate=${(snapshot.responseRate * 100).toFixed(1)}% (<10%) campaignId=${snapshot.campaignId}${templateLabel}`,
        phoneId,
        { source: 'ResponseRate', responseRate: snapshot.responseRate, templateName: snapshot.templateName, factor }
      );
      if (phoneId) {
        this.applySlowDown(phoneId, factor);
        this.incrementSlowdownCount(phoneId);
      }
    }
  }

  private applySlowDown(phoneNumberId: string, factor: number): void {
    const bucket = this.tokenBuckets.get(phoneNumberId);
    if (bucket) {
      const stats = bucket.getStats();
      const newRate = Math.max(this.config.minRefillRate, stats.refillRate * factor);
      bucket.setRefillRate(newRate);
      console.log(`[DECISION] applySlowDown phoneNumberId=${phoneNumberId} factor=${factor} newRate=${newRate.toFixed(3)}`);
    }
    this.onSlowDownCallback?.(this.config.campaignId, phoneNumberId, factor);
    this.triggerRebalance(phoneNumberId, factor);
  }

  private triggerRebalance(disabledPhoneId: string, factor: number): void {
    const weights = new Map<string, number>();
    for (const phoneId of this.config.phoneNumberIds) {
      if (phoneId === disabledPhoneId) {
        weights.set(phoneId, Math.max(0.1, factor));
      } else {
        weights.set(phoneId, 1.0);
      }
    }
    console.log(`[DECISION] triggerRebalance campaignId=${this.config.campaignId} disabledPhone=${disabledPhoneId} factor=${factor}`);
    if (this.coordinator) {
      const entries = Array.from(weights.entries());
      for (const [phoneId, weight] of entries) {
        this.coordinator.setPhoneWeight(phoneId, weight);
      }
    }
    this.onRebalanceCallback?.(this.config.campaignId, weights);
  }

  private emit(action: DecisionAction, reason: string, phoneNumberId?: string, metadata?: Record<string, unknown>): void {
    const event: DecisionEvent = {
      timestamp: Date.now(),
      action,
      reason,
      campaignId: this.config.campaignId,
      phoneNumberId,
      metadata,
    };

    this.decisionLog.push(event);
    if (this.decisionLog.length > this.maxDecisionLog) {
      this.decisionLog.shift();
    }

    console.log(`[DECISION] action=${action} campaignId=${this.config.campaignId} reason="${reason}"${phoneNumberId ? ` phoneNumberId=${phoneNumberId}` : ''}`);

    for (const cb of this.onDecisionCallbacks) {
      cb(event);
    }

    if (action === 'pause_campaign') {
      this.onPauseCampaignCallback?.(this.config.campaignId, reason);
    } else if (action === 'disable_number' && phoneNumberId) {
      this.onDisableNumberCallback?.(this.config.campaignId, phoneNumberId, reason);
      this.triggerRebalance(phoneNumberId, 0);
    }
  }

  registerPhoneReputationScore(phoneId: string, reputationScore: PhoneReputationScore): void {
    this.phoneReputationScores.set(phoneId, reputationScore);

    reputationScore.onReduceLoad((_pid, rep) => {
      this.emit('slow_down', `reputation_reduce_load score=${rep.score.toFixed(3)}`, phoneId, { source: 'PhoneReputation', score: rep.score });
      const factor = this.getGradualFactor(phoneId);
      this.applySlowDown(phoneId, factor);
      this.incrementSlowdownCount(phoneId);
    });
    reputationScore.onDisableTemp((_pid, rep) => {
      this.emit('disable_number', `reputation_disable_temp score=${rep.score.toFixed(3)}`, phoneId, { source: 'PhoneReputation', score: rep.score });
    });
    reputationScore.onHighTrust((_pid, rep) => {
      this.resetSlowdownCount(phoneId);
      this.emit('continue', `reputation_high_trust score=${rep.score.toFixed(3)}`, phoneId, { source: 'PhoneReputation', score: rep.score });
    });
    reputationScore.onRecover((_pid, rep) => {
      this.resetSlowdownCount(phoneId);
      this.emit('continue', `reputation_recovered score=${rep.score.toFixed(3)}`, phoneId, { source: 'PhoneReputation', score: rep.score });
    });
  }

  subscribeToPhoneTrackers(
    deliveryMetrics: DeliveryMetricsTracker,
    responseRateTracker: ResponseRateTracker,
    reputationScore: PhoneReputationScore,
    phoneId: string
  ): void {
    this.registerPhoneReputationScore(phoneId, reputationScore);

    deliveryMetrics.onAutoPause((reason) => {
      this.emit('pause_campaign', reason, phoneId, { source: 'DeliveryMetrics' });
      this.refreshReputations();
    });
    deliveryMetrics.onAutoReduce((templateName, currentRate) => {
      this.refreshReputations();
      if (this.isPhoneProtected(phoneId)) {
        console.log(`[DECISION] SKIP delivery_rate_low for NEW protected phone=${phoneId} (delivered<30)`);
        return;
      }
      const factor = this.getGradualFactor(phoneId);
      this.emit('slow_down', `delivery_rate_low template=${templateName} rate=${(currentRate * 100).toFixed(1)}%`, phoneId, { source: 'DeliveryMetrics', currentRate, factor });
      this.applySlowDown(phoneId, factor);
      this.incrementSlowdownCount(phoneId);
    });
    deliveryMetrics.onLatencyReduce((_pid, latencyMs) => {
      this.refreshReputations();
      if (this.isPhoneProtected(phoneId)) {
        console.log(`[DECISION] SKIP latency_reduce for NEW protected phone=${phoneId} (delivered<30)`);
        return;
      }
      const factor = this.getGradualFactor(phoneId);
      this.emit('slow_down', `latency_high latencyMs=${latencyMs}ms (>30s)`, phoneId, { source: 'LatencyTracker', latencyMs, factor });
      this.applySlowDown(phoneId, factor);
      this.incrementSlowdownCount(phoneId);
    });
    deliveryMetrics.onLatencyWarning((_pid, latencyMs) => {
      this.refreshReputations();
      if (this.isPhoneProtected(phoneId)) {
        console.log(`[DECISION] SKIP latency_warning for NEW protected phone=${phoneId} (delivered<30)`);
        return;
      }
      const factor = this.isPhoneNew(phoneId)
        ? Math.max(this.getGradualFactor(phoneId), 0.7)
        : this.getGradualFactor(phoneId);
      this.emit('slow_down', `latency_warning latencyMs=${latencyMs}ms (>60s)`, phoneId, { source: 'LatencyTracker', latencyMs, factor });
      this.applySlowDown(phoneId, factor);
      this.incrementSlowdownCount(phoneId);
    });
    deliveryMetrics.onLatencyAutoPause((_pid, latencyMs) => {
      this.emit('pause_campaign', `latency_critical latencyMs=${latencyMs}ms (>=120s) phoneNumberId=${phoneId}`, phoneId, { source: 'LatencyTracker', latencyMs });
    });
    responseRateTracker.onReduceRate((snapshot) => {
      this.refreshReputations();
      this.handleLowResponseRate(snapshot, false);
    });
    responseRateTracker.onPauseCampaign((snapshot) => {
      this.refreshReputations();
      this.handleLowResponseRate(snapshot, true);
    });
    responseRateTracker.onRecoverRate((snapshot) => {
      if (snapshot.phoneNumberId) {
        this.resetSlowdownCount(snapshot.phoneNumberId);
      }
      this.emit('continue', `response_rate_recovered rate=${(snapshot.responseRate * 100).toFixed(1)}%`, snapshot.phoneNumberId, { source: 'ResponseRate' });
      this.refreshReputations();
    });
  }

  evaluateRiskResult(result: RiskResult, phoneNumberId: string): void {
    if (result.action === 'PAUSE') {
      this.emit('pause_campaign', `risk_engine PAUSE score=${result.score.toFixed(1)} ${result.details}`, phoneNumberId, { source: 'RiskEngine', score: result.score });
    } else if (result.action === 'COOLDOWN' || result.action === 'REDUCE_50') {
      this.emit('slow_down', `risk_engine ${result.action} score=${result.score.toFixed(1)} ${result.details}`, phoneNumberId, { source: 'RiskEngine', score: result.score });
    } else if (result.action === 'REDUCE_20') {
      this.emit('slow_down', `risk_engine REDUCE_20 score=${result.score.toFixed(1)} ${result.details}`, phoneNumberId, { source: 'RiskEngine', score: result.score });
    }

    this.updateWabaMetricsFromRisk(phoneNumberId, result);
  }

  private updateWabaMetricsFromRisk(phoneNumberId: string, _result: RiskResult): void {
    const wabaId = this.config.phoneWabaMap.get(phoneNumberId) || this.config.wabaId;
    const waba = this.wabaMetrics.get(wabaId);
    if (!waba) return;
    if (waba.totalSent > 0) {
      waba.deliveryRate = waba.totalDelivered / waba.totalSent;
    }
  }

  recordDeliveryForWaba(phoneNumberId: string, status: 'sent' | 'delivered' | 'failed'): void {
    const wabaId = this.config.phoneWabaMap.get(phoneNumberId) || this.config.wabaId;
    const waba = this.wabaMetrics.get(wabaId);
    if (!waba) return;

    if (status === 'sent') {
      waba.totalSent++;
    } else if (status === 'delivered') {
      waba.totalDelivered++;
    } else if (status === 'failed') {
      waba.totalFailed++;
    }

    if (waba.totalSent > 0) {
      waba.deliveryRate = waba.totalDelivered / waba.totalSent;
    }
  }

  refreshReputations(): void {
    for (const [phoneId, repScore] of this.phoneReputationScores) {
      const wabaId = this.config.phoneWabaMap.get(phoneId) || this.config.wabaId;
      repScore.refreshFromTrackers(phoneId, wabaId, this.config.campaignId, this.responseRateTracker);
    }
  }

  onDecision(callback: OnDecisionCallback): void {
    this.onDecisionCallbacks.push(callback);
  }

  onPauseCampaign(callback: OnPauseCampaignCallback): void {
    this.onPauseCampaignCallback = callback;
  }

  onSlowDown(callback: OnSlowDownCallback): void {
    this.onSlowDownCallback = callback;
  }

  onDisableNumber(callback: OnDisableNumberCallback): void {
    this.onDisableNumberCallback = callback;
  }

  onRebalance(callback: OnRebalanceCallback): void {
    this.onRebalanceCallback = callback;
  }

  getDecisionLog(): DecisionEvent[] {
    return [...this.decisionLog];
  }

  getConfig(): DecisionEngineConfig {
    return { ...this.config };
  }

  getWabaMetrics(wabaId: string): WabaMetrics | undefined {
    return this.wabaMetrics.get(wabaId);
  }

  getAllWabaMetrics(): WabaMetrics[] {
    return Array.from(this.wabaMetrics.values());
  }

  logValidation(): void {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[CampaignDecisionEngine] Architecture Validation`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   Single DecisionEngine for campaign: ${this.config.campaignId}`);
    console.log(`   Phones coordinated: ${this.config.phoneNumberIds.length}`);
    console.log(`   WABA isolation: ${this.wabaMetrics.size} WABA(s)`);
    Array.from(this.wabaMetrics.entries()).forEach(([wabaId, waba]) => {
      console.log(`      WABA ${wabaId}: phones=[${waba.phoneNumberIds.join(', ')}]`);
    });
    console.log(`   Coordinator integration: ${this.coordinator ? 'CONNECTED' : 'NOT SET'}`);
    console.log(`   Phone slowdown counts: ${this.phoneSlowdownCounts.size} tracked`);
    console.log(`${'='.repeat(60)}\n`);
  }

  destroy(): void {
    this.decisionLog.length = 0;
    this.onDecisionCallbacks.length = 0;
    this.onPauseCampaignCallback = undefined;
    this.onSlowDownCallback = undefined;
    this.onDisableNumberCallback = undefined;
    this.onRebalanceCallback = undefined;
    this.phoneReputationScores.clear();
    this.tokenBuckets.clear();
    this.wabaMetrics.clear();
    this.phoneSlowdownCounts.clear();
    this.coordinator = null;
  }
}
