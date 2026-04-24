ALTER TABLE "waba_hooks" ADD COLUMN IF NOT EXISTS "meta_message_id" text;
CREATE INDEX IF NOT EXISTS "idx_waba_hooks_meta_message_id" ON "waba_hooks" ("meta_message_id");
