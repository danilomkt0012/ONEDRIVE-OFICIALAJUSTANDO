# Overview

Overdrive is a WhatsApp Business messaging platform designed to automate and streamline WhatsApp campaigns. It offers features for lead management, WhatsApp Business API configuration, message template management, and campaign execution with intelligent lead distribution. The platform prioritizes high-speed, BM-safe message delivery and provides comprehensive reporting and analytics. The project aims for efficient and scalable WhatsApp campaign management, aspiring to be a leader in automated WhatsApp communication, offering robust tools for businesses to engage with customers, optimize campaign ROI, and expand market reach.

# User Preferences

Preferred communication style: Simple, everyday language.
Branding: Project name is "Overdrive". Logo stored at attached_assets/overdrive-logo.png.

# System Architecture

## Core Capabilities
- **Professional Image Generation Pipeline**: Generates unique, photorealistic personalized images per lead using a physical-simulation pipeline.
- **Campaign Automation**: Supports lead import, API configuration, template management, and campaign execution with intelligent lead distribution.
- **Optimized Sending Engines**: Features "Optimized Sending Engine V2" and "Ultra-Stable Engine V3" for high-throughput, stability, non-blocking retries, pre-validation, adaptive rate limiting, and real-time risk assessment.
- **Template Management**: Includes automatic round-robin template rotation and dynamic parameter mapping for WhatsApp templates.
- **Intelligent Lead Distribution**: Distributes leads across multiple WhatsApp numbers using adaptive, weighted, or round-robin strategies.
- **BM Protection System**: Implements intelligent rate limiting and category-aware processing to prevent account restrictions.
- **Real-time Observability**: Uses Server-Sent Events (SSE) for real-time campaign metrics, progress monitoring, and live logging.
- **Lead Cleaning Module**: Processes various file types for parsing, normalization, deduplication, E.164 validation, WhatsApp number verification, and CPF validation.
- **Lead Pool (Meu Estoque de Leads)**: Provides persistent lead storage for uploading, validating, deduplicating, and atomically consuming leads.
- **Multi-WABA System**: Supports multiple WhatsApp Business Accounts with isolation and security, offering WABA management, conversation management, real-time chat events, automation rules, and personalization parameter models.
- **Global Bot Automation**: Independent bot system for automated responses, with campaign rules taking priority.
- **Bot Flow Engine**: State machine with mutex per phone+flow preventing race conditions. State only advances on successful message send. Supports `replaceVariables()` for named and numbered placeholders. Handles audio and button validation. Supports `image_template` messageType for personalized image generation and sending. Bot responds indefinitely to inbound messages regardless of campaign status (running/completed/paused) — only disabled by `automationEnabled=false`. Multi-campaign conflict resolution prioritizes conversation-linked campaign, then most recently active. Media failures auto-fallback to text. Deleted nodes auto-reset to start. Timed-out conversations restart from start on new inbound. Unknown leads get fallback response. All failures produce `[ALERT_BOT_FAILURE]`, `[ALERT_MEDIA_FAILURE]`, `[ALERT_UNKNOWN_LEADS]` tags. Guaranteed catch-all response on any unhandled exception. Bot processing has 30s timeout with 1 retry. `firstResponseButtonsSent` check persisted in DB (messages table). Phone normalization via `canonicalPhone()` ensures consistent matching.
- **appSecret Sync**: When starting a campaign, appSecret is automatically synchronized between `api_configurations` and `wabas` tables. New WABAs inherit appSecret from user config.
- **Pre-send Validation**: Campaign wizard validates WABA accessToken, appSecret, bot flow nodes, and WABA numbers before allowing campaign start.
- **SSE Inbound Broadcast**: Inbound message SSE notifications fall back to broadcasting to all user WABAs when the primary WABA has no active chat clients.
- **Image Generation (node-canvas)**: Uses node-canvas for image generation with fixed canvas, relative positioning, and text alignment. Falls back to SVG+Sharp pipeline.

