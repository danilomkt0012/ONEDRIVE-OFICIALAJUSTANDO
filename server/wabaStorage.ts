import { db } from "./db";
import { eq, sql, and, or, desc, asc, like } from "drizzle-orm";
import {
  wabas, wabaNumbers, conversations, messages, campaigns,
  campaignAutomationRules, parameterModels, botRules, botSettings,
  type Waba, type WabaNumber, type Conversation, type Message,
  type CampaignAutomationRule, type ParameterModel, type BotRule, type BotSettings,
} from "@shared/schema";
import { isNotNull } from "drizzle-orm";

class WabaStorage {
  async createWaba(data: { userId: string; name: string; wabaId: string; bmId?: string; accessToken: string; appSecret?: string }): Promise<Waba> {
    const values: any = {
      userId: data.userId,
      name: data.name,
      wabaId: data.wabaId,
      bmId: data.bmId || null,
      accessToken: data.accessToken,
    };
    if (data.appSecret) values.appSecret = data.appSecret;
    const [result] = await db.insert(wabas).values(values).returning();
    return result;
  }

  async getWabasByUser(userId: string): Promise<Waba[]> {
    return db.select().from(wabas).where(eq(wabas.userId, userId)).orderBy(desc(wabas.createdAt));
  }

  async getAllWabas(): Promise<Waba[]> {
    return db.select().from(wabas).orderBy(desc(wabas.createdAt));
  }

  async getWabaById(id: string): Promise<Waba | undefined> {
    const [result] = await db.select().from(wabas).where(eq(wabas.id, id));
    return result;
  }

  async updateWaba(id: string, updates: Partial<Waba>): Promise<Waba | undefined> {
    const [result] = await db.update(wabas).set({ ...updates, updatedAt: new Date() }).where(eq(wabas.id, id)).returning();
    return result;
  }

  async deleteWaba(id: string): Promise<boolean> {
    const result = await db.delete(wabas).where(eq(wabas.id, id));
    return true;
  }

  async getWabaNumbers(wabaId: string): Promise<WabaNumber[]> {
    return db.select().from(wabaNumbers).where(eq(wabaNumbers.wabaId, wabaId));
  }

  async upsertWabaNumber(data: { wabaId: string; phoneNumberId: string; displayNumber: string; verifiedName?: string; qualityRating?: string; tier?: string | null }): Promise<WabaNumber> {
    const existing = await db.select().from(wabaNumbers)
      .where(and(eq(wabaNumbers.wabaId, data.wabaId), eq(wabaNumbers.phoneNumberId, data.phoneNumberId)));

    if (existing.length > 0) {
      const newTier = data.tier || null;
      if (!newTier && existing[0].tier) {
        console.warn(`[wabaStorage] upsertWabaNumber: tier ausente/falsy para ${data.phoneNumberId} — mantendo tier atual "${existing[0].tier}" (não sobrescrevendo com TIER_250 implícito)`);
      }
      const [result] = await db.update(wabaNumbers).set({
        displayNumber: data.displayNumber,
        verifiedName: data.verifiedName || existing[0].verifiedName,
        qualityRating: data.qualityRating || existing[0].qualityRating,
        tier: newTier || existing[0].tier,
      }).where(eq(wabaNumbers.id, existing[0].id)).returning();
      return result;
    }

    const [result] = await db.insert(wabaNumbers).values({
      wabaId: data.wabaId,
      phoneNumberId: data.phoneNumberId,
      displayNumber: data.displayNumber,
      verifiedName: data.verifiedName || null,
      qualityRating: data.qualityRating || "UNKNOWN",
      tier: data.tier || "TIER_250",
    }).returning();
    return result;
  }

  async findWabaByExternalId(externalWabaId: string): Promise<Waba | undefined> {
    const [result] = await db.select().from(wabas).where(eq(wabas.wabaId, externalWabaId));
    return result;
  }

  async findWabaByPhoneNumberId(phoneNumberId: string): Promise<Waba | undefined> {
    const [num] = await db.select().from(wabaNumbers).where(eq(wabaNumbers.phoneNumberId, phoneNumberId));
    if (!num) return undefined;
    return this.getWabaById(num.wabaId);
  }

  async getConversations(wabaId: string, options?: { search?: string; limit?: number; offset?: number }): Promise<{ data: Conversation[]; total: number }> {
    const conditions = [eq(conversations.wabaId, wabaId)];
    if (options?.search) {
      conditions.push(
        or(
          like(conversations.contactPhone, `%${options.search}%`),
          like(conversations.contactName, `%${options.search}%`)
        )!
      );
    }
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(conversations).where(where);
    const total = Number(countResult?.count || 0);
    const rows = await db.select().from(conversations).where(where)
      .orderBy(desc(conversations.lastMessageAt))
      .limit(options?.limit || 50)
      .offset(options?.offset || 0);
    return { data: rows, total };
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const [result] = await db.select().from(conversations).where(eq(conversations.id, id));
    return result;
  }

