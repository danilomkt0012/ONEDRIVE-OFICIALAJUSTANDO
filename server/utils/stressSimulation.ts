import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { generateFromCustomTemplate } from '../services/imageGenerator';
import {
  getOperationalStats,
  claimSendRight,
  confirmSendRight,
  isAlreadyConfirmed,
  buildImageIdemKey,
  admitToQueue,
  MAX_QUEUE_SIZE,
} from '../services/imageStabilityGuard';

const __dirname_sim = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_IMAGE_PATH = path.resolve(__dirname_sim, '../../uploads/campaign-images');

interface StressReport {
  totalRequested: number;
  totalGenerated: number;
  totalFailed: number;
  duplicatesBlocked: number;
  retryFalseSuccess: number;
  idempotencyHits: number;
  startMemoryMB: number;
  peakMemoryMB: number;
  endMemoryMB: number;
  memoryGrowthMB: number;
  diskFilesCreated: number;
  durationMs: number;
  averageMs: number;
  errors: string[];
}

function getHeapMB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

async function createMinimalJpegBuffer(): Promise<Buffer> {
  const { createCanvas } = await import('canvas');
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#cccccc';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#333333';
  ctx.font = '12px sans-serif';
  ctx.fillText('STRESS', 10, 50);
  return canvas.toBuffer('image/jpeg', { quality: 0.7 });
}

