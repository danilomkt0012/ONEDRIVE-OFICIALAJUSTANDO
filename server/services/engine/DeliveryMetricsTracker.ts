import { ResponseRateTracker } from './ResponseRateTracker';

export type DeliveryEventStatus = 'sent' | 'delivered' | 'read' | 'failed';

interface MetricEntry {
  timestamp: number;
  status: DeliveryEventStatus;
}

interface TemplateMetrics {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  entries: MetricEntry[];
}

interface PhoneMetrics {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  entries: MetricEntry[];
}

export interface DeliverySnapshot {
  templateName: string;
  phoneNumberId: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  deliveryRate: number;
  readRate: number;
  failRate: number;
}

export interface WindowedDeliveryRate {
  windowMs: number;
  sent: number;
  delivered: number;
  deliveryRate: number;
  gapRate: number;
}

export interface QualityDashboardData {
  templates: Array<{
    name: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
    readRate: number;
    responseRate: number;
    failRate: number;
  }>;
  phones: Array<{
    phoneNumberId: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
    readRate: number;
    responseRate: number;
    failRate: number;
  }>;
  overall: {
    totalSent: number;
    totalDelivered: number;
    totalRead: number;
    totalFailed: number;
    overallDeliveryRate: number;
    overallReadRate: number;
    overallResponseRate: number;
    overallFailRate: number;
  };
  windowedRates: WindowedDeliveryRate & { readRate: number; responseRate: number };
  autoPaused: boolean;
  autoPauseReason: string | null;
  pacing: {
    status: 'healthy' | 'warning' | 'critical';
    activeEngines: number;
    reduceThreshold: number;
    pauseThreshold: number;
  };
}

const LATENCY_WINDOW_SIZE = 20;
const LATENCY_THRESHOLD_REDUCE_MS = 30000;
const LATENCY_THRESHOLD_WARNING_MS = 60000;
const LATENCY_THRESHOLD_PAUSE_MS = 120000;

export interface MessageMeta {
  templateName: string;
  campaignId?: string;
  phoneNumberId?: string;
}

export class DeliveryMetricsTracker {
  private templateMetrics: Map<string, TemplateMetrics> = new Map();
  private phoneMetrics: Map<string, PhoneMetrics> = new Map();
  private messageIdToTemplate: Map<string, string> = new Map();
  private messageIdToMeta: Map<string, MessageMeta> = new Map();
  private messageIdExpiry: Array<{ msgId: string; timestamp: number }> = [];
  private windowMs: number = 300000;
  private autoPaused: boolean = false;
  private autoPauseReason: string | null = null;
  private onAutoPauseCallbacks: Array<(reason: string) => void> = [];
  private onAutoReduceCallbacks: Array<(templateName: string, currentRate: number) => void> = [];
  private deliveryRateAutoPauseThreshold: number;
  private deliveryRateReduceThreshold: number;

  private messageIdToSentAt: Map<string, { sentAt: number; phoneNumberId: string; campaignId?: string; wabaId?: string; templateName?: string }> = new Map();
  private messageIdSentAtExpiry: Array<{ msgId: string; timestamp: number }> = [];
  private latencySamples: Map<string, number[]> = new Map();
  private campaignLatencySamples: Map<string, number[]> = new Map();
  private wabaLatencySamples: Map<string, number[]> = new Map();

  private phoneBlockCounts: Map<string, number> = new Map();
  private phoneBlockWindowEntries: Map<string, Array<number>> = new Map();

  private windowedReadTimestamps: number[] = [];
  private static readonly WINDOWED_READ_MAX = 5000;

  private onLatencyReduceCallbacks: Array<(phoneNumberId: string, latencyMs: number) => void> = [];
  private onLatencyWarningCallbacks: Array<(phoneNumberId: string, latencyMs: number) => void> = [];
  private onLatencyAutoPauseCallbacks: Array<(phoneNumberId: string, latencyMs: number) => void> = [];

