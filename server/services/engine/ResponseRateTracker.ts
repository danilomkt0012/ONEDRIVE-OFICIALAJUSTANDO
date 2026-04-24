export interface ResponseRateSnapshot {
  campaignId: string;
  templateName: string;
  phoneNumberId: string;
  deliveredCount: number;
  replyCount: number;
  responseRate: number;
  windowMs: number;
}

export interface CumulativeCampaignStats {
  totalDelivered: number;
  totalReplies: number;
}

interface RateEntry {
  timestamp: number;
  type: 'delivered' | 'reply';
}

interface TrackerKey {
  campaignId: string;
  templateName: string;
  phoneNumberId: string;
}

interface TrackerBucket {
  key: TrackerKey;
  entries: RateEntry[];
  totalDelivered: number;
  totalReplies: number;
}

export type ResponseRateCallback = (snapshot: ResponseRateSnapshot) => void;

export class ResponseRateTracker {
  private buckets: Map<string, TrackerBucket> = new Map();
  private windowMs: number;
  private onReduceRateCallbacks: ResponseRateCallback[] = [];
  private onPauseCampaignCallbacks: ResponseRateCallback[] = [];
  private onRecoverRateCallbacks: ResponseRateCallback[] = [];

  private readonly REDUCE_THRESHOLD = 0.10;
  private readonly PAUSE_THRESHOLD = 0.05;
  private readonly MIN_DELIVERED = 10;

  private contactTemplateMap: Map<string, string> = new Map();
  private contactTemplateMaxEntries = 50000;

  private processedDeliveredIds: Set<string> = new Set();
  private processedReplyIds: Set<string> = new Set();
  private readonly DEDUP_MAX_SIZE = 50000;

  private aggGlobalDelivered = 0;
  private aggGlobalReplies = 0;
  private aggTemplateDelivered: Map<string, number> = new Map();
  private aggTemplateReplies: Map<string, number> = new Map();
  private aggPhoneDelivered: Map<string, number> = new Map();
  private aggPhoneReplies: Map<string, number> = new Map();

  private windowedDeliveredTimestamps: number[] = [];
  private windowedReplyTimestamps: number[] = [];
  private static readonly WINDOWED_RING_MAX = 5000;

  constructor(windowMs: number = 300000) {
    this.windowMs = windowMs;
  }

  getIncrementalAggregates(): {
    globalDelivered: number;
    globalReplies: number;
    templateDelivered: ReadonlyMap<string, number>;
    templateReplies: ReadonlyMap<string, number>;
    phoneDelivered: ReadonlyMap<string, number>;
    phoneReplies: ReadonlyMap<string, number>;
  } {
    return {
      globalDelivered: this.aggGlobalDelivered,
      globalReplies: this.aggGlobalReplies,
      templateDelivered: this.aggTemplateDelivered,
      templateReplies: this.aggTemplateReplies,
      phoneDelivered: this.aggPhoneDelivered,
      phoneReplies: this.aggPhoneReplies,
    };
  }

  private buildKey(campaignId: string, templateName: string, phoneNumberId: string): string {
    return `${campaignId}:${templateName}:${phoneNumberId}`;
  }

