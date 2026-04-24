import { 
  type User, 
  type InsertUser,
  type ApiConfiguration,
  type InsertApiConfiguration,
  type LeadList,
  type InsertLeadList,
  type Lead,
  type InsertLead,
  type WhatsappTemplate,
  type Campaign,
  type InsertCampaign,
  type MessageDelivery,
  type Transaction,
  type InsertTransaction,
  type TransactionEvent,
  type InsertTransactionEvent,
  type PaymentGateway,
  type InsertPaymentGateway,
  type DailyMessageCounter,
  type WabaHook,
  type MessageStatus,
  type DeliveryStats,
  type LeadPoolList,
  type InsertLeadPoolList,
  type LeadPoolItem,
  leadPoolLists,
  leadPool,
  cswSessions,
  dailyMessageCounters as dailyMessageCountersTable,
  messageDeliveries as messageDeliveriesTable,
  campaigns as campaignsTable,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { db } from "./db";
import { eq, sql, and, desc, lt, isNotNull, or } from "drizzle-orm";
import { logError } from './utils/logger';

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // API Configurations
  getApiConfiguration(userId: string): Promise<ApiConfiguration | undefined>;
  createApiConfiguration(config: InsertApiConfiguration & { userId: string }): Promise<ApiConfiguration>;
  updateApiConfiguration(userId: string, config: Partial<ApiConfiguration>): Promise<ApiConfiguration | undefined>;

  // Lead Lists
  getLeadList(id: string): Promise<LeadList | undefined>;
  getLeadListsByUser(userId: string): Promise<LeadList[]>;
  createLeadList(leadList: InsertLeadList & { userId: string }): Promise<LeadList>;
  updateLeadList(id: string, updates: Partial<LeadList>): Promise<LeadList | undefined>;

  // Leads
  getLeadsByListId(leadListId: string): Promise<Lead[]>;
  createLead(lead: InsertLead): Promise<Lead>;
  createLeads(leads: InsertLead[]): Promise<Lead[]>;

  // WhatsApp Templates
  getTemplate(id: string): Promise<WhatsappTemplate | undefined>;
  getTemplatesByUser(userId: string): Promise<WhatsappTemplate[]>;
  createTemplate(template: Omit<WhatsappTemplate, 'id' | 'lastSynced'>): Promise<WhatsappTemplate>;
  updateTemplate(id: string, updates: Partial<WhatsappTemplate>): Promise<WhatsappTemplate | undefined>;
  deleteTemplatesByUser(userId: string): Promise<void>;

  // Campaigns
  getCampaign(id: string): Promise<Campaign | undefined>;
  getCampaignsByUser(userId: string): Promise<Campaign[]>;
  getActiveCampaignsByUser(userId: string): Promise<Campaign[]>;
  createCampaign(campaign: InsertCampaign & { userId: string }): Promise<Campaign>;
  updateCampaign(id: string, updates: Partial<Campaign>): Promise<Campaign | undefined>;

  // Message Deliveries
  getMessageDeliveriesByCampaign(campaignId: string): Promise<MessageDelivery[]>;
  createMessageDelivery(delivery: Omit<MessageDelivery, 'id' | 'createdAt'>): Promise<MessageDelivery>;
  updateMessageDelivery(id: string, updates: Partial<MessageDelivery>): Promise<MessageDelivery | undefined>;

  // Transactions
  getTransactions(userId: string): Promise<Transaction[]>;
  getTransactionById(id: string): Promise<Transaction | undefined>;
  createTransaction(transaction: InsertTransaction & { userId: string }): Promise<Transaction>;
  updateTransactionStatus(id: string, status: string): Promise<Transaction | undefined>;

  // Payment Gateways
  getPaymentGateways(userId: string): Promise<PaymentGateway[]>;
  getPaymentGatewayById(id: string): Promise<PaymentGateway | undefined>;
  getPaymentGatewayByName(userId: string, name: string): Promise<PaymentGateway | undefined>;
  createPaymentGateway(gateway: InsertPaymentGateway & { userId: string }): Promise<PaymentGateway>;
  updatePaymentGateway(id: string, updates: Partial<PaymentGateway>): Promise<PaymentGateway | undefined>;

  // Transaction Events
  createTransactionEvent(event: InsertTransactionEvent): Promise<TransactionEvent>;
  getTransactionEvents(transactionId: string): Promise<TransactionEvent[]>;

  // Daily Message Counters
  getDailyMessageCounter(phoneNumberId: string): Promise<DailyMessageCounter | undefined>;
  incrementDailyMessageCounter(phoneNumberId: string, displayPhoneNumber: string, tier: string, tierLimit: number): Promise<DailyMessageCounter>;
  resetExpiredCounters(): Promise<void>;
  getRemainingQuota(phoneNumberId: string): Promise<number>;

  // Webhook Events
  insertWebhookEvent(data: { object: string; entry: unknown }): Promise<WabaHook>;
  upsertMessageStatus(campaignId: string | null, msgId: string, phone: string, status: string): Promise<MessageStatus & { previousStatus?: string }>;
  getDeliveryStats(campaignId: string): Promise<DeliveryStats>;

  // Lead Pool
  createLeadPoolList(data: InsertLeadPoolList): Promise<LeadPoolList>;
  getLeadPoolLists(): Promise<LeadPoolList[]>;
  updateLeadPoolList(id: string, updates: Partial<LeadPoolList>): Promise<LeadPoolList | undefined>;
  insertPoolLeadsBatch(leads: { phone: string; name: string; cpf: string; listId: string }[]): Promise<number>;
  consumePoolLeads(count: number): Promise<LeadPoolItem[]>;
  getPoolStats(): Promise<{ available: number; consumed: number; totalUploaded: number }>;
  getExistingPoolPhones(): Promise<Set<string>>;

  // CSW Sessions
  upsertCSWSession(phone: string, campaignId: string | null, phoneNumberId: string | null): Promise<any>;
  getCSWSession(phone: string): Promise<any | null>;
  markCSWConversionSent(phone: string): Promise<void>;
  getOpenCSWSessionsForCampaign(campaignId: string): Promise<any[]>;
  cleanupExpiredCSWSessions(): Promise<number>;

  // Lead-Campaign Mapping
  registerLeadCampaignMapping(phone: string, campaignId: string): Promise<void>;
  getCampaignForLead(phone: string, wabaId?: string): Promise<string | null>;
}

