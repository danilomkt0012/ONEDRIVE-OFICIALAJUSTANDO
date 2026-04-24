import fs from 'fs';
import child_process from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { logError } from './logger';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

export function detectAudioFormat(buffer: Buffer): 'ogg' | 'mp3' | 'wav' | 'unknown' {
  if (buffer.length < 4) return 'unknown';
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'ogg';
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'mp3';
  if (buffer[0] === 0xFF && (buffer[1] === 0xFB || buffer[1] === 0xF3 || buffer[1] === 0xF2)) return 'mp3';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'wav';
  return 'unknown';
}

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegStatic) return true;
  return new Promise((resolve) => {
    child_process.exec('ffmpeg -version', (err) => resolve(!err));
  });
}

export async function convertToOgg(inputPath: string): Promise<Buffer> {
  const outputPath = inputPath + '_converted.ogg';
  return new Promise<Buffer>((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('libopus')
      .format('ogg')
      .save(outputPath)
      .on('end', async () => {
        try {
          const buf = await fs.promises.readFile(outputPath);
          fs.promises.unlink(outputPath).catch((e) => { logError('audioConverter.convertToOgg.cleanupOutput', { outputPath }, e); });
          resolve(buf);
        } catch (e) {
          reject(e);
        }
      })
      .on('error', (err: Error) => {
        fs.promises.unlink(outputPath).catch((e) => { logError('audioConverter.convertToOgg.cleanupOnError', { outputPath }, e); });
        reject(err);
      });
  });
}

export async function convertBufferToOgg(inputBuffer: Buffer, tmpPath: string): Promise<Buffer> {
  await fs.promises.writeFile(tmpPath, inputBuffer);
  try {
    const result = await convertToOgg(tmpPath);
    return result;
  } finally {
    fs.promises.unlink(tmpPath).catch((e) => { logError('audioConverter.convertBufferToOgg.cleanup', { tmpPath }, e); });
  }
}
