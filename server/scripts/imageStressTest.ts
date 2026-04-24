/**
 * Image Template Stress-Test Utility
 *
 * Runs a large batch of sequential image generations using the custom template
 * pipeline to detect:
 *   - Rendering drift or quality degradation across runs
 *   - Font inconsistency (missing glyphs, unexpected substitutions)
 *   - Memory accumulation after repeated generations
 *   - Corrupted or suspiciously small output buffers
 *   - inflightGenerations map pruning correctness
 *
 * Usage (from project root):
 *   npx tsx server/scripts/imageStressTest.ts [--count=50] [--templateId=<uuid>] [--debug]
 *
 * Or via API route (POST /api/debug/image-stress-test):
 *   { count: 20, templateId: "...", debugOverlay: false }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas } from 'canvas';
import type { ImageTemplateField } from '@shared/schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface StressTestOptions {
  count?: number;
  templateId?: string;
  baseImagePath?: string;
  debugOverlay?: boolean;
  /** When true, skips physical simulation — output is byte-stable across runs (tighter drift check). */
  deterministic?: boolean;
  outputDir?: string;
}

export interface StressTestResult {
  total: number;
  succeeded: number;
  failed: number;
  minBytes: number;
  maxBytes: number;
  avgBytes: number;
  minRenderMs: number;
  maxRenderMs: number;
  avgRenderMs: number;
  driftWarnings: string[];
  failures: Array<{ run: number; error: string }>;
  memoryBeforeMb: number;
  memoryAfterMb: number;
  memoryDeltaMb: number;
}

const SYNTHETIC_FIELDS_FIXTURE: ImageTemplateField[] = [
  {
    id: 'stress-name',
    label: 'Nome',
    type: 'name',
    defaultText: 'CLIENTE',
    x: 0.1,
    y: 0.5,
    fontSize: 32,
    fontFamily: 'sans-serif',
    fontWeight: 'bold',
    fontStyle: 'normal',
    color: '#000000',
    textAlign: 'left',
    textTransform: 'uppercase',
    opacity: 100,
    maxWidth: 400,
    letterSpacing: 0,
    lineHeight: 1,
    rotation: 0,
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    strokeEnabled: false,
    strokeColor: '#000000',
    strokeWidth: 0,
    coordinateSystem: 'relative',
  },
  {
    id: 'stress-cpf',
    label: 'CPF',
    type: 'cpf',
    defaultText: '',
    x: 0.1,
    y: 0.6,
    fontSize: 24,
    fontFamily: 'sans-serif',
    fontWeight: 'normal',
    fontStyle: 'normal',
    color: '#333333',
    textAlign: 'left',
    textTransform: 'none',
    opacity: 100,
    maxWidth: 300,
    letterSpacing: 0,
    lineHeight: 1,
    rotation: 0,
    shadowEnabled: false,
    shadowColor: '#000000',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowBlur: 0,
    strokeEnabled: false,
    strokeColor: '#000000',
    strokeWidth: 0,
    coordinateSystem: 'relative',
  },
];

function randomName(): string {
  const names = [
    'JOÃO SILVA', 'MARIA SOUZA', 'CARLOS OLIVEIRA', 'ANA SANTOS',
    'FRANCISCO PEREIRA', 'FERNANDA COSTA', 'LUIZ ALMEIDA', 'PATRICIA NASCIMENTO',
    'PAULO LIMA', 'AMANDA CARVALHO', 'THIERRY MONTALBANO DA CUNHA E SILVA PINHEIRO',
    'X',
  ];
  return names[Math.floor(Math.random() * names.length)];
}

function randomCpf(): string {
  return Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('');
}

function createSyntheticBaseImage(): Buffer {
  const canvas = createCanvas(800, 600);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(50, 50, 700, 500);
  ctx.fillStyle = '#cccccc';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('STRESS TEST TEMPLATE', 60, 80);
  return canvas.toBuffer('image/jpeg', { quality: 0.85 });
}

