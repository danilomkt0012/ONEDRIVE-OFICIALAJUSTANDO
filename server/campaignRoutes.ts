import type { Express } from "express";
import { storage } from "./storage";
import { wabaStorage } from "./wabaStorage";
import { db } from "./db";
import { campaigns, messageDeliveries, campaignErrorLogs, campaignAutomationRules, conversations, messages, apiConfigurations, leads as leadsSchema, whatsappTemplates, wabas as wabasTable, botFlows, botFlowNodes, wabaNumbers, ttsJobProgress, voiceProfiles } from "@shared/schema";
import { eq, desc, sql, and, like, count } from "drizzle-orm";
import { z } from "zod";
import { campaignStore } from "./services/campaign/CampaignStore";
import { metricsPublisher } from "./services/observability/CampaignMetricsPublisher";
import { triggerCampaignExecution } from "./services/campaign/executionBridge";
import { generateSignedImageUrl } from "./services/signedUrl";
import { EventEmitter } from "events";
import { logError } from './utils/logger';
import { registerPersistentCampaignTracker, unregisterPersistentCampaignTracker } from './services/engine/DeliveryMetricsTracker';
import { audioStitchingService } from "./services/tts/AudioStitchingService";
import { ttsQueue } from "./services/tts/TtsQueue";

const META_API_VERSION = process.env.META_API_VERSION || process.env.API_VERSION || 'v25.0';

export const campaignHotUpdateEmitter = new EventEmitter();

async function getOwnedCampaign(campaignId: string, userId: string) {
  const [campaign] = await db.select().from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));
  return campaign || null;
}

interface PreGenerateTtsOptions {
  campaignId: string;
  leads: Array<{ id: string; name: string; phone: string; [key: string]: any }>;
  voiceProfile: { id: string; referenceAudioPath: string; name: string };
  ttsTemplate: string;
  speed: number;
  pitch: number;
  volume: number;
  humanize: boolean;
  sendCfg: Record<string, any>;
  resolvedWabaConfigs?: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[]; wabaDbId?: string }>;
  campaignConfig: Record<string, any>;
}

const PRIORITY_LEAD_COUNT = 100;

