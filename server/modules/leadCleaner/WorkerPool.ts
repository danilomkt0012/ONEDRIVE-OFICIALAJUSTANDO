import type { NormalizedLead } from "./LeadNormalizer";
import { CacheStore } from "./CacheStore";
import { whatsappChecker } from "../leadCleanerUltra/WhatsAppChecker";
import { logError } from '../../utils/logger';

export interface WorkerResult {
  lead: NormalizedLead;
  valid: boolean | null;
  fromCache: boolean;
}

export class WorkerPool {
  private maxWorkers: number;
  private totalChecked = 0;
  private totalErrors = 0;
  private cache: CacheStore;

  constructor(cache: CacheStore, initialWorkers = 10) {
    this.maxWorkers = initialWorkers;
    this.cache = cache;
  }

  isConfigured(): boolean {
    return whatsappChecker.isConfigured();
  }

  async processBatch(leads: NormalizedLead[]): Promise<WorkerResult[]> {
    const results: WorkerResult[] = [];
    const toCheck: { lead: NormalizedLead; idx: number }[] = [];

    for (let i = 0; i < leads.length; i++) {
      const cached = this.cache.get(leads[i].phone);
      if (cached !== null) {
        results.push({ lead: leads[i], valid: cached, fromCache: true });
      } else {
        results.push({ lead: leads[i], valid: null, fromCache: false });
        toCheck.push({ lead: leads[i], idx: i });
      }
    }

    if (!this.isConfigured() || toCheck.length === 0) {
      return results;
    }

    const concurrency = this.getCurrentConcurrency();
    const chunks: typeof toCheck[] = [];
    for (let i = 0; i < toCheck.length; i += concurrency) {
      chunks.push(toCheck.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (item) => {
        const result = await this.checkSingle(item.lead.phone);
        this.totalChecked++;
        if (result === null) {
          this.totalErrors++;
        } else {
          this.cache.set(item.lead.phone, result);
        }
        results[item.idx] = { lead: item.lead, valid: result, fromCache: false };
      });

      await Promise.all(promises);
      await this.delay(300);
    }

    return results;
  }

  private getCurrentConcurrency(): number {
    if (this.totalChecked < 20) return this.maxWorkers;
    const errorRate = this.totalErrors / this.totalChecked;
    if (errorRate > 0.10) return Math.max(3, Math.floor(this.maxWorkers * 0.3));
    if (errorRate > 0.05) return Math.max(5, Math.floor(this.maxWorkers * 0.5));
    return this.maxWorkers;
  }

  private async checkSingle(phone: string, retry = 0): Promise<boolean | null> {
    try {
      const result = await whatsappChecker.checkNumber(phone);

      if (result.exists !== null) {
        return result.exists;
      }

      if (retry < 1) {
        await this.delay(500);
        return this.checkSingle(phone, retry + 1);
      }

      console.error(`[WorkerPool] Error for ${phone}: ${result.error}`);
      return null;
    } catch (error: any) {
      if (retry < 1) {
        await this.delay(500);
        return this.checkSingle(phone, retry + 1);
      }
      logError('WorkerPool.checkSingle', { phone }, error);
      return null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  get stats() {
    return {
      concurrency: this.getCurrentConcurrency(),
      totalChecked: this.totalChecked,
      totalErrors: this.totalErrors,
      errorRate: this.totalChecked > 0 ? this.totalErrors / this.totalChecked : 0,
      cacheSize: this.cache.size,
    };
  }
}