  async getOrCreateConversation(wabaId: string, contactPhone: string, contactName?: string, campaignId?: string, contactWaId?: string): Promise<Conversation> {
    let existing: Conversation[] = [];

    if (contactWaId) {
      const waIdConditions: any[] = [eq(conversations.wabaId, wabaId), eq(conversations.contactWaId, contactWaId)];
      if (campaignId) waIdConditions.push(eq(conversations.campaignId, campaignId));
      existing = await db.select().from(conversations).where(and(...waIdConditions));
    }

    if (existing.length === 0) {
      const phoneConditions: any[] = [eq(conversations.wabaId, wabaId), eq(conversations.contactPhone, contactPhone)];
      if (campaignId) phoneConditions.push(eq(conversations.campaignId, campaignId));
      existing = await db.select().from(conversations).where(and(...phoneConditions));
    }

    if (existing.length > 0) {
      const updates: Partial<Conversation> = {};
      if (contactName && contactName !== existing[0].contactName) updates.contactName = contactName;
      if (campaignId && !existing[0].campaignId) updates.campaignId = campaignId;
      if (contactWaId && !existing[0].contactWaId) updates.contactWaId = contactWaId;
      if (Object.keys(updates).length > 0) {
        const [updated] = await db.update(conversations).set(updates).where(eq(conversations.id, existing[0].id)).returning();
        return updated;
      }
      return existing[0];
    }

    const [result] = await db.insert(conversations).values({
      wabaId,
      campaignId: campaignId || null,
      contactPhone,
      contactWaId: contactWaId || null,
      contactName: contactName || null,
    }).returning();
    return result;
  }

  async findConversationsByPhone(wabaId: string, contactPhone: string): Promise<Conversation[]> {
    return db.select().from(conversations)
      .where(and(
        eq(conversations.wabaId, wabaId),
        eq(conversations.contactPhone, contactPhone)
      ));
  }

  async findActiveCampaignConversation(wabaId: string, contactPhone: string, contactWaId?: string): Promise<Conversation | null> {
    const { inArray } = await import("drizzle-orm");
    const { canonicalPhone } = await import("./services/bot/BotFlowEngine");
    const normalizedPhone = canonicalPhone(contactPhone);
    const phonesToSearch = [contactPhone];
    if (normalizedPhone !== contactPhone) phonesToSearch.push(normalizedPhone);
    const botEligibleStatuses = ["running", "completed", "paused"];

    const isWithinCSWWindow = (campaign: { status: string; completedAt: Date | null }): boolean => {
      if (campaign.status === "running" || campaign.status === "paused") return true;
      if (campaign.status === "completed") {
        return true;
      }
      return false;
    };

    if (contactWaId) {
      const byWaIdResults = await db.select({ conversation: conversations, campaignStatus: campaigns.status, campaignCompletedAt: campaigns.completedAt })
        .from(conversations)
        .innerJoin(campaigns, eq(conversations.campaignId, campaigns.id))
        .where(and(
          eq(conversations.wabaId, wabaId),
          eq(conversations.contactWaId, contactWaId),
          isNotNull(conversations.campaignId),
          inArray(campaigns.status, botEligibleStatuses)
        ))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(5);

      for (const row of byWaIdResults) {
        if (isWithinCSWWindow({ status: row.campaignStatus, completedAt: row.campaignCompletedAt })) {
          console.log(`[WEBHOOK] findActiveCampaignConversation: matched campaign conversation by wa_id ${contactWaId} wabaId ${wabaId} → convo ${row.conversation.id} (status=${row.campaignStatus})`);
          return row.conversation;
        }
      }
    }

    const phoneOrCondition = phonesToSearch.length > 1
      ? or(...phonesToSearch.map(p => eq(conversations.contactPhone, p)))
      : eq(conversations.contactPhone, contactPhone);
    const phoneResults = await db.select({ conversation: conversations, campaignStatus: campaigns.status, campaignCompletedAt: campaigns.completedAt })
      .from(conversations)
      .innerJoin(campaigns, eq(conversations.campaignId, campaigns.id))
      .where(and(
        eq(conversations.wabaId, wabaId),
        phoneOrCondition!,
        isNotNull(conversations.campaignId),
        inArray(campaigns.status, botEligibleStatuses)
      ))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(5);

    for (const row of phoneResults) {
      if (isWithinCSWWindow({ status: row.campaignStatus, completedAt: row.campaignCompletedAt })) {
        console.log(`[WEBHOOK] findActiveCampaignConversation: matched campaign conversation for phone ${contactPhone} wabaId ${wabaId} → convo ${row.conversation.id} (status=${row.campaignStatus})`);
        return row.conversation;
      }
    }

    const fallbackPhoneOr = phonesToSearch.length > 1
      ? or(...phonesToSearch.map(p => eq(conversations.contactPhone, p)))
      : eq(conversations.contactPhone, contactPhone);
    const fallbackResults = await db.select({ conversation: conversations, campaignStatus: campaigns.status, campaignCompletedAt: campaigns.completedAt })
      .from(conversations)
      .innerJoin(campaigns, eq(conversations.campaignId, campaigns.id))
      .where(and(
        eq(conversations.wabaId, wabaId),
        fallbackPhoneOr!,
        isNotNull(conversations.campaignId)
      ))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1);

