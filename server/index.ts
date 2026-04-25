import express, { type Request, Response, NextFunction } from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { registerRoutes, executeUltraStableCampaignWithResume } from "./routes";
import { registerCampaignRoutes } from "./campaignRoutes";
import { registerAuthRoutes, seedAdminUser } from "./auth";
import { requireAuth } from "./middleware/auth";
import { setupVite, serveStatic, log } from "./vite";
import { startDailyResetJob, stopDailyResetJob } from "./jobs/resetSenderUsage";
import { startImageCleanupJob, stopImageCleanupJob } from "./jobs/imageCleanupJob";
import { startTtsCleanupJob } from "./jobs/ttsCleanupJob";
import { startWebhookQueueWorker, stopWebhookQueueWorker } from "./jobs/webhookQueueWorker";
import { proxyPoolManager } from "./services/proxyPool/ProxyPoolManager";
import { startQualityRatingPoller, stopQualityRatingPoller } from "./jobs/qualityRatingPoller";
import { pool, db } from "./db";
import { logError } from "./utils/logger";
import { initSignedUrlSecret } from "./services/signedUrl";
import { initImageFonts } from "./services/imageGenerator";
import { ttsService } from "./services/tts/TtsService";
import { wabaStorage } from "./wabaStorage";
import { subscribeWabaToApp } from "./meta/metaAPI";
import { wabas as wabasTable, campaigns as campaignsTable } from "@shared/schema";
import { eq } from "drizzle-orm";
import { registerPersistentCampaignTracker } from "./services/engine/DeliveryMetricsTracker";

const __filename_idx = fileURLToPath(import.meta.url);
const __dirname_idx = path.dirname(__filename_idx);

const isProduction = process.env.NODE_ENV === "production";

const REQUIRED_ENV_VARS = ["DATABASE_URL"];

const REQUIRED_IN_PRODUCTION: string[] = ["SESSION_SECRET", "META_APP_SECRET", "WEBHOOK_VERIFY_TOKEN"];

const RECOMMENDED_ENV_VARS = [
  "STATS_API_KEY",
];

const OPTIONAL_ENV_VARS = [
  "WASENDER_API_KEY",
  "TWO_CHAT_API_KEY",
  "TWO_CHAT_SENDER_NUMBER",
  "TRACKFLOW_TOKEN",
  "META_API_VERSION",
  "WHATSAPP_ACCESS_TOKEN",
  "PHONE_IDS",
];

function ensureSessionSecret() {
  if (!process.env.SESSION_SECRET) {
    if (isProduction) {
      console.error("[ENV] ERRO FATAL: SESSION_SECRET não configurada em PRODUÇÃO.");
      console.error("[ENV] Configure SESSION_SECRET no painel Secrets antes de fazer deploy.");
      process.exit(1);
    }
    const generated = crypto.randomBytes(32).toString("hex");
    process.env.SESSION_SECRET = generated;
    log("[ENV] SESSION_SECRET não configurada — gerada temporariamente para desenvolvimento (APENAS DEV)");
  }
}

