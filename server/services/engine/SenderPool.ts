import { db } from '../../db';
import { senderUsage, wabaNumbers, warmupSchedules } from '@shared/schema';
import type { SenderUsage } from '@shared/schema';
import { eq, and, asc, sql, or, lt, desc } from 'drizzle-orm';

const WARMUP_STAGES = [250, 500, 1000, 2000, 5000] as const;

export interface SenderInfo {
  phoneNumberId: string;
  sentToday: number;
  dailyQuota: number;
  status: string;
  remaining: number;
}

const COOLDOWN_DURATION_MS = 5 * 60 * 1000;

function senderIsAvailable(r: SenderUsage): boolean {
  if (r.status === 'ok') return true;
  if (r.status === 'cooldown' && r.cooldownUntil && r.cooldownUntil <= new Date()) return true;
  return false;
}

export async function nextSender(excludeId?: string): Promise<SenderInfo> {
  const now = new Date();

  const rows = await db
    .select()
    .from(senderUsage)
    .where(
      or(
        eq(senderUsage.status, 'ok'),
        and(
          eq(senderUsage.status, 'cooldown'),
          lt(senderUsage.cooldownUntil, now)
        )
      )
    )
    .orderBy(asc(senderUsage.sentToday))
    .limit(5);

  const available = excludeId ? rows.filter(r => r.phoneNumberId !== excludeId) : rows;
  const chosen = available.length > 0 ? available[0] : (rows.length > 0 ? rows[0] : null);

  if (!chosen) {
    throw new Error('Sem sender disponível — todos estão mortos ou em cooldown ativo');
  }

  if (chosen.status === 'cooldown' && chosen.cooldownUntil && chosen.cooldownUntil <= now) {
    await db
      .update(senderUsage)
      .set({ status: 'ok', cooldownUntil: null })
      .where(eq(senderUsage.phoneNumberId, chosen.phoneNumberId));
    chosen.status = 'ok';
    console.log(`[SenderPool] Sender ${chosen.phoneNumberId} saiu do cooldown — restaurado automaticamente`);
  }

  return {
    phoneNumberId: chosen.phoneNumberId,
    sentToday: chosen.sentToday,
    dailyQuota: chosen.dailyQuota,
    status: chosen.status,
    remaining: chosen.dailyQuota - chosen.sentToday,
  };
}

export async function incrementSender(phoneNumberId: string): Promise<void> {
  await db
    .update(senderUsage)
    .set({
      sentToday: sql`${senderUsage.sentToday} + 1`,
      lastSent: new Date(),
    })
    .where(eq(senderUsage.phoneNumberId, phoneNumberId));
}

export async function markDead(phoneNumberId: string): Promise<void> {
  const cooldownUntil = new Date(Date.now() + COOLDOWN_DURATION_MS);
  console.log(`[SenderPool] Sender ${phoneNumberId} em cooldown por 5 min (até ${cooldownUntil.toISOString()})`);
  await db
    .update(senderUsage)
    .set({
      status: 'cooldown',
      cooldownUntil,
      lastSent: new Date(),
    })
    .where(eq(senderUsage.phoneNumberId, phoneNumberId));
}

export async function resetDaily(): Promise<void> {
  console.log('[SenderPool] Resetting all senders for new day');
  await db
    .update(senderUsage)
    .set({
      sentToday: 0,
      status: 'ok',
      cooldownUntil: null,
      lastSent: new Date(),
    });
}

export async function getAllSenders(): Promise<SenderInfo[]> {
  const rows = await db.select().from(senderUsage).orderBy(asc(senderUsage.sentToday));
  return rows.map(r => ({
    phoneNumberId: r.phoneNumberId,
    sentToday: r.sentToday,
    dailyQuota: r.dailyQuota,
    status: r.status,
    remaining: r.dailyQuota - r.sentToday,
  }));
}

export async function getAvailableSenders(): Promise<SenderInfo[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(senderUsage)
    .where(
      or(
        eq(senderUsage.status, 'ok'),
        and(
          eq(senderUsage.status, 'cooldown'),
          lt(senderUsage.cooldownUntil, now)
        )
      )
    )
    .orderBy(asc(senderUsage.sentToday));

  return rows.map(r => ({
    phoneNumberId: r.phoneNumberId,
    sentToday: r.sentToday,
    dailyQuota: r.dailyQuota,
    status: r.status,
    remaining: r.dailyQuota - r.sentToday,
  }));
}

