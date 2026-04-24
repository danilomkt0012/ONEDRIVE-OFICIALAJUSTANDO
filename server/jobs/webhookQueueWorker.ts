import { db } from "../db";
import { wabaHooks } from "@shared/schema";
import { eq, and, lt, asc, sql } from "drizzle-orm";
import { logError } from "../utils/logger";

const POLL_INTERVAL_MS = 10000;
const BATCH_SIZE = 50;
const STALE_THRESHOLD_MS = 30000;
const MAX_RETRY_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5000;

let workerTimer: ReturnType<typeof setInterval> | null = null;
let processingCallback: ((hook: any) => Promise<void>) | null = null;

function computeBackoffMs(retryCount: number): number {
  const delay = BASE_BACKOFF_MS * Math.pow(2, retryCount);
  return Math.min(delay, 300_000);
}

/**
 * Atomically claim a batch of eligible hooks using SELECT FOR UPDATE SKIP LOCKED.
 * Returns a list of hook rows that this worker exclusively owns for processing.
 */
async function claimEligibleHooks(): Promise<any[]> {
  const cutoffTs = Date.now() - STALE_THRESHOLD_MS;
  const nowMs = Date.now();

  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      SELECT id, entry, meta_message_id, retry_count, last_attempt_at, is_dead_letter
      FROM waba_hooks
      WHERE processed = false
        AND is_dead_letter = false
        AND ts_received < to_timestamp(${cutoffTs / 1000})
        AND (
          last_attempt_at IS NULL
          OR EXTRACT(EPOCH FROM (now() - last_attempt_at)) * 1000
             >= ${BASE_BACKOFF_MS}::float * power(2, GREATEST(retry_count - 1, 0))
        )
      ORDER BY ts_received ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `);

    const rows: Record<string, unknown>[] = result.rows || [];
    if (rows.length === 0) return [];

    const claimedAt = new Date(nowMs);
    const ids = rows.map((r) => String(r.id));
    await tx.execute(sql`
      UPDATE waba_hooks
      SET last_attempt_at = ${claimedAt}
      WHERE id = ANY(${ids}::text[])
    `);

    return rows;
  });
}

async function processUnprocessedHooks(): Promise<void> {
  try {
    const hooks = await claimEligibleHooks();
    if (hooks.length === 0) return;

    const now = new Date();
    const results = await Promise.allSettled(
      hooks.map(async (hook) => {
        const hookId = hook.id as string;
        const retryCount = Number(hook.retry_count ?? 0);
        const metaMessageId = hook.meta_message_id as string | null;
        const hookStartMs = Date.now();

        try {
          if (processingCallback) {
            const fullHook = {
              id: hookId,
              entry: hook.entry,
              metaMessageId,
              retryCount,
              lastAttemptAt: hook.last_attempt_at,
              isDeadLetter: hook.is_dead_letter,
            };
            await processingCallback(fullHook);
          }
          await db
            .update(wabaHooks)
            .set({ processed: true, lastAttemptAt: now })
            .where(eq(wabaHooks.id, hookId));
          console.log(`[WebhookWorker] hookId=${hookId} metaMessageId=${metaMessageId ?? 'N/A'} result=success elapsed_ms=${Date.now() - hookStartMs}`);
        } catch (err: any) {
          const newRetryCount = retryCount + 1;
          const isDeadLetter = newRetryCount >= MAX_RETRY_ATTEMPTS;

          await db
            .update(wabaHooks)
            .set({
              retryCount: newRetryCount,
              lastError: err?.message ?? 'Unknown error',
              lastAttemptAt: now,
              isDeadLetter: isDeadLetter,
            })
            .where(eq(wabaHooks.id, hookId));

          console.log(`[WebhookWorker] hookId=${hookId} metaMessageId=${metaMessageId ?? 'N/A'} result=fail retryCount=${newRetryCount} isDeadLetter=${isDeadLetter} elapsed_ms=${Date.now() - hookStartMs}`);
          if (isDeadLetter) {
            logError("webhookworker.deadLetter", {
              hookId,
              retryCount: newRetryCount,
              metaMessageId,
            }, err);
          } else {
            const nextDelay = computeBackoffMs(newRetryCount);
            logError("webhookworker.retryScheduled", {
              hookId,
              retryCount: newRetryCount,
              nextRetryInMs: nextDelay,
              metaMessageId,
            }, err);
          }
          throw err;
        }
      })
    );

    let failed = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        failed++;
      }
    }

    console.log(`[WebhookWorker] Processed ${hooks.length} hook(s)${failed > 0 ? ` (${failed} failed/retried)` : ''}`);
  } catch (err: any) {
    logError("webhookworker.fetchBatch", {}, err);
  }
}

export function setWebhookProcessingCallback(cb: (hook: any) => Promise<void>): void {
  processingCallback = cb;
}

export function startWebhookQueueWorker(): void {
  if (workerTimer) return;
  console.log(`[WebhookWorker] Starting persistent webhook queue worker with DLQ support (poll every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_RETRY_ATTEMPTS} retries, exponential backoff, SELECT FOR UPDATE SKIP LOCKED)`);
  workerTimer = setInterval(() => {
    processUnprocessedHooks().catch(err => logError('webhookQueueWorker.poll', {}, err));
  }, POLL_INTERVAL_MS);
  if (workerTimer && typeof workerTimer.unref === 'function') {
    workerTimer.unref();
  }
}

export function stopWebhookQueueWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