function validateEnvironment() {
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
      missing.push(varName);
    }
  }

  for (const varName of REQUIRED_IN_PRODUCTION) {
    if (!process.env[varName]) {
      if (isProduction) {
        missing.push(varName);
      } else {
        warnings.push(varName);
      }
    }
  }

  for (const varName of RECOMMENDED_ENV_VARS) {
    if (!process.env[varName]) {
      warnings.push(varName);
    }
  }

  if (missing.length > 0) {
    console.error(`[ENV] ERRO FATAL: Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
    console.error(`[ENV] Configure estas variaveis no painel Secrets da Replit antes de iniciar.`);
    process.exit(1);
  }

  ensureSessionSecret();

  if (warnings.length > 0) {
    log(`[ENV] Variáveis opcionais ausentes (não obrigatórias): ${warnings.join(", ")}`);
  }

  log(`[ENV] Ambiente: ${isProduction ? "PRODUCAO" : "DESENVOLVIMENTO"}`);
}

export { serverStartTime, getLastWebhookEventTime, updateLastWebhookEvent } from "./utils/serverState";


const REQUIRED_TABLES = [
  "users", "api_configurations", "wabas", "waba_numbers", "conversations",
  "messages", "campaign_automation_rules", "parameter_models", "lead_lists",
  "leads", "whatsapp_templates", "campaigns", "message_deliveries",
  "transactions", "transaction_events", "daily_message_counters",
  "sender_usage", "payment_gateways", "csw_sessions", "phone_soft_quotas",
  "waba_hooks", "message_status", "lead_pool_lists", "lead_pool",
  "opt_out_numbers", "phone_warmup_schedules", "follow_up_rules",
  "follow_up_status", "quality_rating_history", "warmup_schedules",
  "campaign_error_logs", "image_templates",
  "bot_flows", "bot_flow_nodes", "bot_conversation_states",
  "image_send_confirmations",
];

async function verifyDatabaseSchema(): Promise<void> {
  try {
    const result = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    const existingTables = new Set(result.rows.map((r: { tablename: string }) => r.tablename));
    const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));

    if (missingTables.length > 0) {
      console.error(`[DB] ERRO FATAL: ${missingTables.length} tabela(s) obrigatória(s) ausente(s): ${missingTables.join(", ")}`);
      console.error(`[DB] Execute 'npm run db:push' para sincronizar o schema antes de iniciar o servidor.`);
      process.exit(1);
    }

    log(`[DB] Schema verificado: ${existingTables.size} tabela(s) encontrada(s), todas as ${REQUIRED_TABLES.length} obrigatorias presentes.`);

    try {
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'conversations' AND column_name = 'phone_number_id'
          ) THEN
            ALTER TABLE conversations ADD COLUMN phone_number_id TEXT;
          END IF;
        END $$;
      `);
    } catch (migrationErr: any) {
      logError('index.dbMigrationPhoneNumberId', {}, migrationErr);
    }

    try {
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'wabas' AND column_name = 'subscribed_apps_at'
          ) THEN
            ALTER TABLE wabas ADD COLUMN subscribed_apps_at TIMESTAMP;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'wabas' AND column_name = 'subscribed_apps_status'
          ) THEN
            ALTER TABLE wabas ADD COLUMN subscribed_apps_status TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'wabas' AND column_name = 'last_webhook_received_at'
          ) THEN
            ALTER TABLE wabas ADD COLUMN last_webhook_received_at TIMESTAMP;
          END IF;
        END $$;
      `);
      log('[DB] Migração de colunas WABA concluída (subscribed_apps_at, subscribed_apps_status, last_webhook_received_at)');
    } catch (migrationErr: any) {
      logError('index.dbMigrationWabaColumns', {}, migrationErr);
    }

    // Add sent_count to quality_rating_history for volume time-series tracking
    try {
      await pool.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'quality_rating_history' AND column_name = 'sent_count'
          ) THEN
            ALTER TABLE quality_rating_history ADD COLUMN sent_count INTEGER DEFAULT 0;
          END IF;
        END $$;
      `);
      log('[DB] Migração quality_rating_history.sent_count concluída');
    } catch (migrationErr: any) {
      logError('index.dbMigrationQualityHistorySentCount', {}, migrationErr);
    }
  } catch (err: any) {
    logError('index.dbSchemaCheck', {}, err);
    process.exit(1);
  }
}

async function loadPersistentTrackersOnStartup(): Promise<void> {
  try {
    const allCampaigns = await db.select({ id: campaignsTable.id }).from(campaignsTable);
    if (allCampaigns.length === 0) {
      log('[PERSISTENT_TRACKER] No campaigns found — no persistent trackers to load');
      return;
    }
    for (const campaign of allCampaigns) {
      registerPersistentCampaignTracker(campaign.id);
    }
    log(`[PERSISTENT_TRACKER] Loaded persistent trackers for ${allCampaigns.length} campaign(s)`);
  } catch (err: any) {
    logError('startup.loadPersistentTrackers', {}, err);
  }
}

