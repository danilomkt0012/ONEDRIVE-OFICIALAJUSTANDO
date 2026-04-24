import sharp from "sharp";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createCanvas, loadImage, registerFont } from "canvas";
import { getRandomTemplate, loadTemplatesAsync, type TemplateInfo } from "./templateManager";
import type { ImageTemplateField } from "@shared/schema";
import { replaceVariables } from "./bot/BotFlowEngine";
import { logError, logWarn } from '../utils/logger';
import {
  logGenerationStart,
  logGenerationEnd,
  admitToQueue,
} from './imageStabilityGuard';

// ─── Font Registry ────────────────────────────────────────────────────────────
// Tracks custom font registrations and whether any failed.
// On failure the render path falls back to the safe system font stack explicitly.
const _fontRegistry = new Map<string, 'registered' | 'failed'>();
// Fallback stack used when a custom font failed its explicit registration attempt
const SAFE_FALLBACK_FONT_STACK = 'DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif';

function logImageGen(level: 'info' | 'warn' | 'error', op: string, ctx: Record<string, unknown>, msg?: string, err?: unknown) {
  const ts = new Date().toISOString();
  const tag = `[ImageGen][${ts}] op=${op}`;
  if (level === 'error') {
    const e = err instanceof Error ? err : new Error(msg || String(err));
    console.error(`${tag}`, { ...ctx, message: e.message, stack: e.stack });
  } else if (level === 'warn') {
    console.warn(`${tag} ${msg || ''}`, ctx);
  } else {
    console.log(`${tag} ${msg || ''}`, ctx);
  }
}

/**
 * Registers a custom font file with node-canvas before rendering.
 * Call from `initImageFonts()` at server startup for every bundled custom font.
 * On failure, a warning is logged and `_fontRegistry` records `'failed'` for
 * the key so `resolveCanvasFont` can substitute the safe system fallback stack.
 */
export function tryRegisterFont(fontPath: string, family: string, weight?: string, style?: string): void {
  const key = `${fontPath}:${family}:${weight || 'normal'}:${style || 'normal'}`;
  if (_fontRegistry.has(key)) return;
  try {
    if (!fs.existsSync(fontPath)) {
      throw new Error(`Font file not found: ${fontPath}`);
    }
    const options: { family: string; weight?: string; style?: string } = { family };
    if (weight) options.weight = weight;
    if (style) options.style = style;
    registerFont(fontPath, options);
    _fontRegistry.set(key, 'registered');
    logImageGen('info', 'tryRegisterFont', { fontPath, family, weight, style }, 'Font registered successfully');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    _fontRegistry.set(key, 'failed');
    logImageGen('warn', 'tryRegisterFont', { fontPath, family, weight, style, error: errMsg },
      `Font registration failed — falling back to system fonts for family "${family}". Check that the font file exists and is a valid TTF/OTF.`);
  }
}

// Known-safe system/web-safe font families resolved by node-canvas via OS.
const KNOWN_SYSTEM_FONTS = new Set([
  'arial', 'helvetica', 'verdana', 'tahoma', 'trebuchet ms', 'georgia',
  'times new roman', 'times', 'courier new', 'courier', 'impact', 'comic sans ms',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'dejavu sans', 'liberation sans', 'liberation serif', 'liberation mono',
  'ubuntu', 'noto sans', 'roboto', 'open sans', 'handwriting',
]);

/**
 * Returns a canvas font descriptor string for the requested family.
 *
 * - If the family was explicitly attempted via `tryRegisterFont` and failed,
 *   substitutes `SAFE_FALLBACK_FONT_STACK` and logs a warning.
 * - If the family is not known to the system font list and was never registered
 *   via `tryRegisterFont`, logs an info-level notice (canvas will try to resolve
 *   it via OS; may silently degrade to a default glyph).
 * - Known system/web-safe families pass through unchanged — resolved at render time.
 */
function resolveCanvasFont(family: string, fontSize: number, weight: string, style: string): string {
  const familyLower = family.toLowerCase();

  // Check if this family was explicitly attempted via tryRegisterFont and failed
  const failedKey = [..._fontRegistry.entries()].find(
    ([k, v]) => v === 'failed' && k.split(':')[1]?.toLowerCase() === familyLower
  );
  if (failedKey) {
    logImageGen('warn', 'resolveCanvasFont', { family, fontSize, weight, style },
      `Font "${family}" registration failed at startup — using system fallback fonts`);
    return `${style} ${weight} ${fontSize}px ${SAFE_FALLBACK_FONT_STACK}`;
  }

  // Enforce strict font resolution policy for unknown/unregistered families:
  // - If the family is a known system/web-safe font → pass through (OS resolves it).
  // - If the family was explicitly registered via tryRegisterFont and succeeded → pass through.
  // - Otherwise → substitute safe fallback stack with a warning so rendering is
  //   deterministic regardless of OS font availability (no silent substitution).
  const isRegisteredSuccessfully = [..._fontRegistry.entries()].some(
    ([k, v]) => v === 'registered' && k.split(':')[1]?.toLowerCase() === familyLower
  );
  if (!KNOWN_SYSTEM_FONTS.has(familyLower) && !isRegisteredSuccessfully) {
    logImageGen('warn', 'resolveCanvasFont', { family },
      `Font family "${family}" is not a known system font and was not registered via tryRegisterFont — substituting safe fallback to prevent non-deterministic rendering`);
    return `${style} ${weight} ${fontSize}px ${SAFE_FALLBACK_FONT_STACK}`;
  }

  const canonicalFamily = fontFamilyToCanvas(family);
  return `${style} ${weight} ${fontSize}px ${canonicalFamily}`;
}

/**
 * Called at server startup to register any custom fonts bundled with the
 * application.
 *
 * The function is intentionally non-blocking — font failures are logged as
 * warnings so the server continues to start. If a custom font fails,
 * `resolveCanvasFont()` automatically substitutes `SAFE_FALLBACK_FONT_STACK`
 * at render time.
 *
 * To add a bundled font: place the TTF/OTF file under `server/fonts/` and
 * call `tryRegisterFont(...)` below. All registrations happen synchronously
 * via node-canvas before any render path executes.
 */