## Technical Implementations
- **Frontend**: React with TypeScript, Vite, Wouter, TanStack Query, Shadcn/ui (Radix UI + Tailwind CSS), React Hook Form with Zod, and Uppy.js.
- **Backend**: Express.js with TypeScript, RESTful API, centralized error handling, Multer, and XLSX.
- **Data Storage**: PostgreSQL (Neon), Drizzle ORM, Google Cloud Storage, and Drizzle Kit for migrations.
- **Authentication/Authorization**: Custom object ACL system for file access.
- **WhatsApp Business API Integration**: Custom TypeScript client for template management, message sending, delivery tracking, and error handling.
- **UI/UX**: Configuration interfaces, real-time campaign dashboards, reporting, and a unified campaign wizard (8 steps) with custom image per lead support. Full mobile optimization is implemented.
- **Unified Dashboard**: Consolidated monitoring page with "Visao Geral" (campaign overview, stats, active campaigns) and "Qualidade de Envio" (per-template/number metrics, pacing, auto-pause alerts).
- **Campaign Management System**: Full campaign lifecycle management with listing, an 8-step wizard for campaign creation, a 4-tab detail view (Metrics, Chat, Contacts, Logs), and Hot Update functionality for active campaigns. Supports multi-WABA. Campaigns page shows production status indicator and collapsible "Proximos Passos" guide with webhook URL, step-by-step instructions and pre-launch checklist. Campaign wizard Step 9 (Review) validates prerequisites with actionable error messages and blocks launch until all are met.
- **Sidebar Navigation**: Organized into CAMPANHAS, COMUNICAÇÃO, MONITORAMENTO, CONFIGURAÇÕES sections. Root path `/` redirects to `/campaigns`.
- **Conversations Campaign Filter**: Chat page includes a campaign dropdown filter.
- **Auto-Register WABA**: Automatically registers WABA upon campaign creation if not already present.

## Sending Strategy: Skip-Label + Human Behavior Anti-Spam (Cold Base Optimized)
- **Mode**: `sender_label: null` utilizes the verified display name from the WABA account.
- **Engine Defaults (Safe Cold Base)**: Configured for safe cold base sending with defined `maxConcurrent`, `targetRtt`, `prefetch`, `maxRefill`, `maxTokens`, `burstMultiplier`, and `initialRefillRate`.
- **Speed Presets**: SLOW, NORMAL, FAST with safe Meta limits and TIER_SPEED_LIMITS. No CUSTOM mode.
- **Gradual Ramp-Up**: Starts at 10 msg/min, increasing 5 msg/min every 5 min up to target (30 msg/min).
- **Template Weights**: UI allows per-template weight percentages for weighted template selection.
- **Micro-Batch Sending**: Sends 100-200 msgs per batch with 60-120s random pauses.
- **Multi-WABA Per Campaign**: Campaigns can use multiple WABAs, alternating per micro-batch.
- **Campaign Logic**: `buildPlan()` distributes leads with weighted probabilistic template rotation and Gaussian delay distribution. `runPlan()` handles execution with exponential backoff retries.
- **Proactive Pacing Detection**: `DeliveryMetricsTracker` monitors accepted vs delivered gap, auto-reducing rate if delivery <60% and auto-pausing if <50%. Thresholds are configurable.
- **Quality Dashboard**: Provides real-time per-template and per-number delivery/read/fail rates with windowed metrics and auto-pause alerts.
- **HumanBehavior Module**: Simulates human behavior with Gaussian delay distribution, periodic long pauses, cycle pauses, and micro-pauses. Includes weighted probabilistic template rotation and per-phone independent timing offsets. Uses `crypto.randomInt`.
- **TemplatePacingBackoff**: Smart backoff for error 130429 (template pacing).
- **RiskEngine Gradual Recovery**: After cooldown, recovery is gradual (5 steps over 150s).
- **Campaign Config**: Accepts `baseType` (cold/warm/hot), `templateWeights`, and `humanBehavior` parameters.