async function autoResumeCampaignsOnStartup(): Promise<void> {
  try {
    const runningCampaigns = await db
      .select({ id: campaignsTable.id, successMessages: campaignsTable.successMessages, failedMessages: campaignsTable.failedMessages })
      .from(campaignsTable)
      .where(eq(campaignsTable.status, 'running'));

    if (runningCampaigns.length === 0) {
      log('[CAMPAIGN_RESUME] No campaigns in running state — nothing to resume');
      return;
    }

    log(`[CAMPAIGN_RESUME] Found ${runningCampaigns.length} campaign(s) in running state — will resume after stagger`);

    for (let i = 0; i < runningCampaigns.length; i++) {
      const campaign = runningCampaigns[i];
      const startFromIndex = (campaign.successMessages || 0) + (campaign.failedMessages || 0);

      setTimeout(() => {
        log(`[CAMPAIGN_RESUMED] Resuming campaign ${campaign.id} from index ${startFromIndex}`);
        executeUltraStableCampaignWithResume(campaign.id, startFromIndex).catch((err: any) => {
          logError('startup.autoResumeCampaign', { campaignId: campaign.id }, err);
        });
      }, i * 3000);
    }
  } catch (err: any) {
    logError('startup.autoResumeCampaignsOnStartup', {}, err);
  }
}

async function subscribeAllWabasOnStartup(): Promise<void> {
  const env = process.env.NODE_ENV || 'development';
  log(`[WABA_SUBSCRIBE_START] Iniciando re-inscrição de WABAs no boot (env=${env})`);
  try {
    const allWabas = await db.select().from(wabasTable);
    if (allWabas.length === 0) {
      log('[WABA_SUBSCRIBE_START] Nenhuma WABA cadastrada para inscrever');
      return;
    }

    log(`[WABA_SUBSCRIBE_START] Inscrevendo ${allWabas.length} WABA(s) no subscribed_apps...`);

    let successCount = 0;
    let failCount = 0;

    for (const waba of allWabas) {
      if (!waba.accessToken) {
        log(`[WABA_SUBSCRIBE_SKIP] wabaId=${waba.wabaId} name="${waba.name}" motivo=sem_accessToken`);
        continue;
      }

      try {
        const resp = await subscribeWabaToApp(waba.wabaId, waba.accessToken);
        log(`[WABA_SUBSCRIBED_SUCCESS] wabaId=${waba.wabaId} name="${waba.name}" response=${JSON.stringify(resp).slice(0, 300)}`);
        successCount++;
        try {
          await db.update(wabasTable)
            .set({ subscribedAppsAt: new Date(), subscribedAppsStatus: 'success', updatedAt: new Date() })
            .where(eq(wabasTable.id, waba.id));
        } catch (e) {
          logError('index.updateWabaSubscribeStatus', { wabaId: waba.id }, e);
        }
      } catch (err: any) {
        const metaError = err.message || 'erro desconhecido';
        log(`[WABA_SUBSCRIBE_FAILED] wabaId=${waba.wabaId} name="${waba.name}" error=${metaError}`);
        failCount++;
        try {
          await db.update(wabasTable)
            .set({ subscribedAppsStatus: `failed: ${metaError}`.slice(0, 200), updatedAt: new Date() })
            .where(eq(wabasTable.id, waba.id));
        } catch (e) {
          logError('index.updateWabaSubscribeStatus', { wabaId: waba.id }, e);
        }
      }
    }

    log(`[WABA_SUBSCRIBE_DONE] Inscrição concluída: ${successCount} sucesso(s), ${failCount} falha(s) de ${allWabas.length} WABA(s)`);
  } catch (err: any) {
    logError('index.subscribeAllWabasOnStartup', {}, err);
  }
}

