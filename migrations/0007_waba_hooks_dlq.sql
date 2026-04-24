-- T1: Add DLQ (Dead Letter Queue) support fields to waba_hooks
-- Each webhook event is persisted as its own row (including multiple status events
-- for the same meta_message_id). Dedup happens at processing time, not at DB level.
-- Safe to apply on existing databases - uses IF NOT EXISTS throughout.

-- Step 1: Drop old non-unique index (will be recreated below)
DROP INDEX IF EXISTS "idx_waba_hooks_meta_message_id";
DROP INDEX IF EXISTS "idx_waba_hooks_meta_message_id_unique";

-- Step 2: Add DLQ tracking columns (idempotent)
ALTER TABLE "waba_hooks" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "waba_hooks" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "waba_hooks" ADD COLUMN IF NOT EXISTS "is_dead_letter" boolean DEFAULT false;
ALTER TABLE "waba_hooks" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;

-- Step 3: Non-unique index for fast lookup by meta_message_id (multiple events per messageId allowed)
CREATE INDEX IF NOT EXISTS "idx_waba_hooks_meta_message_id" ON "waba_hooks" ("meta_message_id");

-- Step 4: Supporting composite/scalar indexes
CREATE INDEX IF NOT EXISTS "idx_waba_hooks_processed_ts" ON "waba_hooks" ("processed", "ts_received");
CREATE INDEX IF NOT EXISTS "idx_waba_hooks_dead_letter" ON "waba_hooks" ("is_dead_letter");
