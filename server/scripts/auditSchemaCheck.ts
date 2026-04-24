/**
 * Startup Schema Audit Check
 *
 * Verifies that all tables required by the bot and image subsystems exist in the
 * database. Run this after `npm run db:push` or before any production deployment.
 *
 * Usage:
 *   npx tsx server/scripts/auditSchemaCheck.ts
 *
 * Exit codes:
 *   0 — All required tables present
 *   1 — One or more required tables missing
 */

import { pool } from '../db';

const AUDIT_TABLES = [
  "users",
  "api_configurations",
  "wabas",
  "waba_numbers",
  "conversations",
  "messages",
  "campaign_automation_rules",
  "parameter_models",
  "lead_lists",
  "leads",
  "whatsapp_templates",
  "campaigns",
  "message_deliveries",
  "transactions",
  "transaction_events",
  "daily_message_counters",
  "sender_usage",
  "payment_gateways",
  "csw_sessions",
  "phone_soft_quotas",
  "waba_hooks",
  "message_status",
  "lead_pool_lists",
  "lead_pool",
  "opt_out_numbers",
  "phone_warmup_schedules",
  "follow_up_rules",
  "follow_up_status",
  "quality_rating_history",
  "warmup_schedules",
  "campaign_error_logs",
  "image_templates",
  "bot_flows",
  "bot_flow_nodes",
  "bot_conversation_states",
  "image_send_confirmations",
];

async function run(): Promise<void> {
  try {
    const result = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const existing = new Set(result.rows.map((r: { tablename: string }) => r.tablename));
    const missing = AUDIT_TABLES.filter(t => !existing.has(t));

    if (missing.length > 0) {
      console.error(`[AUDIT_SCHEMA] FAIL: ${missing.length} table(s) missing:`);
      for (const t of missing) {
        console.error(`  - ${t}`);
      }
      console.error(`[AUDIT_SCHEMA] Run 'npm run db:push' to create missing tables.`);
      process.exit(1);
    }

    console.log(`[AUDIT_SCHEMA] PASS: all ${AUDIT_TABLES.length} required tables present (${existing.size} total in schema).`);
    process.exit(0);
  } catch (err: any) {
    console.error('[AUDIT_SCHEMA] ERROR connecting to database:', err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

run();
