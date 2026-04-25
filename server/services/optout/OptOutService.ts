import { db } from '../../db';
import { optOutNumbers, frequencyBlacklist } from '@shared/schema';
import { eq, sql, inArray, gt } from 'drizzle-orm';
import { logError } from '../../utils/logger';

const OPT_OUT_ERROR_CODES = [132001, 132015, 133010];
const FREQUENCY_CAP_ERROR_CODES = [131049, 131056];
const FREQUENCY_BLACKLIST_DAYS = 7;

const OPT_OUT_CACHE = new Set<string>();
let cacheLoaded = false;

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  const rows = await db.select({ phone: optOutNumbers.phone }).from(optOutNumbers);
  for (const row of rows) {
    OPT_OUT_CACHE.add(normalizePhone(row.phone));
  }
  cacheLoaded = true;
}

export async function addOptOut(
  phone: string,
  reason: string,
  errorCode?: number,
  campaignId?: string,
  phoneNumberId?: string
): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 8) return false;

  if (OPT_OUT_CACHE.has(normalized)) return false;

  try {
    await db.insert(optOutNumbers).values({
      phone: normalized,
      reason,
      errorCode,
      campaignId,
      phoneNumberId,
    }).onConflictDoNothing();

    OPT_OUT_CACHE.add(normalized);
    console.log(`🚫 Opt-out registrado: ${normalized} (${reason})`);
    return true;
  } catch (err) {
    return false;
  }
}

export async function removeOptOut(phone: string): Promise<boolean> {
  const normalized = normalizePhone(phone);
  try {
    await db.delete(optOutNumbers).where(eq(optOutNumbers.phone, normalized));
    OPT_OUT_CACHE.delete(normalized);
    return true;
  } catch (e: any) {
    logError("optout.removeOptOut", {}, e);
    return false;
  }
}

export async function isOptedOut(phone: string): Promise<boolean> {
  await loadCache();
  return OPT_OUT_CACHE.has(normalizePhone(phone));
}

export async function filterOptedOutLeads<T extends { phone: string }>(leads: T[]): Promise<{ clean: T[]; removed: number }> {
  await loadCache();
  const clean: T[] = [];
  let removed = 0;

  for (const lead of leads) {
    if (OPT_OUT_CACHE.has(normalizePhone(lead.phone))) {
      removed++;
    } else {
      clean.push(lead);
    }
  }

  if (removed > 0) {
    console.log(`🚫 Opt-out filter: ${removed} leads removidos, ${clean.length} restantes`);
  }

  return { clean, removed };
}

export function shouldOptOut(errorCode?: number, errorMessage?: string): boolean {
  if (errorCode && OPT_OUT_ERROR_CODES.includes(errorCode)) {
    return true;
  }

  if (errorMessage) {
    const lower = errorMessage.toLowerCase();
    if (
      lower.includes('opt-out') ||
      lower.includes('opted out') ||
      lower.includes('user has blocked') ||
      lower.includes('customer has blocked') ||
      lower.includes('recipient blocked')
    ) {
      return true;
    }
  }

  return false;
}

export async function handleDeliveryError(
  phone: string,
  errorCode: number | undefined,
  errorMessage: string,
  campaignId?: string,
  phoneNumberId?: string
): Promise<void> {
  if (shouldOptOut(errorCode, errorMessage)) {
    const reason = errorCode
      ? `error_${errorCode}`
      : 'blocked_by_message';
    await addOptOut(phone, reason, errorCode, campaignId, phoneNumberId);
  }

  // Erro 131049/131056 = frequency cap por usuário (Meta).
  // Não retentamos por 7 dias — usuário foi bombardeado por outros negócios também.
  if (errorCode && FREQUENCY_CAP_ERROR_CODES.includes(errorCode)) {
    await addToFrequencyBlacklist(phone, errorCode);
  }
}

