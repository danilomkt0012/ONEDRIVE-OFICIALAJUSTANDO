import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { ttsService } from './TtsService';
import { audioCacheService } from './AudioCacheService';
import { textHumanizerService } from './TextHumanizerService';
import { logError } from '../../utils/logger';

function cleanupTmpFile(filePath: string): void {
  fs.promises.unlink(filePath).catch((err) => {
    logError('AudioStitchingService.tmpCleanup', { file: filePath }, err);
  });
}

export interface StitchConfig {
  template: string;
  variables: Record<string, string>;
  referenceWavPath: string;
  voiceProfileId: string;
  speed?: number;
  humanize?: boolean;
  pitch?: number;
  volume?: number;
  pauseLevel?: number;
  expressiveness?: number;
}

interface Segment {
  type: 'fixed' | 'variable';
  content: string;
  variableName?: string;
}

function getFfmpegPath(): string {
  if (ffmpegStatic) return ffmpegStatic;
  return 'ffmpeg';
}

function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /\{\{(\w+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(template)) !== null) {
    if (match.index > lastIndex) {
      const fixed = template.slice(lastIndex, match.index).trim();
      if (fixed) {
        segments.push({ type: 'fixed', content: fixed });
      }
    }
    segments.push({ type: 'variable', content: match[0], variableName: match[1] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < template.length) {
    const fixed = template.slice(lastIndex).trim();
    if (fixed) {
      segments.push({ type: 'fixed', content: fixed });
    }
  }

  return segments;
}

async function generateWavBuffer(
  text: string,
  referenceWavPath: string,
  voiceProfileId: string,
  speed: number,
  isFixed: boolean
): Promise<Buffer> {
  const params = { speed: speed.toFixed(2) };
  const hash = audioCacheService.buildHash(text, voiceProfileId, params);

  const cached = await audioCacheService.get(hash);
  if (cached) return cached;

  const wavBuffer = await ttsService.generate({ text, referenceWavPath, speed, voiceProfileId });

  const oggBuffer = await convertWavToOgg(wavBuffer);

  await audioCacheService.set(hash, oggBuffer, voiceProfileId, text, isFixed);

  return oggBuffer;
}

function buildAudioFilters(pitch: number, volume: number): string[] {
  const filters: string[] = [];
  if (Math.abs(pitch - 1.0) > 0.01) {
    const sampleRate = 48000;
    const shiftedRate = Math.round(sampleRate * pitch);
    filters.push(`asetrate=${shiftedRate},aresample=${sampleRate}`);
  }
  if (Math.abs(volume - 1.0) > 0.01) {
    filters.push(`volume=${volume.toFixed(3)}`);
  }
  return filters;
}

async function convertWavToOgg(wavBuffer: Buffer, pitch = 1.0, volume = 1.0): Promise<Buffer> {
  const convertStartMs = Date.now();
  const tmpWav = path.join(os.tmpdir(), `tts_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  const tmpOgg = tmpWav.replace('.wav', '.ogg');

  console.log(`[TTS_CONVERT_START] step=convertWavToOgg input_bytes=${wavBuffer.length} pitch=${pitch} volume=${volume}`);

  await fs.promises.writeFile(tmpWav, wavBuffer);

  const audioFilters = buildAudioFilters(pitch, volume);
  const filterArgs = audioFilters.length > 0 ? ['-af', audioFilters.join(',')] : [];

  return new Promise((resolve, reject) => {
    let stderrOutput = '';
    const ffmpeg = spawn(getFfmpegPath(), [
      '-i', tmpWav,
      ...filterArgs,
      '-acodec', 'libopus',
      '-f', 'ogg',
      '-y',
      tmpOgg,
    ]);

    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    ffmpeg.on('close', async (code) => {
      cleanupTmpFile(tmpWav);
      if (code !== 0) {
        console.warn(`[TTS_CONVERT_WARN] step=convertWavToOgg ffmpeg exited with code=${code} input_bytes=${wavBuffer.length} elapsed_ms=${Date.now() - convertStartMs} — falling back to raw WAV. stderr=${stderrOutput.slice(-500)}`);
        logError('AudioStitchingService.convertWavToOgg.ffmpegFail', { code, inputBytes: wavBuffer.length }, new Error(`ffmpeg exit code ${code}: ${stderrOutput.slice(-200)}`));
        cleanupTmpFile(tmpOgg);
        resolve(wavBuffer);
        return;
      }
      try {
        const stat = await fs.promises.stat(tmpOgg);
        if (stat.size === 0) {
          console.warn(`[TTS_CONVERT_WARN] step=convertWavToOgg output file is empty input_bytes=${wavBuffer.length} elapsed_ms=${Date.now() - convertStartMs}`);
          logError('AudioStitchingService.convertWavToOgg.emptyOutput', { inputBytes: wavBuffer.length }, new Error('ffmpeg produced empty output'));
          cleanupTmpFile(tmpOgg);
          resolve(wavBuffer);
          return;
        }
        const buf = await fs.promises.readFile(tmpOgg);
        console.log(`[TTS_CONVERT_DONE] step=convertWavToOgg input_bytes=${wavBuffer.length} output_bytes=${buf.length} elapsed_ms=${Date.now() - convertStartMs} result=success`);
        cleanupTmpFile(tmpOgg);
        resolve(buf);
      } catch (e) {
        logError('AudioStitchingService.convertWavToOgg.readOutput', { tmpOgg }, e);
        reject(e);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[TTS_CONVERT_ERROR] step=convertWavToOgg spawn error input_bytes=${wavBuffer.length} elapsed_ms=${Date.now() - convertStartMs} error=${err.message}`);
      logError('AudioStitchingService.convertWavToOgg.spawnError', { inputBytes: wavBuffer.length }, err);
      cleanupTmpFile(tmpWav);
      cleanupTmpFile(tmpOgg);
      resolve(wavBuffer);
    });
  });
}

