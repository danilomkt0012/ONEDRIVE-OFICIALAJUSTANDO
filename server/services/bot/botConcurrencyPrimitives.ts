/**
 * Bot concurrency primitives — shared by BotFlowEngine.ts and the concurrency stress test.
 *
 * These are pure in-memory coordination mechanisms with no external I/O dependencies,
 * making them importable by tests without mocking databases or external APIs.
 */

const PHONE_MAP_IDLE_TTL_MS = 30 * 60 * 1000;

const phoneMutexes = new Map<string, Promise<void>>();
const phoneMutexLastUse = new Map<string, number>();
export const phoneMutexQueueDepth = new Map<string, number>();

export async function withPhoneMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  phoneMutexLastUse.set(key, Date.now());
  const prev = phoneMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>(r => { release = r; });
  phoneMutexes.set(key, lock);

  const entryDepth = (phoneMutexQueueDepth.get(key) ?? 0) + 1;
  phoneMutexQueueDepth.set(key, entryDepth);

  if (entryDepth > 1) {
    console.log(`[BOT_QUEUE_ADD] key=${key} queueDepth=${entryDepth}`);
  }

  try {
    await prev;
    const activeDepth = phoneMutexQueueDepth.get(key) ?? 1;
    console.log(`[BOT_LOCK_ACQUIRED] key=${key} queueDepth=${activeDepth}`);
    if (entryDepth > 1) {
      console.log(`[BOT_QUEUE_PROCESS] key=${key} waitingBehind=${activeDepth - 1}`);
    }
    return await fn();
  } finally {
    console.log(`[BOT_LOCK_RELEASED] key=${key}`);
    const remaining = (phoneMutexQueueDepth.get(key) ?? 1) - 1;
    if (remaining <= 0) {
      phoneMutexQueueDepth.delete(key);
    } else {
      phoneMutexQueueDepth.set(key, remaining);
    }
    if (phoneMutexes.get(key) === lock) {
      phoneMutexes.delete(key);
    }
    phoneMutexLastUse.delete(key);
    release();
  }
}

const phoneSendQueues = new Map<string, Promise<void>>();
const phoneSendQueueLastUse = new Map<string, number>();

export async function withSendQueue<T>(phone: string, fn: () => Promise<T>): Promise<T> {
  phoneSendQueueLastUse.set(phone, Date.now());
  const prev = phoneSendQueues.get(phone) || Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>(r => { resolve = r; });
  phoneSendQueues.set(phone, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (phoneSendQueues.get(phone) === next) {
      phoneSendQueues.delete(phone);
      phoneSendQueueLastUse.delete(phone);
    }
  }
}

export const BOT_DEBOUNCE_MS = 2000;

interface DebounceEntry {
  timer: ReturnType<typeof setTimeout>;
  fn: () => void;
}

const phoneDebounceTimers = new Map<string, DebounceEntry>();

export function scheduleWithDebounce(key: string, fn: () => void): void {
  const existing = phoneDebounceTimers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    console.log(`[BOT_DEBOUNCE_TRIGGERED] key=${key} — previous timer cancelled, resetting debounce`);
  }
  const timer = setTimeout(() => {
    phoneDebounceTimers.delete(key);
    fn();
  }, BOT_DEBOUNCE_MS);
  phoneDebounceTimers.set(key, { timer, fn });
}

const _phoneMapCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - PHONE_MAP_IDLE_TTL_MS;
  Array.from(phoneMutexLastUse.entries()).forEach(([key, lastUse]) => {
    if (lastUse < cutoff && !phoneMutexes.has(key)) {
      phoneMutexLastUse.delete(key);
      phoneMutexQueueDepth.delete(key);
    }
  });
  Array.from(phoneSendQueueLastUse.entries()).forEach(([phone, lastUse]) => {
    if (lastUse < cutoff && !phoneSendQueues.has(phone)) {
      phoneSendQueueLastUse.delete(phone);
    }
  });
}, 10 * 60 * 1000).unref();
