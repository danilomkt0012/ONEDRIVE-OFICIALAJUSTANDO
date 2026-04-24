import { db } from '../db';
import { imageSendConfirmations } from '@shared/schema';
import { eq, lt, and } from 'drizzle-orm';
import { logError } from '../utils/logger';

const DEBUG_MEMORY = process.env.IMAGE_DEBUG_MEMORY === 'true';

const CONFIRMATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * If a `pending` claim is older than this, it is considered stale.
 * A stale pending indicates the original process crashed or timed out before confirming.
 * Stale claims are reclaimed so delivery can be retried.
 */
const PENDING_CLAIM_TTL_MS = 2 * 60 * 1000;

export const MAX_QUEUE_SIZE = 200;
const BURST_THROTTLE_DELAY_MS = 500;

let currentQueueDepth = 0;
let throttleEvents = 0;
let idempotencyHits = 0;
let generationStarts = 0;
let generationEnds = 0;
let generationErrors = 0;

function logImageEvent(
  level: 'info' | 'warn' | 'error',
  tag: string,
  details: Record<string, unknown>,
  err?: Error
): void {
  const entry = JSON.stringify({
    level,
    tag: `[IMAGE_STABILITY] ${tag}`,
    ts: new Date().toISOString(),
    queueDepth: currentQueueDepth,
    ...details,
  });
  if (level === 'error' && err) {
    logError(`ImageStability.${tag}`, details as Record<string, string>, err);
  } else if (level === 'warn') {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

export function logGenerationStart(phone: string, templateId?: string): void {
  generationStarts++;
  logImageEvent('info', 'generation_start', {
    event: 'generation_start',
    phone,
    templateId: templateId || 'unknown',
    queueDepth: currentQueueDepth,
  });
  if (DEBUG_MEMORY) {
    const mem = process.memoryUsage();
    logImageEvent('info', 'memory_snapshot', {
      event: 'memory_snapshot',
      phase: 'start',
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(mem.external / 1024 / 1024) + 'MB',
    });
  }
}

export function logGenerationEnd(phone: string, templateId?: string, errorMsg?: string): void {
  generationEnds++;
  if (errorMsg) {
    generationErrors++;
    logImageEvent('error', 'generation_error', {
      event: 'generation_error',
      phone,
      templateId: templateId || 'unknown',
      error: errorMsg,
    }, new Error(errorMsg));
  } else {
    logImageEvent('info', 'generation_end', {
      event: 'generation_end',
      phone,
      templateId: templateId || 'unknown',
    });
  }
  if (DEBUG_MEMORY) {
    const mem = process.memoryUsage();
    logImageEvent('info', 'memory_snapshot', {
      event: 'memory_snapshot',
      phase: 'end',
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
    });
  }
}

export function logQueueEvent(event: 'enqueue' | 'dequeue' | 'throttle', details?: Record<string, unknown>): void {
  if (event === 'enqueue') currentQueueDepth++;
  else if (event === 'dequeue') currentQueueDepth = Math.max(0, currentQueueDepth - 1);
  else throttleEvents++;

  logImageEvent(event === 'throttle' ? 'warn' : 'info', `queue_${event}`, {
    event: `queue_${event}`,
    queueDepth: currentQueueDepth,
    throttleEvents,
    ...details,
  });
}

export function logIdempotencyHit(messageId: string, phone: string, templateId?: string): void {
  idempotencyHits++;
  logImageEvent('warn', 'idempotency_hit', {
    event: 'idempotency_hit',
    messageId,
    phone,
    templateId: templateId ?? 'unknown',
    totalHits: idempotencyHits,
  });
}

export function getOperationalStats(): Record<string, number> {
  return {
    queueDepth: currentQueueDepth,
    throttleEvents,
    idempotencyHits,
    generationStarts,
    generationEnds,
    generationErrors,
  };
}

/**
 * Legacy burst throttle used by imageGenerator.ts.
 * Polls until queue is below cap, then returns.
 */
export async function applyBurstThrottle(): Promise<void> {
  while (currentQueueDepth >= MAX_QUEUE_SIZE) {
    throttleEvents++;
    logImageEvent('warn', 'queue_throttle', {
      event: 'queue_throttle',
      reason: 'queue_cap_reached',
      maxQueueSize: MAX_QUEUE_SIZE,
      currentDepth: currentQueueDepth,
      delayMs: BURST_THROTTLE_DELAY_MS,
    });
    await new Promise<void>(resolve => setTimeout(resolve, BURST_THROTTLE_DELAY_MS));
  }
}

/**
 * Build a session-scoped idempotency key for image template sends.
 * Uses botConversationState.id (UUID) + nodeId so different conversations
 * always get a fresh key and never block each other.
 */
export function buildImageIdemKey(stateId: string, nodeId: string): string {
  return `img_tpl:${stateId}:${nodeId}`;
}

/**
 * Bounded-delay admission gate — throttles callers when at cap (delay, not drop).
 *
 * Increment happens synchronously (before first await) — JS single-threaded event loop
 * guarantees no two concurrent callers simultaneously pass the cap check without seeing
 * the other's increment.
 *
 * When at cap:
 *   - Polls every BURST_THROTTLE_DELAY_MS until a slot opens.
 *   - Callers are DELAYED, not dropped. Natural call-site timeouts (HTTP connection
 *     timeouts from the webhook server) bound how long any single caller waits.
 *
 * Returns a release() function that MUST be called in a finally block.
 */
export async function admitToQueue(details?: Record<string, unknown>): Promise<() => void> {
  let waited = 0;
  while (currentQueueDepth >= MAX_QUEUE_SIZE) {
    throttleEvents++;
    logImageEvent('warn', 'queue_throttle', {
      event: 'queue_throttle',
      reason: 'queue_cap_reached',
      maxQueueSize: MAX_QUEUE_SIZE,
      currentDepth: currentQueueDepth,
      waitedMs: waited,
      delayMs: BURST_THROTTLE_DELAY_MS,
    });
    await new Promise<void>(resolve => setTimeout(resolve, BURST_THROTTLE_DELAY_MS));
    waited += BURST_THROTTLE_DELAY_MS;
  }

  currentQueueDepth++;
  logImageEvent('info', 'queue_enqueue', {
    event: 'queue_enqueue',
    currentDepth: currentQueueDepth,
    ...details,
  });

  return () => {
    currentQueueDepth = Math.max(0, currentQueueDepth - 1);
    logImageEvent('info', 'queue_dequeue', {
      event: 'queue_dequeue',
      currentDepth: currentQueueDepth,
    });
  };
}

/**
 * Claim the right to send an image for the given messageId (initial OR retry attempt).
 *
 * Returns true  — caller has exclusive right to send; MUST call confirmSendRight() after.
 * Returns false — another worker already claimed/confirmed this send; caller MUST skip.
 * Throws        — DB error; caller MUST NOT mark send as successful (propagate failure).
 *
 * Cases:
 *   1. No record:       INSERT pending (atomic PK); returns true — proceed.
 *   2. pending, fresh:  concurrent duplicate (<2 min); returns false — skip safely.
 *   3. pending, stale:  crash recovery (≥2 min), UPDATE compare-and-set; returns true — proceed.
 *   4. confirmed:       already delivered; returns false — skip safely.
 *   5. DB error:        THROWS — do not swallow; caller must surface as failure.
 *
 * Key semantics: `buildImageIdemKey(stateId, nodeId)` — unique per conversation session
 * (stateId = botConversationState UUID) × per flow node (nodeId). A given node within
 * one conversation session sends at most once. New conversation → new stateId → new key.
 */
export async function claimSendRight(
  messageId: string,
  phone: string,
  templateId?: string
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const staleThreshold = new Date(Date.now() - PENDING_CLAIM_TTL_MS);

  try {
    const [existing] = await db
      .select({
        status: imageSendConfirmations.status,
        claimedAt: imageSendConfirmations.claimedAt,
      })
      .from(imageSendConfirmations)
      .where(eq(imageSendConfirmations.messageId, messageId));

    if (!existing) {
      const inserted = await db
        .insert(imageSendConfirmations)
        .values({ messageId, phone, templateId: templateId ?? null, status: 'pending', expiresAt })
        .onConflictDoNothing()
        .returning({ messageId: imageSendConfirmations.messageId });

      if (inserted.length === 0) {
        logImageEvent('warn', 'claim_lost_race', {
          event: 'claim_lost_race',
          messageId,
          phone,
        });
        return false;
      }

      logImageEvent('info', 'send_right_claimed', {
        event: 'send_right_claimed',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
      });
      return true;
    }

    if (existing.status === 'confirmed') {
      logIdempotencyHit(messageId, phone, templateId);
      return false;
    }

    if (existing.status === 'unknown_delivered') {
      // Meta received the message but the confirmation write failed.
      // Treat as delivered — block any reclaim or retry indefinitely.
      logImageEvent('warn', 'claim_blocked_unknown_delivered', {
        event: 'claim_blocked_unknown_delivered',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        reason: 'Message was sent to provider but confirmation persistence failed — blocking retry to prevent duplicate',
      });
      return false;
    }

    if (existing.status === 'pending') {
      const isStale = existing.claimedAt < staleThreshold;
      if (!isStale) {
        logImageEvent('warn', 'claim_concurrent_blocked', {
          event: 'claim_concurrent_blocked',
          messageId,
          phone,
          claimedAt: existing.claimedAt.toISOString(),
        });
        return false;
      }

      const reclaimed = await db
        .update(imageSendConfirmations)
        .set({ claimedAt: new Date(), expiresAt, confirmedAt: null })
        .where(
          and(
            eq(imageSendConfirmations.messageId, messageId),
            eq(imageSendConfirmations.status, 'pending'),
            lt(imageSendConfirmations.claimedAt, staleThreshold)
          )
        )
        .returning({ messageId: imageSendConfirmations.messageId });

      if (reclaimed.length === 0) {
        logImageEvent('warn', 'claim_reclaim_lost_race', {
          event: 'claim_reclaim_lost_race',
          messageId,
          phone,
        });
        return false;
      }

      logImageEvent('warn', 'send_right_reclaimed', {
        event: 'send_right_reclaimed',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        staleSinceMs: Date.now() - existing.claimedAt.getTime(),
      });
      return true;
    }

    return false;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('ImageStability.claimSendRight', { messageId, phone }, e);
    // Re-throw: DB errors must NOT be swallowed as false (which would be treated as
    // a duplicate-skip, silently advancing conversation state with no delivery).
    // Callers must catch this and surface it as a real failure.
    throw e;
  }
}

/**
 * Confirm that a message was successfully sent (pending → confirmed).
 *
 * FAIL-CLOSED: if the primary DB update fails after provider delivery succeeded,
 * we must NOT silently stay pending (which would allow stale-reclaim and duplicate
 * delivery after 2 minutes). Instead:
 *   1. Attempt primary update: pending → confirmed.
 *   2. On DB failure: attempt emergency fallback — pending → unknown_delivered.
 *      unknown_delivered tells claimSendRight() to block all future retries.
 *   3. If fallback also fails: re-throw so the caller can surface the error.
 *      The caller MUST NOT mark this as sendSuccess — but MUST NOT retry the send
 *      (Meta may have already received it).
 */
export async function confirmSendRight(
  messageId: string,
  phone: string,
  templateId?: string
): Promise<void> {
  const now = new Date();
  try {
    const updated = await db
      .update(imageSendConfirmations)
      .set({ status: 'confirmed', confirmedAt: now })
      .where(
        and(
          eq(imageSendConfirmations.messageId, messageId),
          eq(imageSendConfirmations.status, 'pending')
        )
      )
      .returning({ messageId: imageSendConfirmations.messageId });

    if (updated.length === 0) {
      logImageEvent('warn', 'confirm_noop', {
        event: 'confirm_noop',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        reason: 'No pending row found — may already be confirmed, unknown_delivered, or expired',
      });
      return;
    }

    logImageEvent('info', 'send_right_confirmed', {
      event: 'send_right_confirmed',
      messageId,
      phone,
      templateId: templateId ?? 'unknown',
      confirmedAt: now.toISOString(),
    });
  } catch (primaryErr: unknown) {
    const pe = primaryErr instanceof Error ? primaryErr : new Error(String(primaryErr));
    logError('ImageStability.confirmSendRight.primary_failed', { messageId, phone }, pe);

    // Emergency fallback: mark as unknown_delivered to block stale-pending reclaim.
    // This prevents duplicate sends even if the confirmed write cannot be persisted.
    try {
      await db
        .update(imageSendConfirmations)
        .set({ status: 'unknown_delivered' })
        .where(eq(imageSendConfirmations.messageId, messageId));

      logImageEvent('warn', 'confirm_fallback_unknown_delivered', {
        event: 'confirm_fallback_unknown_delivered',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        reason: 'Primary confirm failed; row marked unknown_delivered to block retry',
        primaryError: pe.message,
      });
    } catch (fallbackErr: unknown) {
      const fe = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
      logError('ImageStability.confirmSendRight.fallback_failed', { messageId, phone }, fe);
      // Both writes failed — DB is likely down. Re-throw so callers do not advance
      // conversation state as if delivery was confirmed.
      throw pe;
    }
  }
}

/**
 * Release a `pending` send claim so the retry can immediately reclaim it.
 *
 * This is called after a caught first-attempt failure (upload or send throws)
 * so that the 2-second retry path can run claimSendRight() and succeed
 * rather than hitting `fresh_pending` (which would block it).
 *
 * Safety: only deletes the row when status is still `pending`.
 * Rows with status `confirmed` or `unknown_delivered` are NEVER touched
 * — they represent a message that reached the provider and must stay protected.
 */
export async function releaseSendRight(
  messageId: string,
  phone: string,
  templateId?: string
): Promise<void> {
  try {
    const deleted = await db
      .delete(imageSendConfirmations)
      .where(
        and(
          eq(imageSendConfirmations.messageId, messageId),
          eq(imageSendConfirmations.status, 'pending')
        )
      )
      .returning({ messageId: imageSendConfirmations.messageId });

    if (deleted.length > 0) {
      logImageEvent('info', 'send_right_released', {
        event: 'send_right_released',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        reason: 'First-attempt caught exception — releasing pending claim so retry can reclaim immediately',
      });
    } else {
      logImageEvent('warn', 'send_right_release_noop', {
        event: 'send_right_release_noop',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        reason: 'No pending row found — row may already be confirmed, unknown_delivered, or never inserted',
      });
    }
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('ImageStability.releaseSendRight', { messageId, phone }, e);
  }
}

/**
 * Gate check for the RETRY path.
 *
 * Blocks retry (returns non-false) in three cases:
 *   1. Status is 'confirmed' — original send was delivered and confirmed.
 *   2. Status is 'unknown_delivered' — Meta received the message but confirmation
 *      persistence failed; treat as delivered; block all future retries permanently.
 *   3. Status is 'pending' AND the claim is fresh (< PENDING_CLAIM_TTL_MS old) —
 *      the original attempt may have succeeded at the provider but crashed before
 *      persisting the confirmation. Blocking the retry prevents a possible duplicate.
 *
 * Returns:
 *   'confirmed'    — message was definitively delivered; caller may treat as success.
 *   'fresh_pending'— outcome is ambiguous (< 2 min old); caller must NOT mark as success
 *                    but must NOT retry either (prevent duplicate delivery).
 *   false          — allow retry (no record, or stale pending ≥ 2 min).
 */
export async function isAlreadyConfirmed(
  messageId: string,
  phone: string,
  templateId?: string
): Promise<'confirmed' | 'fresh_pending' | false> {
  const staleThreshold = new Date(Date.now() - PENDING_CLAIM_TTL_MS);
  try {
    const [row] = await db
      .select({ status: imageSendConfirmations.status, claimedAt: imageSendConfirmations.claimedAt })
      .from(imageSendConfirmations)
      .where(eq(imageSendConfirmations.messageId, messageId));

    if (!row) {
      return false;
    }

    if (row.status === 'confirmed') {
      logIdempotencyHit(messageId, phone, templateId);
      return 'confirmed';
    }

    if (row.status === 'unknown_delivered') {
      // Meta received the message but DB confirmation persistence failed.
      // Treat as delivered to block retry permanently and prevent duplicate.
      logImageEvent('warn', 'retry_blocked_unknown_delivered', {
        event: 'retry_blocked_unknown_delivered',
        messageId,
        phone,
        templateId: templateId ?? 'unknown',
        reason: 'Message was sent to provider but confirmation persistence failed — retry permanently blocked',
      });
      return 'confirmed';
    }

    if (row.status === 'pending') {
      const isFreshPending = row.claimedAt >= staleThreshold;
      if (isFreshPending) {
        logImageEvent('warn', 'retry_blocked_fresh_pending', {
          event: 'retry_blocked_fresh_pending',
          messageId,
          phone,
          templateId: templateId ?? 'unknown',
          claimedAt: row.claimedAt.toISOString(),
          reason: 'Original send outcome is ambiguous — skipping retry to prevent duplicate delivery',
        });
        return 'fresh_pending';
      }
      return false;
    }

    return false;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('ImageStability.isAlreadyConfirmed', { messageId, phone }, e);
    return false;
  }
}

export async function pruneExpiredConfirmations(): Promise<void> {
  try {
    const now = new Date();
    const result = await db
      .delete(imageSendConfirmations)
      .where(lt(imageSendConfirmations.expiresAt, now));
    const count = (result as unknown as { rowCount?: number })?.rowCount ?? 0;
    logImageEvent('info', 'prune_confirmations', {
      event: 'prune_confirmations',
      removed: count,
    });
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logError('ImageStability.pruneExpiredConfirmations', {}, e);
  }
}

if (DEBUG_MEMORY) {
  setInterval(() => {
    const mem = process.memoryUsage();
    const stats = getOperationalStats();
    logImageEvent('info', 'periodic_memory_report', {
      event: 'periodic_memory_report',
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(mem.external / 1024 / 1024) + 'MB',
      ...stats,
    });
  }, 60 * 1000).unref?.();
}
