import { db } from '../../db';
import { optOutNumbers } from '@shared/schema';
import { eq, sql, inArray } from 'drizzle-orm';
import { logError } from '../../utils/logger';

const OPT_OUT_ERROR_CODES = [132001, 132015, 133010];

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
