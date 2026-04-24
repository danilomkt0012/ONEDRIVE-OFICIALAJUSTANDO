import { audioStitchingService } from './AudioStitchingService';
import { audioCacheService } from './AudioCacheService';
import { db } from '../../db';
import { ttsJobProgress, voiceProfiles } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { logError } from '../../utils/logger';

const MAX_CONCURRENT_JOBS = 2;
const JOB_TIMEOUT_MS = 90_000;

export interface TtsJobConfig {
  template: string;
  variables?: Record<string, string>;
  voiceProfileId: string;
  speed?: number;
  pitch?: number;
  volume?: number;
  pauseLevel?: number;
  expressiveness?: number;
  humanize?: boolean;
  leadId?: string;
  campaignId?: string;
}

interface Job {
  id: string;
  config: TtsJobConfig;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  settled: boolean;
  createdAt: number;
}

class TtsQueue {
  private queue: Job[] = [];
  private running = 0;

  enqueue(config: TtsJobConfig): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.queue.push({ id: jobId, config, resolve, reject, settled: false, createdAt: Date.now() });
      this.drain();
    });
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT_JOBS && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      this.runJob(job).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  private settle(job: Job, buffer?: Buffer, err?: Error): void {
    if (job.settled) return;
    job.settled = true;
    if (err) {
      job.reject(err);
    } else {
      job.resolve(buffer!);
    }
  }

  private async runJob(job: Job): Promise<void> {
    const jobStartMs = Date.now();
    console.log(`[TTS_JOB_START] jobId=${job.id} voiceProfileId=${job.config.voiceProfileId} template=${job.config.template.slice(0, 60)} queue_pending=${this.queue.length} active=${this.running}`);
    try {
      const profile = await this.getVoiceProfile(job.config.voiceProfileId);
      if (!profile) {
        throw new Error(`Perfil de voz não encontrado: ${job.config.voiceProfileId}`);
      }

      const generationPromise = audioStitchingService.generateForLead({
        template: job.config.template,
        variables: job.config.variables ?? {},
        referenceWavPath: profile.referenceAudioPath,
        voiceProfileId: job.config.voiceProfileId,
        speed: job.config.speed ?? 1.0,
        humanize: job.config.humanize ?? false,
        pitch: job.config.pitch ?? 1.0,
        volume: job.config.volume ?? 1.0,
        pauseLevel: job.config.pauseLevel ?? 1,
      });

      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`TTS job timeout após ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS);
      });

      try {
        var buffer = await Promise.race([generationPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutHandle!);
      }

      this.settle(job, buffer);

      if (job.config.campaignId && job.config.leadId) {
        let audioPath: string | undefined;
        try {
          const resolvedText = this.resolveTemplate(job.config.template, job.config.variables ?? {});
          const cacheKey = `tts:${job.config.voiceProfileId}:${resolvedText}`;
          const hash = audioCacheService.buildHash(resolvedText, job.config.voiceProfileId, {
            speed: String(job.config.speed ?? 1.0),
            pitch: String(job.config.pitch ?? 1.0),
            volume: String(job.config.volume ?? 1.0),
          });
          audioPath = await audioCacheService.set(hash, buffer, job.config.voiceProfileId, cacheKey, false);
        } catch (err) {
          logError('TtsQueue.cacheSet', { jobId: job.id, voiceProfileId: job.config.voiceProfileId }, err);
          audioPath = undefined;
        }
        await this.updateJobProgress(job.config.campaignId, job.config.leadId, 'done', undefined, audioPath);
      }
      console.log(`[TTS_JOB_DONE] jobId=${job.id} voiceProfileId=${job.config.voiceProfileId} elapsed_ms=${Date.now() - jobStartMs} result=success output_bytes=${buffer.length}`);
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.settle(job, undefined, error);
      console.log(`[TTS_JOB_DONE] jobId=${job.id} voiceProfileId=${job.config.voiceProfileId} elapsed_ms=${Date.now() - jobStartMs} result=fail error=${error.message.slice(0, 100)}`);
      logError('TtsQueue.runJob', { jobId: job.id, voiceProfileId: job.config.voiceProfileId }, error);

      if (job.config.campaignId && job.config.leadId) {
        await this.updateJobProgress(job.config.campaignId, job.config.leadId, 'failed', error.message, undefined);
      }
    }
  }

  private async getVoiceProfile(id: string) {
    const [profile] = await db.select().from(voiceProfiles).where(eq(voiceProfiles.id, id));
    return profile ?? null;
  }

  private async updateJobProgress(
    campaignId: string,
    leadId: string,
    status: string,
    errorMessage: string | undefined,
    audioPath: string | undefined
  ): Promise<void> {
    try {
      const [existing] = await db.select().from(ttsJobProgress)
        .where(and(eq(ttsJobProgress.campaignId, campaignId), eq(ttsJobProgress.leadId, leadId)));

      if (existing) {
        await db.update(ttsJobProgress)
          .set({
            status,
            errorMessage: errorMessage ?? null,
            audioPath: audioPath ?? existing.audioPath,
            updatedAt: new Date(),
          })
          .where(eq(ttsJobProgress.id, existing.id));
      } else {
        await db.insert(ttsJobProgress).values({
          campaignId,
          leadId,
          status,
          errorMessage: errorMessage ?? null,
          audioPath: audioPath ?? null,
        });
      }
    } catch (err) {
      logError('TtsQueue.updateJobProgress', { campaignId, leadId }, err);
    }
  }

  private resolveTemplate(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.running;
  }
}

export const ttsQueue = new TtsQueue();
