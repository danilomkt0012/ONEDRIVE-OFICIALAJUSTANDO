CREATE TABLE "api_configurations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"meta_token" text NOT NULL,
	"whatsapp_business_id" text NOT NULL,
	"is_valid" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_conversation_states" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" varchar NOT NULL,
	"campaign_id" varchar NOT NULL,
	"phone" text NOT NULL,
	"current_node_id" varchar,
	"variables" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"last_response" text,
	"started_at" timestamp DEFAULT now(),
	"last_activity_at" timestamp DEFAULT now(),
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_flow_nodes" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" varchar NOT NULL,
	"node_type" text DEFAULT 'message' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"label" text,
	"message_content" text,
	"message_type" text DEFAULT 'text',
	"media_url" text,
	"button_payload" jsonb,
	"conditions" jsonb DEFAULT '[]'::jsonb,
	"default_next_node_id" varchar,
	"timeout_minutes" integer,
	"timeout_action" text DEFAULT 'end',
	"timeout_next_node_id" varchar,
	"timeout_message" text,
	"delay_seconds" integer DEFAULT 3,
	"variable_capture" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_flows" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"name" text DEFAULT 'Fluxo principal' NOT NULL,
	"is_active" boolean DEFAULT false,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_rules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"keyword" text NOT NULL,
	"response" text NOT NULL,
	"response_type" text DEFAULT 'text',
	"media_url" text,
	"button_payload" jsonb,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_settings" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"is_active" boolean DEFAULT false,
	"fallback_message" text,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "bot_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_automation_rules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"keyword" text NOT NULL,
	"response" text NOT NULL,
	"response_type" text DEFAULT 'text',
	"media_url" text,
	"button_payload" jsonb,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "campaign_error_logs" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"phone" text,
	"phone_number_id" text,
	"count" integer DEFAULT 1 NOT NULL,
	"last_occurred_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"waba_id" varchar,
	"name" text NOT NULL,
	"description" text,
	"lead_list_id" varchar,
	"template_id" varchar,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_leads" integer DEFAULT 0,
	"sent_count" integer DEFAULT 0,
	"failed_count" integer DEFAULT 0,
	"sent_messages" integer DEFAULT 0,
	"success_messages" integer DEFAULT 0,
	"failed_messages" integer DEFAULT 0,
	"delivered_count" integer DEFAULT 0,
	"read_count" integer DEFAULT 0,
	"replied_count" integer DEFAULT 0,
	"estimated_time" text,
	"is_test_mode" boolean DEFAULT false,
	"conversion_message" text,
	"conversion_link" text,
	"conversion_delay_ms" integer DEFAULT 0,
	"conversions_sent" integer DEFAULT 0,
	"burst_mode" boolean DEFAULT false,
	"business_hours_only" boolean DEFAULT false,
	"business_hours_start" integer DEFAULT 8,
	"business_hours_end" integer DEFAULT 20,
	"automation_enabled" boolean DEFAULT false,
	"automation_fallback" text DEFAULT 'silence',
	"scheduled_at" timestamp,
	"campaign_config" jsonb,
	"waba_config" jsonb,
	"send_config" jsonb,
	"bot_config" jsonb,
	"template_ids" jsonb,
	"selected_numbers" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"waba_id" varchar NOT NULL,
	"campaign_id" varchar,
	"contact_phone" text NOT NULL,
	"contact_name" text,
	"phone_number_id" text,
	"csw_expires_at" timestamp,
	"last_message_at" timestamp DEFAULT now(),
	"last_message_preview" text,
	"unread_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "csw_sessions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"campaign_id" varchar,
	"phone_number_id" text,
	"last_inbound_at" timestamp DEFAULT now() NOT NULL,
	"window_expires_at" timestamp NOT NULL,
	"conversion_sent" boolean DEFAULT false,
	"conversion_sent_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "daily_message_counters" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"tier_limit" integer DEFAULT 1000 NOT NULL,
	"tier" text DEFAULT 'TIER_1K' NOT NULL,
	"window_start" timestamp DEFAULT now() NOT NULL,
	"window_end" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "follow_up_rules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"stage" integer DEFAULT 1 NOT NULL,
	"delay_minutes" integer DEFAULT 1440 NOT NULL,
	"template_name" text,
	"message_text" text,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "follow_up_status" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"phone" text NOT NULL,
	"current_stage" integer DEFAULT 0 NOT NULL,
	"last_follow_up_at" timestamp,
	"next_follow_up_at" timestamp,
	"has_replied" boolean DEFAULT false,
	"is_completed" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "image_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"base_image_path" text NOT NULL,
	"base_image_url" text,
	"base_image_data" text,
	"width" integer DEFAULT 0 NOT NULL,
	"height" integer DEFAULT 0 NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lead_lists" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"total_leads" integer NOT NULL,
	"valid_leads" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "lead_pool" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text NOT NULL,
	"cpf" text,
	"list_id" varchar NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"consumed_at" timestamp,
	CONSTRAINT "lead_pool_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "lead_pool_lists" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"total_uploaded" integer DEFAULT 0 NOT NULL,
	"total_valid" integer DEFAULT 0 NOT NULL,
	"total_rejected" integer DEFAULT 0 NOT NULL,
	"total_available" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_list_id" varchar NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"cpf" text,
	"endereco" text,
	"produto" text,
	"valor" text,
	"codigo_rastreio" text,
	"is_valid" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "message_deliveries" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" varchar NOT NULL,
	"lead_id" varchar NOT NULL,
	"phone_number" text NOT NULL,
	"message_id" text,
	"status" text NOT NULL,
	"error_message" text,
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "message_status" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" text,
	"msg_id" text NOT NULL,
	"phone" text NOT NULL,
	"status" text NOT NULL,
	"ts" timestamp DEFAULT now(),
	CONSTRAINT "message_status_msg_id_unique" UNIQUE("msg_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" varchar NOT NULL,
	"direction" text NOT NULL,
	"body" text,
	"type" text DEFAULT 'text',
	"media_url" text,
	"meta_message_id" text,
	"status" text DEFAULT 'sent',
	"sent_at" timestamp DEFAULT now(),
	"delivered_at" timestamp,
	"read_at" timestamp,
	CONSTRAINT "messages_meta_message_id_unique" UNIQUE("meta_message_id")
);
--> statement-breakpoint
CREATE TABLE "opt_out_numbers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"reason" text DEFAULT 'blocked' NOT NULL,
	"error_code" integer,
	"campaign_id" varchar,
	"phone_number_id" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "opt_out_numbers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "parameter_models" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"template_name" text,
	"parameters" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "payment_gateways" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"api_key" text,
	"webhook_url" text,
	"secret_key" text,
	"is_active" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "phone_soft_quotas" (
	"phone_number_id" text PRIMARY KEY NOT NULL,
	"soft_quota" integer DEFAULT 800 NOT NULL,
	"utility_score" integer DEFAULT 0 NOT NULL,
	"batch_unlocked" boolean DEFAULT false,
	"quality_score" integer DEFAULT 100 NOT NULL,
	"last_quality_check" timestamp,
	"is_new_number" boolean DEFAULT true,
	"total_cycles_completed" integer DEFAULT 0 NOT NULL,
	"consecutive_successful_cycles" integer DEFAULT 0 NOT NULL,
	"current_ramp_up_batch" integer DEFAULT 50 NOT NULL,
	"paused_until" timestamp,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "phone_warmup_schedules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_number" text,
	"current_day_limit" integer DEFAULT 50 NOT NULL,
	"target_day_limit" integer DEFAULT 1000 NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"day_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'warming' NOT NULL,
	"last_reset_at" timestamp DEFAULT now(),
	"started_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "phone_warmup_schedules_phone_number_id_unique" UNIQUE("phone_number_id")
);
--> statement-breakpoint
CREATE TABLE "quality_rating_history" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" varchar NOT NULL,
	"quality_rating" text NOT NULL,
	"previous_rating" text,
	"checked_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sender_usage" (
	"phone_number_id" text PRIMARY KEY NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"daily_quota" integer DEFAULT 2000 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"last_sent" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_events" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" varchar NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"gateway" text NOT NULL,
	"customer_name" text,
	"customer_email" text,
	"external_id" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "waba_hooks" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts_received" timestamp DEFAULT now(),
	"object" text,
	"entry" jsonb,
	"processed" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "waba_numbers" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"waba_id" varchar NOT NULL,
	"phone_number_id" text NOT NULL,
	"display_number" text NOT NULL,
	"verified_name" text,
	"quality_rating" text DEFAULT 'UNKNOWN',
	"tier" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "wabas" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"name" text NOT NULL,
	"waba_id" text NOT NULL,
	"bm_id" text,
	"access_token" text NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "warmup_schedules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" varchar NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_day" integer DEFAULT 1 NOT NULL,
	"total_days" integer DEFAULT 7 NOT NULL,
	"daily_targets" jsonb NOT NULL,
	"sent_today" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now(),
	"last_send_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"waba_id" varchar,
	"template_id" text NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"components" jsonb,
	"last_synced" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_campaigns_user_status" ON "campaigns" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_conversations_waba" ON "conversations" USING btree ("waba_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_campaign" ON "conversations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_leads_list" ON "leads" USING btree ("lead_list_id");--> statement-breakpoint
CREATE INDEX "idx_message_deliveries_campaign" ON "message_deliveries" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_message_status_campaign_ts" ON "message_status" USING btree ("campaign_id","ts");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "session" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "idx_waba_hooks_processed_ts" ON "waba_hooks" USING btree ("processed","ts_received");