import axios, { AxiosError } from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logError } from '../../utils/logger';

const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL || 'http://localhost:5500';

const GENERATE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 2_000;
const SELF_TEST_TIMEOUT_MS = 90_000;

export class TtsUnavailableError extends Error {
  readonly code = 'TTS_UNAVAILABLE';
  constructor(reason: string) {
    super(`Serviço TTS indisponível: ${reason}`);
    this.name = 'TtsUnavailableError';
  }
}

export class TtsStepError extends Error {
  readonly step: string;
  readonly details: any;
  constructor(step: string, message: string, details?: any) {
    super(message);
    this.name = 'TtsStepError';
    this.step = step;
    this.details = details ?? null;
  }
}

export interface TtsGenerateConfig {
  text: string;
  referenceWavPath: string;
  language?: string;
  speed?: number;
  voiceProfileId?: string;
  templateId?: string;
  messageId?: string;
}

export class TtsService {
  async generate(config: TtsGenerateConfig): Promise<Buffer> {
    const { text, referenceWavPath, language = 'pt', speed = 1.0 } = config;
    const genStartMs = Date.now();

    const voiceId = config.voiceProfileId ?? 'unknown';
    const tplId = config.templateId ?? 'unknown';
    const msgId = config.messageId ?? 'unknown';
    const logCtx = { voiceProfileId: voiceId, templateId: tplId, messageId: msgId };

    if (!text?.trim()) {
      const err = new TtsStepError('validation', 'Texto para TTS não pode estar vazio', { field: 'text' });
      console.error(`[TTS_GENERATE_VALIDATION_FAIL] step=text_empty`, logCtx);
      logError('TtsService.generate.validateText', logCtx, err);
      throw err;
    }
    if (!fs.existsSync(referenceWavPath)) {
      const err = new TtsStepError('validation', `Arquivo de referência não encontrado: ${referenceWavPath}`, { field: 'referenceWavPath', path: referenceWavPath });
      console.error(`[TTS_GENERATE_VALIDATION_FAIL] step=ref_missing ref=${referenceWavPath}`, logCtx);
      logError('TtsService.generate.validateRef', { ...logCtx, referenceWavPath }, err);
      throw err;
    }

    const tmpDir = os.tmpdir();
    try {
      fs.accessSync(tmpDir, fs.constants.W_OK);
    } catch (accessErr) {
      const err = new TtsStepError('validation', `Temp directory not writable: ${tmpDir}`, { tmpDir });
      console.error(`[TTS_GENERATE_VALIDATION_FAIL] step=tmpdir_access tmpDir=${tmpDir}`, logCtx);
      logError('TtsService.generate.validateTmpDir', { ...logCtx, tmpDir }, err);
      throw err;
    }

    console.log(`[TTS_GENERATE_START] text_len=${text.length} language=${language} speed=${speed} voiceProfileId=${voiceId} templateId=${tplId} messageId=${msgId} ref=${referenceWavPath.slice(-30)}`);

    let lastError: Error = new Error('unknown');

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[TTS_GENERATE_ATTEMPT] attempt=${attempt} text_len=${text.length} voiceProfileId=${voiceId}`);
        const response = await axios.post(
          `${TTS_SERVICE_URL}/generate`,
          { text, reference_wav_path: referenceWavPath, language, speed },
          {
            timeout: GENERATE_TIMEOUT_MS,
            responseType: 'arraybuffer',
            headers: { 'Content-Type': 'application/json' },
          }
        );
        const buf = Buffer.from(response.data);
        if (buf.length === 0) {
          const zeroErr = new TtsStepError('buffer_processing', 'TTS generation returned zero-byte audio output', { attempt, textLen: text.length });
          console.error(`[TTS_GENERATE_ZERO_BYTES] attempt=${attempt} text_len=${text.length} elapsed_ms=${Date.now() - genStartMs} voiceProfileId=${voiceId}`);
          logError('TtsService.generate.zeroBytes', { ...logCtx, attempt }, zeroErr);
          throw zeroErr;
        }
        console.log(`[TTS_GENERATE_DONE] text_len=${text.length} attempt=${attempt} elapsed_ms=${Date.now() - genStartMs} output_bytes=${buf.length} result=success voiceProfileId=${voiceId} templateId=${tplId} messageId=${msgId}`);
        return buf;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const axiosErr = err as AxiosError;
        const isUnavailable =
          axiosErr.code === 'ECONNREFUSED' ||
          axiosErr.code === 'ENOTFOUND' ||
          axiosErr.code === 'ECONNRESET';
        const isTimeout =
          axiosErr.code === 'ETIMEDOUT' ||
          axiosErr.code === 'ECONNABORTED' ||
          axiosErr.response?.status === 408 ||
          axiosErr.response?.status === 504;
        const isQueueFull = axiosErr.response?.status === 503;

        if (isUnavailable) {
          console.error(`[TTS_GENERATE_UNAVAILABLE] attempt=${attempt} text_len=${text.length} elapsed_ms=${Date.now() - genStartMs} code=${axiosErr.code} voiceProfileId=${voiceId}`);
          logError('TtsService.generate.unavailable', { ...logCtx, attempt, code: axiosErr.code }, lastError);
          const stepErr = new TtsStepError('generation_call', 'microserviço Python não está respondendo', { code: axiosErr.code, attempt });
          throw stepErr;
        }

        if (isQueueFull) {
          console.error(`[TTS_GENERATE_QUEUE_FULL] attempt=${attempt} text_len=${text.length} elapsed_ms=${Date.now() - genStartMs} voiceProfileId=${voiceId}`);
          logError('TtsService.generate.queueFull', { ...logCtx, attempt }, lastError);
          const stepErr = new TtsStepError('generation_call', 'fila de geração TTS está cheia', { attempt });
          throw stepErr;
        }

        if (isTimeout) {
          console.error(`[TTS_GENERATE_TIMEOUT] attempt=${attempt} text_len=${text.length} elapsed_ms=${Date.now() - genStartMs} timeout_ms=${GENERATE_TIMEOUT_MS} voiceProfileId=${voiceId}`);
          logError('TtsService.generate.timeout', { ...logCtx, attempt, textLen: text.length, elapsedMs: Date.now() - genStartMs, timeoutMs: GENERATE_TIMEOUT_MS }, lastError);
          if (attempt === 2) {
            const stepErr = new TtsStepError('generation_call', `timeout na geração de áudio TTS após ${GENERATE_TIMEOUT_MS / 1000}s (text_len=${text.length})`, { attempt, timeoutMs: GENERATE_TIMEOUT_MS });
            throw stepErr;
          }
        }

        if (attempt < 2) {
          logError('TtsService.generate.retry', { ...logCtx, attempt, text: text.slice(0, 50) }, lastError);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }

    const detail = _extractDetail(lastError as AxiosError);
    console.error(`[TTS_GENERATE_DONE] text_len=${text.length} elapsed_ms=${Date.now() - genStartMs} result=fail voiceProfileId=${voiceId} templateId=${tplId} messageId=${msgId} error=${detail.slice(0, 200)}`);
    logError('TtsService.generate.finalFailure', { ...logCtx, text: text.slice(0, 50), elapsedMs: Date.now() - genStartMs }, lastError);
    throw new TtsStepError('generation_call', `Falha na geração TTS: ${detail}`, { elapsedMs: Date.now() - genStartMs });
  }

  async checkHealth(): Promise<{
    available: boolean;
    modelLoaded: boolean;
    modelLoading: boolean;
    memoryMb?: number;
    uptimeS?: number;
    queue?: { active: number; pending: number };
    error?: string;
  }> {
    const healthStartMs = Date.now();
    console.log(`[TTS_HEALTH_CHECK_START] url=${TTS_SERVICE_URL}/health`);
    try {
      const response = await axios.get(`${TTS_SERVICE_URL}/health`, {
        timeout: HEALTH_TIMEOUT_MS,
      });
      const d = response.data;
      const result: {
        available: boolean;
        modelLoaded: boolean;
        modelLoading: boolean;
        memoryMb?: number;
        uptimeS?: number;
        queue?: { active: number; pending: number };
        error?: string;
      } = {
        available: true,
        modelLoaded: d?.model_loaded === true,
        modelLoading: d?.model_loading === true,
        memoryMb: d?.memory_rss_mb,
        uptimeS: d?.uptime_s,
        queue: d?.queue,
      };
      if (d?.error) {
        result.error = d.error;
      }
      console.log(`[TTS_HEALTH_CHECK_DONE] elapsed_ms=${Date.now() - healthStartMs} available=true modelLoaded=${result.modelLoaded} modelLoading=${result.modelLoading} memoryMb=${result.memoryMb} uptimeS=${result.uptimeS}`);
      return result;
    } catch (err) {
      console.error(`[TTS_HEALTH_CHECK_DONE] elapsed_ms=${Date.now() - healthStartMs} available=false`);
      logError('TtsService.checkHealth', { url: `${TTS_SERVICE_URL}/health`, elapsedMs: Date.now() - healthStartMs }, err);
      return { available: false, modelLoaded: false, modelLoading: false, error: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async runSelfTest(): Promise<{ ok: boolean; detail: string; audioBytes?: number; elapsedMs?: number }> {
    const testStartMs = Date.now();
    const selfTestWavPath = path.join(os.tmpdir(), `tts_self_test_ref_node_${process.pid}_${Date.now()}.wav`);
    console.log(`[TTS_SELF_TEST_START] url=${TTS_SERVICE_URL}/generate refPath=${selfTestWavPath}`);

    const cleanup = () => {
      try { if (fs.existsSync(selfTestWavPath)) fs.unlinkSync(selfTestWavPath); } catch {}
    };

    try {
      const health = await this.checkHealth();
      if (!health.available) {
        const msg = `Self-test skipped: TTS service not available`;
        console.warn(`[TTS_SELF_TEST_DONE] elapsed_ms=${Date.now() - testStartMs} result=skipped reason=service_unavailable`);
        console.log(`[TTS_SELF_TEST_SUMMARY] Diagnostic self-test SKIPPED (service unavailable). The TTS service will be available for real requests once the microservice starts.`);
        return { ok: false, detail: msg };
      }
      if (!health.modelLoaded) {
        const msg = `Self-test skipped: TTS model not loaded`;
        console.warn(`[TTS_SELF_TEST_DONE] elapsed_ms=${Date.now() - testStartMs} result=skipped reason=model_not_loaded`);
        console.log(`[TTS_SELF_TEST_SUMMARY] Diagnostic self-test SKIPPED (model not loaded). The TTS service will be available once the model finishes loading.`);
        return { ok: false, detail: msg };
      }

      _writeSpeechLikeWav(selfTestWavPath);
      console.log(`[TTS_SELF_TEST] Created speech-like reference WAV at ${selfTestWavPath} (3s, 22050Hz)`);

      const testPayload = {
        text: 'Teste.',
        reference_wav_path: selfTestWavPath,
        language: 'pt',
        speed: 1.0,
      };

      const response = await axios.post(
        `${TTS_SERVICE_URL}/generate`,
        testPayload,
        { timeout: SELF_TEST_TIMEOUT_MS, responseType: 'arraybuffer', headers: { 'Content-Type': 'application/json' }, validateStatus: () => true }
      );

      const elapsedMs = Date.now() - testStartMs;
      if (response.status >= 200 && response.status < 300) {
        const size = Buffer.from(response.data).length;
        if (size > 0) {
          console.log(`[TTS_SELF_TEST_DONE] elapsed_ms=${elapsedMs} result=success status=${response.status} output_bytes=${size}`);
          console.log(`[TTS_SELF_TEST_SUMMARY] Diagnostic self-test PASSED. TTS service is fully operational.`);
          return { ok: true, detail: `Self-test passed: ${size} bytes in ${elapsedMs}ms`, audioBytes: size, elapsedMs };
        } else {
          console.warn(`[TTS_SELF_TEST_DONE] elapsed_ms=${elapsedMs} result=fail status=${response.status} output_bytes=0 reason=empty_output`);
          console.log(`[TTS_SELF_TEST_SUMMARY] Diagnostic self-test FAILED (empty output). This is a startup diagnostic only — the TTS service is still available for real requests with user-provided voice references.`);
          return { ok: false, detail: `Self-test failed: received 200 but output is empty` };
        }
      } else {
        let detail: string;
        try {
          const body = Buffer.from(response.data).toString();
          detail = JSON.parse(body)?.detail ?? body;
        } catch (parseErr) {
          logError('TtsService.runSelfTest.parseResponse', { status: response.status }, parseErr);
          detail = `HTTP ${response.status} (response body not parseable)`;
        }
        console.warn(`[TTS_SELF_TEST_DONE] elapsed_ms=${elapsedMs} result=fail status=${response.status} detail=${detail.slice(0, 200)}`);
        console.log(`[TTS_SELF_TEST_SUMMARY] Diagnostic self-test FAILED. This is a startup diagnostic only — the TTS service is still available for real requests with user-provided voice references.`);
        return { ok: false, detail: `Self-test failed: HTTP ${response.status} — ${detail}` };
      }
    } catch (err: any) {
      const elapsedMs = Date.now() - testStartMs;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[TTS_SELF_TEST_DONE] elapsed_ms=${elapsedMs} result=error error=${msg.slice(0, 200)}`);
      logError('TtsService.runSelfTest', { elapsedMs }, err);
      console.log(`[TTS_SELF_TEST_SUMMARY] Diagnostic self-test FAILED (error). This is a startup diagnostic only — the TTS service is still available for real requests with user-provided voice references.`);
      return { ok: false, detail: `Self-test error: ${msg}` };
    } finally {
      cleanup();
    }
  }
}

