import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from '../db';
import { ttsAudioCache } from '@shared/schema';
import { lt, sql } from 'drizzle-orm';
import { logError } from '../utils/logger';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TEMP_FILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

async function cleanOrphanedTempFiles(): Promise<number> {
  let cleaned = 0;
  try {
    const tmpDir = os.tmpdir();
    const files = await fs.promises.readdir(tmpDir);
    const now = Date.now();

    for (const file of files) {
      if (!file.startsWith('tts_')) continue;
      const filePath = path.join(tmpDir, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
          await fs.promises.unlink(filePath);
          cleaned++;
        }
      } catch (err) {
        logError('ttsCleanupJob.statOrUnlinkTempFile', { filePath }, err);
      }
    }
  } catch (err) {
    logError('ttsCleanupJob.cleanOrphanedTempFiles', {}, err);
  }
  return cleaned;
}

async function runTtsCleanup(): Promise<void> {
  try {
    const expired = await db
      .select()
      .from(ttsAudioCache)
      .where(
        lt(
          ttsAudioCache.lastUsedAt,
          sql`NOW() - (${ttsAudioCache.ttlDays} || ' days')::interval`
        )
      );

    let removed = 0;
    const ids: string[] = [];

    for (const row of expired) {
      if (fs.existsSync(row.filePath)) {
        try {
          await fs.promises.unlink(row.filePath);
          removed++;
        } catch (e) {
          logError('ttsCleanupJob.unlinkFile', { filePath: row.filePath }, e);
        }
      }
      ids.push(row.id);
    }

    if (ids.length > 0) {
      for (const id of ids) {
        await db.delete(ttsAudioCache).where(sql`id = ${id}`);
      }
    }

    const orphanedCleaned = await cleanOrphanedTempFiles();

    if (removed > 0 || ids.length > 0 || orphanedCleaned > 0) {
      console.log(`[TTS_CLEANUP] Removed ${removed} cached files, ${ids.length} cache records, ${orphanedCleaned} orphaned temp files`);
    }
  } catch (err) {
    logError('ttsCleanupJob.runTtsCleanup', {}, err);
  }
}

export function startTtsCleanupJob(): void {
  runTtsCleanup().catch(err => logError('ttsCleanupJob.initialRun', {}, err));
  setInterval(() => {
    runTtsCleanup().catch(err => logError('ttsCleanupJob.scheduledRun', {}, err));
  }, CLEANUP_INTERVAL_MS).unref?.();
  console.log('[TTS_CLEANUP] TTL cleanup job started (interval: 24h, orphan temp cleanup included)');
}
