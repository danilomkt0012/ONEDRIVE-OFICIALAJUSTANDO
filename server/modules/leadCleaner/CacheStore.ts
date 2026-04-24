import fsp from "fs/promises";
import path from "path";
import { logError } from '../../utils/logger';

interface CacheEntry {
  valid: boolean;
  timestamp: number;
}

const CACHE_FILE = path.resolve("data/validated_numbers.json");
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CacheStore {
  private cache: Map<string, CacheEntry> = new Map();
  private dirty = false;
  private loaded = false;

  async init(): Promise<void> {
    if (this.loaded) return;
    await this.loadAsync();
    this.loaded = true;
  }

  private async loadAsync(): Promise<void> {
    try {
      const raw = await fsp.readFile(CACHE_FILE, "utf-8");
      const entries: Record<string, CacheEntry> = JSON.parse(raw);
      const now = Date.now();
      for (const [phone, entry] of Object.entries(entries)) {
        if (now - entry.timestamp < TTL_MS) {
          this.cache.set(phone, entry);
        }
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        logError("CacheStore.loadAsync", {}, e);
      }
      this.cache = new Map();
    }
  }

  get(phone: string): boolean | null {
    const entry = this.cache.get(phone);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.cache.delete(phone);
      return null;
    }
    return entry.valid;
  }

  set(phone: string, valid: boolean): void {
    this.cache.set(phone, { valid, timestamp: Date.now() });
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
      logError("CacheStore.flushAsync", {}, err);
    }
  }

  get size(): number {
    return this.cache.size;
  }
}