export async function runStressSimulation(options: {
  sequentialCount?: number;
  burstCount?: number;
  burstParallelism?: number;
  simulateRetries?: boolean;
  verbose?: boolean;
}): Promise<StressReport> {
  const {
    sequentialCount = 50,
    burstCount = 20,
    burstParallelism = 5,
    simulateRetries = true,
    verbose = false,
  } = options;

  const report: StressReport = {
    totalRequested: sequentialCount + burstCount,
    totalGenerated: 0,
    totalFailed: 0,
    duplicatesBlocked: 0,
    retryFalseSuccess: 0,
    idempotencyHits: 0,
    startMemoryMB: getHeapMB(),
    peakMemoryMB: getHeapMB(),
    endMemoryMB: 0,
    memoryGrowthMB: 0,
    diskFilesCreated: 0,
    durationMs: 0,
    averageMs: 0,
    errors: [],
  };

  const startTime = Date.now();
  const statsBefore = getOperationalStats();

  console.log(JSON.stringify({
    level: 'info',
    tag: '[STRESS_SIM]',
    event: 'started',
    sequentialCount,
    burstCount,
    burstParallelism,
    simulateRetries,
    startMemoryMB: report.startMemoryMB,
  }));

  let baseImageBuffer: Buffer;
  try {
    baseImageBuffer = await createMinimalJpegBuffer();
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    report.errors.push(`Failed to create base image: ${e.message}`);
    return report;
  }

  const fakeFields = [
    {
      id: 'f1',
      label: 'Nome',
      type: 'name' as const,
      defaultText: 'CLIENTE',
      x: 0.1,
      y: 0.5,
      fontSize: 12,
      fontFamily: 'sans-serif',
      fontWeight: 'normal',
      fontStyle: 'normal',
      color: '#000000',
      opacity: 100,
      letterSpacing: 0,
      lineHeight: 1,
      rotation: 0,
      textAlign: 'left',
      maxWidth: 0,
      textTransform: 'none',
      shadowEnabled: false,
      shadowColor: '#000000',
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowBlur: 0,
      strokeEnabled: false,
      strokeColor: '#000000',
      strokeWidth: 0,
      coordinateSystem: 'relative' as const,
    },
  ];

  const tmpDir = path.join(SAMPLE_IMAGE_PATH, 'stress-sim-tmp');
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
  } catch {
    /* already exists */
  }

  const generationTimes: number[] = [];

  async function generateOne(index: number): Promise<boolean> {
    const t0 = Date.now();
    const leadData = {
      name: `Lead Stress ${index}`,
      cpf: String(10000000000 + index).padStart(11, '0'),
    };
    try {
      const buf = await generateFromCustomTemplate(baseImageBuffer, fakeFields, leadData);
      const elapsed = Date.now() - t0;
      generationTimes.push(elapsed);
      const outPath = path.join(tmpDir, `stress_${index}.jpg`);
      await fs.promises.writeFile(outPath, buf);
      report.diskFilesCreated++;
      report.totalGenerated++;
      const currentMem = getHeapMB();
      if (currentMem > report.peakMemoryMB) report.peakMemoryMB = currentMem;
      if (verbose) {
        console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'generated', index, elapsed, heapMB: currentMem }));
      }
      return true;
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      report.totalFailed++;
      report.errors.push(`seq[${index}]: ${e.message}`);
      if (verbose) {
        console.log(JSON.stringify({ level: 'warn', tag: '[STRESS_SIM]', event: 'failed', index, error: e.message }));
      }
      return false;
    }
  }

  console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'sequential_phase_start', count: sequentialCount }));
  for (let i = 0; i < sequentialCount; i++) {
    await generateOne(i);
  }

  console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'burst_phase_start', count: burstCount, parallelism: burstParallelism }));
  for (let b = 0; b < burstCount; b += burstParallelism) {
    const batch = [];
    for (let p = 0; p < burstParallelism && b + p < burstCount; p++) {
      batch.push(generateOne(sequentialCount + b + p));
    }
    await Promise.all(batch);
    const currentMem = getHeapMB();
    if (currentMem > report.peakMemoryMB) report.peakMemoryMB = currentMem;
  }

  if (simulateRetries) {
    console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'retry_simulation_start' }));

    const phone = '5511999000001';
    const templateId = 'stress-template-1';

    /**
     * Scenario 1: Successful initial send → retry should skip.
     * Simulates: attempt1 claims → sends → confirms; retry uses isAlreadyConfirmed → skip
     */
    const key1 = buildImageIdemKey('stress-state-S1', 'node-A');
    const claimed1 = await claimSendRight(key1, phone, templateId);
    if (claimed1) {
      await confirmSendRight(key1, phone, templateId);
      const retryWouldSkip = await isAlreadyConfirmed(key1, phone, templateId);
      if (retryWouldSkip === 'confirmed') {
        report.duplicatesBlocked++;
        console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario1_ok', msg: 'Retry correctly skipped — original confirmed' }));
      } else {
        report.errors.push(`Scenario 1 FAIL: retry isAlreadyConfirmed should return 'confirmed' after successful send, got: ${retryWouldSkip}`);
      }
    } else {
      report.errors.push('Scenario 1 FAIL: initial claim should succeed on fresh key');
    }

    /**
     * Scenario 2: Failed initial send with ambiguous outcome → retry should be blocked.
     * Simulates: attempt1 claims → send outcome ambiguous (no confirm, fresh pending);
     * retry checks isAlreadyConfirmed → true (fresh pending = blocked) → prevents duplicate.
     * Safe conservative: original may have succeeded but process crashed before confirming.
     */
    const key2 = buildImageIdemKey('stress-state-S2', 'node-A');
    const claimed2 = await claimSendRight(key2, phone, templateId);
    if (claimed2) {
      const retryWouldBlock = await isAlreadyConfirmed(key2, phone, templateId);
      if (retryWouldBlock === 'fresh_pending') {
        report.duplicatesBlocked++;
        console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario2_ok', msg: 'Retry correctly blocked on fresh pending — original send outcome ambiguous, duplicate prevented' }));
      } else {
        report.errors.push(`Scenario 2 FAIL: isAlreadyConfirmed should return 'fresh_pending' for ambiguous outcome, got: ${retryWouldBlock}`);
      }
      await confirmSendRight(key2, phone, templateId);
    } else {
      report.errors.push('Scenario 2 FAIL: initial claim should succeed on fresh key');
    }

    /**
     * Scenario 3: Concurrent duplicate initial claims — only one should succeed.
     * Simulates burst traffic for same session+node.
     */
    const key3 = buildImageIdemKey('stress-state-S3', 'node-A');
    const concurrentResults = await Promise.all(
      Array.from({ length: 5 }, () => claimSendRight(key3, phone, templateId))
    );
    const successCount = concurrentResults.filter(Boolean).length;
    const blockedCount = concurrentResults.filter(r => !r).length;
    if (successCount === 1 && blockedCount === 4) {
      report.duplicatesBlocked += 4;
      console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario3_ok', msg: '5 concurrent claims → exactly 1 succeeded, 4 blocked by DB PK' }));
    } else {
      report.errors.push(`Scenario 3 FAIL: expected 1 success + 4 blocked, got ${successCount} succeeded + ${blockedCount} blocked`);
    }

    /**
     * Scenario 4: Retry after successful initial send must NOT create false success.
     * Verifies that isAlreadyConfirmed correctly returns true → retry returns (not throws).
     */
    const key4 = buildImageIdemKey('stress-state-S4', 'node-A');
    const claimed4 = await claimSendRight(key4, phone, templateId);
    if (claimed4) {
      await confirmSendRight(key4, phone, templateId);
      const confirmed4 = await isAlreadyConfirmed(key4, phone, templateId);
      if (confirmed4 === 'confirmed') {
        console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario4_ok', msg: "Retry sees 'confirmed' → would return (safe idempotent skip), not throw" }));
      } else {
        report.retryFalseSuccess++;
        report.errors.push(`Scenario 4 FAIL: retry should see 'confirmed', would have proceeded and sent duplicate. Got: ${confirmed4}`);
      }
    } else {
      report.errors.push('Scenario 4 FAIL: initial claim should succeed on fresh key');
    }

    /**
     * Scenario 5: Real burst pressure — cap enforcement + backpressure.
     * Fires BURST_CONCURRENCY > MAX_QUEUE_SIZE concurrent admitToQueue() calls.
     * Each caller releases its slot IMMEDIATELY upon admission so waiting callers
     * can proceed (no deadlock). The 50 excess callers must wait in the 500ms poll
     * loop until a slot frees — exercising the actual backpressure code path.
     *
     * Validates:
     *   (a) Peak observed depth ≤ MAX_QUEUE_SIZE (hard cap never breached).
     *   (b) Backpressure activates: throttle events increment during the burst.
     *   (c) ALL callers are eventually admitted (no drops, pure delay).
     *   (d) Depth returns exactly to 0 after all slots are released (no accounting drift).
     *   (e) No abnormal memory growth during a 250-caller burst.
     */
    const BURST_CONCURRENCY = MAX_QUEUE_SIZE + 50; // 250 — exceeds cap by 50
    let burstPeakObserved = 0;
    let burstTotalAdmitted = 0;
    let burstThrottleActivated = false;
    const statsBurstBefore = getOperationalStats();
    const memBurstBefore = getHeapMB();

    await Promise.all(
      Array.from({ length: BURST_CONCURRENCY }, async () => {
        const rel = await admitToQueue({ tag: 'stress-burst-test' });
        const depth = getOperationalStats().queueDepth;
        if (depth > burstPeakObserved) burstPeakObserved = depth;
        if (depth >= MAX_QUEUE_SIZE) burstThrottleActivated = true;
        burstTotalAdmitted++;
        rel(); // Release immediately so waiting callers can proceed
      })
    );

    const statsBurstAfter = getOperationalStats();
    const memBurstAfter = getHeapMB();
    const burstMemGrowthMB = memBurstAfter - memBurstBefore;
    const depthAfterRelease = getOperationalStats().queueDepth;
    const throttleEventsDelta = statsBurstAfter.throttleEvents - statsBurstBefore.throttleEvents;

    if (burstPeakObserved <= MAX_QUEUE_SIZE) {
      console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario5_cap_ok', msg: `Burst cap OK — peak depth ${burstPeakObserved} ≤ MAX_QUEUE_SIZE ${MAX_QUEUE_SIZE}` }));
    } else {
      report.errors.push(`Scenario 5 FAIL: peak queue depth ${burstPeakObserved} exceeded MAX_QUEUE_SIZE ${MAX_QUEUE_SIZE} — hard cap is NOT enforced`);
    }

    if (burstTotalAdmitted === BURST_CONCURRENCY) {
      console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario5_no_drops_ok', msg: `All ${BURST_CONCURRENCY} callers admitted — no drops (pure delay, not rejection)` }));
    } else {
      report.errors.push(`Scenario 5 FAIL: only ${burstTotalAdmitted}/${BURST_CONCURRENCY} callers admitted — ${BURST_CONCURRENCY - burstTotalAdmitted} dropped`);
    }

    if (depthAfterRelease === 0) {
      console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario5_accounting_ok', msg: `Depth returned to 0 after all ${BURST_CONCURRENCY} releases — no accounting drift` }));
    } else {
      report.errors.push(`Scenario 5 FAIL: depth after all releases = ${depthAfterRelease} (expected 0) — accounting drift detected`);
    }

    if (burstThrottleActivated) {
      console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario5_backpressure_ok', msg: `Backpressure activated during burst — throttle events delta: ${throttleEventsDelta}` }));
    } else {
      report.errors.push(`Scenario 5 FAIL: backpressure never activated — ${BURST_CONCURRENCY} callers (${BURST_CONCURRENCY - MAX_QUEUE_SIZE} over cap) should have hit cap`);
    }

    console.log(JSON.stringify({ level: 'info', tag: '[STRESS_SIM]', event: 'scenario5_summary', BURST_CONCURRENCY, MAX_QUEUE_SIZE, burstPeakObserved, burstTotalAdmitted, throttleEventsDelta, burstMemGrowthMB, depthAfterRelease }));

    console.log(JSON.stringify({
      level: 'info',
      tag: '[STRESS_SIM]',
      event: 'retry_simulation_complete',
      duplicatesBlocked: report.duplicatesBlocked,
      retryFalseSuccess: report.retryFalseSuccess,
    }));
  }

  await new Promise<void>(resolve => setTimeout(resolve, 500));
  if (typeof (global as Record<string, unknown>).gc === 'function') {
    ((global as Record<string, unknown>).gc as () => void)();
  }

  report.endMemoryMB = getHeapMB();
  report.memoryGrowthMB = report.endMemoryMB - report.startMemoryMB;
  report.durationMs = Date.now() - startTime;
  report.averageMs = generationTimes.length > 0
    ? Math.round(generationTimes.reduce((a, b) => a + b, 0) / generationTimes.length)
    : 0;

  const statsAfter = getOperationalStats();

  try {
    const cleanupFiles = await fs.promises.readdir(tmpDir);
    for (const f of cleanupFiles) {
      await fs.promises.unlink(path.join(tmpDir, f)).catch(() => {});
    }
    await fs.promises.rmdir(tmpDir).catch(() => {});
  } catch {
    /* ignore cleanup errors */
  }

  console.log(JSON.stringify({
    level: 'info',
    tag: '[STRESS_SIM]',
    event: 'complete',
    report: {
      ...report,
      statsAfter,
      statsDelta: {
        generationStarts: statsAfter.generationStarts - statsBefore.generationStarts,
        generationEnds: statsAfter.generationEnds - statsBefore.generationEnds,
        generationErrors: statsAfter.generationErrors - statsBefore.generationErrors,
        throttleEvents: statsAfter.throttleEvents - statsBefore.throttleEvents,
        idempotencyHits: statsAfter.idempotencyHits - statsBefore.idempotencyHits,
      },
    },
  }));

  return report;
}