class LeadPoolStorage {
  async createLeadPoolList(data: InsertLeadPoolList): Promise<LeadPoolList> {
    const [result] = await db.insert(leadPoolLists).values(data).returning();
    return result;
  }

  async getLeadPoolLists(): Promise<LeadPoolList[]> {
    return db.select().from(leadPoolLists).orderBy(desc(leadPoolLists.createdAt));
  }

  async updateLeadPoolList(id: string, updates: Partial<LeadPoolList>): Promise<LeadPoolList | undefined> {
    const [result] = await db.update(leadPoolLists).set(updates).where(eq(leadPoolLists.id, id)).returning();
    return result;
  }

  async insertPoolLeadsBatch(leads: { phone: string; name: string; cpf: string; listId: string }[]): Promise<number> {
    if (leads.length === 0) return 0;
    let inserted = 0;
    for (let i = 0; i < leads.length; i += 500) {
      const batch = leads.slice(i, i + 500);
      try {
        const result = await db.insert(leadPool)
          .values(batch.map(l => ({
            phone: l.phone,
            name: l.name,
            cpf: l.cpf || null,
            listId: l.listId,
            status: "available",
          })))
          .onConflictDoNothing({ target: leadPool.phone })
          .returning();
        inserted += result.length;
      } catch (err: any) {
        logError("storage.insertPoolLeadsBatch", {}, err);
      }
    }
    return inserted;
  }

