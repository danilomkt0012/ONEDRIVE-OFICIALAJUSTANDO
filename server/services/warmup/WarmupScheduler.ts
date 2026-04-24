import { db } from '../../db';
import { phoneWarmupSchedules } from '@shared/schema';
import { eq, sql, lt } from 'drizzle-orm';

const WARMUP_PROGRESSION: number[] = [
  50,    // Day 1
  100,   // Day 2
  200,   // Day 3
  350,   // Day 4
  500,   // Day 5
  700,   // Day 6
  1000,  // Day 7
  1500,  // Day 8
  2000,  // Day 9
  3000,  // Day 10
];

export interface WarmupStatus {
  phoneNumberId: string;
  displayNumber: string | null;
  currentDayLimit: number;
  targetDayLimit: number;
  sentToday: number;
  remaining: number;
  dayNumber: number;
  status: string;
  progressPct: number;
}

function getDayLimit(dayNumber: number, targetLimit: number): number {
  if (dayNumber <= 0) return WARMUP_PROGRESSION[0];
  if (dayNumber > WARMUP_PROGRESSION.length) return targetLimit;
  const scheduled = WARMUP_PROGRESSION[dayNumber - 1];
  return Math.min(scheduled, targetLimit);
}

export async function enrollNumber(
  phoneNumberId: string,
  displayNumber?: string,
  targetDayLimit: number = 1000
): Promise<WarmupStatus> {
  const existing = await db
    .select()
    .from(phoneWarmupSchedules)
    .where(eq(phoneWarmupSchedules.phoneNumberId, phoneNumberId))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    return {
      phoneNumberId: row.phoneNumberId,
      displayNumber: row.displayNumber,
      currentDayLimit: row.currentDayLimit,
      targetDayLimit: row.targetDayLimit,
      sentToday: row.sentToday,
      remaining: Math.max(0, row.currentDayLimit - row.sentToday),
      dayNumber: row.dayNumber,
      status: row.status,
      progressPct: Math.round((row.currentDayLimit / row.targetDayLimit) * 100),
    };
  }

  const initialLimit = getDayLimit(1, targetDayLimit);

  await db.insert(phoneWarmupSchedules).values({
    phoneNumberId,
    displayNumber: displayNumber || null,
    currentDayLimit: initialLimit,
    targetDayLimit,
    sentToday: 0,
    dayNumber: 1,
    status: 'warming',
  });

  console.log(`🔥 Aquecimento iniciado: ${phoneNumberId} → ${initialLimit}/dia (meta: ${targetDayLimit})`);

  return {
    phoneNumberId,
    displayNumber: displayNumber || null,
    currentDayLimit: initialLimit,
    targetDayLimit,
    sentToday: 0,
    remaining: initialLimit,
    dayNumber: 1,
    status: 'warming',
    progressPct: Math.round((initialLimit / targetDayLimit) * 100),
  };
}

export async function incrementSent(phoneNumberId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(phoneWarmupSchedules)
    .where(eq(phoneWarmupSchedules.phoneNumberId, phoneNumberId))
    .limit(1);

  if (rows.length === 0) return true;

  const row = rows[0];
  if (row.status !== 'warming') return true;

  if (row.sentToday >= row.currentDayLimit) {
    console.log(`⏸️ Aquecimento: ${phoneNumberId} atingiu limite diário (${row.currentDayLimit})`);
    return false;
  }

  await db
    .update(phoneWarmupSchedules)
    .set({
      sentToday: sql`${phoneWarmupSchedules.sentToday} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(phoneWarmupSchedules.phoneNumberId, phoneNumberId));

  return true;
}

export async function getWarmupLimit(phoneNumberId: string): Promise<number | null> {
  const rows = await db
    .select()
    .from(phoneWarmupSchedules)
    .where(eq(phoneWarmupSchedules.phoneNumberId, phoneNumberId))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.status !== 'warming') return null;

  return Math.max(0, row.currentDayLimit - row.sentToday);
}

export async function advanceDay(): Promise<number> {
  const rows = await db
    .select()
    .from(phoneWarmupSchedules)
    .where(eq(phoneWarmupSchedules.status, 'warming'));

  let advanced = 0;

  for (const row of rows) {
    const newDay = row.dayNumber + 1;
    const newLimit = getDayLimit(newDay, row.targetDayLimit);
    const isComplete = newLimit >= row.targetDayLimit;

    await db
      .update(phoneWarmupSchedules)
      .set({
        dayNumber: newDay,
        currentDayLimit: newLimit,
        sentToday: 0,
        status: isComplete ? 'completed' : 'warming',
        lastResetAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(phoneWarmupSchedules.phoneNumberId, row.phoneNumberId));

    console.log(`📈 Aquecimento ${row.phoneNumberId}: Dia ${newDay} → ${newLimit}/dia${isComplete ? ' ✅ COMPLETO' : ''}`);
    advanced++;
  }

  return advanced;
}

export async function resetDailyCounts(): Promise<void> {
  await db
    .update(phoneWarmupSchedules)
    .set({
      sentToday: 0,
      lastResetAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(phoneWarmupSchedules.status, 'warming'));
}

export async function getAllSchedules(): Promise<WarmupStatus[]> {
  const rows = await db.select().from(phoneWarmupSchedules);

  return rows.map(row => ({
    phoneNumberId: row.phoneNumberId,
    displayNumber: row.displayNumber,
    currentDayLimit: row.currentDayLimit,
    targetDayLimit: row.targetDayLimit,
    sentToday: row.sentToday,
    remaining: Math.max(0, row.currentDayLimit - row.sentToday),
    dayNumber: row.dayNumber,
    status: row.status,
    progressPct: Math.round((row.currentDayLimit / row.targetDayLimit) * 100),
  }));
}

export async function removeNumber(phoneNumberId: string): Promise<boolean> {
  const result = await db
    .delete(phoneWarmupSchedules)
    .where(eq(phoneWarmupSchedules.phoneNumberId, phoneNumberId));
  return true;
}

export async function getStatus(phoneNumberId: string): Promise<WarmupStatus | null> {
  const rows = await db
    .select()
    .from(phoneWarmupSchedules)
    .where(eq(phoneWarmupSchedules.phoneNumberId, phoneNumberId))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    phoneNumberId: row.phoneNumberId,
    displayNumber: row.displayNumber,
    currentDayLimit: row.currentDayLimit,
    targetDayLimit: row.targetDayLimit,
    sentToday: row.sentToday,
    remaining: Math.max(0, row.currentDayLimit - row.sentToday),
    dayNumber: row.dayNumber,
    status: row.status,
    progressPct: Math.round((row.currentDayLimit / row.targetDayLimit) * 100),
  };
}

export function getProgression(): number[] {
  return [...WARMUP_PROGRESSION];
}