export function initImageFonts(): void {
  // System-font-only policy (explicit):
  // This project relies on OS system fonts (Arial, Helvetica, DejaVu Sans,
  // Liberation Sans, etc.) which are resolved by node-canvas via the OS font cache.
  // No custom TTF/OTF bundles are required at this time.
  //
  // Any font family not in KNOWN_SYSTEM_FONTS and not registered below is
  // substituted with SAFE_FALLBACK_FONT_STACK at render time to prevent
  // non-deterministic OS-dependent font substitution.
  //
  // To register a bundled custom font, call tryRegisterFont() here:
  //   tryRegisterFont(path.join(__dirname, '../fonts/MyFont-Regular.ttf'), 'MyFont');
  const registered = [..._fontRegistry.entries()].filter(([, v]) => v === 'registered').map(([k]) => k.split(':')[1]);
  const failed     = [..._fontRegistry.entries()].filter(([, v]) => v === 'failed').map(([k]) => k.split(':')[1]);

  // Startup self-test: verify that the baseline fallback font stack is functional.
  // If measureText returns 0, canvas font resolution is broken and all renders will degrade.
  try {
    const testCanvas = createCanvas(100, 20);
    const testCtx = testCanvas.getContext('2d');
    testCtx.font = `normal normal 16px ${SAFE_FALLBACK_FONT_STACK}`;
    const measured = testCtx.measureText('A').width;
    if (measured > 0) {
      logImageGen('info', 'initImageFonts', { measuredWidth: measured },
        'Font system self-test passed — baseline fallback font stack is functional');
    } else {
      logImageGen('warn', 'initImageFonts', {},
        'Font system self-test WARN — measureText returned 0; text rendering may be invisible');
    }
  } catch (selfTestErr: unknown) {
    const msg = selfTestErr instanceof Error ? selfTestErr.message : String(selfTestErr);
    logImageGen('warn', 'initImageFonts', { error: msg },
      'Font system self-test FAILED — canvas font resolution unavailable; check node-canvas build');
  }

  logImageGen('info', 'initImageFonts', {
    customFontsRegistered: registered,
    customFontsFailed: failed,
    knownSystemFontsCount: KNOWN_SYSTEM_FONTS.size,
    fallbackStack: SAFE_FALLBACK_FONT_STACK,
  }, 'Image font registry initialized');
}

/**
 * Truncate `text` so that it fits within `maxWidth` pixels for the current
 * canvas context. Appends "…" when truncation occurs.
 */
function fitTextToWidth(ctx: { measureText(t: string): { width: number }; font: string }, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return text;
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = '…';
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  const available = maxWidth - ellipsisWidth;
  if (available <= 0) return ellipsis;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid)).width <= available) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low) + ellipsis;
}

/**
 * Auto-shrink font size until text fits within maxWidth, down to minFontSize.
 * Returns the fitted font size. Does NOT mutate ctx permanently.
 */
function autoFitFontSize(
  ctx: { measureText(t: string): { width: number }; font: string },
  text: string,
  maxWidth: number,
  currentFontSize: number,
  fontDescriptor: string,
  minFontSize: number = 8
): number {
  if (maxWidth <= 0) return currentFontSize;
  let size = currentFontSize;
  while (size > minFontSize) {
    const testFont = fontDescriptor.replace(/\d+px/, `${size}px`);
    ctx.font = testFont;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size = Math.max(minFontSize, size - 1);
  }
  return size;
}

// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  private _permits: number;
  private _queue: Array<() => void> = [];
  constructor(permits: number) { this._permits = permits; }
  acquire(): Promise<void> {
    if (this._permits > 0) { this._permits--; return Promise.resolve(); }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release(): void {
    const next = this._queue.shift();
    if (next) { next(); } else { this._permits++; }
  }
}

const imageGenSemaphore = new Semaphore(4);

const inflightGenerations = new Map<string, Promise<Buffer>>();