  private getOrCreateBucket(campaignId: string, templateName: string, phoneNumberId: string): TrackerBucket {
    const key = this.buildKey(campaignId, templateName, phoneNumberId);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        key: { campaignId, templateName, phoneNumberId },
        entries: [],
        totalDelivered: 0,
        totalReplies: 0,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private pruneEntries(bucket: TrackerBucket): void {
    const cutoff = Date.now() - this.windowMs;
    bucket.entries = bucket.entries.filter(e => e.timestamp >= cutoff);
  }

  private getWindowedCounts(bucket: TrackerBucket): { delivered: number; replies: number } {
    this.pruneEntries(bucket);
    let delivered = 0;
    let replies = 0;
    for (const e of bucket.entries) {
      if (e.type === 'delivered') delivered++;
      else if (e.type === 'reply') replies++;
    }
    return { delivered, replies };
  }

  private pruneDedupSet(dedupSet: Set<string>): void {
    if (dedupSet.size > this.DEDUP_MAX_SIZE) {
      const iter = dedupSet.values();
      let toRemove = dedupSet.size - this.DEDUP_MAX_SIZE + 1000;
      while (toRemove > 0) {
        const val = iter.next().value;
        if (val !== undefined) dedupSet.delete(val);
        toRemove--;
      }
    }
  }

  recordDelivered(campaignId: string, templateName: string, phoneNumberId: string, contactPhone?: string, messageId?: string): void {
    if (messageId) {
      const dedupKey = `d:${messageId}`;
      if (this.processedDeliveredIds.has(dedupKey)) {
        console.log(`[METRIC] response_rate delivered DEDUP skip messageId=${messageId}`);
        return;
      }
      this.processedDeliveredIds.add(dedupKey);
      this.pruneDedupSet(this.processedDeliveredIds);
    }

    const now = Date.now();
    const tplBucket = this.getOrCreateBucket(campaignId, templateName, phoneNumberId);
    tplBucket.entries.push({ timestamp: now, type: 'delivered' });
    tplBucket.totalDelivered++;
    if (contactPhone) {
      if (this.contactTemplateMap.size >= this.contactTemplateMaxEntries) {
        const firstKey = this.contactTemplateMap.keys().next().value;
        if (firstKey !== undefined) this.contactTemplateMap.delete(firstKey);
      }
      this.contactTemplateMap.set(`${campaignId}:${contactPhone}`, templateName);
    }
    const campaignBucket = this.getOrCreateBucket(campaignId, '_campaign', phoneNumberId);
    campaignBucket.entries.push({ timestamp: now, type: 'delivered' });
    campaignBucket.totalDelivered++;

    const tplName = templateName || 'unattributed';
    this.aggGlobalDelivered++;
    this.aggTemplateDelivered.set(tplName, (this.aggTemplateDelivered.get(tplName) ?? 0) + 1);
    this.aggPhoneDelivered.set(phoneNumberId, (this.aggPhoneDelivered.get(phoneNumberId) ?? 0) + 1);
    this.windowedDeliveredTimestamps.push(now);
    if (this.windowedDeliveredTimestamps.length > ResponseRateTracker.WINDOWED_RING_MAX) {
      this.windowedDeliveredTimestamps.splice(0, this.windowedDeliveredTimestamps.length - ResponseRateTracker.WINDOWED_RING_MAX);
    }

    console.log(`[METRIC] response_rate delivered campaignId=${campaignId} template=${templateName} phone=${phoneNumberId}`);
    this.evaluateBucket(tplBucket);
    this.evaluateBucket(campaignBucket);
  }

  recordReply(campaignId: string, phoneNumberId: string, contactPhone?: string, messageId?: string): void {
    if (messageId) {
      const dedupKey = `r:${messageId}`;
      if (this.processedReplyIds.has(dedupKey)) {
        console.log(`[METRIC] response_rate reply DEDUP skip messageId=${messageId}`);
        return;
      }
      this.processedReplyIds.add(dedupKey);
      this.pruneDedupSet(this.processedReplyIds);
    }

    const now = Date.now();
    const campaignBucket = this.getOrCreateBucket(campaignId, '_campaign', phoneNumberId);
    campaignBucket.entries.push({ timestamp: now, type: 'reply' });
    campaignBucket.totalReplies++;
    let resolvedTemplate: string | undefined;
    if (contactPhone) {
      resolvedTemplate = this.contactTemplateMap.get(`${campaignId}:${contactPhone}`);
    }
    const replyTemplate = resolvedTemplate || 'unattributed';
    const tplBucket = this.getOrCreateBucket(campaignId, replyTemplate, phoneNumberId);
    tplBucket.entries.push({ timestamp: now, type: 'reply' });
    tplBucket.totalReplies++;
    this.aggTemplateReplies.set(replyTemplate, (this.aggTemplateReplies.get(replyTemplate) ?? 0) + 1);
    this.evaluateBucket(tplBucket);
    this.aggGlobalReplies++;
    this.aggPhoneReplies.set(phoneNumberId, (this.aggPhoneReplies.get(phoneNumberId) ?? 0) + 1);
    this.windowedReplyTimestamps.push(now);
    if (this.windowedReplyTimestamps.length > ResponseRateTracker.WINDOWED_RING_MAX) {
      this.windowedReplyTimestamps.splice(0, this.windowedReplyTimestamps.length - ResponseRateTracker.WINDOWED_RING_MAX);
    }
    console.log(`[METRIC] response_rate reply campaignId=${campaignId} template=${resolvedTemplate || '_campaign'} phone=${phoneNumberId} contactPhone=${contactPhone || 'unknown'}`);
    this.evaluateBucket(campaignBucket);
  }

  private evaluateBucket(bucket: TrackerBucket): void {
    const { delivered, replies } = this.getWindowedCounts(bucket);
    if (delivered < this.MIN_DELIVERED) return;

    const responseRate = replies / delivered;
    const snapshot: ResponseRateSnapshot = {
      campaignId: bucket.key.campaignId,
      templateName: bucket.key.templateName,
      phoneNumberId: bucket.key.phoneNumberId,
      deliveredCount: delivered,
      replyCount: replies,
      responseRate,
      windowMs: this.windowMs,
    };

    if (responseRate < this.PAUSE_THRESHOLD) {
      console.log(`[METRIC] response_rate PAUSE threshold hit: rate=${(responseRate * 100).toFixed(1)}% campaignId=${bucket.key.campaignId} template=${bucket.key.templateName}`);
      this.onPauseCampaignCallbacks.forEach(cb => cb(snapshot));
    } else if (responseRate < this.REDUCE_THRESHOLD) {
      console.log(`[METRIC] response_rate REDUCE threshold hit: rate=${(responseRate * 100).toFixed(1)}% campaignId=${bucket.key.campaignId} template=${bucket.key.templateName}`);
      this.onReduceRateCallbacks.forEach(cb => cb(snapshot));
    } else if (responseRate >= this.REDUCE_THRESHOLD) {
      this.onRecoverRateCallbacks.forEach(cb => cb(snapshot));
    }
  }

  getSnapshot(campaignId: string, templateName: string, phoneNumberId: string): ResponseRateSnapshot | null {
    const key = this.buildKey(campaignId, templateName, phoneNumberId);
    const bucket = this.buckets.get(key);
    if (!bucket) return null;

    const { delivered, replies } = this.getWindowedCounts(bucket);
    const responseRate = delivered > 0 ? replies / delivered : 0;

    return {
      campaignId,
      templateName,
      phoneNumberId,
      deliveredCount: delivered,
      replyCount: replies,
      responseRate,
      windowMs: this.windowMs,
    };
  }

  getSnapshotsForCampaign(campaignId: string): ResponseRateSnapshot[] {
    const results: ResponseRateSnapshot[] = [];
    const bucketValues = Array.from(this.buckets.values());
    for (const bucket of bucketValues) {
      if (bucket.key.campaignId !== campaignId) continue;
      if (bucket.key.templateName === '_campaign') continue;
      const { delivered, replies } = this.getWindowedCounts(bucket);
      results.push({
        campaignId,
        templateName: bucket.key.templateName,
        phoneNumberId: bucket.key.phoneNumberId,
        deliveredCount: delivered,
        replyCount: replies,
        responseRate: delivered > 0 ? replies / delivered : 0,
        windowMs: this.windowMs,
      });
    }
    return results;
  }

  getCampaignLevelSnapshot(campaignId: string, phoneNumberId: string): ResponseRateSnapshot | null {
    return this.getSnapshot(campaignId, '_campaign', phoneNumberId);
  }

  getCumulativeCampaignStats(campaignId: string, phoneNumberId: string): CumulativeCampaignStats | null {
    const key = this.buildKey(campaignId, '_campaign', phoneNumberId);
    const bucket = this.buckets.get(key);
    if (!bucket) return null;
    return {
      totalDelivered: bucket.totalDelivered,
      totalReplies: bucket.totalReplies,
    };
  }

  onReduceRate(callback: ResponseRateCallback): void {
    this.onReduceRateCallbacks.push(callback);
  }

  onPauseCampaign(callback: ResponseRateCallback): void {
    this.onPauseCampaignCallbacks.push(callback);
  }

  onRecoverRate(callback: ResponseRateCallback): void {
    this.onRecoverRateCallbacks.push(callback);
  }

  getWindowedCampaignCounts(): { delivered: number; replies: number } {
    const cutoff = Date.now() - this.windowMs;
    let di = 0;
    while (di < this.windowedDeliveredTimestamps.length && this.windowedDeliveredTimestamps[di] < cutoff) di++;
    if (di > 0) this.windowedDeliveredTimestamps.splice(0, di);
    let ri = 0;
    while (ri < this.windowedReplyTimestamps.length && this.windowedReplyTimestamps[ri] < cutoff) ri++;
    if (ri > 0) this.windowedReplyTimestamps.splice(0, ri);
    return { delivered: this.windowedDeliveredTimestamps.length, replies: this.windowedReplyTimestamps.length };
  }

  reset(): void {
    this.buckets.clear();
    this.contactTemplateMap.clear();
    this.onReduceRateCallbacks.length = 0;
    this.onPauseCampaignCallbacks.length = 0;
    this.onRecoverRateCallbacks.length = 0;
    this.processedDeliveredIds.clear();
    this.processedReplyIds.clear();
    this.aggGlobalDelivered = 0;
    this.aggGlobalReplies = 0;
    this.aggTemplateDelivered.clear();
    this.aggTemplateReplies.clear();
    this.aggPhoneDelivered.clear();
    this.aggPhoneReplies.clear();
    this.windowedDeliveredTimestamps.length = 0;
    this.windowedReplyTimestamps.length = 0;
  }
}
