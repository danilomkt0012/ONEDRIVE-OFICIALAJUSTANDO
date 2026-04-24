import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../../db';
import { ttsAudioCache } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logError } from '../../utils/logger';

const TTS_CACHE_DIR = path.resolve(process.cwd(), 'uploads/tts-cache');

fs.promises.mkdir(TTS_CACHE_DIR, { recursive: true }).catch((err) => {
  logError('AudioCacheService.mkdirCacheDir', { dir: TTS_CACHE_DIR }, err);
});

export class AudioCacheService {
  buildHash(text: string, voiceProfileId: string, params: Record<string, unknown> = {}): string {
    const payload = JSON.stringify({ text, voiceProfileId, ...params });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  async get(hash: string): Promise<Buffer | null> {
    try {
      const [row] = await db.select().from(ttsAudioCache).where(eq(ttsAudioCache.hash, hash));
      if (!row) return null;

      if (!fs.existsSync(row.filePath)) {
        await db.delete(ttsAudioCache).where(eq(ttsAudioCache.hash, hash));
        return null;
      }

      await db.update(ttsAudioCache)
        .set({ lastUsedAt: new Date() })
        .where(eq(ttsAudioCache.hash, hash));

      return fs.promises.readFile(row.filePath);
    } catch (err) {
      logError('AudioCacheService.get', { hash }, err);
      return null;
    }
  }

  async set(
    hash: string,
    buffer: Buffer,
    voiceProfileId: string,
    textContent: string,
    isFixed = false
  ): Promise<string> {
    const ttlDays = isFixed ? 30 : 7;
    const ext = 'ogg';
    const filePath = path.join(TTS_CACHE_DIR, `${hash}.${ext}`);

    await fs.promises.writeFile(filePath, buffer);

    try {
      const [existing] = await db.select().from(ttsAudioCache).where(eq(ttsAudioCache.hash, hash));
      if (!existing) {
        await db.insert(ttsAudioCache).values({
          hash,
          filePath,
          voiceProfileId,
          textContent: textContent.slice(0, 1000),
          isFixed,
          ttlDays,
          lastUsedAt: new Date(),
        });
      } else {
        await db.update(ttsAudioCache)
          .set({ lastUsedAt: new Date() })
          .where(eq(ttsAudioCache.hash, hash));
      }
    } catch (err) {
      logError('AudioCacheService.set', { hash }, err);
    }

    return filePath;
  }

  async invalidateByVoiceProfileId(voiceProfileId: string): Promise<number> {
    try {
      const rows = await db.select().from(ttsAudioCache).where(eq(ttsAudioCache.voiceProfileId, voiceProfileId));
      if (rows.length === 0) return 0;

      const unlinkPromises = rows.map((row) =>
        fs.promises.unlink(row.filePath).catch(() => {})
      );
      await Promise.all(unlinkPromises);

      await db.delete(ttsAudioCache).where(eq(ttsAudioCache.voiceProfileId, voiceProfileId));

      return rows.length;
    } catch (err) {
      logError('AudioCacheService.invalidateByVoiceProfileId', { voiceProfileId }, err);
      return 0;
    }
  }

  async getFilePath(hash: string): Promise<string | null> {
    try {
      const [row] = await db.select().from(ttsAudioCache).where(eq(ttsAudioCache.hash, hash));
      if (!row || !fs.existsSync(row.filePath)) return null;

      await db.update(ttsAudioCache)
        .set({ lastUsedAt: new Date() })
        .where(eq(ttsAudioCache.hash, hash));

      return row.filePath;
    } catch (err) {
      logError('AudioCacheService.getFilePath', { hash }, err);
      return null;
    }
  }
}

export const audioCacheService = new AudioCacheService();