function generationKey(leadPhone: string, templateName: string): string {
  return `${leadPhone}:${templateName}`;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GENERATED_DIR = path.resolve(__dirname, "../../uploads/campaign-images");

const CANVAS_SIZE = 1080;

const MIN_OUTPUT_BYTES = 1000;

export interface ImageTextConfig {
  name: string;
  cpf: string;
  imageType?: "correios" | "dirpf" | "auto";
  jitterEnabled?: boolean;
}

export interface LeadImageSpec {
  id: string;
  nome: string;
  cpf?: string;
  telefone: string;
  imagePath?: string;
  templateUsed?: string;
}

export interface LeadImageResult extends LeadImageSpec {
  imagePath: string;
  templateUsed: string;
}

export interface BatchGenerateOptions {
  campaignId: string;
  concurrency?: number;
  imageType?: "correios" | "dirpf" | "auto";
  baseImagePath?: string;
  onProgress?: (generated: number, total: number) => void;
}

export interface BatchReport {
  total: number;
  succeeded: number;
  failed: number;
  failures: Array<{ index: number; phone: string; error: string }>;
}

interface InkColor {
  r: number;
  g: number;
  b: number;
}

function rnd(min: number, max: number): number {
  return min + (crypto.randomInt(0, 1000000) / 1000000) * (max - min);
}

function rndInt(min: number, max: number): number {
  if (min >= max) return min;
  return crypto.randomInt(min, max + 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function formatCpf(cpf: string): string {
  const digits = cpf.replace(/\D/g, "");
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  return cpf;
}

function fontFamilyToCanvas(family: string): string {
  const map: Record<string, string> = {
    "sans-serif": "Arial, Helvetica, sans-serif",
    "serif": "Georgia, Times New Roman, serif",
    "monospace": "Courier New, Courier, monospace",
    "handwriting": "cursive",
  };
  return map[family] || family;
}

function applyTextTransformServer(text: string, transform: string): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    default: return text;
  }
}

function computeCanvasDimensions(imgWidth: number, imgHeight: number): { width: number; height: number; drawX: number; drawY: number; drawW: number; drawH: number } {
  if (imgWidth === imgHeight) {
    return { width: CANVAS_SIZE, height: CANVAS_SIZE, drawX: 0, drawY: 0, drawW: CANVAS_SIZE, drawH: CANVAS_SIZE };
  }
  const aspect = imgWidth / imgHeight;
  let canvasW: number, canvasH: number;
  if (aspect > 1) {
    canvasW = CANVAS_SIZE;
    canvasH = Math.round(CANVAS_SIZE / aspect);
  } else {
    canvasH = CANVAS_SIZE;
    canvasW = Math.round(CANVAS_SIZE * aspect);
  }
  return { width: canvasW, height: canvasH, drawX: 0, drawY: 0, drawW: canvasW, drawH: canvasH };
}

/**
 * Converts a field's stored coordinates to canvas pixel coordinates.
 * `relative`: [0,1] fractions × canvas dimensions.
 * `absolute`: pixel values passed through unchanged.
 * Legacy (no coordinateSystem): inferred by value range ([0,1] → relative).
 * Callers must clamp the result to canvas bounds after this call.
 */
function resolveCoordinates(field: ImageTemplateField, canvasW: number, canvasH: number): { x: number; y: number } {
  if (field.coordinateSystem === 'relative') {
    return { x: canvasW * field.x, y: canvasH * field.y };
  }
  if (field.coordinateSystem === 'absolute') {
    return { x: field.x, y: field.y };
  }
  const isRelative = field.x >= 0 && field.x <= 1 && field.y >= 0 && field.y <= 1;
  return isRelative
    ? { x: canvasW * field.x, y: canvasH * field.y }
    : { x: field.x, y: field.y };
}

export async function generateImage(
  userData: Record<string, string>,
  template: {
    baseImageBuffer: Buffer;
    fields: ImageTemplateField[];
    templateId?: string;
    debugOverlay?: boolean;
  }
): Promise<Buffer> {
  const templateId = template.templateId || 'unknown';
  const debugOverlay = template.debugOverlay === true;
  const renderStart = Date.now();

  await imageGenSemaphore.acquire();
  try {
    const meta = await sharp(template.baseImageBuffer).metadata();
    const imgW = meta.width;
    const imgH = meta.height;
    if (!imgW || !imgH) {
      throw new Error("Image metadata missing width/height — image may be corrupted");
    }

    const dims = computeCanvasDimensions(imgW, imgH);
    const canvas = createCanvas(dims.width, dims.height);
    const ctx = canvas.getContext("2d");

    const img = await loadImage(template.baseImageBuffer);
    ctx.drawImage(img, dims.drawX, dims.drawY, dims.drawW, dims.drawH);

    const fieldPositionLog: Array<{ fieldId: string; type: string; x: number; y: number; text: string; maxWidth: number; fitted: boolean }> = [];

    for (const field of template.fields) {
      let text = field.defaultText;
      if (field.type === "name") text = userData.nome || userData.name || field.defaultText;
      else if (field.type === "cpf") text = formatCpf(userData.cpf || field.defaultText);

      text = replaceVariables(text, userData);
      text = applyTextTransformServer(text, field.textTransform);

      const { x: rawX, y: rawY } = resolveCoordinates(field, dims.width, dims.height);
      // Clamp coordinates to canvas bounds to prevent off-canvas rendering
      const realX = clamp(rawX, 0, dims.width);
      const realY = clamp(rawY, 0, dims.height);
      const fontSize = field.fontSize;

      const weight = field.fontWeight || "normal";
      const style = field.fontStyle || "normal";
      const fontDescriptor = resolveCanvasFont(field.fontFamily, fontSize, weight, style);
      ctx.font = fontDescriptor;

      // Auto-fit font size if text would overflow maxWidth
      let effectiveFontSize = fontSize;
      let fittedText = text;
      let fitted = false;
      if (field.maxWidth > 0) {
        effectiveFontSize = autoFitFontSize(ctx, text, field.maxWidth, fontSize, fontDescriptor);
        if (effectiveFontSize !== fontSize) {
          ctx.font = fontDescriptor.replace(/\d+px/, `${effectiveFontSize}px`);
          fitted = true;
        }
        // Ellipsis truncation as final guard after font shrink
        fittedText = fitTextToWidth(ctx, text, field.maxWidth);
        if (fittedText !== text) fitted = true;
      }

      if (field.textAlign === "center") {
        ctx.textAlign = "center";
      } else if (field.textAlign === "right") {
        ctx.textAlign = "right";
      } else {
        ctx.textAlign = "left";
      }
      ctx.textBaseline = "top";

      const opacity = (field.opacity || 100) / 100;
      ctx.globalAlpha = opacity;

      if (field.shadowEnabled) {
        ctx.shadowColor = field.shadowColor || "rgba(0,0,0,0.5)";
        ctx.shadowOffsetX = field.shadowOffsetX || 0;
        ctx.shadowOffsetY = field.shadowOffsetY || 0;
        ctx.shadowBlur = field.shadowBlur || 0;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.shadowBlur = 0;
      }

      if (field.strokeEnabled && field.strokeWidth > 0) {
        ctx.strokeStyle = field.strokeColor || "#000000";
        ctx.lineWidth = field.strokeWidth;
        ctx.strokeText(fittedText, realX, realY, field.maxWidth > 0 ? field.maxWidth : undefined);
      }

      ctx.fillStyle = field.color || "#000000";

      if (field.rotation) {
        ctx.save();
        ctx.translate(realX, realY);
        ctx.rotate((field.rotation * Math.PI) / 180);
        ctx.fillText(fittedText, 0, 0, field.maxWidth > 0 ? field.maxWidth : undefined);
        ctx.restore();
      } else {
        ctx.fillText(fittedText, realX, realY, field.maxWidth > 0 ? field.maxWidth : undefined);
      }

      ctx.globalAlpha = 1;

      // Debug overlay: draw bounding box around each rendered field.
      // Box origin is adjusted for textAlign so it matches actual glyph bounds:
      //   left  → origin is realX
      //   center → origin is realX - measuredW/2
      //   right  → origin is realX - measuredW
      if (debugOverlay) {
        const measuredW = field.maxWidth > 0 ? field.maxWidth : ctx.measureText(fittedText).width;
        const measuredH = effectiveFontSize;
        const align = (field.textAlign || 'left').toLowerCase();
        const boxX = align === 'center' ? realX - measuredW / 2 : align === 'right' ? realX - measuredW : realX;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,0,0,0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(boxX, realY, measuredW, measuredH);
        ctx.fillStyle = 'rgba(255,0,0,0.7)';
        ctx.font = '10px sans-serif';
        ctx.fillText(`${field.type}(${Math.round(realX)},${Math.round(realY)})`, boxX, Math.max(0, realY - 12));
        ctx.restore();
      }

      fieldPositionLog.push({
        fieldId: field.id || 'unknown',
        type: field.type || 'text',
        x: Math.round(realX),
        y: Math.round(realY),
        text: field.type === 'cpf' ? '***masked***' : fittedText.substring(0, 40),
        maxWidth: field.maxWidth || 0,
        fitted,
      });
    }

    const jpegBuffer = canvas.toBuffer("image/jpeg", { quality: 0.92 });
    if (jpegBuffer.length < MIN_OUTPUT_BYTES) {
      throw new Error(`Generated image too small (${jpegBuffer.length} bytes) — possible rendering failure`);
    }

    logImageGen('info', 'generateImage', {
      templateId,
      fieldCount: template.fields.length,
      outputBytes: jpegBuffer.length,
      renderMs: Date.now() - renderStart,
      debugOverlay,
      fields: fieldPositionLog,
    }, 'Image rendered successfully');

    return jpegBuffer;
  } catch (err: any) {
    logImageGen('error', 'generateImage', {
      templateId,
      renderMs: Date.now() - renderStart,
    }, undefined, err);
    logError('ImageGen.generateImage', { templateId }, err);
    throw err;
  } finally {
    imageGenSemaphore.release();
  }
}

export async function sendImage(
  phone: string,
  imageUrl: string,
  phoneNumberId: string,
  accessToken: string,
  caption?: string
): Promise<{ success: boolean; error?: string }> {
  if (!imageUrl || !imageUrl.trim()) {
    return { success: false, error: "URL da imagem vazia" };
  }
  try {
    const { metaAPI } = await import("../meta/metaAPI");
    await metaAPI.sendImageMessage(phoneNumberId, phone, imageUrl, caption, accessToken);
    return { success: true };
  } catch (err: any) {
    logError('ImageGen.sendImageMessage', { phone, phoneNumberId }, err);
    return { success: false, error: err?.message || String(err) };
  }
}

export interface SampleRegion {
  xStart: number;
  xEnd: number;
  yStart: number;
  yEnd: number;
}

export async function validateTextColor(
  templatePath: string,
  generatedBuffer: Buffer,
  sampleRegion: SampleRegion
): Promise<{ avgR: number; avgG: number; avgB: number; deltaR: number; deltaG: number; deltaB: number; pass: boolean }> {
  const [tplData, genData] = await Promise.all([
    sharp(templatePath).raw().toBuffer({ resolveWithObject: true }),
    sharp(generatedBuffer).raw().toBuffer({ resolveWithObject: true }),
  ]);

  const { data: tData } = tplData;
  const { data: gData, info: gInfo } = genData;
  const W = gInfo.width;
  const ch = gInfo.channels;

  function regionAvg(d: Buffer, r: SampleRegion) {
    let sumR = 0, sumG = 0, sumB = 0, n = 0;
    for (let y = r.yStart; y <= r.yEnd; y++) {
      for (let x = r.xStart; x <= r.xEnd; x++) {
        const idx = (y * W + x) * ch;
        sumR += d[idx]; sumG += d[idx + 1]; sumB += d[idx + 2]; n++;
      }
    }
    return n ? { r: sumR / n, g: sumG / n, b: sumB / n } : { r: 255, g: 255, b: 255 };
  }

  const tplAvg = regionAvg(tData as unknown as Buffer, sampleRegion);
  const genAvg = regionAvg(gData as unknown as Buffer, sampleRegion);

  const deltaR = Math.abs(genAvg.r - tplAvg.r);
  const deltaG = Math.abs(genAvg.g - tplAvg.g);
  const deltaB = Math.abs(genAvg.b - tplAvg.b);

  return {
    avgR: genAvg.r,
    avgG: genAvg.g,
    avgB: genAvg.b,
    deltaR,
    deltaG,
    deltaB,
    pass: deltaR > 10 && deltaG > 10 && deltaB > 10,
  };
}

function varyInkColor(ink: InkColor): InkColor {
  return {
    r: clamp(ink.r + rndInt(-5, 5), 0, 255),
    g: clamp(ink.g + rndInt(-5, 5), 0, 255),
    b: clamp(ink.b + rndInt(-5, 5), 0, 255),
  };
}

interface TextPosition {
  x: number;
  y: number;
  fontSize: number;
  color: string;
  text: string;
  fontWeight?: string;
  letterSpacing?: number;
  rotation?: number;
  textAnchor?: string;
  dominantBaseline?: string;
  maxWidth?: number;
}

interface PositionSpec {
  x: number;
  y: number;
  fontSize: number;
  text: string;
  fontWeight?: string;
  letterSpacing?: number;
  textAnchor?: string;
  dominantBaseline?: string;
  maxWidth?: number;
  paperSampleX: number;
  paperSampleY: number;
  paperSampleW: number;
  paperSampleH: number;
  targetInk: InkColor;
}

/**
 * Applies ±1 px position jitter via `crypto.randomInt` to simulate print variation.
 * Purely cosmetic — bounded to [-1, +1] px; callers clamp coordinates to canvas bounds.
 * Pass `enabled = false` for deterministic stress-test runs.
 */
function jitterPosition(spec: PositionSpec, enabled: boolean = true): { x: number; y: number } {
  if (!enabled) return { x: spec.x, y: spec.y };
  return {
    x: spec.x + rndInt(-1, 1),
    y: spec.y + rndInt(-1, 1),
  };
}

function samplePaperColor(
  rawData: Buffer,
  imgWidth: number,
  imgHeight: number,
  channels: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): InkColor {
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(imgWidth - 1, Math.floor(rx + rw));
  const y1 = Math.min(imgHeight - 1, Math.floor(ry + rh));

  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const idx = (py * imgWidth + px) * channels;
      const r = rawData[idx], g = rawData[idx + 1], b = rawData[idx + 2];
      if ((r + g + b) / 3 > 160) {
        sumR += r; sumG += g; sumB += b; count++;
      }
    }
  }

  return count === 0
    ? { r: 220, g: 220, b: 222 }
    : { r: Math.round(sumR / count), g: Math.round(sumG / count), b: Math.round(sumB / count) };
}