const PUBLIC_PATHS = [
  "/api/auth/",
  "/api/webhook/meta",
  "/api/server-status",
  "/api/signed-media/",
];

const CRITICAL_ENDPOINTS = [
  "/api/server-status",
];

async function verifyEndpointsOnStartup(port: number): Promise<void> {
  const results: { endpoint: string; status: number; ok: boolean }[] = [];
  for (const endpoint of CRITICAL_ENDPOINTS) {
    try {
      const response = await fetch(`http://localhost:${port}${endpoint}`);
      results.push({ endpoint, status: response.status, ok: response.status < 400 });
    } catch (err: any) {
      logError('verifyEndpointsOnStartup', { endpoint, port }, err);
      results.push({ endpoint, status: 0, ok: false });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    log(`[HEALTH] ${failed.length}/${results.length} endpoint(s) com falha: ${failed.map((f) => `${f.endpoint}(${f.status})`).join(", ")}`);
  } else {
    log(`[HEALTH] Todos os ${results.length} endpoints criticos respondendo OK.`);
  }
}

async function verifyWebhookOnStartup(port: number) {
  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    log("[WEBHOOK] WEBHOOK_VERIFY_TOKEN ausente — verificacao ignorada");
    return;
  }

  const challenge = crypto.randomBytes(16).toString("hex");
  const testUrl = `http://localhost:${port}/api/webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challenge}`;

  try {
    const response = await fetch(testUrl);
    const body = await response.text();

    if (response.status === 200 && body === challenge) {
      log("[WEBHOOK] Verificacao automatica: OK — webhook respondendo corretamente");
    } else {
      log(`[WEBHOOK] Verificacao automatica: FALHA — status=${response.status}, resposta=${body.slice(0, 100)}`);
    }
  } catch (err: any) {
    logError('verifyWebhookOnStartup', { port }, err);
  }
}