export async function upsertSender(phoneNumberId: string, dailyQuota: number = 2000): Promise<void> {
  const existing = await db
    .select()
    .from(senderUsage)
    .where(eq(senderUsage.phoneNumberId, phoneNumberId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(senderUsage)
      .set({ dailyQuota, status: 'ok', cooldownUntil: null })
      .where(eq(senderUsage.phoneNumberId, phoneNumberId));
  } else {
    await db.insert(senderUsage).values({
      phoneNumberId,
      sentToday: 0,
      dailyQuota,
      status: 'ok',
      lastSent: new Date(),
      cooldownUntil: null,
    });
  }
}

export async function removeSender(phoneNumberId: string): Promise<void> {
  await db.delete(senderUsage).where(eq(senderUsage.phoneNumberId, phoneNumberId));
}

export async function getSenderStatus(phoneNumberId: string): Promise<SenderInfo | null> {
  const rows = await db
    .select()
    .from(senderUsage)
    .where(eq(senderUsage.phoneNumberId, phoneNumberId))
    .limit(1);

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    phoneNumberId: r.phoneNumberId,
    sentToday: r.sentToday,
    dailyQuota: r.dailyQuota,
    status: r.status,
    remaining: r.dailyQuota - r.sentToday,
  };
}

export function shouldSwitchSender(_sentCount: number): boolean {
  return false;
}

/**
 * Upserts a sender with warmup-aware daily quota enforcement.
 * - For UNKNOWN-rated numbers: caps quota at 250 and auto-enrolls in warmup schedule.
 * - For numbers already in an active warmup schedule: applies current stage limit.
 * - For GREEN/YELLOW/RED numbers with no active warmup: uses the requested quota.
 */
export async function upsertSenderWithWarmup(
  phoneNumberId: string,
  wabaId: string,
  requestedQuota: number = 2000
): Promise<{ effectiveQuota: number; warmupActive: boolean }> {
  const [numRecord] = await db
    .select({ qualityRating: wabaNumbers.qualityRating })
    .from(wabaNumbers)
    .where(eq(wabaNumbers.phoneNumberId, phoneNumberId))
    .limit(1);

  const qualityRating = numRecord?.qualityRating ?? 'UNKNOWN';

  const [activeSchedule] = await db
    .select()
    .from(warmupSchedules)
    .where(
      and(
        eq(warmupSchedules.phoneNumberId, phoneNumberId),
        eq(warmupSchedules.wabaId, wabaId),
        eq(warmupSchedules.status, 'active')
      )
    )
    .orderBy(desc(warmupSchedules.createdAt))
    .limit(1);

  let effectiveQuota = requestedQuota;
  let warmupActive = false;

  if (activeSchedule) {
    const targets = (activeSchedule.dailyTargets as number[]).length > 0
      ? (activeSchedule.dailyTargets as number[])
      : [...WARMUP_STAGES];
    const dayIdx = Math.min(activeSchedule.currentDay - 1, targets.length - 1);
    effectiveQuota = Math.min(requestedQuota, targets[dayIdx]);
    warmupActive = true;
  } else if (qualityRating === 'UNKNOWN') {
    effectiveQuota = Math.min(requestedQuota, 250);
    warmupActive = true;

    const totalDays = WARMUP_STAGES.length;
    await db.insert(warmupSchedules).values({
      phoneNumberId,
      wabaId,
      status: 'active',
      currentDay: 1,
      totalDays,
      dailyTargets: [...WARMUP_STAGES],
      sentToday: 0,
      startedAt: new Date(),
    });
    console.log(`[SenderPool] Número ${phoneNumberId} (UNKNOWN) inscrito em warmup automático: ${effectiveQuota}/dia`);
  }

  await upsertSender(phoneNumberId, effectiveQuota);
  return { effectiveQuota, warmupActive };
}

/**
 * Updates the effective daily quota for a sender based on current warmup stage.
 * Called by the quality poller when warmup advances a day.
 */
const TIER_QUOTAS: Record<string, number> = {
  'TIER_250': 250,
  'TIER_1K': 1000,
  'TIER_10K': 10000,
  'TIER_100K': 100000,
  'TIER_UNLIMITED': 999999,
};

