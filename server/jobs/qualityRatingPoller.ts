import { db } from '../db';
import { qualityRatingHistory, wabas, campaigns, warmupSchedules, senderUsage } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { wabaStorage } from '../wabaStorage';
import { logError } from '../utils/logger';
import { syncWarmupQuota } from '../services/engine/SenderPool';

// Import lazily to avoid circular reference — routes.ts imports this module
async function pauseEngineForCampaign(campaignId: string): Promise<void> {
  try {
    const { pauseActiveEngineForCampaign } = await import('../routes');
    pauseActiveEngineForCampaign(campaignId);
  } catch {
    // Silent — engine may not be in memory
  }
}

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const META_API_VERSION = process.env.META_API_VERSION || 'v25.0';

const WARMUP_STAGES = [250, 500, 1000, 2000, 5000];

let pollerTimer: ReturnType<typeof setInterval> | null = null;

interface PhoneQualityResult {
  quality_rating: string;
  messaging_limit_tier: string | null;
}

async function fetchPhoneQualityFromMeta(
  phoneNumberId: string,
  accessToken: string
): Promise<PhoneQualityResult | null> {
  try {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}?fields=quality_rating,messaging_limit_tier`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, string>;

    const rawTier = data.messaging_limit_tier;
    console.log(`[QualityPoller] ${phoneNumberId} — raw messaging_limit_tier="${rawTier ?? '(ausente)'}"`);

    const VALID_TIERS = new Set(['TIER_250', 'TIER_1K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED']);
    let resolvedTier: string | null = null;

    if (!rawTier) {
      console.warn(`[QualityPoller] ${phoneNumberId} — messaging_limit_tier ausente/falsy na resposta da Meta. Mantendo tier atual do banco.`);
    } else if (!VALID_TIERS.has(rawTier)) {
      logError('qualityPoller.invalidTier', { phoneNumberId, rawTier }, new Error(`Tier inválido recebido da Meta: "${rawTier}". Mantendo tier atual do banco.`));
    } else {
      resolvedTier = rawTier;
    }

    return {
      quality_rating: data.quality_rating || 'UNKNOWN',
      messaging_limit_tier: resolvedTier,
    };
  } catch (err: unknown) {
    logError('qualityPoller.fetchPhoneQuality', { phoneNumberId }, err instanceof Error ? err : new Error(String(err)));
    return null;
  }
}

async function pauseCampaignsForNumber(phoneNumberId: string): Promise<void> {
  try {
    // Fetch ALL running campaigns (not filtered by wabaId) so that campaigns using
    // this number via a secondary WABA are also caught. Membership is determined
    // by inspecting selectedNumbers for the specific phoneNumberId.
    const runningCampaigns = await db
      .select({ id: campaigns.id, selectedNumbers: campaigns.selectedNumbers })
      .from(campaigns)
      .where(eq(campaigns.status, 'running'));

    for (const campaign of runningCampaigns) {
      const selectedNumbers = (campaign.selectedNumbers as Array<{ phoneNumberId?: string; id?: string }>) || [];
      const usesThisNumber = selectedNumbers.some(
        (n) => n.phoneNumberId === phoneNumberId || n.id === phoneNumberId
      );
      if (usesThisNumber) {
        await db
          .update(campaigns)
          .set({ status: 'paused', updatedAt: new Date() })
          .where(eq(campaigns.id, campaign.id));
        console.log(`[QualityPoller] Campanha ${campaign.id} pausada (DB) — número ${phoneNumberId} ficou RED`);
        // Also pause any active in-memory engine for this campaign
        await pauseEngineForCampaign(campaign.id);
      }
    }
  } catch (err: unknown) {
    logError('qualityPoller.pauseCampaigns', { phoneNumberId }, err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Advances warmup by one day ONLY if the current rating is GREEN or UNKNOWN (zero-reputation, no error),
 * and at least 20 hours have passed since the last advancement.
 * On YELLOW or RED, warmup progression is halted until rating recovers.
 */
async function advanceDailyWarmupIfEligible(phoneNumberId: string, wabaId: string, currentRating: string): Promise<void> {
  if (currentRating === 'RED' || currentRating === 'YELLOW') return;

  try {
    const [schedule] = await db
      .select()
      .from(warmupSchedules)
      .where(
        and(
          eq(warmupSchedules.phoneNumberId, phoneNumberId),
          eq(warmupSchedules.wabaId, wabaId),
          eq(warmupSchedules.status, 'active')
        )
      )
      .limit(1);

    if (!schedule) return;

    const now = new Date();
    const lastUpdated = schedule.updatedAt ? new Date(schedule.updatedAt) : new Date(schedule.startedAt || now);
    const hoursSinceLastAdvance = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastAdvance < 20) return;

    const nextDay = schedule.currentDay + 1;

    if (nextDay > schedule.totalDays) {
      await db
        .update(warmupSchedules)
        .set({ status: 'completed', updatedAt: now })
        .where(eq(warmupSchedules.id, schedule.id));
      console.log(`[QualityPoller] Warmup concluído: ${phoneNumberId} — promovendo ao tier real da conta`);
      await syncWarmupQuota(phoneNumberId, wabaId);
      return;
    }

    await db
      .update(warmupSchedules)
      .set({ currentDay: nextDay, sentToday: 0, updatedAt: now })
      .where(eq(warmupSchedules.id, schedule.id));

    const targets = (schedule.dailyTargets as number[]) || WARMUP_STAGES;
    const newLimit = targets[Math.min(nextDay - 1, targets.length - 1)];
    console.log(`[QualityPoller] Warmup avançado: ${phoneNumberId} → dia ${nextDay}/${schedule.totalDays} (limite: ${newLimit}/dia)`);

    // Sync senderUsage.dailyQuota with the new warmup stage limit
    await syncWarmupQuota(phoneNumberId, wabaId);
  } catch (err: unknown) {
    logError('qualityPoller.advanceDailyWarmup', { phoneNumberId }, err instanceof Error ? err : new Error(String(err)));
  }
}

async function pollWabaList(wabaList: Array<{ id: string; accessToken: string | null; name: string }>): Promise<void> {
  let changeCount = 0;

  for (const waba of wabaList) {
    if (!waba.accessToken) continue;

    try {
      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      if (!numbers || numbers.length === 0) continue;

      for (const num of numbers) {
        try {
          const status = await fetchPhoneQualityFromMeta(num.phoneNumberId, waba.accessToken);
          if (!status) continue;

          const prevRating = num.qualityRating || 'UNKNOWN';
          const newRating = status.quality_rating || 'UNKNOWN';

          // Look up today's sent volume from senderUsage for volume time-series
          const [usage] = await db
            .select({ sentToday: senderUsage.sentToday })
            .from(senderUsage)
            .where(eq(senderUsage.phoneNumberId, num.phoneNumberId))
            .limit(1);
          const sentToday = usage?.sentToday ?? 0;

          // Always record each poll cycle for time-series history (rating + volume)
          await db.insert(qualityRatingHistory).values({
            phoneNumberId: num.phoneNumberId,
            wabaId: waba.id,
            qualityRating: newRating,
            previousRating: prevRating,
            sentCount: sentToday,
          });

          if (prevRating !== newRating) {
            changeCount++;
            console.log(
              `[QualityPoller] ${num.displayNumber || num.phoneNumberId}: ${prevRating} → ${newRating}`
            );
          }

          await wabaStorage.upsertWabaNumber({
            wabaId: waba.id,
            phoneNumberId: num.phoneNumberId,
            displayNumber: num.displayNumber ?? num.phoneNumberId,
            qualityRating: newRating,
            tier: status.messaging_limit_tier,
          });

          if (newRating === 'RED' && prevRating !== 'RED') {
            await pauseCampaignsForNumber(num.phoneNumberId);
          }

          // Advance daily warmup only when GREEN or UNKNOWN (zero-reputation, no active issue)
          await advanceDailyWarmupIfEligible(num.phoneNumberId, waba.id, newRating);
        } catch (numErr: unknown) {
          logError('qualityPoller.pollNumber', { phoneNumberId: num.phoneNumberId }, numErr instanceof Error ? numErr : new Error(String(numErr)));
        }
      }
    } catch (wabaErr: unknown) {
      logError('qualityPoller.pollWaba', { wabaId: waba.id }, wabaErr instanceof Error ? wabaErr : new Error(String(wabaErr)));
    }
  }

  if (changeCount > 0) {
    console.log(`[QualityPoller] Ciclo completo: ${changeCount} mudança(s) de rating detectada(s)`);
  } else {
    console.log(`[QualityPoller] Ciclo completo: nenhuma mudança de rating`);
  }
}

async function pollAllWabas(): Promise<void> {
  try {
    const allWabas = await db.select().from(wabas);
    if (allWabas.length === 0) return;
    await pollWabaList(allWabas);
  } catch (err: unknown) {
    logError('qualityPoller.pollAllWabas', {}, err instanceof Error ? err : new Error(String(err)));
  }
}

export function startQualityRatingPoller(): void {
  if (pollerTimer) return;

  console.log(
    `[QualityPoller] Iniciando polling de Quality Rating a cada ${POLL_INTERVAL_MS / 60000} minutos`
  );

  setTimeout(() => {
    pollAllWabas().catch((err: unknown) => logError('qualityPoller.initialPoll', {}, err instanceof Error ? err : new Error(String(err))));
  }, 30000);

  pollerTimer = setInterval(() => {
    pollAllWabas().catch((err: unknown) => logError('qualityPoller.scheduledPoll', {}, err instanceof Error ? err : new Error(String(err))));
  }, POLL_INTERVAL_MS);
}

export function stopQualityRatingPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log('[QualityPoller] Polling de Quality Rating parado');
  }
}

export function triggerQualityPoll(): Promise<void> {
  return pollAllWabas();
}

export async function triggerQualityPollForUser(userId: string): Promise<void> {
  try {
    const userWabas = await wabaStorage.getWabasByUser(userId);
    if (userWabas.length === 0) return;
    await pollWabaList(userWabas);
  } catch (err: unknown) {
    logError('qualityPoller.pollForUser', { userId }, err instanceof Error ? err : new Error(String(err)));
  }
}