    if (fallbackResults.length > 0) {
      const fb = fallbackResults[0];
      if (isWithinCSWWindow({ status: fb.campaignStatus, completedAt: fb.campaignCompletedAt })) {
        console.log(`[WEBHOOK] findActiveCampaignConversation: matched ${fb.campaignStatus} campaign conversation (fallback) for phone ${contactPhone} wabaId ${wabaId} → convo ${fb.conversation.id}`);
        return fb.conversation;
      }
      console.log(`[WEBHOOK] findActiveCampaignConversation: found ${fb.campaignStatus} conversation but outside CSW window for phone ${contactPhone} wabaId ${wabaId}`);
    }

    console.log(`[WEBHOOK] findActiveCampaignConversation: no campaign conversation found for phone ${contactPhone} wabaId ${wabaId}`);
    return null;
  }

  async getConversationsByCampaign(campaignId: string, options?: { search?: string; limit?: number; offset?: number }): Promise<{ data: Conversation[]; total: number }> {
    const conditions: any[] = [eq(conversations.campaignId, campaignId)];
    if (options?.search) {
      conditions.push(
        or(
          like(conversations.contactPhone, `%${options.search}%`),
          like(conversations.contactName, `%${options.search}%`)
        )!
      );
    }
    const where = conditions.length > 1 ? and(...conditions) : conditions[0];
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(conversations).where(where);
    const total = Number(countResult?.count || 0);
    const rows = await db.select().from(conversations).where(where)
      .orderBy(desc(conversations.lastMessageAt))
      .limit(options?.limit || 50)
      .offset(options?.offset || 0);
    return { data: rows, total };
  }

  async updateConversation(id: string, updates: Partial<Conversation>): Promise<Conversation | undefined> {
    const [result] = await db.update(conversations).set(updates).where(eq(conversations.id, id)).returning();
    return result;
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.sentAt));
  }

  async createMessage(data: { conversationId: string; direction: string; body?: string; type?: string; mediaUrl?: string; metaMessageId?: string; status?: string }): Promise<Message> {
    const [result] = await db.insert(messages).values({
      conversationId: data.conversationId,
      direction: data.direction,
      body: data.body || null,
      type: data.type || "text",
      mediaUrl: data.mediaUrl || null,
      metaMessageId: data.metaMessageId || null,
      status: data.status || "sent",
    }).returning();
    return result;
  }

  async getMessageByMetaId(metaMessageId: string): Promise<Message | undefined> {
    const [result] = await db.select().from(messages).where(eq(messages.metaMessageId, metaMessageId));
    return result;
  }

  async updateMessageStatus(metaMessageId: string, status: string): Promise<Message | undefined> {
    const updates: Partial<Message> = { status };
    if (status === "delivered") updates.deliveredAt = new Date();
    if (status === "read") { updates.deliveredAt = new Date(); updates.readAt = new Date(); }

    const [result] = await db.update(messages).set(updates).where(eq(messages.metaMessageId, metaMessageId)).returning();
    return result;
  }

  async getAutomationRules(campaignId: string): Promise<CampaignAutomationRule[]> {
    return db.select().from(campaignAutomationRules)
      .where(and(eq(campaignAutomationRules.campaignId, campaignId), eq(campaignAutomationRules.isActive, true)))
      .orderBy(asc(campaignAutomationRules.priority));
  }

  async createAutomationRule(data: { campaignId: string; keyword: string; response: string; priority?: number; responseType?: string; mediaUrl?: string; buttonPayload?: any }): Promise<CampaignAutomationRule> {
    const [result] = await db.insert(campaignAutomationRules).values({
      campaignId: data.campaignId,
      keyword: data.keyword,
      response: data.response,
      responseType: data.responseType || "text",
      mediaUrl: data.mediaUrl || null,
      buttonPayload: data.buttonPayload || null,
      priority: data.priority || 0,
    }).returning();
    return result;
  }

  async deleteAutomationRule(id: string): Promise<boolean> {
    await db.delete(campaignAutomationRules).where(eq(campaignAutomationRules.id, id));
    return true;
  }

  async updateAutomationRules(campaignId: string, rules: { keyword: string; response: string; priority?: number; responseType?: string; mediaUrl?: string; buttonPayload?: any }[]): Promise<CampaignAutomationRule[]> {
    await db.delete(campaignAutomationRules).where(eq(campaignAutomationRules.campaignId, campaignId));
    const results: CampaignAutomationRule[] = [];
    for (let i = 0; i < rules.length; i++) {
      const rule = await this.createAutomationRule({
        campaignId,
        keyword: rules[i].keyword,
        response: rules[i].response,
        responseType: rules[i].responseType || "text",
        mediaUrl: rules[i].mediaUrl,
        buttonPayload: rules[i].buttonPayload,
        priority: rules[i].priority ?? i,
      });
      results.push(rule);
    }
    return results;
  }

  async getParameterModels(userId: string): Promise<ParameterModel[]> {
    return db.select().from(parameterModels).where(eq(parameterModels.userId, userId)).orderBy(desc(parameterModels.createdAt));
  }

  async createParameterModel(data: { userId: string; name: string; templateName?: string; parameters: Record<string, unknown> }): Promise<ParameterModel> {
    const [result] = await db.insert(parameterModels).values({
      userId: data.userId,
      name: data.name,
      templateName: data.templateName || null,
      parameters: data.parameters,
    }).returning();
    return result;
  }

  async deleteParameterModel(id: string): Promise<boolean> {
    await db.delete(parameterModels).where(eq(parameterModels.id, id));
    return true;
  }

  async getBotRules(userId: string): Promise<BotRule[]> {
    return db.select().from(botRules)
      .where(eq(botRules.userId, userId))
      .orderBy(asc(botRules.priority));
  }

  async getActiveBotRules(userId: string): Promise<BotRule[]> {
    return db.select().from(botRules)
      .where(and(eq(botRules.userId, userId), eq(botRules.isActive, true)))
      .orderBy(asc(botRules.priority));
  }

  async createBotRule(data: { userId: string; keyword: string; response: string; responseType?: string; mediaUrl?: string; buttonPayload?: any; priority?: number; isActive?: boolean }): Promise<BotRule> {
    const [result] = await db.insert(botRules).values({
      userId: data.userId,
      keyword: data.keyword,
      response: data.response,
      responseType: data.responseType || "text",
      mediaUrl: data.mediaUrl || null,
      buttonPayload: data.buttonPayload || null,
      priority: data.priority || 0,
      isActive: data.isActive ?? true,
    }).returning();
    return result;
  }

  async updateBotRule(id: string, userId: string, data: Partial<BotRule>): Promise<BotRule | undefined> {
    const [result] = await db.update(botRules).set(data).where(and(eq(botRules.id, id), eq(botRules.userId, userId))).returning();
    return result;
  }

  async deleteBotRule(id: string, userId: string): Promise<boolean> {
    await db.delete(botRules).where(and(eq(botRules.id, id), eq(botRules.userId, userId)));
    return true;
  }

  async getBotSettings(userId: string): Promise<BotSettings | undefined> {
    const [result] = await db.select().from(botSettings).where(eq(botSettings.userId, userId));
    return result;
  }

  async upsertBotSettings(userId: string, data: { isActive?: boolean; fallbackMessage?: string }): Promise<BotSettings> {
    const existing = await this.getBotSettings(userId);
    if (existing) {
      const [result] = await db.update(botSettings).set({ ...data, updatedAt: new Date() }).where(eq(botSettings.id, existing.id)).returning();
      return result;
    }
    const [result] = await db.insert(botSettings).values({
      userId,
      isActive: data.isActive ?? false,
      fallbackMessage: data.fallbackMessage || null,
    }).returning();
    return result;
  }

  async getWabaMetrics(wabaId: string): Promise<{ sent: number; delivered: number; read: number; replied: number }> {
    const allConvos = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.wabaId, wabaId));
    if (allConvos.length === 0) return { sent: 0, delivered: 0, read: 0, replied: 0 };

    const convoIds = allConvos.map(c => c.id);
    const allMessages = await db.select({
      direction: messages.direction,
      status: messages.status,
    }).from(messages).where(sql`${messages.conversationId} = ANY(${convoIds})`);

    let sent = 0, delivered = 0, read = 0, replied = 0;
    for (const msg of allMessages) {
      if (msg.direction === "outbound") {
        sent++;
        if (msg.status === "delivered" || msg.status === "read") delivered++;
        if (msg.status === "read") read++;
      } else if (msg.direction === "inbound") {
        replied++;
      }
    }
    return { sent, delivered, read, replied };
  }
}

export const wabaStorage = new WabaStorage();
