import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, jsonb, boolean, serial, json, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const session = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { precision: 6, withTimezone: false }).notNull(),
}, (table) => [
  index("IDX_session_expire").on(table.expire),
]);

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("pending"),
  avatar: text("avatar"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const apiConfigurations = pgTable("api_configurations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  metaToken: text("meta_token").notNull(),
  whatsappBusinessId: text("whatsapp_business_id").notNull(),
  appSecret: text("app_secret"),
  webhookVerifyToken: text("webhook_verify_token"),
  isValid: boolean("is_valid").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const wabas = pgTable("wabas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  wabaId: text("waba_id").notNull(),
  bmId: text("bm_id"),
  accessToken: text("access_token").notNull(),
  appSecret: text("app_secret"),
  isActive: boolean("is_active").default(true),
  subscribedAppsAt: timestamp("subscribed_apps_at"),
  subscribedAppsStatus: text("subscribed_apps_status"),
  lastWebhookReceivedAt: timestamp("last_webhook_received_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const wabaNumbers = pgTable("waba_numbers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  wabaId: varchar("waba_id").notNull(),
  phoneNumberId: text("phone_number_id").notNull(),
  displayNumber: text("display_number").notNull(),
  verifiedName: text("verified_name"),
  qualityRating: text("quality_rating").default("UNKNOWN"),
  tier: text("tier"),
  confidenceScore: integer("confidence_score").default(50),
  scoreUpdatedAt: timestamp("score_updated_at"),
  scoreSamples: integer("score_samples").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const conversations = pgTable("conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  wabaId: varchar("waba_id").notNull(),
  campaignId: varchar("campaign_id"),
  contactPhone: text("contact_phone").notNull(),
  contactWaId: text("contact_wa_id"),
  contactName: text("contact_name"),
  phoneNumberId: text("phone_number_id"),
  cswExpiresAt: timestamp("csw_expires_at"),
  lastMessageAt: timestamp("last_message_at").defaultNow(),
  lastMessagePreview: text("last_message_preview"),
  unreadCount: integer("unread_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_conversations_waba").on(table.wabaId),
  index("idx_conversations_campaign").on(table.campaignId),
  index("idx_conversations_waba_campaign").on(table.wabaId, table.campaignId),
]);

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull(),
  direction: text("direction").notNull(),
  body: text("body"),
  type: text("type").default("text"),
  mediaUrl: text("media_url"),
  metaMessageId: text("meta_message_id").unique(),
  status: text("status").default("sent"),
  sentAt: timestamp("sent_at").defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  readAt: timestamp("read_at"),
}, (table) => [
  index("idx_messages_conversation").on(table.conversationId),
]);

export const campaignAutomationRules = pgTable("campaign_automation_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  keyword: text("keyword").notNull(),
  response: text("response").notNull(),
  responseType: text("response_type").default("text"),
  mediaUrl: text("media_url"),
  buttonPayload: jsonb("button_payload"),
  isActive: boolean("is_active").default(true),
  priority: integer("priority").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const botRules = pgTable("bot_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  keyword: text("keyword").notNull(),
  response: text("response").notNull(),
  responseType: text("response_type").default("text"),
  mediaUrl: text("media_url"),
  buttonPayload: jsonb("button_payload"),
  isActive: boolean("is_active").default(true),
  priority: integer("priority").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const botSettings = pgTable("bot_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  isActive: boolean("is_active").default(false),
  fallbackMessage: text("fallback_message"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const parameterModels = pgTable("parameter_models", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  templateName: text("template_name"),
  parameters: jsonb("parameters").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const leadLists = pgTable("lead_lists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  totalLeads: integer("total_leads").notNull(),
  validLeads: integer("valid_leads").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  leadListId: varchar("lead_list_id").notNull(),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email"),
  cpf: text("cpf"),
  endereco: text("endereco"),
  produto: text("produto"),
  valor: text("valor"),
  codigoRastreio: text("codigo_rastreio"),
  isValid: boolean("is_valid").default(true),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_leads_list").on(table.leadListId),
]);

export const whatsappTemplates = pgTable("whatsapp_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  wabaId: varchar("waba_id"),
  templateId: text("template_id").notNull(),
  name: text("name").notNull(),
  language: text("language").notNull(),
  category: text("category").notNull(),
  status: text("status").notNull(),
  components: jsonb("components"),
  lastSynced: timestamp("last_synced").defaultNow(),
});

export const campaigns = pgTable("campaigns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  wabaId: varchar("waba_id"),
  name: text("name").notNull(),
  description: text("description"),
  leadListId: varchar("lead_list_id"),
  templateId: varchar("template_id"),
  status: text("status").notNull().default("draft"),
  totalLeads: integer("total_leads").default(0),
  sentCount: integer("sent_count").default(0),
  failedCount: integer("failed_count").default(0),
  sentMessages: integer("sent_messages").default(0),
  successMessages: integer("success_messages").default(0),
  failedMessages: integer("failed_messages").default(0),
  deliveredCount: integer("delivered_count").default(0),
  readCount: integer("read_count").default(0),
  repliedCount: integer("replied_count").default(0),
  estimatedTime: text("estimated_time"),
  isTestMode: boolean("is_test_mode").default(false),
  conversionMessage: text("conversion_message"),
  conversionLink: text("conversion_link"),
  conversionDelayMs: integer("conversion_delay_ms").default(0),
  conversionsSent: integer("conversions_sent").default(0),
  burstMode: boolean("burst_mode").default(false),
  dispatchMode: text("dispatch_mode").default("equilibrado"),
  businessHoursOnly: boolean("business_hours_only").default(false),
  businessHoursStart: integer("business_hours_start").default(8),
  businessHoursEnd: integer("business_hours_end").default(20),
  automationEnabled: boolean("automation_enabled").default(false),
  automationFallback: text("automation_fallback").default("silence"),
  scheduledAt: timestamp("scheduled_at"),
  campaignConfig: jsonb("campaign_config"),
  wabaConfig: jsonb("waba_config"),
  sendConfig: jsonb("send_config"),
  botConfig: jsonb("bot_config"),
  templateIds: jsonb("template_ids"),
  selectedNumbers: jsonb("selected_numbers"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_campaigns_user_status").on(table.userId, table.status),
]);

export const messageDeliveries = pgTable("message_deliveries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  leadId: varchar("lead_id").notNull(),
  phoneNumber: text("phone_number").notNull(),
  messageId: text("message_id"),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  sentAt: timestamp("sent_at"),
  deliveredAt: timestamp("delivered_at"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_message_deliveries_campaign").on(table.campaignId),
]);

export const transactions = pgTable("transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  amount: integer("amount").notNull(),
  status: text("status").notNull(),
  gateway: text("gateway").notNull(),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  externalId: text("external_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const transactionEvents = pgTable("transaction_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transactionId: varchar("transaction_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload"),
  receivedAt: timestamp("received_at").defaultNow(),
});

export const dailyMessageCounters = pgTable("daily_message_counters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumberId: text("phone_number_id").notNull(),
  displayPhoneNumber: text("display_phone_number"),
  messageCount: integer("message_count").notNull().default(0),
  tierLimit: integer("tier_limit").notNull().default(1000),
  tier: text("tier").notNull().default('TIER_1K'),
  windowStart: timestamp("window_start").notNull().defaultNow(),
  windowEnd: timestamp("window_end").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const senderUsage = pgTable("sender_usage", {
  phoneNumberId: text("phone_number_id").primaryKey(),
  sentToday: integer("sent_today").notNull().default(0),
  dailyQuota: integer("daily_quota").notNull().default(2000),
  status: text("status").notNull().default('ok'),
  lastSent: timestamp("last_sent").defaultNow(),
  cooldownUntil: timestamp("cooldown_until"),
});

export const frequencyBlacklist = pgTable("frequency_blacklist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phone: text("phone").notNull(),
  reason: text("reason").notNull().default("error_131049"),
  errorCode: integer("error_code"),
  blockedUntil: timestamp("blocked_until").notNull(),
  hitCount: integer("hit_count").notNull().default(1),
  lastHitAt: timestamp("last_hit_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_freq_blacklist_phone").on(table.phone),
  index("idx_freq_blacklist_until").on(table.blockedUntil),
]);

export const senderScoreHistory = pgTable("sender_score_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumberId: text("phone_number_id").notNull(),
  score: integer("score").notNull(),
  deliveredRate: integer("delivered_rate"),
  errorRate: integer("error_rate"),
  reason: text("reason"),
  recordedAt: timestamp("recorded_at").defaultNow(),
}, (table) => [
  index("idx_sender_score_phone_time").on(table.phoneNumberId, table.recordedAt),
]);

export const paymentGateways = pgTable("payment_gateways", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  apiKey: text("api_key"),
  webhookUrl: text("webhook_url"),
  secretKey: text("secret_key"),
  isActive: boolean("is_active").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Insert schemas
export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  email: true,
  phone: true,
});

export const insertApiConfigurationSchema = createInsertSchema(apiConfigurations).pick({
  metaToken: true,
  whatsappBusinessId: true,
  appSecret: true,
  webhookVerifyToken: true,
});

export const insertLeadListSchema = createInsertSchema(leadLists).pick({
  name: true,
  filePath: true,
  totalLeads: true,
  validLeads: true,
  status: true,
});

export const insertLeadSchema = createInsertSchema(leads).pick({
  leadListId: true,
  name: true,
  phone: true,
  email: true,
  cpf: true,
  endereco: true,
  produto: true,
  valor: true,
  codigoRastreio: true,
  isValid: true,
});

export const insertCampaignSchema = createInsertSchema(campaigns).pick({
  name: true,
  leadListId: true,
  templateId: true,
  totalLeads: true,
  isTestMode: true,
}).extend({
  name: z.string().min(1, "Nome da campanha obrigatorio"),
  description: z.string().max(500).optional(),
  leadListId: z.string().optional(),
  templateId: z.string().optional(),
  totalLeads: z.number().optional(),
  wabaId: z.string().optional(),
  wabaConfig: z.record(z.unknown()).optional(),
  sendConfig: z.record(z.unknown()).optional(),
  botConfig: z.record(z.unknown()).optional(),
  templateIds: z.array(z.string()).optional(),
  selectedNumbers: z.array(z.record(z.unknown())).optional(),
  conversionMessage: z.string().max(1024).optional(),
  conversionLink: z.string().url().optional().or(z.literal("")),
  conversionDelayMs: z.number().min(0).max(300000).optional(),
  burstMode: z.boolean().optional(),
  businessHoursOnly: z.boolean().optional(),
  businessHoursStart: z.number().min(0).max(23).optional(),
  businessHoursEnd: z.number().min(0).max(23).optional(),
});

export const insertTransactionSchema = createInsertSchema(transactions).pick({
  amount: true,
  status: true,
  gateway: true,
  customerName: true,
  customerEmail: true,
  externalId: true,
  metadata: true,
});

export const insertTransactionEventSchema = createInsertSchema(transactionEvents).pick({
  transactionId: true,
  eventType: true,
  payload: true,
});

export const insertPaymentGatewaySchema = createInsertSchema(paymentGateways).pick({
  name: true,
  apiKey: true,
  webhookUrl: true,
  secretKey: true,
  isActive: true,
}).extend({
  name: z.string().min(1, "Nome do gateway é obrigatório"),
  apiKey: z.string().min(1, "API Key é obrigatória"),
  webhookUrl: z.string().url("URL do webhook inválida").optional().or(z.literal("")),
  secretKey: z.string().optional().or(z.literal("")),
});

export const insertWabaSchema = createInsertSchema(wabas).pick({
  name: true,
  wabaId: true,
  bmId: true,
  accessToken: true,
});

export const insertConversationSchema = createInsertSchema(conversations).pick({
  wabaId: true,
  campaignId: true,
  contactPhone: true,
  contactName: true,
});

export const insertMessageSchema = createInsertSchema(messages).pick({
  conversationId: true,
  direction: true,
  body: true,
  type: true,
  metaMessageId: true,
  status: true,
});

export const insertAutomationRuleSchema = createInsertSchema(campaignAutomationRules).pick({
  campaignId: true,
  keyword: true,
  response: true,
  priority: true,
});

export const insertParameterModelSchema = createInsertSchema(parameterModels).pick({
  name: true,
  templateName: true,
  parameters: true,
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertApiConfiguration = z.infer<typeof insertApiConfigurationSchema>;
export type ApiConfiguration = typeof apiConfigurations.$inferSelect;

export type InsertLeadList = z.infer<typeof insertLeadListSchema>;
export type LeadList = typeof leadLists.$inferSelect;

export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;

export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaigns.$inferSelect;

export type WhatsappTemplate = typeof whatsappTemplates.$inferSelect;
export type MessageDelivery = typeof messageDeliveries.$inferSelect;

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

export type InsertTransactionEvent = z.infer<typeof insertTransactionEventSchema>;
export type TransactionEvent = typeof transactionEvents.$inferSelect;

export type InsertPaymentGateway = z.infer<typeof insertPaymentGatewaySchema>;
export type PaymentGateway = typeof paymentGateways.$inferSelect;

export type DailyMessageCounter = typeof dailyMessageCounters.$inferSelect;

export type SenderUsage = typeof senderUsage.$inferSelect;

export type CSWSession = typeof cswSessions.$inferSelect;
export type PhoneSoftQuota = typeof phoneSoftQuotas.$inferSelect;

export const cswSessions = pgTable("csw_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phone: text("phone").notNull(),
  campaignId: varchar("campaign_id"),
  phoneNumberId: text("phone_number_id"),
  lastInboundAt: timestamp("last_inbound_at").notNull().defaultNow(),
  windowExpiresAt: timestamp("window_expires_at").notNull(),
  conversionSent: boolean("conversion_sent").default(false),
  conversionSentAt: timestamp("conversion_sent_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const phoneSoftQuotas = pgTable("phone_soft_quotas", {
  phoneNumberId: text("phone_number_id").primaryKey(),
  softQuota: integer("soft_quota").notNull().default(800),
  utilityScore: integer("utility_score").notNull().default(0),
  batchUnlocked: boolean("batch_unlocked").default(false),
  qualityScore: integer("quality_score").notNull().default(100),
  lastQualityCheck: timestamp("last_quality_check"),
  isNewNumber: boolean("is_new_number").default(true),
  totalCyclesCompleted: integer("total_cycles_completed").notNull().default(0),
  consecutiveSuccessfulCycles: integer("consecutive_successful_cycles").notNull().default(0),
  currentRampUpBatch: integer("current_ramp_up_batch").notNull().default(50),
  pausedUntil: timestamp("paused_until"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Waba = typeof wabas.$inferSelect;
export type InsertWaba = z.infer<typeof insertWabaSchema>;

export type WabaNumber = typeof wabaNumbers.$inferSelect;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type CampaignAutomationRule = typeof campaignAutomationRules.$inferSelect;
export type InsertAutomationRule = z.infer<typeof insertAutomationRuleSchema>;

export type BotRule = typeof botRules.$inferSelect;
export type BotSettings = typeof botSettings.$inferSelect;

export type ParameterModel = typeof parameterModels.$inferSelect;
export type InsertParameterModel = z.infer<typeof insertParameterModelSchema>;

export const wabaHooks = pgTable("waba_hooks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tsReceived: timestamp("ts_received").defaultNow(),
  object: text("object"),
  entry: jsonb("entry"),
  processed: boolean("processed").default(false),
  metaMessageId: text("meta_message_id"),
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  isDeadLetter: boolean("is_dead_letter").default(false),
  lastAttemptAt: timestamp("last_attempt_at"),
}, (table) => [
  index("idx_waba_hooks_processed_ts").on(table.processed, table.tsReceived),
  index("idx_waba_hooks_meta_message_id").on(table.metaMessageId),
  index("idx_waba_hooks_dead_letter").on(table.isDeadLetter),
]);

export const messageStatus = pgTable("message_status", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: text("campaign_id"),
  msgId: text("msg_id").unique().notNull(),
  phone: text("phone").notNull(),
  status: text("status").notNull(),
  ts: timestamp("ts").defaultNow(),
}, (table) => [
  index("idx_message_status_campaign_ts").on(table.campaignId, table.ts),
]);

export const insertWabaHookSchema = createInsertSchema(wabaHooks).omit({ id: true, tsReceived: true });
export const insertMessageStatusSchema = createInsertSchema(messageStatus).omit({ id: true, ts: true });

export type InsertWabaHook = z.infer<typeof insertWabaHookSchema>;
export type WabaHook = typeof wabaHooks.$inferSelect;

export type InsertMessageStatus = z.infer<typeof insertMessageStatusSchema>;
export type MessageStatus = typeof messageStatus.$inferSelect;

export type DeliveryStats = {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
};

export const leadPoolLists = pgTable("lead_pool_lists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  totalUploaded: integer("total_uploaded").notNull().default(0),
  totalValid: integer("total_valid").notNull().default(0),
  totalRejected: integer("total_rejected").notNull().default(0),
  totalAvailable: integer("total_available").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const leadPool = pgTable("lead_pool", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phone: text("phone").notNull().unique(),
  name: text("name").notNull(),
  cpf: text("cpf"),
  listId: varchar("list_id").notNull(),
  status: text("status").notNull().default("available"),
  createdAt: timestamp("created_at").defaultNow(),
  consumedAt: timestamp("consumed_at"),
});

export const insertLeadPoolListSchema = createInsertSchema(leadPoolLists).omit({ id: true, createdAt: true });
export const insertLeadPoolSchema = createInsertSchema(leadPool).omit({ id: true, createdAt: true, consumedAt: true });

export type InsertLeadPoolList = z.infer<typeof insertLeadPoolListSchema>;
export type LeadPoolList = typeof leadPoolLists.$inferSelect;

export type InsertLeadPool = z.infer<typeof insertLeadPoolSchema>;
export type LeadPoolItem = typeof leadPool.$inferSelect;

export const optOutNumbers = pgTable("opt_out_numbers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phone: text("phone").notNull().unique(),
  reason: text("reason").notNull().default("blocked"),
  errorCode: integer("error_code"),
  campaignId: varchar("campaign_id"),
  phoneNumberId: text("phone_number_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type OptOutNumber = typeof optOutNumbers.$inferSelect;

export const phoneWarmupSchedules = pgTable("phone_warmup_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumberId: text("phone_number_id").notNull().unique(),
  displayNumber: text("display_number"),
  currentDayLimit: integer("current_day_limit").notNull().default(50),
  targetDayLimit: integer("target_day_limit").notNull().default(1000),
  sentToday: integer("sent_today").notNull().default(0),
  dayNumber: integer("day_number").notNull().default(1),
  status: text("status").notNull().default("warming"),
  lastResetAt: timestamp("last_reset_at").defaultNow(),
  startedAt: timestamp("started_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type PhoneWarmupSchedule = typeof phoneWarmupSchedules.$inferSelect;

export const followUpRules = pgTable("follow_up_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  stage: integer("stage").notNull().default(1),
  delayMinutes: integer("delay_minutes").notNull().default(1440),
  templateName: text("template_name"),
  messageText: text("message_text"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export type FollowUpRule = typeof followUpRules.$inferSelect;

export const followUpStatus = pgTable("follow_up_status", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  phone: text("phone").notNull(),
  currentStage: integer("current_stage").notNull().default(0),
  lastFollowUpAt: timestamp("last_follow_up_at"),
  nextFollowUpAt: timestamp("next_follow_up_at"),
  hasReplied: boolean("has_replied").default(false),
  isCompleted: boolean("is_completed").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const qualityRatingHistory = pgTable("quality_rating_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumberId: text("phone_number_id").notNull(),
  wabaId: varchar("waba_id").notNull(),
  qualityRating: text("quality_rating").notNull(),
  previousRating: text("previous_rating"),
  sentCount: integer("sent_count").default(0),
  checkedAt: timestamp("checked_at").defaultNow(),
});

export type QualityRatingHistory = typeof qualityRatingHistory.$inferSelect;

export const warmupSchedules = pgTable("warmup_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumberId: text("phone_number_id").notNull(),
  wabaId: varchar("waba_id").notNull(),
  status: text("status").notNull().default("active"),
  currentDay: integer("current_day").notNull().default(1),
  totalDays: integer("total_days").notNull().default(7),
  dailyTargets: jsonb("daily_targets").notNull(),
  sentToday: integer("sent_today").notNull().default(0),
  startedAt: timestamp("started_at").defaultNow(),
  lastSendAt: timestamp("last_send_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type WarmupSchedule = typeof warmupSchedules.$inferSelect;

export const campaignErrorLogs = pgTable("campaign_error_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  errorCode: text("error_code").notNull(),
  errorMessage: text("error_message").notNull(),
  phone: text("phone"),
  phoneNumberId: text("phone_number_id"),
  count: integer("count").notNull().default(1),
  lastOccurredAt: timestamp("last_occurred_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type CampaignErrorLog = typeof campaignErrorLogs.$inferSelect;

export const imageTemplates = pgTable("image_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  baseImagePath: text("base_image_path").notNull(),
  baseImageUrl: text("base_image_url"),
  baseImageData: text("base_image_data"),
  width: integer("width").notNull().default(0),
  height: integer("height").notNull().default(0),
  fields: jsonb("fields").notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertImageTemplateSchema = createInsertSchema(imageTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ImageTemplate = typeof imageTemplates.$inferSelect;
export type InsertImageTemplate = z.infer<typeof insertImageTemplateSchema>;

export interface ImageTemplateField {
  id: string;
  label: string;
  type: "name" | "cpf" | "custom";
  defaultText: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  color: string;
  opacity: number;
  letterSpacing: number;
  lineHeight: number;
  rotation: number;
  textAlign: string;
  maxWidth: number;
  textTransform: string;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
  strokeEnabled: boolean;
  strokeColor: string;
  strokeWidth: number;
  coordinateSystem?: "absolute" | "relative";
}

export const botFlows = pgTable("bot_flows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  name: text("name").notNull().default("Fluxo principal"),
  isActive: boolean("is_active").default(false),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const botFlowNodes = pgTable("bot_flow_nodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  flowId: varchar("flow_id").notNull(),
  nodeType: text("node_type").notNull().default("message"),
  sortOrder: integer("sort_order").notNull().default(0),
  label: text("label"),
  messageContent: text("message_content"),
  messageType: text("message_type").default("text"),
  mediaUrl: text("media_url"),
  buttonPayload: jsonb("button_payload"),
  conditions: jsonb("conditions").default(sql`'[]'::jsonb`),
  defaultNextNodeId: varchar("default_next_node_id"),
  timeoutMinutes: integer("timeout_minutes"),
  timeoutAction: text("timeout_action").default("end"),
  timeoutNextNodeId: varchar("timeout_next_node_id"),
  timeoutMessage: text("timeout_message"),
  delaySeconds: integer("delay_seconds").default(3),
  variableCapture: text("variable_capture"),
  linkUrl: text("link_url"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const botConversationStates = pgTable("bot_conversation_states", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  flowId: varchar("flow_id").notNull(),
  campaignId: varchar("campaign_id").notNull(),
  phone: text("phone").notNull(),
  currentNodeId: varchar("current_node_id"),
  variables: jsonb("variables").default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("active"),
  lastResponse: text("last_response"),
  lastInboundMessageId: varchar("last_inbound_message_id", { length: 255 }),
  startedAt: timestamp("started_at").defaultNow(),
  lastActivityAt: timestamp("last_activity_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type BotFlow = typeof botFlows.$inferSelect;
export type BotFlowNode = typeof botFlowNodes.$inferSelect;
export type BotConversationState = typeof botConversationStates.$inferSelect;

export interface BotNodeCondition {
  id: string;
  matchType: "keyword" | "regex" | "exact" | "any";
  matchValue: string;
  nextNodeId: string;
}

export interface BotMessageHeader {
  type: "text" | "image";
  value: string;
}

export interface BotButtonPayloadItem {
  id?: string;
  title?: string;
  nextNodeId?: string;
}

export type CswFallbackAction = "text_only" | "skip" | "end" | "campaign_default";

export interface BotButtonsPayloadMeta {
  items: BotButtonPayloadItem[];
  header?: BotMessageHeader;
  footer?: string;
  cswFallback?: CswFallbackAction;
}

export interface BotListSection {
  title: string;
  rows: Array<{ id: string; title: string; description?: string; nextNodeId?: string }>;
}

export interface BotListPayload {
  button: string;
  sections: BotListSection[];
  header?: BotMessageHeader;
  footer?: string;
  cswFallback?: CswFallbackAction;
}

export type BotButtonPayload = BotButtonPayloadItem[] | BotButtonsPayloadMeta | BotListPayload | null;

export const systemConfig = pgTable("system_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const imageSendConfirmations = pgTable("image_send_confirmations", {
  messageId: text("message_id").primaryKey(),
  phone: text("phone").notNull(),
  templateId: text("template_id"),
  status: text("status", { enum: ["pending", "confirmed", "unknown_delivered"] }).notNull().default("pending"),
  claimedAt: timestamp("claimed_at").defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at"),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => [
  index("idx_isc_expires_at").on(table.expiresAt),
  index("idx_isc_phone").on(table.phone),
  index("idx_isc_status").on(table.status),
]);

export type ImageSendConfirmation = typeof imageSendConfirmations.$inferSelect;

export const insertBotFlowSchema = createInsertSchema(botFlows).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBotFlowNodeSchema = createInsertSchema(botFlowNodes).omit({ id: true, createdAt: true });
export const insertBotConversationStateSchema = createInsertSchema(botConversationStates).omit({ id: true, createdAt: true, startedAt: true });

export type InsertBotFlow = z.infer<typeof insertBotFlowSchema>;
export type InsertBotFlowNode = z.infer<typeof insertBotFlowNodeSchema>;
export type InsertBotConversationState = z.infer<typeof insertBotConversationStateSchema>;

export const proxies = pgTable("proxies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  url: text("url").notNull().unique(),
  label: text("label"),
  isActive: boolean("is_active").notNull().default(true),
  latencyMs: integer("latency_ms"),
  lastCheckedAt: timestamp("last_checked_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertProxySchema = createInsertSchema(proxies).omit({ id: true, createdAt: true, updatedAt: true, latencyMs: true, lastCheckedAt: true }).extend({
  url: z.string().url("URL do proxy inválida"),
  label: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
});

export const updateProxySchema = z.object({
  isActive: z.boolean().optional(),
  label: z.string().max(100).trim().optional(),
});

export type Proxy = typeof proxies.$inferSelect;
export type InsertProxy = z.infer<typeof insertProxySchema>;

export const voiceProfiles = pgTable("voice_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull(),
  gender: text("gender").notNull().default("feminina"),
  referenceAudioPath: text("reference_audio_path").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const ttsAudioCache = pgTable("tts_audio_cache", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  hash: text("hash").notNull().unique(),
  filePath: text("file_path").notNull(),
  voiceProfileId: varchar("voice_profile_id").notNull(),
  textContent: text("text_content").notNull(),
  isFixed: boolean("is_fixed").default(false),
  ttlDays: integer("ttl_days").notNull().default(7),
  lastUsedAt: timestamp("last_used_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_tts_cache_hash").on(table.hash),
  index("idx_tts_cache_last_used").on(table.lastUsedAt),
]);

export const ttsJobProgress = pgTable("tts_job_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: varchar("campaign_id").notNull(),
  leadId: varchar("lead_id"),
  status: text("status").notNull().default("pending"),
  audioPath: text("audio_path"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_tts_job_campaign").on(table.campaignId),
]);

export const insertVoiceProfileSchema = createInsertSchema(voiceProfiles).omit({ id: true, createdAt: true });
export const insertTtsAudioCacheSchema = createInsertSchema(ttsAudioCache).omit({ id: true, createdAt: true });
export const insertTtsJobProgressSchema = createInsertSchema(ttsJobProgress).omit({ id: true, createdAt: true, updatedAt: true });

export type VoiceProfile = typeof voiceProfiles.$inferSelect;
export type InsertVoiceProfile = z.infer<typeof insertVoiceProfileSchema>;

export type TtsAudioCache = typeof ttsAudioCache.$inferSelect;
export type InsertTtsAudioCache = z.infer<typeof insertTtsAudioCacheSchema>;

export type TtsJobProgress = typeof ttsJobProgress.$inferSelect;
export type InsertTtsJobProgress = z.infer<typeof insertTtsJobProgressSchema>;