(async () => {
  try {
    validateEnvironment();

    process.on('uncaughtException', (err) => {
      logError('uncaughtException', {}, err);
      if (isProduction) {
        process.exit(1);
      }
    });

    process.on('unhandledRejection', (reason) => {
      logError('unhandledRejection', {}, reason instanceof Error ? reason : new Error(String(reason)));
    });

    const uploadsDir = path.join(__dirname_idx, '../uploads');
    await fs.promises.mkdir(uploadsDir, { recursive: true });

    await verifyDatabaseSchema();
    await seedAdminUser();
    await initSignedUrlSecret();
    initImageFonts();

    const app = express();
    const trustProxy = process.env.TRUST_PROXY;
    if (trustProxy === 'false' || trustProxy === '0' || trustProxy === 'off') {
      app.set("trust proxy", false);
    } else if (trustProxy === 'true' || trustProxy === '1') {
      app.set("trust proxy", true);
    } else if (trustProxy) {
      const parsed = parseInt(trustProxy, 10);
      app.set("trust proxy", Number.isFinite(parsed) && parsed > 0 ? parsed : trustProxy);
    } else {
      app.set("trust proxy", 1);
    }

    const globalBodyLimit = '1mb';
    app.use(express.json({
      limit: globalBodyLimit,
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }));
    app.use(express.urlencoded({ extended: false, limit: globalBodyLimit }));

    app.use('/uploads/campaign-images', (_req, res) => {
      res.status(403).json({ error: "Use /api/signed-media/:token for campaign images" });
    });

    app.use('/uploads', express.static(uploadsDir, {
      maxAge: '1d',
      acceptRanges: true,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Accept-Ranges', 'bytes');
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.opus' || ext === '.ogg' || ext === '.oga') {
          res.setHeader('Content-Type', 'audio/ogg');
        }
      }
    }));

    app.use('/uploads', (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err && (err.status === 416 || err.statusCode === 416)) {
        const relativePath = path.posix.normalize(req.path || '/').replace(/^\/+/, '');
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          return next(err);
        }
        const resolvedPath = path.resolve(uploadsDir, relativePath);
        if (!resolvedPath.startsWith(path.resolve(uploadsDir) + path.sep) && resolvedPath !== path.resolve(uploadsDir)) {
          return next(err);
        }
        res.removeHeader('Content-Range');
        res.status(200).sendFile(relativePath, { root: uploadsDir, acceptRanges: false }, (fileErr) => {
          if (fileErr) next(fileErr);
        });
      } else {
        next(err);
      }
    });

    const PgStore = connectPgSimple(session);
    app.use(
      session({
        store: new PgStore({ pool, createTableIfMissing: true }),
        secret: process.env.SESSION_SECRET!,
        resave: false,
        saveUninitialized: false,
        cookie: {
          maxAge: 7 * 24 * 60 * 60 * 1000,
          httpOnly: true,
          secure: isProduction,
          sameSite: "lax",
        },
      })
    );

    registerAuthRoutes(app);

    app.use("/api", (req, res, next) => {
      const isPublic = PUBLIC_PATHS.some((p) => req.path.startsWith(p.replace("/api", "")));
      if (isPublic) return next();
      return requireAuth(req, res, next);
    });

    app.use((req, res, next) => {
      const start = Date.now();
      const reqPath = req.path;

      res.on("finish", () => {
        const duration = Date.now() - start;
        if (reqPath.startsWith("/api")) {
          if (isProduction && !reqPath.includes("/server-status")) {
            return;
          }
          const logLine = `${req.method} ${reqPath} ${res.statusCode} in ${duration}ms`;
          log(logLine.length > 120 ? logLine.slice(0, 119) + "…" : logLine);
        }
      });

      next();
    });

    registerCampaignRoutes(app);
    const server = await registerRoutes(app);

    await loadPersistentTrackersOnStartup();

    app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
      const status = err.status || err.statusCode || 500;
      const message = isProduction ? "Internal Server Error" : (err.message || "Internal Server Error");

      logError('expressErrorHandler', { status }, err);
      res.status(status).json({ message });
    });

    if (app.get("env") === "development") {
      await setupVite(app, server);
    } else {
      serveStatic(app);
    }

    const port = parseInt(process.env.PORT || '5000', 10);

    if (isProduction) {
      log('[STARTUP_GATE] Production mode — checking TTS microservice status (non-blocking)…');

      try {
        const ttsHealth = await ttsService.checkHealth();
        if (!ttsHealth.available || !ttsHealth.modelLoaded) {
          log(`[STARTUP_GATE] INFO: TTS microservice is still initializing (available=${ttsHealth.available}, modelLoaded=${ttsHealth.modelLoaded}). This is expected — the TTS model takes 1-3 minutes to load on first boot. The app will start normally and TTS will become available automatically once the model finishes loading.`);
        } else {
          log(`[STARTUP_GATE] TTS microservice OK (modelLoaded=${ttsHealth.modelLoaded}, memory_mb=${ttsHealth.memoryMb ?? 'N/A'})`);
        }
      } catch (healthErr: any) {
        log(`[STARTUP_GATE] INFO: TTS microservice is not reachable yet (${healthErr.message ?? healthErr}). This is expected during startup — the Python TTS process needs time to initialize and load the model. The app will start normally and TTS will become available automatically.`);
      }
    }

    const gracefulShutdown = (signal: string) => {
      log(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);
      try { stopDailyResetJob(); } catch (e: any) { logError('shutdown.stopDailyResetJob', {}, e); }
      try { stopImageCleanupJob(); } catch (e: any) { logError('shutdown.stopImageCleanupJob', {}, e); }
      try { stopWebhookQueueWorker(); } catch (e: any) { logError('shutdown.stopWebhookQueueWorker', {}, e); }
      try { proxyPoolManager.stopHealthCheckJob(); } catch (e: any) { logError('shutdown.stopProxyPoolHealthCheckJob', {}, e); }
      try { stopQualityRatingPoller(); } catch (e: any) { logError('shutdown.stopQualityRatingPoller', {}, e); }
      server.close(() => {
        log('[SHUTDOWN] HTTP server closed');
        pool.end().then(() => {
          log('[SHUTDOWN] DB pool closed');
          process.exit(0);
        }).catch((err) => {
          logError('shutdown.poolEnd', {}, err);
          process.exit(1);
        });
      });
      setTimeout(() => {
        log('[SHUTDOWN] Forceful shutdown after timeout');
        process.exit(1);
      }, 15000).unref();
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    server.on('error', (err: any) => {
      log(`[FATAL] HTTP server error: ${err?.code || ''} ${err?.message || err}`);
      logError('server.listen', { port }, err);
      process.exit(1);
    });

    const listenOpts: any = { port, host: "0.0.0.0" };
    if (!isProduction) listenOpts.reusePort = true;

    server.listen(listenOpts, () => {
      log(`serving on port ${port}`);

      try { startDailyResetJob(); } catch (err: any) {
        logError('startDailyResetJob', {}, err);
      }
      try { startImageCleanupJob(); } catch (err: any) {
        logError('startImageCleanupJob', {}, err);
      }
      try { startWebhookQueueWorker(); } catch (err: any) {
        logError('startWebhookQueueWorker', {}, err);
      }
      proxyPoolManager.loadFromDb().then(() => {
        try { proxyPoolManager.startHealthCheckJob(); } catch (err: any) {
          logError('startProxyPoolHealthCheckJob', {}, err);
        }
      }).catch((err: any) => {
        logError('proxyPoolManager.loadFromDb', {}, err);
        try { proxyPoolManager.startHealthCheckJob(); } catch (err2: any) {
          logError('startProxyPoolHealthCheckJob', {}, err2);
        }
      });
      try { startQualityRatingPoller(); } catch (err: any) {
        logError('startQualityRatingPoller', {}, err);
      }
      try { startTtsCleanupJob(); } catch (err: any) {
        logError('startTtsCleanupJob', {}, err);
      }

      const memoryMonitorInterval = setInterval(() => {
        const mem = process.memoryUsage();
        log(`[MEMORY] rss_mb=${(mem.rss / 1024 / 1024).toFixed(1)} heap_used_mb=${(mem.heapUsed / 1024 / 1024).toFixed(1)} heap_total_mb=${(mem.heapTotal / 1024 / 1024).toFixed(1)} external_mb=${(mem.external / 1024 / 1024).toFixed(1)} uptime_s=${Math.floor(process.uptime())}`);
      }, 60_000);
      if (memoryMonitorInterval.unref) memoryMonitorInterval.unref();

      setTimeout(() => {
        verifyWebhookOnStartup(port).catch((err) => {
          log(`[WEBHOOK] Erro na verificacao automatica: ${err.message}`);
        });
        verifyEndpointsOnStartup(port).catch((err) => {
          log(`[HEALTH] Erro na verificacao de endpoints: ${err.message}`);
        });
        subscribeAllWabasOnStartup().catch((err) => {
          logError('startup.subscribeAllWabas', {}, err);
        });
        autoResumeCampaignsOnStartup().catch((err) => {
          logError('startup.autoResumeCampaigns', {}, err);
        });
        if (!isProduction) {
          ttsService.checkHealth().then((health) => {
            if (health.available) {
              log(`[TTS] Microserviço TTS acessível na inicialização. modelLoaded=${health.modelLoaded} memory_mb=${health.memoryMb ?? 'N/A'}`);
            } else {
              log(`[TTS] INFO: Microserviço TTS ainda não está acessível (dev). Isso é normal durante o boot — o modelo TTS leva 1-3 minutos para carregar. O serviço de áudio ficará disponível automaticamente.`);
            }
          }).catch((err) => {
            logError('startup.ttsHealthCheck', {}, err);
          });
        }
      }, 2000);

    });
  } catch (err: any) {
    logError('serverStartup', {}, err);
    process.exit(1);
  }
})();