function computeMultiplySource(
  inkR: number, inkG: number, inkB: number,
  paperR: number, paperG: number, paperB: number
): string {
  const srcR = Math.min(255, Math.round(inkR * 255 / Math.max(1, paperR)));
  const srcG = Math.min(255, Math.round(inkG * 255 / Math.max(1, paperG)));
  const srcB = Math.min(255, Math.round(inkB * 255 / Math.max(1, paperB)));
  return `rgb(${srcR},${srcG},${srcB})`;
}

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSvgOverlay(width: number, height: number, positions: TextPosition[]): string {
  const fontFamily = "DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif";

  const textElements = positions.map((p) => {
    const transform = p.rotation ? ` transform="rotate(${p.rotation}, ${p.x}, ${p.y})"` : "";
    const spacing = p.letterSpacing !== undefined ? ` letter-spacing="${p.letterSpacing}"` : "";
    const weight = p.fontWeight || "normal";
    const anchor = p.textAnchor ? ` text-anchor="${p.textAnchor}"` : "";
    const baseline = p.dominantBaseline || "alphabetic";
    const maxW = p.maxWidth ? ` textLength="${p.maxWidth}" lengthAdjust="spacing"` : "";

    return `<text
      x="${p.x}" y="${p.y}"
      font-family="${fontFamily}"
      font-size="${p.fontSize}"
      font-weight="${weight}"
      fill="${p.color}"
      dominant-baseline="${baseline}"${anchor}${spacing}${maxW}${transform}
    >${escapeSvgText(p.text)}</text>`;
  }).join("\n");

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="white"/>
    ${textElements}
  </svg>`;
}

export async function applyPhysicalSimulation(imageBuffer: Buffer): Promise<Buffer> {
  const angle      = rnd(-0.3, 0.3);
  const brightness = rnd(0.97, 1.03);
  const blurSigma  = rnd(0.3, 0.5);
  const quality    = rndInt(70, 85);
  const noiseLevel = rnd(0.01, 0.03);

  let pipeline = sharp(imageBuffer);

  if (Math.abs(angle) > 0.01) {
    pipeline = pipeline.rotate(angle, { background: { r: 255, g: 255, b: 255 } });
  }

  pipeline = pipeline.modulate({ brightness });
  pipeline = pipeline.blur(blurSigma);

  const { data, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });

  const noiseMag = Math.floor(noiseLevel * 255);
  for (let i = 0; i < data.length; i++) {
    const noise = rndInt(-noiseMag, noiseMag);
    (data as Buffer)[i] = clamp((data as Buffer)[i] + noise, 0, 255);
  }

  return sharp(data as Buffer, {
    raw: { width: info.width, height: info.height, channels: info.channels as 1 | 2 | 3 | 4 },
  })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

function getDirpfSpecs(w: number, h: number, name: string, cpf: string): PositionSpec[] {
  const formattedCpf = formatCpf(cpf);
  const sx = w / 1024;
  const sy = h / 1536;
  const fs = Math.round(14 * sx);
  const dirpfInk: InkColor = { r: 70, g: 72, b: 78 };

  return [
    {
      x: Math.round(290 * sx),
      y: Math.round(451 * sy),
      fontSize: fs,
      text: name.toUpperCase(),
      letterSpacing: 0.4,
      fontWeight: "normal",
      dominantBaseline: "alphabetic",
      paperSampleX: Math.round(290 * sx),
      paperSampleY: Math.round(435 * sy),
      paperSampleW: Math.round(280 * sx),
      paperSampleH: Math.round(14 * sy),
      targetInk: dirpfInk,
    },
    {
      x: Math.round(168 * sx),
      y: Math.round(496 * sy),
      fontSize: fs,
      text: formattedCpf,
      letterSpacing: 0.8,
      fontWeight: "normal",
      dominantBaseline: "alphabetic",
      paperSampleX: Math.round(155 * sx),
      paperSampleY: Math.round(481 * sy),
      paperSampleW: Math.round(200 * sx),
      paperSampleH: Math.round(14 * sy),
      targetInk: dirpfInk,
    },
  ];
}

function getCorreiosSpecs(w: number, h: number, name: string, cpf: string): PositionSpec[] {
  const formattedCpf = formatCpf(cpf);
  const sx = w / 1140;
  const sy = h / 855;
  const nameInk: InkColor = { r: 6, g: 6, b: 8 };
  const cpfInk: InkColor = { r: 8, g: 8, b: 10 };

  return [
    {
      x: Math.round(460 * sx),
      y: Math.round(528 * sy),
      fontSize: Math.round(20 * sx),
      text: name.toUpperCase(),
      fontWeight: "bold",
      letterSpacing: 0.8,
      textAnchor: "middle",
      dominantBaseline: "middle",
      maxWidth: Math.round(300 * sx),
      paperSampleX: Math.round(310 * sx),
      paperSampleY: Math.round(510 * sy),
      paperSampleW: Math.round(300 * sx),
      paperSampleH: Math.round(30 * sy),
      targetInk: nameInk,
    },
    {
      x: Math.round(275 * sx),
      y: Math.round(562 * sy),
      fontSize: Math.round(14 * sx),
      text: `CPF: ${formattedCpf}`,
      letterSpacing: 0.6,
      dominantBaseline: "middle",
      paperSampleX: Math.round(275 * sx),
      paperSampleY: Math.round(547 * sy),
      paperSampleW: Math.round(200 * sx),
      paperSampleH: Math.round(25 * sy),
      targetInk: cpfInk,
    },
  ];
}

function getAutoSpecs(w: number, h: number, name: string, cpf: string): PositionSpec[] {
  const formattedCpf = formatCpf(cpf);
  const fs = Math.round(Math.min(w, h) * 0.025);
  const startX = Math.round(w * 0.1);
  const ink: InkColor = { r: 8, g: 9, b: 11 };

  return [
    {
      x: startX, y: Math.round(h * 0.55), fontSize: fs,
      text: name.toUpperCase(), fontWeight: "bold",
      paperSampleX: startX, paperSampleY: Math.round(h * 0.52),
      paperSampleW: Math.round(w * 0.5), paperSampleH: fs,
      targetInk: ink,
    },
    {
      x: startX, y: Math.round(h * 0.62), fontSize: Math.round(fs * 0.9),
      text: `CPF: ${formattedCpf}`,
      paperSampleX: startX, paperSampleY: Math.round(h * 0.59),
      paperSampleW: Math.round(w * 0.4), paperSampleH: fs,
      targetInk: ink,
    },
  ];
}

export async function generatePackageImage(
  imageBuffer: Buffer,
  config: ImageTextConfig
): Promise<Buffer> {
  const bufferHash = crypto.createHash('md5').update(imageBuffer.slice(0, 1024)).digest('hex').slice(0, 12);
  const dedupKey = generationKey(config.cpf || config.name, `${config.imageType || 'auto'}:${bufferHash}`);
  const inflight = inflightGenerations.get(dedupKey);
  if (inflight) {
    return inflight;
  }

  const release = await admitToQueue({ dedupKey, path: 'generatePackageImage' });

  const promise = (async () => {
    logGenerationStart(config.cpf || config.name, config.imageType || 'auto');
    await imageGenSemaphore.acquire();
    try {
      const result = await _generatePackageImageInner(imageBuffer, config);
      logGenerationEnd(config.cpf || config.name, config.imageType || 'auto');
      return result;
    } catch (err: any) {
      logGenerationEnd(config.cpf || config.name, config.imageType || 'auto', err.message);
      throw err;
    } finally {
      imageGenSemaphore.release();
      inflightGenerations.delete(dedupKey);
      release();
    }
  })();

  inflightGenerations.set(dedupKey, promise);
  return promise;
}

async function _generatePackageImageInner(
  imageBuffer: Buffer,
  config: ImageTextConfig
): Promise<Buffer> {
  const meta = await sharp(imageBuffer).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) {
    throw new Error("Image metadata missing width/height — image may be corrupted");
  }
  const channels = meta.channels || 3;

  const { data: rawData } = await sharp(imageBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const specs =
    config.imageType === "dirpf"
      ? getDirpfSpecs(width, height, config.name, config.cpf)
      : config.imageType === "correios" || !config.imageType
        ? getCorreiosSpecs(width, height, config.name, config.cpf)
        : getAutoSpecs(width, height, config.name, config.cpf);

  const jitterEnabled = config.jitterEnabled !== false;

  const positions: TextPosition[] = specs.map((spec) => {
    const paper = samplePaperColor(
      rawData as unknown as Buffer,
      width, height, channels,
      spec.paperSampleX, spec.paperSampleY,
      spec.paperSampleW, spec.paperSampleH
    );

    const variedInk = varyInkColor(spec.targetInk);
    const color = computeMultiplySource(
      variedInk.r, variedInk.g, variedInk.b,
      paper.r, paper.g, paper.b
    );

    const { x, y } = jitterPosition(spec, jitterEnabled);

    return {
      x, y,
      fontSize: spec.fontSize,
      color,
      text: spec.text,
      fontWeight: spec.fontWeight,
      letterSpacing: spec.letterSpacing,
      textAnchor: spec.textAnchor,
      dominantBaseline: spec.dominantBaseline,
      maxWidth: spec.maxWidth,
    };
  });

  const textBlur = rnd(0.4, 0.9);

  let textLayer: Buffer | null = await sharp(Buffer.from(buildSvgOverlay(width, height, positions)))
    .png()
    .blur(textBlur)
    .toBuffer();

  let composed: Buffer | null = await sharp(imageBuffer)
    .composite([{ input: textLayer, top: 0, left: 0, blend: "multiply" }])
    .toBuffer();
  textLayer = null;

  const result = await applyPhysicalSimulation(composed);
  composed = null;

  if (result.length < MIN_OUTPUT_BYTES) {
    logWarn('ImageGen.generatePackageImage', { resultSize: result.length }, 'Output image suspiciously small');
  }

  return result;
}

export async function generatePackageImageFromFile(
  imagePath: string,
  config: ImageTextConfig
): Promise<Buffer> {
  const imageBuffer = await fs.promises.readFile(imagePath);
  return await generatePackageImage(imageBuffer, config);
}

function buildCustomSvgOverlay(
  width: number,
  height: number,
  fields: ImageTemplateField[],
  leadData: { name: string; cpf: string; extraVars?: Record<string, string> },
  jitterEnabled: boolean = false
): string {
  const textElements = fields.map((f) => {
    let text = f.defaultText;
    if (f.type === "name") text = leadData.name;
    else if (f.type === "cpf") text = formatCpf(leadData.cpf);
    text = replaceVariables(text, {
      nome: leadData.name,
      name: leadData.name,
      cpf: leadData.cpf,
      ...(leadData.extraVars || {}),
    });
    text = applyTextTransformServer(text, f.textTransform);

    const hexToRgb = (hex: string) => {
      const h = hex.replace("#", "");
      return {
        r: parseInt(h.substring(0, 2), 16) || 0,
        g: parseInt(h.substring(2, 4), 16) || 0,
        b: parseInt(h.substring(4, 6), 16) || 0,
      };
    };
    const textColor = hexToRgb(f.color);
    const fillColor = `rgb(${textColor.r},${textColor.g},${textColor.b})`;
    const opacity = (f.opacity || 100) / 100;

    const { x: resolvedX, y: resolvedY } = resolveCoordinates(f, width, height);
    const x = jitterEnabled ? resolvedX + rndInt(-1, 1) : resolvedX;
    const y = jitterEnabled ? resolvedY + rndInt(-1, 1) : resolvedY;

    let svgAttrs = `x="${x}" y="${y}"`;
    svgAttrs += ` font-family="${fontFamilyToSvg(f.fontFamily)}"`;
    svgAttrs += ` font-size="${f.fontSize}"`;
    svgAttrs += ` font-weight="${f.fontWeight}"`;
    svgAttrs += ` font-style="${f.fontStyle}"`;
    svgAttrs += ` fill="${fillColor}"`;
    svgAttrs += ` opacity="${opacity}"`;
    if (f.letterSpacing) svgAttrs += ` letter-spacing="${f.letterSpacing}"`;
    if (f.lineHeight && f.lineHeight !== 1) {
      const dyValue = f.fontSize * (f.lineHeight - 1);
      svgAttrs += ` dy="${dyValue.toFixed(1)}"`;
    }
    if (f.textAlign === "center") svgAttrs += ` text-anchor="middle"`;
    else if (f.textAlign === "right") svgAttrs += ` text-anchor="end"`;
    if (f.maxWidth > 0) svgAttrs += ` textLength="${f.maxWidth}" lengthAdjust="spacing"`;

    let transform = "";
    if (f.rotation) transform += `rotate(${f.rotation}, ${x}, ${y})`;
    if (transform) svgAttrs += ` transform="${transform}"`;

    let filterDef = "";
    let filterRef = "";
    if (f.shadowEnabled) {
      const filterId = `shadow-${f.id}`;
      const shadowRgb = hexToRgb(f.shadowColor);
      filterDef = `<filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="${f.shadowOffsetX}" dy="${f.shadowOffsetY}" stdDeviation="${f.shadowBlur}" flood-color="rgb(${shadowRgb.r},${shadowRgb.g},${shadowRgb.b})" flood-opacity="0.8"/>
      </filter>`;
      filterRef = ` filter="url(#${filterId})"`;
    }

    let strokeAttr = "";
    if (f.strokeEnabled && f.strokeWidth > 0) {
      const strokeRgb = hexToRgb(f.strokeColor);
      strokeAttr = ` stroke="rgb(${strokeRgb.r},${strokeRgb.g},${strokeRgb.b})" stroke-width="${f.strokeWidth}" paint-order="stroke fill"`;
    }

    return { filterDef, element: `<text ${svgAttrs}${filterRef}${strokeAttr}>${escapeSvgText(text)}</text>` };
  });

  const defs = textElements.filter((t) => t.filterDef).map((t) => t.filterDef).join("\n");
  const elements = textElements.map((t) => t.element).join("\n");

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    ${defs ? `<defs>${defs}</defs>` : ""}
    ${elements}
  </svg>`;
}

