import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db } from "../db";
import { campaigns } from "@shared/schema";
import { and, lt, isNotNull, inArray } from "drizzle-orm";
import { cleanupCampaignImages } from "../services/imageGenerator";
import { logError } from "../utils/logger";
import { pruneExpiredConfirmations } from "../services/imageStabilityGuard";

const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const CLEANUP_GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;
const BOT_IMAGE_TTL_MS = 10 * 60 * 1000;
const BOT_IMAGE_STALE_STARTUP_MS = 60 * 60 * 1000;

const __dirname_job = path.dirname(fileURLToPath(import.meta.url));
const CAMPAIGN_IMAGES_DIR = path.resolve(__dirname_job, '../../uploads/campaign-images');
const BOT_IMAGES_DIR = path.join(CAMPAIGN_IMAGES_DIR, 'bot');

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function safeUnlink(filePath: string, label?: string): Promise<boolean> {
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (err: any) {
    if (err.code === 'ENOENT') return false;
    logError('imageCleanupJob.safeUnlink', { filePath, label: label || '' }, err);
    return false;
  }
}

async function runBotImageCleanupCycle(maxAgeMs: number = BOT_IMAGE_TTL_MS): Promise<void> {
  try {
    const botDirExists = await fs.promises.access(BOT_IMAGES_DIR).then(() => true).catch(() => false);
    if (!botDirExists) return;

    const files = await fs.promises.readdir(BOT_IMAGES_DIR);
    const now = Date.now();
    let removed = 0;

    for (const file of files) {
      const filePath = path.join(BOT_IMAGES_DIR, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) continue;
        const ageMs = now - Math.max(stat.mtimeMs, stat.atimeMs);
        if (ageMs >= maxAgeMs) {
          const deleted = await safeUnlink(filePath, 'bot-cleanup');
          if (deleted) {
            removed++;
          }
        }
      } catch (fileErr: any) {
        if (fileErr.code !== 'ENOENT') {
          logError('imageCleanupJob.botFile', { file }, fileErr);
        }
      }
    }

    if (removed > 0) {
      console.log(JSON.stringify({
        level: 'info',
        tag: '[MEDIA_CLEANUP_SAFE]',
        event: 'bot_images_removed',
        count: removed,
        maxAgeMinutes: Math.round(maxAgeMs / 60000),
      }));
    }
  } catch (err: any) {
    logError("imageCleanupJob.botCycle", {}, err);
  }
}

async function startupSweep(): Promise<void> {
  try {
    const botDirExists = await fs.promises.access(BOT_IMAGES_DIR).then(() => true).catch(() => false);
    if (!botDirExists) return;

    const files = await fs.promises.readdir(BOT_IMAGES_DIR);
    const now = Date.now();
    let removed = 0;

    for (const file of files) {
      const filePath = path.join(BOT_IMAGES_DIR, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) continue;
        const ageMs = now - Math.max(stat.mtimeMs, stat.atimeMs);
        if (ageMs >= BOT_IMAGE_STALE_STARTUP_MS) {
          const deleted = await safeUnlink(filePath, 'startup-sweep');
          if (deleted) removed++;
        }
      } catch (fileErr: any) {
        if (fileErr.code !== 'ENOENT') {
          logError('imageCleanupJob.startupSweepFile', { file }, fileErr);
        }
      }
    }

    console.log(JSON.stringify({
      level: 'info',
      tag: '[IMAGE_CLEANUP]',
      event: 'startup_sweep_complete',
      filesScanned: files.length,
      staleRemoved: removed,
      staleThresholdMinutes: Math.round(BOT_IMAGE_STALE_STARTUP_MS / 60000),
    }));
  } catch (err: any) {
    logError("imageCleanupJob.startupSweep", {}, err);
  }
}

async function runImageCleanupCycle(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS);
    const finishedCampaigns = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(
        and(
          inArray(campaigns.status, ["completed", "failed", "cancelled"]),
          isNotNull(campaigns.completedAt),
          lt(campaigns.completedAt, cutoff)
        )
      );

    for (const campaign of finishedCampaigns) {
      if (campaign.id === 'bot') continue;
      await cleanupCampaignImages(campaign.id);
    }

    if (finishedCampaigns.length > 0) {
      console.log(JSON.stringify({
        level: 'info',
        tag: '[IMAGE_CLEANUP]',
        event: 'campaign_cleanup_complete',
        campaignsProcessed: finishedCampaigns.length,
      }));
    }

    await runBotImageCleanupCycle();
    await pruneExpiredConfirmations();
  } catch (err: any) {
    logError("imageCleanupJob.cycle", {}, err);
  }
}

export function startImageCleanupJob(): void {
  if (cleanupTimer) return;

  console.log(JSON.stringify({
    level: 'info',
    tag: '[IMAGE_CLEANUP]',
    event: 'job_started',
    intervalMinutes: CLEANUP_INTERVAL_MS / 60000,
    botImageTtlMinutes: BOT_IMAGE_TTL_MS / 60000,
    startupSweepThresholdMinutes: BOT_IMAGE_STALE_STARTUP_MS / 60000,
  }));

  startupSweep().catch(err => logError('imageCleanupJob.startupSweep', {}, err));

  runImageCleanupCycle().catch(err => logError('imageCleanupJob.initialRun', {}, err));
  cleanupTimer = setInterval(() => {
    runImageCleanupCycle().catch(err => logError('imageCleanupJob.periodicRun', {}, err));
  }, CLEANUP_INTERVAL_MS);
}

export function stopImageCleanupJob(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
