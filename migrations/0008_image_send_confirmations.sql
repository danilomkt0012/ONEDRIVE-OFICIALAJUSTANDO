CREATE TABLE IF NOT EXISTS "image_send_confirmations" (
  "message_id" text PRIMARY KEY,
  "phone" text NOT NULL,
  "template_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "claimed_at" timestamp NOT NULL DEFAULT now(),
  "confirmed_at" timestamp,
  "expires_at" timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_isc_expires_at" ON "image_send_confirmations" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_isc_phone" ON "image_send_confirmations" ("phone");
CREATE INDEX IF NOT EXISTS "idx_isc_status" ON "image_send_confirmations" ("status");
