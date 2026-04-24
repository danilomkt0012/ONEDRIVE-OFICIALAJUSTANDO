ALTER TABLE "bot_conversation_states" ADD COLUMN "last_inbound_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "sender_usage" ADD COLUMN "cooldown_until" timestamp;--> statement-breakpoint
ALTER TABLE "wabas" ADD COLUMN "app_secret" text;