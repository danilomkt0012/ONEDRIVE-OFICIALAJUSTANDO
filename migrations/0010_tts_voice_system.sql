CREATE TABLE IF NOT EXISTS "voice_profiles" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar NOT NULL,
  "name" text NOT NULL,
  "gender" text NOT NULL DEFAULT 'feminina',
  "reference_audio_path" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "tts_audio_cache" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "hash" text NOT NULL UNIQUE,
  "file_path" text NOT NULL,
  "voice_profile_id" varchar NOT NULL,
  "text_content" text NOT NULL,
  "is_fixed" boolean DEFAULT false,
  "ttl_days" integer NOT NULL DEFAULT 7,
  "last_used_at" timestamp DEFAULT now(),
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_tts_cache_hash" ON "tts_audio_cache" ("hash");
CREATE INDEX IF NOT EXISTS "idx_tts_cache_last_used" ON "tts_audio_cache" ("last_used_at");

CREATE TABLE IF NOT EXISTS "tts_job_progress" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" varchar NOT NULL,
  "lead_id" varchar,
  "status" text NOT NULL DEFAULT 'pending',
  "audio_path" text,
  "error_message" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_tts_job_campaign" ON "tts_job_progress" ("campaign_id");