function _writeSpeechLikeWav(filePath: string): void {
  const sampleRate = 22050;
  const numChannels = 1;
  const bitsPerSample = 16;
  const durationSec = 3;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  const formants = [250.0, 700.0, 2500.0, 3500.0];
  let rngState = 42;
  const pseudoRandom = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return (rngState / 0x7fffffff) * 2.0 - 1.0;
  };

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = 0.6 + 0.4 * Math.sin(2.0 * Math.PI * 3.0 * t);
    const pitch = 120.0 + 30.0 * Math.sin(2.0 * Math.PI * 0.5 * t);
    let val = 0.0;
    for (const f of formants) {
      val += Math.sin(2.0 * Math.PI * f * t + pitch * t * 0.01);
    }
    val *= envelope;
    const noise = pseudoRandom() * 0.3;
    val = (val / formants.length + noise) * 0.7;
    const sample = Math.max(-32767, Math.min(32767, Math.round(val * 16000)));
    buf.writeInt16LE(sample, headerSize + i * 2);
  }

  fs.writeFileSync(filePath, buf);
}

function _extractDetail(err: AxiosError): string {
  if (!err.response?.data) return err.message;
  const data = err.response.data;
  if (Buffer.isBuffer(data)) {
    try { return JSON.parse(data.toString())?.detail ?? data.toString(); } catch (e) { console.warn(`[TTS_EXTRACT_DETAIL] Failed to parse response body as JSON: ${(e as Error).message}`); return data.toString(); }
  }
  if (typeof data === 'object') return (data as any)?.detail ?? JSON.stringify(data);
  return String(data);
}