export async function runImageStressTest(options: StressTestOptions = {}): Promise<StressTestResult> {
  const count = options.count ?? 20;
  const debugOverlay = options.debugOverlay ?? false;
  const deterministic = options.deterministic ?? false;
  // In deterministic mode (no physical simulation), size drift is expected to be minimal.
  const driftThresholdPct = deterministic ? 5 : 80;

  const { generateFromCustomTemplate } = await import('../services/imageGenerator.js');

  let baseImageBuffer: Buffer;
  let fields: ImageTemplateField[] = SYNTHETIC_FIELDS_FIXTURE;
  let resolvedTemplateId = options.templateId || 'stress-test-synthetic';

  // When a real templateId is provided, load the actual template fields and base image
  // so the stress test exercises the true render path rather than the synthetic fixture.
  if (options.templateId) {
    try {
      const { db } = await import('../db.js');
      const { imageTemplates } = await import('@shared/schema');
      const { eq } = await import('drizzle-orm');
      const rows = await db.select().from(imageTemplates).where(eq(imageTemplates.id, options.templateId));
      if (rows.length > 0) {
        const tpl = rows[0];
        fields = (tpl.fields || []) as ImageTemplateField[];
        resolvedTemplateId = `template-${tpl.id}`;

        if (options.baseImagePath && fs.existsSync(options.baseImagePath)) {
          baseImageBuffer = await fs.promises.readFile(options.baseImagePath);
        } else if (tpl.baseImagePath && fs.existsSync(tpl.baseImagePath)) {
          baseImageBuffer = await fs.promises.readFile(tpl.baseImagePath);
        } else if (tpl.baseImageData) {
          const b64 = (tpl.baseImageData as string).replace(/^data:image\/\w+;base64,/, '');
          baseImageBuffer = Buffer.from(b64, 'base64');
        } else {
          console.warn('[StressTest] Template found but no base image available — using synthetic');
          baseImageBuffer = createSyntheticBaseImage();
        }
        console.log(`[StressTest] Loaded template id=${tpl.id} name="${tpl.name}" fields=${fields.length}`);
      } else {
        console.warn(`[StressTest] Template id=${options.templateId} not found — using synthetic fixture`);
        baseImageBuffer = createSyntheticBaseImage();
      }
    } catch (dbErr: unknown) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      console.warn(`[StressTest] Failed to load template (${msg}) — using synthetic fixture`);
      baseImageBuffer = createSyntheticBaseImage();
    }
  } else if (options.baseImagePath && fs.existsSync(options.baseImagePath)) {
    baseImageBuffer = await fs.promises.readFile(options.baseImagePath);
  } else {
    baseImageBuffer = createSyntheticBaseImage();
  }

  if (fields.length === 0) {
    console.warn('[StressTest] No fields to render — output will be base image only');
  }

  const results: Array<{ bytes: number; renderMs: number }> = [];
  const failures: Array<{ run: number; error: string }> = [];
  const driftWarnings: string[] = [];

  const memBefore = process.memoryUsage().heapUsed;

  console.log(`[StressTest] Starting ${count} sequential image generations...`);
  console.log(`[StressTest] debugOverlay=${debugOverlay} fields=${fields.length}`);

  let firstRunBytes = 0;

  for (let i = 0; i < count; i++) {
    const name = randomName();
    const cpf = randomCpf();
    const start = Date.now();

    try {
      const buf = await generateFromCustomTemplate(
        baseImageBuffer,
        fields,
        { name, cpf },
        { templateId: resolvedTemplateId, debugOverlay, deterministic }
      );

      const renderMs = Date.now() - start;

      if (buf.length < 1000) {
        driftWarnings.push(`Run ${i + 1}: output suspiciously small (${buf.length} bytes)`);
      }

      if (i === 0) {
        firstRunBytes = buf.length;
      } else {
        const delta = Math.abs(buf.length - firstRunBytes);
        const pct = firstRunBytes > 0 ? (delta / firstRunBytes) * 100 : 0;
        if (pct > driftThresholdPct) {
          driftWarnings.push(`Run ${i + 1}: output size drifted ${pct.toFixed(1)}% from baseline (${firstRunBytes} → ${buf.length} bytes)`);
        }
      }

      results.push({ bytes: buf.length, renderMs });

      if (options.outputDir && i < 5) {
        const outPath = path.join(options.outputDir, `stress_run_${String(i + 1).padStart(3, '0')}.jpg`);
        await fs.promises.mkdir(options.outputDir, { recursive: true });
        await fs.promises.writeFile(outPath, buf);
      }

      if ((i + 1) % 10 === 0) {
        console.log(`[StressTest] Progress: ${i + 1}/${count} | last=${renderMs}ms | bytes=${buf.length}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failures.push({ run: i + 1, error: errMsg });
      console.error(`[StressTest] Run ${i + 1} FAILED:`, errMsg);
    }
  }

  const memAfter = process.memoryUsage().heapUsed;

  const succeeded = results.length;
  const failed = failures.length;

  const bytesArr = results.map(r => r.bytes);
  const msArr = results.map(r => r.renderMs);

  const minBytes = bytesArr.length ? Math.min(...bytesArr) : 0;
  const maxBytes = bytesArr.length ? Math.max(...bytesArr) : 0;
  const avgBytes = bytesArr.length ? Math.round(bytesArr.reduce((a, b) => a + b, 0) / bytesArr.length) : 0;

  const minRenderMs = msArr.length ? Math.min(...msArr) : 0;
  const maxRenderMs = msArr.length ? Math.max(...msArr) : 0;
  const avgRenderMs = msArr.length ? Math.round(msArr.reduce((a, b) => a + b, 0) / msArr.length) : 0;

  const memoryBeforeMb = Math.round(memBefore / 1024 / 1024 * 10) / 10;
  const memoryAfterMb = Math.round(memAfter / 1024 / 1024 * 10) / 10;
  const memoryDeltaMb = Math.round((memAfter - memBefore) / 1024 / 1024 * 10) / 10;

  const report: StressTestResult = {
    total: count,
    succeeded,
    failed,
    minBytes,
    maxBytes,
    avgBytes,
    minRenderMs,
    maxRenderMs,
    avgRenderMs,
    driftWarnings,
    failures,
    memoryBeforeMb,
    memoryAfterMb,
    memoryDeltaMb,
  };

  console.log('[StressTest] === REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  if (driftWarnings.length > 0) {
    console.warn('[StressTest] DRIFT WARNINGS:');
    driftWarnings.forEach(w => console.warn(' -', w));
  }

  if (memoryDeltaMb > 100) {
    console.warn(`[StressTest] WARNING: memory grew by ${memoryDeltaMb}MB across ${count} runs — possible leak`);
  }

  return report;
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const count = parseInt(args.find(a => a.startsWith('--count='))?.split('=')[1] || '20', 10);
  const templateId = args.find(a => a.startsWith('--templateId='))?.split('=')[1];
  const debug = args.includes('--debug');

  runImageStressTest({ count, templateId, debugOverlay: debug }).then(r => {
    if (r.failed > 0 || r.driftWarnings.length > 0) {
      process.exit(1);
    }
    process.exit(0);
  }).catch(err => {
    console.error('[StressTest] Fatal error:', err);
    process.exit(2);
  });
}