const FREQ_BLACKLIST_CACHE = new Set<string>();
let freqCacheLoaded = false;
let freqCacheLastLoad = 0;
const FREQ_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadFrequencyCache(): Promise<void> {
  const now = Date.now();
  if (freqCacheLoaded && (now - freqCacheLastLoad) < FREQ_CACHE_TTL_MS) return;
  try {
    const rows = await db
      .select({ phone: frequencyBlacklist.phone })
      .from(frequencyBlacklist)
      .where(gt(frequencyBlacklist.blockedUntil, new Date()));
    FREQ_BLACKLIST_CACHE.clear();
    for (const row of rows) FREQ_BLACKLIST_CACHE.add(normalizePhone(row.phone));
    freqCacheLoaded = true;
    freqCacheLastLoad = now;
  } catch (err) {
    logError('OptOutService.loadFrequencyCache', {}, err);
  }
}

export async function addToFrequencyBlacklist(phone: string, errorCode: number): Promise<boolean> {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 8) return false;

  const blockedUntil = new Date(Date.now() + FREQUENCY_BLACKLIST_DAYS * 24 * 60 * 60 * 1000);
  try {
    await db.insert(frequencyBlacklist).values({
      phone: normalized,
      reason: `frequency_cap_${errorCode}`,
      errorCode,
      blockedUntil,
      hitCount: 1,
      lastHitAt: new Date(),
    });
    FREQ_BLACKLIST_CACHE.add(normalized);
    console.log(`⏳ Frequency blacklist (7d): ${normalized} — erro ${errorCode}`);
    return true;
  } catch {
    // Já existe — incrementa hit count e estende o prazo
    try {
      await db
        .update(frequencyBlacklist)
        .set({
          hitCount: sql`${frequencyBlacklist.hitCount} + 1`,
          blockedUntil,
          lastHitAt: new Date(),
        })
        .where(eq(frequencyBlacklist.phone, normalized));
      FREQ_BLACKLIST_CACHE.add(normalized);
    } catch (err) {
      logError('OptOutService.addToFrequencyBlacklist.update', { phone: normalized }, err);
    }
    return false;
  }
}

export async function isFrequencyBlacklisted(phone: string): Promise<boolean> {
  await loadFrequencyCache();
  return FREQ_BLACKLIST_CACHE.has(normalizePhone(phone));
}

export async function filterFrequencyBlacklisted<T extends { phone: string }>(
  leads: T[]
): Promise<{ clean: T[]; removed: number }> {
  await loadFrequencyCache();
  const clean: T[] = [];
  let removed = 0;
  for (const lead of leads) {
    if (FREQ_BLACKLIST_CACHE.has(normalizePhone(lead.phone))) removed++;
    else clean.push(lead);
  }
  if (removed > 0) {
    console.log(`⏳ Frequency blacklist filter: ${removed} leads em quarentena de 7d, ${clean.length} restantes`);
  }
  return { clean, removed };
}

export function invalidateFrequencyCache(): void {
  freqCacheLoaded = false;
  freqCacheLastLoad = 0;
  FREQ_BLACKLIST_CACHE.clear();
}

export async function getOptOutList(limit = 100, offset = 0): Promise<{ numbers: Array<{ phone: string; reason: string; errorCode: number | null; createdAt: Date | null }>; total: number }> {
  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(optOutNumbers);
  const total = Number(countResult.count);

  const numbers = await db
    .select({
      phone: optOutNumbers.phone,
      reason: optOutNumbers.reason,
      errorCode: optOutNumbers.errorCode,
      createdAt: optOutNumbers.createdAt,
    })
    .from(optOutNumbers)
    .limit(limit)
    .offset(offset);

  return { numbers, total };
}

export async function clearOptOutList(): Promise<number> {
  const [result] = await db.select({ count: sql<number>`count(*)` }).from(optOutNumbers);
  await db.delete(optOutNumbers);
  OPT_OUT_CACHE.clear();
  cacheLoaded = false;
  return Number(result.count);
}

export async function getOptOutStats(): Promise<{
  total: number;
  byReason: Record<string, number>;
}> {
  const rows = await db
    .select({
      reason: optOutNumbers.reason,
      count: sql<number>`count(*)`,
    })
    .from(optOutNumbers)
    .groupBy(optOutNumbers.reason);

  const byReason: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byReason[row.reason] = Number(row.count);
    total += Number(row.count);
  }

  return { total, byReason };
}

export function invalidateCache(): void {
  cacheLoaded = false;
  OPT_OUT_CACHE.clear();
}