function fontFamilyToSvg(family: string): string {
  const map: Record<string, string> = {
    "sans-serif": "DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif",
    "serif": "DejaVu Serif, Liberation Serif, Georgia, Times New Roman, serif",
    "monospace": "DejaVu Sans Mono, Liberation Mono, Courier New, Courier, monospace",
    "handwriting": "Comic Sans MS, Segoe Script, cursive",
  };
  return map[family] || family;
}

export async function generateFromCustomTemplate(
  baseImageBuffer: Buffer,
  fields: ImageTemplateField[],
  leadData: { name: string; cpf: string; extraVars?: Record<string, string> },
  options?: { templateId?: string; debugOverlay?: boolean; deterministic?: boolean }
): Promise<Buffer> {
  const templateId = options?.templateId || 'custom';
  const debugOverlay = options?.debugOverlay === true;
  const deterministic = options?.deterministic === true;
  const renderStart = Date.now();

  const bufferHash = crypto.createHash('md5').update(baseImageBuffer.slice(0, 1024)).digest('hex').slice(0, 12);
  const fieldsHash = crypto.createHash('md5').update(JSON.stringify(fields.map(f => ({ id: f.id, x: f.x, y: f.y, fontSize: f.fontSize, color: f.color, type: f.type })))).digest('hex').slice(0, 8);
  // Include render options in key to prevent cross-request reuse of wrong inflight output
  const optsTag = `${debugOverlay ? 'd' : ''}${deterministic ? 'x' : ''}`;
  const dedupKey = generationKey(leadData.cpf || leadData.name, `custom:${bufferHash}:${fieldsHash}:${optsTag}`);
  const inflight = inflightGenerations.get(dedupKey);
  if (inflight) {
    return inflight;
  }

  const release = await admitToQueue({ dedupKey, path: 'generateFromCustomTemplate' });

  const promise = (async () => {
  logGenerationStart(leadData.cpf || leadData.name, `custom:${bufferHash}`);
  await imageGenSemaphore.acquire();
  let jpegBuffer: Buffer | null = null;
  let textLayer: Buffer | null = null;
  let composed: Buffer | null = null;
  try {
    const meta = await sharp(baseImageBuffer).metadata();
    const imgW = meta.width;
    const imgH = meta.height;
    if (!imgW || !imgH) {
      throw new Error("Image metadata missing width/height — image may be corrupted");
    }

    const dims = computeCanvasDimensions(imgW, imgH);
    const canvas = createCanvas(dims.width, dims.height);
    const ctx = canvas.getContext("2d");

    const img = await loadImage(baseImageBuffer);
    ctx.drawImage(img, dims.drawX, dims.drawY, dims.drawW, dims.drawH);

    const fieldPositionLog: Array<{ fieldId: string; type: string; x: number; y: number; text: string; maxWidth: number; fitted: boolean }> = [];

    for (const f of fields) {
      let text = f.defaultText;
      if (f.type === "name") text = leadData.name;
      else if (f.type === "cpf") text = formatCpf(leadData.cpf);
      // Merge extraVars so all bot conversation variables ({{produto}}, {{valor}}, etc.)
      // are substituted — not just name and cpf.
      text = replaceVariables(text, {
        nome: leadData.name,
        name: leadData.name,
        cpf: leadData.cpf,
        ...(leadData.extraVars || {}),
      });
      text = applyTextTransformServer(text, f.textTransform);

      const { x: rawX, y: rawY } = resolveCoordinates(f, dims.width, dims.height);
      // Clamp coordinates to canvas bounds to prevent off-canvas rendering
      const realX = clamp(rawX, 0, dims.width);
      const realY = clamp(rawY, 0, dims.height);

      const weight = f.fontWeight || "normal";
      const style = f.fontStyle || "normal";
      const fontDescriptor = resolveCanvasFont(f.fontFamily, f.fontSize, weight, style);
      ctx.font = fontDescriptor;

      // Auto-fit font size if text would overflow maxWidth
      let effectiveFontSize = f.fontSize;
      let fittedText = text;
      let fitted = false;
      if (f.maxWidth > 0) {
        effectiveFontSize = autoFitFontSize(ctx, text, f.maxWidth, f.fontSize, fontDescriptor);
        if (effectiveFontSize !== f.fontSize) {
          ctx.font = fontDescriptor.replace(/\d+px/, `${effectiveFontSize}px`);
          fitted = true;
        }
        fittedText = fitTextToWidth(ctx, text, f.maxWidth);
        if (fittedText !== text) fitted = true;
      }

      if (f.textAlign === "center") ctx.textAlign = "center";
      else if (f.textAlign === "right") ctx.textAlign = "right";
      else ctx.textAlign = "left";

      ctx.textBaseline = "top";
      const opacity = (f.opacity || 100) / 100;
      ctx.globalAlpha = opacity;

      if (f.shadowEnabled) {
        ctx.shadowColor = f.shadowColor || "rgba(0,0,0,0.5)";
        ctx.shadowOffsetX = f.shadowOffsetX || 0;
        ctx.shadowOffsetY = f.shadowOffsetY || 0;
        ctx.shadowBlur = f.shadowBlur || 0;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.shadowBlur = 0;
      }

      if (f.strokeEnabled && f.strokeWidth > 0) {
        ctx.strokeStyle = f.strokeColor || "#000000";
        ctx.lineWidth = f.strokeWidth;
        ctx.strokeText(fittedText, realX, realY, f.maxWidth > 0 ? f.maxWidth : undefined);
      }

      ctx.fillStyle = f.color || "#000000";

      if (f.rotation) {
        ctx.save();
        ctx.translate(realX, realY);
        ctx.rotate((f.rotation * Math.PI) / 180);
        ctx.fillText(fittedText, 0, 0, f.maxWidth > 0 ? f.maxWidth : undefined);
        ctx.restore();
      } else {
        ctx.fillText(fittedText, realX, realY, f.maxWidth > 0 ? f.maxWidth : undefined);
      }

      ctx.globalAlpha = 1;

      // Debug overlay: draw bounding box adjusted for textAlign (left/center/right)
      if (debugOverlay) {
        const measuredW = f.maxWidth > 0 ? f.maxWidth : ctx.measureText(fittedText).width;
        const measuredH = effectiveFontSize;
        const alignF = (f.textAlign || 'left').toLowerCase();
        const boxX = alignF === 'center' ? realX - measuredW / 2 : alignF === 'right' ? realX - measuredW : realX;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,0,0,0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.strokeRect(boxX, realY, measuredW, measuredH);
        ctx.fillStyle = 'rgba(255,0,0,0.7)';
        ctx.font = '10px sans-serif';
        ctx.fillText(`${f.type}(${Math.round(realX)},${Math.round(realY)})`, boxX, Math.max(0, realY - 12));
        ctx.restore();
      }

      fieldPositionLog.push({
        fieldId: f.id || 'unknown',
        type: f.type || 'text',
        x: Math.round(realX),
        y: Math.round(realY),
        text: f.type === 'cpf' ? '***masked***' : fittedText.substring(0, 40),
        maxWidth: f.maxWidth || 0,
        fitted,
      });
    }

    jpegBuffer = canvas.toBuffer("image/jpeg", { quality: 0.92 });
    if (jpegBuffer.length < MIN_OUTPUT_BYTES) {
      throw new Error(`Generated image too small (${jpegBuffer.length} bytes) — possible rendering failure`);
    }

    logImageGen('info', 'generateFromCustomTemplate', {
      templateId,
      fieldCount: fields.length,
      outputBytes: jpegBuffer.length,
      renderMs: Date.now() - renderStart,
      debugOverlay,
      leadName: leadData.name.substring(0, 20),
      leadCpfMasked: leadData.cpf ? leadData.cpf.replace(/\d(?=\d{4})/g, '*') : '',
      fields: fieldPositionLog,
    }, 'Custom template rendered successfully');

    // Deterministic mode: skip physical simulation so output is byte-stable across runs.
    // Used for stress-test validation and determinism checks.
    if (deterministic) {
      return jpegBuffer;
    }
    const result = await applyPhysicalSimulation(jpegBuffer);
    // Release the source buffer reference explicitly to allow GC
    jpegBuffer.fill(0);
    jpegBuffer = null;
    return result;
  } catch (err: unknown) {
    jpegBuffer = null;
    logImageGen('warn', 'generateFromCustomTemplate', {
      templateId,
      renderMs: Date.now() - renderStart,
    }, 'Canvas rendering failed, falling back to SVG pipeline (visual differences may occur)');
    logWarn('ImageGen.canvasFallbackToSVG', { templateId }, 'Canvas rendering failed, falling back to SVG pipeline (visual differences may occur)');
    logError('ImageGen.generateFromCustomTemplate', { templateId }, err);

    const meta = await sharp(baseImageBuffer).metadata();
    const width = meta.width;
    const height = meta.height;
    if (!width || !height) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logGenerationEnd(leadData.cpf || leadData.name, `custom:${bufferHash}`, errMsg);
      throw new Error("Image metadata missing width/height — image may be corrupted");
    }

    const svgOverlay = buildCustomSvgOverlay(width, height, fields, leadData, false);
    const textBlur = rnd(0.4, 0.9);

    try {
      textLayer = await sharp(Buffer.from(svgOverlay))
        .png()
        .blur(textBlur)
        .toBuffer();

      composed = await sharp(baseImageBuffer)
        .composite([{ input: textLayer, top: 0, left: 0, blend: "multiply" }])
        .toBuffer();
      textLayer = null;

      const svgResult = await applyPhysicalSimulation(composed);
      composed = null;

      logImageGen('info', 'generateFromCustomTemplate.svgFallback', {
        templateId,
        renderMs: Date.now() - renderStart,
        outputBytes: svgResult.length,
      }, 'SVG fallback render completed');

      return svgResult;
    } catch (svgErr: unknown) {
      textLayer = null;
      composed = null;
      throw svgErr;
    }
  } finally {
    imageGenSemaphore.release();
    inflightGenerations.delete(dedupKey);
    release();
  }
  })();

  inflightGenerations.set(dedupKey, promise);
  return promise;
}