async function concatenateOggFiles(filePaths: string[]): Promise<Buffer> {
  const concatStartMs = Date.now();
  console.log(`[TTS_CONCAT_START] step=concatenateOggFiles file_count=${filePaths.length}`);

  if (filePaths.length === 0) {
    const err = new Error('Nenhum arquivo para concatenar');
    logError('AudioStitchingService.concatenateOggFiles.empty', { count: 0 }, err);
    throw err;
  }
  if (filePaths.length === 1) {
    const buf = await fs.promises.readFile(filePaths[0]);
    console.log(`[TTS_CONCAT_DONE] step=concatenateOggFiles file_count=1 output_bytes=${buf.length} elapsed_ms=${Date.now() - concatStartMs} result=single_file`);
    return buf;
  }

  const listFile = path.join(os.tmpdir(), `tts_list_${Date.now()}.txt`);
  const outFile = path.join(os.tmpdir(), `tts_concat_${Date.now()}.ogg`);

  const listContent = filePaths.map(f => `file '${f}'`).join('\n');
  await fs.promises.writeFile(listFile, listContent);

  return new Promise((resolve, reject) => {
    let stderrOutput = '';
    const ffmpeg = spawn(getFfmpegPath(), [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-acodec', 'libopus',
      '-f', 'ogg',
      '-y',
      outFile,
    ]);

    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    ffmpeg.on('close', async (code) => {
      cleanupTmpFile(listFile);
      if (code !== 0) {
        const err = new Error(`FFmpeg concat exited with code ${code}: ${stderrOutput.slice(-200)}`);
        console.error(`[TTS_CONCAT_ERROR] step=concatenateOggFiles code=${code} file_count=${filePaths.length} elapsed_ms=${Date.now() - concatStartMs} stderr=${stderrOutput.slice(-300)}`);
        logError('AudioStitchingService.concatenateOggFiles.ffmpegFail', { code, fileCount: filePaths.length }, err);
        cleanupTmpFile(outFile);
        reject(err);
        return;
      }
      try {
        const buf = await fs.promises.readFile(outFile);
        console.log(`[TTS_CONCAT_DONE] step=concatenateOggFiles file_count=${filePaths.length} output_bytes=${buf.length} elapsed_ms=${Date.now() - concatStartMs} result=success`);
        cleanupTmpFile(outFile);
        resolve(buf);
      } catch (e) {
        logError('AudioStitchingService.concatenateOggFiles.readOutput', { outFile }, e);
        reject(e);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[TTS_CONCAT_ERROR] step=concatenateOggFiles spawn error file_count=${filePaths.length} elapsed_ms=${Date.now() - concatStartMs} error=${err.message}`);
      logError('AudioStitchingService.concatenateOggFiles.spawnError', { fileCount: filePaths.length }, err);
      reject(err);
    });
  });
}

export class AudioStitchingService {
  async generateForLead(config: StitchConfig): Promise<Buffer> {
    const stitchStartMs = Date.now();
    const {
      template, variables, referenceWavPath, voiceProfileId,
      speed = 1.0, humanize = false,
      pitch = 1.0, volume = 1.0,
      pauseLevel = 1,
    } = config;

    console.log(`[TTS_STITCH_START] step=generateForLead voiceProfileId=${voiceProfileId} template=${template.slice(0, 60)} speed=${speed} humanize=${humanize} pitch=${pitch} volume=${volume}`);

    if (!fs.existsSync(referenceWavPath)) {
      const err = new Error(`Reference audio not found on disk: ${referenceWavPath}`);
      console.error(`[TTS_STITCH_VALIDATION_FAIL] step=generateForLead.refCheck voiceProfileId=${voiceProfileId} refPath=${referenceWavPath}`);
      logError('AudioStitchingService.generateForLead.refCheck', { voiceProfileId, referenceWavPath }, err);
      throw err;
    }

    const clampedPitch = Math.max(0.5, Math.min(2.0, pitch));
    const clampedVolume = Math.max(0.1, Math.min(2.0, volume));

    const applyPause = (text: string): string => {
      if (pauseLevel <= 0) return text;
      const pauseChar = pauseLevel >= 3 ? '... ' : pauseLevel === 2 ? '.. ' : ', ';
      return text.replace(/([.!?])\s+/g, `$1${pauseChar}`);
    };

    const segments = parseTemplate(template);

    if (segments.length === 0) {
      const err = new Error('Template vazio — não é possível gerar áudio');
      logError('AudioStitchingService.generateForLead.emptyTemplate', { voiceProfileId }, err);
      throw err;
    }

    const hasVariables = segments.some(s => s.type === 'variable');
    console.log(`[TTS_STITCH_PARSED] step=generateForLead segment_count=${segments.length} has_variables=${hasVariables} voiceProfileId=${voiceProfileId}`);

    if (!hasVariables) {
      let text = template;
      if (humanize) text = textHumanizerService.humanize(text);
      if (pauseLevel > 0) text = applyPause(text);

      const hash = audioCacheService.buildHash(text, voiceProfileId, { speed: speed.toFixed(2), pitch: clampedPitch.toFixed(2), volume: clampedVolume.toFixed(2) });
      const cachedPath = await audioCacheService.getFilePath(hash);
      if (cachedPath) {
        const buf = await fs.promises.readFile(cachedPath);
        console.log(`[TTS_STITCH_DONE] step=generateForLead voiceProfileId=${voiceProfileId} elapsed_ms=${Date.now() - stitchStartMs} result=cache_hit output_bytes=${buf.length}`);
        return buf;
      }

      const wavBuf = await ttsService.generate({ text, referenceWavPath, speed, voiceProfileId });
      const buf = await convertWavToOgg(wavBuf, clampedPitch, clampedVolume);
      await audioCacheService.set(hash, buf, voiceProfileId, text, true);
      console.log(`[TTS_STITCH_DONE] step=generateForLead voiceProfileId=${voiceProfileId} elapsed_ms=${Date.now() - stitchStartMs} result=generated output_bytes=${buf.length}`);
      return buf;
    }

    const tmpSegmentFiles: string[] = [];

    try {
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        let text: string;
        let isFixed: boolean;

        if (segment.type === 'fixed') {
          text = segment.content;
          isFixed = true;
        } else {
          const varName = segment.variableName!;
          text = variables[varName] || variables[varName.toLowerCase()] || varName;
          isFixed = false;
        }

        if (!text.trim()) continue;

        if (humanize) text = textHumanizerService.humanize(text);
        if (pauseLevel > 0) text = applyPause(text);

        const params = { speed: speed.toFixed(2), pitch: clampedPitch.toFixed(2), volume: clampedVolume.toFixed(2) };
        const hash = audioCacheService.buildHash(text, voiceProfileId, params);

        let filePath = await audioCacheService.getFilePath(hash);

        if (!filePath) {
          console.log(`[TTS_STITCH_SEGMENT] step=generateForLead segment=${i + 1}/${segments.length} type=${segment.type} text_len=${text.length} voiceProfileId=${voiceProfileId} cached=false`);
          const wavBuf = await ttsService.generate({ text, referenceWavPath, speed, voiceProfileId });
          const oggBuf = await convertWavToOgg(wavBuf, clampedPitch, clampedVolume);
          filePath = await audioCacheService.set(hash, oggBuf, voiceProfileId, text, isFixed);
        } else {
          console.log(`[TTS_STITCH_SEGMENT] step=generateForLead segment=${i + 1}/${segments.length} type=${segment.type} text_len=${text.length} voiceProfileId=${voiceProfileId} cached=true`);
        }

        tmpSegmentFiles.push(filePath);
      }

      if (tmpSegmentFiles.length === 0) {
        const err = new Error('Nenhum segmento de áudio gerado');
        logError('AudioStitchingService.generateForLead.noSegments', { voiceProfileId, template: template.slice(0, 50) }, err);
        throw err;
      }

      const result = await concatenateOggFiles(tmpSegmentFiles);
      console.log(`[TTS_STITCH_DONE] step=generateForLead voiceProfileId=${voiceProfileId} elapsed_ms=${Date.now() - stitchStartMs} result=stitched segments=${tmpSegmentFiles.length} output_bytes=${result.length}`);
      return result;
    } catch (err) {
      console.error(`[TTS_STITCH_ERROR] step=generateForLead voiceProfileId=${voiceProfileId} elapsed_ms=${Date.now() - stitchStartMs} template=${template.slice(0, 50)} error=${err instanceof Error ? err.message : String(err)}`);
      logError('AudioStitchingService.generateForLead', { voiceProfileId, template: template.slice(0, 50), elapsedMs: Date.now() - stitchStartMs }, err);
      throw err;
    }
  }

  async preGenerateFixedSegments(
    template: string,
    referenceWavPath: string,
    voiceProfileId: string,
    speed = 1.0,
    humanize = false,
    pitch = 1.0,
    volume = 1.0
  ): Promise<void> {
    const clampedPitch = Math.max(0.5, Math.min(2.0, pitch));
    const clampedVolume = Math.max(0.1, Math.min(2.0, volume));

    const segments = parseTemplate(template);
    const fixedSegments = segments.filter(s => s.type === 'fixed');

    for (const seg of fixedSegments) {
      let text = seg.content;
      if (humanize) text = textHumanizerService.humanize(text);

      const hash = audioCacheService.buildHash(text, voiceProfileId, { speed: speed.toFixed(2), pitch: clampedPitch.toFixed(2), volume: clampedVolume.toFixed(2) });
      const existing = await audioCacheService.getFilePath(hash);
      if (!existing) {
        const wavBuf = await ttsService.generate({ text, referenceWavPath, speed, voiceProfileId });
        const oggBuf = await convertWavToOgg(wavBuf, clampedPitch, clampedVolume);
        await audioCacheService.set(hash, oggBuf, voiceProfileId, text, true);
      }
    }
  }
}

export const audioStitchingService = new AudioStitchingService();
