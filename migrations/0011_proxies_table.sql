CREATE TABLE IF NOT EXISTS "proxies" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "url" text NOT NULL,
        "label" text,
        "is_active" boolean DEFAULT true NOT NULL,
        "latency_ms" integer,
        "last_checked_at" timestamp,
        "created_at" timestamp DEFAULT now(),
        "updated_at" timestamp DEFAULT now(),
        CONSTRAINT "proxies_url_unique" UNIQUE("url")
);