export const ttsService = new TtsService();

(async () => {
  console.log('[TTS_SERVICE_INIT] Waiting for TTS microservice to be ready (polling with backoff)...');

  const CONNECT_TIMEOUT_MS = 300_000;
  const MODEL_LOAD_TIMEOUT_MS = 300_000;
  const INITIAL_DELAY_MS = 3_000;
  const MAX_DELAY_MS = 15_000;
  const startTime = Date.now();
  let delay = INITIAL_DELAY_MS;
  let attempt = 0;
  let firstContactTime: number | null = null;

  while (true) {
    attempt++;
    await new Promise(resolve => setTimeout(resolve, delay));

    const elapsed = Date.now() - startTime;

    if (!firstContactTime && elapsed > CONNECT_TIMEOUT_MS) {
      console.warn(`[TTS_SERVICE_INIT] Microservice not reachable within ${CONNECT_TIMEOUT_MS / 1000}s. Self-test skipped.`);
      break;
    }

    if (firstContactTime && (Date.now() - firstContactTime) > MODEL_LOAD_TIMEOUT_MS) {
      console.warn(`[TTS_SERVICE_INIT] Model did not finish loading within ${MODEL_LOAD_TIMEOUT_MS / 1000}s after first contact. Self-test skipped.`);
      break;
    }

    try {
      const health = await ttsService.checkHealth();

      if (health.available && !firstContactTime) {
        firstContactTime = Date.now();
        console.log(`[TTS_SERVICE_INIT] First contact with microservice after ${Math.round(elapsed / 1000)}s. Model loading timeout starts now (${MODEL_LOAD_TIMEOUT_MS / 1000}s).`);
      }

      if (health.available && health.modelLoaded) {
        console.log(`[TTS_SERVICE_INIT] Microservice ready after ${attempt} poll(s) (${Math.round(elapsed / 1000)}s). Running self-test...`);
        const result = await ttsService.runSelfTest();
        console.log(`[TTS_SERVICE_INIT] Self-test result: ok=${result.ok} detail=${result.detail}`);
        return;
      }

      if (health.available && health.modelLoading) {
        console.log(`[TTS_SERVICE_INIT] Poll ${attempt}: model is loading (available=${health.available}, modelLoading=${health.modelLoading}). Waiting patiently — retrying in ${Math.round(delay / 1000)}s...`);
      } else {
        console.log(`[TTS_SERVICE_INIT] Poll ${attempt}: not ready yet (available=${health.available}, modelLoaded=${health.modelLoaded}). Retrying in ${Math.round(delay / 1000)}s...`);
      }
    } catch (err: any) {
      console.log(`[TTS_SERVICE_INIT] Poll ${attempt}: microservice not reachable yet (${err?.code || err?.message || 'unknown'}). This is expected during startup — retrying in ${Math.round(delay / 1000)}s...`);
    }

    delay = Math.min(delay * 1.5, MAX_DELAY_MS);
  }

  console.warn(`[TTS_SERVICE_INIT] TTS will be attempted on first request.`);
})().catch(err => {
  logError('TtsService.startupSelfTest', {}, err);
});