export async function generateImageForLead(
  lead: LeadImageSpec,
  campaignId: string,
  templates?: TemplateInfo[]
): Promise<LeadImageResult> {
  const template = getRandomTemplate(templates);
  const imageBuffer = await fs.promises.readFile(template.filePath);

  const name = lead.nome || "CLIENTE";
  const cpf  = lead.cpf  || "";

  const resultBuffer = await generatePackageImage(imageBuffer, {
    name,
    cpf,
    imageType: template.imageType,
  });

  const safePhone = lead.telefone.replace(/\D/g, "");
  const leadDir   = path.join(GENERATED_DIR, campaignId);
  await fs.promises.mkdir(leadDir, { recursive: true });

  const imagePath = path.join(leadDir, `${safePhone}.jpg`);
  await fs.promises.writeFile(imagePath, resultBuffer);

  return {
    ...lead,
    imagePath,
    templateUsed: template.filename,
  };
}

export async function preBatchGenerate(
  leads: LeadImageSpec[],
  options: BatchGenerateOptions
): Promise<LeadImageResult[]> {
  const {
    campaignId,
    concurrency = 8,
    imageType,
    baseImagePath,
    onProgress,
  } = options;

  const templates = await loadTemplatesAsync();
  const results: LeadImageResult[] = new Array(leads.length);
  let generated = 0;
  const report: BatchReport = { total: leads.length, succeeded: 0, failed: 0, failures: [] };

  let baseBuffer: Buffer | null = null;
  if (baseImagePath) {
    try {
      await fs.promises.access(baseImagePath);
      baseBuffer = await fs.promises.readFile(baseImagePath);
    } catch (accessErr: any) {
      logWarn('ImageGen.preBatchGenerate', { baseImagePath, error: accessErr.message }, 'Base image not found, using templates');
    }
  }

  for (let i = 0; i < leads.length; i += concurrency) {
    const batch = leads.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (lead, batchIdx) => {
        const idx = i + batchIdx;
        try {
          let result: LeadImageResult;

          if (baseBuffer) {
            const name = lead.nome || "CLIENTE";
            const cpf  = lead.cpf  || "";
            const buf  = await generatePackageImage(baseBuffer, {
              name,
              cpf,
              imageType: imageType || "auto",
            });
            const safePhone = lead.telefone.replace(/\D/g, "");
            const leadDir   = path.join(GENERATED_DIR, campaignId);
            await fs.promises.mkdir(leadDir, { recursive: true });
            const imgPath = path.join(leadDir, `${safePhone}.jpg`);
            await fs.promises.writeFile(imgPath, buf);
            result = { ...lead, imagePath: imgPath, templateUsed: path.basename(baseImagePath!) };
          } else {
            result = await generateImageForLead(lead, campaignId, templates);
          }

          generated++;
          report.succeeded++;
          if (onProgress && (generated % 50 === 0 || generated === leads.length)) {
            onProgress(generated, leads.length);
          }

          return { idx, result };
        } catch (err: any) {
          report.failed++;
          report.failures.push({ index: idx, phone: lead.telefone, error: err.message || String(err) });
          logError('ImageGen.preBatchGenerate', { idx, phone: lead.telefone }, err);
          generated++;
          return { idx, result: { ...lead, imagePath: "", templateUsed: "" } };
        }
      })
    );

    for (const { idx, result } of batchResults) {
      results[idx] = result;
    }
  }

  if (report.failed > 0) {
    logWarn('ImageGen.preBatchGenerate.report', {
      total: report.total,
      succeeded: report.succeeded,
      failed: report.failed,
    }, `Batch generation completed with ${report.failed} failures`);
    for (const failure of report.failures.slice(0, 20)) {
      console.warn(`[ImageGen] Failed lead #${failure.index} (${failure.phone}): ${failure.error}`);
    }
  }

  return results;
}