## Advanced Campaign Features
- **Burst Launch Mode**: Orchestrates up to 5 phone numbers simultaneously.
- **Customer Service Window (CSW) & Post-Response Conversion**: Tracks 24h CSW windows and auto-sends conversion messages.
- **BM Quality Score Monitor**: Polls `quality_score` from Graph API, pausing numbers with low scores and providing quota bonuses.
- **Stealth/Camouflage Scheduler**: Implements jitter, batch size variation, micro-delays, geographic DDD shuffling, ramp-up for new numbers, and business hours gating.
- **Meta API 2026 Alignment**: Updated for new tier structures, DDI +1 filter, template pacing, Graph API v25.0, and correct tier limits.
- **Opt-Out Automatico**: Global blacklist with auto-detection via error codes and webhook callbacks.
- **Aquecimento de Numeros**: Progressive daily limit schedule for warming up numbers.
- **Follow-Up Automatico / Engajamento Forcado**: Multi-stage follow-up rules per campaign with configurable delays.
- **Delivery Strategy Selector**: UI toggle (Safe/Balanced/Aggressive) adjusts distribution strategy.
- **Template Rotation UI**: Enhanced template selection with visual indicators and configurable weight percentages.
- **RiskEngine Integration**: Active risk management via `applyRiskAction` in UltraStableEngine.
- **Visual Template Editor**: Complete visual editor for creating custom image templates.
- **Image URL Validation**: HTTP/HTTPS scheme validation and SSRF protection.
- **Bot Response Automation**: Expanded webhook automation supports text, audio, image, interactive buttons, and list responses.
- **Quality Rating Monitoring**: Per-number quality polling from Meta Graph API, history tracking, and UI panel.
- **Real Delivery Metrics**: Webhook-based delivery stats using `DISTINCT ON (msg_id)` for accurate message lifecycle tracking.
- **Campaign Counter Normalization**: Campaign schema has dual counter fields (`sentCount`/`sentMessages`, `failedCount`/`failedMessages`) with API endpoints normalizing their usage.
- **Campaign Restart**: Failed and completed campaigns can be restarted via API.
- **MemStorage→DB Migration**: All critical data operations migrated from in-memory MemStorage to PostgreSQL via Drizzle ORM.
- **Warm-up Scheduler**: Multi-day warm-up plans for new numbers with configurable daily targets.

## Multi-WABA System
- Supports multiple WhatsApp Business Accounts (WABAs) with dedicated database tables, enforcing isolation and security. Offers API endpoints for WABA CRUD, conversation management, real-time chat events, automation rules, and personalization parameter models. Features frontend pages for WABA management and a WhatsApp Web-style chat interface.

## Global Bot Automation
- An independent bot system that works without active campaigns. Campaign automation rules have priority. Provides a bot page with full CRUD for rules, including keyword, response type, media upload, priority, and active/inactive toggle. Includes a configurable global fallback message and bot on/off toggle.

## Bot Programavel (Conversa Guiada por Etapas)
- Per-campaign programmable bot with multi-step guided conversations.
- **Data Model**: `bot_flows`, `bot_flow_nodes`, `bot_conversation_states`.
- **Execution Engine**: Processes inbound messages, evaluates conditions, advances leads through the flow, and sends responses.
- **Variable Substitution**: Supports `{{nome}}`, `{{cpf}}`, `{{resposta_anterior}}`, and custom captured variables.
- **Timeout Job**: Checks for leads that haven't responded within configured timeout.
- **Frontend**: Visual step editor integrated into the campaign dispatch page.
- **Webhook Integration**: Bot flow engine checked first in webhook handler.
- **Live Editing**: Flow can be updated while campaign is active.

## Chat Media Support
- The chat interface supports sending and displaying images, audio, and documents via file upload.

## Security & Performance
- **Webhook Signature Validation**: POST `/api/webhook/meta` validates `X-Hub-Signature-256` using HMAC-SHA256.
- **Signed Campaign Image URLs**: Campaign images served via `/api/media/:token` with HMAC-signed temporary tokens.
- **Database Performance Indices**: Indices on high-volume tables.
- **Persistent Webhook Queue**: Webhooks saved to `waba_hooks` before processing, background worker polls unprocessed hooks.
- **Periodic Image Cleanup**: `imageCleanupJob` runs every 30 minutes.
- **Safe WABA Fallback**: Discards messages when `phoneNumberId` doesn't match any registered WABA.
- **Configurable Delivery Thresholds**: Auto-pause and rate-reduce thresholds configurable per campaign.
- **Crypto-Secure Randomness**: All `Math.random()` replaced with `crypto.randomInt()` / `crypto.randomBytes()` across all server modules.
- **Graceful Shutdown**: SIGTERM/SIGINT handlers close HTTP server and DB pool.
- **Body Parser Limit**: Global body parser reduced from 50MB to 1MB.

