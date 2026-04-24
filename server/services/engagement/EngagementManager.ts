import { db } from '../../db';
import { followUpRules, followUpStatus } from '@shared/schema';
import { eq, and, lt, sql, isNull } from 'drizzle-orm';
import type { FollowUpRule } from '@shared/schema';
import { logError } from '../../utils/logger';

export interface FollowUpConfig {
  campaignId: string;
  stages: Array<{
    stage: number;
    delayMinutes: number;
    templateName?: string;
    messageText?: string;
  }>;
}

export async function createFollowUpRules(config: FollowUpConfig): Promise<FollowUpRule[]> {
  const created: FollowUpRule[] = [];

  for (const stage of config.stages) {
    const [rule] = await db.insert(followUpRules).values({
      campaignId: config.campaignId,
      stage: stage.stage,
      delayMinutes: stage.delayMinutes,
      templateName: stage.templateName || null,
      messageText: stage.messageText || null,
      isActive: true,
    }).returning();
    created.push(rule);
  }

  console.log(`📋 ${created.length} follow-up rules criadas para campanha ${config.campaignId}`);
  return created;
}

export async function initializeLeadFollowUp(
  campaignId: string,
  phones: string[]
): Promise<number> {
  let initialized = 0;

  for (const phone of phones) {
    try {
      await db.insert(followUpStatus).values({
        campaignId,
        phone,
        currentStage: 0,
        hasReplied: false,
        isCompleted: false,
      }).onConflictDoNothing();
      initialized++;
    } catch (e: any) {
      logError('[EngagementManager] Failed to initialize engagement row', {}, new Error('[EngagementManager] Failed to initialize engagement row'));
    }
  }

  return initialized;
}

export async function markReplied(campaignId: string, phone: string): Promise<void> {
  await db
    .update(followUpStatus)
    .set({
      hasReplied: true,
      isCompleted: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(followUpStatus.campaignId, campaignId),
        eq(followUpStatus.phone, phone)
      )
    );
}

export async function getPendingFollowUps(campaignId: string): Promise<Array<{
  phone: string;
  currentStage: number;
  nextStage: number;
  rule: FollowUpRule;
}>> {
  const rules = await db
    .select()
    .from(followUpRules)
    .where(
      and(
        eq(followUpRules.campaignId, campaignId),
        eq(followUpRules.isActive, true)
      )
    );

  if (rules.length === 0) return [];

  const statuses = await db
    .select()
    .from(followUpStatus)
    .where(
      and(
        eq(followUpStatus.campaignId, campaignId),
        eq(followUpStatus.hasReplied, false),
        eq(followUpStatus.isCompleted, false)
      )
    );

  const now = new Date();
  const pending: Array<{
    phone: string;
    currentStage: number;
    nextStage: number;
    rule: FollowUpRule;
  }> = [];

  for (const status of statuses) {
    const nextStage = status.currentStage + 1;
    const rule = rules.find(r => r.stage === nextStage);
    if (!rule) {
      await db
        .update(followUpStatus)
        .set({ isCompleted: true, updatedAt: new Date() })
        .where(eq(followUpStatus.id, status.id));
      continue;
    }

    const lastAction = status.lastFollowUpAt || status.createdAt;
    if (!lastAction) continue;

    const elapsed = (now.getTime() - new Date(lastAction).getTime()) / (1000 * 60);
    if (elapsed >= rule.delayMinutes) {
      pending.push({
        phone: status.phone,
        currentStage: status.currentStage,
        nextStage,
        rule,
      });
    }
  }

  return pending;
}

export async function advanceFollowUp(
  campaignId: string,
  phone: string,
  newStage: number
): Promise<void> {
  await db
    .update(followUpStatus)
    .set({
      currentStage: newStage,
      lastFollowUpAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(followUpStatus.campaignId, campaignId),
        eq(followUpStatus.phone, phone)
      )
    );
}

export async function getRulesForCampaign(campaignId: string): Promise<FollowUpRule[]> {
  return db
    .select()
    .from(followUpRules)
    .where(eq(followUpRules.campaignId, campaignId));
}

export async function getFollowUpStats(campaignId: string): Promise<{
  total: number;
  replied: number;
  completed: number;
  pending: number;
  byStage: Record<number, number>;
}> {
  const statuses = await db
    .select()
    .from(followUpStatus)
    .where(eq(followUpStatus.campaignId, campaignId));

  const byStage: Record<number, number> = {};
  let replied = 0;
  let completed = 0;
  let pending = 0;

  for (const s of statuses) {
    byStage[s.currentStage] = (byStage[s.currentStage] || 0) + 1;
    if (s.hasReplied) replied++;
    if (s.isCompleted) completed++;
    if (!s.hasReplied && !s.isCompleted) pending++;
  }

  return {
    total: statuses.length,
    replied,
    completed,
    pending,
    byStage,
  };
}

export async function deleteRulesForCampaign(campaignId: string): Promise<void> {
  await db.delete(followUpRules).where(eq(followUpRules.campaignId, campaignId));
  await db.delete(followUpStatus).where(eq(followUpStatus.campaignId, campaignId));
}