  constructor(config?: {
    windowMs?: number;
    deliveryRateAutoPauseThreshold?: number;
    deliveryRateReduceThreshold?: number;
  }) {
    this.windowMs = config?.windowMs ?? 300000;
    this.deliveryRateAutoPauseThreshold = config?.deliveryRateAutoPauseThreshold ?? 0.5;
    this.deliveryRateReduceThreshold = config?.deliveryRateReduceThreshold ?? 0.6;
  }

  private getOrCreateTemplateMetrics(templateName: string): TemplateMetrics {
    let metrics = this.templateMetrics.get(templateName);
    if (!metrics) {
      metrics = { sent: 0, delivered: 0, read: 0, failed: 0, entries: [] };
      this.templateMetrics.set(templateName, metrics);
    }
    return metrics;
  }

  private getOrCreatePhoneMetrics(phoneNumberId: string): PhoneMetrics {
    let metrics = this.phoneMetrics.get(phoneNumberId);
    if (!metrics) {
      metrics = { sent: 0, delivered: 0, read: 0, failed: 0, entries: [] };
      this.phoneMetrics.set(phoneNumberId, metrics);
    }
    return metrics;
  }

  private static readonly MAX_ENTRIES_PER_METRIC = 2000;

  private maybeInlinePrune(entries: MetricEntry[]): void {
    if (entries.length <= DeliveryMetricsTracker.MAX_ENTRIES_PER_METRIC) return;
    const cutoff = Date.now() - this.windowMs;
    const kept = entries.filter(e => e.timestamp >= cutoff);
    if (kept.length > DeliveryMetricsTracker.MAX_ENTRIES_PER_METRIC) {
      kept.splice(0, kept.length - DeliveryMetricsTracker.MAX_ENTRIES_PER_METRIC);
    }
    entries.length = 0;
    for (const e of kept) entries.push(e);
  }

  recordSent(templateName: string, phoneNumberId: string, messageId: string, campaignId?: string, wabaId?: string): void {
    const now = Date.now();
    const tpl = this.getOrCreateTemplateMetrics(templateName);
    tpl.sent++;
    tpl.entries.push({ timestamp: now, status: 'sent' });
    this.maybeInlinePrune(tpl.entries);

    const phone = this.getOrCreatePhoneMetrics(phoneNumberId);
    phone.sent++;
    phone.entries.push({ timestamp: now, status: 'sent' });
    this.maybeInlinePrune(phone.entries);

    if (templateName) {
      this.messageIdToTemplate.set(messageId, templateName);
      this.messageIdToMeta.set(messageId, {
        templateName,
        campaignId,
        phoneNumberId,
      });
      this.messageIdExpiry.push({ msgId: messageId, timestamp: now });
      this.pruneMessageIdMap();
    }

    this.messageIdToSentAt.set(messageId, { sentAt: now, phoneNumberId, campaignId, wabaId, templateName });
    this.messageIdSentAtExpiry.push({ msgId: messageId, timestamp: now });
    this.pruneMessageIdSentAtMap();
    console.log(`[SEND] messageId=${messageId} phoneNumberId=${phoneNumberId} template=${templateName}${campaignId ? ` campaignId=${campaignId}` : ''}`);
  }

  recordBlockEvent(phoneNumberId: string): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let entries = this.phoneBlockWindowEntries.get(phoneNumberId);
    if (!entries) {
      entries = [];
      this.phoneBlockWindowEntries.set(phoneNumberId, entries);
    }
    entries.push(now);
    while (entries.length > 0 && entries[0] < cutoff) entries.shift();

    const total = this.phoneBlockCounts.get(phoneNumberId) || 0;
    this.phoneBlockCounts.set(phoneNumberId, total + 1);

