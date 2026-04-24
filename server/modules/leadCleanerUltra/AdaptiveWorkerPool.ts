import type { NormalizedLead } from "./QueueEngine";
import { CacheLayer } from "./CacheLayer";
import { whatsappChecker } from "./WhatsAppChecker";

export interface ValidationResult {
  lead: NormalizedLead;
  valid: boolean | null;
  fromCache: boolean;
}

export class AdaptiveWorkerPool {
  private cache: CacheLayer;

  private maxConcurrency = 50;
  private minConcurrency = 10;
  private _currentConcurrency = 30;

  private totalChecked = 0;
  private totalErrors = 0;
  private consecutiveTimeouts = 0;
  private backoffMs = 0;
  private _apiReachable: boolean | null = null;

  constructor(cache: CacheLayer) {
    this.cache = cache;
  }

  isConfigured(): boolean {
    return whatsappChecker.isConfigured();
  }

  get concurrency(): number { return this._currentConcurrency; }
  get apiReachable(): boolean | null { return this._apiReachable; }

  async testConnection(): Promise<boolean> {
    whatsappChecker.reload();

    if (!whatsappChecker.isConfigured()) {
      console.log("[AdaptiveWorkerPool] Nenhuma API WhatsApp configurada");
      this._apiReachable = false;
      return false;
    }

    const ok = await whatsappChecker.testConnection();
    this._apiReachable = ok;

    if (!ok) {
      console.log(`[AdaptiveWorkerPool] WhatsApp API (${whatsappChecker.getProviderName()}) não acessível - pulando verificação`);
    }

    return ok;
  }

  async processBatch(leads: NormalizedLead[]): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const toCheck: NormalizedLead[] = [];

    for (const lead of leads) {
      const cached = this.cache.get(lead.phone);
      if (cached !== null) {
        results.push({ lead, valid: cached, fromCache: true });
      } else {
        toCheck.push(lead);
      }
    }

    if (toCheck.length === 0) return results;

    let i = 0;
    while (i < toCheck.length) {
      const chunkSize = Math.min(this._currentConcurrency, toCheck.length - i, 100);
      const chunk = toCheck.slice(i, i + chunkSize);

      if (this.backoffMs > 0) {
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.max(0, this.backoffMs - 100);
      }

      const settled = await Promise.allSettled(
        chunk.map(lead => this.checkWithRetry(lead))
      );

      for (let idx = 0; idx < settled.length; idx++) {
        const s = settled[idx];
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          results.push({ lead: chunk[idx], valid: null, fromCache: false });
        }
      }

      i += chunkSize;
      this.adaptConcurrency();
    }

    return results;
  }

  private async checkWithRetry(lead: NormalizedLead): Promise<ValidationResult> {
    const result = await this.checkSingle(lead);
    if (result.valid === null) {
      await this.sleep(100);
      const retry = await this.checkSingle(lead);
      return retry;
    }
    return result;
  }

  private async checkSingle(lead: NormalizedLead): Promise<ValidationResult> {
    try {
      const result = await whatsappChecker.checkNumber(lead.phone);
      this.totalChecked++;
      this.consecutiveTimeouts = 0;

      if (result.error === "rate_limited") {
        this.totalErrors++;
        this.backoffMs = Math.min(this.backoffMs * 2 || 1000, 16000);
        return { lead, valid: null, fromCache: false };
      }

      if (result.error && result.error.startsWith("http_5")) {
        this.totalErrors++;
        this.backoffMs = Math.min(this.backoffMs * 2 || 500, 8000);
        return { lead, valid: null, fromCache: false };
      }

      if (result.exists === null) {
        this.totalErrors++;
        return { lead, valid: null, fromCache: false };
      }

      this.backoffMs = Math.max(0, this.backoffMs - 200);
      this.cache.set(lead.phone, result.exists);
      return { lead, valid: result.exists, fromCache: false };
    } catch (err: any) {
      this.totalChecked++;
      this.totalErrors++;

      if (err.name === "AbortError") {
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= 3) {
          this._currentConcurrency = Math.max(this.minConcurrency, Math.floor(this._currentConcurrency * 0.5));
          this.backoffMs = Math.min(this.backoffMs * 2 || 1000, 16000);
        }
      } else {
        this.backoffMs = Math.min(this.backoffMs * 2 || 500, 8000);
      }

      return { lead, valid: null, fromCache: false };
    }
  }

  private adaptConcurrency(): void {
    if (this.totalChecked < 10) return;
    const errorRate = this.totalErrors / this.totalChecked;

    if (errorRate > 0.1) {
      this._currentConcurrency = this.minConcurrency;
    } else if (errorRate > 0.05) {
      this._currentConcurrency = 20;
    } else if (this._currentConcurrency < this.maxConcurrency) {
      this._currentConcurrency = Math.min(this._currentConcurrency + 2, this.maxConcurrency);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
