import fsp from "fs/promises";
import path from "path";
import { logError } from '../../utils/logger';

const CACHE_FILE = path.resolve("data/whatsapp_cache.json");
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  exists: boolean;
  checkedAt: number;
}

export class CacheLayer {
  private cache: Map<string, CacheEntry> = new Map();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;

  constructor() {
    this.flushTimer = setInterval(() => this.flushAsync(), 30_000);
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await this.loadAsync();
    this.loaded = true;
  }

  private async loadAsync(): Promise<void> {
    try {
      const raw = await fsp.readFile(CACHE_FILE, "utf-8");
      const data = JSON.parse(raw);
      const now = Date.now();
      for (const [key, val] of Object.entries(data)) {
        const entry = val as CacheEntry;
        if (now - entry.checkedAt < TTL_MS) {
          this.cache.set(key, entry);
        }
      }
      console.log(`[CacheLayer] Loaded ${this.cache.size} valid entries`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logError("CacheLayer.loadAsync", {}, err);
      }
    }
  }

  get(phone: string): boolean | null {
    const entry = this.cache.get(phone);
    if (!entry) return null;
    if (Date.now() - entry.checkedAt >= TTL_MS) {
      this.cache.delete(phone);
      return null;
    }
    return entry.exists;
  }

  set(phone: string, exists: boolean): void {
    this.cache.set(phone, { exists, checkedAt: Date.now() });
    this.dirty = true;
  }

  async flushAsync(): Promise<void> {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(CACHE_FILE);
      await fsp.mkdir(dir, { recursive: true });
      const obj: Record<string, CacheEntry> = {};
      this.cache.forEach((v, k) => { obj[k] = v; });
      await fsp.writeFile(CACHE_FILE, JSON.stringify(obj), "utf-8");
      this.dirty = false;
    } catch (err: any) {
      logError("CacheLayer.flushAsync", {}, err);
    }
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushAsync();
  }

  get totalEntries(): number { return this.cache.size; }
}