export async function cleanupCampaignImages(campaignId: string): Promise<void> {
  if (campaignId === 'bot') {
    console.log('[ImageGen] Skipping bot directory in cleanupCampaignImages — managed by imageCleanupJob [MEDIA_CLEANUP_SAFE]');
    return;
  }
  const campaignDir = path.join(GENERATED_DIR, campaignId);
  try {
    await fs.promises.access(campaignDir);
    const files = await fs.promises.readdir(campaignDir);
    for (const file of files) {
      try {
        await fs.promises.unlink(path.join(campaignDir, file));
      } catch (e: any) {
        logError('ImageGen.cleanup.deleteFile', { campaignDir, file }, e);
      }
    }
    try {
      await fs.promises.rmdir(campaignDir);
    } catch (e: any) {
      logError('ImageGen.cleanup.rmdir', { campaignDir }, e);
    }
    console.log(`[ImageGen] Cleaned up ${files.length} image(s) for campaign ${campaignId}`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logError('ImageGen.cleanupCampaignImages', { campaignId }, err);
    }
  }
}

export async function validateAllImages(
  leads: LeadImageResult[],
  campaignId: string
): Promise<boolean> {
  const missingChecks = await Promise.all(
    leads.map(async (l) => {
      if (!l.imagePath) return true;
      try {
        await fs.promises.access(l.imagePath);
        return false;
      } catch {
        return true;
      }
    })
  );

  const missing = leads.filter((_, i) => missingChecks[i]);

  if (missing.length === 0) {
    console.log("[ImageGen] Validation: all images present.");
    return true;
  }

  logWarn('ImageGen.validateAllImages', { missing: missing.length }, `${missing.length} image(s) missing. Re-generating...`);

  const regenerated = await preBatchGenerate(missing, {
    campaignId,
    concurrency: 8,
    onProgress: (g, t) => console.log(`[ImageGen] Re-generating image ${g}/${t}...`),
  });

  for (const regen of regenerated) {
    const original = leads.find((l) => l.telefone === regen.telefone);
    if (original) {
      original.imagePath    = regen.imagePath;
      original.templateUsed = regen.templateUsed;
    }
  }

  const stillMissingChecks = await Promise.all(
    leads.map(async (l) => {
      if (!l.imagePath) return true;
      try {
        await fs.promises.access(l.imagePath);
        return false;
      } catch {
        return true;
      }
    })
  );
  const stillMissing = leads.filter((_, i) => stillMissingChecks[i]);

  if (stillMissing.length > 0) {
    logError('ImageGen.validateAllImages', { stillMissing: stillMissing.length }, new Error(`${stillMissing.length} images still missing after re-generation`));
    return false;
  }

  console.log("[ImageGen] All images validated successfully.");
  return true;
}