    console.log(`[METRIC] block_event phoneNumberId=${phoneNumberId} windowedBlocks=${entries.length}`);
  }

  getWindowedBlockRate(phoneNumberId: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entries = this.phoneBlockWindowEntries.get(phoneNumberId);
    if (!entries || entries.length === 0) return 0;
    const windowedBlocks = entries.filter(t => t >= cutoff).length;
    const phone = this.phoneMetrics.get(phoneNumberId);
    const windowedSent = phone ? phone.entries.filter(e => e.status === 'sent' && e.timestamp >= cutoff).length : 0;
    if (windowedSent === 0) return 0;
    return windowedBlocks / windowedSent;
  }

  private pruneMessageIdSentAtMap(): void {
    const cutoff = Date.now() - this.windowMs * 3;
    while (this.messageIdSentAtExpiry.length > 0 && this.messageIdSentAtExpiry[0].timestamp < cutoff) {
      const entry = this.messageIdSentAtExpiry.shift()!;
      this.messageIdToSentAt.delete(entry.msgId);
    }
  }

  private recordLatency(messageId: string, latencyMs: number): void {
    const meta = this.messageIdToSentAt.get(messageId);
    const phoneNumberId = meta?.phoneNumberId || 'unknown';

    let samples = this.latencySamples.get(phoneNumberId);
    if (!samples) {
      samples = [];
      this.latencySamples.set(phoneNumberId, samples);
    }
    samples.push(latencyMs);
    if (samples.length > LATENCY_WINDOW_SIZE) {
      samples.shift();
    }

    if (meta?.campaignId) {
      let cSamples = this.campaignLatencySamples.get(meta.campaignId);
      if (!cSamples) {
        cSamples = [];
        this.campaignLatencySamples.set(meta.campaignId, cSamples);
      }
      cSamples.push(latencyMs);
      if (cSamples.length > LATENCY_WINDOW_SIZE * 4) cSamples.shift();
    }

    if (meta?.wabaId) {
      let wSamples = this.wabaLatencySamples.get(meta.wabaId);
      if (!wSamples) {
        wSamples = [];
        this.wabaLatencySamples.set(meta.wabaId, wSamples);
      }
      wSamples.push(latencyMs);
      if (wSamples.length > LATENCY_WINDOW_SIZE * 4) wSamples.shift();
    }

    console.log(`[METRIC] latency messageId=${messageId} phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}${meta?.campaignId ? ` campaignId=${meta.campaignId}` : ''}${meta?.wabaId ? ` wabaId=${meta.wabaId}` : ''}`);

    if (latencyMs >= LATENCY_THRESHOLD_PAUSE_MS) {
      console.log(`[METRIC] latency CRITICAL >120s phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}`);
      this.onLatencyAutoPauseCallbacks.forEach(cb => cb(phoneNumberId, latencyMs));
    } else if (latencyMs > LATENCY_THRESHOLD_WARNING_MS) {
      console.log(`[METRIC] latency WARNING >60s phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}`);
      this.onLatencyWarningCallbacks.forEach(cb => cb(phoneNumberId, latencyMs));
    } else if (latencyMs > LATENCY_THRESHOLD_REDUCE_MS) {
      console.log(`[METRIC] latency REDUCE >30s phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}`);
      this.onLatencyReduceCallbacks.forEach(cb => cb(phoneNumberId, latencyMs));
    }
  }

  getLatencySamples(phoneNumberId: string): number[] {
    return [...(this.latencySamples.get(phoneNumberId) || [])];
  }

  getAverageLatency(phoneNumberId: string): number {
    const samples = this.latencySamples.get(phoneNumberId);
    if (!samples || samples.length === 0) return 0;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  getCampaignLatencySamples(campaignId: string): number[] {
    return [...(this.campaignLatencySamples.get(campaignId) || [])];
  }

  getAverageCampaignLatency(campaignId: string): number {
    const samples = this.campaignLatencySamples.get(campaignId);
    if (!samples || samples.length === 0) return 0;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  getWabaLatencySamples(wabaId: string): number[] {
    return [...(this.wabaLatencySamples.get(wabaId) || [])];
  }

  getAverageWabaLatency(wabaId: string): number {
    const samples = this.wabaLatencySamples.get(wabaId);
    if (!samples || samples.length === 0) return 0;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  onLatencyReduce(callback: (phoneNumberId: string, latencyMs: number) => void): void {
    this.onLatencyReduceCallbacks.push(callback);
  }

  onLatencyWarning(callback: (phoneNumberId: string, latencyMs: number) => void): void {
    this.onLatencyWarningCallbacks.push(callback);
  }

  onLatencyAutoPause(callback: (phoneNumberId: string, latencyMs: number) => void): void {
    this.onLatencyAutoPauseCallbacks.push(callback);
  }

  lookupTemplateByMessageId(messageId: string): string | undefined {
    return this.messageIdToTemplate.get(messageId);
  }

  lookupCampaignByMessageId(messageId: string): string | undefined {
    return this.messageIdToSentAt.get(messageId)?.campaignId;
  }

  lookupWabaByMessageId(messageId: string): string | undefined {
    return this.messageIdToSentAt.get(messageId)?.wabaId;
  }

  lookupMetaByMessageId(messageId: string): { campaignId?: string; wabaId?: string; phoneNumberId?: string; templateName?: string } | undefined {
    const meta = this.messageIdToSentAt.get(messageId);
    if (!meta) return undefined;
    return { campaignId: meta.campaignId, wabaId: meta.wabaId, phoneNumberId: meta.phoneNumberId, templateName: meta.templateName };
  }

  private pruneMessageIdMap(): void {
    const cutoff = Date.now() - this.windowMs * 3;
    while (this.messageIdExpiry.length > 0 && this.messageIdExpiry[0].timestamp < cutoff) {
      const entry = this.messageIdExpiry.shift()!;
      this.messageIdToTemplate.delete(entry.msgId);
      this.messageIdToMeta.delete(entry.msgId);
    }
  }

  recordWebhookStatus(
    status: DeliveryEventStatus,
    templateName?: string,
    phoneNumberId?: string,
    messageId?: string
  ): void {
    const now = Date.now();

    if (messageId && status === 'delivered') {
      const sentMeta = this.messageIdToSentAt.get(messageId);
      if (sentMeta) {
        const latencyMs = now - sentMeta.sentAt;
        this.recordLatency(messageId, latencyMs);
      }
    }

    if (status === 'read') {
      this.windowedReadTimestamps.push(now);
      if (this.windowedReadTimestamps.length > DeliveryMetricsTracker.WINDOWED_READ_MAX) {
        this.windowedReadTimestamps.splice(0, this.windowedReadTimestamps.length - DeliveryMetricsTracker.WINDOWED_READ_MAX);
      }
    }

    if (templateName) {
      const tpl = this.getOrCreateTemplateMetrics(templateName);
      if (status === 'delivered') tpl.delivered++;
      else if (status === 'read') tpl.read++;
      else if (status === 'failed') tpl.failed++;
      tpl.entries.push({ timestamp: now, status });
      this.maybeInlinePrune(tpl.entries);
    }

    if (phoneNumberId) {
      const phone = this.getOrCreatePhoneMetrics(phoneNumberId);
      if (status === 'delivered') phone.delivered++;
      else if (status === 'read') phone.read++;
      else if (status === 'failed') phone.failed++;
      phone.entries.push({ timestamp: now, status });
      this.maybeInlinePrune(phone.entries);
    }

    console.log(`[WEBHOOK] status=${status} messageId=${messageId || 'n/a'} phoneNumberId=${phoneNumberId || 'n/a'} template=${templateName || 'n/a'}`);
    this.checkProactiveDetection();
  }

  private checkProactiveDetection(): void {
    const windowed = this.getWindowedDeliveryRate();

    if (windowed.sent >= 20) {
      if (windowed.deliveryRate < this.deliveryRateAutoPauseThreshold) {
        if (!this.autoPaused) {
          this.autoPaused = true;
          this.autoPauseReason = `Taxa de entrega ${(windowed.deliveryRate * 100).toFixed(1)}% < ${(this.deliveryRateAutoPauseThreshold * 100).toFixed(0)}% (janela ${this.windowMs / 1000}s)`;
          console.log(`\n🚨 [DeliveryMetrics] AUTO-PAUSE: ${this.autoPauseReason}`);
          this.onAutoPauseCallbacks.forEach(cb => cb(this.autoPauseReason!));
        }
      }

      if (windowed.deliveryRate < this.deliveryRateReduceThreshold && !this.autoPaused) {
        const entries = Array.from(this.templateMetrics.entries());
        for (let idx = 0; idx < entries.length; idx++) {
          const tplName = entries[idx][0];
          const tpl = entries[idx][1];
          const tplWindowed = this.getWindowedEntriesForMetric(tpl.entries);
          const tplSent = tplWindowed.filter((e: MetricEntry) => e.status === 'sent').length;
          const tplDelivered = tplWindowed.filter((e: MetricEntry) => e.status === 'delivered' || e.status === 'read').length;
          if (tplSent >= 10) {
            const tplRate = tplDelivered / tplSent;
            if (tplRate < this.deliveryRateReduceThreshold) {
              console.log(`\n⚠️ [DeliveryMetrics] Template ${tplName} delivery rate ${(tplRate * 100).toFixed(1)}% — reducing volume`);
              this.onAutoReduceCallbacks.forEach(cb => cb(tplName, tplRate));
            }
          }
        }
      }
    }
  }

  private getWindowedEntriesForMetric(entries: MetricEntry[]): MetricEntry[] {
    const cutoff = Date.now() - this.windowMs;
    return entries.filter(e => e.timestamp >= cutoff);
  }

  getWindowedDeliveryRate(): WindowedDeliveryRate {
    const cutoff = Date.now() - this.windowMs;
    let sent = 0;
    let delivered = 0;

    const tplValues = Array.from(this.templateMetrics.values());
    for (let i = 0; i < tplValues.length; i++) {
      const tpl = tplValues[i];
      const windowed = tpl.entries.filter((e: MetricEntry) => e.timestamp >= cutoff);
      sent += windowed.filter((e: MetricEntry) => e.status === 'sent').length;
      delivered += windowed.filter((e: MetricEntry) => e.status === 'delivered' || e.status === 'read').length;
    }

    const deliveryRate = sent > 0 ? delivered / sent : 1.0;
    const gapRate = 1.0 - deliveryRate;

    return {
      windowMs: this.windowMs,
      sent,
      delivered,
      deliveryRate,
      gapRate,
    };
  }

  getWindowedReadCount(): number {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.windowedReadTimestamps.length && this.windowedReadTimestamps[i] < cutoff) i++;
    if (i > 0) this.windowedReadTimestamps.splice(0, i);
    return this.windowedReadTimestamps.length;
  }

  getTemplateSnapshot(templateName: string): DeliverySnapshot | null {
    const tpl = this.templateMetrics.get(templateName);
    if (!tpl) return null;

    return {
      templateName,
      phoneNumberId: '',
      sent: tpl.sent,
      delivered: tpl.delivered,
      read: tpl.read,
      failed: tpl.failed,
      deliveryRate: tpl.sent > 0 ? tpl.delivered / tpl.sent : 0,
      readRate: tpl.sent > 0 ? tpl.read / tpl.sent : 0,
      failRate: tpl.sent > 0 ? tpl.failed / tpl.sent : 0,
    };
  }

  getPhoneSnapshot(phoneNumberId: string): DeliverySnapshot | null {
    const phone = this.phoneMetrics.get(phoneNumberId);
    if (!phone) return null;

    return {
      templateName: '',
      phoneNumberId,
      sent: phone.sent,
      delivered: phone.delivered,
      read: phone.read,
      failed: phone.failed,
      deliveryRate: phone.sent > 0 ? phone.delivered / phone.sent : 0,
      readRate: phone.sent > 0 ? phone.read / phone.sent : 0,
      failRate: phone.sent > 0 ? phone.failed / phone.sent : 0,
    };
  }

  getDashboardData(): QualityDashboardData {
    const merged = mergeIncrementalAggregates();
    const globalResponseRate = merged.globalDelivered > 0 ? merged.globalReplies / merged.globalDelivered : 0;

    let windowedReplies = 0;
    let windowedRRDelivered = 0;
    activeResponseRateTrackers.forEach((trackers) => {
      trackers.forEach((tracker) => {
        const counts = tracker.getWindowedCampaignCounts();
        windowedRRDelivered += counts.delivered;
        windowedReplies += counts.replies;
      });
    });
    const windowedResponseRate = windowedRRDelivered > 0 ? windowedReplies / windowedRRDelivered : 0;

    const templateResponseRates = new Map<string, number>();
    merged.templateDelivered.forEach((delivered, tplName) => {
      const replies = merged.templateReplies.get(tplName) ?? 0;
      templateResponseRates.set(tplName, delivered > 0 ? replies / delivered : 0);
    });

    const phoneResponseRates = new Map<string, number>();
    merged.phoneDelivered.forEach((delivered, phoneId) => {
      const replies = merged.phoneReplies.get(phoneId) ?? 0;
      phoneResponseRates.set(phoneId, delivered > 0 ? replies / delivered : 0);
    });

    const templates: QualityDashboardData['templates'] = [];
    const tplEntries = Array.from(this.templateMetrics.entries());
    for (let i = 0; i < tplEntries.length; i++) {
      const name = tplEntries[i][0];
      const tpl = tplEntries[i][1];
      templates.push({
        name,
        sent: tpl.sent,
        delivered: tpl.delivered,
        read: tpl.read,
        failed: tpl.failed,
        deliveryRate: tpl.sent > 0 ? tpl.delivered / tpl.sent : 0,
        readRate: tpl.sent > 0 ? tpl.read / tpl.sent : 0,
        responseRate: templateResponseRates.get(name) ?? 0,
        failRate: tpl.sent > 0 ? tpl.failed / tpl.sent : 0,
      });
    }

    const phones: QualityDashboardData['phones'] = [];
    const phoneEntries = Array.from(this.phoneMetrics.entries());
    for (let i = 0; i < phoneEntries.length; i++) {
      const phoneId = phoneEntries[i][0];
      const phone = phoneEntries[i][1];
      phones.push({
        phoneNumberId: phoneId,
        sent: phone.sent,
        delivered: phone.delivered,
        read: phone.read,
        failed: phone.failed,
        deliveryRate: phone.sent > 0 ? phone.delivered / phone.sent : 0,
        readRate: phone.sent > 0 ? phone.read / phone.sent : 0,
        responseRate: phoneResponseRates.get(phoneId) ?? 0,
        failRate: phone.sent > 0 ? phone.failed / phone.sent : 0,
      });
    }

    let totalSent = 0, totalDelivered = 0, totalRead = 0, totalFailed = 0;
    for (const tpl of templates) {
      totalSent += tpl.sent;
      totalDelivered += tpl.delivered;
      totalRead += tpl.read;
      totalFailed += tpl.failed;
    }

    const windowed = this.getWindowedDeliveryRate();
    const windowedReadCount = this.getWindowedReadCount();
    let pacingStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (this.autoPaused) {
      pacingStatus = 'critical';
    } else if (windowed.sent >= 10 && windowed.deliveryRate < this.deliveryRateReduceThreshold) {
      pacingStatus = 'warning';
    }

    return {
      templates,
      phones,
      overall: {
        totalSent,
        totalDelivered,
        totalRead,
        totalFailed,
        overallDeliveryRate: totalSent > 0 ? totalDelivered / totalSent : 0,
        overallReadRate: totalSent > 0 ? totalRead / totalSent : 0,
        overallResponseRate: globalResponseRate,
        overallFailRate: totalSent > 0 ? totalFailed / totalSent : 0,
      },
      windowedRates: {
        ...windowed,
        readRate: windowed.sent > 0 ? windowedReadCount / windowed.sent : 0,
        responseRate: windowedResponseRate,
      },
      autoPaused: this.autoPaused,
      autoPauseReason: this.autoPauseReason,
      pacing: {
        status: pacingStatus,
        activeEngines: activeEngineTrackers.size,
        reduceThreshold: this.deliveryRateReduceThreshold,
        pauseThreshold: this.deliveryRateAutoPauseThreshold,
      },
    };
  }

  isAutoPaused(): boolean {
    return this.autoPaused;
  }

  resetAutoPause(): void {
    this.autoPaused = false;
    this.autoPauseReason = null;
  }

  onAutoPause(callback: (reason: string) => void): void {
    this.onAutoPauseCallbacks.push(callback);
  }

  onAutoReduce(callback: (templateName: string, currentRate: number) => void): void {
    this.onAutoReduceCallbacks.push(callback);
  }

  pruneOldEntries(): void {
    const cutoff = Date.now() - this.windowMs * 2;
    const tplValues = Array.from(this.templateMetrics.values());
    for (let i = 0; i < tplValues.length; i++) {
      tplValues[i].entries = tplValues[i].entries.filter((e: MetricEntry) => e.timestamp >= cutoff);
    }
    const phoneValues = Array.from(this.phoneMetrics.values());
    for (let i = 0; i < phoneValues.length; i++) {
      phoneValues[i].entries = phoneValues[i].entries.filter((e: MetricEntry) => e.timestamp >= cutoff);
    }
  }

  reset(): void {
    this.templateMetrics.clear();
    this.phoneMetrics.clear();
    this.messageIdToTemplate.clear();
    this.messageIdToMeta.clear();
    this.messageIdExpiry = [];
    this.messageIdToSentAt.clear();
    this.messageIdSentAtExpiry = [];
    this.latencySamples.clear();
    this.campaignLatencySamples.clear();
    this.wabaLatencySamples.clear();
    this.phoneBlockCounts.clear();
    this.phoneBlockWindowEntries.clear();
    this.windowedReadTimestamps.length = 0;
    this.autoPaused = false;
    this.autoPauseReason = null;
  }

  destroy(): void {
    this.reset();
    this.onAutoPauseCallbacks.length = 0;
    this.onAutoReduceCallbacks.length = 0;
    this.onLatencyReduceCallbacks.length = 0;
    this.onLatencyWarningCallbacks.length = 0;
    this.onLatencyAutoPauseCallbacks.length = 0;
  }
}

export const deliveryMetricsTracker = new DeliveryMetricsTracker();

const activeEngineTrackers: Set<DeliveryMetricsTracker> = new Set();

const activeResponseRateTrackers: Map<string, Set<ResponseRateTracker>> = new Map();

const persistentCampaignTrackers: Map<string, ResponseRateTracker> = new Map();

const persistentCampaignReadCounts: Map<string, number> = new Map();

export function registerPersistentCampaignTracker(campaignId: string): ResponseRateTracker {
  let tracker = persistentCampaignTrackers.get(campaignId);
  if (!tracker) {
    tracker = new ResponseRateTracker();
    persistentCampaignTrackers.set(campaignId, tracker);
    console.log(`[PERSISTENT_TRACKER] Registered persistent tracker for campaignId=${campaignId}`);
  }
  return tracker;
}

export function unregisterPersistentCampaignTracker(campaignId: string): void {
  persistentCampaignTrackers.delete(campaignId);
  persistentCampaignReadCounts.delete(campaignId);
  console.log(`[PERSISTENT_TRACKER] Removed persistent tracker for campaignId=${campaignId}`);
}

export function getPersistentCampaignTracker(campaignId: string): ResponseRateTracker | undefined {
  return persistentCampaignTrackers.get(campaignId);
}

export function recordPersistentCampaignRead(campaignId: string): void {
  const current = persistentCampaignReadCounts.get(campaignId) ?? 0;
  persistentCampaignReadCounts.set(campaignId, current + 1);
}

export function getPersistentCampaignReadCount(campaignId: string): number {
  return persistentCampaignReadCounts.get(campaignId) ?? 0;
}

export function getPersistentCampaignResponseStats(campaignId: string): { responseRate: number; replyCount: number; deliveredCount: number; readCount: number } | null {
  const tracker = persistentCampaignTrackers.get(campaignId);
  if (!tracker) return null;
  const snapshot = tracker.getCampaignLevelSnapshot(campaignId, '_all') ?? tracker.getSnapshotsForCampaign(campaignId)[0];
  const cumulative = tracker.getCumulativeCampaignStats(campaignId, '_all');
  const readCount = persistentCampaignReadCounts.get(campaignId) ?? 0;
  if (!cumulative && !snapshot) return { responseRate: 0, replyCount: 0, deliveredCount: 0, readCount };
  const totalDelivered = cumulative?.totalDelivered ?? snapshot?.deliveredCount ?? 0;
  const totalReplies = cumulative?.totalReplies ?? snapshot?.replyCount ?? 0;
  const responseRate = totalDelivered > 0 ? totalReplies / totalDelivered : 0;
  return { responseRate, replyCount: totalReplies, deliveredCount: totalDelivered, readCount };
}

export function registerResponseRateTracker(campaignId: string, tracker: ResponseRateTracker): void {
  let trackers = activeResponseRateTrackers.get(campaignId);
  if (!trackers) {
    trackers = new Set();
    activeResponseRateTrackers.set(campaignId, trackers);
  }
  trackers.add(tracker);
}

export function unregisterResponseRateTracker(campaignId: string, tracker?: ResponseRateTracker): void {
  if (tracker) {
    const trackers = activeResponseRateTrackers.get(campaignId);
    if (trackers) {
      trackers.delete(tracker);
      if (trackers.size === 0) activeResponseRateTrackers.delete(campaignId);
    }
  } else {
    activeResponseRateTrackers.delete(campaignId);
  }
}

export function fanOutDeliveredForResponseRate(campaignId: string, templateName: string, phoneNumberId: string, contactPhone?: string, messageId?: string): void {
  const trackers = activeResponseRateTrackers.get(campaignId);
  if (trackers) {
    trackers.forEach(tracker => tracker.recordDelivered(campaignId, templateName || 'unattributed', phoneNumberId, contactPhone, messageId));
  }
  const persistentTracker = persistentCampaignTrackers.get(campaignId);
  if (persistentTracker) {
    persistentTracker.recordDelivered(campaignId, templateName || 'unattributed', '_all', contactPhone, messageId);
  }
}

export function fanOutReplyForResponseRate(campaignId: string, phoneNumberId: string, contactPhone?: string, messageId?: string): void {
  const trackers = activeResponseRateTrackers.get(campaignId);
  if (trackers) {
    trackers.forEach(tracker => tracker.recordReply(campaignId, phoneNumberId, contactPhone, messageId));
  }
  const persistentTracker = persistentCampaignTrackers.get(campaignId);
  if (persistentTracker) {
    persistentTracker.recordReply(campaignId, '_all', contactPhone, messageId);
  }
}

function mergeIncrementalAggregates(): {
  globalDelivered: number;
  globalReplies: number;
  templateDelivered: Map<string, number>;
  templateReplies: Map<string, number>;
  phoneDelivered: Map<string, number>;
  phoneReplies: Map<string, number>;
} {
  const merged = {
    globalDelivered: 0,
    globalReplies: 0,
    templateDelivered: new Map<string, number>(),
    templateReplies: new Map<string, number>(),
    phoneDelivered: new Map<string, number>(),
    phoneReplies: new Map<string, number>(),
  };
  activeResponseRateTrackers.forEach((trackers) => {
    trackers.forEach((tracker) => {
      const agg = tracker.getIncrementalAggregates();
      merged.globalDelivered += agg.globalDelivered;
      merged.globalReplies += agg.globalReplies;
      agg.templateDelivered.forEach((v, k) => merged.templateDelivered.set(k, (merged.templateDelivered.get(k) ?? 0) + v));
      agg.templateReplies.forEach((v, k) => merged.templateReplies.set(k, (merged.templateReplies.get(k) ?? 0) + v));
      agg.phoneDelivered.forEach((v, k) => merged.phoneDelivered.set(k, (merged.phoneDelivered.get(k) ?? 0) + v));
      agg.phoneReplies.forEach((v, k) => merged.phoneReplies.set(k, (merged.phoneReplies.get(k) ?? 0) + v));
    });
  });
  return merged;
}

export function registerActiveTracker(tracker: DeliveryMetricsTracker): void {
  activeEngineTrackers.add(tracker);
}

export function unregisterActiveTracker(tracker: DeliveryMetricsTracker): void {
  activeEngineTrackers.delete(tracker);
}

export function fanOutWebhookStatus(
  status: DeliveryEventStatus,
  templateName?: string,
  phoneNumberId?: string,
  messageId?: string
): void {
  deliveryMetricsTracker.recordWebhookStatus(status, templateName, phoneNumberId, messageId);
  for (const tracker of activeEngineTrackers) {
    tracker.recordWebhookStatus(status, templateName, phoneNumberId, messageId);
  }
}
