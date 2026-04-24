/**
 * Structured error logging helper.
 *
 * Every catch block must emit: op (operation name), ctx (sanitized input
 * context), error.message, and error.stack. Use this helper to enforce
 * that contract uniformly across the codebase.
 *
 * Usage:
 *   import { logError } from '../utils/logger';
 *   try { ... } catch (err) { logError('sendMessage', { phone, campaignId }, err); }
 */
export function logError(op: string, ctx: Record<string, unknown>, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error(`[ERROR] op=${op}`, { ...ctx, message: e.message, stack: e.stack });
}

export function logWarn(op: string, ctx: Record<string, unknown>, msg: string): void {
  console.warn(`[WARN] op=${op} ${msg}`, ctx);
}