  async consumePoolLeads(count: number): Promise<LeadPoolItem[]> {
    return await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE lead_pool
        SET status = 'consumed', consumed_at = NOW()
        WHERE id IN (
          SELECT id FROM lead_pool
          WHERE status = 'available'
          ORDER BY created_at
          LIMIT ${count}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, phone, name, cpf, list_id, status, created_at, consumed_at
      `);
      const rows = result.rows || [];
      const leads = rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        phone: r.phone as string,
        name: r.name as string,
        cpf: (r.cpf as string) || null,
        listId: r.list_id as string,
        status: r.status as string,
        createdAt: r.created_at ? new Date(r.created_at as string) : null,
        consumedAt: r.consumed_at ? new Date(r.consumed_at as string) : null,
      })) as LeadPoolItem[];

      const listCounts = new Map<string, number>();
      for (const lead of leads) {
        if (lead.listId) listCounts.set(lead.listId, (listCounts.get(lead.listId) || 0) + 1);
      }
      for (const [listId, cnt] of listCounts) {
        await tx.update(leadPoolLists)
          .set({ totalAvailable: sql`GREATEST(0, ${leadPoolLists.totalAvailable} - ${cnt})` })
          .where(eq(leadPoolLists.id, listId));
      }

      return leads;
    });
  }

  async getPoolStats(): Promise<{ available: number; consumed: number; totalUploaded: number }> {
    const [stats] = await db.select({
      available: sql<number>`count(*) filter (where ${leadPool.status} = 'available')`,
      consumed: sql<number>`count(*) filter (where ${leadPool.status} = 'consumed')`,
      totalUploaded: sql<number>`count(*)`,
    }).from(leadPool);
    return {
      available: Number(stats?.available || 0),
      consumed: Number(stats?.consumed || 0),
      totalUploaded: Number(stats?.totalUploaded || 0),
    };
  }

  async getExistingPoolPhones(): Promise<Set<string>> {
    const rows = await db.select({ phone: leadPool.phone }).from(leadPool);
    return new Set(rows.map(r => r.phone));
  }

  async getExistingPoolCpfs(): Promise<Set<string>> {
    const rows = await db.select({ cpf: leadPool.cpf }).from(leadPool)
      .where(sql`${leadPool.cpf} IS NOT NULL AND ${leadPool.cpf} != ''`);
    return new Set(rows.map(r => r.cpf).filter(Boolean) as string[]);
  }

  async decrementListAvailable(listId: string, count: number): Promise<void> {
    await db.update(leadPoolLists)
      .set({ totalAvailable: sql`GREATEST(0, ${leadPoolLists.totalAvailable} - ${count})` })
      .where(eq(leadPoolLists.id, listId));
  }
}

export const leadPoolStorage = new LeadPoolStorage();

/**
 * DatabaseStorage — DB-backed implementation for hot-path storage methods.
 *
 * Replaces MemStorage as the exported `storage` singleton. All methods delegate
 * to the PostgreSQL database for durability across restarts.
 *
 * Active methods (called by CSWTracker, MultiPhoneEngineCoordinator, routes):
 *  - CSW session: upsertCSWSession / getCSWSession / markCSWConversionSent /
 *                 getOpenCSWSessionsForCampaign / cleanupExpiredCSWSessions
 *  - Daily message counter: incrementDailyMessageCounter / getRemainingQuota
 *  - Lead-campaign mapping: registerLeadCampaignMapping / getCampaignForLead
 *
 * Deprecated/stub methods throw errors pointing to the canonical DB client.
 */
class DatabaseStorage implements IStorage {
  // ── Users ─────────────────────────────────────────────────────────────────
  async getUser(_id: string): Promise<User | undefined> { throw new Error("Use db client directly"); }
  async getUserByUsername(_username: string): Promise<User | undefined> { throw new Error("Use db client directly"); }
  async createUser(_user: InsertUser): Promise<User> { throw new Error("Use db client directly"); }

  // ── API Configurations ────────────────────────────────────────────────────
  async getApiConfiguration(_userId: string): Promise<ApiConfiguration | undefined> { throw new Error("Use db client directly"); }
  async createApiConfiguration(_config: InsertApiConfiguration & { userId: string }): Promise<ApiConfiguration> { throw new Error("Use db client directly"); }
  async updateApiConfiguration(_userId: string, _config: Partial<ApiConfiguration>): Promise<ApiConfiguration | undefined> { throw new Error("Use db client directly"); }

  // ── Lead Lists ────────────────────────────────────────────────────────────
  async getLeadList(_id: string): Promise<LeadList | undefined> { throw new Error("Use db client directly"); }
  async getLeadListsByUser(_userId: string): Promise<LeadList[]> { throw new Error("Use db client directly"); }
  async createLeadList(_leadList: InsertLeadList & { userId: string }): Promise<LeadList> { throw new Error("Use db client directly"); }
  async updateLeadList(_id: string, _updates: Partial<LeadList>): Promise<LeadList | undefined> { throw new Error("Use db client directly"); }

  // ── Leads ─────────────────────────────────────────────────────────────────
  async getLeadsByListId(_leadListId: string): Promise<Lead[]> { throw new Error("Use db client directly"); }
  async createLead(_lead: InsertLead): Promise<Lead> { throw new Error("Use db client directly"); }
  async createLeads(_leads: InsertLead[]): Promise<Lead[]> { throw new Error("Use db client directly"); }

  // ── WhatsApp Templates ────────────────────────────────────────────────────
  async getTemplate(_id: string): Promise<WhatsappTemplate | undefined> { throw new Error("Use db client directly"); }
  async getTemplatesByUser(_userId: string): Promise<WhatsappTemplate[]> { throw new Error("Use db client directly"); }
  async createTemplate(_template: Omit<WhatsappTemplate, 'id' | 'lastSynced'>): Promise<WhatsappTemplate> { throw new Error("Use db client directly"); }
  async updateTemplate(_id: string, _updates: Partial<WhatsappTemplate>): Promise<WhatsappTemplate | undefined> { throw new Error("Use db client directly"); }
  async deleteTemplatesByUser(_userId: string): Promise<void> { throw new Error("Use db client directly"); }

  // ── Campaigns ─────────────────────────────────────────────────────────────
  async getCampaign(_id: string): Promise<Campaign | undefined> { throw new Error("Use db client directly"); }
  async getCampaignsByUser(_userId: string): Promise<Campaign[]> { throw new Error("Use db client directly"); }
  async getActiveCampaignsByUser(_userId: string): Promise<Campaign[]> { throw new Error("Use db client directly"); }
  async createCampaign(_campaign: InsertCampaign & { userId: string }): Promise<Campaign> { throw new Error("Use db client directly"); }
  async updateCampaign(_id: string, _updates: Partial<Campaign>): Promise<Campaign | undefined> { throw new Error("Use db client directly"); }

  // ── Message Deliveries ────────────────────────────────────────────────────
  async getMessageDeliveriesByCampaign(_campaignId: string): Promise<MessageDelivery[]> { throw new Error("Use db client directly"); }
  async createMessageDelivery(_delivery: Omit<MessageDelivery, 'id' | 'createdAt'>): Promise<MessageDelivery> { throw new Error("Use db client directly"); }
  async updateMessageDelivery(_id: string, _updates: Partial<MessageDelivery>): Promise<MessageDelivery | undefined> { throw new Error("Use db client directly"); }

  // ── Transactions ──────────────────────────────────────────────────────────
  async createTransaction(_transaction: InsertTransaction & { userId: string }): Promise<Transaction> { throw new Error("Use db client directly"); }
  async getTransactionsByUser(_userId: string): Promise<Transaction[]> { throw new Error("Use db client directly"); }
  async getTransactions(_userId: string): Promise<Transaction[]> { throw new Error("Use db client directly"); }
  async getTransactionById(_id: string): Promise<Transaction | undefined> { throw new Error("Use db client directly"); }
  async updateTransaction(_id: string, _updates: Partial<Transaction>): Promise<Transaction | undefined> { throw new Error("Use db client directly"); }
  async updateTransactionStatus(_id: string, _status: string): Promise<Transaction | undefined> { throw new Error("Use db client directly"); }

  // ── Payment Gateways ──────────────────────────────────────────────────────
  async getPaymentGateway(_id: string): Promise<PaymentGateway | undefined> { throw new Error("Use db client directly"); }
  async getPaymentGateways(_userId: string): Promise<PaymentGateway[]> { throw new Error("Use db client directly"); }
  async getPaymentGatewayById(_id: string): Promise<PaymentGateway | undefined> { throw new Error("Use db client directly"); }
  async getPaymentGatewayByName(_userId: string, _name: string): Promise<PaymentGateway | undefined> { throw new Error("Use db client directly"); }
  async getPaymentGatewaysByUser(_userId: string): Promise<PaymentGateway[]> { throw new Error("Use db client directly"); }
  async createPaymentGateway(_gateway: InsertPaymentGateway & { userId: string }): Promise<PaymentGateway> { throw new Error("Use db client directly"); }
  async updatePaymentGateway(_id: string, _updates: Partial<PaymentGateway>): Promise<PaymentGateway | undefined> { throw new Error("Use db client directly"); }

  // ── Transaction Events ────────────────────────────────────────────────────
  async createTransactionEvent(_event: InsertTransactionEvent): Promise<TransactionEvent> { throw new Error("Use db client directly"); }
  async getTransactionEvents(_transactionId: string): Promise<TransactionEvent[]> { throw new Error("Use db client directly"); }

  // ── Daily Message Counters (DB-backed) ────────────────────────────────────
  async getDailyMessageCounter(phoneNumberId: string): Promise<DailyMessageCounter | undefined> {
    const now = new Date();
    const [row] = await db.select().from(dailyMessageCountersTable)
      .where(and(eq(dailyMessageCountersTable.phoneNumberId, phoneNumberId), sql`${dailyMessageCountersTable.windowEnd} > ${now}`));
    return row;
  }

  async incrementDailyMessageCounter(
    phoneNumberId: string,
    displayPhoneNumber: string,
    tier: string,
    tierLimit: number
  ): Promise<DailyMessageCounter> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const existing = await this.getDailyMessageCounter(phoneNumberId);
    if (existing) {
      const [updated] = await db.update(dailyMessageCountersTable)
        .set({ messageCount: sql`${dailyMessageCountersTable.messageCount} + 1`, updatedAt: now })
        .where(eq(dailyMessageCountersTable.id, existing.id))
        .returning();
      return updated;
    }
    const [inserted] = await db.insert(dailyMessageCountersTable).values({
      phoneNumberId,
      displayPhoneNumber,
      messageCount: 1,
      tierLimit,
      tier,
      windowStart: now,
      windowEnd,
    }).returning();
    return inserted;
  }

  async resetExpiredCounters(): Promise<void> {
    await db.delete(dailyMessageCountersTable).where(lt(dailyMessageCountersTable.windowEnd, new Date()));
  }

  async getRemainingQuota(_phoneNumberId: string): Promise<number> {
    return Infinity;
  }

  // ── Webhook Events ────────────────────────────────────────────────────────
  async insertWebhookEvent(_data: { object: string; entry: unknown }): Promise<WabaHook> { throw new Error("Use db client directly"); }
  async upsertMessageStatus(_campaignId: string | null, _msgId: string, _phone: string, _status: string): Promise<MessageStatus & { previousStatus?: string }> { throw new Error("Use db client directly"); }
  async getDeliveryStats(_campaignId: string): Promise<DeliveryStats> { throw new Error("Use db client directly"); }

  // ── Lead Pool Storage ─────────────────────────────────────────────────────
  async createLeadPoolList(_data: InsertLeadPoolList): Promise<LeadPoolList> { throw new Error("Use leadPoolStorage directly"); }
  async getLeadPoolLists(): Promise<LeadPoolList[]> { throw new Error("Use leadPoolStorage directly"); }
  async updateLeadPoolList(_id: string, _updates: Partial<LeadPoolList>): Promise<LeadPoolList | undefined> { throw new Error("Use leadPoolStorage directly"); }
  async addToLeadPool(_listId: string, _phones: string[]): Promise<number> { throw new Error("Use leadPoolStorage directly"); }
  async insertPoolLeadsBatch(_leads: { phone: string; name: string; cpf: string; listId: string }[]): Promise<number> { throw new Error("Use leadPoolStorage directly"); }
  async consumePoolLeads(_count: number): Promise<LeadPoolItem[]> { throw new Error("Use leadPoolStorage directly"); }
  async consumeFromLeadPool(_listId: string, _count: number): Promise<LeadPoolItem[]> { throw new Error("Use leadPoolStorage directly"); }
  async getPoolStats(): Promise<{ available: number; consumed: number; totalUploaded: number }> { throw new Error("Use leadPoolStorage directly"); }
  async getExistingPoolPhones(): Promise<Set<string>> { throw new Error("Use leadPoolStorage directly"); }

  // ── CSW Sessions (DB-backed) ───────────────────────────────────────────────
  async upsertCSWSession(phone: string, campaignId: string | null, phoneNumberId: string | null): Promise<any> {
    const now = new Date();
    const windowExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const [existing] = await db.select().from(cswSessions).where(eq(cswSessions.phone, phone)).limit(1);
    if (existing) {
      const [updated] = await db.update(cswSessions)
        .set({
          lastInboundAt: now,
          windowExpiresAt,
          campaignId: campaignId ?? existing.campaignId,
          phoneNumberId: phoneNumberId ?? existing.phoneNumberId,
        })
        .where(eq(cswSessions.id, existing.id))
        .returning();
      return updated;
    }
    const [inserted] = await db.insert(cswSessions).values({
      phone,
      campaignId,
      phoneNumberId,
      lastInboundAt: now,
      windowExpiresAt,
      conversionSent: false,
      conversionSentAt: null,
    }).returning();
    return inserted;
  }

  async getCSWSession(phone: string): Promise<any | null> {
    const now = new Date();
    const [row] = await db.select().from(cswSessions)
      .where(and(eq(cswSessions.phone, phone), sql`${cswSessions.windowExpiresAt} > ${now}`));
    return row ?? null;
  }

  async markCSWConversionSent(phone: string): Promise<void> {
    await db.update(cswSessions).set({ conversionSent: true, conversionSentAt: new Date() })
      .where(eq(cswSessions.phone, phone));
  }

  async getOpenCSWSessionsForCampaign(campaignId: string): Promise<any[]> {
    const now = new Date();
    return db.select().from(cswSessions)
      .where(and(eq(cswSessions.campaignId, campaignId), sql`${cswSessions.windowExpiresAt} > ${now}`));
  }

  async cleanupExpiredCSWSessions(): Promise<number> {
    const result = await db.delete(cswSessions).where(lt(cswSessions.windowExpiresAt, new Date())).returning({ id: cswSessions.id });
    return result.length;
  }

  // ── Lead-Campaign Mapping (DB-backed via messageDeliveries) ───────────────
  async registerLeadCampaignMapping(_phone: string, _campaignId: string): Promise<void> {
    // messageDeliveries is the source of truth; no separate mapping table needed.
    // This is a no-op — getCampaignForLead queries messageDeliveries directly.
  }

  async getCampaignForLead(phone: string, wabaId?: string): Promise<string | null> {
    const digits = phone.replace(/\D/g, '');
    const variants = new Set<string>([phone, digits, '+' + digits]);

    // Brazilian 9th-digit variants
    if (digits.startsWith('55') && digits.length === 13) {
      const without9 = '55' + digits.slice(2, 4) + digits.slice(5);
      variants.add(without9);
      variants.add('+' + without9);
    }
    if (digits.startsWith('55') && digits.length === 12) {
      const ddd = digits.slice(2, 4);
      const num = digits.slice(4);
      if (['6','7','8','9'].includes(num[0])) {
        const with9 = '55' + ddd + '9' + num;
        variants.add(with9);
        variants.add('+' + with9);
      }
    }
    if (!digits.startsWith('55') && digits.length === 11) {
      variants.add('55' + digits);
      variants.add('+55' + digits);
    }
    if (!digits.startsWith('55') && digits.length === 10) {
      const ddd = digits.slice(0, 2);
      const num = digits.slice(2);
      variants.add('55' + ddd + '9' + num);
      variants.add('55' + ddd + num);
      variants.add('+55' + ddd + '9' + num);
      variants.add('+55' + ddd + num);
    }

    const variantArray = Array.from(variants);
    const phoneConditions = variantArray.map(v => eq(messageDeliveriesTable.phoneNumber, v));

    // When wabaId is provided, join campaigns to scope results to that WABA,
    // preventing cross-WABA campaign misattribution when same lead exists in multiple WABAs.
    let campaignId: string | null = null;
    if (wabaId) {
      const rows = await db
        .select({ campaignId: messageDeliveriesTable.campaignId, createdAt: messageDeliveriesTable.createdAt })
        .from(messageDeliveriesTable)
        .innerJoin(campaignsTable, eq(messageDeliveriesTable.campaignId, campaignsTable.id))
        .where(and(
          or(...phoneConditions),
          eq(campaignsTable.wabaId, wabaId)
        ))
        .orderBy(desc(messageDeliveriesTable.createdAt))
        .limit(1);
      campaignId = rows[0]?.campaignId ?? null;
    } else {
      // No WABA scope: select the most recently created delivery across all WABAs
      const rows = await db.select({ campaignId: messageDeliveriesTable.campaignId, createdAt: messageDeliveriesTable.createdAt })
        .from(messageDeliveriesTable)
        .where(or(...phoneConditions))
        .orderBy(desc(messageDeliveriesTable.createdAt))
        .limit(1);
      campaignId = rows[0]?.campaignId ?? null;
    }

    if (campaignId) {
      console.log(`[WEBHOOK] getCampaignForLead: phone ${phone} → campaignId ${campaignId} (variants=${variantArray.length} wabaId=${wabaId || 'any'})`);
    } else {
      console.log(`[WEBHOOK] getCampaignForLead: phone ${phone} → no campaign found (variants=${variantArray.length} wabaId=${wabaId || 'any'})`);
    }
    return campaignId;
  }
}

export const storage = new DatabaseStorage();