/**
 * Computes the warmup-safe send rate (messages/second) for a number.
 * Warmup/UNKNOWN numbers use the daily quota distributed evenly across a 12-hour
 * active sending window, resulting in a conservative, organic pacing profile.
 * Numbers not in warmup return null (caller uses its own speed preset).
 *
 * Example: 250-quota warmup → 250 / (12 * 3600) ≈ 0.0058 msg/s → hard cap enforced.
 */
export async function getWarmupSendRate(phoneNumberId: string, wabaId: string): Promise<number | null> {
  const [activeSchedule] = await db
    .select({ currentDay: warmupSchedules.currentDay, dailyTargets: warmupSchedules.dailyTargets })
    .from(warmupSchedules)
    .where(
      and(
        eq(warmupSchedules.phoneNumberId, phoneNumberId),
        eq(warmupSchedules.wabaId, wabaId),
        eq(warmupSchedules.status, 'active')
      )
    )
    .orderBy(desc(warmupSchedules.createdAt))
    .limit(1);

  if (!activeSchedule) {
    // Check if number is UNKNOWN-rated (new number, no schedule yet)
    const [numRecord] = await db
      .select({ qualityRating: wabaNumbers.qualityRating })
      .from(wabaNumbers)
      .where(eq(wabaNumbers.phoneNumberId, phoneNumberId))
      .limit(1);
    if (!numRecord || numRecord.qualityRating !== 'UNKNOWN') return null;
    // UNKNOWN but no schedule: apply default 250-quota pacing
    const dailyLimit = 250;
    const ACTIVE_WINDOW_SECONDS = 12 * 3600;
    return dailyLimit / ACTIVE_WINDOW_SECONDS;
  }

  const targets = (activeSchedule.dailyTargets as number[]).length > 0
    ? (activeSchedule.dailyTargets as number[])
    : [...WARMUP_STAGES];
  const dayIdx = Math.min(activeSchedule.currentDay - 1, targets.length - 1);
  const dailyLimit = targets[dayIdx];
  // Spread daily quota across 12-hour active window for uniform distribution
  const ACTIVE_WINDOW_SECONDS = 12 * 3600;
  return dailyLimit / ACTIVE_WINDOW_SECONDS;
}

/**
 * Syncs senderUsage.dailyQuota with the current warmup stage limit.
 * When warmup is completed, promotes to the number's real Meta tier limit.
 */
export async function syncWarmupQuota(phoneNumberId: string, wabaId: string): Promise<void> {
  const [activeSchedule] = await db
    .select()
    .from(warmupSchedules)
    .where(
      and(
        eq(warmupSchedules.phoneNumberId, phoneNumberId),
        eq(warmupSchedules.wabaId, wabaId),
        eq(warmupSchedules.status, 'active')
      )
    )
    .orderBy(desc(warmupSchedules.createdAt))
    .limit(1);

  let newQuota: number;
  let logMsg: string;

  if (activeSchedule) {
    const targets = (activeSchedule.dailyTargets as number[]).length > 0
      ? (activeSchedule.dailyTargets as number[])
      : [...WARMUP_STAGES];
    const dayIdx = Math.min(activeSchedule.currentDay - 1, targets.length - 1);
    newQuota = targets[dayIdx];
    logMsg = `Quota de warmup atualizada: ${phoneNumberId} → ${newQuota}/dia (dia ${activeSchedule.currentDay}/${activeSchedule.totalDays})`;
  } else {
    // Warmup completed: promote to real Meta tier limit
    const [numRecord] = await db
      .select({ tier: wabaNumbers.tier })
      .from(wabaNumbers)
      .where(eq(wabaNumbers.phoneNumberId, phoneNumberId))
      .limit(1);

    const tier = numRecord?.tier ?? 'TIER_1K';
    newQuota = TIER_QUOTAS[tier] ?? 1000;
    logMsg = `Warmup finalizado: ${phoneNumberId} promovido ao tier ${tier} → ${newQuota}/dia`;
  }

  const [existing] = await db
    .select({ dailyQuota: senderUsage.dailyQuota })
    .from(senderUsage)
    .where(eq(senderUsage.phoneNumberId, phoneNumberId))
    .limit(1);

  if (existing && existing.dailyQuota !== newQuota) {
    await db
      .update(senderUsage)
      .set({ dailyQuota: newQuota })
      .where(eq(senderUsage.phoneNumberId, phoneNumberId));
    console.log(`[SenderPool] ${logMsg}`);
  }
}
