import type { Express, Response } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import rateLimit from "express-rate-limit";
import { requireAdmin } from "./middleware/auth";
import { storage } from "./storage";
import { wabaStorage } from "./wabaStorage";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { voiceProfiles, ttsAudioCache, ttsJobProgress } from "@shared/schema";
import { ttsService, TtsStepError } from "./services/tts/TtsService";
import { audioCacheService } from "./services/tts/AudioCacheService";
import { audioStitchingService } from "./services/tts/AudioStitchingService";
import { textHumanizerService } from "./services/tts/TextHumanizerService";
import { ttsQueue } from "./services/tts/TtsQueue";
import { insertApiConfigurationSchema, insertLeadListSchema, insertCampaignSchema, imageTemplates } from "@shared/schema";
import type { ImageTemplateField } from "@shared/schema";
import { db } from "./db";
import { eq, and, isNotNull } from "drizzle-orm";
import multer from "multer";
import * as XLSX from "xlsx";
import { z } from "zod";
import { parseLeads } from "./utils/parseLeads";
import { getTemplates, getPhoneNumbers, validateCredentials, sendTemplateMessage, sendTemplateWithButtons, metaAPI, validateMetaConfig, subscribeWabaToApp } from "./meta/metaAPI";
import { distributeLeadsForCampaign, leadDistributionService } from "./services/distributeLeads";
import { UltraStableCampaignSender, CAMPAIGN_PRESETS, type UltraStableStats } from "./services/sendCampaign";
import { CampaignDecisionEngine } from "./services/engine/CampaignDecisionEngine";
import { cswTracker } from "./services/csw/CSWTracker";
import { conversionTriggerService } from "./services/csw/ConversionTriggerService";

import { BurstLaunchMode } from "./services/engine/BurstLaunchMode";
import { deliveryMetricsTracker, fanOutWebhookStatus, fanOutDeliveredForResponseRate, fanOutReplyForResponseRate, registerResponseRateTracker, unregisterResponseRateTracker, registerPersistentCampaignTracker, recordPersistentCampaignRead } from "./services/engine/DeliveryMetricsTracker";
import { ResponseRateTracker } from "./services/engine/ResponseRateTracker";
import { PhoneReputationScore } from "./services/engine/PhoneReputationScore";
import type { PhoneReputation } from "./services/engine/PhoneReputationScore";
import { bmQualityMonitor } from "./services/engine/BMQualityMonitor";
import { stealthScheduler } from "./services/engine/StealthScheduler";
import { shouldBlockMarketingTemplate } from "./services/engine/TierDetection";
import { metricsPublisher, GlobalCampaignMetrics } from "./services/observability/CampaignMetricsPublisher";
import { getOrCreateAdapter, removeAdapter } from "./services/observability/CampaignMetricsAdapter";
import { campaignStore } from "./services/campaign/CampaignStore";
import { registerExecutor } from "./services/campaign/executionBridge";
import { PhoneNumberWithStatus, ThroughputEstimate, PhoneSelectionConfig } from "@shared/phoneNumberTypes";
import { serverStartTime, getLastWebhookEventTime, updateLastWebhookEvent } from "./utils/serverState";
import { botFlowEngine, withSendQueue, validateAudioUrl, sendAudioWithRetry, sendButtons, sendList, canonicalPhone, incrementAlertCounter, scheduleWithDebounce } from "./services/bot/BotFlowEngine";
import { startBotTimeoutJob } from "./jobs/botTimeoutJob";
import { setWebhookProcessingCallback } from "./jobs/webhookQueueWorker";
import { botFlows, botFlowNodes, botConversationStates, campaigns as campaignsSchema, apiConfigurations as apiConfigsSchema, whatsappTemplates as templatesSchema, leads as leadsSchema, leadLists as leadListsSchema, messageDeliveries as messageDeliveriesSchema, messageStatus as messageStatusSchema, wabaHooks as wabaHooksSchema, wabas as wabasSchema, proxies as proxiesSchema, insertProxySchema, updateProxySchema } from "@shared/schema";
import type { BotNodeCondition, BotButtonPayloadItem, BotButtonsPayloadMeta, BotListPayload } from "@shared/schema";
import { desc, asc, sql } from "drizzle-orm";
import { generatePackageImage, generatePackageImageFromFile, preBatchGenerate, validateAllImages, generateFromCustomTemplate, cleanupCampaignImages } from "./services/imageGenerator";
import { fileURLToPath } from "url";
import * as OptOutService from "./services/optout/OptOutService";
import * as WarmupScheduler from "./services/warmup/WarmupScheduler";
import * as EngagementManager from "./services/engagement/EngagementManager";
import { generateSignedImageUrl, verifySignedToken } from "./services/signedUrl";
import { logError } from './utils/logger';
import { getAllTemplateIntelligence, recordTemplateReplyByCampaign, recordTemplateReplyByMessageId, setCampaignTemplate, clearCampaignTemplate } from './services/templateManager';
import { fetchAudioBuffer } from './utils/ssrfGuard';
import { detectAudioFormat, isFfmpegAvailable, convertToOgg, convertBufferToOgg } from './utils/audioConverter';
import ffmpeg from 'fluent-ffmpeg';
import { whatsAppExtractorService, WaExtractorUserError } from './services/whatsapp-extractor/WhatsAppExtractorService';
import { proxyPoolManager, ProxyUnavailableError } from './services/proxyPool/ProxyPoolManager';

const __filename = fileURLToPath(import.meta.url);
const __dirname_routes = path.dirname(__filename);

const META_API_VERSION = process.env.META_API_VERSION || process.env.API_VERSION || 'v25.0';

function routeError(op: string, ctx: Record<string, unknown>, err: unknown): void {
  logError(`routes.${op}`, ctx, err);
}

const upload = multer({ storage: multer.memoryStorage() });

const LEAD_CLEANER_TMP_DIR = path.join(__dirname_routes, '../uploads/lead-cleaner-tmp');
const _mkdirLeadCleaner = fs.promises.mkdir(LEAD_CLEANER_TMP_DIR, { recursive: true }).catch((e: any) => {
  logError('routes.mkdirLeadCleanerTmpDir', { path: LEAD_CLEANER_TMP_DIR }, e);
});
const leadCleanerDiskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LEAD_CLEANER_TMP_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.txt';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const leadCleanerUpload = multer({
  storage: leadCleanerDiskStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Diretório persistente para imagens de campanha (servido como /uploads/* sem autenticação)
const CAMPAIGN_IMAGES_DIR = path.join(__dirname_routes, '../uploads/campaign-images');
const CAMPAIGN_BASE_IMAGES_DIR = path.join(__dirname_routes, '../uploads/campaign-base-images');
const CHAT_MEDIA_DIR = path.join(__dirname_routes, '../uploads/chat-media');
const _mkdirCampaignImages = fs.promises.mkdir(CAMPAIGN_IMAGES_DIR, { recursive: true }).catch((e: any) => {
  logError('routes.mkdirCampaignImagesDir', { path: CAMPAIGN_IMAGES_DIR }, e);
});
const _mkdirCampaignBaseImages = fs.promises.mkdir(CAMPAIGN_BASE_IMAGES_DIR, { recursive: true }).catch((e: any) => {
  logError('routes.mkdirCampaignBaseImagesDir', { path: CAMPAIGN_BASE_IMAGES_DIR }, e);
});
const _mkdirChatMedia = fs.promises.mkdir(CHAT_MEDIA_DIR, { recursive: true }).catch((e: any) => {
  logError('routes.mkdirChatMediaDir', { path: CHAT_MEDIA_DIR }, e);
});

const chatMediaStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CHAT_MEDIA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const chatMediaUpload = multer({ storage: chatMediaStorage, limits: { fileSize: 16 * 1024 * 1024 } });

// Resolve domínio público do servidor (dev ou deploy)
function getPublicDomain(): string {
  if (process.env.REPLIT_DEPLOYMENT_URL) {
    const d = process.env.REPLIT_DEPLOYMENT_URL;
    return d.startsWith('http') ? d : `https://${d}`;
  }
  if (process.env.REPLIT_DOMAINS) {
    const firstDomain = process.env.REPLIT_DOMAINS.split(',')[0].trim();
    if (firstDomain) return `https://${firstDomain}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return `http://localhost:${process.env.PORT || 5000}`;
}

const TEXTOS3 = [
  "Confirmação pendente.",
  "Dados aguardando revisão.",
  "Atualização disponível.",
  "Registro requer validação.",
  "Informação em verificação."
];

const PREFIX4 = [
  "Seguir: ",
  "Acesse: ",
  "Visualizar: ",
  "Abrir: ",
  "Consultar: "
];

const DOMS = ["g3x.net", "z7t.org", "k4p.com", "r9n.net"];

let domIdx = 0;
let enviosNoDom = 0;
let disparoSeq = 0;
const usedPaths = new Set<string>();
const MAX_PATH_CACHE = 2000;
const ROTACAO_A_CADA = 450;

const sorteia = <T>(arr: T[]): T => arr[crypto.randomInt(0, arr.length)];

const novoPath = (): string => {
  let p: string;
  do {
    p = crypto.randomBytes(4).toString("hex");
  } while (usedPaths.has(p));
  usedPaths.add(p);
  if (usedPaths.size > MAX_PATH_CACHE) usedPaths.clear();
  return p;
};

const proxDom = (): string => {
  if (enviosNoDom >= ROTACAO_A_CADA) {
    domIdx = (domIdx + 1) % DOMS.length;
    enviosNoDom = 0;
  }
  enviosNoDom++;
  return DOMS[domIdx];
};

const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 800,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Taxa de requisições ao webhook excedida.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

export async function registerRoutes(app: Express): Promise<Server> {
  await Promise.all([_mkdirLeadCleaner, _mkdirCampaignImages, _mkdirCampaignBaseImages, _mkdirChatMedia]);
  const objectStorageService = new ObjectStorageService();

  const isProduction = process.env.NODE_ENV === "production";

  app.get("/api/server-status", (req, res) => {
    const uptimeMs = Date.now() - serverStartTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;

    const publicDomain = getPublicDomain();
    const isLocalhost = publicDomain.startsWith('http://localhost');
    const sessionUserId = req.session?.userId;

    let webhookUrl: string;
    let webhookWarning: string | null = null;

    const baseWebhookPath = sessionUserId
      ? `/api/webhook/meta/${sessionUserId}`
      : `/api/webhook/meta`;

    if (!isLocalhost) {
      webhookUrl = `${publicDomain}${baseWebhookPath}`;
    } else if (isProduction) {
      webhookUrl = "";
      webhookWarning = "Domínio de produção não detectado. A variável REPLIT_DEPLOYMENT_URL não está configurada.";
    } else {
      webhookUrl = `${publicDomain}${baseWebhookPath}`;
      webhookWarning = "URL local — não utilizável para webhook da Meta. Faça o deploy para obter uma URL pública.";
    }

    res.json({
      environment: isProduction ? "production" : "development",
      status: "online",
      uptime: `${hours}h ${minutes}m ${seconds}s`,
      uptimeMs,
      startedAt: new Date(serverStartTime).toISOString(),
      lastWebhookEvent: getLastWebhookEventTime()
        ? new Date(getLastWebhookEventTime()!).toISOString()
        : null,
      webhookUrl,
      webhookWarning,
      domain: isLocalhost ? null : publicDomain,
    });
  });

  app.post("/api/webhook/test", async (req, res) => {
    const sessionUserId = req.session?.userId;

    let verifyToken: string | null = null;
    let testUrl: string;

    try {
      if (sessionUserId) {
        const [config] = await db.select({ webhookVerifyToken: apiConfigsSchema.webhookVerifyToken })
          .from(apiConfigsSchema)
          .where(eq(apiConfigsSchema.userId, sessionUserId));
        verifyToken = config?.webhookVerifyToken || null;
        testUrl = `${getPublicDomain()}/api/webhook/meta/${sessionUserId}`;
      } else {
        verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || null;
        testUrl = `${getPublicDomain()}/api/webhook/meta`;
      }

      if (!verifyToken) {
        return res.json({
          success: false,
          error: sessionUserId
            ? "Nenhum Verify Token configurado. Gere um token na página de configurações do webhook."
            : "WEBHOOK_VERIFY_TOKEN não está configurado nas variáveis de ambiente",
        });
      }

      const challenge = crypto.randomBytes(16).toString("hex");
      const response = await fetch(
        `${testUrl}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challenge}`
      );
      const body = await response.text();

      if (response.status === 200 && body === challenge) {
        res.json({
          success: true,
          message: "Webhook respondeu corretamente ao hub challenge",
          statusCode: response.status,
          challengeSent: challenge,
          challengeReceived: body,
        });
      } else {
        res.json({
          success: false,
          error: `Webhook retornou status ${response.status}`,
          statusCode: response.status,
          challengeSent: challenge,
          responseBody: body,
        });
      }
    } catch (error: any) {
      routeError('postWebhookTest', {}, error);
      res.json({
        success: false,
        error: `Falha ao testar webhook: ${error.message}`,
      });
    }
  });

  // Object storage routes for file uploads
  app.get("/objects/:objectPath(*)", async (req, res) => {
    try {
      const rawObjectPath = req.params.objectPath as string;
      const normalizedPath = path.posix.normalize(rawObjectPath);
      if (normalizedPath.startsWith('..') || normalizedPath.includes('/..') || normalizedPath.includes('../')) {
        return res.sendStatus(400);
      }
      const safePath = `/objects/${normalizedPath}`;
      const objectFile = await objectStorageService.getObjectEntityFile(safePath);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      routeError('Error checking object access:', {}, error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  app.post("/api/objects/upload", async (req, res) => {
    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      routeError('Error getting upload URL:', {}, error);
      res.status(500).json({ error: "Failed to get upload URL" });
    }
  });

  app.post("/api/config/generate-verify-token", async (req, res) => {
    try {
      const userId = req.session.userId!;
      const newToken = crypto.randomUUID();

      const [existing] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, userId));

      let config;
      if (existing) {
        const [updated] = await db.update(apiConfigsSchema)
          .set({ webhookVerifyToken: newToken, updatedAt: new Date() })
          .where(eq(apiConfigsSchema.userId, userId))
          .returning();
        config = updated;
      } else {
        const [created] = await db.insert(apiConfigsSchema).values({
          userId,
          metaToken: "",
          whatsappBusinessId: "",
          webhookVerifyToken: newToken,
        }).returning();
        config = created;
      }

      res.json({ webhookVerifyToken: config.webhookVerifyToken });
    } catch (error) {
      routeError('Error generating verify token:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/config/set-verify-token", async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { token } = req.body;
      if (!token || typeof token !== "string" || token.trim().length < 8) {
        return res.status(400).json({ error: "Token inválido. Mínimo 8 caracteres." });
      }
      const cleanToken = token.trim();
      const [existing] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, userId));
      let config;
      if (existing) {
        const [updated] = await db.update(apiConfigsSchema)
          .set({ webhookVerifyToken: cleanToken, updatedAt: new Date() })
          .where(eq(apiConfigsSchema.userId, userId))
          .returning();
        config = updated;
      } else {
        const [created] = await db.insert(apiConfigsSchema).values({
          userId,
          metaToken: "",
          whatsappBusinessId: "",
          webhookVerifyToken: cleanToken,
        }).returning();
        config = created;
      }
      res.json({ webhookVerifyToken: config.webhookVerifyToken });
    } catch (error) {
      routeError('Error setting verify token:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // API Configuration routes
  app.get("/api/config", async (req, res) => {
    try {
      const [config] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, req.session.userId!));
      if (!config) {
        return res.json({ metaToken: "", whatsappBusinessId: "", appSecret: null, webhookVerifyToken: null, isValid: false });
      }
      
      res.json(config);
    } catch (error) {
      routeError('Error getting API configuration:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const validatedData = insertApiConfigurationSchema.parse(req.body);
      
      const [existing] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, req.session.userId!));
      let config;
      
      if (existing) {
        console.log(`🔄 Atualizando configuração existente`);
        const [updated] = await db.update(apiConfigsSchema)
          .set({ ...validatedData, updatedAt: new Date() })
          .where(eq(apiConfigsSchema.userId, req.session.userId!))
          .returning();
        config = updated;
      } else {
        console.log(`➕ Criando nova configuração`);
        if (!validatedData.webhookVerifyToken) {
          validatedData.webhookVerifyToken = crypto.randomUUID();
        }
        const [created] = await db.insert(apiConfigsSchema).values({
          ...validatedData,
          userId: req.session.userId!,
        }).returning();
        config = created;
      }
      
      res.json(config);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      routeError('Error saving API configuration:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/config/validate", async (req, res) => {
    try {
      const [config] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, req.session.userId!));
      if (!config) {
        return res.status(404).json({ error: "API configuration not found" });
      }

      const isValid = await validateMetaApiConfig(config.metaToken, config.whatsappBusinessId);
      
      if (!isValid) {
        console.log(`⚠️ Validação direta falhou, tentando auto-descoberta de WABA...`);
        const discovered = await metaAPI.discoverWabaFromBM(config.whatsappBusinessId, config.metaToken);
        if (discovered) {
          console.log(`✅ [WABA Auto] Corrigindo ID: ${config.whatsappBusinessId} → ${discovered.wabaId} (${discovered.wabaName})`);
          await db.update(apiConfigsSchema)
            .set({ whatsappBusinessId: discovered.wabaId, isValid: true, updatedAt: new Date() })
            .where(eq(apiConfigsSchema.userId, req.session.userId!));
          return res.json({
            valid: true,
            auto_discovered: true,
            old_id: config.whatsappBusinessId,
            new_waba_id: discovered.wabaId,
            waba_name: discovered.wabaName,
            phone_numbers: discovered.phoneNumbers,
          });
        }
      }

      await db.update(apiConfigsSchema)
        .set({ isValid, updatedAt: new Date() })
        .where(eq(apiConfigsSchema.userId, req.session.userId!));
      
      res.json({ valid: isValid });
    } catch (error) {
      routeError('Error validating API configuration:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/config/discover-waba", async (req, res) => {
    try {
      const { bm_id, access_token } = req.body;
      const [config] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, req.session.userId!));
      const token = access_token || config?.metaToken;
      const bmId = bm_id || config?.whatsappBusinessId;

      if (!token || !bmId) {
        return res.status(400).json({ error: "Token e BM ID são obrigatórios" });
      }

      const discovered = await metaAPI.discoverWabaFromBM(bmId, token);
      if (!discovered) {
        return res.status(404).json({ error: "Nenhuma WABA encontrada neste BM" });
      }

      await db.update(apiConfigsSchema)
        .set({ whatsappBusinessId: discovered.wabaId, isValid: true, updatedAt: new Date() })
        .where(eq(apiConfigsSchema.userId, req.session.userId!));

      console.log(`✅ [WABA Auto] ${bmId} → ${discovered.wabaId} (${discovered.wabaName})`);
      console.log(`✅ [WABA Auto] ${discovered.phoneNumbers.length} números encontrados`);

      res.json({
        success: true,
        old_bm_id: bmId,
        waba_id: discovered.wabaId,
        waba_name: discovered.wabaName,
        phone_numbers: discovered.phoneNumbers,
      });
    } catch (error: any) {
      routeError('Error discovering WABA:', {}, error);
      res.status(500).json({ error: error.response?.data?.error?.message || error.message });
    }
  });

  app.post("/api/wabas/discover", async (req, res) => {
    try {
      const { bmId, accessToken } = req.body;
      if (!bmId || !accessToken) {
        return res.status(400).json({ error: "BM ID e Access Token são obrigatórios" });
      }

      const wabas = await metaAPI.discoverAllWabasFromBM(bmId, accessToken);
      console.log(`✅ [WABA Discover All] BM ${bmId} → ${wabas.length} WABAs encontradas`);
      res.json({ success: true, wabas });
    } catch (error: any) {
      routeError('Error discovering all WABAs:', {}, error);
      const statusCode = error.statusCode || 500;
      const message = error.message || "Falha ao buscar WABAs";
      res.status(statusCode).json({ error: message });
    }
  });

  app.post("/api/wabas/validate-by-id", async (req, res) => {
    try {
      const { wabaId, accessToken } = req.body;
      if (!wabaId || !accessToken) {
        return res.status(400).json({ error: "WABA ID e Access Token são obrigatórios" });
      }

      try {
        const phones = await metaAPI.getPhoneNumbers(wabaId, accessToken);
        console.log(`✅ [WABA Validate] WABA ${wabaId} → ${phones.length} números encontrados`);
        return res.json({ success: true, wabaId, phoneCount: phones.length, phones });
      } catch (primaryError: any) {
        const code = primaryError?.errorCode ?? primaryError?.code;
        const status = primaryError?.httpStatus ?? primaryError?.statusCode;
        const msg = primaryError?.message || '';
        const looksLikePermissionError = code === 100 || status === 400 || status === 403
          || msg.includes('does not exist') || msg.includes('missing permissions')
          || msg.includes('Unsupported get request') || msg.includes('Falha ao buscar números');

        if (looksLikePermissionError) {
          try {
            const wabas = await metaAPI.discoverAllWabasFromBM(String(wabaId), accessToken);
            if (Array.isArray(wabas) && wabas.length > 0) {
              console.log(`✅ [WABA Validate] Fallback: ID ${wabaId} é BM, ${wabas.length} WABA(s) encontrada(s)`);
              return res.json({
                success: true,
                isBmId: true,
                bmId: String(wabaId),
                wabas,
                message: `O ID informado é um Business Manager. Foram encontradas ${wabas.length} WABA(s) dentro dele — selecione a desejada para cadastrar.`,
              });
            }
          } catch {
          }

          return res.status(400).json({
            error: "Não foi possível validar este ID na Meta.",
            details: "A Meta retornou erro de permissão ou ID inexistente. Verifique:",
            checks: [
              "1) O ID informado é mesmo o WABA ID (e não o Business Manager ID, App ID ou Phone Number ID).",
              "2) O Access Token tem o escopo 'whatsapp_business_management' (e 'business_management' se for token de System User).",
              "3) O usuário/System User do token é admin do Business Manager dono dessa WABA.",
              "4) A WABA está ativa e não foi removida ou migrada para outro BM.",
            ],
            metaError: primaryError?.message,
          });
        }

        throw primaryError;
      }
    } catch (error: any) {
      routeError('Error validating WABA by ID:', {}, error);
      const statusCode = error.statusCode || 400;
      const message = error.message || "Falha ao validar WABA";
      res.status(statusCode).json({ error: message });
    }
  });

  // Cloud API Registration routes
  app.post("/api/buscar-numeros", async (req, res) => {
    try {
      const { business_account_id, access_token } = req.body;
      
      if (!business_account_id || !access_token) {
        return res.status(400).json({ 
          success: false, 
          error: "business_account_id e access_token são obrigatórios" 
        });
      }

      const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${business_account_id}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,account_mode`,
        {
          headers: { Authorization: `Bearer ${access_token}` }
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.json({ 
          success: false, 
          error: data.error.message || "Erro ao buscar números" 
        });
      }

      const phones = (data.data || []).map((phone: any) => ({
        id: phone.id,
        display_phone_number: phone.display_phone_number,
        verified_name: phone.verified_name || "Não verificado",
        code_verification_status: phone.code_verification_status || "N/A",
        quality_rating: phone.quality_rating || "UNKNOWN",
        platform: phone.platform_type || phone.account_mode || "UNKNOWN"
      }));

      res.json({ success: true, phones });
    } catch (error: any) {
      routeError('Erro ao buscar números:', {}, error);
      res.json({ success: false, error: error.message || "Erro interno" });
    }
  });

  app.post("/api/registrar-numero", async (req, res) => {
    try {
      const { phone_id, phone_number, access_token } = req.body;
      
      if (!phone_id || !access_token) {
        return res.status(400).json({ 
          success: false, 
          error: "phone_id e access_token são obrigatórios" 
        });
      }

      const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${phone_id}/register`,
        {
          method: "POST",
          headers: { 
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            pin: (() => {
              const pin = process.env.PHONE_REGISTER_PIN;
              if (!pin) throw new Error("PHONE_REGISTER_PIN não configurada nas variáveis de ambiente");
              return pin;
            })()
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.json({ 
          success: false, 
          error: data.error.message || "Erro ao registrar número" 
        });
      }

      console.log(`✅ Número ${phone_number} registrado na Cloud API`);
      res.json({ success: true, message: `Número ${phone_number} registrado com sucesso` });
    } catch (error: any) {
      routeError('Erro ao registrar número:', {}, error);
      res.json({ success: false, error: error.message || "Erro interno" });
    }
  });

  app.post("/api/solicitar-sms", async (req, res) => {
    try {
      const { phone_id, access_token } = req.body;
      
      if (!phone_id || !access_token) {
        return res.status(400).json({ 
          success: false, 
          error: "phone_id e access_token são obrigatórios" 
        });
      }

      const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${phone_id}/request_code`,
        {
          method: "POST",
          headers: { 
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            code_method: "SMS",
            language: "pt_BR"
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.json({ 
          success: false, 
          error: data.error.message || "Erro ao solicitar SMS" 
        });
      }

      console.log(`📱 SMS solicitado para phone_id: ${phone_id}`);
      res.json({ success: true, message: "SMS solicitado com sucesso" });
    } catch (error: any) {
      routeError('Erro ao solicitar SMS:', {}, error);
      res.json({ success: false, error: error.message || "Erro interno" });
    }
  });

  app.post("/api/verificar-sms", async (req, res) => {
    try {
      const { phone_id, sms_code, access_token } = req.body;
      
      if (!phone_id || !sms_code || !access_token) {
        return res.status(400).json({ 
          success: false, 
          error: "phone_id, sms_code e access_token são obrigatórios" 
        });
      }

      const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${phone_id}/verify_code`,
        {
          method: "POST",
          headers: { 
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            code: sms_code
          })
        }
      );

      const data = await response.json();

      if (data.error) {
        return res.json({ 
          success: false, 
          error: data.error.message || "Erro ao verificar código" 
        });
      }

      console.log(`✅ Código verificado para phone_id: ${phone_id}`);
      res.json({ success: true, message: "Número verificado com sucesso!" });
    } catch (error: any) {
      routeError('Erro ao verificar SMS:', {}, error);
      res.json({ success: false, error: error.message || "Erro interno" });
    }
  });

  // WhatsApp Templates routes
  app.get("/api/templates", async (req, res) => {
    try {
      let templates = await db.select().from(templatesSchema).where(eq(templatesSchema.userId, req.session.userId!));
      
      if (templates.length === 0) {
        const config = await getApiConfigFromDbOrStorage(req.session.userId!);
        if (config && config.isValid) {
          try {
            console.log("Auto-syncing templates from Meta API to DB...");
            const metaTemplates = await fetchWhatsAppTemplates(config.metaToken, config.whatsappBusinessId);
            
            if (metaTemplates.length > 0) {
              await db.delete(templatesSchema).where(eq(templatesSchema.userId, req.session.userId!));
              await db.insert(templatesSchema).values(
                metaTemplates.map(template => ({
                  userId: req.session.userId!,
                  templateId: template.id,
                  name: template.name,
                  language: template.language,
                  category: template.category,
                  status: template.status,
                  components: template.components,
                }))
              );
              templates = await db.select().from(templatesSchema).where(eq(templatesSchema.userId, req.session.userId!));
              console.log(`Auto-synced ${templates.length} templates to DB`);
            }
          } catch (syncError) {
            routeError('routes.autoSyncTemplates', {}, syncError);
          }
        }
      }
      
      res.json(templates);
    } catch (error) {
      routeError('Error getting templates:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/templates/sync", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Valid API configuration required" });
      }

      const templates = await fetchWhatsAppTemplates(config.metaToken, config.whatsappBusinessId);
      
      await db.delete(templatesSchema).where(eq(templatesSchema.userId, req.session.userId!));
      
      if (templates.length > 0) {
        await db.insert(templatesSchema).values(
          templates.map(template => ({
            userId: req.session.userId!,
            templateId: template.id,
            name: template.name,
            language: template.language,
            category: template.category,
            status: template.status,
            components: template.components,
          }))
        );
      }
      
      res.json({ count: templates.length });
    } catch (error) {
      routeError('Error syncing templates:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Buscar números de telefone conectados
  app.get("/api/phone-numbers", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Valid API configuration required" });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      res.json(phoneNumbers);
    } catch (error) {
      routeError('Error fetching phone numbers:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Diagnóstico completo da configuração WhatsApp
  app.post("/api/diagnose-whatsapp", async (req, res) => {
    try {
      const results: any = {
        timestamp: new Date().toISOString(),
        checks: []
      };

      // 1. Verificar configuração existe
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config) {
        results.checks.push({
          name: "Configuração API",
          status: "error",
          message: "Configuração não encontrada"
        });
        return res.json(results);
      }

      results.config = {
        whatsappBusinessId: config.whatsappBusinessId,
        tokenConfigured: !!config.metaToken
      };

      // 2. Testar phone numbers
      try {
        const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
        results.checks.push({
          name: "Phone Numbers",
          status: "success",
          message: `${phoneNumbers.length} número(s) encontrado(s)`,
          data: phoneNumbers.map(p => ({
            id: p.id,
            displayPhone: p.display_phone_number,
            verifiedName: p.verified_name
          }))
        });
      } catch (error: any) {
        results.checks.push({
          name: "Phone Numbers",
          status: "error",
          message: error.message || "Falha ao buscar números",
          error: error.response?.data || error.message
        });
      }

      // 3. Testar templates
      try {
        const templates = await getTemplates(config.whatsappBusinessId, config.metaToken);
        const approvedTemplates = templates.filter((t: any) => t.status === 'APPROVED');
        results.checks.push({
          name: "Templates",
          status: "success",
          message: `${templates.length} total, ${approvedTemplates.length} aprovado(s)`,
          data: templates.map((t: any) => ({
            name: t.name,
            language: t.language,
            status: t.status,
            category: t.category,
            hasButtons: t.components?.some((c: any) => c.type === 'BUTTONS')
          }))
        });
      } catch (error: any) {
        results.checks.push({
          name: "Templates",
          status: "error",
          message: error.message || "Falha ao buscar templates",
          error: error.response?.data || error.message
        });
      }

      // 4. Verificar template específico "modelo_02"
      try {
        const templates = await getTemplates(config.whatsappBusinessId, config.metaToken);
        const modelo02 = templates.find((t: any) => t.name === 'modelo_02');
        if (modelo02) {
          results.checks.push({
            name: "Template 'modelo_02'",
            status: modelo02.status === 'APPROVED' ? "success" : "warning",
            message: `Status: ${modelo02.status}`,
            data: {
              id: modelo02.id,
              language: modelo02.language,
              category: modelo02.category,
              components: modelo02.components
            }
          });
        } else {
          results.checks.push({
            name: "Template 'modelo_02'",
            status: "error",
            message: "Template não encontrado"
          });
        }
      } catch (error: any) {
        results.checks.push({
          name: "Template 'modelo_02'",
          status: "error",
          message: error.message || "Falha ao verificar template"
        });
      }

      res.json(results);
    } catch (error: any) {
      routeError('Erro no diagnóstico:', {}, error);
      res.status(500).json({ error: "Erro no diagnóstico", details: error.message });
    }
  });

  // NOVO: Verificar status de todos os phone numbers (tier, quality, account_mode)
  app.get("/api/whatsapp/phone-status", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      
      const statusList = await Promise.all(
        phoneNumbers.map(async (phone) => {
          try {
            const status = await metaAPI.getPhoneNumberStatus(phone.id, config.metaToken);
            const canSend = await metaAPI.canSendMessages(phone.id, config.metaToken);
            
            return {
              ...status,
              canSend: canSend.canSend,
              warning: canSend.reason,
              tierLimit: (status.messaging_limit_tier as string) === 'TIER_250' ? 250 :
                         (status.messaging_limit_tier as string) === 'TIER_1K' ? 1000 :
                         (status.messaging_limit_tier as string) === 'TIER_10K' ? 10000 :
                         (status.messaging_limit_tier as string) === 'TIER_100K' ? 100000 : 999999
            };
          } catch (error: any) {
            routeError('getPhoneStatus', { phoneId: phone.id }, error);
            return {
              id: phone.id,
              display_phone_number: phone.display_phone_number,
              error: error.message,
              canSend: false
            };
          }
        })
      );

      res.json({
        total: statusList.length,
        blocked: statusList.filter(s => !s.canSend).length,
        phoneNumbers: statusList
      });
    } catch (error: any) {
      routeError('Erro ao buscar status:', {}, error);
      res.status(500).json({ error: "Erro ao buscar status", details: error.message });
    }
  });

  // NOVO: Verificar status de um phone number específico
  app.get("/api/whatsapp/phone-status/:phoneNumberId", async (req, res) => {
    try {
      const { phoneNumberId } = req.params;
      
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      const status = await metaAPI.getPhoneNumberStatus(phoneNumberId, config.metaToken);
      const canSend = await metaAPI.canSendMessages(phoneNumberId, config.metaToken);
      
      res.json({
        ...status,
        canSend: canSend.canSend,
        warning: canSend.reason,
        recommendations: [
          status.account_mode === 'RESTRICTED' 
            ? '🚫 URGENTE: Número BLOQUEADO. Aguarde 24h ou delete/re-adicione no Meta Business Manager'
            : null,
          status.quality_rating === 'RED'
            ? '🔴 CRÍTICO: Quality Rating RED. Reduza bloqueios e reports dos usuários'
            : null,
          status.quality_rating === 'YELLOW'
            ? '🟡 ATENÇÃO: Quality Rating YELLOW. Melhore a qualidade das mensagens'
            : null,
          status.messaging_limit_tier === 'TIER_250'
            ? '📊 INFO: Tier 250/dia. Envie 1.000 msgs em 30 dias para upgrade automático'
            : null
        ].filter(Boolean)
      });
    } catch (error: any) {
      routeError('Erro ao buscar status do phone:', {}, error);
      res.status(500).json({ error: "Erro ao buscar status", details: error.message });
    }
  });

  // NOVO: Diagnóstico completo do WhatsApp Business (versão avançada)
  app.get("/api/whatsapp/diagnose", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ 
          error: "Configuração válida da API é obrigatória",
          canSend: false
        });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      const templates = await getTemplates(config.whatsappBusinessId, config.metaToken);
      
      const phoneStatusList = await Promise.all(
        phoneNumbers.map(async (phone) => {
          try {
            const status = await metaAPI.getPhoneNumberStatus(phone.id, config.metaToken);
            const canSend = await metaAPI.canSendMessages(phone.id, config.metaToken);
            
            return {
              ...status,
              canSend: canSend.canSend,
              warning: canSend.reason,
              tierLimit: (status.messaging_limit_tier as string) === 'TIER_250' ? 250 :
                         (status.messaging_limit_tier as string) === 'TIER_1K' ? 1000 :
                         (status.messaging_limit_tier as string) === 'TIER_10K' ? 10000 :
                         (status.messaging_limit_tier as string) === 'TIER_100K' ? 100000 : 999999
            };
          } catch (error: any) {
            return {
              id: phone.id,
              display_phone_number: phone.display_phone_number,
              error: error.message,
              canSend: false
            };
          }
        })
      );

      const blockedPhones = phoneStatusList.filter(p => !p.canSend);
      const lowQualityPhones = phoneStatusList.filter(p => 'quality_rating' in p && (p.quality_rating === 'RED' || p.quality_rating === 'YELLOW'));
      const approvedTemplates = templates.filter(t => t.status === 'APPROVED');
      
      const overallStatus = blockedPhones.length === phoneStatusList.length ? 'CRITICAL' :
                           blockedPhones.length > 0 ? 'WARNING' :
                           lowQualityPhones.length > 0 ? 'CAUTION' : 'HEALTHY';

      res.json({
        timestamp: new Date().toISOString(),
        overallStatus,
        canStartCampaign: blockedPhones.length < phoneStatusList.length,
        summary: {
          totalPhones: phoneStatusList.length,
          availablePhones: phoneStatusList.length - blockedPhones.length,
          blockedPhones: blockedPhones.length,
          lowQualityPhones: lowQualityPhones.length,
          totalTemplates: templates.length,
          approvedTemplates: approvedTemplates.length
        },
        phoneNumbers: phoneStatusList,
        criticalIssues: [
          blockedPhones.length === phoneStatusList.length 
            ? '🚫 CRÍTICO: TODOS os phone numbers estão bloqueados - campanha NÃO pode iniciar'
            : null,
          blockedPhones.length > 0 && blockedPhones.length < phoneStatusList.length
            ? `⚠️ ${blockedPhones.length} de ${phoneStatusList.length} phone numbers bloqueados`
            : null,
          lowQualityPhones.length > 0
            ? `🟡 ${lowQualityPhones.length} phone numbers com quality rating baixa`
            : null,
          approvedTemplates.length === 0
            ? '❌ Nenhum template aprovado - não é possível enviar mensagens'
            : null
        ].filter(Boolean),
        recommendations: [
          blockedPhones.length > 0 
            ? '1. Delete e re-adicione os phone numbers bloqueados no Meta Business Manager'
            : null,
          lowQualityPhones.length > 0
            ? '2. Melhore a qualidade das mensagens para aumentar o quality rating'
            : null,
          phoneStatusList.some(p => 'messaging_limit_tier' in p && p.messaging_limit_tier === 'TIER_250')
            ? '3. Envie 1.000 mensagens em 30 dias para upgrade de tier'
            : null,
          '4. Monitore os limites diários para evitar bloqueios',
          '5. Use templates UTILITY dentro da janela de 24h para economizar'
        ].filter(Boolean)
      });
    } catch (error: any) {
      routeError('Erro no diagnóstico WhatsApp:', {}, error);
      res.status(500).json({ 
        error: "Erro no diagnóstico", 
        details: error.message,
        canSend: false
      });
    }
  });

  // ============================================================================
  // MULTI-NÚMERO: Phone numbers com status completo
  // ============================================================================
  app.get("/api/phone-numbers/detailed", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      
      const detailedPhones: PhoneNumberWithStatus[] = await Promise.all(
        phoneNumbers.map(async (phone) => {
          try {
            const status = await metaAPI.getPhoneNumberStatus(phone.id, config.metaToken);
            const canSendResult = await metaAPI.canSendMessages(phone.id, config.metaToken);
            
            const tierLimit = 
              (status.messaging_limit_tier as string) === 'TIER_250' ? 250 :
              (status.messaging_limit_tier as string) === 'TIER_1K' ? 1000 :
              (status.messaging_limit_tier as string) === 'TIER_10K' ? 10000 :
              (status.messaging_limit_tier as string) === 'TIER_100K' ? 100000 : 999999;
            
            const maskedPhone = phone.display_phone_number.replace(/(\d{2})(\d{4,5})(\d{4})/, '+$1 **** $3');
            
            let phoneStatus: 'AVAILABLE' | 'BUSY' | 'BLOCKED' | 'DEGRADED' = 'AVAILABLE';
            if (status.account_mode === 'RESTRICTED') phoneStatus = 'BLOCKED';
            else if (status.quality_rating === 'RED') phoneStatus = 'DEGRADED';
            else if (status.account_mode === 'FLAGGED') phoneStatus = 'DEGRADED';
            
            return {
              id: phone.id,
              phoneNumberId: phone.id,
              displayPhone: phone.display_phone_number,
              maskedPhone,
              verifiedName: phone.verified_name || status.verified_name,
              qualityRating: status.quality_rating,
              tier: status.messaging_limit_tier,
              tierLimit,
              accountMode: status.account_mode,
              status: phoneStatus,
              canSend: canSendResult.canSend,
              estimatedDailyLimit: tierLimit
            };
          } catch (error: any) {
            return {
              id: phone.id,
              phoneNumberId: phone.id,
              displayPhone: phone.display_phone_number,
              maskedPhone: phone.display_phone_number,
              verifiedName: phone.verified_name || '',
              qualityRating: 'UNKNOWN' as const,
              tier: 'TIER_1K' as const,
              tierLimit: 1000,
              accountMode: 'PENDING' as const,
              status: 'BLOCKED' as const,
              canSend: false,
              estimatedDailyLimit: 0
            };
          }
        })
      );
      
      const sortedPhones = detailedPhones.sort((a, b) => {
        const qualityOrder = { GREEN: 3, YELLOW: 2, RED: 1, UNKNOWN: 0 };
        return (qualityOrder[b.qualityRating] || 0) - (qualityOrder[a.qualityRating] || 0);
      });

      res.json({
        total: sortedPhones.length,
        available: sortedPhones.filter(p => p.canSend).length,
        blocked: sortedPhones.filter(p => !p.canSend).length,
        phoneNumbers: sortedPhones
      });
    } catch (error: any) {
      routeError('Erro ao buscar phone numbers detalhados:', {}, error);
      res.status(500).json({ error: "Erro ao buscar phone numbers", details: error.message });
    }
  });

  // MULTI-NÚMERO: Calcular throughput estimado para seleção de números
  app.post("/api/phone-numbers/estimate-throughput", async (req, res) => {
    try {
      const { selectedPhoneIds, totalLeads, distributionStrategy = 'adaptive' } = req.body;
      
      if (!selectedPhoneIds || !Array.isArray(selectedPhoneIds) || selectedPhoneIds.length === 0) {
        return res.status(400).json({ error: "selectedPhoneIds é obrigatório" });
      }
      
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      const selectedPhones = phoneNumbers.filter(p => selectedPhoneIds.includes(p.id));
      
      const phoneDetails = await Promise.all(
        selectedPhones.map(async (phone) => {
          try {
            const status = await metaAPI.getPhoneNumberStatus(phone.id, config.metaToken);
            const tierLimit = 
              (status.messaging_limit_tier as string) === 'TIER_250' ? 250 :
              (status.messaging_limit_tier as string) === 'TIER_1K' ? 1000 :
              (status.messaging_limit_tier as string) === 'TIER_10K' ? 10000 :
              (status.messaging_limit_tier as string) === 'TIER_100K' ? 100000 : 999999;
            
            const qualityMultiplier = 
              status.quality_rating === 'GREEN' ? 1.0 :
              status.quality_rating === 'YELLOW' ? 0.7 :
              status.quality_rating === 'RED' ? 0.3 : 0.5;
            
            return {
              phoneId: phone.id,
              displayPhone: phone.display_phone_number,
              limit: tierLimit,
              qualityRating: status.quality_rating,
              contribution: tierLimit * qualityMultiplier,
              canSend: status.account_mode !== 'RESTRICTED'
            };
          } catch (e: any) {
            routeError('routes.fetchPhoneStatus', { phoneId: phone.id }, e);
            return {
              phoneId: phone.id,
              displayPhone: phone.display_phone_number,
              limit: 0,
              qualityRating: 'UNKNOWN',
              contribution: 0,
              canSend: false
            };
          }
        })
      );
      
      const availablePhones = phoneDetails.filter(p => p.canSend);
      const totalDailyCapacity = availablePhones.reduce((sum, p) => sum + p.limit, 0);
      
      const baseRatePerPhone = 15;
      const estimatedMsgPerSec = availablePhones.length * baseRatePerPhone * 
        (distributionStrategy === 'adaptive' ? 0.9 : 
         distributionStrategy === 'weighted' ? 0.8 : 0.7);
      
      const leadsToSend = totalLeads || 1000;
      const estimatedTimeSeconds = estimatedMsgPerSec > 0 ? leadsToSend / estimatedMsgPerSec : 0;
      
      const estimate: ThroughputEstimate = {
        totalPhones: selectedPhones.length,
        availablePhones: availablePhones.length,
        estimatedMsgPerSec: Math.round(estimatedMsgPerSec * 10) / 10,
        estimatedDailyCapacity: totalDailyCapacity,
        estimatedTimeToComplete: Math.round(estimatedTimeSeconds),
        breakdown: phoneDetails.map(p => ({
          phoneId: p.phoneId,
          displayPhone: p.displayPhone,
          contribution: Math.round(p.contribution),
          limit: p.limit
        }))
      };

      res.json(estimate);
    } catch (error: any) {
      routeError('Erro ao estimar throughput:', {}, error);
      res.status(500).json({ error: "Erro ao estimar throughput", details: error.message });
    }
  });

  // ============================================================================
  // OBSERVABILIDADE: SSE para métricas em tempo real
  // ============================================================================
  app.get("/api/campaigns/:campaignId/metrics/stream", async (req, res) => {
    const { campaignId } = req.params;
    const clientId = `client-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    
    console.log(`📊 SSE: Cliente ${clientId} conectado à campanha ${campaignId}`);
    
    metricsPublisher.addClient(clientId, campaignId, res);
    
    req.on('close', () => {
      console.log(`📊 SSE: Cliente ${clientId} desconectado`);
      metricsPublisher.removeClient(clientId);
    });
  });

  app.post("/api/test-campaign-simulation", async (req, res) => {
    const { totalLeads = 20, failRate = 0.1, delayMs = 200 } = req.body;
    const campaignId = `test-sim-${Date.now()}`;
    const adapter = getOrCreateAdapter(campaignId);
    const phones = ['+5577988443311', '+5511999887766'];

    res.json({ campaignId, message: `Simulacao iniciada com ${totalLeads} leads` });

    const buildMetrics = (state: string, processed: number, sent: number, failed: number, startTime: number, peak: number) => ({
      campaignId,
      state,
      currentMsgPerSec: processed > 0 ? Math.round(((processed / ((Date.now() - startTime) / 1000)) || 0) * 10) / 10 : 0,
      peakMsgPerSec: peak,
      avgMsgPerSec: processed > 0 ? Math.round(((processed / ((Date.now() - startTime) / 1000)) || 0) * 10) / 10 : 0,
      totalProcessed: processed,
      totalSuccess: sent,
      totalFailed: failed,
      totalLeads,
      progressPercent: Math.round((processed / totalLeads) * 1000) / 10,
      eta: { remainingSeconds: Math.max(0, ((totalLeads - processed) * delayMs) / 1000), estimatedCompletion: new Date().toISOString(), confidenceLevel: 'high' as const },
      latency: { p50: 140, p95: 200 + crypto.randomInt(0, 30), p99: 280, avg: 150 + crypto.randomInt(0, 40), trend: 'stable' as const },
      errors: { total: failed, rateLimitErrors: 0, payloadErrors: failed, networkErrors: 0, authErrors: 0, environmentErrors: 0, templateErrors: 0, timeoutErrors: 0 },
      metaBlockedCount: 0,
      preflightErrors: 0,
      environmentStatus: 'ok' as const,
      safeModeActive: false,
      pauseActive: false,
      failSafeActive: false,
      healthState: 'HEALTHY' as const,
      burstPhase: 'adaptive',
      detectedTier: 'STANDARD',
      indicators: { speedIndicator: 'normal' as const, stabilityIndicator: 'stable' as const, qualityIndicator: 'good' as const }
    });

    (async () => {
      try {
        adapter.publishStateChange('INIT', 'Inicializando simulacao');
        await new Promise(r => setTimeout(r, 500));
        adapter.publishStateChange('RUNNING', 'Motor rodando');

        let sent = 0;
        let failed = 0;
        let peak = 0;
        const startTime = Date.now();

        for (let i = 0; i < totalLeads; i++) {
          await new Promise(r => setTimeout(r, delayMs));
          const phone = phones[i % phones.length];
          const isError = crypto.randomInt(0, 1000) < failRate * 1000;

          if (isError) {
            failed++;
            adapter.publishSendResult({ success: false, phone, errorMessage: 'Simulated error', errorType: 'payloadError' });
          } else {
            sent++;
            adapter.publishSendResult({ success: true, phone });
          }

          const rate = (i + 1) / ((Date.now() - startTime) / 1000);
          if (rate > peak) peak = Math.round(rate * 10) / 10;

          metricsPublisher.updateGlobalMetrics(campaignId, buildMetrics('RUNNING', i + 1, sent, failed, startTime, peak) as any);
        }

        adapter.publishStateChange('COMPLETED', 'Simulacao finalizada');
        metricsPublisher.updateGlobalMetrics(campaignId, buildMetrics('COMPLETED', totalLeads, sent, failed, startTime, peak) as any);
        adapter.publishComplete({ total: totalLeads, success: sent, failed, duration: Date.now() - startTime });

        setTimeout(() => removeAdapter(campaignId), 30000);
      } catch (err) {
        routeError('routes.campaignSimulation', { campaignId }, err);
        adapter.publishStateChange('FAILED_GRACEFULLY', `Error: ${err}`);
        removeAdapter(campaignId);
      }
    })();
  });

  // Geração de imagem do pacote com nome e CPF
  // GET: preview com imagem padrão (Correios ou DIRPF)
  app.get("/api/package-image/preview", async (req, res) => {
    try {
      const { nome = "MARIA OLIVEIRA", cpf = "12345678900", type = "correios", templateId } = req.query as { nome?: string; cpf?: string; type?: string; templateId?: string };

      if (templateId) {
        const [customTpl] = await db.select().from(imageTemplates).where(eq(imageTemplates.id, templateId));
        if (!customTpl) {
          return res.status(404).json({ error: "Template não encontrado" });
        }
        const tplBaseExists = customTpl.baseImagePath
          ? await fs.promises.access(customTpl.baseImagePath).then(() => true).catch(() => false)
          : false;
        let baseBuffer: Buffer;
        if (!tplBaseExists && customTpl.baseImageData) {
          const safeBasePath = customTpl.baseImagePath || path.join(CAMPAIGN_IMAGES_DIR, 'templates', `${customTpl.id}.jpg`);
          const dir = path.dirname(safeBasePath);
          await fs.promises.mkdir(dir, { recursive: true });
          const restoredBuf = Buffer.from(customTpl.baseImageData, 'base64');
          await fs.promises.writeFile(safeBasePath, restoredBuf);
          if (!customTpl.baseImagePath) {
            await db.update(imageTemplates).set({ baseImagePath: safeBasePath }).where(eq(imageTemplates.id, customTpl.id));
          }
          baseBuffer = restoredBuf;
        } else if (tplBaseExists && customTpl.baseImagePath) {
          baseBuffer = await fs.promises.readFile(customTpl.baseImagePath);
        } else {
          return res.status(404).json({ error: "Imagem base do template não encontrada e sem dados de restauração no banco" });
        }
        const tplFields = (customTpl.fields || []) as ImageTemplateField[];
        const resultBuffer = await generateFromCustomTemplate(baseBuffer, tplFields, { name: nome, cpf });
        res.setHeader("Content-Type", "image/jpeg");
        res.setHeader("Cache-Control", "no-cache");
        return res.send(resultBuffer);
      }

      let baseImagePath: string;
      let imageType: "correios" | "dirpf";

      if (type === "dirpf") {
        baseImagePath = path.resolve(__dirname_routes, "../attached_assets/DIRPF_TEMPLATE.png");
        imageType = "dirpf";
      } else {
        baseImagePath = path.resolve(__dirname_routes, "../attached_assets/FOTO_PRODUTO_CORREIOS_1774527170319.jpg");
        imageType = "correios";
      }

      if (!(await fs.promises.access(baseImagePath).then(() => true).catch(() => false))) {
        return res.status(404).json({ error: "Imagem base não encontrada" });
      }

      const resultBuffer = await generatePackageImageFromFile(baseImagePath, {
        name: nome,
        cpf: cpf,
        imageType,
      });

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-cache");
      res.send(resultBuffer);
    } catch (error: any) {
      routeError('Erro ao gerar imagem de preview:', {}, error);
      res.status(500).json({ error: error.message || "Erro interno ao gerar imagem" });
    }
  });

  // POST: gera imagem com imagem base enviada ou usa padrão (Correios / DIRPF)
  app.post("/api/package-image/generate", upload.single("image"), async (req, res) => {
    try {
      const { nome, cpf, imageType } = req.body;

      if (!nome || !cpf) {
        return res.status(400).json({ error: "Nome e CPF são obrigatórios" });
      }

      let imageBuffer: Buffer;
      let detectedType: "correios" | "dirpf" | "auto";

      if (req.file) {
        imageBuffer = req.file.buffer;
        detectedType = (imageType || "auto") as "correios" | "dirpf" | "auto";
      } else if (imageType === "dirpf") {
        const dirpfImagePath = path.resolve(__dirname_routes, "../attached_assets/DIRPF_TEMPLATE.png");
        if (!(await fs.promises.access(dirpfImagePath).then(() => true).catch(() => false))) {
          return res.status(404).json({ error: "Imagem base DIRPF não encontrada" });
        }
        imageBuffer = await fs.promises.readFile(dirpfImagePath);
        detectedType = "dirpf";
      } else {
        const correiosImagePath = path.resolve(__dirname_routes, "../attached_assets/FOTO_PRODUTO_CORREIOS_1774527170319.jpg");
        if (!(await fs.promises.access(correiosImagePath).then(() => true).catch(() => false))) {
          return res.status(404).json({ error: "Imagem base do Correios não encontrada e nenhuma imagem enviada" });
        }
        imageBuffer = await fs.promises.readFile(correiosImagePath);
        detectedType = "correios";
      }

      const resultBuffer = await generatePackageImage(imageBuffer, {
        name: nome,
        cpf: cpf,
        imageType: detectedType,
      });

      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Disposition", `attachment; filename="pacote_${cpf.replace(/\D/g, "")}.jpg"`);
      res.send(resultBuffer);
    } catch (error: any) {
      routeError('Erro ao gerar imagem do pacote:', {}, error);
      res.status(500).json({ error: error.message || "Erro interno ao gerar imagem" });
    }
  });

  app.get("/api/signed-media/:token", async (req, res) => {
    const { token } = req.params;
    const result = verifySignedToken(token);
    if (!result.valid || !result.filePath) {
      console.error(`[SignedMedia] Token inválido ou expirado para path: ${result.filePath || 'unknown'}`);
      return res.status(403).json({ error: "Invalid or expired token" });
    }
    const absolutePath = path.resolve(__dirname_routes, "../uploads", result.filePath);
    if (!absolutePath.startsWith(path.resolve(__dirname_routes, "../uploads"))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!(await fs.promises.access(absolutePath).then(() => true).catch(() => false))) {
      console.error(`[SignedMedia] Arquivo não encontrado: ${absolutePath}`);
      return res.status(404).json({ error: "File not found" });
    }
    res.setHeader("Cache-Control", "private, max-age=1800");
    res.sendFile(absolutePath);
  });

  app.get("/api/campaign-images/:campaignId/:phone", async (req, res) => {
    const { campaignId, phone } = req.params;
    const safePhone = phone.replace(/\D/g, '');
    const publicDomain = `${req.protocol}://${req.get("host")}`;
    const signedUrl = generateSignedImageUrl(publicDomain, campaignId, safePhone);
    res.redirect(302, signedUrl);
  });

  // POST: upload de imagem base customizada para campanha
  app.post("/api/package-image/upload-campaign-base", upload.single("image"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Imagem obrigatória" });
      }
      const key = crypto.randomUUID();
      const filePath = path.join(CAMPAIGN_BASE_IMAGES_DIR, `${key}.jpg`);
      await fs.promises.writeFile(filePath, req.file.buffer);
      res.json({ imageKey: key });
    } catch (error: any) {
      routeError('postCampaignBaseImage', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  const TEMPLATE_IMAGES_DIR = path.join(__dirname_routes, '../uploads/template-base-images');
  fs.promises.mkdir(TEMPLATE_IMAGES_DIR, { recursive: true }).catch((e: any) => {
    logError('routes.mkdirTemplateImagesDir', { path: TEMPLATE_IMAGES_DIR }, e);
  });

  app.get("/api/image-templates", async (req, res) => {
    try {
      const results = await db.select().from(imageTemplates).where(eq(imageTemplates.userId, req.session.userId!));
      const withUrls = results.map((t) => ({
        ...t,
        baseImageUrl: t.baseImageUrl || `/uploads/template-base-images/${path.basename(t.baseImagePath)}`,
      }));
      res.json(withUrls);
    } catch (error: any) {
      routeError('Error fetching image templates:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/image-templates/:id", async (req, res) => {
    try {
      const [tpl] = await db.select().from(imageTemplates).where(and(eq(imageTemplates.id, req.params.id), eq(imageTemplates.userId, req.session.userId!)));
      if (!tpl) return res.status(404).json({ error: "Template não encontrado" });
      res.json({
        ...tpl,
        baseImageUrl: tpl.baseImageUrl || `/uploads/template-base-images/${path.basename(tpl.baseImagePath)}`,
      });
    } catch (error: any) {
      routeError('getImageTemplate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/image-templates", upload.single("image"), async (req, res) => {
    try {
      const { name, fields: fieldsStr, width, height } = req.body;
      if (!name || !req.file) {
        return res.status(400).json({ error: "Nome e imagem são obrigatórios" });
      }

      let parsedFields: ImageTemplateField[];
      try {
        parsedFields = fieldsStr ? JSON.parse(fieldsStr) : [];
        if (!Array.isArray(parsedFields)) throw new Error("fields must be an array");
      } catch (e: any) {
        console.debug('[routes] Invalid fields JSON for template upload', { error: e.message });
        return res.status(400).json({ error: "Formato de campos inválido" });
      }
      const key = crypto.randomUUID();
      const ext = path.extname(req.file.originalname || ".jpg");
      const filename = `${key}${ext}`;
      const filePath = path.join(TEMPLATE_IMAGES_DIR, filename);
      await fs.promises.writeFile(filePath, req.file.buffer);

      const base64Data = req.file.buffer.toString('base64');

      const [created] = await db.insert(imageTemplates).values({
        userId: req.session.userId!,
        name,
        baseImagePath: filePath,
        baseImageUrl: `/uploads/template-base-images/${filename}`,
        baseImageData: base64Data,
        width: parseInt(width) || 0,
        height: parseInt(height) || 0,
        fields: parsedFields,
        isActive: true,
      }).returning();

      res.json(created);
    } catch (error: any) {
      routeError('Error creating image template:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/image-templates/:id", upload.single("image"), async (req, res) => {
    try {
      const { name, fields: fieldsStr, width, height } = req.body;
      let parsedFields: ImageTemplateField[];
      try {
        parsedFields = fieldsStr ? JSON.parse(fieldsStr) : [];
        if (!Array.isArray(parsedFields)) throw new Error("fields must be an array");
      } catch (e: any) {
        console.debug('[routes] Invalid fields JSON for template update', { error: e.message });
        return res.status(400).json({ error: "Formato de campos inválido" });
      }

      const updates: Partial<typeof imageTemplates.$inferInsert> = {
        name,
        fields: parsedFields,
        width: parseInt(width) || 0,
        height: parseInt(height) || 0,
        updatedAt: new Date(),
      };

      if (req.file) {
        const key = crypto.randomUUID();
        const ext = path.extname(req.file.originalname || ".jpg");
        const filename = `${key}${ext}`;
        const filePath = path.join(TEMPLATE_IMAGES_DIR, filename);
        await fs.promises.writeFile(filePath, req.file.buffer);
        updates.baseImagePath = filePath;
        updates.baseImageUrl = `/uploads/template-base-images/${filename}`;
        updates.baseImageData = req.file.buffer.toString('base64');
      }

      const [updated] = await db.update(imageTemplates)
        .set(updates)
        .where(and(eq(imageTemplates.id, req.params.id), eq(imageTemplates.userId, req.session.userId!)))
        .returning();

      if (!updated) return res.status(404).json({ error: "Template não encontrado" });
      res.json(updated);
    } catch (error: any) {
      routeError('Error updating image template:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/image-templates/:id", async (req, res) => {
    try {
      const [deleted] = await db.delete(imageTemplates)
        .where(and(eq(imageTemplates.id, req.params.id), eq(imageTemplates.userId, req.session.userId!)))
        .returning();

      if (!deleted) return res.status(404).json({ error: "Template não encontrado" });
      if (deleted.baseImagePath) {
        await fs.promises.unlink(deleted.baseImagePath).catch(() => {});
      }
      res.json({ success: true });
    } catch (error: any) {
      routeError('deleteImageTemplate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // Debug: render a template with overlay bounding boxes (toggleable)
  app.post("/api/image-templates/:id/debug-render", async (req, res) => {
    try {
      const [tpl] = await db.select().from(imageTemplates)
        .where(and(eq(imageTemplates.id, req.params.id), eq(imageTemplates.userId, req.session.userId!)));
      if (!tpl) return res.status(404).json({ error: "Template não encontrado" });

      const { name = 'JOÃO DA SILVA SANTOS', cpf = '12345678901', debugOverlay = true } = req.body;
      const { generateFromCustomTemplate } = await import('./services/imageGenerator.js');

      let baseBuffer: Buffer;
      const basePathExists = tpl.baseImagePath
        ? await fs.promises.access(tpl.baseImagePath).then(() => true).catch(() => false)
        : false;

      if (basePathExists) {
        baseBuffer = await fs.promises.readFile(tpl.baseImagePath!);
      } else if (tpl.baseImageData) {
        baseBuffer = Buffer.from(tpl.baseImageData as string, 'base64');
      } else {
        return res.status(422).json({ error: "Base image not available for this template" });
      }

      const fields = (tpl.fields ?? []) as import('@shared/schema').ImageTemplateField[];
      const buf = await generateFromCustomTemplate(
        baseBuffer,
        fields,
        { name: String(name), cpf: String(cpf) },
        { templateId: tpl.id, debugOverlay: debugOverlay === true }
      );

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', `inline; filename="debug_${tpl.id}.jpg"`);
      res.setHeader('Content-Length', buf.length.toString());
      res.send(buf);
    } catch (error: any) {
      routeError('debugRenderImageTemplate', { templateId: req.params.id }, error);
      res.status(500).json({ error: error.message });
    }
  });

  // Debug: stress-test the image generation pipeline sequentially
  // Restricted to admin role to prevent accidental resource exhaustion in production.
  app.post("/api/debug/image-stress-test", async (req, res) => {
    if (req.session.userRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for stress-test endpoint' });
    }
    try {
      const { count = 10, templateId, debugOverlay = false, deterministic = false } = req.body;
      const safeCount = Math.min(Math.max(1, parseInt(String(count), 10)), 100);

      let baseImagePath: string | undefined;
      if (templateId) {
        const [tpl] = await db.select().from(imageTemplates)
          .where(and(eq(imageTemplates.id, templateId), eq(imageTemplates.userId, req.session.userId!)));
        if (tpl?.baseImagePath) {
          const exists = await fs.promises.access(tpl.baseImagePath).then(() => true).catch(() => false);
          if (exists) baseImagePath = tpl.baseImagePath;
        }
      }

      const { runImageStressTest } = await import('./scripts/imageStressTest.js');
      const report = await runImageStressTest({
        count: safeCount,
        templateId: templateId || undefined,
        baseImagePath,
        debugOverlay: debugOverlay === true,
        deterministic: deterministic === true,
      });

      res.json(report);
    } catch (error: any) {
      routeError('imageStressTest', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // Teste de envio de mensagem
  app.post("/api/test-message", async (req, res) => {
    try {
      const { phone, templateName, cpf, nome } = req.body;
      
      if (!phone || !templateName) {
        return res.status(400).json({ error: "Telefone e nome do template são obrigatórios" });
      }

      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      // Buscar números de telefone disponíveis
      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      if (phoneNumbers.length === 0) {
        return res.status(400).json({ error: "Nenhum número de telefone encontrado" });
      }

      const phoneNumberId = phoneNumbers[0].id;

      // Preparar parâmetros do template ({{1}} = CPF, {{2}} = Nome)
      const bodyParameters: Array<{type: 'text', text: string}> = [];
      if (cpf || nome) {
        // {{1}} = CPF sanitizado
        let cpfValue = cpf || '00000000000';
        cpfValue = cpfValue.replace(/[.\-\s]/g, '');
        bodyParameters.push({ type: 'text', text: cpfValue });
        
        // {{2}} = Nome
        const nomeValue = nome || 'Cliente Teste';
        bodyParameters.push({ type: 'text', text: nomeValue });
      }

      // Enviar mensagem de teste
      const result = await sendTemplateMessage(
        phoneNumberId,
        phone,
        templateName,
        'pt_BR',
        bodyParameters,
        config.metaToken
      );

      res.json({
        success: true,
        messageId: result.messages[0]?.id,
        phoneUsed: phoneNumbers[0].display_phone_number
      });
    } catch (error: any) {
      routeError('Error sending test message:', {}, error);
      res.status(500).json({ 
        error: "Erro ao enviar mensagem de teste",
        details: error.message
      });
    }
  });

  // Simular distribuição de leads
  app.post("/api/campaigns/:id/simulate-distribution", async (req, res) => {
    try {
      const { id } = req.params;
      const campaign = await getCampaignFromDbOrStorage(id);
      
      if (!campaign) {
        return res.status(404).json({ error: "Campanha não encontrada" });
      }

      const config = await getApiConfigFromDbOrStorage(campaign.userId);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      const leads = await db.select().from(leadsSchema).where(eq(leadsSchema.leadListId, campaign.leadListId!));
      
      // Simular distribuição sem executar
      const distributionResult = await distributeLeadsForCampaign(leads, config, 1000);
      
      // Gerar relatório detalhado
      const report = leadDistributionService.generateDistributionReport(distributionResult);
      
      res.json({
        distribution: distributionResult,
        report: report.split('\n')
      });
      
    } catch (error: any) {
      routeError('Error simulating distribution:', {}, error);
      res.status(500).json({ 
        error: "Erro ao simular distribuição",
        details: error.message
      });
    }
  });

  // Validar leads por texto
  app.post("/api/leads/validate", async (req, res) => {
    try {
      console.log('Recebendo validação de leads:', req.body);
      const { leadsData, format = 'legacy' } = req.body;
      
      if (!leadsData || typeof leadsData !== 'string') {
        return res.status(400).json({ error: "Dados de leads são obrigatórios" });
      }

      const lines = leadsData.trim().split('\n').filter(line => line.trim());
      const validLeads = [];
      const invalidLeads = [];

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;

        try {
          const parsed = parseLeads(trimmedLine, format);
          console.log('Parsed result para linha:', trimmedLine, parsed);
          if (parsed.validLeads.length > 0) {
            validLeads.push(...parsed.validLeads.map(lead => ({
              name: lead.nome,
              phone: lead.numero,
              produto: lead.produto,
              valor: lead.valor,
              codigoRastreio: lead.codigoRastreio,
              endereco: lead.endereco,
              cpf: lead.cpf,
              email: null,
              leadListId: "",
              isValid: true
            })));
          }
          if (parsed.errors.length > 0) {
            invalidLeads.push({
              line: trimmedLine,
              errors: parsed.errors
            });
          }
        } catch (error: any) {
          invalidLeads.push({
            line: trimmedLine,
            errors: [error.message || "Formato inválido"]
          });
        }
      }

      const summary = {
        total: lines.length,
        valid: validLeads.length,
        invalid: invalidLeads.length
      };

      console.log('Resultado final validação:', { validLeads, invalidLeads, summary });
      res.json({
        validLeads,
        invalidLeads,
        summary
      });

    } catch (error: any) {
      routeError('Error validating leads:', {}, error);
      res.status(500).json({ 
        error: "Erro ao validar leads",
        details: error.message
      });
    }
  });

  // Iniciar disparo direto
  app.post("/api/campaigns/dispatch", async (req, res) => {
    try {
      const { leads, phoneNumbers, templates, batchingRate, forcedLanguage, speedMode, customMessage, customMessages, isDynamicUrl, modo = 'template', dominios = [], variacoes4 = [], variacoes3 = [], singleParamTemplate, spDominios = [], spLinkPrefixes = [], burstMode: reqBurstMode, businessHoursOnly: reqBusinessHoursOnly, conversionMessage: reqConversionMessage, conversionLink: reqConversionLink, conversionDelayMs: reqConversionDelayMs, automationEnabled, automationFallback, automationRules, usePackageImage, packageImageType, packageImageKey, customImageTemplateId, enableOptOutFilter: reqEnableOptOutFilter, deliveryStrategy: reqDeliveryStrategy, followUpConfig: reqFollowUpConfig, wabaConfigs: reqWabaConfigs, templateWeights: reqTemplateWeights } = req.body;
      
      if (!leads || !Array.isArray(leads) || leads.length === 0) {
        return res.status(400).json({ error: "Leads são obrigatórios" });
      }

      if (!phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
        return res.status(400).json({ error: "Números de telefone são obrigatórios" });
      }

      if (!templates || !Array.isArray(templates) || templates.length === 0) {
        return res.status(400).json({ error: "Templates são obrigatórios" });
      }

      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      if (!config.metaToken || config.metaToken.trim() === '') {
        return res.status(400).json({ error: "Token de acesso (metaToken) não configurado. Configure seu token na página de conexão antes de iniciar a campanha." });
      }

      if (!config.appSecret || config.appSecret.trim() === '') {
        return res.status(400).json({ error: "App Secret não configurado. Configure o App Secret na página de conexão para garantir a segurança do webhook antes de iniciar a campanha." });
      }

      {
        const existingWabas = await db.select().from(wabasSchema).where(eq(wabasSchema.userId, req.session.userId!));
        const matchingWaba = existingWabas.find(w => w.wabaId === config.whatsappBusinessId || existingWabas.length > 0);

        if (existingWabas.length > 0 && matchingWaba) {
          if (!matchingWaba.subscribedAppsAt || matchingWaba.subscribedAppsStatus !== 'success') {
            return res.status(400).json({
              error: "WABA não inscrita no subscribed_apps. Aguarde o sistema processar a inscrição (ocorre automaticamente no boot) ou verifique os logs para erros de inscrição.",
              checklistItem: "subscribed_apps"
            });
          }

          if (!matchingWaba.lastWebhookReceivedAt) {
            return res.status(400).json({
              error: "Nenhum webhook recebido ainda para esta WABA. Envie uma mensagem de teste para o número da WABA antes de iniciar a campanha, para confirmar que o webhook está funcionando.",
              checklistItem: "webhook_received"
            });
          }
        }
      }

      const allTemplates = await db.select().from(templatesSchema).where(eq(templatesSchema.userId, req.session.userId!));
      const matchedTemplates = allTemplates.filter(t => templates.includes(t.name) && t.status === 'APPROVED');
      
      if (matchedTemplates.length === 0) {
        return res.status(404).json({ error: "Nenhum template aprovado encontrado" });
      }

      let filteredLeads = leads;
      let optOutRemoved = 0;
      if (reqEnableOptOutFilter !== false) {
        const optOutResult = await OptOutService.filterOptedOutLeads(leads);
        filteredLeads = optOutResult.clean;
        optOutRemoved = optOutResult.removed;
      }
      if (filteredLeads.length === 0) {
        return res.status(400).json({ error: reqEnableOptOutFilter !== false ? "Todos os leads estão na lista de opt-out" : "Nenhum lead fornecido" });
      }

      const [leadList] = await db.insert(leadListsSchema).values({
        name: `Disparo_${new Date().toISOString().slice(0, 19).replace('T', '_')}`,
        userId: req.session.userId!,
        status: "ready",
        totalLeads: filteredLeads.length,
        validLeads: filteredLeads.length,
        filePath: ""
      }).returning();

      let createdLeads: any[] = [];
      if (filteredLeads.length > 0) {
        createdLeads = await db.insert(leadsSchema).values(
          filteredLeads.map(lead => ({
            name: lead.name || 'Cliente',
            phone: lead.phone || '',
            email: lead.email,
            cpf: lead.cpf,
            produto: lead.produto,
            valor: lead.valor,
            codigoRastreio: lead.codigoRastreio,
            leadListId: leadList.id
          }))
        ).returning();
      }

      console.log(`✅ ${createdLeads.length} leads criados para campanha`);

      let autoRegisteredWabaId: string | null = null;
      try {
        const existingWabas = await wabaStorage.getWabasByUser(req.session.userId!);
        const alreadyExists = existingWabas.find(w => w.wabaId === config.whatsappBusinessId);
        if (!alreadyExists) {
          const autoWaba = await wabaStorage.createWaba({
            userId: req.session.userId!,
            name: `Auto-WABA ${config.whatsappBusinessId}`,
            wabaId: config.whatsappBusinessId,
            accessToken: config.metaToken,
          });
          autoRegisteredWabaId = autoWaba.id;
          console.log(`Auto-registrada WABA ${config.whatsappBusinessId} como ${autoWaba.id}`);
        } else {
          autoRegisteredWabaId = alreadyExists.id;
        }
      } catch (e) {
        routeError('routes.autoRegisterWaba', { wabaId: config?.whatsappBusinessId }, e);
      }

      const campaignConfig = {
        modo,
        speedMode,
        phoneNumbers,
        templates: templates,
        dominios: modo === 'blacksky' ? dominios : undefined,
        variacoes3: modo === 'blacksky' ? variacoes3 : undefined,
        variacoes4: modo === 'blacksky' ? variacoes4 : undefined,
        singleParamTemplate: modo === 'parametro_unico' ? singleParamTemplate : undefined,
        spDominios: modo === 'parametro_unico' ? spDominios : undefined,
        spLinkPrefixes: modo === 'parametro_unico' ? spLinkPrefixes : undefined,
        burstMode: reqBurstMode,
        businessHoursOnly: reqBusinessHoursOnly,
        deliveryStrategy: reqDeliveryStrategy || 'balanced',
        templateWeights: reqTemplateWeights,
      };

      const [campaign] = await db.insert(campaignsSchema).values({
        name: `Disparo_${new Date().toISOString().slice(0, 19).replace('T', '_')}`,
        templateId: matchedTemplates[0].id,
        leadListId: leadList.id,
        totalLeads: leads.length,
        userId: req.session.userId!,
        ...(reqConversionMessage ? { conversionMessage: reqConversionMessage } : {}),
        ...(reqConversionLink ? { conversionLink: reqConversionLink } : {}),
        ...(typeof reqConversionDelayMs === 'number' ? { conversionDelayMs: reqConversionDelayMs } : {}),
        ...(reqBurstMode ? { burstMode: true } : {}),
        ...(reqBusinessHoursOnly ? { businessHoursOnly: true } : {}),
      }).returning();

      registerPersistentCampaignTracker(campaign.id);

      await updateCampaignInDbAndStorage(campaign.id, {
        wabaId: autoRegisteredWabaId,
        campaignConfig: campaignConfig,
      } as any);

      if (reqBusinessHoursOnly) {
        console.log(`🕐 Horário comercial ativado para campanha ${campaign.id}`);
      }

      if (reqConversionMessage) {
        conversionTriggerService.registerCampaignConfig({
          campaignId: campaign.id,
          conversionMessage: reqConversionMessage,
          conversionLink: reqConversionLink || '',
          delayMs: typeof reqConversionDelayMs === 'number' ? reqConversionDelayMs : 0,
        });
        console.log(`🔗 Conversão pós-resposta configurada para ${campaign.id}`);
      }

      if (reqBurstMode) {
        const burstLauncher = new BurstLaunchMode();
        const allPhones = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
        burstLauncher.initialize(allPhones.map(p => ({ id: p.id, displayPhoneNumber: p.display_phone_number })));
        burstLauncher.start();
        activeBurstLaunchers.set(campaign.id, burstLauncher);
        console.log(`🚀 BurstLaunchMode ativado para campanha ${campaign.id} (${burstLauncher.getActivePhoneCount()} números)`);
      }

      try {
        const allPhones = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
        bmQualityMonitor.start(config.metaToken, allPhones.map(p => p.id));
      } catch (e: unknown) {
        routeError('routes.bmQualityMonitor', { wabaId: config?.whatsappBusinessId }, e);
      }

      if (automationEnabled) {
        await updateCampaignInDbAndStorage(campaign.id, {
          automationEnabled: true,
          automationFallback: automationFallback || "ignore"
        });
        if (Array.isArray(automationRules) && automationRules.length > 0) {
          await wabaStorage.updateAutomationRules(campaign.id, automationRules);
        }
      }

      if (reqFollowUpConfig && reqFollowUpConfig.message) {
        try {
          await EngagementManager.createFollowUpRules({
            campaignId: campaign.id.toString(),
            stages: [{
              stage: 1,
              delayMinutes: reqFollowUpConfig.delayMinutes || 1440,
              messageText: reqFollowUpConfig.message,
            }],
          });
          const leadPhones = filteredLeads.map((l: any) => l.phone).filter(Boolean);
          if (leadPhones.length > 0) {
            await EngagementManager.initializeLeadFollowUp(campaign.id.toString(), leadPhones);
          }
          console.log(`📨 Follow-up configurado para campanha ${campaign.id} (${reqFollowUpConfig.delayMinutes || 1440}min, ${leadPhones.length} leads)`);
        } catch (e) {
          routeError('routes.followUpConfig', { campaignId: campaign.id }, e);
        }
      }

      if (reqDeliveryStrategy) {
        console.log(`📋 Estrategia de entrega: ${reqDeliveryStrategy.toUpperCase()}`);
      }

      const templateNames = matchedTemplates.map(t => t.name);
      let resolvedCustomMessages = customMessages || (customMessage ? { 3: customMessage } : undefined);
      const isBlacksky = false;
      const blackskyConfig = undefined;
      const isParametroUnico = false;
      const parametroUnicoConfig = undefined;
      const validWabaConfigs = Array.isArray(reqWabaConfigs) ? reqWabaConfigs.filter((w: any) => w?.wabaId && w?.accessToken && Array.isArray(w?.phoneNumberIds)) : undefined;
      executeParallelCampaign(campaign.id, batchingRate, forcedLanguage, speedMode, resolvedCustomMessages, isDynamicUrl, templateNames, undefined, isBlacksky, blackskyConfig, isParametroUnico, parametroUnicoConfig, usePackageImage ? true : false, packageImageType || 'auto', packageImageKey || undefined, customImageTemplateId || undefined, validWabaConfigs, reqTemplateWeights).catch(error => {
        routeError('Error executing parallel campaign:', {}, error);
      });

      res.json({
        campaignId: campaign.id,
        leadsCount: filteredLeads.length,
        phonesCount: phoneNumbers.length,
        templateName: matchedTemplates[0].name,
        selectedTemplates: templateNames,
        templateRotation: matchedTemplates.length > 1,
        optOutRemoved,
        deliveryStrategy: reqDeliveryStrategy || 'balanced',
        followUpEnabled: !!(reqFollowUpConfig && reqFollowUpConfig.message),
        status: "started",
        modo: 'template'
      });

    } catch (error: any) {
      routeError('Error starting dispatch:', {}, error);
      res.status(500).json({ 
        error: "Erro ao iniciar disparo",
        details: error.message
      });
    }
  });

  // ===== LEAD CLEANER ULTRA ROUTES =====
  
  const { leadCleanerUltraService } = await import("./modules/leadCleanerUltra/LeadCleanerUltraController");
  const { runFullTest } = await import("./modules/leadCleanerUltra/LeadCleanerTestRunner");
  const { runApiDiagnostic } = await import("./modules/leadCleanerUltra/ApiDiagnostic");
  const { runSystemSelfTest } = await import("./modules/leadCleanerUltra/SystemSelfTest");

  app.post("/api/lead-cleaner/self-test", async (_req, res) => {
    try {
      const result = await runSystemSelfTest();
      res.json(result);
    } catch (error: any) {
      routeError('[SystemSelfTest] error:', {}, error);
      res.status(500).json({ error: error.message || "Erro ao rodar self-test" });
    }
  });

  app.post("/api/lead-cleaner/api-diagnostic", async (req, res) => {
    try {
      const testPhone = req.body?.phone || "5511999999999";
      const result = await runApiDiagnostic(testPhone);
      res.json(result);
    } catch (error: any) {
      routeError('[ApiDiagnostic] error:', {}, error);
      res.status(500).json({ error: error.message || "Erro ao rodar diagnóstico" });
    }
  });

  app.post("/api/lead-cleaner/test", upload.single("file"), async (req, res) => {
    try {
      let inputText: string | undefined;
      if (req.file) {
        inputText = req.file.buffer.toString("utf-8");
      } else if (req.body?.text) {
        inputText = req.body.text;
      }
      const result = runFullTest(inputText);
      res.json(result);
    } catch (error: any) {
      routeError('[LeadCleanerTest] error:', {}, error);
      res.status(500).json({ error: error.message || "Erro ao rodar testes" });
    }
  });

  app.post("/api/lead-cleaner/start", leadCleanerUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado" });
      }
      const leadsPerFile = parseInt(req.body?.leadsPerFile) || 0;
      const processId = leadCleanerUltraService.startProcessFromFilePath(
        req.file.path,
        req.file.originalname,
        leadsPerFile
      );
      res.json({ processId });
    } catch (error: any) {
      routeError('[LeadCleanerUltra] start error:', {}, error);
      res.status(500).json({ error: error.message || "Erro ao iniciar processamento" });
    }
  });

  app.post("/api/lead-cleaner/start-text", async (req, res) => {
    try {
      const { text, leadsPerFile } = req.body;
      if (!text || typeof text !== "string" || text.trim().length === 0) {
        return res.status(400).json({ error: "Nenhum texto fornecido" });
      }
      const limit = parseInt(leadsPerFile) || 0;
      const processId = leadCleanerUltraService.startProcessFromText(text, limit);
      res.json({ processId });
    } catch (error: any) {
      routeError('[LeadCleanerUltra] start-text error:', {}, error);
      res.status(500).json({ error: error.message || "Erro ao iniciar processamento" });
    }
  });

  app.get("/api/lead-cleaner/progress/:processId", async (req, res) => {
    const { processId } = req.params;
    const progress = leadCleanerUltraService.getProgress(processId);
    if (!progress) {
      return res.status(404).json({ error: "Processo não encontrado" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    leadCleanerUltraService.addSSEClient(processId, res);
  });

  app.get("/api/lead-cleaner/download/:processId", async (req, res) => {
    try {
      const allPaths = leadCleanerUltraService.getAllFilePaths(req.params.processId);

      if (!allPaths.length) {
        return res.status(404).json({ error: "Arquivo não encontrado ou processamento não concluído" });
      }

      let fileIndex = parseInt(req.query.file as string) || 0;
      if (fileIndex < 0 || fileIndex >= allPaths.length) {
        fileIndex = 0;
      }

      const filePath = allPaths[fileIndex];
      const filePathExists = filePath ? await fs.promises.access(filePath).then(() => true).catch(() => false) : false;
      if (!filePath || !filePathExists) {
        return res.status(404).json({ error: "Arquivo não encontrado" });
      }

      const basename = path.basename(filePath);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${basename}"`);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch (error: any) {
      routeError('[LeadCleanerUltra] download error:', {}, error);
      res.status(500).json({ error: "Erro ao gerar arquivo" });
    }
  });

  app.get("/api/lead-cleaner/files/:processId", async (req, res) => {
    try {
      const allPaths = leadCleanerUltraService.getAllFilePaths(req.params.processId);
      const files: { index: number; filename: string; leads: number }[] = [];
      for (let i = 0; i < allPaths.length; i++) {
        const fp = allPaths[i];
        let count = 0;
        try {
          const fpExists = await fs.promises.access(fp).then(() => true).catch(() => false);
          if (fpExists) {
            const content = await fs.promises.readFile(fp, "utf-8");
            count = content.split("\n").filter(l => l.trim()).length;
          }
        } catch (e: any) {
          routeError('routes.countLeadFileLines', { fp }, e);
        }
        const parts = fp.split("/");
        files.push({ index: i, filename: parts[parts.length - 1] || fp, leads: count });
      }
      res.json({ files, total: files.reduce((s, f) => s + f.leads, 0) });
    } catch (error: any) {
      routeError('listLeadCleanerFiles', {}, error);
      res.status(500).json({ error: "Erro ao listar arquivos" });
    }
  });

  app.get("/api/lead-cleaner/download-log/:processId", async (req, res) => {
    try {
      const logPath = leadCleanerUltraService.getLogPath(req.params.processId);
      const logExists = logPath ? await fs.promises.access(logPath).then(() => true).catch(() => false) : false;
      if (!logPath || !logExists) {
        return res.status(404).json({ error: "Log não encontrado" });
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="log_${Date.now()}.txt"`);
      const stream = fs.createReadStream(logPath);
      stream.pipe(res);
    } catch (error: any) {
      routeError('[LeadCleanerUltra] download-log error:', {}, error);
      res.status(500).json({ error: "Erro ao gerar log" });
    }
  });


  // WhatsApp Group Extractor routes (personal number — read-only, isolated from Meta Cloud API)
  app.post("/api/wa-extractor/start", async (req, res) => {
    try {
      const userId = req.session.userId!;
      const result = await whatsAppExtractorService.startSession(userId);
      res.json(result);
    } catch (error: unknown) {
      const isUserError = error instanceof WaExtractorUserError || error instanceof ProxyUnavailableError;
      if (!isUserError) routeError("waExtractor.start", {}, error);
      const msg = error instanceof Error ? error.message : "Erro ao iniciar sessão";
      res.status(isUserError ? 400 : 500).json({ error: msg });
    }
  });

  app.get("/api/wa-extractor/status", async (req, res) => {
    try {
      const userId = req.session.userId!;
      let result = whatsAppExtractorService.getQrCode(userId);
      if (result.status === "idle" && whatsAppExtractorService.hasCredentialsOnDisk(userId)) {
        result = await whatsAppExtractorService.startSession(userId);
      }
      res.json(result);
    } catch (error: unknown) {
      const isUserError = error instanceof WaExtractorUserError || error instanceof ProxyUnavailableError;
      if (!isUserError) routeError("waExtractor.status", {}, error);
      const msg = error instanceof Error ? error.message : "Erro ao obter status";
      res.status(isUserError ? 400 : 500).json({ error: msg });
    }
  });

  app.post("/api/wa-extractor/disconnect", async (req, res) => {
    try {
      const userId = req.session.userId!;
      await whatsAppExtractorService.disconnect(userId);
      res.json({ success: true });
    } catch (error: unknown) {
      const isUserError = error instanceof WaExtractorUserError;
      if (!isUserError) routeError("waExtractor.disconnect", {}, error);
      const msg = error instanceof Error ? error.message : "Erro ao desconectar";
      res.status(isUserError ? 400 : 500).json({ error: msg });
    }
  });

  app.post("/api/wa-extractor/extract", async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { inviteLink } = req.body;
      if (!inviteLink || typeof inviteLink !== "string") {
        return res.status(400).json({ error: "Link de convite é obrigatório" });
      }
      const participants = await whatsAppExtractorService.extractParticipants(userId, inviteLink);
      res.json({ participants, count: participants.length });
    } catch (error: unknown) {
      const isUserError = error instanceof WaExtractorUserError;
      if (!isUserError) {
        routeError("waExtractor.extract", {}, error);
      }
      const msg = error instanceof Error ? error.message : "Erro ao extrair participantes";
      res.status(isUserError ? 400 : 500).json({ error: msg });
    }
  });

  // Proxy Pool status endpoints — admin only (expõe metadados de infraestrutura)
  app.get("/api/proxy-pool/status", (req, res) => {
    if (req.session.userRole !== "admin") {
      return res.status(403).json({ error: "Acesso restrito a administradores" });
    }
    try {
      const status = proxyPoolManager.getStatus();
      res.json(status);
    } catch (err: unknown) {
      routeError("proxyPool.status", {}, err);
      res.status(500).json({ error: "Erro ao obter status do pool de proxies" });
    }
  });

  app.post("/api/proxy-pool/health-check", async (req, res) => {
    if (req.session.userRole !== "admin") {
      return res.status(403).json({ error: "Acesso restrito a administradores" });
    }
    try {
      await proxyPoolManager.runHealthChecks();
      res.json(proxyPoolManager.getStatus());
    } catch (err: unknown) {
      routeError("proxyPool.healthCheck", {}, err);
      res.status(500).json({ error: "Erro ao executar health check dos proxies" });
    }
  });

  // Proxy CRUD endpoints — admin only
  app.get("/api/proxies", async (req, res) => {
    if (req.session.userRole !== "admin") {
      return res.status(403).json({ error: "Acesso restrito a administradores" });
    }
    try {
      const rows = await db.select().from(proxiesSchema).orderBy(proxiesSchema.createdAt);
      const poolProxies = proxyPoolManager.getAll();
      const result = rows.map((r) => {
        const inPool = poolProxies.find((p) => p.id === r.id || p.url === r.url);
        return {
          ...r,
          runtimeActive: inPool ? (inPool.active && !inPool.userDisabled) : false,
          runtimeLatencyMs: inPool ? inPool.latencyMs : null,
          runtimeLastError: inPool ? inPool.lastError : null,
          assignedSessionId: inPool ? inPool.assignedSessionId : null,
          userDisabled: inPool ? inPool.userDisabled : !r.isActive,
        };
      });
      res.json(result);
    } catch (err: unknown) {
      routeError("proxies.list", {}, err);
      res.status(500).json({ error: "Erro ao listar proxies" });
    }
  });

  app.post("/api/proxies", async (req, res) => {
    if (req.session.userRole !== "admin") {
      return res.status(403).json({ error: "Acesso restrito a administradores" });
    }
    try {
      const parsed = insertProxySchema.parse(req.body);
      const existing = await db.select({ id: proxiesSchema.id }).from(proxiesSchema).where(eq(proxiesSchema.url, parsed.url));
      if (existing.length > 0) {
        return res.status(409).json({ error: "Proxy com esta URL já cadastrado" });
      }
      await proxyPoolManager.addProxy(parsed.url, parsed.label ?? undefined);
      const [row] = await db.select().from(proxiesSchema).where(eq(proxiesSchema.url, parsed.url));
      res.status(201).json(row);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Dados inválidos", details: err.errors });
      }
      // DB unique constraint violation (concurrent insert)
      if (err instanceof Error && err.message.includes("proxies_url_unique")) {
        return res.status(409).json({ error: "Proxy com esta URL já cadastrado" });
      }
      routeError("proxies.create", {}, err);
      res.status(500).json({ error: "Erro ao adicionar proxy" });
    }
  });

  app.patch("/api/proxies/:id", async (req, res) => {
    if (req.session.userRole !== "admin") {
      return res.status(403).json({ error: "Acesso restrito a administradores" });
    }
    try {
      const { id } = req.params;
      const parsed = updateProxySchema.parse(req.body);
      const [existing] = await db.select().from(proxiesSchema).where(eq(proxiesSchema.id, id));
      if (!existing) {
        return res.status(404).json({ error: "Proxy não encontrado" });
      }
      if (typeof parsed.isActive === "boolean") {
        await proxyPoolManager.setProxyActive(id, parsed.isActive);
      }
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof parsed.label === "string") updates.label = parsed.label;
      await db.update(proxiesSchema).set(updates).where(eq(proxiesSchema.id, id));
      const [updated] = await db.select().from(proxiesSchema).where(eq(proxiesSchema.id, id));
      res.json(updated);
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: "Dados inválidos", details: err.errors });
      }
      routeError("proxies.update", { id: req.params.id }, err);
      res.status(500).json({ error: "Erro ao atualizar proxy" });
    }
  });

  app.delete("/api/proxies/:id", async (req, res) => {
    if (req.session.userRole !== "admin") {
      return res.status(403).json({ error: "Acesso restrito a administradores" });
    }
    try {
      const { id } = req.params;
      const [existing] = await db.select().from(proxiesSchema).where(eq(proxiesSchema.id, id));
      if (!existing) {
        return res.status(404).json({ error: "Proxy não encontrado" });
      }
      await proxyPoolManager.removeProxy(id);
      res.json({ success: true });
    } catch (err: unknown) {
      routeError("proxies.delete", { id: req.params.id }, err);
      res.status(500).json({ error: "Erro ao remover proxy" });
    }
  });

  // Endpoint para monitorar progresso da campanha
  app.get("/api/campaigns/:id/progress", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const campaign = await getCampaignFromDbOrStorage(campaignId);
      
      if (!campaign) {
        return res.status(404).json({ error: "Campanha não encontrada" });
      }

      // Se a campanha está rodando, incluir estatísticas detalhadas do motor V3
      if (campaign.status === "running") {
        const engine = activeUltraEngines.get(campaign.id);
        const ultraStats = engine?.getUltraStats();
        res.json({
          campaignId: campaign.id,
          status: campaign.status,
          totalLeads: campaign.totalLeads,
          sentMessages: campaign.sentMessages || 0,
          successMessages: campaign.successMessages || 0,
          failedMessages: campaign.failedMessages || 0,
          estimatedTime: campaign.estimatedTime || "Calculando...",
          ultraStats: ultraStats || null,
          safeModeState: engine?.getSafeModeState() || null,
          detectedTier: engine?.getDetectedTier() || null
        });
      } else {
        res.json({
          campaignId: campaign.id,
          status: campaign.status,
          totalLeads: campaign.totalLeads,
          sentMessages: campaign.sentMessages || 0,
          successMessages: campaign.successMessages || 0,
          failedMessages: campaign.failedMessages || 0,
          estimatedTime: campaign.estimatedTime || "Calculando..."
        });
      }
    } catch (error) {
      routeError('Error getting campaign progress:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Controle do sistema OVERDRIVE V3
  app.post("/api/campaigns/:id/parallel/stop", async (req, res) => {
    try {
      const campaignId = req.params.id;
      
      // Parar engine UltraStable V3 (se existir)
      const engine = activeUltraEngines.get(campaignId);
      if (engine) {
        const stats = engine.getUltraStats();
        engine.stopCampaign();
        console.log(`🛑 OVERDRIVE V3: Engine da campanha ${campaignId} parado`);
        
        // Salvar checkpoint V3
        if (stats) {
          ultraCheckpoints.set(campaignId, {
            campaignId,
            lastProcessedIndex: stats.processedLeads - 1,
            successCount: stats.successfulSends,
            failedCount: stats.failedSends,
            timestamp: Date.now()
          });
        }
      }
      
      const checkpoint = ultraCheckpoints.get(campaignId);
      if (checkpoint) {
        ultraCheckpoints.delete(campaignId);
        console.log(`[MEMORY_CLEANUP] ultraCheckpoints cleared on paused transition for campaignId=${campaignId}`);
      }

      await updateCampaignInDbAndStorage(campaignId, { 
        status: "paused",
        updatedAt: new Date()
      });
      
      res.json({ 
        success: true, 
        message: "Campanha pausada (OVERDRIVE V3)",
        checkpoint: checkpoint ? {
          lastProcessedIndex: checkpoint.lastProcessedIndex,
          successCount: checkpoint.successCount,
          failedCount: checkpoint.failedCount
        } : null
      });
    } catch (error) {
      routeError('Error stopping OVERDRIVE campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Retomar campanha pausada do último checkpoint (OVERDRIVE V3)
  app.post("/api/campaigns/:id/resume", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const campaign = await getCampaignFromDbOrStorage(campaignId);
      
      if (!campaign) {
        return res.status(404).json({ error: "Campanha não encontrada" });
      }
      
      if (campaign.status !== 'paused') {
        return res.status(400).json({ error: "Apenas campanhas pausadas podem ser retomadas" });
      }
      
      // Resume index from DB counters (checkpoint was cleared at pause to prevent memory leak)
      const startFromIndex = (campaign.successMessages ?? 0) + (campaign.failedMessages ?? 0);
      
      console.log(`🔄 OVERDRIVE V3: Retomando campanha ${campaignId} do índice ${startFromIndex}`);
      
      // Retomar execução em background com motor V3
      executeUltraStableCampaignWithResume(campaignId, startFromIndex).catch(error => {
        routeError('Error resuming OVERDRIVE campaign:', {}, error);
      });
      
      res.json({ 
        success: true, 
        message: `Campanha retomada do lead ${startFromIndex + 1} (OVERDRIVE V3)`,
        startFromIndex 
      });
    } catch (error) {
      routeError('Error resuming campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Buscar checkpoint de uma campanha (OVERDRIVE V3)
  app.get("/api/campaigns/:id/checkpoint", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const checkpoint = ultraCheckpoints.get(campaignId);
      
      if (checkpoint) {
        res.json(checkpoint);
      } else {
        res.status(404).json({ error: "Checkpoint não encontrado" });
      }
    } catch (error) {
      routeError('Error getting checkpoint:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Configuração de velocidade - OVERDRIVE V3 usa configuração automática
  app.post("/api/campaigns/parallel/config", async (req, res) => {
    try {
      const { preset } = req.body;
      
      // OVERDRIVE V3 gerencia velocidade automaticamente via SafeMode/CircuitBreaker
      res.json({ 
        success: true, 
        message: `OVERDRIVE V3: Velocidade gerenciada automaticamente (preset ${preset || 'auto'} ignorado)`,
        engine: "UltraStableEngine V3",
        features: {
          safeMode: "automático",
          circuitBreaker: "preventivo",
          tierDetection: "ativo",
          retryQueue: "não-bloqueante"
        }
      });
    } catch (error) {
      routeError('Error updating config:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Obter estatísticas detalhadas do OVERDRIVE V3
  app.get("/api/campaigns/parallel/stats", async (req, res) => {
    try {
      const allStats: Record<string, any> = {};
      
      for (const [cid, eng] of Array.from(activeUltraEngines.entries())) {
        allStats[cid] = {
          ultraStats: eng.getUltraStats(),
          safeModeState: eng.getSafeModeState(),
          errorCounts: eng.getErrorCounts(),
          detectedTier: eng.getDetectedTier(),
          isActive: eng.isActive()
        };
      }
      
      res.json({
        engine: "OVERDRIVE UltraStable V3",
        activeCampaigns: activeUltraEngines.size,
        campaigns: allStats
      });
    } catch (error) {
      routeError('Error getting OVERDRIVE stats:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Lead Lists routes
  app.get("/api/lead-lists", async (req, res) => {
    try {
      const leadListResults = await db.select().from(leadListsSchema).where(eq(leadListsSchema.userId, req.session.userId!));
      res.json(leadListResults);
    } catch (error) {
      routeError('Error getting lead lists:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/lead-lists", async (req, res) => {
    if (!req.body.leadsFileURL) {
      return res.status(400).json({ error: "leadsFileURL is required" });
    }

    try {
      const objectPath = objectStorageService.normalizeObjectEntityPath(req.body.leadsFileURL);
      
      // Create initial lead list record
      const [leadList] = await db.insert(leadListsSchema).values({
        userId: req.session.userId!,
        name: req.body.name || "Imported Leads",
        filePath: objectPath,
        totalLeads: 0,
        validLeads: 0,
        status: "processing",
      }).returning();

      // Process file asynchronously
      processLeadsFile(leadList.id, objectPath).catch(console.error);
      
      res.json({ leadListId: leadList.id });
    } catch (error) {
      routeError('Error creating lead list:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/lead-lists/:id/leads", async (req, res) => {
    try {
      const leads = await db.select().from(leadsSchema).where(eq(leadsSchema.leadListId, req.params.id));
      res.json(leads);
    } catch (error) {
      routeError('Error getting leads:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/lead-lists/parse-text", async (req, res) => {
    try {
      const { leadsText, name, format } = req.body;
      
      if (!leadsText || typeof leadsText !== 'string') {
        return res.status(400).json({ error: "leadsText é obrigatório" });
      }

      const parseResult = parseLeads(leadsText, format || 'cpf');
      
      if (parseResult.validLeads.length === 0) {
        return res.status(400).json({ 
          error: "Nenhum lead válido encontrado", 
          errors: parseResult.errors 
        });
      }

      const [leadList] = await db.insert(leadListsSchema).values({
        userId: req.session.userId!,
        name: name || "Lista importada",
        filePath: "",
        totalLeads: parseResult.validLeads.length + parseResult.errors.length,
        validLeads: parseResult.validLeads.length,
        status: "ready",
      }).returning();

      if (parseResult.validLeads.length > 0) {
        await db.insert(leadsSchema).values(
          parseResult.validLeads.map(leadData => ({
            leadListId: leadList.id,
            name: leadData.nome,
            phone: leadData.numero,
            cpf: leadData.cpf || null,
            email: null,
            endereco: leadData.endereco || null,
            produto: leadData.produto || null,
            valor: leadData.valor || null,
            codigoRastreio: leadData.codigoRastreio || null,
          }))
        );
      }

      res.json({
        leadListId: leadList.id,
        validLeads: parseResult.validLeads.length,
        errors: parseResult.errors,
      });
    } catch (error) {
      routeError('Error parsing leads:', {}, error);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });

  app.post("/api/lead-lists/create-direct", async (req, res) => {
    try {
      const { name, leads: leadsData } = req.body;
      if (!Array.isArray(leadsData) || leadsData.length === 0) {
        return res.status(400).json({ error: "Lista de leads vazia" });
      }

      const validLeads = leadsData.filter((ld: any) => ld.phone);

      const [leadList] = await db.insert(leadListsSchema).values({
        userId: req.session.userId!,
        name: name || "Lista direta",
        filePath: "",
        totalLeads: validLeads.length,
        validLeads: validLeads.length,
        status: "ready",
      }).returning();

      if (validLeads.length > 0) {
        await db.insert(leadsSchema).values(
          validLeads.map((ld: any) => ({
            leadListId: leadList.id,
            name: ld.name || "Lead",
            phone: ld.phone.startsWith("+") ? ld.phone : `+${ld.phone}`,
            cpf: ld.cpf || null,
            email: ld.email || null,
            endereco: ld.endereco || null,
            produto: ld.produto || null,
            valor: ld.valor || null,
            codigoRastreio: ld.codigoRastreio || null,
          }))
        );
      }

      res.json({ leadListId: leadList.id, totalLeads: validLeads.length });
    } catch (error) {
      routeError('Error creating direct lead list:', {}, error);
      res.status(500).json({ error: "Erro interno do servidor" });
    }
  });

  // Campaigns routes
  app.get("/api/campaigns", async (req, res) => {
    try {
      const campaigns = await db.select().from(campaignsSchema).where(eq(campaignsSchema.userId, req.session.userId!));
      res.json(campaigns);
    } catch (error) {
      routeError('Error getting campaigns:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/campaigns/active", async (req, res) => {
    try {
      const campaigns = await db.select().from(campaignsSchema).where(and(eq(campaignsSchema.userId, req.session.userId!), eq(campaignsSchema.status, "running")));
      res.json(campaigns);
    } catch (error) {
      routeError('Error getting active campaigns:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/campaigns", async (req, res) => {
    try {
      const validatedData = insertCampaignSchema.parse(req.body);
      
      const [campaign] = await db.insert(campaignsSchema).values({
        ...validatedData,
        userId: req.session.userId!,
      }).returning();

      registerPersistentCampaignTracker(campaign.id);
      res.json(campaign);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid data", details: error.errors });
      }
      routeError('Error creating campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Nova rota: Diagnóstico de Template e Número com análise específica
  app.post("/api/diagnosis/template", async (req, res) => {
    try {
      const { templateName, phoneNumberId } = req.body;
      
      if (!templateName || !phoneNumberId) {
        return res.status(400).json({ error: "templateName e phoneNumberId são obrigatórios" });
      }

      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Configuração válida da API é obrigatória" });
      }

      const allTemplates = await db.select().from(templatesSchema).where(eq(templatesSchema.userId, req.session.userId!));
      const template = allTemplates.find(t => t.name === templateName);
      
      if (!template) {
        return res.status(404).json({ error: "Template não encontrado" });
      }

      // Diagnóstico específico para problemas de entrega
      const { DeliveryAnalyzer } = await import('./utils/deliveryAnalyzer');
      
      const analysis = DeliveryAnalyzer.analyzeDeliveryIssue({
        messageId: 'diagnostic',
        templateCategory: template.category,
        recipientPhone: '5561982162111', // Número exemplo dos logs
        apiResponse: { messages: [{ message_status: 'accepted' }] }
      });

      const actionPlan = DeliveryAnalyzer.generateActionPlan(analysis);
      
      // Resultado do diagnóstico
      const diagnosis = {
        templateValid: template.status === 'APPROVED',
        templateStatus: template.status,
        templateCategory: template.category,
        phoneNumberValid: true,
        phoneNumberStatus: 'CONNECTED',
        issues: analysis,
        actionPlan,
        suggestions: analysis.map(issue => `${issue.issue}: ${issue.description} - ${issue.solution}`)
      };
      
      console.log(`🏥 Diagnóstico completo:`, JSON.stringify(diagnosis, null, 2));
      
      res.json(diagnosis);
    } catch (error: any) {
      routeError('Erro no diagnóstico:', {}, error);
      res.status(500).json({ 
        error: "Erro ao diagnosticar template",
        details: error.message
      });
    }
  });

  app.post("/api/audit/full", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({
          ok: false,
          issues: ["Configuração da API Meta não encontrada ou inválida"],
          warnings: [],
          details: {}
        });
      }

      const { templateName, phoneNumberId } = req.body;
      const issues: string[] = [];
      const warnings: string[] = [];
      const details: Record<string, any> = {};

      let tokenValid = false;
      try {
        tokenValid = await validateCredentials(config.metaToken, config.whatsappBusinessId);
        details.tokenValid = tokenValid;
        if (!tokenValid) {
          issues.push("Token da API inválido ou expirado — mensagens serão aceitas mas NÃO entregues");
        }
      } catch (err: any) {
        issues.push(`Erro ao validar token: ${err.message}`);
        details.tokenValid = false;
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      details.totalPhones = phoneNumbers.length;
      details.phones = [];

      const phonesToCheck = phoneNumberId
        ? phoneNumbers.filter(p => p.id === phoneNumberId)
        : phoneNumbers;

      for (const phone of phonesToCheck) {
        try {
          const status = await metaAPI.getPhoneNumberStatus(phone.id, config.metaToken);
          const canSend = await metaAPI.canSendMessages(phone.id, config.metaToken);

          const phoneDetail: Record<string, any> = {
            id: phone.id,
            display: phone.display_phone_number,
            verifiedName: status.verified_name,
            qualityRating: status.quality_rating,
            tier: status.messaging_limit_tier,
            accountMode: status.account_mode,
            canSend: canSend.canSend,
            canSendReason: canSend.reason
          };
          details.phones.push(phoneDetail);

          const accountMode = String(status.account_mode);
          if (accountMode === 'SANDBOX' || accountMode === 'PENDING') {
            issues.push(`📱 ${phone.display_phone_number}: MODO ${accountMode} — mensagens só vão para números de teste registrados. Ative o modo LIVE no Meta Business Manager.`);
            phoneDetail.isSandbox = true;
          }

          if (accountMode === 'RESTRICTED') {
            issues.push(`📱 ${phone.display_phone_number}: RESTRICTED — limite diário atingido ou conta restrita.`);
          }

          if (status.quality_rating === 'RED') {
            warnings.push(`📱 ${phone.display_phone_number}: Quality Rating VERMELHO — risco de downgrade de tier.`);
          }

          if (!canSend.canSend) {
            issues.push(`📱 ${phone.display_phone_number}: Não pode enviar — ${canSend.reason}`);
          }

          const tier = status.messaging_limit_tier || 'UNKNOWN';
          phoneDetail.skipLabel = true;
          phoneDetail.tierInfo = `Tier ${tier} — skip-label ativo (sender_label: null)`;

        } catch (err: any) {
          warnings.push(`📱 ${phone.display_phone_number}: Erro ao verificar status — ${err.message}`);
        }
      }

      if (templateName) {
        try {
          const allTemplates = await getTemplates(config.metaToken, config.whatsappBusinessId);
          const template = allTemplates.find((t: any) => t.name === templateName);
          if (!template) {
            issues.push(`📝 Template "${templateName}" NÃO ENCONTRADO na WABA`);
            details.templateFound = false;
          } else {
            details.templateFound = true;
            details.templateStatus = template.status;
            details.templateCategory = template.category;
            details.templateLanguage = template.language;
            if (template.status === 'PAUSED') {
              issues.push(`📝 Template "${templateName}" está PAUSADO pela Meta — mensagens serão aceitas pela API mas NÃO entregues ao destinatário`);
            } else if (template.status === 'REJECTED') {
              issues.push(`📝 Template "${templateName}" foi REJEITADO — mensagens não serão entregues`);
            } else if (template.status !== 'APPROVED') {
              warnings.push(`📝 Template "${templateName}" está com status "${template.status}" — pode não ser entregue`);
            }
          }
        } catch (err: any) {
          warnings.push(`Erro ao verificar template: ${err.message}`);
        }
      }

      details.sendStrategy = {
        mode: 'skip-label',
        senderLabel: null,
        description: 'Usa display name verificado da WABA. Sem rotação de nomes. Rate limit padrão do tier.',
      };

      const ok = issues.length === 0;

      console.log(`\n🏥 AUDITORIA COMPLETA:`);
      console.log(`   OK: ${ok}`);
      console.log(`   Issues: ${issues.length}`);
      console.log(`   Warnings: ${warnings.length}`);
      if (issues.length > 0) console.log(`   ❌ ${issues.join('\n   ❌ ')}`);

      res.json({ ok, issues, warnings, details });
    } catch (error: any) {
      routeError('Erro na auditoria:', {}, error);
      res.status(500).json({
        ok: false,
        issues: [`Erro interno: ${error.message}`],
        warnings: [],
        details: {}
      });
    }
  });

  app.post("/api/campaigns/:id/start", async (req, res) => {
    try {
      const campaign = await getCampaignFromDbOrStorage(req.params.id);
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      // VALIDAÇÃO PRÉ-CAMPANHA: Verificar status dos phone numbers
      console.log(`🔍 PRÉ-VALIDAÇÃO: Verificando status dos phone numbers antes de iniciar campanha...`);
      
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ 
          error: "Configuração válida da API é obrigatória",
          canStart: false
        });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      
      const phoneStatusChecks = await Promise.all(
        phoneNumbers.map(async (phone) => {
          try {
            const canSend = await metaAPI.canSendMessages(phone.id, config.metaToken);
            return {
              phoneId: phone.id,
              displayPhone: phone.display_phone_number,
              canSend: canSend.canSend,
              reason: canSend.reason,
              status: canSend.status
            };
          } catch (error: any) {
            return {
              phoneId: phone.id,
              displayPhone: phone.display_phone_number,
              canSend: false,
              reason: `Erro ao verificar: ${error.message}`,
              status: null
            };
          }
        })
      );

      const blockedPhones = phoneStatusChecks.filter(p => !p.canSend);
      
      if (blockedPhones.length === phoneStatusChecks.length) {
        // TODOS os números bloqueados - NÃO PODE INICIAR
        console.error(`❌ CAMPANHA BLOQUEADA: TODOS os ${blockedPhones.length} phone numbers estão BLOQUEADOS`);
        
        return res.status(400).json({
          error: "Campanha não pode iniciar - todos os phone numbers estão bloqueados",
          canStart: false,
          blockedPhones: blockedPhones.map(p => ({
            phone: p.displayPhone,
            reason: p.reason,
            tier: p.status?.messaging_limit_tier,
            quality: p.status?.quality_rating,
            mode: p.status?.account_mode
          })),
          recommendations: [
            "🚫 URGENTE: Todos os números estão RESTRICTED ou com problemas",
            "1. Aguarde 24 horas para reset do limite diário",
            "2. OU delete e re-adicione os números no Meta Business Manager",
            "3. Verifique quality rating e melhore a qualidade das mensagens"
          ]
        });
      }
      
      if (blockedPhones.length > 0) {
        // ALGUNS números bloqueados - AVISO mas pode prosseguir
        console.warn(`⚠️ ATENÇÃO: ${blockedPhones.length}/${phoneStatusChecks.length} phone numbers estão bloqueados`);
        console.warn(`📊 Números disponíveis: ${phoneStatusChecks.length - blockedPhones.length}`);
      } else {
        console.log(`✅ PRÉ-VALIDAÇÃO OK: Todos os ${phoneStatusChecks.length} phone numbers podem enviar`);
      }

      await updateCampaignInDbAndStorage(req.params.id, {
        status: "running",
        startedAt: new Date(),
      });

      if (campaign.conversionMessage) {
        conversionTriggerService.registerCampaignConfig({
          campaignId: campaign.id,
          conversionMessage: campaign.conversionMessage,
          conversionLink: campaign.conversionLink || '',
          delayMs: campaign.conversionDelayMs || 0,
        });
        console.log(`🔗 Conversão pós-resposta ativada para campanha ${campaign.id} (delay=${campaign.conversionDelayMs || 0}ms)`);
      }

      // Warmup enforcement: enroll UNKNOWN/new numbers with conservative 250/day quota
      const selectedNums = (campaign.selectedNumbers as Array<{ phoneNumberId?: string; wabaId?: string }> | null) || [];
      if (selectedNums.length > 0) {
        const { upsertSenderWithWarmup } = await import("./services/engine/SenderPool");
        for (const sel of selectedNums) {
          if (sel.phoneNumberId && sel.wabaId) {
            try {
              await upsertSenderWithWarmup(sel.phoneNumberId, sel.wabaId);
            } catch (warmupErr: any) {
              console.warn(`[WarmupEnroll] Falha ao enrolar ${sel.phoneNumberId}: ${warmupErr.message}`);
            }
          }
        }
      }

      executeCampaign(req.params.id).catch(console.error);
      
      res.json({ 
        success: true,
        warnings: blockedPhones.length > 0 ? {
          blockedPhones: blockedPhones.length,
          availablePhones: phoneStatusChecks.length - blockedPhones.length,
          details: blockedPhones.map(p => `${p.displayPhone}: ${p.reason}`)
        } : undefined
      });
    } catch (error) {
      routeError('Error starting campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/campaigns/:id/pause", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const engine = activeUltraEngines.get(campaignId);
      
      if (engine && engine.isActive()) {
        engine.pauseCampaign();
        campaignStore.update(campaignId, { status: 'PAUSED', pauseActive: true });
        campaignStore.addLog(campaignId, 'INFO', 'Campanha pausada pelo usuário');
        
        const adapter = getOrCreateAdapter(campaignId);
        adapter.publishPause('Pausado pelo usuário', 0);
        adapter.publishStateChange('PAUSED', 'Pausado pelo usuário');
      }
      
      await updateCampaignInDbAndStorage(campaignId, { status: "paused" });
      res.json({ success: true, message: 'Campanha pausada' });
    } catch (error) {
      routeError('Error pausing campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/campaigns/:id/resume-live", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const engine = activeUltraEngines.get(campaignId);
      
      if (engine && engine.isActive()) {
        engine.resumeCampaign();
        campaignStore.update(campaignId, { status: 'RUNNING', pauseActive: false });
        campaignStore.addLog(campaignId, 'INFO', 'Campanha retomada pelo usuário');
        
        const adapter = getOrCreateAdapter(campaignId);
        adapter.publishResume(100);
        adapter.publishStateChange('RUNNING', 'Retomado pelo usuário');
        
        await updateCampaignInDbAndStorage(campaignId, { status: "running" });
        res.json({ success: true, message: 'Campanha retomada' });
      } else {
        res.status(400).json({ error: "Nenhum motor ativo encontrado para esta campanha" });
      }
    } catch (error) {
      routeError('Error resuming campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/campaigns/:id/stop", async (req, res) => {
    try {
      conversionTriggerService.removeCampaignConfig(req.params.id);

      await updateCampaignInDbAndStorage(req.params.id, { 
        status: "completed",
        completedAt: new Date(),
      });
      res.json({ success: true });
    } catch (error) {
      routeError('Error stopping campaign:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Dashboard stats
  app.get("/api/dashboard/stats", async (req, res) => {
    try {
      const dashLeadLists = await db.select().from(leadListsSchema).where(eq(leadListsSchema.userId, req.session.userId!));
      const campaigns = await db.select().from(campaignsSchema).where(eq(campaignsSchema.userId, req.session.userId!));
      const activeCampaigns = await db.select().from(campaignsSchema).where(and(eq(campaignsSchema.userId, req.session.userId!), eq(campaignsSchema.status, "running")));
      
      const totalLeads = dashLeadLists.reduce((sum, list) => sum + list.validLeads, 0);
      const messagesSent = campaigns.reduce((sum, campaign) => sum + (campaign.sentMessages || campaign.sentCount || 0), 0);
      const messagesFailed = campaigns.reduce((sum, campaign) => sum + (campaign.failedMessages || campaign.failedCount || 0), 0);
      const messagesSuccess = campaigns.reduce((sum, campaign) => sum + (campaign.successMessages || 0), 0);
      const totalMessages = campaigns.reduce((sum, campaign) => sum + (campaign.totalLeads || 0), 0);
      const deliveryRate = totalMessages > 0 ? ((messagesSuccess / totalMessages) * 100) : 0;
      
      res.json({
        totalLeads,
        messagesSent,
        messagesFailed,
        messagesSuccess,
        deliveryRate: Math.round(deliveryRate * 10) / 10,
        activeCampaigns: activeCampaigns.length,
        totalCampaigns: campaigns.length,
      });
    } catch (error) {
      routeError('Error getting dashboard stats:', {}, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============ DISPARO RÁPIDO (template neutro com link rotativo) ============
  app.post("/api/dispara", async (req, res) => {
    try {
      const { token, phoneID, to, nome = "cliente", modo = "template" } = req.body;

      if (!token || !phoneID || !to) {
        return res.status(400).json({
          ok: false,
          error: "Faltam token, phoneID ou número de destino.",
        });
      }

      disparoSeq++;
      const seq = disparoSeq;

      let componentes: any[];
      let logExtra: Record<string, any> = {};

      if (modo === "blacksky") {
        const txt3 = sorteia(TEXTOS3);
        const pre4 = sorteia(PREFIX4);
        const dom = proxDom();
        const path = novoPath();
        const link = `${dom}/${path}`;
        componentes = [
          {
            type: "body",
            parameters: [
              { type: "text", text: "438" },
              { type: "text", text: "equipe" },
              { type: "text", text: txt3 },
              { type: "text", text: pre4 + link },
            ],
          },
        ];
        logExtra = { dom, path };
      } else {
        componentes = [
          {
            type: "body",
            parameters: [
              { type: "text", text: "438" },
              { type: "text", text: nome },
              { type: "text", text: "Atualização de Cadastro" },
              { type: "text", text: "Clique aqui para verificar: https://receita.link/regularize" },
            ],
          },
        ];
      }

      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name: "atualiza_cad_v2",
          language: { code: "pt_BR" },
          components: componentes,
        },
      };

      const url = `https://graph.facebook.com/${META_API_VERSION}/${phoneID}/messages`;
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }).then(async (r) => {
        if (!r.ok) {
          const errData = await r.json().catch(() => ({}));
          throw new Error(errData?.error?.message || `HTTP ${r.status}`);
        }
      });

      const log = { seq, to, modo, ok: true, ...logExtra };
      console.log(`Disparo #${seq} [${modo}] -> ${to}${logExtra.dom ? ` via ${logExtra.dom}/${logExtra.path}` : ""}`);
      res.json(log);
    } catch (e: any) {
      routeError("routes.disparo", { seq: disparoSeq }, e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/disparo-config", (_req, res) => {
    res.json({
      textos3: TEXTOS3,
      prefix4: PREFIX4,
      doms: DOMS,
      domAtual: DOMS[domIdx],
      seq: disparoSeq,
      enviosNoDom,
      pathsUsados: usedPaths.size,
      rotacaoACada: ROTACAO_A_CADA,
      maxPathCache: MAX_PATH_CACHE,
    });
  });

  // ============================================================================
  // SENDER POOL ROUTES
  // ============================================================================

  app.get("/api/senders", async (req, res) => {
    try {
      const { getAllSenders } = await import("./services/engine/SenderPool");
      const senders = await getAllSenders();
      res.json(senders);
    } catch (error: any) {
      routeError('Error fetching senders:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/senders/available", async (req, res) => {
    try {
      const { getAvailableSenders } = await import("./services/engine/SenderPool");
      const senders = await getAvailableSenders();
      res.json(senders);
    } catch (error: any) {
      routeError('Error fetching available senders:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  const addSenderWithWabaSchema = z.object({
    phoneNumberId: z.string().min(1, "phoneNumberId é obrigatório"),
    wabaId: z.string().optional(),
    dailyQuota: z.number().int().min(100).max(50000).optional().default(7200),
  });

  app.post("/api/senders", async (req, res) => {
    try {
      const parsed = addSenderWithWabaSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { phoneNumberId, wabaId, dailyQuota } = parsed.data;

      if (wabaId) {
        const { upsertSenderWithWarmup } = await import("./services/engine/SenderPool");
        const result = await upsertSenderWithWarmup(phoneNumberId, wabaId, dailyQuota);
        res.json({ success: true, phoneNumberId, ...result });
      } else {
        const { upsertSender } = await import("./services/engine/SenderPool");
        await upsertSender(phoneNumberId, dailyQuota);
        res.json({ success: true, phoneNumberId, effectiveQuota: dailyQuota, warmupActive: false });
      }
    } catch (error: any) {
      routeError('Error adding sender:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/senders/:phoneNumberId", async (req, res) => {
    try {
      const { removeSender } = await import("./services/engine/SenderPool");
      await removeSender(req.params.phoneNumberId);
      res.json({ success: true });
    } catch (error: any) {
      routeError('Error removing sender:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/senders/reset", async (req, res) => {
    try {
      const { resetDaily } = await import("./services/engine/SenderPool");
      await resetDaily();
      res.json({ success: true, message: "Todos os contadores foram resetados" });
    } catch (error: any) {
      routeError('Error resetting senders:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/senders/:phoneNumberId", async (req, res) => {
    try {
      const { getSenderStatus } = await import("./services/engine/SenderPool");
      const sender = await getSenderStatus(req.params.phoneNumberId);
      if (!sender) {
        return res.status(404).json({ error: "Sender não encontrado" });
      }
      res.json(sender);
    } catch (error: any) {
      routeError('Error fetching sender status:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  const seedSenderSchema = z.object({
    phoneIds: z.array(z.string().min(1)).optional(),
    dailyQuota: z.number().int().min(100).max(50000).optional().default(7200),
  });

  app.post("/api/senders/seed", async (req, res) => {
    try {
      const parsed = seedSenderSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0].message });
      }
      const { dailyQuota } = parsed.data;
      const ids = parsed.data.phoneIds || (process.env.PHONE_IDS ? process.env.PHONE_IDS.split(',').map((s: string) => s.trim()) : []);
      
      if (!ids.length) {
        return res.status(400).json({ error: "Nenhum phoneId fornecido. Envie no body como phoneIds ou defina PHONE_IDS env var." });
      }

      const { upsertSender } = await import("./services/engine/SenderPool");
      for (const id of ids) {
        await upsertSender(id, dailyQuota);
      }
      res.json({ success: true, seeded: ids.length, phoneIds: ids });
    } catch (error: any) {
      routeError('Error seeding senders:', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Opt-Out Management ──────────────────────────────────────────────────────

  app.get("/api/opt-out", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;
      const result = await OptOutService.getOptOutList(limit, offset);
      res.json(result);
    } catch (error: any) {
      routeError('getOptOut', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/opt-out/stats", async (_req, res) => {
    try {
      const stats = await OptOutService.getOptOutStats();
      res.json(stats);
    } catch (error: any) {
      routeError('getOptOutStats', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/opt-out", async (req, res) => {
    try {
      const { phone, reason } = req.body;
      if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
      const added = await OptOutService.addOptOut(phone, reason || "manual");
      res.json({ success: added, phone });
    } catch (error: any) {
      routeError('postOptOut', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/opt-out/bulk", async (req, res) => {
    try {
      const { phones, reason } = req.body;
      if (!phones || !Array.isArray(phones)) return res.status(400).json({ error: "phones array é obrigatório" });
      let added = 0;
      for (const phone of phones) {
        const ok = await OptOutService.addOptOut(phone, reason || "manual_bulk");
        if (ok) added++;
      }
      res.json({ success: true, added, total: phones.length });
    } catch (error: any) {
      routeError('postOptOutBulk', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/opt-out/:phone", async (req, res) => {
    try {
      const removed = await OptOutService.removeOptOut(req.params.phone);
      res.json({ success: removed });
    } catch (error: any) {
      routeError('deleteOptOut', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/opt-out/clear", async (_req, res) => {
    try {
      const count = await OptOutService.clearOptOutList();
      res.json({ success: true, cleared: count });
    } catch (error: any) {
      routeError('postOptOutClear', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/opt-out/check", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
      const isOptedOut = await OptOutService.isOptedOut(phone);
      res.json({ phone, isOptedOut });
    } catch (error: any) {
      routeError('postOptOutCheck', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Warmup Management ─────────────────────────────────────────────────────

  app.get("/api/warmup", async (_req, res) => {
    try {
      const schedules = await WarmupScheduler.getAllSchedules();
      res.json({ schedules, progression: WarmupScheduler.getProgression() });
    } catch (error: any) {
      routeError('getWarmupList', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/enroll", async (req, res) => {
    try {
      const { phoneNumberId, displayNumber, targetDayLimit } = req.body;
      if (!phoneNumberId) return res.status(400).json({ error: "phoneNumberId é obrigatório" });
      const status = await WarmupScheduler.enrollNumber(phoneNumberId, displayNumber, targetDayLimit || 1000);
      res.json(status);
    } catch (error: any) {
      routeError('postWarmupEnroll', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/warmup/:phoneNumberId", async (req, res) => {
    try {
      const status = await WarmupScheduler.getStatus(req.params.phoneNumberId);
      if (!status) return res.status(404).json({ error: "Número não encontrado no aquecimento" });
      res.json(status);
    } catch (error: any) {
      routeError('getWarmupStatus', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/advance-day", async (_req, res) => {
    try {
      const advanced = await WarmupScheduler.advanceDay();
      res.json({ success: true, advanced });
    } catch (error: any) {
      routeError('postWarmupAdvanceDay', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/reset-daily", async (_req, res) => {
    try {
      await WarmupScheduler.resetDailyCounts();
      res.json({ success: true });
    } catch (error: any) {
      routeError('postWarmupResetDaily', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/warmup/:phoneNumberId", async (req, res) => {
    try {
      await WarmupScheduler.removeNumber(req.params.phoneNumberId);
      res.json({ success: true });
    } catch (error: any) {
      routeError('deleteWarmup', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Engagement / Follow-Up Management ──────────────────────────────────────

  app.post("/api/follow-up/rules", async (req, res) => {
    try {
      const { campaignId, stages } = req.body;
      if (!campaignId || !stages || !Array.isArray(stages)) {
        return res.status(400).json({ error: "campaignId e stages são obrigatórios" });
      }
      const rules = await EngagementManager.createFollowUpRules({ campaignId, stages });
      res.json({ success: true, rules });
    } catch (error: any) {
      routeError('postFollowUpRules', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/follow-up/:campaignId/rules", async (req, res) => {
    try {
      const rules = await EngagementManager.getRulesForCampaign(req.params.campaignId);
      res.json(rules);
    } catch (error: any) {
      routeError('getFollowUpRules', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/follow-up/:campaignId/stats", async (req, res) => {
    try {
      const stats = await EngagementManager.getFollowUpStats(req.params.campaignId);
      res.json(stats);
    } catch (error: any) {
      routeError('getFollowUpStats', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/follow-up/:campaignId/pending", async (req, res) => {
    try {
      const pending = await EngagementManager.getPendingFollowUps(req.params.campaignId);
      res.json({ pending, count: pending.length });
    } catch (error: any) {
      routeError('getFollowUpPending', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/follow-up/:campaignId/initialize", async (req, res) => {
    try {
      const { phones } = req.body;
      if (!phones || !Array.isArray(phones)) {
        return res.status(400).json({ error: "phones array é obrigatório" });
      }
      const initialized = await EngagementManager.initializeLeadFollowUp(req.params.campaignId, phones);
      res.json({ success: true, initialized });
    } catch (error: any) {
      routeError('postFollowUpInitialize', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/follow-up/:campaignId/advance", async (req, res) => {
    try {
      const { phone, stage } = req.body;
      if (!phone || stage === undefined) {
        return res.status(400).json({ error: "phone e stage são obrigatórios" });
      }
      await EngagementManager.advanceFollowUp(req.params.campaignId, phone, stage);
      res.json({ success: true });
    } catch (error: any) {
      routeError('postApiFollowupAdvance', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/follow-up/:campaignId/mark-replied", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: "phone é obrigatório" });
      await EngagementManager.markReplied(req.params.campaignId, phone);
      res.json({ success: true });
    } catch (error: any) {
      routeError('postApiFollowupMarkreplied', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/follow-up/:campaignId", async (req, res) => {
    try {
      await EngagementManager.deleteRulesForCampaign(req.params.campaignId);
      res.json({ success: true });
    } catch (error: any) {
      routeError('deleteApiFollowup', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── WABA Management ────────────────────────────────────────────────────────

  const chatSSEClients = new Map<string, Set<Response>>();

  app.get("/api/wabas", async (req, res) => {
    try {
      const wabasList = await wabaStorage.getWabasByUser(req.session.userId!);
      const safe = wabasList.map(({ accessToken, ...rest }) => ({ ...rest, hasToken: !!accessToken }));
      res.json(safe);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabas', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/wabas/checklist", async (req, res) => {
    try {
      const userId = req.session.userId!;
      const [config] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, userId));
      const wabasList = await db.select().from(wabasSchema).where(eq(wabasSchema.userId, userId));

      const wabaConnected = !!(config && config.isValid);
      const tokenValid = !!(config && config.metaToken && config.metaToken.trim() !== '');
      const appSecretPresent = !!(config && config.appSecret && config.appSecret.trim() !== '');

      let subscribedApps = false;
      let webhookReceived = false;
      let lastWebhookAt: string | null = null;
      let subscribedAppsAt: string | null = null;

      if (wabasList.length > 0) {
        const relevantWaba = config?.whatsappBusinessId
          ? (wabasList.find(w => w.wabaId === config.whatsappBusinessId) || wabasList[0])
          : wabasList[0];

        subscribedApps = !!(relevantWaba.subscribedAppsAt && relevantWaba.subscribedAppsStatus === 'success');
        subscribedAppsAt = relevantWaba.subscribedAppsAt ? relevantWaba.subscribedAppsAt.toISOString() : null;
        webhookReceived = !!relevantWaba.lastWebhookReceivedAt;
        lastWebhookAt = relevantWaba.lastWebhookReceivedAt ? relevantWaba.lastWebhookReceivedAt.toISOString() : null;
      }

      const allOk = wabaConnected && tokenValid && appSecretPresent && subscribedApps && webhookReceived;

      res.json({
        allOk,
        items: {
          wabaConnected,
          tokenValid,
          appSecretPresent,
          subscribedApps,
          webhookReceived,
        },
        metadata: {
          lastWebhookAt,
          subscribedAppsAt,
          wabaCount: wabasList.length,
        },
      });
    } catch (error: unknown) {
      routeError('getWabasChecklist', {}, error);
      res.status(500).json({ error: "Erro ao buscar checklist" });
    }
  });

  const webhookTestSessions = new Map<string, { startedAt: number; received: boolean; receivedAt?: number }>();

  app.post("/api/webhook/start-reception-test", async (req, res) => {
    try {
      const userId = req.session.userId!;
      webhookTestSessions.set(userId, { startedAt: Date.now(), received: false });
      res.json({ ok: true, expiresIn: 60 });
    } catch (error: unknown) {
      routeError('postStartWebhookReceptionTest', {}, error);
      res.status(500).json({ error: "Erro ao iniciar teste" });
    }
  });

  app.get("/api/webhook/reception-test-status", async (req, res) => {
    try {
      const userId = req.session.userId!;
      const session = webhookTestSessions.get(userId);
      if (!session) {
        return res.json({ status: 'not_started' });
      }
      const elapsed = Date.now() - session.startedAt;
      if (session.received) {
        console.log(`[WEBHOOK_TEST_SUCCESS] userId=${userId} receivedAt=${new Date(session.receivedAt!).toISOString()}`);
        webhookTestSessions.delete(userId);
        return res.json({ status: 'success', receivedAt: new Date(session.receivedAt!).toISOString() });
      }
      if (elapsed > 60000) {
        console.log(`[WEBHOOK_TEST_FAILED] userId=${userId} elapsed=${elapsed}ms`);
        webhookTestSessions.delete(userId);
        return res.json({ status: 'timeout' });
      }
      return res.json({ status: 'waiting', elapsed, remaining: 60000 - elapsed });
    } catch (error: unknown) {
      routeError('getWebhookReceptionTestStatus', {}, error);
      res.status(500).json({ error: "Erro ao verificar status" });
    }
  });

  app.get("/api/wabas/app-configs", async (req, res) => {
    try {
      const wabasList = await wabaStorage.getWabasByUser(req.session.userId!);
      const groupMap = new Map<string, {
        bmId: string | null;
        accessToken: string;
        appSecret: string | null;
        wabaCount: number;
        label: string;
        wabaIds: string[];
      }>();

      for (const waba of wabasList) {
        const key = `${waba.bmId || ""}::${waba.accessToken}`;
        if (groupMap.has(key)) {
          const existing = groupMap.get(key)!;
          existing.wabaCount += 1;
          existing.wabaIds.push(waba.wabaId);
          if (!existing.appSecret && waba.appSecret) existing.appSecret = waba.appSecret;
        } else {
          groupMap.set(key, {
            bmId: waba.bmId || null,
            accessToken: waba.accessToken,
            appSecret: waba.appSecret || null,
            wabaCount: 1,
            label: waba.bmId ? `BM ${waba.bmId}` : waba.name,
            wabaIds: [waba.wabaId],
          });
        }
      }

      const configs = Array.from(groupMap.values()).map(({ accessToken, ...rest }) => ({
        ...rest,
        hasToken: true,
        tokenPreview: accessToken.length > 8 ? `${accessToken.slice(0, 6)}...${accessToken.slice(-4)}` : "****",
        _accessToken: accessToken,
      }));

      res.json(configs);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabasAppConfigs', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/wabas", async (req, res) => {
    try {
      const { name, wabaId, bmId, accessToken, appSecret } = req.body;
      if (!name || !wabaId || !accessToken) {
        return res.status(400).json({ error: "name, wabaId e accessToken são obrigatórios" });
      }
      let effectiveAppSecret = appSecret;
      if (!effectiveAppSecret) {
        try {
          const [userConfig] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, req.session.userId!));
          if (userConfig?.appSecret) {
            effectiveAppSecret = userConfig.appSecret;
            console.log(`[WABA] Inherited appSecret from api_configurations for new WABA ${wabaId}`);
          }
        } catch (e: any) {
          console.warn(`[WABA] Failed to inherit appSecret: ${e.message}`);
        }
      }
      const waba = await wabaStorage.createWaba({ userId: req.session.userId!, name, wabaId, bmId, accessToken, appSecret: effectiveAppSecret });
      let subscription: { success: boolean; error?: string; at?: string };
      try {
        await subscribeWabaToApp(waba.wabaId, accessToken);
        const now = new Date();
        console.log(`[WABA_SUBSCRIBED_SUCCESS] wabaId=${waba.wabaId} subscribed on POST /api/wabas`);
        await wabaStorage.updateWaba(waba.id, { subscribedAppsStatus: 'success', subscribedAppsAt: now });
        subscription = { success: true, at: now.toISOString() };
      } catch (err: any) {
        routeError('postApiWabas.subscribe', { wabaId: waba.wabaId }, err);
        await wabaStorage.updateWaba(waba.id, { subscribedAppsStatus: `failed: ${err.message}`.slice(0, 200) }).catch(() => {});
        subscription = { success: false, error: err.message };
      }
      res.json({ ...waba, subscription, subscriptionError: subscription.success ? undefined : subscription.error });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiWabas', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.patch("/api/wabas/:id", async (req, res) => {
    try {
      const existing = await wabaStorage.getWabaById(req.params.id);
      if (!existing) return res.status(404).json({ error: "WABA não encontrada" });
      if (existing.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      const { name } = req.body;
      const updateData: Record<string, any> = { ...req.body };
      if (typeof name === "string" && !name.trim()) {
        updateData.name = existing.wabaId;
      }
      const waba = await wabaStorage.updateWaba(req.params.id, updateData);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      const effectiveToken = updateData.accessToken || existing.accessToken;
      let subscription: { success: boolean; error?: string; at?: string };
      try {
        await subscribeWabaToApp(waba.wabaId, effectiveToken);
        const now = new Date();
        console.log(`[WABA_SUBSCRIBED_SUCCESS] wabaId=${waba.wabaId} subscribed on PATCH /api/wabas/:id`);
        await wabaStorage.updateWaba(waba.id, { subscribedAppsStatus: 'success', subscribedAppsAt: now });
        subscription = { success: true, at: now.toISOString() };
      } catch (err: any) {
        routeError('patchApiWabas.subscribe', { wabaId: waba.wabaId }, err);
        await wabaStorage.updateWaba(waba.id, { subscribedAppsStatus: `failed: ${err.message}`.slice(0, 200) }).catch(() => {});
        subscription = { success: false, error: err.message };
      }
      res.json({ ...waba, subscription, subscriptionError: subscription.success ? undefined : subscription.error });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('patchApiWabas', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/wabas/:id", async (req, res) => {
    try {
      await wabaStorage.deleteWaba(req.params.id);
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('deleteApiWabas', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/wabas/:id/test", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.id);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });

      const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${waba.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
        { headers: { Authorization: `Bearer ${waba.accessToken}` } }
      );
      const data = await response.json() as { error?: { message: string }; data?: Array<{ id: string; display_phone_number: string; verified_name: string; quality_rating: string }> };

      if (data.error) {
        return res.json({ success: false, error: data.error.message });
      }

      const phones = data.data || [];
      for (const phone of phones) {
        await wabaStorage.upsertWabaNumber({
          wabaId: waba.id,
          phoneNumberId: phone.id,
          displayNumber: phone.display_phone_number,
          verifiedName: phone.verified_name,
          qualityRating: phone.quality_rating,
        });
      }

      await wabaStorage.updateWaba(waba.id, { isActive: true });
      res.json({ success: true, phoneCount: phones.length, phones });
    } catch (error: unknown) {
      routeError('postWabaTest', {}, error);
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      res.json({ success: false, error: message });
    }
  });

  app.post("/api/wabas/:id/subscribe", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.id);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      try {
        const subscribeResult = await subscribeWabaToApp(waba.wabaId, waba.accessToken);
        console.log(`[WABA_SUBSCRIBED_SUCCESS] wabaId=${waba.wabaId} subscribed via /api/wabas/:id/subscribe`);
        await wabaStorage.updateWaba(waba.id, { subscribedAppsStatus: 'success', subscribedAppsAt: new Date() });
        res.json({ success: true, wabaId: waba.wabaId, result: subscribeResult });
      } catch (subErr: any) {
        console.error(`[WABA_SUBSCRIBE_FAILED] wabaId=${waba.wabaId} error=${subErr.message}`);
        await wabaStorage.updateWaba(waba.id, { subscribedAppsStatus: `failed: ${subErr.message}`.slice(0, 200) }).catch(() => {});
        res.status(500).json({ success: false, error: subErr.message });
      }
    } catch (error: unknown) {
      routeError('postWabaSubscribe', { id: req.params.id }, error);
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      res.status(500).json({ success: false, error: message });
    }
  });

  app.get("/api/wabas/:wabaId/numbers", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      let numbers = await wabaStorage.getWabaNumbers(req.params.wabaId);
      if (numbers.length === 0 && waba.accessToken && waba.wabaId) {
        try {
          const syncResp = await fetch(
            `https://graph.facebook.com/${META_API_VERSION}/${waba.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
            { headers: { Authorization: `Bearer ${waba.accessToken}` } }
          );
          const syncData = await syncResp.json() as { data?: Array<{ id: string; display_phone_number: string; verified_name: string; quality_rating: string }> };
          const phones = syncData.data || [];
          for (const phone of phones) {
            await wabaStorage.upsertWabaNumber({
              wabaId: waba.id,
              phoneNumberId: phone.id,
              displayNumber: phone.display_phone_number,
              verifiedName: phone.verified_name,
              qualityRating: phone.quality_rating,
            });
          }
          if (phones.length > 0) {
            numbers = await wabaStorage.getWabaNumbers(req.params.wabaId);
          }
        } catch (syncErr) {
          routeError('getApiWabasNumbers.autoSync', { wabaId: req.params.wabaId }, syncErr);
        }
      }
      res.json(numbers);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabasNumbers', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/wabas/:wabaId/metrics", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      const metrics = await wabaStorage.getWabaMetrics(req.params.wabaId);
      res.json(metrics);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabasMetrics', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/wabas/:wabaId/templates", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });

      const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${waba.wabaId}/message_templates?limit=100`,
        { headers: { Authorization: `Bearer ${waba.accessToken}` } }
      );
      const result = await response.json() as { data?: Array<{ id: string; name: string; language: string; category: string; status: string; components: unknown }> };
      const metaTemplates = result.data || [];

      if (metaTemplates.length > 0) {
        const userId = req.session.userId!;
        try {
          for (const tpl of metaTemplates) {
            const [existing] = await db.select().from(templatesSchema)
              .where(and(
                eq(templatesSchema.templateId, tpl.id),
                eq(templatesSchema.userId, userId)
              ));

            if (existing) {
              await db.update(templatesSchema).set({
                name: tpl.name,
                language: tpl.language,
                category: tpl.category,
                status: tpl.status,
                components: tpl.components,
                wabaId: req.params.wabaId,
                lastSynced: new Date(),
              }).where(eq(templatesSchema.id, existing.id));
            } else {
              await db.insert(templatesSchema).values({
                userId,
                templateId: tpl.id,
                name: tpl.name,
                language: tpl.language,
                category: tpl.category,
                status: tpl.status,
                components: tpl.components,
                wabaId: req.params.wabaId,
                lastSynced: new Date(),
              });
            }
          }
          console.log(`[WABA Templates] Synced ${metaTemplates.length} templates to DB for user ${userId}, wabaId ${req.params.wabaId}`);
        } catch (syncErr) {
          routeError("routes.wabaTemplateSyncToDB", { wabaId: req.params.wabaId }, syncErr);
        }
      }

      res.json(metaTemplates);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabasTemplates', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/wabas/:wabaId/phone-numbers", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });

      const numbers = await wabaStorage.getWabaNumbers(req.params.wabaId);
      res.json(numbers);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabasPhonenumbers', {}, error);
      res.status(500).json({ error: message });
    }
  });

  // ─── Conversations & Messages ─────────────────────────────────────────────

  app.get("/api/wabas/:wabaId/conversations", async (req, res) => {
    try {
      const waba = await wabaStorage.getWabaById(req.params.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const search = req.query.search as string | undefined;
      const campaignId = req.query.campaignId as string | undefined;

      let result;
      if (campaignId) {
        const campaignConvos = await wabaStorage.getConversationsByCampaign(campaignId, { search, limit, offset });
        campaignConvos.data = campaignConvos.data.filter((c: any) => c.wabaId === req.params.wabaId);
        campaignConvos.total = campaignConvos.data.length;
        result = campaignConvos;
      } else {
        result = await wabaStorage.getConversations(req.params.wabaId, { search, limit, offset });
      }
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiWabasConversations', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/conversations/:conversationId/messages", async (req, res) => {
    try {
      const convo = await wabaStorage.getConversation(req.params.conversationId);
      if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
      const waba = await wabaStorage.getWabaById(convo.wabaId);
      if (!waba || waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      const msgs = await wabaStorage.getMessages(req.params.conversationId);
      res.json(msgs);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiConversationsMessages', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/media/:mediaId", async (req, res) => {
    try {
      const { mediaId } = req.params;
      if (!mediaId) return res.status(400).json({ error: "mediaId é obrigatório" });

      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ error: "Autenticação necessária" });

      const userWabas = await wabaStorage.getWabasByUser(userId);
      if (userWabas.length === 0) return res.status(404).json({ error: "Nenhuma WABA configurada" });

      let lastError: string = "";
      for (const waba of userWabas) {
        try {
          const axios = (await import("axios")).default;
          const metaUrlRes = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/${mediaId}`, {
            headers: { Authorization: `Bearer ${waba.accessToken}` },
          });
          const downloadUrl = metaUrlRes.data?.url;
          if (!downloadUrl) continue;

          const mediaRes = await axios.get(downloadUrl, {
            headers: { Authorization: `Bearer ${waba.accessToken}` },
            responseType: "stream",
          });

          const contentType = mediaRes.headers["content-type"];
          if (contentType) res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "public, max-age=86400");
          mediaRes.data.pipe(res);
          return;
        } catch (err: any) {
          lastError = err?.response?.data?.error?.message || err.message || "Erro desconhecido";
        }
      }

      routeError('getApiMedia', {}, lastError);
      res.status(404).json({ error: `Mídia não encontrada: ${lastError}` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiMedia', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/conversations/:conversationId/reply", async (req, res) => {
    try {
      const convo = await wabaStorage.getConversation(req.params.conversationId);
      if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
      const ownerWaba = await wabaStorage.getWabaById(convo.wabaId);
      if (!ownerWaba || ownerWaba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });

      if (convo.cswExpiresAt && new Date(convo.cswExpiresAt) < new Date()) {
        return res.status(403).json({ error: "Janela de atendimento (CSW) expirada. Use 'Enviar Template'." });
      }

      const waba = await wabaStorage.getWabaById(convo.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });

      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      if (numbers.length === 0) return res.status(400).json({ error: "Nenhum número associado à WABA" });

      let phoneNumberId = numbers[0].phoneNumberId;
      if (convo.phoneNumberId) {
        const matchedNumber = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
        if (matchedNumber) {
          phoneNumberId = matchedNumber.phoneNumberId;
        }
      }
      const { text: messageText } = req.body;
      if (!messageText) return res.status(400).json({ error: "Texto da mensagem é obrigatório" });

      const digits = convo.contactPhone.replace(/\D/g, "");

      const apiData = await metaAPI.sendFreeFormMessage(phoneNumberId, digits, messageText, waba.accessToken);
      const metaMessageId = apiData?.messages?.[0]?.id;

      const msg = await wabaStorage.createMessage({
        conversationId: convo.id,
        direction: "outbound",
        body: messageText,
        type: "text",
        metaMessageId: metaMessageId || undefined,
        status: metaMessageId ? "sent" : "failed",
      });

      await wabaStorage.updateConversation(convo.id, {
        lastMessageAt: new Date(),
        lastMessagePreview: messageText.substring(0, 100),
      });

      const clients = chatSSEClients.get(convo.wabaId);
      if (clients) {
        const eventData = JSON.stringify({ type: "new_message", conversationId: convo.id, message: msg });
        clients.forEach((client) => client.write(`data: ${eventData}\n\n`));
      }

      res.json(msg);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiConversationsReply', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/conversations/:conversationId/send-image", chatMediaUpload.single("image"), async (req, res) => {
    try {
      const convo = await wabaStorage.getConversation(req.params.conversationId);
      if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
      const waba = await wabaStorage.getWabaById(convo.wabaId);
      if (!waba || waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      if (convo.cswExpiresAt && new Date(convo.cswExpiresAt) < new Date()) {
        return res.status(403).json({ error: "Janela de atendimento (CSW) expirada." });
      }
      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      if (numbers.length === 0) return res.status(400).json({ error: "Nenhum número associado à WABA" });

      const caption = req.body.caption || "";
      let imageUrl = req.body.imageUrl || "";
      if (req.file) {
        const publicDomain = getPublicDomain();
        imageUrl = `${publicDomain}/uploads/chat-media/${req.file.filename}`;
      }
      if (!imageUrl) return res.status(400).json({ error: "Imagem é obrigatória" });

      let resolvedPhoneNumberId = numbers[0].phoneNumberId;
      if (convo.phoneNumberId) {
        const matched = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
        if (matched) resolvedPhoneNumberId = matched.phoneNumberId;
      }
      const digits = convo.contactPhone.replace(/\D/g, "");
      const apiData = await metaAPI.sendImageMessage(resolvedPhoneNumberId, digits, imageUrl, caption || undefined, waba.accessToken);
      const metaMessageId = apiData?.messages?.[0]?.id;

      const msg = await wabaStorage.createMessage({
        conversationId: convo.id,
        direction: "outbound",
        body: caption || "[Imagem]",
        type: "image",
        mediaUrl: imageUrl,
        metaMessageId: metaMessageId || undefined,
        status: metaMessageId ? "sent" : "failed",
      });

      await wabaStorage.updateConversation(convo.id, {
        lastMessageAt: new Date(),
        lastMessagePreview: caption || "[Imagem]",
      });

      const clients = chatSSEClients.get(convo.wabaId);
      if (clients) {
        const eventData = JSON.stringify({ type: "new_message", conversationId: convo.id, message: msg });
        clients.forEach((client) => client.write(`data: ${eventData}\n\n`));
      }

      res.json(msg);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiConversationsSendimage', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/conversations/:conversationId/send-audio", chatMediaUpload.single("audio"), async (req, res) => {
    try {
      const convo = await wabaStorage.getConversation(req.params.conversationId);
      if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
      const waba = await wabaStorage.getWabaById(convo.wabaId);
      if (!waba || waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      if (convo.cswExpiresAt && new Date(convo.cswExpiresAt) < new Date()) {
        return res.status(403).json({ error: "Janela de atendimento (CSW) expirada." });
      }
      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      if (numbers.length === 0) return res.status(400).json({ error: "Nenhum número associado à WABA" });

      let resolvedAudioPhoneNumberId = numbers[0].phoneNumberId;
      if (convo.phoneNumberId) {
        const matched = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
        if (matched) resolvedAudioPhoneNumberId = matched.phoneNumberId;
      }
      const digits = convo.contactPhone.replace(/\D/g, "");

      let metaMessageId: string | undefined;
      let audioUrl = req.body.audioUrl || "";

      if (req.file) {
        const rawBuffer = await fs.promises.readFile(req.file.path);
        const detectedFormat = detectAudioFormat(rawBuffer);
        const ext = path.extname(req.file.originalname).toLowerCase() || path.extname(req.file.filename).toLowerCase();

        console.log(`[send-audio] file upload: ext=${ext} detectedFormat=${detectedFormat} phoneNumberId=${resolvedAudioPhoneNumberId}`);

        let fileBuffer: Buffer;
        let mimeType: string;
        let filename: string;

        if (detectedFormat === 'ogg') {
          fileBuffer = rawBuffer;
          mimeType = 'audio/ogg';
          const rawFilename = req.file.originalname || req.file.filename;
          filename = rawFilename.replace(/\.[^.]+$/, '') + '.ogg';
        } else {
          const ffmpegAvailable = await isFfmpegAvailable();
          if (!ffmpegAvailable) {
            return res.status(400).json({ error: "Formato de áudio inválido. Envie um arquivo OGG, OPUS ou WAV." });
          }
          console.log(`[send-audio] converting ${detectedFormat} to OGG/Opus via ffmpeg`);
          try {
            fileBuffer = await convertToOgg(req.file.path);
          } catch (convErr) {
            console.error(`[send-audio] ffmpeg conversion failed for ${detectedFormat}:`, convErr instanceof Error ? convErr.message : convErr);
            return res.status(400).json({ error: "Formato de áudio inválido. Envie um arquivo OGG, OPUS ou WAV." });
          }
          mimeType = 'audio/ogg';
          filename = (req.file.originalname || req.file.filename).replace(/\.[^.]+$/, '') + '.ogg';
        }

        console.log(`[send-audio] uploading to Meta: mimeType=${mimeType} filename=${filename}`);

        const mediaId = await metaAPI.uploadMediaToMeta(
          resolvedAudioPhoneNumberId, fileBuffer, mimeType, filename, waba.accessToken
        );
        console.log(`[send-audio] media uploaded to Meta: mediaId=${mediaId}`);
        const apiData = await metaAPI.sendVoiceNoteMessage(resolvedAudioPhoneNumberId, digits, mediaId, waba.accessToken);
        metaMessageId = apiData?.messages?.[0]?.id;
        console.log(`[send-audio] voice note sent: metaMessageId=${metaMessageId}`);

        const publicDomain = getPublicDomain();
        audioUrl = `${publicDomain}/uploads/chat-media/${req.file.filename}`;
      } else if (audioUrl) {
        const { buffer: urlBuffer, mimeType: rawMime, filename: urlFilename } = await fetchAudioBuffer(audioUrl);
        const urlDetectedFormat = detectAudioFormat(urlBuffer);
        const isOggByMagicUrl = urlDetectedFormat === 'ogg';

        let urlFinalBuffer: Buffer;
        let urlMime: string;
        let safeUrlFilename: string;

        if (isOggByMagicUrl) {
          urlFinalBuffer = urlBuffer;
          urlMime = 'audio/ogg';
          safeUrlFilename = urlFilename.replace(/\.(opus|oga)$/i, '.ogg');
        } else {
          const ffmpegAvailUrl = await isFfmpegAvailable();
          if (ffmpegAvailUrl) {
            console.log(`[send-audio] url: convertendo ${urlDetectedFormat} para OGG/Opus via ffmpeg`);
            const tmpUrlPath = path.join(__dirname_routes, '../uploads', `send_audio_url_tmp_${Date.now()}_${Math.floor(Math.random() * 99999)}.audio`);
            urlFinalBuffer = await convertBufferToOgg(urlBuffer, tmpUrlPath);
            urlMime = 'audio/ogg';
            safeUrlFilename = urlFilename.replace(/\.[^.]+$/, '') + '.ogg';
          } else {
            console.warn(`[send-audio] url: ffmpeg indisponível — enviando áudio no formato original (${urlDetectedFormat})`);
            urlFinalBuffer = urlBuffer;
            urlMime = rawMime;
            safeUrlFilename = urlFilename;
          }
        }

        console.log(`[send-audio] url upload: urlFilename=${safeUrlFilename} urlMime=${urlMime} detectedFormat=${urlDetectedFormat} phoneNumberId=${resolvedAudioPhoneNumberId}`);

        const mediaId = await metaAPI.uploadMediaToMeta(
          resolvedAudioPhoneNumberId, urlFinalBuffer, urlMime, safeUrlFilename, waba.accessToken
        );
        console.log(`[send-audio] media uploaded to Meta from url: mediaId=${mediaId}`);
        const apiData = await metaAPI.sendVoiceNoteMessage(resolvedAudioPhoneNumberId, digits, mediaId, waba.accessToken);
        metaMessageId = apiData?.messages?.[0]?.id;
        console.log(`[send-audio] voice note sent from url: metaMessageId=${metaMessageId}`);
      } else {
        return res.status(400).json({ error: "Áudio é obrigatório" });
      }

      const msg = await wabaStorage.createMessage({
        conversationId: convo.id,
        direction: "outbound",
        body: "[Áudio]",
        type: "audio",
        mediaUrl: audioUrl,
        metaMessageId: metaMessageId || undefined,
        status: metaMessageId ? "sent" : "failed",
      });

      await wabaStorage.updateConversation(convo.id, {
        lastMessageAt: new Date(),
        lastMessagePreview: "[Áudio]",
      });

      const clients = chatSSEClients.get(convo.wabaId);
      if (clients) {
        const eventData = JSON.stringify({ type: "new_message", conversationId: convo.id, message: msg });
        clients.forEach((client) => client.write(`data: ${eventData}\n\n`));
      }

      res.json(msg);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiConversationsSendaudio', {
        conversationId: req.params.conversationId,
        originalFilename: req.file?.originalname,
        fileSize: req.file?.size,
        fileMimetype: req.file?.mimetype,
      }, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/conversations/:conversationId/send-document", chatMediaUpload.single("document"), async (req, res) => {
    try {
      const convo = await wabaStorage.getConversation(req.params.conversationId);
      if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
      const waba = await wabaStorage.getWabaById(convo.wabaId);
      if (!waba || waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });
      if (convo.cswExpiresAt && new Date(convo.cswExpiresAt) < new Date()) {
        return res.status(403).json({ error: "Janela de atendimento (CSW) expirada." });
      }
      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      if (numbers.length === 0) return res.status(400).json({ error: "Nenhum número associado à WABA" });

      const filename = req.body.filename || req.file?.originalname || "document";
      let docUrl = req.body.documentUrl || "";
      if (req.file) {
        const publicDomain = getPublicDomain();
        docUrl = `${publicDomain}/uploads/chat-media/${req.file.filename}`;
      }
      if (!docUrl) return res.status(400).json({ error: "Documento é obrigatório" });

      let resolvedDocPhoneNumberId = numbers[0].phoneNumberId;
      if (convo.phoneNumberId) {
        const matched = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
        if (matched) resolvedDocPhoneNumberId = matched.phoneNumberId;
      }
      const digits = convo.contactPhone.replace(/\D/g, "");
      const apiData = await metaAPI.sendDocumentMessage(resolvedDocPhoneNumberId, digits, docUrl, filename, waba.accessToken);
      const metaMessageId = apiData?.messages?.[0]?.id;

      const msg = await wabaStorage.createMessage({
        conversationId: convo.id,
        direction: "outbound",
        body: filename,
        type: "document",
        mediaUrl: docUrl,
        metaMessageId: metaMessageId || undefined,
        status: metaMessageId ? "sent" : "failed",
      });

      await wabaStorage.updateConversation(convo.id, {
        lastMessageAt: new Date(),
        lastMessagePreview: `[Documento: ${filename}]`,
      });

      const clients = chatSSEClients.get(convo.wabaId);
      if (clients) {
        const eventData = JSON.stringify({ type: "new_message", conversationId: convo.id, message: msg });
        clients.forEach((client) => client.write(`data: ${eventData}\n\n`));
      }

      res.json(msg);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiConversationsSenddocument', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/conversations/:conversationId/send-template", async (req, res) => {
    try {
      const convo = await wabaStorage.getConversation(req.params.conversationId);
      if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });

      const waba = await wabaStorage.getWabaById(convo.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA não encontrada" });
      if (waba.userId !== req.session.userId!) return res.status(403).json({ error: "Acesso negado" });

      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      if (numbers.length === 0) return res.status(400).json({ error: "Nenhum número associado à WABA" });

      const { templateName, language, parameters } = req.body;
      if (!templateName) return res.status(400).json({ error: "templateName é obrigatório" });

      let phoneNumberId = numbers[0].phoneNumberId;
      if (convo.phoneNumberId) {
        const matched = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
        if (matched) phoneNumberId = matched.phoneNumberId;
      }
      const digits = convo.contactPhone.replace(/\D/g, "");
      const formattedPhone = digits.startsWith("+") ? digits : `+${digits}`;

      const templatePayload: { name: string; language: { code: string }; components?: Array<{ type: string; parameters: Array<{ type: string; text: string }> }> } = {
        name: templateName,
        language: { code: language || "pt_BR" }
      };
      if (parameters && Array.isArray(parameters) && parameters.length > 0) {
        templatePayload.components = [{
          type: "body",
          parameters: parameters.map((p: string) => ({ type: "text", text: p }))
        }];
      }

      const apiResponse = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${waba.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: formattedPhone,
            type: "template",
            template: templatePayload,
          }),
        }
      );

      const apiData = await apiResponse.json() as { messages?: Array<{ id: string }> };
      const metaMessageId = apiData?.messages?.[0]?.id;

      const msg = await wabaStorage.createMessage({
        conversationId: convo.id,
        direction: "outbound",
        body: `[Template: ${templateName}]`,
        type: "template",
        metaMessageId: metaMessageId || undefined,
        status: metaMessageId ? "sent" : "failed",
      });

      await wabaStorage.updateConversation(convo.id, {
        lastMessageAt: new Date(),
        lastMessagePreview: `[Template: ${templateName}]`,
      });

      res.json(msg);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiConversationsSendtemplate', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/wabas/:wabaId/events", async (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    const wabaId = req.params.wabaId;
    if (!chatSSEClients.has(wabaId)) {
      chatSSEClients.set(wabaId, new Set());
    }
    chatSSEClients.get(wabaId)!.add(res);

    const pingInterval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
    }, 30000);

    req.on("close", () => {
      clearInterval(pingInterval);
      chatSSEClients.get(wabaId)?.delete(res);
    });
  });

  // ─── Automation Rules ─────────────────────────────────────────────────────

  app.get("/api/campaigns/:campaignId/automation-rules", async (req, res) => {
    try {
      const rules = await wabaStorage.getAutomationRules(req.params.campaignId);
      res.json(rules);
    } catch (error: any) {
      routeError('getApiCampaignsAutomationrules', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/campaigns/:campaignId/automation-rules", async (req, res) => {
    try {
      const { rules } = req.body;
      if (!Array.isArray(rules)) return res.status(400).json({ error: "rules deve ser um array" });
      const result = await wabaStorage.updateAutomationRules(req.params.campaignId, rules);
      res.json(result);
    } catch (error: any) {
      routeError('putApiCampaignsAutomationrules', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/campaigns/:campaignId/automation", async (req, res) => {
    try {
      const { enabled, fallback } = req.body;
      const updates: any = {};
      if (typeof enabled === "boolean") updates.automationEnabled = enabled;
      if (fallback) updates.automationFallback = fallback;
      const campaign = await updateCampaignInDbAndStorage(req.params.campaignId, updates);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(campaign);
    } catch (error: any) {
      routeError('putApiCampaignsAutomation', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Campaign Dashboard Routes (Campanhas Ativas) ─────────────────────────

  app.get("/api/campaigns/:id/full-metrics", async (req, res) => {
    try {
      const campaign = await getCampaignFromDbOrStorage(req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const deliveries = await db.select().from(messageDeliveriesSchema).where(eq(messageDeliveriesSchema.campaignId, req.params.id));
      const stats = await getDeliveryStatsFromDb(req.params.id);

      let sent = 0, delivered = 0, read = 0, replied = 0, blocked = 0;
      const hourlyData: Record<string, { sent: number; delivered: number; read: number }> = {};
      const contactEvents: Record<string, Array<{ event: string; timestamp: string }>> = {};
      const campaignPhones = new Set<string>();

      for (const d of deliveries) {
        sent++;
        campaignPhones.add(d.phoneNumber);
        const hour = d.sentAt ? new Date(d.sentAt).getHours() : 0;
        const day = d.sentAt ? new Date(d.sentAt).getDay() : 0;
        const key = `${day}-${hour}`;
        if (!hourlyData[key]) hourlyData[key] = { sent: 0, delivered: 0, read: 0 };
        hourlyData[key].sent++;

        if (!contactEvents[d.phoneNumber]) contactEvents[d.phoneNumber] = [];
        contactEvents[d.phoneNumber].push({ event: "enviou", timestamp: d.sentAt?.toISOString() || new Date().toISOString() });

        if (d.status === "delivered" || d.status === "read") {
          delivered++;
          hourlyData[key].delivered++;
          contactEvents[d.phoneNumber].push({ event: "entregou", timestamp: d.deliveredAt?.toISOString() || d.sentAt?.toISOString() || new Date().toISOString() });
        }
        if (d.status === "read") {
          read++;
          hourlyData[key].read++;
          contactEvents[d.phoneNumber].push({ event: "leu", timestamp: d.readAt?.toISOString() || new Date().toISOString() });
        }
        if (d.status === "failed") {
          blocked++;
          contactEvents[d.phoneNumber].push({ event: "bloqueou", timestamp: d.sentAt?.toISOString() || new Date().toISOString() });
        }
      }

      if (campaign.wabaId) {
        try {
          const wabaMetrics = await wabaStorage.getWabaMetrics(campaign.wabaId);
          replied = wabaMetrics.replied || 0;
          if (replied > 0) {
            for (const phone of campaignPhones) {
              if (contactEvents[phone]) {
                contactEvents[phone].push({ event: "respondeu", timestamp: new Date().toISOString() });
              }
            }
          }
        } catch (e: any) {
          routeError('routes.fetchWabaMetrics', { wabaId: campaign.wabaId, campaignId: campaign.id }, e);
        }
      }

      sent = Math.max(sent, stats.sent || 0);
      delivered = Math.max(delivered, stats.delivered || 0);
      read = Math.max(read, stats.read || 0);
      blocked = Math.max(blocked, stats.failed || 0);

      const funnel = {
        sent,
        delivered,
        read,
        replied,
        blocked,
        deliveredPct: sent > 0 ? Math.round((delivered / sent) * 100) : 0,
        readPct: delivered > 0 ? Math.round((read / delivered) * 100) : 0,
        repliedPct: read > 0 ? Math.round((replied / read) * 100) : 0,
        blockedPct: sent > 0 ? Math.round((blocked / sent) * 100) : 0,
      };

      const heatmap: Array<{ day: number; hour: number; sent: number; delivered: number; read: number }> = [];
      for (const [key, val] of Object.entries(hourlyData)) {
        const [day, hour] = key.split("-").map(Number);
        heatmap.push({ day, hour, ...val });
      }

      res.json({ campaign, funnel, heatmap, contactEvents, totalContacts: Object.keys(contactEvents).length });
    } catch (error: any) {
      routeError('handler', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/:id/contact-timeline/:phone", async (req, res) => {
    try {
      const deliveries = await db.select().from(messageDeliveriesSchema).where(eq(messageDeliveriesSchema.campaignId, req.params.id));
      const phone = req.params.phone;
      const events: Array<{ event: string; timestamp: string }> = [];

      for (const d of deliveries) {
        if (d.phoneNumber !== phone) continue;
        if (d.sentAt) events.push({ event: "enviou", timestamp: d.sentAt.toISOString() });
        if (d.deliveredAt) events.push({ event: "entregou", timestamp: d.deliveredAt.toISOString() });
        if (d.readAt) events.push({ event: "leu", timestamp: d.readAt.toISOString() });
        if (d.status === "failed") events.push({ event: "bloqueou", timestamp: d.sentAt?.toISOString() || new Date().toISOString() });
      }

      events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      res.json({ phone, events });
    } catch (error: any) {
      routeError('getApiCampaignsContacttimeline', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/:id/export/:format", async (req, res) => {
    try {
      const campaign = await getCampaignFromDbOrStorage(req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const deliveries = await db.select().from(messageDeliveriesSchema).where(eq(messageDeliveriesSchema.campaignId, req.params.id));
      const stats = await getDeliveryStatsFromDb(req.params.id);
      const format = req.params.format;

      if (format === "csv") {
        const lines = ["Telefone,Status,Enviado Em,Entregue Em,Lido Em,Erro"];
        for (const d of deliveries) {
          lines.push([
            d.phoneNumber,
            d.status,
            d.sentAt?.toISOString() || "",
            d.deliveredAt?.toISOString() || "",
            d.readAt?.toISOString() || "",
            d.errorMessage || ""
          ].join(","));
        }
        lines.push("");
        lines.push(`Total Enviadas,${stats.sent}`);
        lines.push(`Total Entregues,${stats.delivered}`);
        lines.push(`Total Lidas,${stats.read}`);
        lines.push(`Total Falhas,${stats.failed}`);

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=campanha_${campaign.id}.csv`);
        res.send(lines.join("\n"));
      } else if (format === "pdf" || format === "txt") {
        const sep = "=".repeat(50);
        const report = [
          sep,
          `  RELATORIO DA CAMPANHA`,
          sep,
          ``,
          `Nome: ${campaign.name}`,
          `ID: ${campaign.id}`,
          `Status: ${campaign.status}`,
          `Total Leads: ${campaign.totalLeads}`,
          ``,
          `--- METRICAS ---`,
          `Enviadas: ${stats.sent}`,
          `Entregues: ${stats.delivered}`,
          `Lidas: ${stats.read}`,
          `Falhas: ${stats.failed}`,
          ``,
          `Taxa de Entrega: ${stats.sent > 0 ? Math.round((stats.delivered / stats.sent) * 100) : 0}%`,
          `Taxa de Leitura: ${stats.delivered > 0 ? Math.round((stats.read / stats.delivered) * 100) : 0}%`,
          `Taxa de Falha: ${stats.sent > 0 ? Math.round((stats.failed / stats.sent) * 100) : 0}%`,
          ``,
          `--- DATAS ---`,
          `Criada em: ${campaign.createdAt?.toISOString() || "N/A"}`,
          `Iniciada em: ${campaign.startedAt?.toISOString() || "N/A"}`,
          `Concluída em: ${campaign.completedAt?.toISOString() || "N/A"}`,
          ``,
          `--- DETALHAMENTO ---`,
          ...deliveries.map(d => `${d.phoneNumber} | ${d.status} | ${d.sentAt?.toISOString() || "N/A"}`),
          ``,
          sep,
        ].join("\n");

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=relatorio_campanha_${campaign.id}.txt`);
        res.send(report);
      } else {
        res.status(400).json({ error: "Formato inválido. Use csv ou pdf" });
      }
    } catch (error: any) {
      routeError('getApiCampaignsExport', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/:id/cost-estimate", async (req, res) => {
    try {
      const campaign = await getCampaignFromDbOrStorage(req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });

      const [template] = campaign.templateId ? await db.select().from(templatesSchema).where(eq(templatesSchema.id, campaign.templateId)) : [undefined];
      const category = template?.category?.toLowerCase() || "marketing";

      const pricePerMessage: Record<string, number> = {
        marketing: 0.0625,
        utility: 0.0080,
        authentication: 0.0315,
        service: 0.0000,
      };

      const unitPrice = pricePerMessage[category] || pricePerMessage.marketing;
      const totalMessages = campaign.totalLeads || 0;
      const estimatedCostUSD = totalMessages * unitPrice;
      const estimatedCostBRL = estimatedCostUSD * 5.2;

      res.json({
        totalMessages,
        category,
        unitPriceUSD: unitPrice,
        estimatedCostUSD: Math.round(estimatedCostUSD * 100) / 100,
        estimatedCostBRL: Math.round(estimatedCostBRL * 100) / 100,
      });
    } catch (error: any) {
      routeError('getApiCampaignsCostestimate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/:id/duplicate", async (req, res) => {
    try {
      const original = await getCampaignFromDbOrStorage(req.params.id);
      if (!original) return res.status(404).json({ error: "Campanha não encontrada" });

      const [duplicate] = await db.insert(campaignsSchema).values({
        name: `${original.name}_copia`,
        templateId: original.templateId,
        leadListId: original.leadListId,
        totalLeads: original.totalLeads,
        userId: req.session.userId!,
        conversionMessage: original.conversionMessage || undefined,
        conversionLink: original.conversionLink || undefined,
        conversionDelayMs: original.conversionDelayMs || undefined,
        burstMode: original.burstMode || undefined,
        businessHoursOnly: original.businessHoursOnly || undefined,
      }).returning();

      registerPersistentCampaignTracker(duplicate.id);

      if (original.campaignConfig) {
        await updateCampaignInDbAndStorage(duplicate.id, {
          wabaId: original.wabaId,
          campaignConfig: original.campaignConfig,
        } as any);
      }

      res.json(duplicate);
    } catch (error: any) {
      routeError('postApiCampaignsDuplicate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/:id/schedule", async (req, res) => {
    try {
      const { scheduledAt } = req.body;
      if (!scheduledAt) return res.status(400).json({ error: "scheduledAt é obrigatório" });

      const scheduledDate = new Date(scheduledAt);
      if (scheduledDate <= new Date()) {
        return res.status(400).json({ error: "Data deve ser no futuro" });
      }

      const campaign = await updateCampaignInDbAndStorage(req.params.id, {
        scheduledAt: scheduledDate,
        status: "scheduled",
      } as any);

      if (!campaign) return res.status(404).json({ error: "Campanha não encontrada" });
      res.json(campaign);
    } catch (error: any) {
      routeError('postApiCampaignsSchedule', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/:id/segmentation", async (req, res) => {
    try {
      const deliveries = await db.select().from(messageDeliveriesSchema).where(eq(messageDeliveriesSchema.campaignId, req.params.id));
      const filter = req.query.filter as string;

      let filtered = deliveries;
      if (filter === "read") {
        filtered = deliveries.filter(d => d.status === "read");
      } else if (filter === "delivered") {
        filtered = deliveries.filter(d => d.status === "delivered" || d.status === "read");
      } else if (filter === "failed") {
        filtered = deliveries.filter(d => d.status === "failed");
      } else if (filter === "no_interaction") {
        filtered = deliveries.filter(d => d.status === "sent");
      }

      const leads = filtered.map(d => ({
        phone: d.phoneNumber,
        status: d.status,
        sentAt: d.sentAt?.toISOString(),
        deliveredAt: d.deliveredAt?.toISOString(),
        readAt: d.readAt?.toISOString(),
      }));

      res.json({
        total: deliveries.length,
        filtered: leads.length,
        filter: filter || "all",
        leads,
      });
    } catch (error: any) {
      routeError('getApiCampaignsSegmentation', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/dashboard", async (req, res) => {
    try {
      const campaigns = await db.select().from(campaignsSchema).where(eq(campaignsSchema.userId, req.session.userId!));
      const dashboard = await Promise.all(
        campaigns.map(async (c) => {
          let stats = { sent: 0, delivered: 0, read: 0, failed: 0 };
          try {
            stats = await getDeliveryStatsFromDb(c.id);
          } catch (e: any) {
            routeError('routes.fetchDeliveryStats', { campaignId: c.id }, e);
          }

          const [templateRow] = c.templateId ? await db.select().from(templatesSchema).where(eq(templatesSchema.id, c.templateId)) : [undefined];
          const template = templateRow || null;

          let repliedCount = 0;
          if (c.wabaId) {
            try {
              const wabaMetrics = await wabaStorage.getWabaMetrics(c.wabaId);
              repliedCount = wabaMetrics.replied || 0;
            } catch (e: any) {
              routeError('routes.fetchWabaMetricsDashboard', { wabaId: c.wabaId, campaignId: c.id }, e);
            }
          }

          const sentTotal = stats.sent || c.sentMessages || 0;
          const deliveredTotal = stats.delivered || 0;
          const readTotal = stats.read || 0;
          const failedTotal = stats.failed || c.failedMessages || 0;

          return {
            ...c,
            templateName: template?.name || "N/A",
            templateCategory: template?.category || "N/A",
            metrics: {
              sent: sentTotal,
              delivered: deliveredTotal,
              read: readTotal,
              failed: failedTotal,
              replied: repliedCount,
              deliveredPct: sentTotal > 0 ? Math.round((deliveredTotal / sentTotal) * 100) : 0,
              readPct: deliveredTotal > 0 ? Math.round((readTotal / deliveredTotal) * 100) : 0,
              blockedPct: sentTotal > 0 ? Math.round((failedTotal / sentTotal) * 100) : 0,
            },
          };
        })
      );

      res.json(dashboard);
    } catch (error: any) {
      routeError('getApiCampaignsDashboard', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Bot Flow (Conversa Guiada) ──────────────────────────────────────────

  startBotTimeoutJob();

  app.get("/api/campaigns/:id/bot-flow", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const [flow] = await db.select().from(botFlows).where(eq(botFlows.campaignId, campaignId));
      if (!flow) return res.json(null);

      const nodes = await db.select().from(botFlowNodes)
        .where(eq(botFlowNodes.flowId, flow.id))
        .orderBy(asc(botFlowNodes.sortOrder));

      res.json({ ...flow, nodes });
    } catch (error: any) {
      routeError('getApiCampaignsBotflow', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/campaigns/:id/bot-flow", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const { name, nodes: inputNodes } = req.body;

      if (!inputNodes || !Array.isArray(inputNodes)) {
        return res.status(400).json({ error: "nodes é obrigatório e deve ser um array" });
      }

      const result = await db.transaction(async (tx) => {
        let [flow] = await tx.select().from(botFlows).where(eq(botFlows.campaignId, campaignId));

        let oldNodeIds: string[] = [];

        if (flow) {
          const existingNodes = await tx.select({ id: botFlowNodes.id }).from(botFlowNodes)
            .where(eq(botFlowNodes.flowId, flow.id));
          oldNodeIds = existingNodes.map(n => n.id);

          [flow] = await tx.update(botFlows).set({
            name: name || flow.name,
            version: flow.version + 1,
            updatedAt: new Date(),
          }).where(eq(botFlows.id, flow.id)).returning();

          await tx.delete(botFlowNodes).where(eq(botFlowNodes.flowId, flow.id));
        } else {
          [flow] = await tx.insert(botFlows).values({
            campaignId,
            name: name || "Fluxo principal",
            isActive: false,
            version: 1,
          }).returning();
        }

        const tempIdToRealId: Record<string, string> = {};
        const createdNodes = [];

        for (let i = 0; i < inputNodes.length; i++) {
          const node = inputNodes[i];
          const [created] = await tx.insert(botFlowNodes).values({
            flowId: flow.id,
            nodeType: node.nodeType || "message",
            sortOrder: node.sortOrder ?? i,
            label: node.label || `Etapa ${i + 1}`,
            messageContent: node.messageContent || null,
            messageType: node.messageType || "text",
            mediaUrl: node.mediaUrl || null,
            buttonPayload: node.buttonPayload || null,
            conditions: node.conditions || [],
            defaultNextNodeId: null,
            timeoutMinutes: node.timeoutMinutes || null,
            timeoutAction: node.timeoutAction || "end",
            timeoutNextNodeId: null,
            timeoutMessage: node.timeoutMessage || null,
            delaySeconds: node.delaySeconds ?? 3,
            variableCapture: node.variableCapture || null,
            linkUrl: node.linkUrl || null,
          }).returning();
          tempIdToRealId[node.tempId || node.id || `node_${i}`] = created.id;
          createdNodes.push({ ...created, originalIndex: i, originalNode: node });
        }

        for (let i = 0; i < createdNodes.length; i++) {
          const node = createdNodes[i];
          const originalNode = node.originalNode;
          const updates: Record<string, string | object> = {};

          if (originalNode.defaultNextNodeId) {
            updates.defaultNextNodeId = tempIdToRealId[originalNode.defaultNextNodeId] || originalNode.defaultNextNodeId;
          } else if (i < createdNodes.length - 1) {
            updates.defaultNextNodeId = createdNodes[i + 1].id;
          }

          if (originalNode.timeoutNextNodeId) {
            updates.timeoutNextNodeId = tempIdToRealId[originalNode.timeoutNextNodeId] || originalNode.timeoutNextNodeId;
          }

          if (originalNode.conditions && Array.isArray(originalNode.conditions)) {
            const mappedConditions = originalNode.conditions.map((c: { id: string; matchType: string; matchValue: string; nextNodeId: string }) => ({
              ...c,
              nextNodeId: tempIdToRealId[c.nextNodeId] || c.nextNodeId,
            }));
            updates.conditions = mappedConditions;
          }

          const rawPayload = originalNode.buttonPayload;
          if (rawPayload != null) {
            if (Array.isArray(rawPayload)) {
              const buttonItems = rawPayload as BotButtonPayloadItem[];
              const remapped = buttonItems.map((item: BotButtonPayloadItem) => ({
                ...item,
                nextNodeId: item.nextNodeId ? (tempIdToRealId[item.nextNodeId] || item.nextNodeId) : item.nextNodeId,
              }));
              updates.buttonPayload = remapped;
            } else if (typeof rawPayload === 'object' && 'items' in rawPayload) {
              const meta = rawPayload as BotButtonsPayloadMeta;
              const remappedItems = meta.items.map((item: BotButtonPayloadItem) => ({
                ...item,
                nextNodeId: item.nextNodeId ? (tempIdToRealId[item.nextNodeId] || item.nextNodeId) : item.nextNodeId,
              }));
              updates.buttonPayload = { ...meta, items: remappedItems };
            } else if (typeof rawPayload === 'object' && 'sections' in rawPayload) {
              const listPay = rawPayload as BotListPayload;
              const remappedSections = listPay.sections.map((section) => ({
                ...section,
                rows: section.rows.map((row) => ({
                  ...row,
                  nextNodeId: row.nextNodeId ? (tempIdToRealId[row.nextNodeId] || row.nextNodeId) : row.nextNodeId,
                })),
              }));
              updates.buttonPayload = { ...listPay, sections: remappedSections };
            }
          }

          if (Object.keys(updates).length > 0) {
            await tx.update(botFlowNodes).set(updates).where(eq(botFlowNodes.id, node.id));
          }
        }

        if (oldNodeIds.length > 0) {
          const oldIdToNewId: Record<string, string> = {};
          for (const [tempId, realId] of Object.entries(tempIdToRealId)) {
            const oldId = oldNodeIds.find(oid => tempId === oid);
            if (oldId) oldIdToNewId[oldId] = realId;
          }
          const activeStates = await tx.select().from(botConversationStates)
            .where(and(
              eq(botConversationStates.flowId, flow.id),
              eq(botConversationStates.status, "active")
            ));
          for (const state of activeStates) {
            const newNodeId = state.currentNodeId ? oldIdToNewId[state.currentNodeId] : undefined;
            if (newNodeId) {
              await tx.update(botConversationStates).set({ currentNodeId: newNodeId })
                .where(eq(botConversationStates.id, state.id));
            } else {
              const firstNode = createdNodes[0];
              if (firstNode) {
                await tx.update(botConversationStates).set({ currentNodeId: firstNode.id })
                  .where(eq(botConversationStates.id, state.id));
              }
            }
          }
        }

        const finalNodes = await tx.select().from(botFlowNodes)
          .where(eq(botFlowNodes.flowId, flow.id))
          .orderBy(asc(botFlowNodes.sortOrder));

        return { ...flow, nodes: finalNodes };
      });

      res.json(result);
    } catch (error: any) {
      routeError('handler', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/:id/bot-flow/activate", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const [flow] = await db.select().from(botFlows).where(eq(botFlows.campaignId, campaignId));
      if (!flow) return res.status(404).json({ error: "Fluxo não encontrado" });

      const nodes = await db.select().from(botFlowNodes).where(eq(botFlowNodes.flowId, flow.id));
      if (nodes.length === 0) return res.status(400).json({ error: "Fluxo sem etapas" });

      const [updated] = await db.update(botFlows).set({ isActive: true, updatedAt: new Date() })
        .where(eq(botFlows.id, flow.id)).returning();

      await db.update(campaignsSchema).set({ automationEnabled: true }).where(eq(campaignsSchema.id, campaignId));

      res.json(updated);
    } catch (error: any) {
      routeError('postCampaignsBotflowActivate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/:id/bot-flow/deactivate", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const [flow] = await db.select().from(botFlows).where(eq(botFlows.campaignId, campaignId));
      if (!flow) return res.status(404).json({ error: "Fluxo não encontrado" });

      const [updated] = await db.update(botFlows).set({ isActive: false, updatedAt: new Date() })
        .where(eq(botFlows.id, flow.id)).returning();

      res.json(updated);
    } catch (error: any) {
      routeError('postCampaignsBotflowDeactivate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/:id/bot-flow/migrate", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const flow = await botFlowEngine.migrateAutomationRulesToFlow(campaignId);
      if (!flow) return res.json({ migrated: false, message: "Nenhuma regra de automação encontrada para migrar ou fluxo já existe" });

      const nodes = await db.select().from(botFlowNodes)
        .where(eq(botFlowNodes.flowId, flow.id))
        .orderBy(asc(botFlowNodes.sortOrder));

      res.json({ migrated: true, flow: { ...flow, nodes } });
    } catch (error: any) {
      routeError('postCampaignsBotflowMigrate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/:id/bot-flow/stats", async (req, res) => {
    try {
      const campaignId = req.params.id;
      const [flow] = await db.select().from(botFlows).where(eq(botFlows.campaignId, campaignId));
      if (!flow) return res.json({ total: 0, active: 0, completed: 0, timedOut: 0 });

      const states = await db.select().from(botConversationStates)
        .where(eq(botConversationStates.flowId, flow.id));

      const stats = {
        total: states.length,
        active: states.filter(s => s.status === 'active').length,
        completed: states.filter(s => s.status === 'completed').length,
        timedOut: states.filter(s => s.status === 'timed_out').length,
      };

      res.json(stats);
    } catch (error: any) {
      routeError('getCampaignsBotflowStats', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Parameter Models ─────────────────────────────────────────────────────

  app.get("/api/parameter-models", async (req, res) => {
    try {
      const models = await wabaStorage.getParameterModels(req.session.userId!);
      res.json(models);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiParametermodels', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/parameter-models", async (req, res) => {
    try {
      const { name, templateName, parameters } = req.body;
      if (!name || !parameters) return res.status(400).json({ error: "name e parameters são obrigatórios" });
      const model = await wabaStorage.createParameterModel({ userId: req.session.userId!, name, templateName, parameters });
      res.json(model);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postApiParametermodels', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/parameter-models/:id", async (req, res) => {
    try {
      await wabaStorage.deleteParameterModel(req.params.id);
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('deleteApiParametermodels', {}, error);
      res.status(500).json({ error: message });
    }
  });

  // ─── Webhook Hooks Log ────────────────────────────────────────────────────

  app.get("/api/quality-dashboard", (_req, res) => {
    try {
      const data = deliveryMetricsTracker.getDashboardData();
      res.json(data);
    } catch (error: any) {
      routeError('getApiQualitydashboard', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/quality-dashboard/reset-pause", (_req, res) => {
    deliveryMetricsTracker.resetAutoPause();
    let resumed = 0;
    for (const engine of activeEngines) {
      try {
        engine.resumeCampaign();
        resumed++;
      } catch (e: any) {
        routeError('routes.resumeCampaignEngine', {}, e);
      }
    }
    res.json({ success: true, message: `Auto-pause resetado, ${resumed} engine(s) retomada(s)` });
  });

  app.get("/api/template-intelligence", (_req, res) => {
    try {
      const data = getAllTemplateIntelligence();
      res.json({ templates: data, updatedAt: new Date().toISOString() });
    } catch (error: any) {
      routeError('getApiTemplateIntelligence', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/health-score", (_req, res) => {
    try {
      const dashData = deliveryMetricsTracker.getDashboardData();
      const templates = getAllTemplateIntelligence();

      const deliveryRate = dashData.overall?.overallDeliveryRate ?? 1;

      const windowedBlockRate = dashData.windowedRates?.deliveryRate != null
        ? 1 - dashData.windowedRates.deliveryRate
        : dashData.overall?.overallFailRate ?? 0;

      const avgTemplateScore = templates.length > 0
        ? templates.reduce((sum, t) => sum + t.score, 0) / templates.length
        : 1;

      const tierWeightMap: Record<string, number> = {
        HIGH_TRUST: 1.0,
        NORMAL: 0.7,
        REDUCE_LOAD: 0.4,
        DISABLE_TEMP: 0.0,
      };

      let phoneReputationScore = 1.0;
      let disabledPhones = 0;
      let reducedPhones = 0;
      const allPhoneReputations: PhoneReputation[] = [];
      for (const [, eng] of activeUltraEngines.entries()) {
        try {
          const reps = eng.getPhoneReputationScore().getAllReputations();
          allPhoneReputations.push(...reps);
        } catch (repErr: any) {
          logError('getApiHealthScore.getReputations', {}, repErr);
        }
      }
      if (allPhoneReputations.length > 0) {
        phoneReputationScore = allPhoneReputations.reduce((acc, r) => acc + (tierWeightMap[r.tier] ?? 0.5), 0) / allPhoneReputations.length;
        disabledPhones = allPhoneReputations.filter(r => r.tier === 'DISABLE_TEMP').length;
        reducedPhones = allPhoneReputations.filter(r => r.tier === 'REDUCE_LOAD').length;
      }

      const hasBlockRateIssue = windowedBlockRate >= 0.15;
      const hasDeliveryIssue = deliveryRate < 0.6;

      const score = Math.max(0, Math.min(100, Math.round(
        (deliveryRate * 0.35 + avgTemplateScore * 0.25 + (1 - windowedBlockRate) * 0.25 + phoneReputationScore * 0.15) * 100
      )));

      const grade =
        score >= 90 ? 'A' :
        score >= 75 ? 'B' :
        score >= 60 ? 'C' :
        score >= 45 ? 'D' : 'F';

      const risks: string[] = [];
      if (hasBlockRateIssue) risks.push(`Block rate (janela) alto: ${(windowedBlockRate * 100).toFixed(1)}%`);
      if (hasDeliveryIssue) risks.push(`Entrega baixa: ${(deliveryRate * 100).toFixed(1)}%`);
      if (disabledPhones > 0) risks.push(`${disabledPhones} número(s) temporariamente desativado(s) por reputação`);
      if (reducedPhones > 0) risks.push(`${reducedPhones} número(s) com carga reduzida por reputação`);
      const rotationNeeded = templates.filter(t => t.needsRotation);
      if (rotationNeeded.length > 0) risks.push(`${rotationNeeded.length} template(s) precisam de rotação`);

      res.json({
        score,
        grade,
        deliveryRate,
        blockRate: windowedBlockRate,
        avgTemplateScore,
        phoneReputationScore,
        phoneReputationDetails: {
          total: allPhoneReputations.length,
          disabled: disabledPhones,
          reduced: reducedPhones,
        },
        risks,
        status: score >= 75 ? 'healthy' : score >= 50 ? 'degraded' : 'critical',
        updatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      routeError('getApiHealthScore', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/webhook-logs", async (req, res) => {
    try {
      if (!req.session?.userId) {
        return res.status(401).json({ error: "Não autenticado" });
      }
      const { db } = await import("./db");
      const { wabaHooks, wabas } = await import("@shared/schema");
      const { desc, eq, inArray } = await import("drizzle-orm");

      const isAdmin = req.session.userRole === "admin";
      if (isAdmin) {
        const logs = await db.select().from(wabaHooks).orderBy(desc(wabaHooks.tsReceived)).limit(100);
        return res.json(logs);
      }

      const userWabas = await db.select({ wabaId: wabas.wabaId }).from(wabas).where(eq(wabas.userId, req.session.userId));
      if (userWabas.length === 0) {
        return res.json([]);
      }
      const wabaIds = userWabas.map(w => w.wabaId);
      const logs = await db.select().from(wabaHooks).orderBy(desc(wabaHooks.tsReceived)).limit(200);
      const filtered = logs.filter(log => {
        try {
          const entryData = log.entry;
          const entries = Array.isArray(entryData) ? entryData : (entryData && typeof entryData === 'object' ? [entryData] : []);
          return entries.some((entry: Record<string, unknown>) => wabaIds.includes(entry.id as string));
        } catch (e: any) {
          console.debug('[routes] Failed to parse webhook log entry', { logId: log.id, error: e.message });
          return false;
        }
      }).slice(0, 100);
      res.json(filtered);
    } catch (error: any) {
      routeError('getWebhookLogs', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Webhook Receiver Meta / WhatsApp ───────────────────────────────────────

  // GET: verificação do webhook pela Meta (hub challenge)
  app.get("/api/webhook/meta", webhookRateLimiter, (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
    if (mode === "subscribe" && token === verifyToken) {
      res.status(200).send(challenge as string);
    } else {
      res.status(403).json({ error: "Forbidden" });
    }
  });

  // GET: verificação do webhook por usuário (hub challenge com verify token do usuário)
  app.get("/api/webhook/meta/:userId", webhookRateLimiter, async (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const { userId } = req.params;

    try {
      const [config] = await db.select({ webhookVerifyToken: apiConfigsSchema.webhookVerifyToken })
        .from(apiConfigsSchema)
        .where(eq(apiConfigsSchema.userId, userId));

      if (config?.webhookVerifyToken && mode === "subscribe" && token === config.webhookVerifyToken) {
        return res.status(200).send(challenge as string);
      }

      const globalVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
      if (mode === "subscribe" && token === globalVerifyToken) {
        return res.status(200).send(challenge as string);
      }

      res.status(403).json({ error: "Forbidden" });
    } catch (error: any) {
      routeError('routes.webhookVerifyUser', { userId }, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post(["/api/webhook/meta", "/api/webhook/meta/:userId"], webhookRateLimiter, async (req, res) => {
    const globalAppSecret = process.env.META_APP_SECRET;
    {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        return res.status(401).json({ error: "Missing X-Hub-Signature-256" });
      }
      const rawBody = (req as any).rawBody as Buffer | undefined;
      if (!rawBody) {
        return res.status(401).json({ error: "Unable to verify signature" });
      }
      if (!signature.startsWith("sha256=")) {
        return res.status(401).json({ error: "Invalid signature format" });
      }

      const secretsToTry: string[] = [];

      let payloadWabaId: string | undefined;
      try {
        const parsedBody = JSON.parse(rawBody.toString());
        payloadWabaId = parsedBody?.entry?.[0]?.id;
      } catch (_e: any) {
        console.error('[webhook] Failed to parse raw body for WABA ID extraction:', _e?.message || _e);
      }

      if (payloadWabaId) {
        try {
          const [specificWaba] = await db.select({ appSecret: wabasSchema.appSecret }).from(wabasSchema)
            .where(and(eq(wabasSchema.wabaId, payloadWabaId), isNotNull(wabasSchema.appSecret)))
            .limit(1);
          if (specificWaba?.appSecret && !secretsToTry.includes(specificWaba.appSecret)) {
            secretsToTry.push(specificWaba.appSecret);
          }
        } catch (e: any) {
          routeError('routes.webhookFetchSpecificWabaSecret', { payloadWabaId }, e);
        }
      }

      if (globalAppSecret && !secretsToTry.includes(globalAppSecret)) secretsToTry.push(globalAppSecret);

      if (secretsToTry.length === 0) {
        console.error("[WEBHOOK] Nenhum APP_SECRET configurado (nem global nem por WABA) — rejeitando webhook");
        return res.status(503).json({ error: "Webhook signature verification not configured" });
      }

      let signatureValid = false;
      let matchedSecretIndex = -1;
      for (let sIdx = 0; sIdx < secretsToTry.length; sIdx++) {
        const secret = secretsToTry[sIdx];
        const expectedSig = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedSig);
        if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
          signatureValid = true;
          matchedSecretIndex = sIdx;
          break;
        }
      }

      if (signatureValid) {
        const sourceLabel = matchedSecretIndex === 0 && globalAppSecret ? 'global' : `waba/config[${matchedSecretIndex}]`;
        console.log(`[WEBHOOK] Signature verified via ${sourceLabel} (${secretsToTry.length} secret(s) available)`);
      }

      if (!signatureValid) {
        console.warn(`[WEBHOOK] Invalid X-Hub-Signature-256 — none of ${secretsToTry.length} secret(s) matched`);
        try {
          const bodyPreview = JSON.parse(rawBody.toString());
          const wabaId = bodyPreview?.entry?.[0]?.id || 'unknown';
          console.warn(`[WEBHOOK] Payload WABA ID: ${wabaId} — verifique se o App Secret está configurado para esta WABA`);
        } catch (e: any) {
          routeError('routes.webhookParseRawBody', {}, e);
        }
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account") {
      console.warn(`[WEBHOOK_DROP]`, { reason: 'body.object mismatch or empty body', object: body?.object || 'none' });
      res.status(200).end();
      return;
    }

    let hookId: string | undefined;
    try {
      const firstMessageId: string | undefined =
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id ||
        body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.id ||
        undefined;
      const [insertedHook] = await db.insert(wabaHooksSchema).values({
        object: body.object,
        entry: body.entry,
        metaMessageId: firstMessageId,
      }).returning({ id: wabaHooksSchema.id });
      hookId = insertedHook?.id;
    } catch (err) {
      routeError('webhook.persistHook', { object: body.object }, err);
    }

    res.status(200).end();
    updateLastWebhookEvent();

    setImmediate(async () => {
      try {
        await processWebhookEntries(body.entry || []);

        if (hookId) {
          await db.update(wabaHooksSchema).set({ processed: true }).where(eq(wabaHooksSchema.id, hookId));
        }
      } catch (err) {
        routeError('webhook.processEntries', { hookId }, err);
      }
    });
  });

  setWebhookProcessingCallback(async (hook: any) => {
    try {
      const entries = Array.isArray(hook.entry) ? hook.entry : [];
      await processWebhookEntries(entries);
    } catch (err: any) {
      routeError('webhookWorker.replay', { hookId: hook.id }, err);
      throw err;
    }
  });

  async function processWebhookEntries(entries: any[]): Promise<void> {
        for (const entry of entries) {
          const entryWabaId: string | undefined = entry.id;
          const changes: any[] = entry.changes || [];
          for (const change of changes) {
            const value = change?.value || {};
            const phoneNumberId = value.metadata?.phone_number_id;

            const statuses: any[] = value.statuses || [];
            for (const ev of statuses) {
              const msgId: string = ev.id;
              const phone: string = ev.recipient_id || ev.bsuid;
              const status: string = ev.status;
              const campaignIdFromMeta: string | null = ev.metadata?.campaign_id ?? null;
              const campaignId: string | null = campaignIdFromMeta || deliveryMetricsTracker.lookupCampaignByMessageId(msgId) || null;
              console.log(`[WEBHOOK] Status update: msgId=${msgId} phone=${phone} status=${status} phoneNumberId=${phoneNumberId || 'none'} campaignId=${campaignId || 'none'}`);
              if (msgId && phone && status) {
                const upsertResult = await upsertMessageStatusInDb(campaignId, msgId, phone, status);
                const isNewTransition = upsertResult.previousStatus !== status;

                if (campaignId && isNewTransition && (status === 'delivered' || status === 'read')) {
                  try {
                    if (status === 'delivered') {
                      await db.execute(sql`UPDATE campaigns SET delivered_count = COALESCE(delivered_count, 0) + 1, updated_at = NOW() WHERE id = ${campaignId}`);
                    } else {
                      await db.execute(sql`UPDATE campaigns SET read_count = COALESCE(read_count, 0) + 1, updated_at = NOW() WHERE id = ${campaignId}`);
                    }
                  } catch (e) {
                    routeError("routes.webhookUpdateStatusCounter", { campaignId, status }, e);
                  }
                }

                if (status === 'delivered' || status === 'read' || status === 'failed') {
                  const msgMeta = deliveryMetricsTracker.lookupMetaByMessageId(msgId);
                  const resolvedTemplate = msgMeta?.templateName || deliveryMetricsTracker.lookupTemplateByMessageId(msgId);
                  const resolvedPhoneId = phoneNumberId || msgMeta?.phoneNumberId;
                  if (isNewTransition) {
                    fanOutWebhookStatus(
                      status as 'delivered' | 'read' | 'failed',
                      resolvedTemplate,
                      resolvedPhoneId,
                      msgId
                    );
                    const effectiveCampaignId = campaignId || msgMeta?.campaignId || null;
                    if (effectiveCampaignId) {
                      if (status === 'delivered' && resolvedPhoneId) {
                        fanOutDeliveredForResponseRate(effectiveCampaignId, resolvedTemplate || 'campaign', resolvedPhoneId, phone, msgId);
                      } else if (status === 'read') {
                        recordPersistentCampaignRead(effectiveCampaignId);
                      }
                    }
                  }
                }

                if (status === 'failed') {
                  const errors = ev.errors && Array.isArray(ev.errors) ? ev.errors : [];
                  if (errors.length > 0) {
                    for (const err of errors) {
                      const errCode = err.code !== undefined ? err.code : 'N/A';
                      const errTitle = err.title || err.message || 'sem descrição';
                      console.error(`[WEBHOOK] message ${msgId} failed: code=${errCode} title=${errTitle} phone=${phone} campaignId=${campaignId || 'none'}`);
                      const errCodeNum = err.code ? parseInt(err.code, 10) : undefined;
                      OptOutService.handleDeliveryError(phone, errCodeNum, errTitle, campaignId || undefined, phoneNumberId).catch(e => routeError('handleDeliveryError', { phone, errCode, errTitle, campaignId, phoneNumberId }, e));
                    }
                  } else {
                    console.error(`[WEBHOOK] message ${msgId} failed: no error details phone=${phone} campaignId=${campaignId || 'none'}`);
                  }
                }
                const updatedMsg = await wabaStorage.updateMessageStatus(msgId, status);
                if (updatedMsg) {
                  const convo = await wabaStorage.getConversation(updatedMsg.conversationId);
                  if (convo) {
                    const sseClients = chatSSEClients.get(convo.wabaId);
                    if (sseClients) {
                      const eventData = JSON.stringify({ type: "status_update", conversationId: convo.id, messageId: updatedMsg.id, status });
                      sseClients.forEach((client) => client.write(`data: ${eventData}\n\n`));
                    }
                  }
                }
              }
            }

            const inboundMessages: any[] = value.messages || [];
            for (const msg of inboundMessages) {
              const metaMessageId = msg.id;
              if (!metaMessageId) {
                console.warn(`[WEBHOOK_DROP]`, { reason: 'metaMessageId missing', phone: msg.from || 'unknown' });
                continue;
              }

              const existingHook = await db.select({ id: wabaHooksSchema.id })
                .from(wabaHooksSchema)
                .where(and(eq(wabaHooksSchema.metaMessageId, metaMessageId), eq(wabaHooksSchema.processed, true)))
                .limit(1);
              if (existingHook.length > 0) {
                console.warn(`[WEBHOOK_DROP]`, { reason: 'duplicate_persisted', metaMessageId, phone: msg.from || 'unknown' });
                continue;
              }

              const senderPhone = msg.from;
              const senderWaId: string | undefined = value.contacts?.[0]?.wa_id || undefined;
              const senderName = value.contacts?.[0]?.profile?.name || senderPhone;
              const msgType = msg.type || "text";
              let messageBody = msg.text?.body || msg.caption || "";
              let buttonReplyId: string | undefined;
              let buttonReplyTitle: string | undefined;
              if (msgType === "interactive" && msg.interactive) {
                if (msg.interactive.button_reply) {
                  buttonReplyId = msg.interactive.button_reply.id || undefined;
                  buttonReplyTitle = msg.interactive.button_reply.title || undefined;
                  messageBody = msg.interactive.button_reply.title || msg.interactive.button_reply.id || "";
                } else if (msg.interactive.list_reply) {
                  buttonReplyId = msg.interactive.list_reply.id || undefined;
                  buttonReplyTitle = msg.interactive.list_reply.title || undefined;
                  messageBody = msg.interactive.list_reply.title || msg.interactive.list_reply.id || "";
                }
              } else if (msgType === "button" && msg.button) {
                messageBody = msg.button.payload || msg.button.text || "";
              }
              if (!messageBody && msgType !== "text") {
                messageBody = `[${msgType}]`;
              }
              let inboundMediaUrl: string | undefined;
              if (msg.image?.id || msg.audio?.id || msg.document?.id || msg.video?.id) {
                const mediaId = msg.image?.id || msg.audio?.id || msg.document?.id || msg.video?.id;
                inboundMediaUrl = `meta:${mediaId}`;
              }

              console.log(`[WEBHOOK] Inbound message received: from=${senderPhone} phoneNumberId=${phoneNumberId || 'none'} entryWabaId=${entryWabaId || 'none'} type=${msgType} metaMessageId=${metaMessageId} buttonReplyId=${buttonReplyId || 'none'} buttonReplyTitle=${buttonReplyTitle || 'none'}`);

              let waba = phoneNumberId ? await wabaStorage.findWabaByPhoneNumberId(phoneNumberId) : undefined;
              if (waba) {
                console.log(`[ROUTING] WABA resolved via phoneNumberId=${phoneNumberId} → wabaDbId=${waba.id}`);
              }

              if (!waba && entryWabaId) {
                waba = await wabaStorage.findWabaByExternalId(entryWabaId);
                if (waba) {
                  console.log(`[ROUTING] WABA resolved via entry.id fallback (${entryWabaId}) → wabaDbId=${waba.id}`);
                }
              }

              if (!waba) {
                console.warn(`[WEBHOOK_DROP]`, { reason: 'WABA not resolved', phoneNumberId: phoneNumberId || 'absent', entryWabaId: entryWabaId || 'absent', phone: senderPhone, metaMessageId });
                console.error(`[ROUTING] WABA not resolved — phoneNumberId=${phoneNumberId || 'absent'} entryWabaId=${entryWabaId || 'absent'} from=${senderPhone}. Persisting to dead-letter log.`);
                try {
                  const { wabaHooks: wabaHooksSchemaInner } = await import("@shared/schema");
                  await db.insert(wabaHooksSchemaInner).values({
                    object: "dead_letter_inbound",
                    entry: [{
                      reason: "waba_not_resolved",
                      from: senderPhone,
                      phoneNumberId: phoneNumberId || null,
                      entryWabaId: entryWabaId || null,
                      metaMessageId,
                      messageType: msgType,
                      body: (messageBody || '').substring(0, 200),
                      receivedAt: new Date().toISOString(),
                    }],
                  });
                  console.warn(`[ROUTING] Dead-letter: persisted unroutable inbound message metaMessageId=${metaMessageId} from=${senderPhone}`);
                } catch (dlErr: any) {
                  console.error(`[ROUTING] Dead-letter persistence failed for message from ${senderPhone}: ${dlErr.message}`);
                }
                continue;
              }

              console.log(`[ROUTING] WABA matched: wabaDbId=${waba.id} wabaExternalId=${waba.wabaId} for phone=${senderPhone}`);

              db.update(wabasSchema).set({ lastWebhookReceivedAt: new Date(), updatedAt: new Date() }).where(eq(wabasSchema.id, waba.id)).catch((e: any) => {
                routeError('webhook.updateLastWebhookReceivedAt', { wabaId: waba.id }, e);
              });

              if (waba.userId) {
                const testSession = webhookTestSessions.get(waba.userId);
                if (testSession && !testSession.received) {
                  testSession.received = true;
                  testSession.receivedAt = Date.now();
                  console.log(`[WEBHOOK_TEST] Inbound message detected for test session userId=${waba.userId}`);
                }
              }

              const canonPhone = canonicalPhone(senderPhone);
              const activeCampaignConvo = await wabaStorage.findActiveCampaignConversation(waba.id, canonPhone, senderWaId);
              const convo = activeCampaignConvo
                ? activeCampaignConvo
                : await wabaStorage.getOrCreateConversation(waba.id, canonPhone, senderName, undefined, senderWaId);

              console.log(`[ROUTING] Conversation resolved: convoId=${convo.id} campaignId=${convo.campaignId || 'none'} source=${activeCampaignConvo ? 'campaign_match' : 'get_or_create'} for phone=${senderPhone}`);

              try {
                await wabaStorage.createMessage({
                  conversationId: convo.id,
                  direction: "inbound",
                  body: messageBody,
                  type: msgType,
                  mediaUrl: inboundMediaUrl,
                  metaMessageId,
                  status: "received",
                });
              } catch (createErr: any) {
                const isUniqueViolation = createErr?.code === '23505' || createErr?.message?.includes('duplicate key') || createErr?.message?.includes('unique constraint');
                if (isUniqueViolation) {
                  console.warn(`[WEBHOOK_DROP]`, { reason: 'duplicate_persisted', metaMessageId, phone: senderPhone });
                  continue;
                }
                throw createErr;
              }
              const bodyPreviewTrunc = messageBody ? messageBody.substring(0, 80) : '(empty)';
              console.log(`[ROUTING] Inbound message persisted: convoId=${convo.id} metaMessageId=${metaMessageId} type=${msgType} body="${bodyPreviewTrunc}"`);

              try {
                await db.insert(wabaHooksSchema).values({
                  object: 'inbound_dedup',
                  entry: null,
                  processed: true,
                  metaMessageId,
                });
              } catch (dedupInsertErr: any) {
                routeError('webhook.dedupInsert', { metaMessageId }, dedupInsertErr);
              }

              const cswExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
              const convoUpdates: Record<string, any> = {
                lastMessageAt: new Date(),
                lastMessagePreview: messageBody.substring(0, 100),
                cswExpiresAt: cswExpiry,
                unreadCount: (convo.unreadCount || 0) + 1,
                contactName: senderName,
              };
              if (phoneNumberId) {
                convoUpdates.phoneNumberId = phoneNumberId;
              }
              if (senderWaId && !convo.contactWaId) {
                convoUpdates.contactWaId = senderWaId;
              }
              await wabaStorage.updateConversation(convo.id, convoUpdates);

              const newMsg = await wabaStorage.getMessageByMetaId(metaMessageId);
              const eventData = JSON.stringify({
                type: "new_message",
                conversationId: convo.id,
                message: newMsg,
                conversation: { ...convo, lastMessageAt: new Date(), lastMessagePreview: messageBody.substring(0, 100) },
              });

              const clients = chatSSEClients.get(waba.id);
              let sseBroadcasted = false;
              if (clients && clients.size > 0) {
                clients.forEach((client) => client.write(`data: ${eventData}\n\n`));
                sseBroadcasted = true;
              }

              if (!sseBroadcasted && waba.userId) {
                try {
                  const userWabas = await wabaStorage.getWabasByUser(waba.userId);
                  for (const uw of userWabas) {
                    const uwClients = chatSSEClients.get(uw.id);
                    if (uwClients && uwClients.size > 0) {
                      uwClients.forEach((client) => client.write(`data: ${eventData}\n\n`));
                      sseBroadcasted = true;
                      console.log(`[SSE] Fallback broadcast to user WABA ${uw.id} for inbound message (original waba=${waba.id})`);
                    }
                  }
                } catch (sseFallbackErr: any) {
                  console.warn(`[SSE] Fallback broadcast error: ${sseFallbackErr.message}`);
                }
              }

              if (!sseBroadcasted) {
                console.log(`[SSE] No active SSE clients for wabaId=${waba.id} — inbound message notification not delivered to chat UI`);
              }

              try {
                const { db: dbInner } = await import("./db");
                const { campaigns: campaignsTable } = await import("@shared/schema");
                const { eq: eqInner, and: andInner } = await import("drizzle-orm");

                const numbers = await wabaStorage.getWabaNumbers(waba.id);
                const replyPhone = canonicalPhone(senderPhone);
                let campaignMatched = false;
                let unknownLeadFallbackSent = false;

                let matchedCampaignIdForCSW = await storage.getCampaignForLead(replyPhone, waba.id);
                if (!matchedCampaignIdForCSW && convo.campaignId) {
                  matchedCampaignIdForCSW = convo.campaignId;
                }
                await cswTracker.registerInbound(replyPhone, matchedCampaignIdForCSW || null, phoneNumberId || null);
                if (matchedCampaignIdForCSW && phoneNumberId) {
                  fanOutReplyForResponseRate(matchedCampaignIdForCSW, phoneNumberId, replyPhone, metaMessageId);
                  if (metaMessageId) {
                    recordTemplateReplyByMessageId(metaMessageId, matchedCampaignIdForCSW);
                  } else {
                    recordTemplateReplyByCampaign(matchedCampaignIdForCSW);
                  }
                  console.log(`[METRIC] response_rate reply tracked campaignId=${matchedCampaignIdForCSW} phoneNumberId=${phoneNumberId} contactPhone=${replyPhone}`);
                }

                if (numbers.length > 0) {
                  let phoneNumId = numbers[0].phoneNumberId;
                  let phoneNumSource = 'default_first';
                  if (phoneNumberId) {
                    const matchedWebhook = numbers.find(n => n.phoneNumberId === phoneNumberId);
                    if (matchedWebhook) {
                      phoneNumId = matchedWebhook.phoneNumberId;
                      phoneNumSource = 'webhook';
                    } else if (convo.phoneNumberId) {
                      const matchedConvo = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
                      if (matchedConvo) {
                        phoneNumId = matchedConvo.phoneNumberId;
                        phoneNumSource = 'conversation';
                      }
                      console.warn(`[BOT] Webhook phoneNumberId=${phoneNumberId} not found in registered WABA numbers — fallback to ${phoneNumSource} phoneNumId=${phoneNumId}`);
                    } else {
                      console.warn(`[BOT] Webhook phoneNumberId=${phoneNumberId} not found in registered WABA numbers — using default phoneNumId=${phoneNumId}`);
                    }
                  } else if (convo.phoneNumberId) {
                    const matched = numbers.find(n => n.phoneNumberId === convo.phoneNumberId);
                    if (matched) {
                      phoneNumId = matched.phoneNumberId;
                      phoneNumSource = 'conversation';
                    }
                  }
                  console.log(`[BOT] Sender selected: phoneNumId=${phoneNumId} source=${phoneNumSource} for phone=${replyPhone}`);

                  if (matchedCampaignIdForCSW) {
                    try {
                      const [campForButtons] = await dbInner.select().from(campaignsTable)
                        .where(eqInner(campaignsTable.id, matchedCampaignIdForCSW));
                      if (campForButtons) {
                        const campCfg = (campForButtons.campaignConfig || {}) as Record<string, any>;
                        const firstResponseButtons = campCfg.firstResponseButtons as Array<{ id?: string; title?: string; nextNodeId?: string; bodyText?: string }> | undefined;
                        if (firstResponseButtons && firstResponseButtons.length > 0) {
                          let alreadySent = false;
                          try {
                            const { messages: msgsTable } = await import("@shared/schema");
                            const likeInner = (await import("drizzle-orm")).like;
                            const campaignButtonMarker = `[campaign:${campForButtons.id}]`;
                            const [existingInteractive] = await dbInner.select({ id: msgsTable.id }).from(msgsTable)
                              .where(andInner(
                                eqInner(msgsTable.conversationId, convo.id),
                                eqInner(msgsTable.direction, 'outbound'),
                                eqInner(msgsTable.type, 'interactive'),
                                likeInner(msgsTable.body, `%${campaignButtonMarker}%`)
                              ))
                              .limit(1);
                            if (existingInteractive) alreadySent = true;
                          } catch (_dbCheckErr: any) {
                            console.error('[routes] Error checking for existing interactive message:', _dbCheckErr?.message || _dbCheckErr);
                          }
                          if (alreadySent) {
                            console.log(`[SEND] botões de resposta rápida já enviados — convo=${convo.id} campaign=${campForButtons.id} phone=${replyPhone}`);
                          }
                          const bodyText = campCfg.firstResponseBodyText || 'Selecione uma opção:';
                          const isOpen = !alreadySent && await cswTracker.isCSWOpen(replyPhone);
                          if (isOpen) {
                            console.log(`[SEND] botões interativos enviados — campaign=${campForButtons.id} phone=${replyPhone} buttons=${firstResponseButtons.length}`);
                            try {
                              await withSendQueue(replyPhone, () =>
                                sendButtons(phoneNumId, replyPhone, bodyText, firstResponseButtons.map(b => ({ id: b.id || b.title || '', title: b.title || '', nextNodeId: b.nextNodeId })), waba.accessToken)
                              );
                              const campaignButtonMarker = `[campaign:${campForButtons.id}]`;
                              await wabaStorage.createMessage({
                                conversationId: convo.id,
                                direction: "outbound",
                                body: `${bodyText} ${campaignButtonMarker}`,
                                type: "interactive",
                                status: "sent",
                              });
                            } catch (btnErr: any) {
                              console.warn(`[SEND] Falha ao enviar botões de resposta rápida: ${btnErr.message}`, { campaignId: campForButtons.id, phone: replyPhone });
                            }
                          }
                        }
                      }
                    } catch (btnCheckErr: any) {
                      console.warn(`[SEND] Erro ao verificar firstResponseButtons: ${btnCheckErr.message}`);
                    }
                  }

                  const botEligibleStatuses = ["running", "completed", "paused"];
                  let activeCampaignsForFlow: typeof campaignsTable.$inferSelect[] = [];
                  if (convo.campaignId) {
                    const [convoCampaignRaw] = await dbInner.select().from(campaignsTable)
                      .where(eqInner(campaignsTable.id, convo.campaignId));
                    if (convoCampaignRaw) {
                      if (convoCampaignRaw.automationEnabled && botEligibleStatuses.includes(convoCampaignRaw.status)) {
                        activeCampaignsForFlow = [convoCampaignRaw];
                        console.log(`[BOT] Conversation campaign ${convo.campaignId} ACTIVE (status=${convoCampaignRaw.status}, automationEnabled=true)`);
                      } else if (!convoCampaignRaw.automationEnabled) {
                        console.log(`[BOT] Conversation campaign ${convo.campaignId} SKIPPED: automationEnabled=false`);
                      } else {
                        console.log(`[BOT] Conversation campaign ${convo.campaignId} SKIPPED: automationEnabled=${convoCampaignRaw.automationEnabled} status=${convoCampaignRaw.status} (requires automationEnabled=true AND status in [${botEligibleStatuses.join(',')}])`);
                      }
                    } else {
                      console.log(`[BOT] Conversation campaign ${convo.campaignId} not found in DB`);
                    }
                  }

                  if (activeCampaignsForFlow.length === 0) {
                    const { inArray: inArrayInner } = await import("drizzle-orm");
                    activeCampaignsForFlow = await dbInner.select().from(campaignsTable)
                      .where(andInner(
                        eqInner(campaignsTable.wabaId, waba.id),
                        eqInner(campaignsTable.automationEnabled, true),
                        inArrayInner(campaignsTable.status, botEligibleStatuses)
                      ));
                    if (activeCampaignsForFlow.length > 1) {
                      console.warn(`[BOT] WARNING: ${activeCampaignsForFlow.length} automation-enabled campaigns found for wabaId=${waba.id} — using most recent. Campaigns: ${activeCampaignsForFlow.map(c => `${c.id}(${c.status})`).join(', ')}`);
                      activeCampaignsForFlow.sort((a, b) => {
                        const aTime = a.completedAt ? new Date(a.completedAt).getTime() : (a.updatedAt ? new Date(a.updatedAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0));
                        const bTime = b.completedAt ? new Date(b.completedAt).getTime() : (b.updatedAt ? new Date(b.updatedAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0));
                        return bTime - aTime;
                      });
                    }
                    console.log(`[BOT] Found ${activeCampaignsForFlow.length} eligible automation-enabled campaigns for wabaId=${waba.id} (statuses: ${botEligibleStatuses.join(',')})`);
                  } else {
                    console.log(`[BOT] Using conversation campaign ${convo.campaignId} (status=${activeCampaignsForFlow[0].status}) for bot flow lookup`);
                  }

                  if (!waba.accessToken) {
                    console.error(`[BOT] WABA accessToken is empty for wabaId=${waba.id} — bot responses will fail`);
                  }

                  const FALLBACK_MESSAGE = "Recebemos sua mensagem e vamos te responder em breve.";
                  const BOT_TIMEOUT_MS = 30000;

                  const NON_ACTIONABLE_MSG_TYPES = new Set(['reaction', 'unsupported', 'system']);
                  if (NON_ACTIONABLE_MSG_TYPES.has(msgType)) {
                    console.log(`[BOT] Skipping bot processing for non-actionable message type="${msgType}" metaMessageId=${metaMessageId} phone=${replyPhone}`);
                  } else {

                  type BotResult = 'handled' | 'config_error' | 'graceful_skip';
                  let lastBotResult: BotResult | null = null;

                  const runBotForCampaigns = async () => {
                  try {
                  for (const campaign of activeCampaignsForFlow) {
                    console.log(`[BOT] Processing inbound for campaign ${campaign.id} (${campaign.name}) phone=${replyPhone} phoneNumId=${phoneNumId} hasToken=${!!waba.accessToken}`);
                    try {
                      let result: BotResult | null = null;
                      let firstTimedOut = false;
                      const botProcess = botFlowEngine.processInboundMessage(
                        replyPhone, messageBody, waba.id, convo.id,
                        campaign.id, phoneNumId, waba.accessToken,
                        metaMessageId, buttonReplyId, buttonReplyTitle
                      );
                      const timeoutSentinel = '__timeout__' as const;
                      const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) =>
                        setTimeout(() => { firstTimedOut = true; resolve(timeoutSentinel); }, BOT_TIMEOUT_MS)
                      );

                      const raceResult = await Promise.race([
                        botProcess.catch((e: any) => { throw e; }),
                        timeoutPromise
                      ]);
                      if (raceResult !== timeoutSentinel) result = raceResult;

                      if (firstTimedOut) {
                        console.warn(`[ALERT_BOT_FAILURE] Bot timeout (${BOT_TIMEOUT_MS}ms) — waiting for original to settle`, { phone: replyPhone, campaignId: campaign.id });
                        try {
                          const settled = await Promise.race([
                            botProcess,
                            new Promise<typeof timeoutSentinel>((resolve) => setTimeout(() => resolve(timeoutSentinel), BOT_TIMEOUT_MS))
                          ]);
                          if (settled !== timeoutSentinel) result = settled;
                        } catch (origErr: any) {
                          result = null;
                          console.error(`[ALERT_BOT_FAILURE] Original bot call failed: ${origErr.message}`, { phone: replyPhone, campaignId: campaign.id });
                        }

                        if (!result) {
                          incrementAlertCounter('botFailures');
                          console.warn(`[ALERT_BOT_FAILURE] Original failed/timed out — retrying once`, { phone: replyPhone, campaignId: campaign.id });
                          try {
                            const retried = await Promise.race([
                              botFlowEngine.processInboundMessage(
                                replyPhone, messageBody, waba.id, convo.id,
                                campaign.id, phoneNumId, waba.accessToken,
                                metaMessageId, buttonReplyId, buttonReplyTitle
                              ).catch((e: any) => { throw e; }),
                              new Promise<typeof timeoutSentinel>((resolve) => setTimeout(() => resolve(timeoutSentinel), BOT_TIMEOUT_MS))
                            ]);
                            if (retried !== timeoutSentinel) result = retried;
                          } catch (retryErr: any) {
                            console.error(`[ALERT_BOT_FAILURE] Bot retry also failed: ${retryErr.message}`, { phone: replyPhone, campaignId: campaign.id });
                            throw retryErr;
                          }
                        }
                      }

                      lastBotResult = result;
                      if (result === 'handled' || result === 'graceful_skip') {
                        console.log(`[BOT] Bot flow result=${result} for phone=${replyPhone} campaignId=${campaign.id}`);
                        campaignMatched = true;
                        break;
                      } else if (result === 'config_error') {
                        console.log(`[BOT] Bot flow config_error for phone=${replyPhone} campaignId=${campaign.id} — trying next campaign if available`);
                      } else {
                        console.log(`[BOT] Bot flow timed out (no result) for phone=${replyPhone} campaignId=${campaign.id}`);
                      }
                    } catch (flowErr: any) {
                      console.error(`[ALERT_BOT_FAILURE] Bot flow ERROR for phone=${replyPhone} campaignId=${campaign.id}: ${flowErr.message}`, { stack: flowErr.stack });
                      incrementAlertCounter('botFailures');
                      routeError("routes.botFlowProcess", { phone: replyPhone, campaignId: campaign.id }, flowErr);
                    }
                  }

                  if (!campaignMatched) {
                    // Determine whether to send generic fallback:
                    // (a) No eligible campaigns found at all → fallback
                    // (b) All campaigns returned config_error or timed out (critical technical failure) → fallback
                    // (c) graceful_skip (CSW pause, node recovery, send-failure with retry pending) → NO fallback
                    const shouldSendFallback = activeCampaignsForFlow.length === 0 || lastBotResult === 'config_error' || lastBotResult === null;
                    const fallbackReason = activeCampaignsForFlow.length === 0
                      ? 'no_eligible_campaigns'
                      : lastBotResult === 'config_error'
                        ? 'bot_config_error'
                        : 'bot_timeout';
                    if (shouldSendFallback) {
                      incrementAlertCounter('unknownLeads');
                      console.warn(`[FLOW_FALLBACK_REASON] reason=${fallbackReason} phone=${replyPhone} wabaId=${waba.id}`);
                      const mostRecentCampaign = activeCampaignsForFlow[0];
                      try {
                        await wabaStorage.updateConversation(convo.id, {
                          ...(mostRecentCampaign && !convo.campaignId ? { campaignId: mostRecentCampaign.id } : {}),
                          lastMessagePreview: `[${fallbackReason}] ${messageBody?.substring(0, 60) || ''}`,
                        });
                      } catch (markErr: any) {
                        console.error(`[ALERT_BOT_FAILURE] Failed to update conversation convo=${convo.id}: ${markErr.message}`);
                      }
                      try {
                        await withSendQueue(replyPhone, () =>
                          metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, FALLBACK_MESSAGE, waba.accessToken)
                        );
                        await wabaStorage.createMessage({
                          conversationId: convo.id,
                          direction: "outbound",
                          body: FALLBACK_MESSAGE,
                          type: "text",
                          status: "sent",
                        });
                        console.log(`[BOT] Fallback message sent — reason=${fallbackReason} phone=${replyPhone}`);
                        unknownLeadFallbackSent = true;
                      } catch (fallbackErr: any) {
                        console.error(`[ALERT_BOT_FAILURE] Failed to send fallback phone=${replyPhone}: ${fallbackErr.message}`);
                        incrementAlertCounter('botFailures');
                      }
                    } else {
                      // graceful_skip: CSW pause, node recovery, or send failure with retry pending.
                      // Flow engine already handled the state correctly — no fallback needed.
                      console.log(`[BOT] graceful_skip for phone=${replyPhone} — no fallback sent (CSW pause / node recovery / send retry pending)`);
                    }
                  }
                  } catch (catchAllErr: any) {
                    console.error(`[ALERT_BOT_FAILURE] Unhandled exception in bot processing for phone=${replyPhone}: ${catchAllErr.message}`, { stack: catchAllErr.stack });
                    incrementAlertCounter('botFailures');
                    try {
                      await withSendQueue(replyPhone, () =>
                        metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, FALLBACK_MESSAGE, waba.accessToken)
                      );
                      await wabaStorage.createMessage({
                        conversationId: convo.id,
                        direction: "outbound",
                        body: FALLBACK_MESSAGE,
                        type: "text",
                        status: "sent",
                      });
                      console.log(`[BOT] Catch-all fallback message sent to phone=${replyPhone}`);
                    } catch (catchAllSendErr: any) {
                      console.error(`[ALERT_BOT_FAILURE] Catch-all fallback also failed for phone=${replyPhone}: ${catchAllSendErr.message}`);
                    }
                  }
                  }; // end runBotForCampaigns

                  // ─── Debounce: last-message-wins (intentional) ───────────────────────────
                  // Rapid messages from the same user within 2000ms cancel previous timers,
                  // so only the final message triggers bot execution. This is correct for a
                  // state-machine bot: intermediate messages would cause duplicate state
                  // transitions. If FIFO-queue-all is ever needed, replace this with a direct
                  // call to runBotForCampaigns() — withPhoneMutex already ensures ordering.
                  // See scheduleWithDebounce in BotFlowEngine.ts for full rationale.
                  // ─────────────────────────────────────────────────────────────────────────
                  const debounceKey = `${replyPhone}:${waba.id}`;
                  scheduleWithDebounce(debounceKey, () => {
                    runBotForCampaigns().catch((err: any) => {
                      console.error(`[ALERT_BOT_FAILURE] Debounced bot processing failed for phone=${replyPhone}: ${err.message}`, { stack: err.stack });
                    });
                  });
                  } // end else (non-actionable type check)
                } else {
                  console.warn(`[ALERT_BOT_FAILURE] No WABA numbers found for wabaId=${waba.id} — cannot process bot flows for phone=${senderPhone}`);
                  incrementAlertCounter('botFailures');
                  const noNumFallbackMsg = "Recebemos sua mensagem e vamos te responder em breve.";
                  try {
                    const fallbackPhoneNumId = phoneNumberId;
                    if (fallbackPhoneNumId && waba.accessToken) {
                      const fallbackPhone = canonicalPhone(senderPhone);
                      await withSendQueue(fallbackPhone, () =>
                        metaAPI.sendFreeFormMessage(fallbackPhoneNumId, fallbackPhone, noNumFallbackMsg, waba.accessToken)
                      );
                      await wabaStorage.createMessage({
                        conversationId: convo.id,
                        direction: "outbound",
                        body: noNumFallbackMsg,
                        type: "text",
                        status: "sent",
                      });
                      console.log(`[BOT] Fallback sent despite no WABA numbers for phone=${senderPhone}`);
                    } else {
                      console.error(`[ALERT_BOT_FAILURE] Cannot send fallback — no phoneNumId/token for waba=${waba.id} phone=${senderPhone}`);
                    }
                  } catch (noNumErr: any) {
                    console.error(`[ALERT_BOT_FAILURE] Fallback send failed (no WABA numbers path) for phone=${senderPhone}: ${noNumErr.message}`);
                  }
                }

                async function sendBotResponse(rule: { response: string; responseType?: string | null; mediaUrl?: string | null; buttonPayload?: any }, phoneNumId: string, token: string, convoId: string) {
                  const ruleType = rule.responseType || "text";
                  const ruleMediaUrl = rule.mediaUrl || "";
                  let sendSuccess = true;

                  const delay = (minS: number, maxS: number) => new Promise<void>(r => setTimeout(r, (minS + crypto.randomInt(0, Math.max(1, Math.floor((maxS - minS) * 1000))) / 1000) * 1000));
                  await delay(2, 8);

                  try {
                    await withSendQueue(replyPhone, async () => {
                      if (ruleType === "combined" && ruleMediaUrl) {
                        if (ruleMediaUrl.match(/\.(mp3|ogg|opus|wav|aac|m4a|webm|amr|mp4)(\?|$)/i)) {
                          const audioValidation = validateAudioUrl(ruleMediaUrl);
                          if (!audioValidation.valid) throw new Error(audioValidation.error);
                          let textSent = false;
                          if (rule.response) {
                            await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, rule.response, token);
                            textSent = true;
                            await delay(1, 3);
                          }
                          try {
                            await delay(2, 4);
                            await sendAudioWithRetry(phoneNumId, replyPhone, ruleMediaUrl, token);
                            await delay(1, 3);
                          } catch (audioErr: any) {
                            routeError('bot.sendBotResponse.partialDelivery', {
                              phone: replyPhone,
                              ruleType: 'combined',
                              phase: 'audio',
                              textSent,
                              mediaUrl: ruleMediaUrl,
                            }, audioErr);
                          }
                        } else {
                          try {
                            await metaAPI.sendImageMessage(phoneNumId, replyPhone, ruleMediaUrl, rule.response || undefined, token);
                          } catch (imgErr: any) {
                            routeError('bot.sendBotResponse.imageFallback', { phone: replyPhone, ruleType: 'combined', mediaUrl: ruleMediaUrl }, imgErr);
                            if (rule.response) {
                              await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, rule.response, token);
                            } else {
                              throw imgErr;
                            }
                          }
                        }
                      } else if (ruleType === "audio" && ruleMediaUrl) {
                        const audioValidation = validateAudioUrl(ruleMediaUrl);
                        if (!audioValidation.valid) throw new Error(audioValidation.error);
                        await delay(2, 4);
                        await sendAudioWithRetry(phoneNumId, replyPhone, ruleMediaUrl, token);
                        await delay(1, 3);
                      } else if (ruleType === "image" && ruleMediaUrl) {
                        try {
                          await metaAPI.sendImageMessage(phoneNumId, replyPhone, ruleMediaUrl, rule.response || undefined, token);
                        } catch (imgErr: any) {
                          routeError('bot.sendBotResponse.imageFallback', { phone: replyPhone, ruleType: 'image', mediaUrl: ruleMediaUrl }, imgErr);
                          if (rule.response) {
                            await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, rule.response, token);
                          } else {
                            throw imgErr;
                          }
                        }
                      } else if (ruleType === "buttons" && rule.buttonPayload) {
                        const btns = Array.isArray(rule.buttonPayload) ? rule.buttonPayload : [];
                        await sendButtons(phoneNumId, replyPhone, rule.response, btns, token);
                      } else if (ruleType === "list" && rule.buttonPayload) {
                        const listPayload = rule.buttonPayload as any;
                        await sendList(phoneNumId, replyPhone, rule.response, listPayload, token);
                      } else {
                        await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, rule.response, token);
                      }
                    });
                  } catch (sendErr: any) {
                    routeError('bot.sendBotResponse', { phone: replyPhone, ruleType, mediaUrl: ruleMediaUrl || undefined }, sendErr);
                    sendSuccess = false;
                  }

                  await wabaStorage.createMessage({
                    conversationId: convoId,
                    direction: "outbound",
                    body: rule.response || `[${ruleType}]`,
                    type: ruleType === "buttons" || ruleType === "list" ? "interactive" : ruleType,
                    mediaUrl: ruleMediaUrl || undefined,
                    status: sendSuccess ? "sent" : "failed",
                  });
                }

                if (!campaignMatched && !unknownLeadFallbackSent && numbers.length > 0) {
                  const phoneNumId = numbers[0].phoneNumberId;
                  const { botFlows: botFlowsTable } = await import("@shared/schema");

                  console.log(`[BOT] No bot flow matched — checking campaign automation rules for phone=${replyPhone} wabaId=${waba.id}`);

                  const activeCampaigns = await dbInner.select().from(campaignsTable)
                    .where(andInner(
                      eqInner(campaignsTable.wabaId, waba.id),
                      eqInner(campaignsTable.automationEnabled, true),
                      eqInner(campaignsTable.status, "running")
                    ));

                  for (const campaign of activeCampaigns) {
                    const [activeFlow] = await dbInner.select({ id: botFlowsTable.id }).from(botFlowsTable)
                      .where(andInner(
                        eqInner(botFlowsTable.campaignId, campaign.id),
                        eqInner(botFlowsTable.isActive, true)
                      ));
                    if (activeFlow) continue;

                    const rules = await wabaStorage.getAutomationRules(campaign.id);

                    for (const rule of rules) {
                      const keywordLower = rule.keyword.toLowerCase();
                      const matched = (buttonReplyId && buttonReplyId.toLowerCase() === keywordLower) ||
                        (buttonReplyTitle && buttonReplyTitle.toLowerCase() === keywordLower) ||
                        messageBody.toLowerCase().includes(keywordLower);
                      if (matched) {
                        await sendBotResponse(rule, phoneNumId, waba.accessToken, convo.id);
                        campaignMatched = true;
                        break;
                      }
                    }

                    if (!campaignMatched && campaign.automationFallback === "conversion") {
                      const fallbackMsg = "Obrigado pelo seu contato! Sua mensagem foi recebida e registrada como conversão.";
                      try {
                        await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, fallbackMsg, waba.accessToken);
                        await wabaStorage.createMessage({
                          conversationId: convo.id,
                          direction: "outbound",
                          body: fallbackMsg,
                          type: "text",
                          status: "sent",
                        });
                      } catch (fallbackErr) {
                        routeError("routes.automationConversionFallback", { phone: replyPhone }, fallbackErr);
                      }
                    }

                    if (!campaignMatched && campaign.automationFallback === "default") {
                      const cfg = campaign.botConfig as Record<string, unknown> | null | undefined;
                      const customMsg = (cfg?.fallbackMessage as string | undefined)?.trim();
                      const fallbackMsg = customMsg || 'Desculpe, não entendi sua resposta. Por favor, tente novamente.';
                      try {
                        await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, fallbackMsg, waba.accessToken);
                        await wabaStorage.createMessage({
                          conversationId: convo.id,
                          direction: "outbound",
                          body: fallbackMsg,
                          type: "text",
                          status: "sent",
                        });
                        campaignMatched = true;
                      } catch (fallbackErr) {
                        routeError("routes.automationDefaultFallback", { phone: replyPhone }, fallbackErr);
                      }
                    }

                    if (campaignMatched) break;
                  }

                  if (!campaignMatched) {
                    const botConfig = await wabaStorage.getBotSettings(waba.userId);
                    if (botConfig?.isActive) {
                      const globalRules = await wabaStorage.getActiveBotRules(waba.userId);
                      let globalMatched = false;

                      for (const rule of globalRules) {
                        const keywordLower = rule.keyword.toLowerCase();
                        const matched = (buttonReplyId && buttonReplyId.toLowerCase() === keywordLower) ||
                          (buttonReplyTitle && buttonReplyTitle.toLowerCase() === keywordLower) ||
                          messageBody.toLowerCase().includes(keywordLower);
                        if (matched) {
                          await sendBotResponse(rule, phoneNumId, waba.accessToken, convo.id);
                          globalMatched = true;
                          break;
                        }
                      }

                      if (!globalMatched && botConfig.fallbackMessage) {
                        try {
                          await metaAPI.sendFreeFormMessage(phoneNumId, replyPhone, botConfig.fallbackMessage, waba.accessToken);
                          await wabaStorage.createMessage({
                            conversationId: convo.id,
                            direction: "outbound",
                            body: botConfig.fallbackMessage,
                            type: "text",
                            status: "sent",
                          });
                        } catch (fbErr) {
                          routeError("routes.botGlobalFallback", { phone: replyPhone }, fbErr);
                        }
                      }
                    }
                  }
                }

                if (!campaignMatched) {
                  console.log(`[WEBHOOK] Routing: no campaign, flow, or automation rule matched for phone=${replyPhone} wabaId=${waba.id} — message stored in conversation ${convo.id}`);
                }
              } catch (autoErr) {
                routeError("routes.webhookAutomation", { phone: senderPhone }, autoErr);
              }
            }

            const messages: any[] = change?.value?.messages || [];
            for (const msg of messages) {
              const senderPhone: string = msg.from || '';
              const phoneNumberId: string = change?.value?.metadata?.phone_number_id || '';
              const bsuid: string = msg.bsuid || '';
              const resolvedPhone = senderPhone || bsuid;

              if (!resolvedPhone) {
                console.warn(`[WEBHOOK_DROP]`, { reason: 'resolvedPhone empty in legacy handler', metaMessageId: msg.id || 'unknown' });
                continue;
              }

              console.log(`📩 [WEBHOOK] Mensagem inbound de ${resolvedPhone}`);

              let resolvedWabaForMsg = phoneNumberId ? await wabaStorage.findWabaByPhoneNumberId(phoneNumberId) : undefined;
              if (!resolvedWabaForMsg) {
                console.warn(`[WEBHOOK] No WABA found for phoneNumberId=${phoneNumberId || 'unknown'} — campaign match may be unscoped for phone=${resolvedPhone}`);
              }

              let matchedCampaignId = await storage.getCampaignForLead(resolvedPhone, resolvedWabaForMsg?.id);

              if (!matchedCampaignId && resolvedWabaForMsg) {
                const activeCampaigns = await db.select().from(campaignsSchema).where(and(eq(campaignsSchema.wabaId, resolvedWabaForMsg.id), eq(campaignsSchema.status, "running")));
                if (activeCampaigns.length > 0) {
                  matchedCampaignId = activeCampaigns[0].id;
                  console.log(`[WEBHOOK] Fallback: matched running campaign ${matchedCampaignId} by WABA for phone=${resolvedPhone}`);
                }
              }

              await cswTracker.registerInbound(resolvedPhone, matchedCampaignId, phoneNumberId);

              if (matchedCampaignId) {
                await conversionTriggerService.onInboundMessage(resolvedPhone, phoneNumberId, matchedCampaignId);
                EngagementManager.markReplied(matchedCampaignId, resolvedPhone).catch(err => routeError('markReplied', { campaignId: matchedCampaignId, phone: resolvedPhone }, err));
              }
            }
          }
        }
  }

  app.get("/api/campaigns/:id/delivery-stats", async (req, res) => {
    try {
      const stats = await getDeliveryStatsFromDb(req.params.id);
      res.json(stats);
    } catch (err: any) {
      routeError('getApiCampaignsDeliverystats', {}, err);
      res.status(500).json({ error: err.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // CSW & Conversion Status
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/csw/stats", (_req, res) => {
    res.json(cswTracker.getStats());
  });

  app.get("/api/csw/check/:phone", async (req, res) => {
    const phone = req.params.phone;
    const isOpen = await cswTracker.isCSWOpen(phone);
    const session = await cswTracker.getSession(phone);
    res.json({ phone, isOpen, session });
  });

  app.get("/api/conversions/stats", (_req, res) => {
    res.json(conversionTriggerService.getStats());
  });

  app.get("/api/campaigns/:id/conversions", async (req, res) => {
    const count = conversionTriggerService.getConversionCount(req.params.id);
    res.json({ campaignId: req.params.id, conversionsSent: count });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Phone Soft Quotas
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/phone-quotas", (_req, res) => {
    const states = bmQualityMonitor.getAllStates();
    res.json(states);
  });

  app.get("/api/phone-quotas/:phoneId", async (req, res) => {
    const state = bmQualityMonitor.getPhoneState(req.params.phoneId);
    if (!state) {
      return res.status(404).json({ error: "Phone not found" });
    }
    res.json(state);
  });

  app.patch("/api/phone-quotas/:phoneId", async (req, res) => {
    const { softQuota } = req.body;
    if (typeof softQuota !== 'number' || softQuota < 0) {
      return res.status(400).json({ error: "softQuota must be a non-negative number" });
    }
    bmQualityMonitor.setSoftQuota(req.params.phoneId, softQuota);
    res.json({ phoneId: req.params.phoneId, softQuota });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // BM Quality Monitor
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/quality-monitor/stats", (_req, res) => {
    res.json(bmQualityMonitor.getStats());
  });

  app.post("/api/quality-monitor/start", async (req, res) => {
    try {
      const config = await getApiConfigFromDbOrStorage(req.session.userId!);
      if (!config || !config.isValid) {
        return res.status(400).json({ error: "Valid API configuration required" });
      }

      const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      const phoneIds = phoneNumbers.map(p => p.id);

      bmQualityMonitor.onCritical((phoneId, score) => {
        console.log(`🛑 [QualityMonitor→Engine] Número ${phoneId} score=${score} — pausando engines`);
        for (const [cid, engine] of activeUltraEngines.entries()) {
          if (engine.isActive()) {
            engine.pauseCampaign();
            campaignStore.addLog(cid, 'WARN', `Número ${phoneId} pausado por qualidade (score=${score})`);
          }
        }
      });

      bmQualityMonitor.onResume((phoneId) => {
        console.log(`▶️ [QualityMonitor→Engine] Número ${phoneId} retomado — resumindo engines`);
        for (const [cid, engine] of activeUltraEngines.entries()) {
          if (engine.isActive()) {
            engine.resumeCampaign();
            campaignStore.addLog(cid, 'INFO', `Número ${phoneId} retomado após pausa de qualidade`);
          }
        }
      });

      bmQualityMonitor.start(config.metaToken, phoneIds);
      res.json({ started: true, phones: phoneIds.length });
    } catch (error: any) {
      routeError('postApiQualitymonitorStart', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/quality-monitor/stop", (_req, res) => {
    bmQualityMonitor.stop();
    res.json({ stopped: true });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Stealth Scheduler Config
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/stealth/config", (_req, res) => {
    res.json(stealthScheduler.getConfig());
  });

  app.patch("/api/stealth/config", async (req, res) => {
    stealthScheduler.updateConfig(req.body);
    res.json(stealthScheduler.getConfig());
  });

  app.get("/api/stealth/stats", (_req, res) => {
    res.json(stealthScheduler.getStats());
  });

  // ────────────────────────────────────────────────────────────────────────────
  // DDI +1 Marketing Filter Check
  // ────────────────────────────────────────────────────────────────────────────

  app.post("/api/check-marketing-block", async (req, res) => {
    const { phone, templateCategory } = req.body;
    const blocked = shouldBlockMarketingTemplate(phone, templateCategory);
    res.json({ phone, templateCategory, blocked });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Quality Rating Monitoring & History (Task 4)
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/quality-rating/:wabaId", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { wabaNumbers, qualityRatingHistory } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const waba = await wabaStorage.getWabaById(req.params.wabaId);
      if (!waba) return res.status(404).json({ error: "WABA not found" });

      const numbers = await wabaStorage.getWabaNumbers(waba.id);
      const results: any[] = [];

      for (const num of numbers) {
        try {
          const status = await metaAPI.getPhoneNumberStatus(num.phoneNumberId, waba.accessToken);
          const prevRating = num.qualityRating || "UNKNOWN";
          const newRating = status.quality_rating || "UNKNOWN";

          if (prevRating !== newRating) {
            await dbInner.insert(qualityRatingHistory).values({
              phoneNumberId: num.phoneNumberId,
              wabaId: waba.id,
              qualityRating: newRating,
              previousRating: prevRating,
            });
          }

          await wabaStorage.upsertWabaNumber({
            wabaId: waba.id,
            phoneNumberId: num.phoneNumberId,
            displayNumber: num.displayNumber,
            qualityRating: newRating,
            tier: status.messaging_limit_tier,
          });

          let protectionAction: string | null = null;
          if (newRating === "RED" && prevRating !== "RED") {
            const phoneState = bmQualityMonitor.getPhoneState(num.phoneNumberId);
            if (phoneState) {
              const newQuota = Math.floor((phoneState.softQuota || 1000) * 0.25);
              bmQualityMonitor.setSoftQuota(num.phoneNumberId, newQuota);
              protectionAction = `Rate RED: quota reduced to ${newQuota} (75% reduction)`;
            }
          } else if (newRating === "YELLOW" && prevRating === "GREEN") {
            const phoneState = bmQualityMonitor.getPhoneState(num.phoneNumberId);
            if (phoneState) {
              const newQuota = Math.floor((phoneState.softQuota || 1000) * 0.5);
              bmQualityMonitor.setSoftQuota(num.phoneNumberId, newQuota);
              protectionAction = `Rate YELLOW: quota reduced to ${newQuota} (50% reduction)`;
            }
          } else if (newRating === "GREEN" && prevRating !== "GREEN" && prevRating !== "UNKNOWN") {
            const phoneState = bmQualityMonitor.getPhoneState(num.phoneNumberId);
            if (phoneState && phoneState.softQuota) {
              const newQuota = Math.floor(phoneState.softQuota * 1.5);
              bmQualityMonitor.setSoftQuota(num.phoneNumberId, newQuota);
              protectionAction = `Rate GREEN restored: quota increased to ${newQuota}`;
            }
          }

          const history = await dbInner.select().from(qualityRatingHistory)
            .where(eq(qualityRatingHistory.phoneNumberId, num.phoneNumberId))
            .orderBy(desc(qualityRatingHistory.checkedAt))
            .limit(20);

          results.push({
            phoneNumberId: num.phoneNumberId,
            displayNumber: num.displayNumber,
            qualityRating: newRating,
            previousRating: prevRating,
            tier: status.messaging_limit_tier,
            accountMode: status.account_mode,
            changed: prevRating !== newRating,
            protectionAction,
            history,
          });
        } catch (err: any) {
          results.push({
            phoneNumberId: num.phoneNumberId,
            displayNumber: num.displayNumber,
            qualityRating: num.qualityRating || "UNKNOWN",
            error: err.message,
          });
          routeError('getQualityMonitorNumbers', { phoneNumberId: num.phoneNumberId }, err);
        }
      }

      res.json({ wabaId: waba.id, numbers: results });
    } catch (error: any) {
      routeError('handler', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/quality-rating-history/:phoneNumberId", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { qualityRatingHistory } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const history = await dbInner.select().from(qualityRatingHistory)
        .where(eq(qualityRatingHistory.phoneNumberId, req.params.phoneNumberId))
        .orderBy(desc(qualityRatingHistory.checkedAt))
        .limit(50);

      res.json(history);
    } catch (error: any) {
      routeError('getApiQualityratinghistory', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Quality Rating Polling: Manual Trigger + Number Health Dashboard
  // ────────────────────────────────────────────────────────────────────────────

  app.post("/api/quality-rating/poll", async (req, res) => {
    try {
      if (!req.session?.userId) return res.status(401).json({ error: "Não autenticado" });
      const { triggerQualityPollForUser } = await import("./jobs/qualityRatingPoller");
      await triggerQualityPollForUser(req.session.userId);
      res.json({ success: true, message: "Polling de quality rating executado" });
    } catch (error: any) {
      routeError('postApiQualityRatingPoll', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/admin/debug/meta-phone-tier/:phoneNumberId", async (req, res) => {
    try {
      if (!req.session?.userId) return res.status(401).json({ error: "Não autenticado" });
      if (req.session.userRole !== "admin") return res.status(403).json({ error: "Acesso restrito a administradores" });

      const { phoneNumberId } = req.params;
      if (!phoneNumberId) return res.status(400).json({ error: "phoneNumberId obrigatório" });

      const userWabas = await wabaStorage.getWabasByUser(req.session.userId);
      let accessToken: string | null = null;
      for (const waba of userWabas) {
        const numbers = await wabaStorage.getWabaNumbers(waba.id);
        if (numbers.some((n) => n.phoneNumberId === phoneNumberId)) {
          accessToken = waba.accessToken ?? null;
          break;
        }
      }

      if (!accessToken) {
        return res.status(404).json({ error: "phoneNumberId não encontrado nas WABAs do usuário ou token ausente" });
      }

      const metaApiVersion = process.env.META_API_VERSION || 'v25.0';
      const url = `https://graph.facebook.com/${metaApiVersion}/${phoneNumberId}?fields=quality_rating,messaging_limit_tier,display_phone_number,verified_name,code_verification_status`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const rawBody = await resp.text();

      let parsed: unknown = null;
      try { parsed = JSON.parse(rawBody); } catch { /* keep null */ }

      res.json({
        phoneNumberId,
        metaApiVersion,
        httpStatus: resp.status,
        rawResponse: parsed ?? rawBody,
        messaging_limit_tier: (parsed as Record<string, unknown>)?.messaging_limit_tier ?? null,
        quality_rating: (parsed as Record<string, unknown>)?.quality_rating ?? null,
      });
    } catch (error: any) {
      routeError('getAdminDebugMetaPhoneTier', { phoneNumberId: req.params.phoneNumberId }, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/number-health", async (req, res) => {
    try {
      if (!req.session?.userId) return res.status(401).json({ error: "Não autenticado" });
      const { db: dbInner } = await import("./db");
      const { qualityRatingHistory, warmupSchedules, senderUsage } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const userWabas = await wabaStorage.getWabasByUser(req.session.userId);
      const results: {
        phoneNumberId: string;
        displayNumber: string | null;
        verifiedName: string | null;
        wabaId: string;
        wabaName: string;
        qualityRating: string;
        tier: string;
        tierLimit: number;
        sentToday: number;
        dailyQuota: number;
        warmupStage: string;
        warmupCurrentLimit: number | null;
        warmupNextTierEstimate: string | null;
        warmupDay: number | null;
        warmupTotalDays: number | null;
        recentHistory: Record<string, unknown>[];
      }[] = [];

      for (const waba of userWabas) {
        const numbers = await wabaStorage.getWabaNumbers(waba.id);
        for (const num of numbers) {
          const recentHistory = await dbInner
            .select()
            .from(qualityRatingHistory)
            .where(eq(qualityRatingHistory.phoneNumberId, num.phoneNumberId))
            .orderBy(desc(qualityRatingHistory.checkedAt))
            .limit(5);

          const [warmupSchedule] = await dbInner
            .select()
            .from(warmupSchedules)
            .where(
              eq(warmupSchedules.phoneNumberId, num.phoneNumberId)
            )
            .orderBy(desc(warmupSchedules.createdAt))
            .limit(1);

          const [usage] = await dbInner
            .select()
            .from(senderUsage)
            .where(eq(senderUsage.phoneNumberId, num.phoneNumberId))
            .limit(1);

          const qualityRating = num.qualityRating || 'UNKNOWN';
          const tier = num.tier || 'TIER_1K';

          const tierLimit = tier === 'TIER_250' ? 250
            : tier === 'TIER_1K' ? 1000
            : tier === 'TIER_10K' ? 10000
            : tier === 'TIER_100K' ? 100000
            : 999999;

          let warmupStage: string = 'none';
          let warmupCurrentLimit: number | null = null;
          let warmupNextTierEstimate: string | null = null;

          if (warmupSchedule && warmupSchedule.status === 'active') {
            const targets = (warmupSchedule.dailyTargets as number[]) || [250, 500, 1000, 2000, 5000];
            const dayIdx = Math.min(warmupSchedule.currentDay - 1, targets.length - 1);
            warmupCurrentLimit = targets[dayIdx] || targets[targets.length - 1];
            const daysRemaining = warmupSchedule.totalDays - warmupSchedule.currentDay;
            warmupNextTierEstimate = daysRemaining > 0
              ? `~${daysRemaining} dia(s)`
              : 'Atingido';
            warmupStage = 'warming';
          } else if (qualityRating === 'UNKNOWN') {
            warmupStage = 'new';
            warmupCurrentLimit = 250;
          } else {
            warmupStage = 'consolidated';
          }

          results.push({
            phoneNumberId: num.phoneNumberId,
            displayNumber: num.displayNumber,
            verifiedName: num.verifiedName,
            wabaId: waba.id,
            wabaName: waba.name,
            qualityRating,
            tier,
            tierLimit,
            sentToday: usage?.sentToday ?? 0,
            dailyQuota: usage?.dailyQuota ?? tierLimit,
            warmupStage,
            warmupCurrentLimit,
            warmupNextTierEstimate,
            warmupDay: warmupSchedule?.currentDay ?? null,
            warmupTotalDays: warmupSchedule?.totalDays ?? null,
            recentHistory: recentHistory.slice(0, 3),
          });
        }
      }

      // Collect recent RED/YELLOW transition alerts (last 24h) for active notification
      const alertSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const { gte: gteAlerts, inArray } = await import("drizzle-orm");
      const allPhoneIds = results.map(r => r.phoneNumberId);
      const recentAlerts = allPhoneIds.length > 0
        ? await dbInner
            .select()
            .from(qualityRatingHistory)
            .where(
              and(
                inArray(qualityRatingHistory.phoneNumberId, allPhoneIds),
                gteAlerts(qualityRatingHistory.checkedAt, alertSince)
              )
            )
            .orderBy(desc(qualityRatingHistory.checkedAt))
            .limit(20)
        : [];

      const criticalAlerts = recentAlerts.filter(
        a => (a.qualityRating === 'RED' || a.qualityRating === 'YELLOW') &&
             a.previousRating !== a.qualityRating
      ).map(a => ({
        phoneNumberId: a.phoneNumberId,
        displayNumber: results.find(r => r.phoneNumberId === a.phoneNumberId)?.displayNumber ?? a.phoneNumberId,
        newRating: a.qualityRating,
        previousRating: a.previousRating,
        detectedAt: a.checkedAt,
        recommendedAction: a.qualityRating === 'RED'
          ? 'Pare os envios imediatamente. Reduza volume, melhore qualidade do conteúdo e aguarde recuperação do rating.'
          : 'Reduza o volume de envios. Monitore respostas negativas e relatórios de spam.',
      }));

      res.json({ numbers: results, recentAlerts: criticalAlerts, updatedAt: new Date().toISOString() });
    } catch (error: any) {
      routeError('getApiNumberHealth', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/quality-rating-history-30d/:phoneNumberId", async (req, res) => {
    try {
      if (!req.session?.userId) return res.status(401).json({ error: "Não autenticado" });

      const phoneNumberId = req.params.phoneNumberId;

      // Authorization: verify phoneNumberId belongs to one of the user's WABAs
      const userWabas = await wabaStorage.getWabasByUser(req.session.userId);
      let authorized = false;
      for (const waba of userWabas) {
        const nums = await wabaStorage.getWabaNumbers(waba.id);
        if (nums.some((n) => n.phoneNumberId === phoneNumberId)) {
          authorized = true;
          break;
        }
      }
      if (!authorized) return res.status(403).json({ error: "Acesso não autorizado a este número" });

      const { db: dbInner } = await import("./db");
      const { qualityRatingHistory } = await import("@shared/schema");
      const { eq, desc, gte, and: andFn } = await import("drizzle-orm");

      const since = new Date();
      since.setDate(since.getDate() - 30);

      // 15-min polling × 96 intervals/day × 30 days = 2880 max points
      const history = await dbInner
        .select()
        .from(qualityRatingHistory)
        .where(
          andFn(
            eq(qualityRatingHistory.phoneNumberId, phoneNumberId),
            gte(qualityRatingHistory.checkedAt, since)
          )
        )
        .orderBy(desc(qualityRatingHistory.checkedAt))
        .limit(2880);

      res.json(history);
    } catch (error: any) {
      routeError('getApiQualityRatingHistory30d', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Real Delivery Metrics (Task 5)
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/campaigns/:id/delivery-metrics", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { messageStatus, messageDeliveries } = await import("@shared/schema");
      const { eq, sql: sqlFn } = await import("drizzle-orm");

      const campaignId = req.params.id;

      const lifecycleQuery = await dbInner.execute(sqlFn`
        WITH latest_status AS (
          SELECT DISTINCT ON (msg_id) msg_id, status
          FROM message_status
          WHERE campaign_id = ${campaignId}
          ORDER BY msg_id, ts DESC
        )
        SELECT status, count(*)::int as count FROM latest_status GROUP BY status
      `);

      let sent = 0, delivered = 0, read = 0, failed = 0;
      for (const row of lifecycleQuery.rows as any[]) {
        if (row.status === "sent" || row.status === "accepted") sent += row.count;
        if (row.status === "delivered") delivered += row.count;
        if (row.status === "read") read += row.count;
        if (row.status === "failed") failed += row.count;
      }

      const total = sent + delivered + read + failed;
      const deliveryRate = total > 0 ? ((delivered + read) / total * 100).toFixed(2) : "0.00";
      const readRate = total > 0 ? (read / total * 100).toFixed(2) : "0.00";

      const deliveries = await dbInner.select({
        avgDeliveryTime: sqlFn<number>`avg(extract(epoch from (${messageDeliveries.deliveredAt} - ${messageDeliveries.sentAt})))::float`,
      }).from(messageDeliveries)
        .where(eq(messageDeliveries.campaignId, campaignId));

      const avgDeliveryTimeSec = deliveries[0]?.avgDeliveryTime || 0;

      const repliedResult = await dbInner.execute(sqlFn`
        SELECT count(DISTINCT ms.phone)::int as count
        FROM message_status ms
        WHERE ms.campaign_id = ${campaignId}
          AND ms.status = 'replied'
      `);
      const repliedCount = [{ count: (repliedResult.rows[0] as any)?.count || 0 }];

      res.json({
        campaignId,
        sent: total,
        delivered: delivered + read,
        read,
        failed,
        deliveryRate: parseFloat(deliveryRate),
        readRate: parseFloat(readRate),
        avgDeliveryTimeSec: Math.round(avgDeliveryTimeSec * 100) / 100,
        replied: repliedCount[0]?.count || 0,
      });
    } catch (error: any) {
      routeError('getApiCampaignsDeliverymetrics', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/campaigns/:id/error-logs", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { campaignErrorLogs } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const logs = await dbInner.select().from(campaignErrorLogs)
        .where(eq(campaignErrorLogs.campaignId, req.params.id))
        .orderBy(desc(campaignErrorLogs.count))
        .limit(100);

      res.json(logs);
    } catch (error: any) {
      routeError('getApiCampaignsErrorlogs', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/campaigns/:id/error-logs", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { campaignErrorLogs } = await import("@shared/schema");
      const { eq, and, sql: sqlFn } = await import("drizzle-orm");

      const { errorCode, errorMessage, phone, phoneNumberId } = req.body;
      if (!errorCode || !errorMessage) {
        return res.status(400).json({ error: "errorCode and errorMessage are required" });
      }

      const cId = req.params.id;
      const code = String(errorCode);

      const existing = await dbInner.select().from(campaignErrorLogs)
        .where(and(
          eq(campaignErrorLogs.campaignId, cId),
          eq(campaignErrorLogs.errorCode, code)
        ))
        .limit(1);

      if (existing.length > 0) {
        await dbInner.update(campaignErrorLogs).set({
          count: sqlFn`${campaignErrorLogs.count} + 1`,
          lastOccurredAt: new Date(),
        }).where(eq(campaignErrorLogs.id, existing[0].id));
      } else {
        await dbInner.insert(campaignErrorLogs).values({
          campaignId: cId,
          errorCode: code,
          errorMessage,
          phone: phone || null,
          phoneNumberId: phoneNumberId || null,
          count: 1,
        });
      }

      res.json({ success: true });
    } catch (error: any) {
      routeError('postApiCampaignsErrorlogs', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // Per-WABA distribution snapshot for multi-WABA campaigns.
  // Returns the live weighted-RR distribution from the running engine.
  app.get("/api/campaigns/:id/waba-distribution", async (req, res) => {
    try {
      const campaignId = req.params.id;
      let distribution: any[] = [];
      let active = false;
      let globalPressure = 1;

      for (const engine of activeEngines) {
        if (engine.getCampaignId && engine.getCampaignId() === campaignId) {
          active = true;
          if (engine.getWabaDistribution) {
            distribution = engine.getWabaDistribution() || [];
          }
          if (engine.getGlobalPressure) {
            globalPressure = engine.getGlobalPressure();
          }
          break;
        }
      }

      res.json({ campaignId, active, distribution, globalPressure });
    } catch (error: any) {
      routeError('getApiCampaignsWabaDistribution', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // Lightweight admin health snapshot — reuses existing engine state, scorer and counters.
  app.get("/api/admin/health", requireAdmin, (_req, res) => {
    try {
      const dash = deliveryMetricsTracker.getDashboardData();
      const windowMs = dash.windowedRates?.windowMs || 300000;
      const sentInWindow = dash.windowedRates?.sent || 0;
      const messagesPerMinute = windowMs > 0 ? Math.round((sentInWindow / windowMs) * 60000) : 0;

      let queueSize = 0;
      let globalPressure = 1;
      const wabaMap = new Map<string, { id: string; score: number; weight: number; blockRate: number }>();

      for (const engine of activeEngines) {
        try {
          if (engine.getGlobalPressure) globalPressure = engine.getGlobalPressure();
          const dist = engine.getWabaDistribution ? (engine.getWabaDistribution() || []) : [];
          for (const d of dist) {
            const id = (d as any).wabaId || (d as any).id;
            if (!id) continue;
            wabaMap.set(id, {
              id,
              score: Number((d as any).score ?? 0),
              weight: Number((d as any).weight ?? 0),
              blockRate: Number((d as any).blockRate ?? 0),
            });
          }
        } catch {}
      }

      const metaStatus: "ok" | "error" = dash.autoPaused ? "error" : "ok";

      res.json({
        metaStatus,
        queueSize,
        activeJobs: activeEngines.size,
        messagesPerMinute,
        globalPressure,
        wabas: Array.from(wabaMap.values()),
      });
    } catch (error: any) {
      res.status(500).json({ metaStatus: "error", error: error?.message || "internal_error" });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Warm-up Scheduler (Task 6)
  // ────────────────────────────────────────────────────────────────────────────

  const DEFAULT_WARMUP_TARGETS = [250, 500, 1000, 2000, 5000, 10000, 20000];

  app.post("/api/warmup/create", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");

      const { phoneNumberId, wabaId, dailyTargets } = req.body;
      if (!phoneNumberId || !wabaId) {
        return res.status(400).json({ error: "phoneNumberId and wabaId are required" });
      }

      const targets = dailyTargets || DEFAULT_WARMUP_TARGETS;

      const [schedule] = await dbInner.insert(warmupSchedules).values({
        phoneNumberId,
        wabaId,
        status: "active",
        currentDay: 1,
        totalDays: targets.length,
        dailyTargets: targets,
        sentToday: 0,
      }).returning();

      res.json(schedule);
    } catch (error: any) {
      routeError('postApiWarmupCreate', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/warmup/:wabaId", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const schedules = await dbInner.select().from(warmupSchedules)
        .where(eq(warmupSchedules.wabaId, req.params.wabaId));

      res.json(schedules);
    } catch (error: any) {
      routeError('getApiWarmup', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/warmup/status/:phoneNumberId", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [schedule] = await dbInner.select().from(warmupSchedules)
        .where(and(
          eq(warmupSchedules.phoneNumberId, req.params.phoneNumberId),
          eq(warmupSchedules.status, "active")
        ));

      if (!schedule) {
        return res.json({ active: false });
      }

      const targets = schedule.dailyTargets as number[];
      const currentTarget = targets[Math.min(schedule.currentDay - 1, targets.length - 1)] || 0;
      const progress = currentTarget > 0 ? Math.min(100, (schedule.sentToday / currentTarget) * 100) : 0;
      const remaining = Math.max(0, currentTarget - schedule.sentToday);

      res.json({
        active: true,
        currentDay: schedule.currentDay,
        totalDays: schedule.totalDays,
        currentTarget,
        sentToday: schedule.sentToday,
        remaining,
        limitReached: schedule.sentToday >= currentTarget,
        progress: Math.round(progress * 100) / 100,
        status: schedule.status,
      });
    } catch (error: any) {
      routeError('getApiWarmupStatus', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/increment/:phoneNumberId", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq, and, sql: sqlFn } = await import("drizzle-orm");

      const count = req.body.count || 1;

      const [schedule] = await dbInner.select().from(warmupSchedules)
        .where(and(
          eq(warmupSchedules.phoneNumberId, req.params.phoneNumberId),
          eq(warmupSchedules.status, "active")
        ));

      if (!schedule) {
        return res.json({ warmupActive: false, allowed: true });
      }

      const targets = schedule.dailyTargets as number[];
      const currentTarget = targets[Math.min(schedule.currentDay - 1, targets.length - 1)] || 0;

      if (schedule.sentToday + count > currentTarget) {
        return res.json({
          warmupActive: true,
          allowed: false,
          remaining: Math.max(0, currentTarget - schedule.sentToday),
          currentTarget,
          sentToday: schedule.sentToday,
        });
      }

      const [updated] = await dbInner.update(warmupSchedules).set({
        sentToday: schedule.sentToday + count,
        lastSendAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(warmupSchedules.id, schedule.id)).returning();

      res.json({
        warmupActive: true,
        allowed: true,
        sentToday: updated.sentToday,
        remaining: Math.max(0, currentTarget - updated.sentToday),
        currentTarget,
      });
    } catch (error: any) {
      routeError('postApiWarmupIncrement', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/warmup/limit/:phoneNumberId", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [schedule] = await dbInner.select().from(warmupSchedules)
        .where(and(
          eq(warmupSchedules.phoneNumberId, req.params.phoneNumberId),
          eq(warmupSchedules.status, "active")
        ));

      if (!schedule) {
        return res.json({ warmupActive: false, maxLeads: null });
      }

      const targets = schedule.dailyTargets as number[];
      const currentTarget = targets[Math.min(schedule.currentDay - 1, targets.length - 1)] || 0;
      const remaining = Math.max(0, currentTarget - schedule.sentToday);

      res.json({
        warmupActive: true,
        maxLeads: remaining,
        currentDay: schedule.currentDay,
        currentTarget,
        sentToday: schedule.sentToday,
      });
    } catch (error: any) {
      routeError('getApiWarmupLimit', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/:id/advance", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const [schedule] = await dbInner.select().from(warmupSchedules)
        .where(eq(warmupSchedules.id, req.params.id));

      if (!schedule) return res.status(404).json({ error: "Schedule not found" });

      const nextDay = schedule.currentDay + 1;
      const newStatus = nextDay > schedule.totalDays ? "completed" : "active";

      const [updated] = await dbInner.update(warmupSchedules).set({
        currentDay: nextDay,
        sentToday: 0,
        status: newStatus,
        updatedAt: new Date(),
      }).where(eq(warmupSchedules.id, req.params.id)).returning();

      res.json(updated);
    } catch (error: any) {
      routeError('postApiWarmupAdvance', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/:id/pause", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const [updated] = await dbInner.update(warmupSchedules).set({
        status: "paused",
        updatedAt: new Date(),
      }).where(eq(warmupSchedules.id, req.params.id)).returning();

      if (!updated) return res.status(404).json({ error: "Schedule not found" });
      res.json(updated);
    } catch (error: any) {
      routeError('postApiWarmupPause', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/warmup/:id/resume", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const [updated] = await dbInner.update(warmupSchedules).set({
        status: "active",
        updatedAt: new Date(),
      }).where(eq(warmupSchedules.id, req.params.id)).returning();

      if (!updated) return res.status(404).json({ error: "Schedule not found" });
      res.json(updated);
    } catch (error: any) {
      routeError('postApiWarmupResume', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/warmup/:id", async (req, res) => {
    try {
      const { db: dbInner } = await import("./db");
      const { warmupSchedules } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      await dbInner.delete(warmupSchedules).where(eq(warmupSchedules.id, req.params.id));
      res.json({ success: true });
    } catch (error: any) {
      routeError('deleteApiWarmup', {}, error);
      res.status(500).json({ error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Image URL Validation (Task 1)
  // ────────────────────────────────────────────────────────────────────────────

  app.post("/api/validate-image-url", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "url is required" });

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (e: any) {
        console.debug('[routes] URL validation failed', { url: url?.substring(0, 200), error: e.message });
        return res.json({ url, accessible: false, isImage: false, valid: false, error: "Invalid URL" });
      }

      if (!["https:", "http:"].includes(parsed.protocol)) {
        return res.json({ url, accessible: false, isImage: false, valid: false, error: "Only HTTP/HTTPS allowed" });
      }

      const blockedPatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|fc|fd|fe80)/i;
      if (blockedPatterns.test(parsed.hostname)) {
        return res.json({ url, accessible: false, isImage: false, valid: false, error: "Private/internal URLs not allowed" });
      }

      const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000), redirect: "manual" });
      if (response.type === "opaqueredirect" || (response.status >= 301 && response.status <= 308)) {
        return res.json({ url, accessible: false, isImage: false, valid: false, error: "Redirects not allowed" });
      }
      const contentType = response.headers.get("content-type") || "";
      const isImage = contentType.startsWith("image/");
      const isAccessible = response.ok;

      res.json({
        url,
        accessible: isAccessible,
        isImage,
        contentType,
        status: response.status,
        valid: isAccessible && isImage,
      });
    } catch (error: any) {
      routeError('postValidateImageUrl', { url: String(req.body?.url || '').slice(0, 200) }, error);
      res.json({ url: req.body.url, accessible: false, isImage: false, valid: false, error: error.message });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // BOT GLOBAL RULES ENDPOINTS
  // ────────────────────────────────────────────────────────────────────────────

  app.get("/api/bot/settings", async (req, res) => {
    try {
      const settings = await wabaStorage.getBotSettings(req.session.userId!);
      res.json(settings || { isActive: false, fallbackMessage: "" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getApiBotSettings', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.put("/api/bot/settings", async (req, res) => {
    try {
      const { isActive, fallbackMessage } = req.body;
      const settings = await wabaStorage.upsertBotSettings(req.session.userId!, { isActive, fallbackMessage });
      res.json(settings);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('putBotSettings', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/bot/rules", async (req, res) => {
    try {
      const rules = await wabaStorage.getBotRules(req.session.userId!);
      res.json(rules);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('getBotRules', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/bot/rules", async (req, res) => {
    try {
      const { keyword, response, responseType, mediaUrl, buttonPayload, isActive } = req.body;
      const mediaOptionalTypes = ["image", "audio"];
      const effectiveType = responseType || "text";
      if (!keyword) return res.status(400).json({ error: "Keyword é obrigatória" });
      if (!response && !(mediaOptionalTypes.includes(effectiveType) && mediaUrl)) {
        return res.status(400).json({ error: "Resposta ou mídia é obrigatória" });
      }
      const existingRules = await wabaStorage.getBotRules(req.session.userId!);
      const nextPriority = existingRules.length > 0
        ? Math.max(...existingRules.map((r: any) => r.priority ?? 0)) + 1
        : 0;
      const rule = await wabaStorage.createBotRule({
        userId: req.session.userId!,
        keyword,
        response: response || "",
        responseType: effectiveType,
        mediaUrl,
        buttonPayload,
        priority: nextPriority,
        isActive: isActive ?? true,
      });
      res.json(rule);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postBotRule', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.put("/api/bot/rules/reorder", async (req, res) => {
    try {
      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds)) return res.status(400).json({ error: "orderedIds deve ser um array" });
      const userId = req.session.userId!;
      await Promise.all(
        orderedIds.map((id: string, index: number) =>
          wabaStorage.updateBotRule(id, userId, { priority: index })
        )
      );
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('putBotRulesReorder', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.put("/api/bot/rules/:id", async (req, res) => {
    try {
      const { keyword, response, responseType, mediaUrl, buttonPayload, priority, isActive } = req.body;
      const rule = await wabaStorage.updateBotRule(req.params.id, req.session.userId!, {
        keyword, response, responseType, mediaUrl, buttonPayload, priority, isActive,
      });
      if (!rule) return res.status(404).json({ error: "Regra não encontrada" });
      res.json(rule);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('putBotRule', {}, error);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/bot/rules/:id", async (req, res) => {
    try {
      await wabaStorage.deleteBotRule(req.params.id, req.session.userId!);
      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('deleteBotRule', {}, error);
      res.status(500).json({ error: message });
    }
  });

  const WHATSAPP_NATIVE_AUDIO_EXTS = new Set([".ogg", ".mp3", ".aac", ".m4a", ".amr"]);
  const TRANSCODABLE_AUDIO_EXTS = new Set([".webm", ".wav", ".mp4", ".opus", ".oga"]);

  function transcodeToOgg(inputPath: string, outputPath: string, isWebm: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg(inputPath);
      if (isWebm) {
        cmd.inputOptions(['-analyzeduration', '100M', '-probesize', '100M', '-f', 'webm']);
      }
      cmd
        .audioCodec("libopus")
        .format("ogg")
        .on("error", (err: Error) => reject(err))
        .on("end", () => resolve())
        .save(outputPath);
    });
  }

  function transcodeToOggFallback(inputPath: string, outputPath: string, isWebm: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const cmd = ffmpeg(inputPath);
      if (isWebm) {
        cmd.inputOptions(['-f', 'webm', '-strict', '-2']);
      }
      cmd
        .audioCodec("libopus")
        .format("ogg")
        .on("error", (err: Error) => reject(err))
        .on("end", () => resolve())
        .save(outputPath);
    });
  }

  function mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      "audio/webm": ".webm",
      "video/webm": ".webm",
      "audio/wav": ".wav",
      "audio/wave": ".wav",
      "audio/ogg": ".ogg",
      "audio/mpeg": ".mp3",
      "audio/mp3": ".mp3",
      "audio/mp4": ".m4a",
      "audio/aac": ".aac",
      "audio/amr": ".amr",
      "audio/opus": ".opus",
    };
    return map[mime] || "";
  }

  app.post("/api/bot/rules/upload-media", chatMediaUpload.single("media"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Arquivo é obrigatório" });

      const audioMime = req.file.mimetype || "";
      const nameExt = path.extname(req.file.originalname || req.file.filename).toLowerCase();
      const knownExts = new Set([...WHATSAPP_NATIVE_AUDIO_EXTS, ...TRANSCODABLE_AUDIO_EXTS]);
      const originalExt = (nameExt && knownExts.has(nameExt)) ? nameExt : (mimeToExt(audioMime) || nameExt);
      const isWebm = originalExt === ".webm" || audioMime === "audio/webm" || audioMime === "video/webm";

      if (audioMime.startsWith("audio/") || audioMime.startsWith("video/webm")) {
        const needsTranscode = TRANSCODABLE_AUDIO_EXTS.has(originalExt) || (!WHATSAPP_NATIVE_AUDIO_EXTS.has(originalExt) && !TRANSCODABLE_AUDIO_EXTS.has(originalExt));

        if (needsTranscode) {
          const fileExt = nameExt || path.extname(req.file.filename);
          const baseName = path.basename(req.file.filename, fileExt);
          const outputFilename = `${baseName}.ogg`;
          const outputPath = path.join(CHAT_MEDIA_DIR, outputFilename);
          let transcodeErr: unknown = null;
          try {
            await transcodeToOgg(req.file.path, outputPath, isWebm);
            transcodeErr = null;
          } catch (err1: unknown) {
            transcodeErr = err1;
            try {
              await transcodeToOggFallback(req.file.path, outputPath, isWebm);
              transcodeErr = null;
            } catch (err2: unknown) {
              transcodeErr = err2;
            }
          }
          if (transcodeErr !== null) {
            fs.promises.unlink(req.file.path).catch(() => {});
            routeError('postBotRuleUploadMedia.transcode', { originalExt, audioMime }, transcodeErr);
            const msg = transcodeErr instanceof Error ? transcodeErr.message : "Erro desconhecido";
            return res.status(500).json({ error: `Falha ao converter áudio para ogg: ${msg}. Tente gravar novamente ou use outro formato.` });
          }
          fs.promises.unlink(req.file.path).catch(() => {});
          const publicDomain = getPublicDomain();
          const mediaUrl = `${publicDomain}/uploads/chat-media/${outputFilename}`;
          return res.json({ url: mediaUrl, filename: outputFilename });
        }
      }

      const publicDomain = getPublicDomain();
      const mediaUrl = `${publicDomain}/uploads/chat-media/${req.file.filename}`;
      res.json({ url: mediaUrl, filename: req.file.originalname });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Erro desconhecido";
      routeError('postBotRuleUploadMedia', {}, error);
      res.status(500).json({ error: message });
    }
  });

    // ──────────────────────────────────────────────────────────────────────────
  // VOICE PROFILES — CRUD
  // ──────────────────────────────────────────────────────────────────────────

  const VOICE_PROFILES_DIR = path.join(__dirname_routes, '../uploads/voice-profiles');
  fs.promises.mkdir(VOICE_PROFILES_DIR, { recursive: true }).catch(() => {});

  const voiceProfileDiskStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VOICE_PROFILES_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.wav';
      cb(null, `voice_${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });

  const voiceProfileUpload = multer({
    storage: voiceProfileDiskStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm'];
      if (allowed.includes(file.mimetype) || file.originalname.match(/\.(wav|mp3|ogg|m4a|webm)$/i)) {
        cb(null, true);
      } else {
        cb(new Error('Formato de áudio não suportado. Use WAV, MP3, OGG, M4A ou WebM.'));
      }
    },
  });

  app.get("/api/voices", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const profiles = await db.select().from(voiceProfiles).where(eq(voiceProfiles.userId, userId));
      res.json(profiles);
    } catch (error: any) {
      routeError('getVoices', {}, error);
      res.status(500).json({ error: 'Erro ao listar perfis de voz' });
    }
  });

  app.post("/api/voices", voiceProfileUpload.single('audio'), async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { name, gender } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });

      if (!req.file) return res.status(400).json({ error: 'Arquivo de áudio é obrigatório' });

      const MIN_DURATION_SECONDS = 6;
      try {
        const mm = await import('music-metadata');
        const metadata = await mm.parseFile(req.file.path, { duration: true });
        const durationSec = metadata.format.duration ?? 0;
        if (durationSec < MIN_DURATION_SECONDS) {
          fs.promises.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: `Áudio de referência muito curto (${durationSec.toFixed(1)}s). Mínimo ${MIN_DURATION_SECONDS} segundos.` });
        }
      } catch (mmErr: any) {
        routeError('postVoices.musicMetadata', { path: req.file.path }, mmErr);
        const MIN_SIZE_BYTES = MIN_DURATION_SECONDS * 8000;
        if (req.file.size < MIN_SIZE_BYTES) {
          fs.promises.unlink(req.file.path).catch(() => {});
          return res.status(400).json({ error: `Áudio de referência muito curto. Mínimo ${MIN_DURATION_SECONDS} segundos.` });
        }
      }

      const [profile] = await db.insert(voiceProfiles).values({
        userId,
        name: name.trim(),
        gender: gender || 'feminina',
        referenceAudioPath: req.file.path,
      }).returning();

      res.status(201).json(profile);
    } catch (error: any) {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
      routeError('postVoices', {}, error);
      res.status(500).json({ error: error.message || 'Erro ao criar perfil de voz' });
    }
  });

  app.put("/api/voices/:id", voiceProfileUpload.single('audio'), async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { id } = req.params;
      const { name, gender } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Nome é obrigatório' });

      const [existing] = await db.select().from(voiceProfiles)
        .where(and(eq(voiceProfiles.id, id), eq(voiceProfiles.userId, userId)));
      if (!existing) return res.status(404).json({ error: 'Perfil não encontrado' });

      const updateData: Record<string, any> = { name: name.trim(), gender: gender || existing.gender };
      const hasNewAudio = !!req.file;

      if (hasNewAudio) {
        const MIN_DURATION_SECONDS = 6;
        try {
          const mm = await import('music-metadata');
          const metadata = await mm.parseFile(req.file!.path, { duration: true });
          const durationSec = metadata.format.duration ?? 0;
          if (durationSec < MIN_DURATION_SECONDS) {
            fs.promises.unlink(req.file!.path).catch(() => {});
            return res.status(400).json({ error: `Áudio de referência muito curto (${durationSec.toFixed(1)}s). Mínimo ${MIN_DURATION_SECONDS} segundos.` });
          }
        } catch (mmErr: any) {
          routeError('putVoices.musicMetadata', { path: req.file!.path }, mmErr);
          const MIN_SIZE_BYTES = MIN_DURATION_SECONDS * 8000;
          if (req.file!.size < MIN_SIZE_BYTES) {
            fs.promises.unlink(req.file!.path).catch(() => {});
            return res.status(400).json({ error: `Áudio de referência muito curto. Mínimo ${MIN_DURATION_SECONDS} segundos.` });
          }
        }
        updateData.referenceAudioPath = req.file!.path;
      }

      const [updated] = await db.update(voiceProfiles)
        .set(updateData)
        .where(and(eq(voiceProfiles.id, id), eq(voiceProfiles.userId, userId)))
        .returning();

      if (hasNewAudio) {
        fs.promises.unlink(existing.referenceAudioPath).catch(() => {});
        audioCacheService.invalidateByVoiceProfileId(id).catch((cacheErr: any) => {
          routeError('putVoices.cacheInvalidation', { voiceProfileId: id }, cacheErr);
        });
      }

      res.json(updated);
    } catch (error: any) {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
      routeError('putVoices', {}, error);
      res.status(500).json({ error: 'Erro ao atualizar perfil de voz' });
    }
  });

  app.delete("/api/voices/:id", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { id } = req.params;
      const [existing] = await db.select().from(voiceProfiles)
        .where(and(eq(voiceProfiles.id, id), eq(voiceProfiles.userId, userId)));
      if (!existing) return res.status(404).json({ error: 'Perfil não encontrado' });

      await db.delete(voiceProfiles)
        .where(and(eq(voiceProfiles.id, id), eq(voiceProfiles.userId, userId)));

      fs.promises.unlink(existing.referenceAudioPath).catch(() => {});

      audioCacheService.invalidateByVoiceProfileId(id).catch((cacheErr: any) => {
        routeError('deleteVoices.cacheInvalidation', { voiceProfileId: id }, cacheErr);
      });

      res.json({ success: true });
    } catch (error: any) {
      routeError('deleteVoices', {}, error);
      res.status(500).json({ error: 'Erro ao deletar perfil de voz' });
    }
  });

  app.get("/api/voices/:id/audio", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { id } = req.params;
      const [profile] = await db.select().from(voiceProfiles)
        .where(and(eq(voiceProfiles.id, id), eq(voiceProfiles.userId, userId)));
      if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });

      if (!fs.existsSync(profile.referenceAudioPath)) {
        return res.status(404).json({ error: 'Arquivo de áudio não encontrado' });
      }

      const ext = path.extname(profile.referenceAudioPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.aac': 'audio/aac',
      };
      const contentType = mimeMap[ext] || 'audio/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      fs.createReadStream(profile.referenceAudioPath).pipe(res);
    } catch (error: any) {
      routeError('getVoiceAudio', {}, error);
      res.status(500).json({ error: 'Erro ao servir áudio' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TTS ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  app.get("/api/tts/status", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const health = await ttsService.checkHealth();
      res.json({
        available: health.available,
        modelLoaded: health.modelLoaded,
        modelLoading: health.modelLoading ?? false,
        memoryMb: health.memoryMb ?? null,
        uptimeS: health.uptimeS ?? null,
        queue: {
          pending: (health.queue?.pending ?? 0) + ttsQueue.pendingCount,
          active: (health.queue?.active ?? 0) + ttsQueue.activeCount,
        },
      });
    } catch (error: any) {
      res.json({ available: false, modelLoaded: false, modelLoading: false, memoryMb: null, uptimeS: null, queue: { pending: 0, active: 0 } });
    }
  });

  app.get("/api/tts/debug", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const probeStart = Date.now();
      const health = await ttsService.checkHealth();
      const probeMs = Date.now() - probeStart;

      res.json({
        success: true,
        service: {
          available: health.available,
          modelLoaded: health.modelLoaded,
          responseTimeMs: probeMs,
          memoryMb: health.memoryMb ?? null,
          uptimeS: health.uptimeS ?? null,
          queue: health.queue ?? null,
          error: health.error ?? null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      routeError('getTtsDebug', {}, error);
      res.status(500).json({ success: false, error: error.message || 'Erro ao consultar diagnóstico TTS' });
    }
  });

  app.post("/api/tts/test", async (req, res) => {
    let testStep = 'initialization';
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ success: false, step: 'auth', error: 'Não autenticado', details: null });

      testStep = 'health_check';
      const testStart = Date.now();
      const health = await ttsService.checkHealth();

      if (!health.available) {
        return res.json({
          success: false,
          step: 'health_check',
          error: 'Serviço TTS indisponível',
          details: { available: false, modelLoaded: false },
          elapsedMs: Date.now() - testStart,
          timestamp: new Date().toISOString(),
        });
      }
      if (!health.modelLoaded) {
        const isLoading = health.modelLoading;
        return res.json({
          success: false,
          step: 'health_check',
          error: isLoading ? 'Modelo TTS está sendo carregado, aguarde…' : 'Modelo TTS não carregado',
          details: { available: true, modelLoaded: false, modelLoading: isLoading },
          elapsedMs: Date.now() - testStart,
          timestamp: new Date().toISOString(),
        });
      }

      testStep = 'test_generation';
      const selfTestResult = await ttsService.runSelfTest();
      const testMs = Date.now() - testStart;

      if (selfTestResult.ok) {
        res.json({
          success: true,
          step: 'complete',
          error: null,
          details: {
            audioGenerated: true,
            audioBytes: selfTestResult.audioBytes ?? null,
            generationMs: selfTestResult.elapsedMs ?? null,
            detail: selfTestResult.detail,
          },
          elapsedMs: testMs,
          timestamp: new Date().toISOString(),
        });
      } else {
        res.json({
          success: false,
          step: 'test_generation',
          error: selfTestResult.detail,
          details: null,
          elapsedMs: testMs,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error: any) {
      routeError('postTtsTest', { step: testStep }, error);
      res.status(500).json({
        success: false,
        step: testStep,
        error: error.message || 'Erro ao executar teste TTS',
        details: error instanceof TtsStepError ? error.details : (error.stack?.slice(0, 500) || null),
      });
    }
  });

  app.post("/api/tts/generate", async (req, res) => {
    let currentStep = 'initialization';
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ success: false, step: 'auth', error: 'Não autenticado', details: null });

      currentStep = 'validation';
      const { voiceProfileId, text, speed = 1.0, humanize = true, pitch = 1.0, volume = 1.0, pauseLevel = 1, expressiveness = 5 } = req.body;
      if (!voiceProfileId || !text?.trim()) {
        return res.status(400).json({ success: false, step: 'validation', error: 'voiceProfileId e text são obrigatórios', details: null });
      }

      const clampedSpeed = Math.max(0.5, Math.min(2.0, Number(speed) || 1.0));
      const clampedPitch = Math.max(0.5, Math.min(2.0, Number(pitch) || 1.0));
      const clampedVolume = Math.max(0.1, Math.min(2.0, Number(volume) || 1.0));
      const clampedPauseLevel = Math.max(0, Math.min(3, Number(pauseLevel) || 1));
      const clampedExpressiveness = Math.max(1, Math.min(10, Number(expressiveness) || 5));

      currentStep = 'profile_lookup';
      const [profile] = await db.select().from(voiceProfiles)
        .where(and(eq(voiceProfiles.id, voiceProfileId), eq(voiceProfiles.userId, userId)));
      if (!profile) return res.status(404).json({ success: false, step: 'profile_lookup', error: 'Perfil de voz não encontrado', details: null });

      currentStep = 'health_check';
      const health = await ttsService.checkHealth();
      if (!health.available) {
        return res.status(503).json({ success: false, step: 'health_check', error: 'Serviço TTS indisponível', details: { available: false, modelLoaded: health.modelLoaded } });
      }
      if (!health.modelLoaded) {
        const isLoading = health.modelLoading;
        return res.status(503).json({ success: false, step: 'health_check', error: isLoading ? 'Modelo TTS está sendo carregado, aguarde…' : 'Modelo TTS não carregado', details: { available: true, modelLoaded: false, modelLoading: isLoading } });
      }

      currentStep = 'audio_generation';
      const audioBuffer = await audioStitchingService.generateForLead({
        template: text.trim(),
        variables: {},
        referenceWavPath: profile.referenceAudioPath,
        voiceProfileId: profile.id,
        speed: clampedSpeed,
        humanize: Boolean(humanize),
        pitch: clampedPitch,
        volume: clampedVolume,
        pauseLevel: clampedPauseLevel,
        expressiveness: clampedExpressiveness,
      });

      currentStep = 'buffer_processing';
      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(500).json({ success: false, step: 'buffer_processing', error: 'Geração retornou áudio vazio (0 bytes)', details: null });
      }

      res.set({
        'Content-Type': 'audio/ogg',
        'Content-Disposition': 'attachment; filename=preview.ogg',
        'Content-Length': audioBuffer.length,
      });
      res.send(audioBuffer);
    } catch (error: any) {
      routeError('postTtsGenerate', { step: currentStep }, error);
      const step = error instanceof TtsStepError ? error.step : currentStep;
      const details = error instanceof TtsStepError ? error.details : (error.code || null);
      res.status(500).json({
        success: false,
        step,
        error: error.message || 'Erro ao gerar áudio TTS',
        details,
      });
    }
  });

  app.post("/api/tts/humanize", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { text } = req.body;
      if (!text?.trim()) return res.status(400).json({ error: 'text é obrigatório' });

      const humanizedText = textHumanizerService.humanize(text.trim());
      res.json({ humanizedText });
    } catch (error: any) {
      routeError('postTtsHumanize', {}, error);
      res.status(500).json({ error: 'Erro ao humanizar texto' });
    }
  });

  app.get("/api/tts/campaign/:campaignId/progress", async (req, res) => {
    try {
      const userId = req.session?.userId;
      if (!userId) return res.status(401).json({ error: 'Não autenticado' });

      const { campaignId } = req.params;

      const [campaign] = await db.select().from(campaignsSchema)
        .where(and(eq(campaignsSchema.id, campaignId), eq(campaignsSchema.userId, userId)));
      if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

      const rows = await db.select().from(ttsJobProgress)
        .where(eq(ttsJobProgress.campaignId, campaignId));

      const total = rows.length;
      const generated = rows.filter(r => r.status === 'done').length;
      const failed = rows.filter(r => r.status === 'failed').length;
      const pending = rows.filter(r => r.status === 'pending').length;
      const allDone = total > 0 && pending === 0;

      res.json({ total, generated, failed, pending, allDone, status: campaign.status });
    } catch (error: any) {
      routeError('getTtsCampaignProgress', {}, error);
      res.status(500).json({ error: 'Erro ao buscar progresso TTS' });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────

  const httpServer = createServer(app);
  return httpServer;
}

// Helper functions
async function validateMetaApiConfig(token: string, businessId: string): Promise<boolean> {
  try {
    return await validateCredentials(token, businessId);
  } catch (error) {
    routeError('Error validating Meta API config:', {}, error);
    return false;
  }
}

async function fetchWhatsAppTemplates(token: string, businessId: string): Promise<any[]> {
  try {
    return await getTemplates(token, businessId);
  } catch (error) {
    routeError('Error fetching WhatsApp templates:', {}, error);
    return [];
  }
}

async function processLeadsFile(leadListId: string, filePath: string): Promise<void> {
  try {
    // In a real implementation, you would:
    // 1. Download the file from object storage
    // 2. Parse CSV/Excel content
    // 3. Validate phone numbers
    // 4. Save leads to database
    // 5. Update lead list status
    
    // For now, simulate processing
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Update lead list with processed status
    await db.update(leadListsSchema).set({
      status: "ready",
      totalLeads: 100,
      validLeads: 95,
    }).where(eq(leadListsSchema.id, leadListId));
    
    console.log(`Processed leads file for list ${leadListId}`);
  } catch (error) {
    routeError('Error processing leads file:', {}, error);
    await db.update(leadListsSchema).set({ status: "error" }).where(eq(leadListsSchema.id, leadListId));
  }
}

// ============================================================================
// OVERDRIVE - MOTOR ULTRA-ESTÁVEL V3 (PADRÃO GLOBAL)
// ============================================================================
// 
// CARACTERÍSTICAS ATIVAS:
// - RetryQueue não-bloqueante (sempre ativa)
// - SafeMode automático (ativa em errorRate > 0.5%)
// - Circuit Breaker preventivo (age ANTES do erro)
// - TierDetection via Meta API (no início da campanha)
// - Checkpoint a cada 5 msgs (mais seguro que V2)
// - Finalização garantida: pipeline.drain() + retryQueue.drain()
// 
// V2 (OptimizedEngineV2) foi REMOVIDO do fluxo ativo.
// ============================================================================

// Mapa de engines UltraStable ativos por campanha
const activeUltraEngines = new Map<string, UltraStableCampaignSender>();
const activeBurstLaunchers = new Map<string, BurstLaunchMode>();

/**
 * Pauses all active in-memory engines belonging to a campaign.
 * Handles both exact keys (campaignId) and suffixed keys (campaignId-phoneNumberId)
 * that are created by executeParallelCampaign for multi-number runs.
 */
export function pauseActiveEngineForCampaign(campaignId: string): void {
  let paused = 0;
  for (const [key, engine] of activeUltraEngines.entries()) {
    // Match exact key OR suffixed key (e.g. "camp123-1234567890")
    if ((key === campaignId || key.startsWith(`${campaignId}-`)) && engine.isActive()) {
      engine.pauseCampaign();
      paused++;
      console.log(`[QualityPoller] Engine em memória pausado: key=${key} (campanha ${campaignId})`);
    }
  }
  if (paused === 0) {
    console.log(`[QualityPoller] Nenhum engine ativo encontrado para campanha ${campaignId}`);
  }
}

// Armazenamento de checkpoints V3 em memória
interface UltraCheckpoint {
  campaignId: string;
  lastProcessedIndex: number;
  successCount: number;
  failedCount: number;
  timestamp: number;
}
const ultraCheckpoints = new Map<string, UltraCheckpoint>();
const activeEngines: Set<UltraStableCampaignSender> = new Set();

const CHECKPOINT_STALE_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, cp] of ultraCheckpoints) {
    if (now - cp.timestamp > CHECKPOINT_STALE_MS) {
      ultraCheckpoints.delete(id);
      console.log(`[MEMORY_CLEANUP] Removed stale ultraCheckpoint for campaignId=${id}`);
    }
  }
}, 30 * 60 * 1000);

// Factory para criar engine UltraStable por campanha (OVERDRIVE V3)
function createUltraStableEngine(campaignId: string, speedMode?: string, totalLeads?: number, customRate?: number, parentCampaignId?: string, wabaConfigs?: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[] }>, templateWeights?: Record<string, number>, deliveryThresholds?: { autoPause?: number; reduce?: number; windowMs?: number; blockRateAutoPause?: number }): UltraStableCampaignSender {
  const validModes = ['SLOW', 'NORMAL', 'FAST'];
  const resolvedMode = (speedMode && validModes.includes(speedMode)) ? speedMode as 'SLOW' | 'NORMAL' | 'FAST' : 'NORMAL';
  
  console.log(`🛡️ OVERDRIVE: Criando motor UltraStable V3 para campanha ${campaignId} [SpeedMode: ${resolvedMode}]`);
  
  const engine = new UltraStableCampaignSender({
    maxRetries: 3,
    retryDelay: 2000,
    speedMode: resolvedMode,
    wabaConfigs: wabaConfigs || [],
    templateWeights: templateWeights || {},
    deliveryRateAutoPauseThreshold: deliveryThresholds?.autoPause,
    deliveryRateReduceThreshold: deliveryThresholds?.reduce,
    deliveryRateWindowMs: deliveryThresholds?.windowMs,
    blockRateAutoPauseThreshold: deliveryThresholds?.blockRateAutoPause,
  });

  if (totalLeads) {
    campaignStore.init(campaignId, totalLeads);
    campaignStore.update(campaignId, { status: 'RUNNING', tier: resolvedMode });
  }

  const adapter = getOrCreateAdapter(campaignId, totalLeads);
  const parentAdapter = parentCampaignId ? getOrCreateAdapter(parentCampaignId) : null;
  engine.setSendResultCallback((result) => {
    const sendResultData = {
      success: result.success,
      phone: result.phone,
      errorMessage: result.error,
      errorType: result.errorType,
      isMetaBlocked: result.isMetaBlocked,
      isRetry: result.isRetry
    };
    adapter.publishSendResult(sendResultData);
    if (parentAdapter) {
      parentAdapter.publishSendResult(sendResultData);
    }

    if (!result.isRetry) {
      campaignStore.increment(campaignId, 'processed');
    }

    if (result.success) {
      campaignStore.increment(campaignId, 'accepted');
      campaignStore.addLog(campaignId, 'SEND', `Enviada para ${result.phone}`);

      (async () => {
        try {
          const realCampaignId = parentCampaignId || campaignId;
          const camp = await getCampaignFromDbOrStorage(realCampaignId);
          const campRecord = camp as Record<string, unknown> | undefined;
          if (campRecord?.wabaId) {
            const wabaId = campRecord.wabaId as string;
            const phone = result.phone.replace(/\D/g, "");
            const convo = await wabaStorage.getOrCreateConversation(wabaId, phone, undefined, realCampaignId);
            const campTemplateId = campRecord.templateId as string | undefined;
            const campTemplateIds = (campRecord.templateIds || []) as string[];
            let templateName = "campaign";

            let resolvedBody = "";
            let headerImageUrl: string | undefined;
            let resolutionFailed = false;
            try {
              const userId = campRecord.userId as string;
              if (!userId) throw new Error("userId ausente na campanha");

              const allTpls = await db.select().from(templatesSchema).where(eq(templatesSchema.userId, userId));
              const tpl = allTpls.find((t: any) =>
                t.id === campTemplateId ||
                t.templateId === campTemplateId ||
                campTemplateIds.includes(t.id) ||
                campTemplateIds.includes(t.templateId)
              );
              if (tpl) templateName = (tpl as any).name || templateName;

              if (!tpl) {
                console.warn(`[Campaign] Template '${templateName}' não encontrado para userId=${userId}. Templates disponíveis: ${allTpls.map((t: any) => t.name).join(', ')}`);
                resolutionFailed = true;
              } else if (tpl.components && Array.isArray(tpl.components)) {
                const bodyComp = tpl.components.find((c: any) => c.type === "BODY");
                if (bodyComp?.text) {
                  let bodyText = bodyComp.text;
                  const leadListId = (campRecord as any).leadListId;
                  if (leadListId) {
                    try {
                      const campLeads = await db.select().from(leadsSchema).where(eq(leadsSchema.leadListId, leadListId));
                      const leadMatch = campLeads.find((l: any) => l.phone.replace(/\D/g, "") === phone);
                      if (leadMatch) {
                        const lm = leadMatch as any;
                        const knownAliases: Record<string, string> = {
                          cpf: lm.doc || lm.cpf || lm.documento || '',
                          nome: lm.name || lm.nome || lm.Name || '',
                          name: lm.name || lm.nome || lm.Name || '',
                          telefone: lm.phone || lm.telefone || '',
                          phone: lm.phone || lm.telefone || '',
                          email: lm.email || '',
                          produto: lm.produto || lm.product || '',
                          product: lm.produto || lm.product || '',
                          valor: lm.valor || lm.value || lm.price || '',
                          value: lm.valor || lm.value || lm.price || '',
                          codigo_rastreio: lm.codigoRastreio || lm.codigo_rastreio || '',
                          codigoRastreio: lm.codigoRastreio || lm.codigo_rastreio || '',
                          endereco: lm.endereco || lm.address || '',
                          address: lm.endereco || lm.address || '',
                          link: lm.link || lm.url || '',
                          url: lm.link || lm.url || '',
                        };
                        function resolveLeadTag(tag: string): string {
                          const key = tag.trim().toLowerCase();
                          if (knownAliases[key] !== undefined) return knownAliases[key];
                          if (lm[tag] !== undefined && lm[tag] !== null) return String(lm[tag]);
                          if (lm[key] !== undefined && lm[key] !== null) return String(lm[key]);
                          const camelCase = key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
                          if (lm[camelCase] !== undefined && lm[camelCase] !== null) return String(lm[camelCase]);
                          return '';
                        }

                        const leadFieldOrder = ['name', 'cpf', 'email', 'produto', 'valor', 'endereco', 'codigoRastreio', 'link'];
                        const leadParamMap: Record<number, string> = {};
                        let idx = 1;
                        for (const field of leadFieldOrder) {
                          const val = lm[field];
                          if (val && typeof val === 'string' && val.trim()) {
                            leadParamMap[idx] = val.trim();
                            idx++;
                          }
                        }

                        const campCfg = (campRecord as any).campaignConfig || {};
                        const tplParamCfg = campCfg.templateParams || {};
                        const tplKey = Object.keys(tplParamCfg).find(k =>
                          k === campTemplateId || campTemplateIds.includes(k) || k === (tpl as any).templateId
                        );
                        const configuredParams = tplKey ? tplParamCfg[tplKey] : {};

                        bodyText = bodyText.replace(/\{\{(\d+)\}\}/g, (_: string, idxStr: string) => {
                          const paramNum = parseInt(idxStr, 10);
                          const configKey = `body_${paramNum}`;
                          if (configuredParams[configKey]) {
                            let val = configuredParams[configKey] as string;
                            val = val.replace(/\{([^}]+)\}/gi, (_m: string, tagName: string) => resolveLeadTag(tagName));
                            return val;
                          }
                          return leadParamMap[paramNum] || "";
                        });
                      }
                    } catch (leadErr) {
                      routeError("routes.campaignLeadParamSubst", {}, leadErr);
                    }
                  }
                  bodyText = bodyText.replace(/\{\{\d+\}\}/g, "");
                  resolvedBody = bodyText.trim();
                } else {
                  resolvedBody = templateName;
                }
                const headerComp = tpl.components.find((c: any) => c.type === "HEADER" && c.format === "IMAGE");
                if (headerComp) {
                  const pubDomain = getPublicDomain();
                  headerImageUrl = generateSignedImageUrl(pubDomain, realCampaignId, phone);
                }
              } else {
                resolvedBody = templateName;
              }
            } catch (templateResolveErr) {
              routeError("routes.campaignTemplateBodyResolve", {}, templateResolveErr);
              resolutionFailed = true;
            }

            if (!resolvedBody) {
              resolvedBody = resolutionFailed
                ? `[Campanha: ${templateName} - falha na resolução do template]`
                : templateName;
            }

            await wabaStorage.createMessage({
              conversationId: convo.id,
              direction: "outbound",
              body: resolvedBody,
              type: "template",
              mediaUrl: headerImageUrl,
              status: "sent",
            });
            await wabaStorage.updateConversation(convo.id, {
              lastMessageAt: new Date(),
              lastMessagePreview: resolvedBody.substring(0, 100),
            });
          }
        } catch (persistErr) {
          routeError("routes.campaignPersistMessage", {}, persistErr);
        }
      })();
    } else if (result.isMetaBlocked) {
      campaignStore.increment(campaignId, 'blocked');
      campaignStore.addLog(campaignId, 'WARN', `Bloqueada pela Meta: ${result.phone}`);
      if (result.error) {
        const code = result.error.match(/(\d{5,6})/)?.[1] || 'unknown';
        campaignStore.updateErrorMap(campaignId, code, result.error, result.phone);
        const errorCode = parseInt(code, 10);
        OptOutService.handleDeliveryError(result.phone, isNaN(errorCode) ? undefined : errorCode, result.error, campaignId).catch(err => routeError('handleDeliveryError', { phone: result.phone, errorCode, campaignId }, err));
      }
    } else {
      campaignStore.increment(campaignId, 'failed');
      campaignStore.addLog(campaignId, 'ERROR', `Falha: ${result.phone} - ${result.error || 'Erro desconhecido'}`);
      if (result.error) {
        const code = result.error.match(/(\d{5,6})/)?.[1] || 'unknown';
        campaignStore.updateErrorMap(campaignId, code, result.error, result.phone);
        const errorCode = parseInt(code, 10);
        OptOutService.handleDeliveryError(result.phone, isNaN(errorCode) ? undefined : errorCode, result.error, campaignId).catch(err => routeError('handleDeliveryError', { phone: result.phone, errorCode, campaignId }, err));
      }
    }
  });

  engine.setProgressCallback((stats: UltraStableStats) => {
    const remainingSecs = stats.eta ? stats.eta.remainingMs / 1000 : 0;
    const completionDate = stats.eta?.completionTime || new Date();
    const confidence = stats.eta ? (stats.eta.confidenceLevel > 0.7 ? 'high' : stats.eta.confidenceLevel > 0.4 ? 'medium' : 'low') : 'low';

    adapter.updateFromEngineStats({
      campaignId,
      processedLeads: stats.processedLeads,
      successfulSends: stats.successfulSends,
      failedSends: stats.failedSends,
      preflightFailed: stats.preflightFailed,
      totalLeads: stats.totalLeads,
      currentRate: stats.currentRate,
      peakRate: stats.peakRate,
      averageRttMs: stats.averageRttMs,
      p95RttMs: stats.p95RttMs,
      p99RttMs: 0,
      burstState: stats.burstState.phaseName || 'adaptive',
      circuitBreakerTrips: stats.circuitBreakerTrips,
      totalRetries: stats.totalRetries,
      tokenBucketRate: stats.tokenBucketRate,
      circuitState: stats.circuitState,
      inFlightRequests: stats.inFlightRequests,
      eta: {
        remainingSeconds: remainingSecs,
        estimatedCompletion: completionDate,
        confidence,
      },
      retryQueue: {
        size: stats.retryQueue?.queueLength || 0,
        processed: stats.retryQueue?.totalRetried || 0,
        failed: stats.retryQueue?.totalExhausted || 0,
      },
      errorCounts: stats.errorCounts || { rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, unknownErrors: 0, total: 0 },
      metaBlockedSends: stats.metaBlockedSends,
      safeModeState: {
        isActive: stats.safeModeState?.isActive || false,
        activationReason: stats.safeModeState?.activationReason || undefined,
      },
      detectedTier: stats.detectedTier,
      healthState: stats.burstState?.isStressed ? 'DEGRADED' : 'HEALTHY',
      campaignState: 'RUNNING',
      pauseState: { isPaused: false, currentRatePercent: 100 },
      failSafeActive: false,
    });

    if (parentCampaignId) {
      const progressPercent = stats.totalLeads > 0 ? Math.round((stats.processedLeads / stats.totalLeads) * 1000) / 10 : 0;
      const parentMetrics: GlobalCampaignMetrics = {
        campaignId: parentCampaignId,
        state: 'RUNNING',
        currentMsgPerSec: Math.round(stats.currentRate * 10) / 10,
        peakMsgPerSec: Math.round(stats.peakRate * 10) / 10,
        avgMsgPerSec: Math.round(stats.currentRate * 10) / 10,
        totalProcessed: stats.processedLeads,
        totalSuccess: stats.successfulSends,
        totalFailed: stats.failedSends,
        totalLeads: stats.totalLeads,
        progressPercent,
        eta: {
          remainingSeconds: remainingSecs,
          estimatedCompletion: completionDate.toISOString(),
          confidenceLevel: confidence as 'high' | 'medium' | 'low',
        },
        latency: {
          p50: stats.averageRttMs || 0,
          p95: stats.p95RttMs || 0,
          p99: 0,
          avg: stats.averageRttMs || 0,
          trend: 'stable' as const,
        },
        errors: stats.errorCounts ? {
          total: stats.errorCounts.total || 0,
          rateLimitErrors: stats.errorCounts.rateLimitErrors || 0,
          payloadErrors: stats.errorCounts.payloadErrors || 0,
          networkErrors: stats.errorCounts.networkErrors || 0,
          authErrors: stats.errorCounts.authErrors || 0,
          environmentErrors: stats.errorCounts.environmentErrors || 0,
          templateErrors: 0,
          timeoutErrors: 0,
        } : { total: 0, rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, templateErrors: 0, timeoutErrors: 0 },
        metaBlockedCount: stats.metaBlockedSends || 0,
        preflightErrors: stats.preflightFailed || 0,
        environmentStatus: (stats.metaBlockedSends || 0) > 0 ? 'blocked' : 'ok',
        safeModeActive: stats.safeModeState?.isActive || false,
        pauseActive: false,
        failSafeActive: false,
        healthState: stats.burstState?.isStressed ? 'DEGRADED' : 'HEALTHY',
        burstPhase: stats.burstState?.phaseName || 'adaptive',
        detectedTier: stats.detectedTier,
        indicators: {
          health: 'GREEN' as const,
          speed: 'NORMAL' as const,
          risk: 'LOW' as const,
          healthReason: 'Sistema operando normalmente',
          speedReason: `${stats.currentRate.toFixed(1)} msg/s`,
          riskReason: 'Operação segura',
        },
      };
      metricsPublisher.updateGlobalMetrics(parentCampaignId, parentMetrics);
    }

    campaignStore.updateFromEngineMetrics(campaignId, {
      campaignId,
      state: 'RUNNING',
      currentMsgPerSec: Math.round(stats.currentRate * 10) / 10,
      peakMsgPerSec: Math.round(stats.peakRate * 10) / 10,
      avgMsgPerSec: Math.round(stats.currentRate * 10) / 10,
      totalProcessed: stats.processedLeads,
      totalSuccess: stats.successfulSends,
      totalFailed: stats.failedSends,
      totalLeads: stats.totalLeads,
      progressPercent: stats.totalLeads > 0 ? Math.round((stats.processedLeads / stats.totalLeads) * 1000) / 10 : 0,
      eta: {
        remainingSeconds: remainingSecs,
        estimatedCompletion: completionDate.toISOString(),
        confidenceLevel: confidence as 'high' | 'medium' | 'low',
      },
      latency: {
        p50: stats.averageRttMs || 0,
        p95: stats.p95RttMs || 0,
        p99: 0,
        avg: stats.averageRttMs || 0,
        trend: 'stable' as const,
      },
      errors: stats.errorCounts ? {
        total: stats.errorCounts.total || 0,
        rateLimitErrors: stats.errorCounts.rateLimitErrors || 0,
        payloadErrors: stats.errorCounts.payloadErrors || 0,
        networkErrors: stats.errorCounts.networkErrors || 0,
        authErrors: stats.errorCounts.authErrors || 0,
        environmentErrors: stats.errorCounts.environmentErrors || 0,
        templateErrors: 0,
        timeoutErrors: 0,
      } : { total: 0, rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, templateErrors: 0, timeoutErrors: 0 },
      metaBlockedCount: stats.metaBlockedSends || 0,
      preflightErrors: stats.preflightFailed || 0,
      environmentStatus: (stats.metaBlockedSends || 0) > 0 ? 'blocked' : 'ok',
      safeModeActive: stats.safeModeState?.isActive || false,
      pauseActive: false,
      failSafeActive: false,
      healthState: 'HEALTHY',
      burstPhase: stats.burstState?.phaseName || 'adaptive',
      detectedTier: stats.detectedTier,
      indicators: {
        health: 'GREEN' as const,
        speed: 'NORMAL' as const,
        risk: 'LOW' as const,
        healthReason: 'Sistema operando normalmente',
        speedReason: `${stats.currentRate.toFixed(1)} msg/s`,
        riskReason: 'Operação segura',
      },
    });
  });
  
  engine.setBlockRatePauseCallback(async (cId, reason, blockRate) => {
    try {
      campaignStore.addLog(cId, 'WARN', `AUTO-PAUSE por block rate: ${reason} (${(blockRate * 100).toFixed(1)}%)`);
      await db.update(campaignsSchema).set({
        status: 'paused',
        updatedAt: new Date(),
      }).where(eq(campaignsSchema.id, cId));
      console.log(`[AutoPause] Campanha ${cId} pausada por block rate alto: ${reason}`);
    } catch (e: any) {
      routeError('routes.blockRatePauseCallback', { campaignId: cId }, e);
    }
  });

  activeUltraEngines.set(campaignId, engine);
  return engine;
}

// Limpar engine UltraStable após conclusão
function cleanupUltraStableEngine(campaignId: string): void {
  const engine = activeUltraEngines.get(campaignId);
  if (engine) {
    engine.stopCampaign();
  }
  activeUltraEngines.delete(campaignId);

  const burst = activeBurstLaunchers.get(campaignId);
  if (burst) {
    burst.stop();
    activeBurstLaunchers.delete(campaignId);
    console.log(`🧹 BurstLauncher limpo para campanha ${campaignId}`);
  }

  console.log(`🧹 OVERDRIVE: Engine V3 limpo para campanha ${campaignId}`);
}

// ============================================================================
// HELPERS: BRIDGE DB/MEMSTORAGE PARA CAMPANHAS MANAGED
// ============================================================================
async function getCampaignFromDbOrStorage(campaignId: string) {
  const [dbCampaign] = await db.select().from(campaignsSchema).where(eq(campaignsSchema.id, campaignId));
  return dbCampaign || undefined;
}

async function updateCampaignInDbAndStorage(campaignId: string, updates: Record<string, any>) {
  if ((updates.status === 'completed' || updates.status === 'failed') && !updates.completedAt) {
    updates.completedAt = updates.updatedAt ?? new Date();
  }
  try {
    const [updated] = await db.update(campaignsSchema).set(updates).where(eq(campaignsSchema.id, campaignId)).returning();
    return updated;
  } catch (e) {
    routeError("routes.updateCampaignInDb", { campaignId }, e);
    return undefined;
  }
}

async function getApiConfigFromDbOrStorage(userId: string) {
  const [dbConfig] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, userId));
  return dbConfig || null;
}

async function getTemplatesFromDbOrStorage(userId: string) {
  return db.select().from(templatesSchema).where(eq(templatesSchema.userId, userId));
}

async function getLeadsByListFromDbOrStorage(leadListId: string) {
  return db.select().from(leadsSchema).where(eq(leadsSchema.leadListId, leadListId));
}

async function upsertMessageStatusInDb(campaignId: string | null, msgId: string, phone: string, status: string) {
  const [existing] = await db.select().from(messageStatusSchema).where(eq(messageStatusSchema.msgId, msgId));
  if (existing) {
    const previousStatus = existing.status;
    const [updated] = await db.update(messageStatusSchema)
      .set({ status, ts: new Date() })
      .where(eq(messageStatusSchema.msgId, msgId))
      .returning();
    return { ...updated, previousStatus };
  }
  const [entry] = await db.insert(messageStatusSchema).values({
    campaignId: campaignId ?? null,
    msgId,
    phone,
    status,
  }).returning();
  return { ...entry, previousStatus: undefined };
}

async function getDeliveryStatsFromDb(campaignId: string) {
  const all = await db.select().from(messageStatusSchema).where(eq(messageStatusSchema.campaignId, campaignId));
  const stats = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const s of all) {
    if (s.status === 'sent') stats.sent++;
    else if (s.status === 'delivered') stats.delivered++;
    else if (s.status === 'read') stats.read++;
    else if (s.status === 'failed') stats.failed++;
  }
  return stats;
}

// ============================================================================
// OVERDRIVE V3 - FUNÇÃO DE EXECUÇÃO DE CAMPANHA (ULTRA-ESTÁVEL COM MULTI-NÚMERO)
// ============================================================================
async function executeParallelCampaign(campaignId: string, batchingRate?: number, forcedLanguage?: string, speedMode?: string, customMessages?: Record<number, string>, isDynamicUrl?: boolean, templateNames?: string[], customRate?: number, isBlacksky?: boolean, blackskyConfig?: { dominios: string[]; variacoes4: string[]; variacoes3?: string[] }, isParametroUnico?: boolean, parametroUnicoConfig?: { singleParamTemplate: string; dominios: string[]; linkPrefixes: string[] }, usePackageImage?: boolean, packageImageType?: 'correios' | 'dirpf' | 'auto', packageImageKey?: string, customImageTemplateId?: string, wabaConfigs?: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[] }>, templateWeights?: Record<string, number>): Promise<void> {
  const engines: Map<string, UltraStableCampaignSender> = new Map();
  let multiPhoneCoordinator: Awaited<typeof import('./services/engine/MultiPhoneEngineCoordinator')>['multiPhoneCoordinator'] | null = null;
  
  try {
    const speedLabel = speedMode === 'SLOW' ? 'LENTO' : speedMode === 'FAST' ? 'RÁPIDO' : 'NORMAL';
    console.log(`🛡️ OVERDRIVE V3: Iniciando campanha ${campaignId}`);
    console.log(`   ⚡ Motor: UltraStableEngine (V3) Multi-Número`);
    console.log(`   🎚️ Velocidade: ${speedLabel} (${speedMode || 'NORMAL'})`);
    console.log(`   🔄 RetryQueue: não-bloqueante`);
    console.log(`   🛡️ SafeMode: automático com auto-recovery`);
    console.log(`   ⚡ CircuitBreaker: preventivo`);
    console.log(`   📊 TierDetection: ativo`);
    console.log(`   📱 Multi-Número: integrado`);
    
    if (forcedLanguage) {
      console.log(`   🌐 Idioma forçado: ${forcedLanguage}`);
    }
    
    const campaign = await getCampaignFromDbOrStorage(campaignId);
    if (!campaign) throw new Error('Campanha não encontrada');

    if (campaign.businessHoursOnly) {
      stealthScheduler.updateConfig({ businessHoursOnly: true });
      console.log(`   🕐 Horário comercial: ativado para campanha ${campaignId}`);
    }
    
    const config = await getApiConfigFromDbOrStorage(campaign.userId);
    if (!config || !config.isValid) throw new Error('Configuração da API inválida');

    try {
      await validateMetaConfig(config.metaToken || '');
      console.log(`   ✅ Token Meta validado com sucesso para campanha ${campaignId}`);
    } catch (tokenErr: any) {
      console.error(`[validateMetaConfig] Campanha ${campaignId} bloqueada:`, tokenErr.message);
      throw new Error(tokenErr.message);
    }

    const allTemplates = await getTemplatesFromDbOrStorage(campaign.userId);
    if (allTemplates.length === 0) throw new Error('Nenhum template encontrado');
    
    let selectedTemplate = allTemplates.find(t => t.id === campaign.templateId && t.status === 'APPROVED');
    if (!selectedTemplate) {
      selectedTemplate = allTemplates.find(t => t.templateId === campaign.templateId && t.status === 'APPROVED');
    }
    if (!selectedTemplate) {
      selectedTemplate = allTemplates.find(t => t.name === campaign.templateId && t.status === 'APPROVED');
    }
    if (!selectedTemplate) throw new Error(`Template '${campaign.templateId}' não encontrado ou não aprovado. Sincronize os templates e re-selecione na campanha.`);
    
    console.log(`   🎯 Template: ${selectedTemplate.name}`);
    
    const leads = await getLeadsByListFromDbOrStorage(campaign.leadListId!);
    if (leads.length === 0) throw new Error('Nenhum lead encontrado');

    for (const lead of leads) {
      await storage.registerLeadCampaignMapping(lead.phone, campaignId);
    }
    console.log(`📋 ${leads.length} leads mapeados para campanha ${campaignId}`);

    const campConfig = (campaign as any).campaignConfig || {};
    const templateParamConfig = campConfig.templateParams || {};
    const templateParamKeys = Object.keys(templateParamConfig);
    if (templateParamKeys.length > 0) {
      console.log(`   📝 [ParamConfig] Template params configurados para ${templateParamKeys.length} template(s):`);
      for (const tplId of templateParamKeys) {
        const paramEntries = Object.entries(templateParamConfig[tplId] || {});
        for (const [paramKey, paramValue] of paramEntries) {
          const preview = typeof paramValue === 'string' ? paramValue.substring(0, 60) : String(paramValue);
          console.log(`      • template=${tplId} | ${paramKey} = "${preview}"`);
        }
      }
      for (const lead of leads) {
        (lead as any)._templateParamConfig = templateParamConfig;
      }
      console.log(`   📝 [ParamConfig] _templateParamConfig aplicado em ${leads.length} leads`);
    } else {
      console.log(`   📝 [ParamConfig] Nenhum template param configurado no wizard (templateParams vazio)`);
    }

    if (campConfig.campaignAudioEnabled && campConfig.campaignAudioUrl) {
      console.log(`   🎵 Audio da campanha configurado: ${campConfig.campaignAudioUrl.substring(0, 60)}...`);
      for (const lead of leads) {
        (lead as any).campaignAudioUrl = campConfig.campaignAudioUrl;
      }
    }

    // ── PRÉ-GERAÇÃO DE IMAGENS DO PACOTE ──────────────────────────────────
    if (usePackageImage) {
      console.log(`🖼️ Pré-geração de Imagem do Pacote ativada para ${leads.length} leads`);
      console.log(`🖼️ [ImageDebug] customImageTemplateId=${customImageTemplateId}, packageImageType=${packageImageType}, packageImageKey=${packageImageKey}`);
      campaignStore.addLog(campaignId, 'INFO', `Gerando imagens personalizadas: 0/${leads.length}`);

      const publicDomain = getPublicDomain();
      console.log(`🖼️ [ImageDebug] publicDomain=${publicDomain}`);

      let usedCustomTemplate = false;
      if (customImageTemplateId) {
        const [customTpl] = await db.select().from(imageTemplates).where(eq(imageTemplates.id, customImageTemplateId));
        const basePathExists = customTpl?.baseImagePath
          ? await fs.promises.access(customTpl.baseImagePath).then(() => true).catch(() => false)
          : false;
        console.log(`🖼️ [ImageDebug] customTpl encontrado: ${!!customTpl}, baseImagePath=${customTpl?.baseImagePath}, fileExists=${basePathExists}, hasBase64=${!!customTpl?.baseImageData}`);

        if (customTpl && customTpl.baseImagePath && !basePathExists && customTpl.baseImageData) {
          console.log(`🖼️ [ImageDebug] Restaurando imagem base do banco de dados para disco...`);
          const dir = path.dirname(customTpl.baseImagePath);
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(customTpl.baseImagePath, Buffer.from(customTpl.baseImageData, 'base64'));
          console.log(`🖼️ [ImageDebug] Imagem restaurada: ${customTpl.baseImagePath}`);
        }

        const basePathExistsFinal = customTpl?.baseImagePath
          ? await fs.promises.access(customTpl.baseImagePath).then(() => true).catch(() => false)
          : false;

        if (customTpl && customTpl.baseImagePath && !basePathExistsFinal) {
          console.warn(`🖼️ [ImageDebug] Arquivo base não existe no disco e não há dados no banco. Fallback para imagem do template Meta.`);
          campaignStore.addLog(campaignId, 'WARN', 'Arquivo de imagem base não encontrado. Usando imagem padrão do template.');
        }
        if (customTpl && customTpl.baseImagePath && basePathExistsFinal) {
          console.log(`🎨 Usando template personalizado: ${customTpl.name}`);
          const baseBuffer = await fs.promises.readFile(customTpl.baseImagePath);
          const tplFields = (customTpl.fields || []) as ImageTemplateField[];
          const GENERATED_DIR = path.resolve(__dirname_routes, '../uploads/campaign-images');
          let generated = 0;
          for (const lead of leads) {
            try {
              const nome = (lead as any).name || (lead as any).nome || 'CLIENTE';
              const cpf = (lead as any).cpf || (lead as any).doc || '';
              const resultBuf = await generateFromCustomTemplate(baseBuffer, tplFields, { name: nome, cpf });
              const safePhone = lead.phone.replace(/\D/g, '');
              const leadDir = path.join(GENERATED_DIR, campaignId);
              await fs.promises.mkdir(leadDir, { recursive: true });
              const imgPath = path.join(leadDir, `${safePhone}.jpg`);
              await fs.promises.writeFile(imgPath, resultBuf);
              (lead as any).packageImageUrl = generateSignedImageUrl(publicDomain, campaignId, safePhone);
              (lead as any).templateUsed = customTpl.name;
              generated++;
              if (generated % 50 === 0 || generated === leads.length) {
                campaignStore.addLog(campaignId, 'INFO', `Gerando imagem ${generated}/${leads.length}`);
              }
            } catch (err: any) {
              routeError('routes.generateCustomTemplateImage', { campaignId, phone: lead.phone }, err);
              (lead as any).imageGenerationFailed = true;
            }
          }
          usedCustomTemplate = true;
        } else {
          campaignStore.addLog(campaignId, 'WARN', 'Template personalizado não encontrado, usando padrão.');
        }
      }

      if (!usedCustomTemplate) {
        const correiosPath = path.resolve(__dirname_routes, '../attached_assets/FOTO_PRODUTO_CORREIOS_1774527170319.jpg');
        const dirpfPath = path.resolve(__dirname_routes, '../attached_assets/DIRPF_TEMPLATE.png');
        let resolvedBaseImagePath: string | undefined;
        if (packageImageKey) {
          const customPath = path.join(CAMPAIGN_BASE_IMAGES_DIR, `${packageImageKey}.jpg`);
          const customPathExists = await fs.promises.access(customPath).then(() => true).catch(() => false);
          resolvedBaseImagePath = customPathExists ? customPath : correiosPath;
        } else if (packageImageType === 'dirpf') {
          resolvedBaseImagePath = dirpfPath;
        }

        const leadSpecs = leads.map((lead) => ({
          id: lead.phone,
          nome: (lead as any).name || (lead as any).nome || 'CLIENTE',
          cpf: (lead as any).cpf || (lead as any).doc || '',
          telefone: lead.phone,
        }));

        const imageResults = await preBatchGenerate(leadSpecs, {
          campaignId,
          concurrency: 8,
          imageType: (packageImageType as any) || 'correios',
          baseImagePath: resolvedBaseImagePath,
          onProgress: (g, t) => {
            if (g % 100 === 0 || g === t) {
              campaignStore.addLog(campaignId, 'INFO', `Gerando imagem ${g}/${t}`);
            }
          },
        });

        const allValid = await validateAllImages(imageResults, campaignId);
        if (!allValid) {
          campaignStore.addLog(campaignId, 'WARN', 'Algumas imagens não puderam ser geradas. Prosseguindo com leads disponíveis.');
        }

        let batchGenerated = 0;
        for (const result of imageResults) {
          const lead = leads.find((l) => l.phone === result.telefone);
          if (lead && result.imagePath) {
            const safePhone = result.telefone.replace(/\D/g, '');
            (lead as any).packageImageUrl = generateSignedImageUrl(publicDomain, campaignId, safePhone);
            (lead as any).templateUsed = result.templateUsed;
            batchGenerated++;
          }
        }
        console.log(`✅ Imagens do pacote prontas: ${batchGenerated}/${leads.length}`);
        campaignStore.addLog(campaignId, 'INFO', `Imagens prontas: ${batchGenerated}/${leads.length}. Iniciando envio...`);
      } else {
        const customGenerated = leads.filter((l) => (l as any).packageImageUrl).length;
        console.log(`✅ Imagens customizadas prontas: ${customGenerated}/${leads.length}`);
        campaignStore.addLog(campaignId, 'INFO', `Imagens prontas: ${customGenerated}/${leads.length}. Iniciando envio...`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    if (isBlacksky && blackskyConfig) {
      const bkDominios = blackskyConfig.dominios.filter(d => d.trim());
      const bkVar3 = (blackskyConfig.variacoes3 || []).filter((v: string) => v.trim());
      const bkVar4Prefixes = blackskyConfig.variacoes4.filter(v => v.trim());
      if (bkDominios.length === 0 || bkVar4Prefixes.length === 0) {
        throw new Error('Blacksky: dominios ou variacoes4 vazios');
      }
      console.log(`   🌑 Modo BLACKSKY ativo: ${bkDominios.length} dominio(s), ${bkVar3.length} var(3), ${bkVar4Prefixes.length} var(4), rotacao a cada ${ROTACAO_A_CADA}`);
      let bkDomIdx = 0;
      let bkEnvios = 0;
      for (const lead of leads) {
        const txt3 = bkVar3.length > 0 ? sorteia(bkVar3) : '';
        const prefix4 = sorteia(bkVar4Prefixes);
        if (bkEnvios >= ROTACAO_A_CADA) {
          bkDomIdx = (bkDomIdx + 1) % bkDominios.length;
          bkEnvios = 0;
        }
        bkEnvios++;
        const domToUse = bkDominios[bkDomIdx];
        const path = novoPath();
        const link = `${domToUse}/${path}`;
        (lead as any).customMessage3 = txt3;
        (lead as any).customMessage = txt3;
        (lead as any).customMessage4 = prefix4 + link;
        if (isDynamicUrl) (lead as any).isDynamicUrl = true;
      }
    } else if (isParametroUnico && parametroUnicoConfig) {
      const spDoms = parametroUnicoConfig.dominios;
      const spPrefixes = parametroUnicoConfig.linkPrefixes;
      const tmplText = parametroUnicoConfig.singleParamTemplate;
      console.log(`   📝 Modo PARAMETRO UNICO ativo: template="${tmplText.substring(0, 60)}...", ${spDoms.length} dominio(s), ${spPrefixes.length} prefixo(s)`);
      let spDomIdx = 0;
      let spEnvios = 0;
      for (const lead of leads) {
        let finalText = tmplText;
        const leadName = (lead as any).name || (lead as any).nome || 'Cliente';
        const leadCpf = (lead as any).cpf || (lead as any).doc || (lead as any).documento || '';
        finalText = finalText.replace(/\{nome\}/g, leadName);
        finalText = finalText.replace(/\{cpf\}/g, leadCpf);
        if (tmplText.includes('{link}')) {
          if (spDoms.length > 0) {
            if (spEnvios >= ROTACAO_A_CADA) {
              spDomIdx = (spDomIdx + 1) % spDoms.length;
              spEnvios = 0;
            }
            spEnvios++;
            const domToUse = spDoms[spDomIdx];
            const path = novoPath();
            const prefix = spPrefixes.length > 0 ? sorteia(spPrefixes) : '';
            const link = prefix + `${domToUse}/${path}`;
            finalText = finalText.replace(/\{link\}/g, link);
          } else {
            finalText = finalText.replace(/\{link\}/g, '');
          }
        }
        (lead as any).customMessage1 = finalText;
        if (isDynamicUrl) (lead as any).isDynamicUrl = true;
      }
    } else if (customMessages || isDynamicUrl) {
      for (const lead of leads) {
        if (customMessages) {
          for (const [paramKey, paramValue] of Object.entries(customMessages)) {
            const key = parseInt(paramKey, 10);
            if (key >= 1 && key <= 6 && typeof paramValue === 'string' && paramValue.trim()) {
              (lead as any)[`customMessage${key}`] = paramValue.trim();
            }
          }
          if (customMessages[3]) (lead as any).customMessage = customMessages[3];
        }
        if (isDynamicUrl) (lead as any).isDynamicUrl = true;
      }
    }
    
    const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
    if (phoneNumbers.length === 0) throw new Error('Nenhum número de telefone disponível');
    
    // Priorizar números por qualidade (GREEN > YELLOW > RED)
    const prioritizedNumbers = phoneNumbers.sort((a, b) => {
      const priority = { 'GREEN': 3, 'YELLOW': 2, 'RED': 1 };
      return (priority[b.quality_rating as keyof typeof priority] || 0) - 
             (priority[a.quality_rating as keyof typeof priority] || 0);
    });
    
    console.log(`   📱 Números disponíveis: ${prioritizedNumbers.length}`);
    prioritizedNumbers.forEach((p, i) => {
      console.log(`      ${i + 1}. ${p.display_phone_number} (${p.quality_rating})`);
    });
    console.log(`   📊 Total leads: ${leads.length}`);
    
    await updateCampaignInDbAndStorage(campaignId, {
      status: "running",
      startedAt: new Date(),
      updatedAt: new Date()
    });
    
    let formattedTemplates: Array<{ id: string; templateId?: string | null; name: string; language: string; status: string; category: string; components: any[]; wabaId?: string }> = [];
    
    if (templateNames && templateNames.length > 0) {
      const matchedAll = allTemplates.filter(t => templateNames.includes(t.name) && t.status === 'APPROVED');
      if (matchedAll.length > 0) {
        formattedTemplates = matchedAll.map(t => ({
          id: t.id,
          templateId: t.templateId,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components: t.components as any[],
          wabaId: t.wabaId ?? undefined,
        }));
      }
    }
    
    const campaignTemplateIds = (campaign.templateIds as string[] | undefined) || (campConfig.templateIds as string[] | undefined);
    if (formattedTemplates.length <= 1 && campaignTemplateIds && campaignTemplateIds.length > 1) {
      const matchedByIds = allTemplates.filter(t => (campaignTemplateIds.includes(t.id) || campaignTemplateIds.includes(t.templateId || '') || campaignTemplateIds.includes(t.name)) && t.status === 'APPROVED');
      if (matchedByIds.length > 1) {
        formattedTemplates = matchedByIds.map(t => ({
          id: t.id,
          templateId: t.templateId,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components: t.components as any[],
          wabaId: t.wabaId ?? undefined,
        }));
      }
    }
    
    if (formattedTemplates.length === 0) {
      formattedTemplates = [{
        id: selectedTemplate.id,
        templateId: selectedTemplate.templateId,
        name: selectedTemplate.name,
        language: selectedTemplate.language,
        status: selectedTemplate.status,
        category: selectedTemplate.category,
        components: selectedTemplate.components as any[],
        wabaId: selectedTemplate.wabaId ?? undefined,
      }];
    }
    
    const rotationMode = (campConfig.rotationMode as string) || 'sequential';
    
    if (formattedTemplates.length > 1) {
      console.log(`   🔄 Rotação de templates ativa: ${formattedTemplates.length} templates (modo: ${rotationMode})`);
      formattedTemplates.forEach((t, i) => {
        console.log(`      ${i + 1}. ${t.name} (${t.category})`);
      });
    }

    const shuffledLeads = stealthScheduler.shuffleByGeography(leads, prioritizedNumbers.length);
    if (shuffledLeads.length !== leads.length) {
      console.log(`⚠️ DDD shuffle retornou ${shuffledLeads.length} leads (esperado ${leads.length}), usando original`);
    } else {
      for (let i = 0; i < leads.length; i++) {
        leads[i] = shuffledLeads[i];
      }
      console.log(`🗺️ DDD shuffle aplicado: ${leads.length} leads reordenados por distribuição geográfica`);
    }

    const mpcModule = await import('./services/engine/MultiPhoneEngineCoordinator');
    multiPhoneCoordinator = mpcModule.multiPhoneCoordinator;
    
    const distributions = await multiPhoneCoordinator.distributeLeads(
      leads,
      prioritizedNumbers.map(p => ({
        id: p.id,
        display_phone_number: p.display_phone_number,
        quality_rating: p.quality_rating,
        verified_name: p.verified_name
      }))
    );
    
    if (distributions.length === 0) {
      throw new Error('Nenhum número disponível com quota para envio');
    }
    
    console.log(`\n📊 DISTRIBUIÇÃO MULTI-NÚMERO:`);
    distributions.forEach(d => {
      console.log(`   📱 ${d.displayPhoneNumber}: ${d.leads.length} leads (quota: ${d.remainingQuota})`);
    });
    
    // Executar engines em paralelo para cada número
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalMetaBlocked = 0;
    const startTime = Date.now();

    const deliveryThresholds = {
      autoPause: campConfig.deliveryRateAutoPauseThreshold as number | undefined,
      reduce: campConfig.deliveryRateReduceThreshold as number | undefined,
      windowMs: campConfig.deliveryRateWindowMs as number | undefined,
      blockRateAutoPause: campConfig.blockRateAutoPauseThreshold as number | undefined,
    };
    
    // Hard guard: in multi-WABA mode, every template must carry a wabaId so the
    // engine can enforce template isolation per sender. Fail fast rather than
    // silently sending a template via the wrong WABA.
    if (wabaConfigs && wabaConfigs.length > 1) {
      const missingWabaIdTemplates = formattedTemplates.filter(t => !t.wabaId);
      if (missingWabaIdTemplates.length > 0) {
        const names = missingWabaIdTemplates.map(t => t.name).join(', ');
        console.error(`[TEMPLATE] Multi-WABA guard FAILED: templates without wabaId=[${names}] — these templates cannot be isolated per WABA. Ensure each template is synced under a specific WABA.`);
        throw new Error(`Multi-WABA isolation guard: templates without WABA assignment: ${names}`);
      }
    }

    if (formattedTemplates.length > 0) {
      setCampaignTemplate(campaignId, formattedTemplates[0].name);
    }

    campaignStore.init(campaignId, leads.length);
    campaignStore.update(campaignId, { status: 'RUNNING', tier: speedMode || 'NORMAL' });
    campaignStore.addLog(campaignId, 'INFO', `Campanha iniciada com ${leads.length} leads, ${distributions.length} número(s)`);

    const parentAdapter = getOrCreateAdapter(campaignId, leads.length);
    parentAdapter.publishStateChange('RUNNING', 'Campanha iniciada');

    // Build warmup rate map: phoneNumberId → max-msgs/s for uniform distribution pacing
    const warmupRateMap = new Map<string, number>();
    {
      const selectedNums = (campaign.selectedNumbers as Array<{ phoneNumberId?: string; wabaId?: string }> | null) || [];
      if (selectedNums.length > 0) {
        const { getWarmupSendRate } = await import('./services/engine/SenderPool');
        for (const sel of selectedNums) {
          if (sel.phoneNumberId && sel.wabaId) {
            try {
              const rate = await getWarmupSendRate(sel.phoneNumberId, sel.wabaId);
              if (rate !== null) {
                warmupRateMap.set(sel.phoneNumberId, rate);
                console.log(`[WarmupPacing] ${sel.phoneNumberId}: ${rate.toFixed(6)} msgs/s (distribuição uniforme ao longo do dia)`);
              }
            } catch (warmupErr: any) {
              console.warn(`[WarmupPacing] Erro ao obter rate para ${sel.phoneNumberId}: ${warmupErr.message}`);
            }
          }
        }
      }
    }

    if (distributions.length === 1) {
      const dist = distributions[0];
      const engine = createUltraStableEngine(`${campaignId}-${dist.phoneNumberId}`, speedMode, undefined, undefined, campaignId, wabaConfigs, templateWeights, deliveryThresholds);
      engine.rotationMode = rotationMode;
      engine.setMultiPhoneCoordinator(multiPhoneCoordinator!);
      // Apply warmup pacing if this number is in warmup
      const warmupRate = warmupRateMap.get(dist.phoneNumberId);
      if (warmupRate !== undefined) engine.setHardRateLimit(warmupRate);
      engines.set(dist.phoneNumberId, engine);
      activeEngines.add(engine);
      
      try {
        const progress = await engine.startCampaign(
          dist.leads,
          [{ id: dist.phoneNumberId, display_phone_number: dist.displayPhoneNumber, quality_rating: dist.qualityRating }],
          formattedTemplates,
          config.metaToken,
          async (campaignProgress) => {
            await updateCampaignInDbAndStorage(campaignId, {
              sentMessages: campaignProgress.successfulSends,
              successMessages: campaignProgress.successfulSends,
              failedMessages: campaignProgress.failedSends,
              updatedAt: new Date()
            });
          },
          forcedLanguage
        );
        
        totalSuccess = progress.successfulSends;
        totalFailed = progress.failedSends;
        const ultraStats = engine.getUltraStats();
        totalMetaBlocked += (ultraStats?.metaBlockedSends || 0);

        await multiPhoneCoordinator!.recordMessagesSent(
          dist.phoneNumberId,
          dist.displayPhoneNumber,
          dist.tier,
          dist.tierLimit,
          progress.successfulSends
        );
      } finally {
        activeEngines.delete(engine);
      }
    } else {
      const progressTracker = { totalSuccess: 0, totalFailed: 0 };

      // Build per-phone engines first so we can wire the shared CampaignDecisionEngine before starting them
      const phoneEngineMap = new Map<string, UltraStableCampaignSender>();
      for (const dist of distributions) {
        const engine = createUltraStableEngine(`${campaignId}-${dist.phoneNumberId}`, speedMode, undefined, undefined, campaignId, wabaConfigs, templateWeights, deliveryThresholds);
        engine.rotationMode = rotationMode;
        // Apply warmup pacing for this number if it's in warmup
        const distWarmupRate = warmupRateMap.get(dist.phoneNumberId);
        if (distWarmupRate !== undefined) engine.setHardRateLimit(distWarmupRate);
        phoneEngineMap.set(dist.phoneNumberId, engine);
        engines.set(dist.phoneNumberId, engine);
        activeEngines.add(engine);
      }

      // Build shared CampaignDecisionEngine spanning all phones
      const allPhoneIds = distributions.map(d => d.phoneNumberId);
      const phoneWabaMap = new Map<string, string>();
      const sharedTokenBuckets = new Map<string, import('./services/engine/TokenBucket').TokenBucket>();
      for (const dist of distributions) {
        const ownerWaba = (wabaConfigs || []).find((w) => w.phoneNumberIds.includes(dist.phoneNumberId));
        phoneWabaMap.set(dist.phoneNumberId, ownerWaba?.wabaId || 'default');
        sharedTokenBuckets.set(dist.phoneNumberId, phoneEngineMap.get(dist.phoneNumberId)!.getTokenBucket());
      }
      const primaryWabaId = phoneWabaMap.get(allPhoneIds[0]) || 'default';
      const sharedResponseRateTracker = new ResponseRateTracker();
      const sharedDeliveryMetrics = phoneEngineMap.get(allPhoneIds[0])!.getDeliveryMetrics();
      const sharedDecisionEngine = new CampaignDecisionEngine(
        { campaignId, wabaId: primaryWabaId, phoneNumberIds: allPhoneIds, phoneWabaMap, minRefillRate: 0.1 },
        sharedDeliveryMetrics,
        sharedResponseRateTracker,
        null,
        sharedTokenBuckets
      );

      // Pause all engines when campaign pause is triggered
      sharedDecisionEngine.onPauseCampaign((cId, reason) => {
        console.log(`[DECISION] SharedEngine pause_campaign campaignId=${cId} reason="${reason}"`);
        phoneEngineMap.forEach(eng => eng.pause());
      });
      sharedDecisionEngine.onDisableNumber((cId, phoneId, reason) => {
        console.log(`[DECISION] SharedEngine disable_number campaignId=${cId} phoneId=${phoneId} reason="${reason}"`);
        const eng = phoneEngineMap.get(phoneId);
        if (eng) eng.pause();
      });

      // Register shared response rate tracker under base campaignId so webhook fanout hits it
      registerResponseRateTracker(campaignId, sharedResponseRateTracker);

      const firstPhoneId = allPhoneIds[0];
      for (const dist of distributions) {
        const eng = phoneEngineMap.get(dist.phoneNumberId)!;
        eng.setDecisionEngine(sharedDecisionEngine);
        eng.setMultiPhoneCoordinator(multiPhoneCoordinator!);
        if (dist.phoneNumberId === firstPhoneId) {
          const firstRepScore = eng.getPhoneReputationScore();
          if (firstRepScore) {
            sharedDecisionEngine.registerPhoneReputationScore(firstPhoneId, firstRepScore);
          }
        } else {
          sharedDecisionEngine.subscribeToPhoneTrackers(
            eng.getDeliveryMetrics(),
            eng.getResponseRateTracker(),
            eng.getPhoneReputationScore(),
            dist.phoneNumberId
          );
        }
      }

      sharedDecisionEngine.setCoordinator(multiPhoneCoordinator!);
      sharedDecisionEngine.logValidation();

      sharedDecisionEngine.onRebalance((cId, weights) => {
        const weightLog = Array.from(weights.entries()).map(([id, w]) => `${id}:${w.toFixed(2)}`).join(', ');
        console.log(`[DECISION] SharedEngine rebalance campaignId=${cId} weights=[${weightLog}]`);
        const weightsArray = Array.from(weights.entries());
        for (const [phoneId, weight] of weightsArray) {
          multiPhoneCoordinator!.setPhoneWeight(phoneId, weight);
          const eng = phoneEngineMap.get(phoneId);
          if (eng && weight <= 0.2) { eng.pause(); }
        }
      });

      const enginePromises = distributions.map(async (dist) => {
        const engine = phoneEngineMap.get(dist.phoneNumberId)!;
        
        console.log(`\n🚀 Iniciando engine para ${dist.displayPhoneNumber} com ${dist.leads.length} leads`);
        
        try {
        const progress = await engine.startCampaign(
          dist.leads,
          [{ id: dist.phoneNumberId, display_phone_number: dist.displayPhoneNumber, quality_rating: dist.qualityRating }],
          formattedTemplates,
          config.metaToken,
          async (campaignProgress) => {
            progressTracker.totalSuccess = totalSuccess + campaignProgress.successfulSends;
            progressTracker.totalFailed = totalFailed + campaignProgress.failedSends;
            
            await updateCampaignInDbAndStorage(campaignId, {
              sentMessages: progressTracker.totalSuccess,
              successMessages: progressTracker.totalSuccess,
              failedMessages: progressTracker.totalFailed,
              updatedAt: new Date()
            });

            const aggregatedProcessed = progressTracker.totalSuccess + progressTracker.totalFailed;
            const aggregatedProgress = leads.length > 0 ? Math.round((aggregatedProcessed / leads.length) * 1000) / 10 : 0;
            const aggregatedMetrics: GlobalCampaignMetrics = {
              campaignId,
              state: 'RUNNING',
              currentMsgPerSec: Math.round(campaignProgress.currentRate * 10) / 10,
              peakMsgPerSec: Math.round(campaignProgress.peakRate * 10) / 10,
              avgMsgPerSec: Math.round(campaignProgress.currentRate * 10) / 10,
              totalProcessed: aggregatedProcessed,
              totalSuccess: progressTracker.totalSuccess,
              totalFailed: progressTracker.totalFailed,
              totalLeads: leads.length,
              progressPercent: aggregatedProgress,
              eta: { remainingSeconds: 0, estimatedCompletion: new Date().toISOString(), confidenceLevel: 'low' },
              latency: { p50: 0, p95: 0, p99: 0, avg: 0, trend: 'stable' },
              errors: { total: 0, rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, templateErrors: 0, timeoutErrors: 0 },
              metaBlockedCount: 0,
              preflightErrors: 0,
              environmentStatus: 'ok',
              safeModeActive: false,
              pauseActive: false,
              failSafeActive: false,
              healthState: 'HEALTHY',
              indicators: { health: 'GREEN', speed: 'NORMAL', risk: 'LOW', healthReason: '', speedReason: '', riskReason: '' },
            };
            metricsPublisher.updateGlobalMetrics(campaignId, aggregatedMetrics);
          },
          forcedLanguage
        );
        
        // Registrar mensagens no contador diário
        await multiPhoneCoordinator!.recordMessagesSent(
          dist.phoneNumberId,
          dist.displayPhoneNumber,
          dist.tier,
          dist.tierLimit,
          progress.successfulSends
        );
        
        return {
          phoneNumberId: dist.phoneNumberId,
          displayPhoneNumber: dist.displayPhoneNumber,
          success: progress.successfulSends,
          failed: progress.failedSends,
          metaBlocked: engine.getUltraStats()?.metaBlockedSends || 0,
          rate: progress.currentRate
        };
        } finally {
          activeEngines.delete(engine);
        }
      });
      
      // Aguardar todos os engines completarem
      const results = await Promise.all(enginePromises);
      
      // Agregar resultados finais
      for (const result of results) {
        totalSuccess += result.success;
        totalFailed += result.failed;
        totalMetaBlocked += result.metaBlocked;
        console.log(`   ✅ ${result.displayPhoneNumber}: ${result.success} enviadas, ${result.failed} falhas, ${result.metaBlocked} bloqueadas (${result.rate.toFixed(1)} msg/s)`);
      }
      
      // Atualizar progresso final consolidado
      await updateCampaignInDbAndStorage(campaignId, {
        sentMessages: totalSuccess,
        successMessages: totalSuccess,
        failedMessages: totalFailed,
        updatedAt: new Date()
      });
    }
    
    const elapsed = (Date.now() - startTime) / 1000;
    const overallRate = elapsed > 0 ? totalSuccess / elapsed : 0;

    parentAdapter.publishStateChange('COMPLETED', 'Disparo finalizado');
    const finalMetrics: GlobalCampaignMetrics = {
      campaignId,
      state: 'COMPLETED',
      currentMsgPerSec: 0,
      peakMsgPerSec: Math.round(overallRate * 10) / 10,
      avgMsgPerSec: Math.round(overallRate * 10) / 10,
      totalProcessed: leads.length,
      totalSuccess,
      totalFailed,
      totalLeads: leads.length,
      progressPercent: 100,
      eta: { remainingSeconds: 0, estimatedCompletion: new Date().toISOString(), confidenceLevel: 'high' },
      latency: { p50: 0, p95: 0, p99: 0, avg: 0, trend: 'stable' },
      errors: { total: totalFailed, rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, templateErrors: 0, timeoutErrors: 0 },
      metaBlockedCount: totalMetaBlocked,
      preflightErrors: 0,
      environmentStatus: totalMetaBlocked > 0 && totalSuccess === 0 ? 'blocked' : 'ok',
      safeModeActive: false,
      pauseActive: false,
      failSafeActive: false,
      healthState: 'HEALTHY',
      indicators: { health: 'GREEN', speed: 'NORMAL', risk: 'LOW', healthReason: '', speedReason: '', riskReason: '' },
    };
    metricsPublisher.updateGlobalMetrics(campaignId, finalMetrics);
    parentAdapter.publishComplete({ total: leads.length, success: totalSuccess, failed: totalFailed, duration: Date.now() - startTime });

    // Atualizar status final
    let finalStatus = "completed";
    const realFailures = totalFailed;
    if (totalSuccess === 0 && totalMetaBlocked > 0 && realFailures === 0) {
      finalStatus = "blocked_by_meta_environment";
    } else if (totalSuccess === 0 && realFailures > 0) {
      finalStatus = "failed";
    }
    
    await updateCampaignInDbAndStorage(campaignId, {
      status: finalStatus,
      completedAt: new Date(),
      sentMessages: totalSuccess,
      successMessages: totalSuccess,
      failedMessages: totalFailed + totalMetaBlocked,
      updatedAt: new Date()
    });
    
    campaignStore.update(campaignId, { 
      status: finalStatus === 'completed' ? 'COMPLETED' : 'FAILED',
      accepted: totalSuccess,
      failed: totalFailed,
      blocked: totalMetaBlocked,
    });
    campaignStore.addLog(campaignId, 'INFO', `Campanha finalizada: ${totalSuccess} enviadas, ${totalFailed} erros, ${totalMetaBlocked} bloqueadas`);

    if (usePackageImage) {
      console.log(`🗑️ Imagens da campanha ${campaignId} serão limpas pelo job periódico de cleanup`);
    }

    console.log(`\n✅ OVERDRIVE V3 MULTI-NÚMERO: Campanha ${campaignId} concluída (status: ${finalStatus})`);
    console.log(`   📊 Total enviadas: ${totalSuccess}, Meta bloqueadas: ${totalMetaBlocked}, Erros reais: ${totalFailed}`);
    console.log(`   📈 Taxa média: ${overallRate.toFixed(2)} msg/s`);
    console.log(`   📱 Números utilizados: ${distributions.length}`);
    console.log(`   ⏱️ Tempo total: ${elapsed.toFixed(1)}s`);
    
  } catch (error) {
    routeError('OVERDRIVE V3: Erro na execução:', {}, error);
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    let status = 'failed';
    
    if (errorMessage.includes('OAUTH_ERROR') || errorMessage.includes('OAuth access token')) {
      status = 'oauth_error';
    }
    
    await updateCampaignInDbAndStorage(campaignId, { 
      status,
      updatedAt: new Date()
    });
    
    throw error;
  } finally {
    Array.from(engines.keys()).forEach(phoneId => {
      cleanupUltraStableEngine(`${campaignId}-${phoneId}`);
    });
    unregisterResponseRateTracker(campaignId);
    clearCampaignTemplate(campaignId);
    multiPhoneCoordinator?.clearRuntimeWeightOverrides();
    if (ultraCheckpoints.has(campaignId)) {
      ultraCheckpoints.delete(campaignId);
      console.log(`[MEMORY_CLEANUP] ultraCheckpoints cleared for terminal campaign ${campaignId}`);
    }
  }
}

// ============================================================================
// OVERDRIVE V3 - FUNÇÃO DE RETOMADA DE CAMPANHA (ULTRA-ESTÁVEL)
// ============================================================================
export async function executeUltraStableCampaignWithResume(campaignId: string, startFromIndex: number = 0, forcedLanguage?: string): Promise<void> {
  const engine = createUltraStableEngine(campaignId);
  
  try {
    console.log(`🔄 OVERDRIVE V3: Retomando campanha ${campaignId} do índice ${startFromIndex}`);
    
    const campaign = await getCampaignFromDbOrStorage(campaignId);
    if (!campaign) throw new Error('Campanha não encontrada');
    
    const config = await getApiConfigFromDbOrStorage(campaign.userId);
    if (!config || !config.isValid) throw new Error('Configuração da API inválida');

    try {
      await validateMetaConfig(config.metaToken || '');
      console.log(`   ✅ Token Meta validado com sucesso para retomada de campanha ${campaignId}`);
    } catch (tokenErr: any) {
      console.error(`[validateMetaConfig] Retomada de campanha ${campaignId} bloqueada:`, tokenErr.message);
      throw new Error(tokenErr.message);
    }

    const allTemplates = await getTemplatesFromDbOrStorage(campaign.userId);
    let selectedTemplate = allTemplates.find(t => t.id === campaign.templateId && t.status === 'APPROVED');
    if (!selectedTemplate) {
      selectedTemplate = allTemplates.find(t => t.templateId === campaign.templateId && t.status === 'APPROVED');
    }
    if (!selectedTemplate) {
      selectedTemplate = allTemplates.find(t => t.name === campaign.templateId && t.status === 'APPROVED');
    }
    if (!selectedTemplate) throw new Error(`Template não encontrado ou não aprovado`);
    
    const leads = await getLeadsByListFromDbOrStorage(campaign.leadListId!);
    if (leads.length === 0) throw new Error('Nenhum lead encontrado');
    
    // Pegar apenas leads restantes
    const remainingLeads = leads.slice(startFromIndex);
    
    const phoneNumbers = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
    if (phoneNumbers.length === 0) throw new Error('Nenhum número de telefone disponível');
    
    const prioritizedNumbers = phoneNumbers.sort((a, b) => {
      const priority = { 'GREEN': 3, 'YELLOW': 2, 'RED': 1 };
      return (priority[b.quality_rating as keyof typeof priority] || 0) - 
             (priority[a.quality_rating as keyof typeof priority] || 0);
    });
    
    // Warmup enrollment: ensure UNKNOWN numbers respect conservative 250/day quota
    // Also compute the warmup-safe send rate for uniform day distribution pacing
    const campaignSelectedNums = (campaign.selectedNumbers as Array<{ phoneNumberId?: string; wabaId?: string }> | null) || [];
    let warmupHardRate: number | undefined;
    if (campaignSelectedNums.length > 0) {
      const { upsertSenderWithWarmup, getWarmupSendRate } = await import('./services/engine/SenderPool');
      for (const sel of campaignSelectedNums) {
        if (sel.phoneNumberId && sel.wabaId) {
          try {
            await upsertSenderWithWarmup(sel.phoneNumberId, sel.wabaId);
            const rate = await getWarmupSendRate(sel.phoneNumberId, sel.wabaId);
            if (rate !== null) {
              // Use the most conservative rate across all warmup numbers
              warmupHardRate = warmupHardRate === undefined ? rate : Math.min(warmupHardRate, rate);
            }
          } catch (warmupErr: any) {
            console.warn(`[WarmupEnroll] Falha ao enrolar ${sel.phoneNumberId}: ${warmupErr.message}`);
          }
        }
      }
    }
    if (warmupHardRate !== undefined) {
      console.log(`[WarmupPacing] Hard rate limit aplicado: ${warmupHardRate.toFixed(6)} msgs/s (distribuição uniforme ao longo do dia)`);
      engine.setHardRateLimit(warmupHardRate);
    }

    console.log(`   📱 Número: ${prioritizedNumbers[0].display_phone_number}`);
    console.log(`   📊 Leads restantes: ${remainingLeads.length}`);
    
    await updateCampaignInDbAndStorage(campaignId, {
      status: "running",
      updatedAt: new Date()
    });
    
    const formattedTemplate = {
      id: selectedTemplate.id,
      name: selectedTemplate.name,
      language: selectedTemplate.language,
      status: selectedTemplate.status,
      category: selectedTemplate.category,
      components: selectedTemplate.components as any[]
    };
    
    // Retomar com OVERDRIVE V3
    const progress = await engine.startCampaign(
      remainingLeads,
      prioritizedNumbers,
      [formattedTemplate],
      config.metaToken,
      async (campaignProgress) => {
        await updateCampaignInDbAndStorage(campaignId, {
          sentMessages: startFromIndex + campaignProgress.successfulSends,
          successMessages: startFromIndex + campaignProgress.successfulSends,
          failedMessages: campaignProgress.failedSends,
          updatedAt: new Date()
        });
      },
      forcedLanguage
    );
    
    let finalStatus = "completed";
    const totalSuccessResume = startFromIndex + progress.successfulSends;
    const resumeUltraStats = engine.getUltraStats();
    const resumeMetaBlocked = resumeUltraStats?.metaBlockedSends || 0;
    const resumeRealFailed = progress.failedSends;
    if (totalSuccessResume === 0 && resumeMetaBlocked > 0 && resumeRealFailed === 0) {
      finalStatus = "blocked_by_meta_environment";
    } else if (totalSuccessResume === 0 && resumeRealFailed > 0) {
      finalStatus = "failed";
    }
    
    await updateCampaignInDbAndStorage(campaignId, {
      status: finalStatus,
      completedAt: new Date(),
      sentMessages: totalSuccessResume,
      successMessages: totalSuccessResume,
      failedMessages: resumeRealFailed + resumeMetaBlocked,
      updatedAt: new Date()
    });
    
    console.log(`✅ OVERDRIVE V3: Campanha retomada ${campaignId} concluída (status: ${finalStatus})`);
    console.log(`   📊 Enviadas: ${progress.successfulSends}, Meta bloqueadas: ${resumeMetaBlocked}, Erros: ${resumeRealFailed}`);
    
  } catch (error) {
    routeError('OVERDRIVE V3: Erro ao retomar:', {}, error);
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    let status = 'failed';
    
    if (errorMessage.includes('OAUTH_ERROR') || errorMessage.includes('OAuth access token')) {
      status = 'oauth_error';
    }
    
    await updateCampaignInDbAndStorage(campaignId, { 
      status,
      updatedAt: new Date()
    });
    
    throw error;
  } finally {
    cleanupUltraStableEngine(campaignId);
    if (ultraCheckpoints.has(campaignId)) {
      ultraCheckpoints.delete(campaignId);
      console.log(`[MEMORY_CLEANUP] ultraCheckpoints cleared for terminal campaign ${campaignId} (resume)`);
    }
  }
}

// Alias para compatibilidade
const executeParallelCampaignWithResume = executeUltraStableCampaignWithResume;

async function executeCampaign(campaignId: string): Promise<void> {
  const metricsAdapter = getOrCreateAdapter(campaignId);
  const startTime = Date.now();
  
  try {
    const campaign = await getCampaignFromDbOrStorage(campaignId);
    if (!campaign) {
      removeAdapter(campaignId);
      return;
    }
    
    const config = await getApiConfigFromDbOrStorage(campaign.userId);
    if (!config || !config.isValid) {
      removeAdapter(campaignId);
      return;
    }

    try {
      await validateMetaConfig(config.metaToken || '');
      console.log(`   ✅ Token Meta validado com sucesso para campanha ${campaignId}`);
    } catch (tokenErr: any) {
      console.error(`[validateMetaConfig] Campanha ${campaignId} bloqueada:`, tokenErr.message);
      removeAdapter(campaignId);
      throw new Error(tokenErr.message);
    }

    const allTemplatesExec = await getTemplatesFromDbOrStorage(campaign.userId);
    const template = allTemplatesExec.find(t => t.id === campaign.templateId);
    if (!template) {
      removeAdapter(campaignId);
      return;
    }
    
    const leads = await getLeadsByListFromDbOrStorage(campaign.leadListId!);
    
    metricsAdapter.publishStateChange('RUNNING', 'Campaign started');
    
    console.log(`Iniciando distribuição de ${leads.length} leads para campanha ${campaignId}`);
    
    const distributionResult = await distributeLeadsForCampaign(leads, config, 1000);
    
    console.log(`Leads distribuídos entre ${distributionResult.totalPhones} números:`);
    distributionResult.distributions.forEach((dist, index) => {
      console.log(`${index + 1}. ${dist.displayPhoneNumber}: ${dist.messageCount} leads`);
    });
    
    await updateCampaignInDbAndStorage(campaignId, {
      status: "running",
      startedAt: new Date(),
    });
    
    let totalSentCount = 0;
    let totalFailedCount = 0;
    
    // Processar cada distribuição sequencialmente para evitar rate limits
    for (const distribution of distributionResult.distributions) {
      let sentCount = 0;
      let failedCount = 0;
      
      console.log(`Processando ${distribution.messageCount} leads no número ${distribution.displayPhoneNumber}`);
      
      for (const lead of distribution.leads) {
        if (campaign.isTestMode && totalSentCount >= 5) break; // Limitar modo de teste
        
        try {
          // Criar parâmetros do template baseado nos dados do lead
          const bodyParameters: Array<{type: 'text', text: string}> = [];
          const buttonParameters: Array<{type: 'text', text: string}> = [];
          
          // Verificar se o template tem componentes que requerem parâmetros
          if (template.components && Array.isArray(template.components)) {
            // Processar componente BODY
            const bodyComponent = template.components.find((comp: any) => comp.type === 'BODY');
            if (bodyComponent && bodyComponent.text) {
              const paramMatches = bodyComponent.text.match(/\{\{\d+\}\}/g);
              if (paramMatches) {
                for (let i = 0; i < paramMatches.length; i++) {
                  if (i === 0) {
                    // {{1}} = CPF do lead (conforme template aprovado: documento *{{1}}*)
                    let cpfParam = lead.cpf || lead.codigoRastreio || '00000000000';
                    // Sanitizar CPF: remover pontos, traços e espaços
                    cpfParam = cpfParam.replace(/[.\-\s]/g, '');
                    bodyParameters.push({ type: 'text', text: cpfParam });
                  } else if (i === 1) {
                    // {{2}} = Nome do lead (conforme template: Prezado(a) {{2}})
                    const nomeParam = lead.name || 'Cliente';
                    bodyParameters.push({ type: 'text', text: nomeParam });
                  } else {
                    bodyParameters.push({ type: 'text', text: 'Informação' });
                  }
                }
              }
            }
            
            // Processar componente BUTTONS
            const buttonComponent = template.components.find((comp: any) => comp.type === 'BUTTONS');
            if (buttonComponent && buttonComponent.buttons) {
              buttonComponent.buttons.forEach((button: any, index: number) => {
                if (button.type === 'URL' && button.url && button.url.includes('{{')) {
                  // {{1}} no botão URL = SEMPRE CPF (11 dígitos) conforme template aprovado
                  // Prioridade: cpf > codigoRastreio > fallback
                  let rawValue = lead.cpf || lead.codigoRastreio || '00000000000';
                  // Sanitizar: remover pontos, traços e espaços para garantir apenas números
                  let buttonValue = rawValue.replace(/[.\-\s]/g, '');
                  
                  // VALIDAÇÃO CRÍTICA: Garantir exatamente 11 dígitos
                  if (buttonValue.length !== 11) {
                    console.log(`⚠️ ATENÇÃO: CPF com ${buttonValue.length} dígitos (esperado: 11). Usando fallback.`);
                    buttonValue = '00000000000'; // Fallback seguro
                  }
                  
                  buttonParameters.push({ type: 'text', text: buttonValue });
                  console.log(`🎯 Parâmetro botão {{1}} configurado (${buttonValue.length} dígitos)`);
                }
              });
            }
          }
          
          // LOG FINAL DOS PARÂMETROS
          console.log(`\n=== PARÂMETROS FINAIS ===`);
          console.log(`Body parameters:`, JSON.stringify(bodyParameters, null, 2));
          console.log(`Button parameters:`, JSON.stringify(buttonParameters, null, 2));
          console.log(`===========================\n`);
          
          // Verificar se temos número de telefone válido
          const phoneNumber = lead.phone || '';
          if (!phoneNumber) {
            console.error(`❌ ERRO: Telefone não encontrado para lead`);
            throw new Error('Número de telefone obrigatório');
          }

          console.log(`📞 Processando envio para lead`);

          // Escolher método de envio baseado nos parâmetros necessários
          if (buttonParameters.length > 0) {
            // Template com botões dinâmicos
            await sendTemplateWithButtons(
              distribution.phoneNumberId,
              phoneNumber,
              template.name,
              template.language,
              bodyParameters.length > 0 ? bodyParameters : undefined,
              buttonParameters,
              config.metaToken
            );
          } else {
            // Template simples ou só com body
            await sendTemplateMessage(
              distribution.phoneNumberId,
              phoneNumber,
              template.name,
              template.language,
              bodyParameters,
              config.metaToken
            );
          }
          
          sentCount++;
          totalSentCount++;
          console.log(`✅ Mensagem enviada via ${distribution.displayPhoneNumber}`);
          
          await updateCampaignInDbAndStorage(campaignId, {
            sentMessages: totalSentCount,
            sentCount: totalSentCount,
            successMessages: totalSentCount,
            failedMessages: totalFailedCount,
            failedCount: totalFailedCount,
            updatedAt: new Date()
          });
          
          // Publicar métricas SSE em tempo real
          const elapsed = (Date.now() - startTime) / 1000;
          const currentRate = elapsed > 0 ? totalSentCount / elapsed : 0;
          metricsAdapter.updateFromEngineStats({
            campaignId,
            processedLeads: totalSentCount + totalFailedCount,
            successfulSends: totalSentCount,
            failedSends: totalFailedCount,
            totalLeads: leads.length,
            currentRate,
            peakRate: currentRate,
            averageRttMs: 150,
            burstState: 'normal',
            circuitBreakerTrips: 0,
            totalRetries: 0,
            tokenBucketRate: 1,
            circuitState: 'closed',
            inFlightRequests: 0,
            eta: {
              remainingSeconds: currentRate > 0 ? (leads.length - totalSentCount - totalFailedCount) / currentRate : 0,
              estimatedCompletion: new Date(Date.now() + ((leads.length - totalSentCount - totalFailedCount) / Math.max(currentRate, 0.1)) * 1000),
              confidence: 'medium'
            },
            retryQueue: { size: 0, processed: 0, failed: 0 },
            errorCounts: { rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, unknownErrors: totalFailedCount, total: totalFailedCount },
            campaignState: 'RUNNING'
          });
          
          // Delay entre mensagens para evitar rate limit
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          failedCount++;
          totalFailedCount++;
          const phoneToShow = lead.phone || 'telefone indefinido';
          routeError('routes.campaignSendLead', { phone: phoneToShow, campaignId }, error);
          
          await updateCampaignInDbAndStorage(campaignId, {
            sentMessages: totalSentCount,
            sentCount: totalSentCount,
            successMessages: totalSentCount,
            failedMessages: totalFailedCount,
            failedCount: totalFailedCount,
            updatedAt: new Date()
          });
          
          // Publicar métricas SSE para falha também
          const elapsedFail = (Date.now() - startTime) / 1000;
          const currentRateFail = elapsedFail > 0 ? (totalSentCount + totalFailedCount) / elapsedFail : 0;
          metricsAdapter.updateFromEngineStats({
            campaignId,
            processedLeads: totalSentCount + totalFailedCount,
            successfulSends: totalSentCount,
            failedSends: totalFailedCount,
            totalLeads: leads.length,
            currentRate: currentRateFail,
            peakRate: currentRateFail,
            averageRttMs: 200,
            burstState: 'stress',
            circuitBreakerTrips: 0,
            totalRetries: 1,
            tokenBucketRate: 0.8,
            circuitState: 'closed',
            inFlightRequests: 0,
            eta: {
              remainingSeconds: currentRateFail > 0 ? (leads.length - totalSentCount - totalFailedCount) / currentRateFail : 0,
              estimatedCompletion: new Date(Date.now() + ((leads.length - totalSentCount - totalFailedCount) / Math.max(currentRateFail, 0.1)) * 1000),
              confidence: 'low'
            },
            retryQueue: { size: 0, processed: 0, failed: totalFailedCount },
            errorCounts: { rateLimitErrors: 0, payloadErrors: totalFailedCount, networkErrors: 0, authErrors: 0, environmentErrors: 0, unknownErrors: 0, total: totalFailedCount },
            campaignState: totalFailedCount > leads.length * 0.1 ? 'DEGRADED' : 'RUNNING'
          });
          metricsAdapter.publishError('payload', String(error), distribution.phoneNumberId);
        }
      }
      
      console.log(`Número ${distribution.displayPhoneNumber}: ${sentCount} enviadas, ${failedCount} falhas`);
    }
    
    // Atualizar campanha com resultado final
    await updateCampaignInDbAndStorage(campaignId, {
      status: "completed",
      completedAt: new Date(),
      sentMessages: totalSentCount,
      sentCount: totalSentCount,
      successMessages: totalSentCount,
      failedMessages: totalFailedCount,
      failedCount: totalFailedCount,
      updatedAt: new Date()
    });
    
    // Publicar evento de conclusão via SSE
    const duration = (Date.now() - startTime) / 1000;
    metricsAdapter.publishStateChange('COMPLETED', 'Campaign finished successfully');
    metricsAdapter.publishComplete({
      total: leads.length,
      success: totalSentCount,
      failed: totalFailedCount,
      duration
    });
    removeAdapter(campaignId);
    
    console.log(`Campanha ${campaignId} concluída: ${totalSentCount} enviadas, ${totalFailedCount} falhas`);
    
  } catch (error) {
    routeError('Erro na execução da campanha:', {}, error);
    metricsAdapter.publishStateChange('FAILED_GRACEFULLY', `Campaign error: ${error}`);
    removeAdapter(campaignId);
    await updateCampaignInDbAndStorage(campaignId, { 
      status: "failed",
      completedAt: new Date(),
      updatedAt: new Date()
    });
  }
}

registerExecutor(async (campaignId, options) => {
  await executeParallelCampaign(
    campaignId,
    options.batchingRate,
    options.forcedLanguage,
    options.speedMode,
    options.customMessages,
    options.isDynamicUrl,
    options.templateNames,
    options.customRate,
    options.isBlacksky,
    options.blackskyConfig,
    options.isParametroUnico,
    options.parametroUnicoConfig,
    options.usePackageImage,
    options.packageImageType,
    options.packageImageKey,
    options.customImageTemplateId,
    options.wabaConfigs,
    options.templateWeights,
  );
});