## Observability & Automatic Decision System
- **CampaignDecisionEngine**: Central orchestrator that subscribes to delivery metrics, response rate, latency, and reputation signals across all phones. Emits decisions: `continue`, `slow_down`, `pause_campaign`, `disable_number`. Drives multi-phone rebalancing via `onRebalance` callback. Uses `registerPhoneReputationScore()` for same-tracker phones and `subscribeToPhoneTrackers()` for separate-tracker phones to avoid duplicate event wiring. Implements lifecycle-aware decisions: NEW phones with <30 delivered receive NO negative actions; NEW phones with 30-49 delivered get pause downgraded to slow_down. Gradual degradation via per-phone slowdown count (1st=0.8, 2nd=0.7, 3rd+=0.5), reset on recovery. Calls `refreshReputations()` BEFORE every lifecycle-gated decision to ensure fresh data.
- **ResponseRateTracker**: Tracks per-campaign, per-template, per-phone response rates with windowed buckets. Uses `contactTemplateMap` (contactPhone → templateName) for accurate template-level reply attribution even during template rotation. Implements messageId-based deduplication via `processedDeliveredIds`/`processedReplyIds` Sets (capped at 50k). Exposes `getCumulativeCampaignStats()` for lifecycle state derivation.
- **PhoneReputationScore**: READ-ONLY cache layer — no internal counters. Derives ALL data from DeliveryMetricsTracker (cumulative delivered, delivery rate, block rate) and ResponseRateTracker (cumulative replies, response rate) via `refreshFromTrackers()`. Per-phone reputation scoring (delivery rate 40%, response rate 40%, block rate 20%) with tier classification (HIGH_TRUST, NORMAL, REDUCE_LOAD, DISABLE_TEMP). Phone lifecycle states: NEW → ACTIVE (delivered≥50 or replies≥10) → DEGRADED (score<0.3 with data). NEW phones clamped to score≥0.5 and NORMAL tier minimum. `isPhoneNewAndProtected()` returns true when lifecycle=NEW AND totalDelivered<30. DISABLE_TEMP triggers a recovery timer that re-evaluates after the disable period.
- **DeliveryMetricsTracker**: Latency tracking per-message, block rate monitoring, webhook status fanout. Latency critical threshold uses >=120s (not >120s). Supports multi-tracker registration via `Set<ResponseRateTracker>` per campaign. Fanout functions pass messageId for tracker-level deduplication and contactPhone for accurate reply attribution.

## Production Hardening Modules
- **FrequencyCap**: Pre-send behavioral frequency cap limiting messages per recipient within 24h.
- **PortfolioControl**: Portfolio-level BM global control for adaptive slowdown and blocking.
- **ProactiveSenderRotation**: Auto-rotates sender after random 80-150 messages.
- **Delay Upgrade**: HumanBehavior base delays upgraded from 800ms-3000ms to 3000ms-8000ms with adaptive adjustments.
- **Weighted Template Rotation**: `templateManager.ts` uses weighted selection based on usage count and performance scores.
- **Image Generator Hardening**: Metadata validation, aspect-ratio-aware canvas, coordinate system detection, no fontSize randomization in SVG, configurable jitter, output size validation, async cleanup/validate, batch error reporting.
- **Audio Hardening**: URL validation supports query params, retry with `crypto.randomInt` jitter, structured error logging.
- **TTS Install Hardening**: `install_tts.sh` explicitly installs fastapi, uvicorn, python-multipart alongside TTS/transformers/psutil/torchaudio.
- **Node.js Memory Monitor**: Logs RSS, heap used/total, external memory every 60s via `[MEMORY]` tag.
- **TTS Startup Health Check**: On boot, checks TTS microservice reachability and logs status.
- **TTS Queue Timeout Leak Fix**: `TtsQueue.runJob` clears timeout timer after Promise.race resolves to prevent timer leaks.
- **TTS Cache Key Fix**: `TtsQueue` cache key uses deterministic hash (template+speed) instead of `Date.now()` to enable cache hits.
- **Orphaned Temp File Cleanup**: `ttsCleanupJob` scans OS temp directory for stale `tts_*` files older than 2h.
- **Silent Catch Elimination**: All `catch {}` blocks in AudioCacheService, TtsQueue replaced with `logError()` calls.
- **Structured TTS Logging**: `[TTS_GENERATE_START]`, `[TTS_GENERATE_DONE]`, `[TTS_JOB_START]`, `[TTS_JOB_DONE]` tags with text_len, elapsed_ms, output_bytes, result.
- **Webhook Worker Logging**: Per-hook structured log with hookId, metaMessageId, result, elapsed_ms.
- **Stress Test Enhancement**: `scripts/bot-concurrency-test.ts` extended with Test 11 (500 simulated audio generations across 50 users) and Test 12 (memory leak check with 1000 operations).

# External Dependencies

- **WhatsApp Business API (Meta)**: Core platform for messaging and campaign execution.
- **WasenderAPI and 2Chat**: For WhatsApp number verification.
- **TrackFlow API (apis.trackflow.services)**: For CPF validation.
- **Google Cloud Storage**: For storing files.
- **Neon**: Serverless PostgreSQL database hosting.
- **XLSX Library**: For parsing Excel files.
- **Uppy.js**: For client-side file uploads.