async function preGenerateAllTtsAudio(opts: PreGenerateTtsOptions): Promise<void> {
  const { campaignId, leads, voiceProfile, ttsTemplate, speed, pitch = 1.0, volume = 1.0, humanize, sendCfg, resolvedWabaConfigs, campaignConfig } = opts;

  console.log(`[TTS_PREGENERATOR] Starting pre-generation for campaign ${campaignId}: ${leads.length} leads (priority first ${PRIORITY_LEAD_COUNT})`);

  await audioStitchingService.preGenerateFixedSegments(
    ttsTemplate,
    voiceProfile.referenceAudioPath,
    voiceProfile.id,
    speed,
    humanize,
    pitch,
    volume
  ).catch(err => {
    logError('preGenerateAllTtsAudio.fixedSegments', { campaignId }, err);
  });

  const priorityLeads = leads.slice(0, PRIORITY_LEAD_COUNT);
  const remainingLeads = leads.slice(PRIORITY_LEAD_COUNT);

  let doneCount = 0;
  let failedCount = 0;
  let campaignTriggered = false;

  const triggerCampaign = async () => {
    if (campaignTriggered) return;
    campaignTriggered = true;
    await db.update(campaigns)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(campaigns.id, campaignId));
    triggerCampaignExecution(campaignId, {
      speedMode: sendCfg.speed || "NORMAL",
      batchingRate: sendCfg.batchingRate || undefined,
      forcedLanguage: sendCfg.forcedLanguage || undefined,
      customMessages: sendCfg.customMessages || undefined,
      isDynamicUrl: campaignConfig.isDynamicUrl || undefined,
      templateNames: sendCfg.templateNames || undefined,
      customRate: sendCfg.customRate || undefined,
      isBlacksky: campaignConfig.isBlacksky || undefined,
      blackskyConfig: campaignConfig.blackskyConfig || undefined,
      isParametroUnico: campaignConfig.isParametroUnico || undefined,
      parametroUnicoConfig: campaignConfig.parametroUnicoConfig || undefined,
      usePackageImage: campaignConfig.usePackageImage === true,
      packageImageType: campaignConfig.packageImageType || undefined,
      packageImageKey: campaignConfig.packageImageKey || undefined,
      customImageTemplateId: campaignConfig.customImageTemplateId || undefined,
      wabaConfigs: resolvedWabaConfigs || undefined,
      templateWeights: sendCfg.templateWeights || undefined,
    }).catch(async (err) => {
      logError('preGenerateAllTtsAudio.triggerExecution', { campaignId }, err instanceof Error ? err : new Error(String(err)));
      await db.update(campaigns).set({ status: "failed", completedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
    });
  };

  const generateForLead = async (lead: typeof leads[number]) => {
    try {
      const variables: Record<string, string> = {};
      if (lead.name) variables['nome'] = lead.name;
      if (lead.phone) variables['telefone'] = lead.phone;
      if (lead.cpf) variables['cpf'] = lead.cpf;
      if (lead.produto) variables['produto'] = lead.produto;
      if (lead.valor) variables['valor'] = lead.valor;
      if (lead.codigoRastreio) variables['codigo_rastreio'] = lead.codigoRastreio;

      await ttsQueue.enqueue({
        template: ttsTemplate,
        variables,
        voiceProfileId: voiceProfile.id,
        speed,
        pitch,
        volume,
        humanize,
        campaignId,
        leadId: lead.id,
      });

      doneCount++;
      console.log(`[TTS_PREGENERATOR] ${doneCount}/${leads.length} leads done (campaign ${campaignId})`);

      if (!campaignTriggered && doneCount >= PRIORITY_LEAD_COUNT) {
        await triggerCampaign();
      }
    } catch (err: any) {
      failedCount++;
      logError('preGenerateAllTtsAudio.lead', { campaignId, leadId: lead.id }, err instanceof Error ? err : new Error(String(err)));
    }
  };

  await Promise.all(priorityLeads.map(lead => generateForLead(lead)));

  if (!campaignTriggered) {
    await triggerCampaign();
  }

  Promise.all(remainingLeads.map(lead => generateForLead(lead))).then(() => {
    console.log(`[TTS_PREGENERATOR] Background generation complete: ${doneCount} done, ${failedCount} failed for campaign ${campaignId}`);
  }).catch(err => {
    logError('preGenerateAllTtsAudio.remaining', { campaignId }, err instanceof Error ? err : new Error(String(err)));
  });
}

export function registerCampaignRoutes(app: Express): void {

  app.get("/api/campaigns/managed", async (req, res) => {
    try {
      const allCampaigns = await db.select().from(campaigns)
        .where(eq(campaigns.userId, req.session.userId!))
        .orderBy(desc(campaigns.createdAt));

      const result = allCampaigns.map(c => {
        const live = campaignStore.getSnapshot(c.id);
        const sent = c.sentMessages || c.sentCount || 0;
        const failed = c.failedMessages || c.failedCount || 0;
        return {
          ...c,
          sentCount: sent,
          failedCount: failed,
          liveMetrics: live ? {
            processed: live.processed,
            accepted: live.accepted,
            failed: live.failed,
            speedCurrent: live.speedCurrent,
            status: live.status,
          } : null,
        };
      });

      res.json(result);
    } catch (error: any) {
      logError("campaignRoutes.listManaged", {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/managed", async (req, res) => {
    try {
      const schema = z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        dispatchMode: z.enum(['seguro', 'equilibrado', 'turbo']).optional(),
      });
      const data = schema.parse(req.body);

      const [campaign] = await db.insert(campaigns).values({
        userId: req.session.userId!,
        name: data.name,
        description: data.description || null,
        dispatchMode: data.dispatchMode || 'equilibrado',
        status: "draft",
        totalLeads: 0,
      }).returning();

      registerPersistentCampaignTracker(campaign.id);
      res.json(campaign);
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Dados inválidos", details: error.errors });
      }
      logError("campaignRoutes.createDraftCampaign", {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================================
  // DISPATCH MODE — perfis, ETA preview, saúde dos números
  // ============================================================================
  app.get("/api/dispatch/profiles", async (_req, res) => {
    try {
      const { DISPATCH_PROFILES } = await import('./services/engine/DispatchProfile');
      res.json({
        profiles: Object.values(DISPATCH_PROFILES).map(p => ({
          mode: p.mode,
          label: p.label,
          description: p.description,
          refillRatePerNumber: p.refillRatePerNumber,
          maxConcurrentPerNumber: p.maxConcurrentPerNumber,
          autoPauseOnRedRating: p.autoPauseOnRedRating,
          maxMessagesPerRecipient24h: p.maxMessagesPerRecipient24h,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/dispatch/eta", async (req, res) => {
    try {
      const totalLeads = parseInt(req.query.totalLeads as string) || 2000;
      const numberCount = parseInt(req.query.numberCount as string) || 5;
      const mode = (req.query.mode as string) || 'equilibrado';

      const { estimateEtaMinutes } = await import('./services/engine/DispatchProfile');
      const all = ['seguro', 'equilibrado', 'turbo'].map(m => {
        const r = estimateEtaMinutes(totalLeads, numberCount, m);
        return {
          mode: m,
          label: r.profile.label,
          description: r.profile.description,
          etaMinutes: Math.round(r.etaMinutes * 10) / 10,
          etaSeconds: Math.round(r.etaSeconds),
          effectiveRate: Math.round(r.effectiveRate * 100) / 100,
          msgsPerHour: Math.round(r.effectiveRate * 3600),
        };
      });
      const selected = all.find(x => x.mode === mode) || all[1];
      res.json({ selected, all, totalLeads, numberCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/dispatch/sender-health", async (req, res) => {
    try {
      const userId = req.session.userId!;
      // Coleta phoneNumberIds de todas as WABAs do user
      const userWabas = await wabaStorage.getWabasByUser(userId);
      const allNumbers: Array<{ phoneNumberId: string; displayNumber?: string; wabaName?: string }> = [];
      for (const w of userWabas) {
        const nums = await wabaStorage.getWabaNumbers(w.id);
        for (const n of nums) {
          allNumbers.push({
            phoneNumberId: n.phoneNumberId,
            displayNumber: n.displayNumber,
            wabaName: w.name,
          });
        }
      }

      if (allNumbers.length === 0) {
        return res.json({ numbers: [], totalNumbers: 0 });
      }

      const { getHealthSummary } = await import('./services/engine/AdaptiveScoring');
      const summary = await getHealthSummary(allNumbers.map(n => n.phoneNumberId));
      const merged = summary.map(s => {
        const meta = allNumbers.find(n => n.phoneNumberId === s.phoneNumberId);
        return {
          ...s,
          displayNumber: meta?.displayNumber,
          wabaName: meta?.wabaName,
          weightSharePercent: Math.round(s.weightShare * 1000) / 10,
        };
      });
      res.json({ numbers: merged, totalNumbers: merged.length });
    } catch (error: any) {
      logError('campaignRoutes.senderHealth', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/dispatch-mode", async (req, res) => {
    try {
      const schema = z.object({
        dispatchMode: z.enum(['seguro', 'equilibrado', 'turbo']),
      });
      const data = schema.parse(req.body);
      const [updated] = await db.update(campaigns)
        .set({ dispatchMode: data.dispatchMode, updatedAt: new Date() })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Modo inválido", details: error.errors });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const rules = await wabaStorage.getAutomationRules(campaign.id);
      const live = campaignStore.getSnapshot(campaign.id);
      const logs = campaignStore.getLogs(campaign.id);

      const sent = campaign.sentMessages || campaign.sentCount || 0;
      const failed = campaign.failedMessages || campaign.failedCount || 0;

      res.json({
        ...campaign,
        sentCount: sent,
        failedCount: failed,
        automationRules: rules,
        liveMetrics: live,
        recentLogs: logs.slice(-100),
      });
    } catch (error: any) {
      logError("campaignRoutes.getCampaign", { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/info", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const schema = z.object({
        name: z.string().min(1).optional(),
        description: z.string().max(500).optional(),
        isTestMode: z.boolean().optional(),
      });
      const data = schema.parse(req.body);

      const [updated] = await db.update(campaigns)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.patchInfo', { campaignId: req.params.id }, error);
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/waba", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const schema = z.object({
        wabaId: z.string().optional(),
        wabaConfig: z.record(z.unknown()).optional(),
        selectedNumbers: z.array(z.record(z.unknown())).optional(),
      });
      const data = schema.parse(req.body);

      const [updated] = await db.update(campaigns)
        .set({
          wabaId: data.wabaId,
          wabaConfig: data.wabaConfig,
          selectedNumbers: data.selectedNumbers,
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });

      if (data.wabaId) {
        try {
          const userId = req.session.userId!;
          const waba = await wabaStorage.getWabaById(data.wabaId);
          if (waba && waba.userId === userId) {
            const [userConfig] = await db.select().from(apiConfigurations).where(eq(apiConfigurations.userId, userId));
            const cfgSecret = userConfig?.appSecret;
            const wSecret = waba.appSecret;
            if (cfgSecret && cfgSecret !== wSecret) {
              await db.update(wabasTable).set({ appSecret: cfgSecret, updatedAt: new Date() })
                .where(and(eq(wabasTable.id, data.wabaId), eq(wabasTable.userId, userId)));
              console.log(`[CampaignWABA] Synced appSecret (api_configurations → WABA ${data.wabaId}) on campaign update`);
            } else if (wSecret && userConfig && !cfgSecret) {
              await db.update(apiConfigurations).set({ appSecret: wSecret, updatedAt: new Date() })
                .where(and(eq(apiConfigurations.id, userConfig.id), eq(apiConfigurations.userId, userId)));
              console.log(`[CampaignWABA] Synced appSecret (WABA ${data.wabaId} → api_configurations) on campaign update`);
            }
          } else if (waba) {
            console.warn(`[CampaignWABA] WABA ${data.wabaId} does not belong to user ${userId} — skipping appSecret sync`);
          }
        } catch (syncErr: any) {
          console.warn(`[CampaignWABA] appSecret sync on campaign WABA update failed: ${syncErr.message}`);
        }
      }

      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.patchWaba', { campaignId: req.params.id }, error);
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/templates", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const schema = z.object({
        templateId: z.string().optional(),
        templateIds: z.array(z.string()).optional(),
      });
      const data = schema.parse(req.body);

      const [updated] = await db.update(campaigns)
        .set({
          templateId: data.templateId,
          templateIds: data.templateIds,
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.patchTemplates', { campaignId: req.params.id }, error);
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/bot", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const schema = z.object({
        botConfig: z.record(z.unknown()).optional(),
        automationEnabled: z.boolean().optional(),
        automationFallback: z.string().optional(),
        fallbackMessage: z.string().optional(),
        rules: z.array(z.object({
          keyword: z.string(),
          response: z.string(),
          responseType: z.string().optional(),
          mediaUrl: z.string().optional(),
          priority: z.number().optional(),
        })).optional(),
      });
      const data = schema.parse(req.body);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.botConfig !== undefined) {
        updates.botConfig = data.botConfig;
      } else if (data.fallbackMessage !== undefined) {
        const existingBotConfig = (campaign.botConfig as Record<string, unknown>) || {};
        updates.botConfig = { ...existingBotConfig, fallbackMessage: data.fallbackMessage };
      }
      if (data.automationEnabled !== undefined) updates.automationEnabled = data.automationEnabled;
      if (data.automationFallback !== undefined) updates.automationFallback = data.automationFallback;

      const [updated] = await db.update(campaigns)
        .set(updates as Record<string, unknown>)
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });

      if (data.rules !== undefined) {
        await wabaStorage.updateAutomationRules(req.params.id, data.rules);
      }

      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.patchBot', { campaignId: req.params.id }, error);
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/contacts", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const schema = z.object({
        leadListId: z.string().optional(),
        totalLeads: z.number().optional(),
      });
      const data = schema.parse(req.body);

      const [updated] = await db.update(campaigns)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.patchContacts', { campaignId: req.params.id }, error);
      res.status(400).json({ error: error.message });
    }
  });

  app.patch("/api/campaigns/managed/:id/send-config", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const schema = z.object({
        sendConfig: z.record(z.unknown()).optional(),
        burstMode: z.boolean().optional(),
        dispatchMode: z.enum(['seguro', 'equilibrado', 'turbo']).optional(),
        businessHoursOnly: z.boolean().optional(),
        businessHoursStart: z.number().optional(),
        businessHoursEnd: z.number().optional(),
        scheduledAt: z.string().nullable().optional(),
        conversionMessage: z.string().optional(),
        conversionLink: z.string().optional(),
        conversionDelayMs: z.number().optional(),
        campaignConfig: z.record(z.unknown()).optional(),
      });
      const data = schema.parse(req.body);

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.sendConfig !== undefined) updates.sendConfig = data.sendConfig;
      if (data.burstMode !== undefined) updates.burstMode = data.burstMode;
      if (data.dispatchMode !== undefined) updates.dispatchMode = data.dispatchMode;
      if (data.businessHoursOnly !== undefined) updates.businessHoursOnly = data.businessHoursOnly;
      if (data.businessHoursStart !== undefined) updates.businessHoursStart = data.businessHoursStart;
      if (data.businessHoursEnd !== undefined) updates.businessHoursEnd = data.businessHoursEnd;
      if (data.scheduledAt !== undefined) updates.scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
      if (data.conversionMessage !== undefined) updates.conversionMessage = data.conversionMessage;
      if (data.conversionLink !== undefined) updates.conversionLink = data.conversionLink;
      if (data.conversionDelayMs !== undefined) updates.conversionDelayMs = data.conversionDelayMs;
      if (data.campaignConfig !== undefined) {
        const existingCampaign = await getOwnedCampaign(req.params.id, req.session.userId!);
        const existingConfig = (existingCampaign?.campaignConfig || {}) as Record<string, unknown>;
        updates.campaignConfig = { ...existingConfig, ...data.campaignConfig };
      }

      const [updated] = await db.update(campaigns)
        .set(updates)
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.patchSendConfig', { campaignId: req.params.id }, error);
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id/validate", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const warnings: string[] = [];
      const errors: string[] = [];
      const userId = req.session.userId!;

      if (campaign.wabaId) {
        const waba = await wabaStorage.getWabaById(campaign.wabaId);
        if (!waba) {
          errors.push("WABA selecionada não encontrada.");
        } else {
          if (!waba.accessToken) {
            errors.push("WABA selecionada não possui Access Token configurado.");
          }

          const [userConfig] = await db.select().from(apiConfigurations).where(eq(apiConfigurations.userId, userId));
          const hasAppSecret = !!(waba.appSecret || userConfig?.appSecret);
          if (!hasAppSecret) {
            errors.push("App Secret não está configurado. Configure o App Secret nas configurações de API antes de iniciar.");
          }

          const numbers = await db.select().from(wabaNumbers).where(eq(wabaNumbers.wabaId, campaign.wabaId));
          if (numbers.length === 0) {
            errors.push("Nenhum número de telefone registrado para esta WABA. Registre números antes de iniciar.");
          }
        }
      } else {
        errors.push("Nenhuma WABA selecionada para a campanha.");
      }

      if (campaign.automationEnabled) {
        const [flow] = await db.select().from(botFlows).where(and(eq(botFlows.campaignId, campaign.id), eq(botFlows.isActive, true)));
        if (!flow) {
          errors.push("Automação ativada mas nenhum fluxo de bot ativo encontrado para esta campanha.");
        } else {
          const nodes = await db.select().from(botFlowNodes).where(eq(botFlowNodes.flowId, flow.id));
          if (nodes.length === 0) {
            errors.push("Fluxo de bot ativo mas sem nenhum nó configurado. Adicione pelo menos um nó ao fluxo.");
          }
        }
      }

      res.json({ valid: errors.length === 0, errors, warnings });
    } catch (error: any) {
      logError("campaignRoutes.validateCampaign", { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/managed/:id/start", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      if (!["draft", "paused", "generating_audio"].includes(campaign.status)) {
        return res.status(400).json({ error: `Campanha com status '${campaign.status}' não pode ser iniciada` });
      }

      const userId = req.session.userId!;

      if (campaign.leadListId) {
        const [leadCountResult] = await db.select({ total: count() }).from(leadsSchema).where(eq(leadsSchema.leadListId, campaign.leadListId));
        const leadCount = Number(leadCountResult?.total || 0);
        if (leadCount === 0) {
          return res.status(400).json({ error: "A lista de leads associada esta vazia. Adicione contatos antes de iniciar a campanha." });
        }
      } else {
        return res.status(400).json({ error: "Nenhuma lista de leads associada a campanha. Configure os contatos antes de iniciar." });
      }

      if (campaign.wabaId) {
        const waba = await wabaStorage.getWabaById(campaign.wabaId);
        if (!waba || waba.userId !== userId) {
          return res.status(400).json({ error: "WABA selecionada não encontrada ou não pertence a sua conta." });
        }
        if (!waba.accessToken || !waba.wabaId) {
          return res.status(400).json({ error: "WABA selecionada não possui token de acesso válido. Reconfigure a WABA." });
        }
        const [existingConfig] = await db.select().from(apiConfigurations).where(eq(apiConfigurations.userId, userId));
        if (existingConfig) {
          await db.update(apiConfigurations).set({
            metaToken: waba.accessToken,
            whatsappBusinessId: waba.wabaId,
            isValid: true,
            updatedAt: new Date(),
          }).where(eq(apiConfigurations.id, existingConfig.id));
        } else {
          await db.insert(apiConfigurations).values({
            userId,
            metaToken: waba.accessToken,
            whatsappBusinessId: waba.wabaId,
            isValid: true,
          });
        }
        console.log(`[ManagedStart] Synced WABA credentials to api_configurations for user ${userId}`);

        const [currentConfig] = await db.select().from(apiConfigurations).where(eq(apiConfigurations.userId, userId));
        const configSecret = currentConfig?.appSecret;
        const wabaSecret = waba.appSecret;
        let effectiveSecret: string | null = null;

        if (configSecret && wabaSecret && configSecret !== wabaSecret) {
          effectiveSecret = configSecret;
          await db.update(wabasTable).set({
            appSecret: configSecret,
            updatedAt: new Date(),
          }).where(and(eq(wabasTable.id, campaign.wabaId), eq(wabasTable.userId, userId)));
          console.log(`[ManagedStart] appSecret MISMATCH resolved: api_configurations wins, updated WABA ${campaign.wabaId}`);
        } else if (configSecret && !wabaSecret) {
          effectiveSecret = configSecret;
          await db.update(wabasTable).set({
            appSecret: configSecret,
            updatedAt: new Date(),
          }).where(and(eq(wabasTable.id, campaign.wabaId), eq(wabasTable.userId, userId)));
          console.log(`[ManagedStart] Propagated appSecret from api_configurations to WABA ${campaign.wabaId}`);
        } else if (wabaSecret && currentConfig && !configSecret) {
          effectiveSecret = wabaSecret;
          await db.update(apiConfigurations).set({
            appSecret: wabaSecret,
            updatedAt: new Date(),
          }).where(and(eq(apiConfigurations.id, currentConfig.id), eq(apiConfigurations.userId, userId)));
          console.log(`[ManagedStart] Propagated appSecret from WABA ${campaign.wabaId} to api_configurations`);
        } else {
          effectiveSecret = configSecret || wabaSecret || null;
        }

        if (effectiveSecret) {
          const userWabas = await wabaStorage.getWabasByUser(userId);
          for (const uw of userWabas) {
            if (uw.id !== campaign.wabaId && uw.appSecret !== effectiveSecret) {
              await db.update(wabasTable).set({
                appSecret: effectiveSecret,
                updatedAt: new Date(),
              }).where(and(eq(wabasTable.id, uw.id), eq(wabasTable.userId, userId)));
              console.log(`[ManagedStart] Synchronized appSecret to WABA ${uw.id}`);
            }
          }
        }
      } else {
        const [existingConfig] = await db.select().from(apiConfigurations).where(eq(apiConfigurations.userId, userId));
        if (!existingConfig || !existingConfig.isValid) {
          return res.status(400).json({ error: "Nenhuma WABA ou configuracao de API encontrada. Selecione uma WABA na etapa de conexao." });
        }
      }

      const templateIds = (campaign.templateIds || []) as string[];
      if (!campaign.templateId && templateIds.length === 0) {
        return res.status(400).json({ error: "Nenhum template selecionado para a campanha." });
      }

      const templateIdsToCheck = campaign.templateId
        ? [campaign.templateId, ...templateIds.filter((id: string) => id !== campaign.templateId)]
        : templateIds;

      let allUserTemplates = await db.select().from(whatsappTemplates).where(eq(whatsappTemplates.userId, userId));
      console.log(`[ManagedStart] Templates disponíveis para user ${userId}: ${allUserTemplates.length}`, allUserTemplates.map(t => ({ id: t.id, templateId: t.templateId, name: t.name, status: t.status })));
      console.log(`[ManagedStart] templateIdsToCheck:`, templateIdsToCheck);

      let metaFallbackAttempted = false;

      for (const tplId of templateIdsToCheck) {
        let tpl = allUserTemplates.find(t => t.id === tplId);
        if (!tpl) {
          tpl = allUserTemplates.find(t => t.templateId === tplId);
        }
        if (!tpl) {
          tpl = allUserTemplates.find(t => t.name === tplId);
        }

        if (!tpl && !metaFallbackAttempted) {
          metaFallbackAttempted = true;
          const campaignWabaId = campaign.wabaId;
          if (campaignWabaId) {
            try {
              console.log(`[ManagedStart] Template '${tplId}' not in DB, attempting one-time Meta API fallback via WABA ${campaignWabaId}`);
              const waba = await wabaStorage.getWabaById(campaignWabaId);
              if (waba && waba.accessToken && waba.wabaId) {
                const metaResponse = await fetch(
                  `https://graph.facebook.com/${META_API_VERSION}/${waba.wabaId}/message_templates?limit=100`,
                  { headers: { Authorization: `Bearer ${waba.accessToken}` } }
                );
                const metaResult = await metaResponse.json() as { data?: Array<{ id: string; name: string; language: string; category: string; status: string; components: unknown }> };
                const metaTemplates = metaResult.data || [];

                for (const mt of metaTemplates) {
                  const [existing] = await db.select().from(whatsappTemplates)
                    .where(and(
                      eq(whatsappTemplates.templateId, mt.id),
                      eq(whatsappTemplates.userId, userId)
                    ));
                  if (!existing) {
                    await db.insert(whatsappTemplates).values({
                      userId,
                      templateId: mt.id,
                      name: mt.name,
                      language: mt.language,
                      category: mt.category,
                      status: mt.status,
                      components: mt.components,
                      wabaId: campaignWabaId,
                      lastSynced: new Date(),
                    });
                  } else {
                    await db.update(whatsappTemplates).set({
                      name: mt.name,
                      language: mt.language,
                      category: mt.category,
                      status: mt.status,
                      components: mt.components,
                      wabaId: campaignWabaId,
                      lastSynced: new Date(),
                    }).where(eq(whatsappTemplates.id, existing.id));
                  }
                }
                console.log(`[ManagedStart] Synced ${metaTemplates.length} templates from Meta API fallback`);

                allUserTemplates = await db.select().from(whatsappTemplates).where(eq(whatsappTemplates.userId, userId));
                tpl = allUserTemplates.find(t => t.id === tplId)
                  || allUserTemplates.find(t => t.templateId === tplId)
                  || allUserTemplates.find(t => t.name === tplId);
              }
            } catch (fallbackErr) {
              logError('[ManagedStart] Meta API fallback failed:', {}, fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
            }
          }
        }

        if (!tpl) {
          console.error(`[ManagedStart] Template '${tplId}' NAO encontrado. Templates disponiveis:`, allUserTemplates.map(t => `id=${t.id} templateId=${t.templateId} name=${t.name}`));
          return res.status(400).json({ error: `Template '${tplId}' não encontrado. Selecione um template válido na etapa de templates.` });
        }
        if (tpl.status !== "APPROVED") {
          return res.status(400).json({ error: `Template '${tpl.name}' não está aprovado (status: ${tpl.status}). Apenas templates aprovados podem ser usados.` });
        }
        console.log(`[ManagedStart] Template '${tplId}' encontrado: id=${tpl.id}, templateId=${tpl.templateId}, name=${tpl.name}`);
      }

      // --- Preflight: validate each template against its own WABA (fail-closed) ---
      const campaignWabaForPreflight = campaign.wabaId;
      if (!campaignWabaForPreflight) {
        return res.status(400).json({ error: "Campanha sem WABA configurada. Selecione uma WABA antes de iniciar." });
      }

      {
        let preflightError: string | null = null;

        try {
          type MetaTemplate = { name: string; status: string; language: string };

          // Cache Meta template lists per WABA to avoid redundant API calls when
          // multiple templates share the same WABA.
          const wabaTemplateCache = new Map<string, MetaTemplate[]>();

          const fetchMetaTemplatesForWaba = async (wabaDbId: string): Promise<{ templates: MetaTemplate[]; error: string | null }> => {
            if (wabaTemplateCache.has(wabaDbId)) {
              return { templates: wabaTemplateCache.get(wabaDbId)!, error: null };
            }
            const preflightWaba = await wabaStorage.getWabaById(wabaDbId);
            if (!preflightWaba || !preflightWaba.accessToken || !preflightWaba.wabaId) {
              return { templates: [], error: `Credenciais da WABA (id: ${wabaDbId}) não encontradas para validação dos templates. Configure as credenciais Meta na etapa de Integração.` };
            }
            console.log(`[TEMPLATE] Preflight: fetching templates from Meta for WABA ${preflightWaba.wabaId} (db id: ${wabaDbId})`);
            const metaPreflight = await fetch(
              `https://graph.facebook.com/${META_API_VERSION}/${preflightWaba.wabaId}/message_templates?limit=250&fields=name,status,language`,
              { headers: { Authorization: `Bearer ${preflightWaba.accessToken}` } }
            );
            if (!metaPreflight.ok) {
              type MetaErrorBody = { error?: { message?: string } };
              const errBody: MetaErrorBody = await metaPreflight.json().catch(() => ({}));
              const errMsg = errBody?.error?.message ?? `HTTP ${metaPreflight.status}`;
              return { templates: [], error: `Falha ao consultar templates na Meta API para WABA ${preflightWaba.wabaId}: ${errMsg}. Verifique o Access Token da integração.` };
            }
            const preflightResult = await metaPreflight.json() as { data?: MetaTemplate[] };
            const list = preflightResult.data ?? [];
            wabaTemplateCache.set(wabaDbId, list);
            console.log(`[TEMPLATE] Preflight: fetched ${list.length} templates from WABA ${preflightWaba.wabaId}`);
            return { templates: list, error: null };
          };

          for (const tplId of templateIdsToCheck) {
            if (preflightError) break;
            const tpl = allUserTemplates.find(t => t.id === tplId || t.templateId === tplId || t.name === tplId);
            if (!tpl) continue;

            // Resolve which WABA this template belongs to. Use template.wabaId if
            // available (per-WABA templates), otherwise fall back to campaign's WABA.
            const tplWabaDbId = tpl.wabaId || campaignWabaForPreflight;
            console.log(`[TEMPLATE] Preflight: checking template '${tpl.name}' (id=${tpl.id}) against WABA db id ${tplWabaDbId}`);

            const { templates: metaTemplateList, error: fetchError } = await fetchMetaTemplatesForWaba(tplWabaDbId);
            if (fetchError) {
              preflightError = fetchError;
              break;
            }

            const metaMatches = metaTemplateList.filter(m => m.name === tpl.name);
            if (metaMatches.length === 0) {
              preflightError = `Template '${tpl.name}' não foi encontrado na Meta para a WABA associada — verifique se ele existe no painel da Meta (Business Manager → WhatsApp → Modelos de mensagem).`;
              break;
            }

            const ptBrMatch = metaMatches.find(m => m.language === "pt_BR");
            if (!ptBrMatch) {
              preflightError = `Template '${tpl.name}' existe na Meta, mas não possui tradução em pt_BR. Adicione a tradução pt_BR no painel da Meta antes de iniciar a campanha.`;
              break;
            }
            if (ptBrMatch.status !== "APPROVED") {
              preflightError = `Template '${tpl.name}' (pt_BR) está com status '${ptBrMatch.status}' na Meta e não pode ser usado. Aguarde a aprovação antes de iniciar.`;
              break;
            }
            console.log(`[TEMPLATE] Preflight OK: template '${tpl.name}' is APPROVED (pt_BR) on WABA ${tplWabaDbId}`);
          }

          if (!preflightError) {
            console.log(`[TEMPLATE] Preflight validation OK for all ${templateIdsToCheck.length} template(s) (validated per-WABA)`);
          }
        } catch (preflightErr) {
          const errMsg = preflightErr instanceof Error ? preflightErr.message : String(preflightErr);
          preflightError = `Erro ao validar templates com a Meta API: ${errMsg}. Verifique a conectividade e as credenciais da integração.`;
          logError('[ManagedStart] Preflight Meta template check failed:', {}, preflightErr instanceof Error ? preflightErr : new Error(errMsg));
        }

        if (preflightError) {
          return res.status(400).json({ error: preflightError });
        }
      }
      // --- End preflight ---

      const cfg = (campaign.campaignConfig || {}) as Record<string, any>;

      const templateParamConfig = (cfg.templateParams || {}) as Record<string, Record<string, string>>;
      const missingParams: string[] = [];
      for (const tplId of templateIdsToCheck) {
        const tpl = allUserTemplates.find(t => t.id === tplId || t.templateId === tplId || t.name === tplId);
        if (!tpl || !Array.isArray(tpl.components)) continue;
        const paramConfig: Record<string, string> =
          templateParamConfig[tpl.id] ||
          templateParamConfig[tpl.templateId || ''] ||
          templateParamConfig[tpl.name] ||
          {};
        for (const comp of tpl.components as any[]) {
          const type = (comp.type || '').toUpperCase();
          const text = comp.text || '';
          const matches = text.match(/\{\{\d+\}\}/g) || [];
          for (const match of matches) {
            const idx = parseInt(match.replace(/[{}]/g, ''));
            const key = type === 'BODY' ? `body_${idx}` : type === 'HEADER' ? `header_${idx}` : `${type.toLowerCase()}_${idx}`;
            if (!paramConfig[key] && paramConfig[key] !== '') {
              missingParams.push(`Template '${tpl.name}': parâmetro {{${idx}}} (${type}) não configurado`);
            }
          }
          if (type === 'BUTTONS' && Array.isArray(comp.buttons)) {
            for (let bi = 0; bi < comp.buttons.length; bi++) {
              const btn = comp.buttons[bi];
              if (btn.type === 'URL' && btn.url) {
                const btnMatches = (btn.url.match(/\{\{\d+\}\}/g) || []) as string[];
                for (const bm of btnMatches) {
                  const idx = parseInt(bm.replace(/[{}]/g, ''));
                  const key = `button_${bi}_${idx}`;
                  if (!paramConfig[key] && paramConfig[key] !== '') {
                    missingParams.push(`Template '${tpl.name}': parâmetro de URL {{${idx}}} do botão ${bi} não configurado`);
                  }
                }
              }
            }
          }
        }
      }
      if (missingParams.length > 0) {
        console.error(`[ManagedStart] Parâmetros não configurados:`, missingParams);
        return res.status(400).json({
          error: `Parâmetros de template não configurados. Configure os seguintes campos no wizard antes de iniciar: ${missingParams.join('; ')}`
        });
      }
      if (cfg.usePackageImage === true) {
        const publicDomain = process.env.REPLIT_DEPLOYMENT_URL
          ? (process.env.REPLIT_DEPLOYMENT_URL.startsWith('http') ? process.env.REPLIT_DEPLOYMENT_URL : `https://${process.env.REPLIT_DEPLOYMENT_URL}`)
          : process.env.REPLIT_DOMAINS
            ? `https://${process.env.REPLIT_DOMAINS.split(',')[0].trim()}`
            : process.env.REPLIT_DEV_DOMAIN
              ? `https://${process.env.REPLIT_DEV_DOMAIN}`
              : `http://localhost:${process.env.PORT || 5000}`;

        const testSignedUrl = generateSignedImageUrl(publicDomain, campaign.id, '0000000000');
        try {
          const testRes = await fetch(testSignedUrl, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
          if (testRes.status === 403) {
            console.error(`[ManagedStart] Signed URL token rejected (HTTP 403): ${testSignedUrl}`);
            return res.status(400).json({
              error: "A URL assinada da imagem foi rejeitada (token inválido ou expirado). Verifique a configuração do servidor."
            });
          }
          if (testRes.status >= 500) {
            console.error(`[ManagedStart] Image server error: HTTP ${testRes.status}`);
            return res.status(400).json({
              error: `O servidor de imagens retornou erro interno (HTTP ${testRes.status}). Verifique se o servidor está online.`
            });
          }
          if (testRes.status === 404) {
            console.log(`[ManagedStart] Signed URL check returned 404 (expected: images not yet generated). Server is reachable.`);
          }
        } catch (imgErr: any) {
          logError('campaignRoutes.imageUrlCheck', { url: testSignedUrl }, imgErr);
          return res.status(400).json({
            error: "A imagem da campanha não está acessível. Verifique se o servidor está online e a URL de imagem é válida."
          });
        }
      }

      const botCfg = (campaign.botConfig || {}) as Record<string, any>;
      const sendCfg = (campaign.sendConfig || {}) as Record<string, any>;

      if (botCfg.ttsEnabled === true && botCfg.voiceProfileId && botCfg.ttsTemplate) {
        const [voiceProfile] = await db.select().from(voiceProfiles)
          .where(and(eq(voiceProfiles.id, botCfg.voiceProfileId), eq(voiceProfiles.userId, userId)));
        if (!voiceProfile) {
          return res.status(400).json({ error: "Perfil de voz TTS não encontrado. Cadastre uma voz antes de iniciar a campanha." });
        }

        const [campaignLeads] = await db.select({ total: count() }).from(leadsSchema).where(eq(leadsSchema.leadListId, campaign.leadListId!));
        const totalLeads = Number(campaignLeads?.total || 0);

        await db.delete(ttsJobProgress).where(eq(ttsJobProgress.campaignId, campaign.id));

        const allLeads = await db.select().from(leadsSchema).where(eq(leadsSchema.leadListId, campaign.leadListId!));

        await db.insert(ttsJobProgress).values(
          allLeads.map(lead => ({
            campaignId: campaign.id,
            leadId: lead.id,
            status: "pending" as const,
          }))
        );

        const [updatedGenerating] = await db.update(campaigns)
          .set({ status: "generating_audio", startedAt: campaign.startedAt || new Date(), updatedAt: new Date() })
          .where(eq(campaigns.id, req.params.id))
          .returning();

        res.json(updatedGenerating);

        let resolvedWabaConfigsForTts: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[]; wabaDbId?: string }> | undefined;
        if (Array.isArray(sendCfg.wabaConfigs) && sendCfg.wabaConfigs.length > 0) {
          const rawWabaConfigs = sendCfg.wabaConfigs as Array<Record<string, any>>;
          if (rawWabaConfigs[0] && rawWabaConfigs[0].accessToken !== undefined) {
            const allUserWabas = await wabaStorage.getWabasByUser(userId);
            resolvedWabaConfigsForTts = rawWabaConfigs.map((wc: Record<string, any>) => {
              let wabaDbId: string | undefined = wc.wabaDbId;
              if (!wabaDbId) {
                const matched = allUserWabas.find(w => w.wabaId === wc.wabaId || w.id === wc.wabaId);
                wabaDbId = matched?.id;
              }
              return { wabaId: wc.wabaId as string, accessToken: wc.accessToken as string, phoneNumberIds: (wc.phoneNumberIds || []) as string[], wabaDbId };
            });
          }
        }

        preGenerateAllTtsAudio({
          campaignId: campaign.id,
          leads: allLeads,
          voiceProfile,
          ttsTemplate: botCfg.ttsTemplate as string,
          speed: Number(botCfg.speed || 1.0),
          pitch: Number(botCfg.pitch || 1.0),
          volume: Number(botCfg.volume || 1.0),
          humanize: botCfg.humanize === true,
          sendCfg,
          resolvedWabaConfigs: resolvedWabaConfigsForTts,
          campaignConfig: (campaign.campaignConfig || {}) as Record<string, any>,
        }).catch(async (err) => {
          logError('campaignRoutes.preGenerateAllTtsAudio', { campaignId: campaign.id }, err instanceof Error ? err : new Error(String(err)));
          await db.update(campaigns).set({ status: "failed", completedAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, campaign.id));
        });

        return;
      }

      const [updated] = await db.update(campaigns)
        .set({
          status: "running",
          startedAt: campaign.startedAt || new Date(),
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, req.params.id))
        .returning();

      let resolvedWabaConfigs: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[]; wabaDbId?: string }> | undefined;
      if (Array.isArray(sendCfg.wabaConfigs) && sendCfg.wabaConfigs.length > 0) {
        const rawWabaConfigs = sendCfg.wabaConfigs as Array<Record<string, any>>;
        if (rawWabaConfigs[0] && rawWabaConfigs[0].accessToken !== undefined) {
          // Pre-resolved configs already have accessToken but may lack wabaDbId.
          // Backfill wabaDbId by matching against DB WABAs owned by this user.
          const allUserWabas = await wabaStorage.getWabasByUser(userId);
          resolvedWabaConfigs = rawWabaConfigs.map((wc: Record<string, any>) => {
            let wabaDbId: string | undefined = wc.wabaDbId;
            if (!wabaDbId) {
              const matched = allUserWabas.find(w => w.wabaId === wc.wabaId || w.id === wc.wabaId);
              wabaDbId = matched?.id;
            }
            return {
              wabaId: wc.wabaId as string,
              accessToken: wc.accessToken as string,
              phoneNumberIds: (wc.phoneNumberIds || []) as string[],
              wabaDbId,
            };
          });
        } else {
          const transformed: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[]; wabaDbId: string }> = [];
          for (const wc of rawWabaConfigs) {
            const wabaDbId = wc.wabaId;
            const waba = await wabaStorage.getWabaById(wabaDbId);
            if (!waba || waba.userId !== userId) {
              return res.status(400).json({ error: `WABA configurada na campanha não encontrada ou não pertence à sua conta (id: ${wabaDbId}).` });
            }
            if (!waba.accessToken) {
              return res.status(400).json({ error: `WABA '${waba.name}' não possui token de acesso válido. Reconfigure a WABA.` });
            }
            const phoneNumbers: string[] = [];
            if (Array.isArray(wc.phoneNumbers)) {
              for (const pn of wc.phoneNumbers) {
                const pnId = pn.phoneNumberId || pn.id;
                if (pnId) phoneNumbers.push(String(pnId));
              }
            }
            if (phoneNumbers.length === 0) {
              const wabaNums = await wabaStorage.getWabaNumbers(waba.id);
              for (const wn of wabaNums) {
                if (wn.phoneNumberId) phoneNumbers.push(wn.phoneNumberId);
              }
            }
            if (phoneNumbers.length === 0) {
              return res.status(400).json({ error: `WABA '${waba.name}' não possui números de telefone configurados. Adicione números à WABA antes de iniciar.` });
            }
            transformed.push({
              wabaId: waba.wabaId,
              accessToken: waba.accessToken,
              phoneNumberIds: phoneNumbers,
              wabaDbId: waba.id,
            });
          }
          resolvedWabaConfigs = transformed;
        }
      }

      triggerCampaignExecution(campaign.id, {
        speedMode: sendCfg.speed || "NORMAL",
        batchingRate: sendCfg.batchingRate || undefined,
        forcedLanguage: sendCfg.forcedLanguage || cfg.forcedLanguage || undefined,
        customMessages: sendCfg.customMessages || cfg.customMessages || undefined,
        isDynamicUrl: cfg.isDynamicUrl || undefined,
        templateNames: sendCfg.templateNames || undefined,
        customRate: sendCfg.customRate || undefined,
        isBlacksky: cfg.isBlacksky || undefined,
        blackskyConfig: cfg.blackskyConfig || undefined,
        isParametroUnico: cfg.isParametroUnico || undefined,
        parametroUnicoConfig: cfg.parametroUnicoConfig || undefined,
        usePackageImage: cfg.usePackageImage === true,
        packageImageType: cfg.packageImageType || undefined,
        packageImageKey: cfg.packageImageKey || undefined,
        customImageTemplateId: cfg.customImageTemplateId || undefined,
        wabaConfigs: resolvedWabaConfigs || undefined,
        templateWeights: sendCfg.templateWeights || undefined,
      }).catch(async (err) => {
        logError('campaignRoutes.managedStart.execution', { campaignId: campaign.id }, err instanceof Error ? err : new Error(String(err)));
        try {
          await db.update(campaigns).set({
            status: "failed",
            completedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(campaigns.id, campaign.id));

          await db.insert(campaignErrorLogs).values({
            campaignId: campaign.id,
            errorCode: "EXECUTION_FAILED",
            errorMessage: err?.message || "Erro desconhecido na execucao da campanha",
          });
        } catch (dbErr) {
          logError('[ManagedStart] Failed to update campaign status to failed:', {}, dbErr instanceof Error ? dbErr : new Error(String(dbErr)));
        }
      });

      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.startCampaign', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/managed/:id/pause", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const [updated] = await db.update(campaigns)
        .set({ status: "paused", updatedAt: new Date() })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.pauseCampaign', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/managed/:id/resume", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const [updated] = await db.update(campaigns)
        .set({ status: "running", updatedAt: new Date() })
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(updated);
    } catch (error: any) {
      logError('campaignRoutes.resumeCampaign', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/managed/:id/hot-update", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      if (campaign.status !== "running") {
        return res.status(400).json({ error: "Hot update só disponível para campanhas em execução" });
      }

      const schema = z.object({
        botConfig: z.record(z.unknown()).optional(),
        sendConfig: z.record(z.unknown()).optional(),
        templateIds: z.array(z.string()).optional(),
        selectedNumbers: z.array(z.record(z.unknown())).optional(),
        automationEnabled: z.boolean().optional(),
        automationFallback: z.string().optional(),
        burstMode: z.boolean().optional(),
        businessHoursOnly: z.boolean().optional(),
        businessHoursStart: z.number().optional(),
        businessHoursEnd: z.number().optional(),
        conversionMessage: z.string().optional(),
        automationRules: z.array(z.object({
          keyword: z.string(),
          response: z.string(),
          responseType: z.string().optional(),
          mediaUrl: z.string().optional(),
          priority: z.number().optional(),
        })).optional(),
      });
      const data = schema.parse(req.body);

      const isBotOnlyUpdate = !!(
        (data.automationRules || data.automationEnabled !== undefined || data.automationFallback !== undefined) &&
        data.sendConfig === undefined && data.templateIds === undefined && data.selectedNumbers === undefined &&
        data.burstMode === undefined && data.businessHoursOnly === undefined &&
        data.businessHoursStart === undefined && data.businessHoursEnd === undefined &&
        data.botConfig === undefined
      );

      if (!isBotOnlyUpdate) {
        campaignHotUpdateEmitter.emit('pause', req.params.id);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.botConfig !== undefined) updates.botConfig = data.botConfig;
      if (data.sendConfig !== undefined) updates.sendConfig = data.sendConfig;
      if (data.templateIds !== undefined) updates.templateIds = data.templateIds;
      if (data.selectedNumbers !== undefined) updates.selectedNumbers = data.selectedNumbers;
      if (data.automationEnabled !== undefined) updates.automationEnabled = data.automationEnabled;
      if (data.automationFallback !== undefined) updates.automationFallback = data.automationFallback;
      if (data.burstMode !== undefined) updates.burstMode = data.burstMode;
      if (data.businessHoursOnly !== undefined) updates.businessHoursOnly = data.businessHoursOnly;
      if (data.businessHoursStart !== undefined) updates.businessHoursStart = data.businessHoursStart;
      if (data.businessHoursEnd !== undefined) updates.businessHoursEnd = data.businessHoursEnd;
      if (data.conversionMessage !== undefined) updates.conversionMessage = data.conversionMessage;

      const [updated] = await db.update(campaigns)
        .set(updates as Record<string, unknown>)
        .where(and(eq(campaigns.id, req.params.id), eq(campaigns.userId, req.session.userId!)))
        .returning();

      if (data.automationRules) {
        await wabaStorage.updateAutomationRules(req.params.id, data.automationRules);
      }

      if (!isBotOnlyUpdate) {
        campaignHotUpdateEmitter.emit('resume', req.params.id);
      }

      res.json({ success: true, campaign: updated, appliedAt: new Date().toISOString() });
    } catch (error: any) {
      logError('campaignRoutes.patchCampaign', { campaignId: req.params.id }, error);
      campaignHotUpdateEmitter.emit('resume', req.params.id);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id/contacts", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const deliveries = await db.select().from(messageDeliveries)
        .where(eq(messageDeliveries.campaignId, req.params.id))
        .orderBy(desc(messageDeliveries.createdAt));

      res.json(deliveries);
    } catch (error: any) {
      logError('campaignRoutes.getContacts', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id/logs", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const logs = campaignStore.getLogs(req.params.id);

      const dbLogs = await db.select().from(campaignErrorLogs)
        .where(eq(campaignErrorLogs.campaignId, req.params.id))
        .orderBy(desc(campaignErrorLogs.lastOccurredAt));

      res.json({
        liveLogs: logs.slice(-200),
        errorLogs: dbLogs,
      });
    } catch (error: any) {
      logError('campaignRoutes.getLogs', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id/chat", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const search = req.query.search as string | undefined;
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await wabaStorage.getConversationsByCampaign(req.params.id, { search, limit, offset });
      res.json(result);
    } catch (error: any) {
      logError('campaignRoutes.getChat', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id/metrics", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const live = campaignStore.getSnapshot(req.params.id);

      const deliveryStats = await db.select({
        status: messageDeliveries.status,
        count: sql<number>`count(*)`,
      }).from(messageDeliveries)
        .where(eq(messageDeliveries.campaignId, req.params.id))
        .groupBy(messageDeliveries.status);

      const stats: Record<string, number> = {};
      for (const row of deliveryStats) {
        stats[row.status] = Number(row.count);
      }

      const { getPersistentCampaignResponseStats: getPersistentStats } = await import('./services/engine/DeliveryMetricsTracker');
      const persistentStats = getPersistentStats(req.params.id);

      res.json({
        campaign: {
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          totalLeads: campaign.totalLeads,
          sentCount: campaign.sentMessages || campaign.sentCount || 0,
          failedCount: campaign.failedMessages || campaign.failedCount || 0,
          deliveredCount: campaign.deliveredCount,
          readCount: campaign.readCount,
          repliedCount: campaign.repliedCount,
          startedAt: campaign.startedAt,
          completedAt: campaign.completedAt,
        },
        liveMetrics: live,
        deliveryBreakdown: stats,
        persistentMetrics: persistentStats ? {
          responseRate: persistentStats.responseRate,
          replyCount: persistentStats.replyCount,
          deliveredCount: persistentStats.deliveredCount,
          readCount: persistentStats.readCount,
        } : null,
      });
    } catch (error: any) {
      logError('campaignRoutes.getMetrics', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/managed/:id/tts-progress", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const jobs = await db.select().from(ttsJobProgress).where(eq(ttsJobProgress.campaignId, campaign.id));

      const total = jobs.length;
      const generated = jobs.filter(j => j.status === "done").length;
      const failed = jobs.filter(j => j.status === "failed").length;
      const pending = jobs.filter(j => j.status === "pending").length;
      const allDone = total > 0 && pending === 0;

      res.json({ total, generated, failed, pending, allDone, status: campaign.status });
    } catch (error: any) {
      logError('campaignRoutes.getTtsProgress', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  const campaignSSEClients = new Map<string, Set<import("express").Response>>();

  app.get("/api/campaigns/managed/:id/sse", async (req, res) => {
    const campaignId = req.params.id;
    const campaign = await getOwnedCampaign(campaignId, req.session.userId!);
    if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (!campaignSSEClients.has(campaignId)) {
      campaignSSEClients.set(campaignId, new Set());
    }
    campaignSSEClients.get(campaignId)!.add(res);

    const { getPersistentCampaignResponseStats: getPersistentSSEStats } = await import('./services/engine/DeliveryMetricsTracker');

    const interval = setInterval(async () => {
      try {
        const live = campaignStore.getSnapshot(campaignId);
        const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
        if (camp) {
          const sent = camp.sentMessages || camp.sentCount || 0;
          const failed = camp.failedMessages || camp.failedCount || 0;
          const persistentStats = getPersistentSSEStats(campaignId);
          const payload = {
            status: camp.status,
            sentCount: sent,
            failedCount: failed,
            deliveredCount: camp.deliveredCount,
            readCount: camp.readCount,
            repliedCount: camp.repliedCount,
            totalLeads: camp.totalLeads,
            liveMetrics: live || null,
            persistentMetrics: persistentStats ? {
              responseRate: persistentStats.responseRate,
              replyCount: persistentStats.replyCount,
              deliveredCount: persistentStats.deliveredCount,
              readCount: persistentStats.readCount,
            } : null,
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      } catch (e: any) {
        logError('campaignRoutes.sseWriteFailed', {}, e);
        clearInterval(interval);
      }
    }, 3000);

    req.on('close', () => {
      clearInterval(interval);
      campaignSSEClients.get(campaignId)?.delete(res);
      if (campaignSSEClients.get(campaignId)?.size === 0) {
        campaignSSEClients.delete(campaignId);
      }
    });
  });

  app.post("/api/campaigns/managed/:id/restart", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      if (campaign.status !== "failed" && campaign.status !== "completed") {
        return res.status(400).json({ error: "Apenas campanhas com status 'falhou' ou 'concluida' podem ser reiniciadas." });
      }

      campaignStore.remove(req.params.id);

      const [updated] = await db.update(campaigns)
        .set({
          status: "draft",
          sentCount: 0,
          failedCount: 0,
          sentMessages: 0,
          successMessages: 0,
          failedMessages: 0,
          deliveredCount: 0,
          readCount: 0,
          repliedCount: 0,
          startedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(campaigns.id, req.params.id))
        .returning();

      res.json(updated);
    } catch (error: any) {
      logError("campaignRoutes.restartCampaign", { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/campaigns/managed/:id", async (req, res) => {
    try {
      const campaign = await getOwnedCampaign(req.params.id, req.session.userId!);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      if (campaign.status === "running") {
        return res.status(400).json({ error: "Não é possível excluir campanha ativa" });
      }

      await db.delete(campaigns).where(eq(campaigns.id, req.params.id));
      unregisterPersistentCampaignTracker(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      logError('campaignRoutes.deleteCampaign', { campaignId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });
}
