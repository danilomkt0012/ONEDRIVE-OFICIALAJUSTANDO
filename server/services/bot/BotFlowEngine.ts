import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAudioBuffer, validateNoSSRF } from '../../utils/ssrfGuard';
import { detectAudioFormat, isFfmpegAvailable, convertBufferToOgg } from '../../utils/audioConverter';
import { db } from '../../db';
import { botFlows, botFlowNodes, botConversationStates, leads, campaigns, campaignAutomationRules, imageTemplates, voiceProfiles, botMediaAlerts } from '@shared/schema';
import type { BotFlow, BotFlowNode, BotConversationState, BotNodeCondition, ImageTemplateField } from '@shared/schema';
import { audioStitchingService } from '../tts/AudioStitchingService';
import { ttsService } from '../tts/TtsService';
import { eq, and, asc, sql } from 'drizzle-orm';
import { metaAPI, MetaAPIError } from '../../meta/metaAPI';
import { wabaStorage } from '../../wabaStorage';
import { cswTracker } from '../csw/CSWTracker';
import { logError } from '../../utils/logger';
import { generateFromCustomTemplate } from '../imageGenerator';
import { generateSignedImageUrl, validateSignedUrlAccessibility } from '../signedUrl';
import { claimSendRight, confirmSendRight, releaseSendRight, isAlreadyConfirmed, buildImageIdemKey, logGenerationStart, logGenerationEnd } from '../imageStabilityGuard';
import {
  withPhoneMutex,
  withSendQueue,
  scheduleWithDebounce,
  BOT_DEBOUNCE_MS,
} from './botConcurrencyPrimitives.js';

export { withSendQueue, scheduleWithDebounce };

const __dirname_engine = path.dirname(fileURLToPath(import.meta.url));
const BOT_IMAGES_DIR = path.resolve(__dirname_engine, '../../../uploads/campaign-images');

function getBotPublicDomain(): string {
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

async function checkMediaUrlReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    validateNoSSRF(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        if (location) {
          try {
            validateNoSSRF(new URL(location, url).toString());
          } catch {
            return false;
          }
        }
        return true;
      }
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function recordMediaAlert(
  mediaUrl: string,
  mediaType: string,
  nodeId?: string | null,
  flowId?: string | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO bot_media_alerts (id, media_url, media_type, node_id, flow_id, occurrence_count, first_seen_at, last_seen_at, resolved_at)
      VALUES (gen_random_uuid(), ${mediaUrl}, ${mediaType}, ${nodeId ?? null}, ${flowId ?? null}, 1, now(), now(), null)
      ON CONFLICT (media_url) DO UPDATE
        SET occurrence_count = bot_media_alerts.occurrence_count + 1,
            last_seen_at = now(),
            resolved_at = null
        WHERE bot_media_alerts.resolved_at IS NOT NULL OR bot_media_alerts.media_url = ${mediaUrl}
    `);
  } catch (e: any) {
    logError('recordMediaAlert', { mediaUrl, mediaType }, e);
  }
}

interface MessageHeader {
  type?: 'text' | 'image';
  value?: string;
}

interface ButtonPayloadItem {
  id?: string;
  title?: string;
  nextNodeId?: string;
}

type CswFallbackAction = 'text_only' | 'skip' | 'end' | 'campaign_default';

interface ButtonsPayloadMeta {
  items: ButtonPayloadItem[];
  header?: MessageHeader;
  footer?: string;
  cswFallback?: CswFallbackAction;
}

interface ListPayload {
  button?: string;
  sections?: Array<{ title?: string; rows?: Array<{ id?: string; title?: string; description?: string; nextNodeId?: string }> }>;
  header?: MessageHeader;
  footer?: string;
  cswFallback?: CswFallbackAction;
}

interface SendResult {
  success: boolean;
  error?: string;
  cswAction?: 'skip' | 'end';
}

const DEFAULT_FALLBACK_MESSAGE = 'Desculpe, não entendi sua resposta. Por favor, tente novamente.';

// ─── Production Safety Verdict (logged on every server restart) ───────────────────────
console.log(JSON.stringify({
  level: 'info',
  tag: '[BOT_PRODUCTION_SAFETY]',
  verdict: 'ACTIVE',
  mechanisms: {
    mutex: { active: true, description: 'withPhoneMutex — serialises all inbound bot executions per phone+waba' },
    sendQueue: { active: true, description: 'withSendQueue — serialises all outbound API calls per phone (FIFO)' },
    debounce: { active: true, windowMs: BOT_DEBOUNCE_MS, strategy: 'last-message-wins', description: 'Rapid burst → only last message triggers bot; prevents duplicate state transitions' },
    interNodeDelay: { active: true, minMs: 300, maxMs: 800, description: 'Random delay between each bot message node to pace outbound sends' },
    retry: { active: true, attempts: 1, retryDelayMs: 2000, description: 'On send failure: retry once after 2s, then per-campaign fallback' },
    catchAllFailsafe: { active: true, message: 'Recebemos sua mensagem e vamos te responder em breve.', paths: 3, description: 'Final catch-all: fallback message sent on any unhandled exception in bot pipeline' },
  },
}));
// ─────────────────────────────────────────────────────────────────────────────────────────

// ─── Debounce strategy: LAST-MESSAGE-WINS (intentional) ───────────────────────────────
//
// When a user sends multiple messages in rapid succession (within BOT_DEBOUNCE_MS = 2000ms),
// only the LAST message triggers bot processing. All earlier pending timers are cancelled.
//
// WHY last-message-wins is correct for a bot:
//   - A bot operates as a state machine. Processing intermediate messages would cause
//     duplicate or conflicting state transitions (e.g., advancing the flow twice for
//     a single user intent expressed across two rapid messages).
//   - If the user types "ol" then "á" in two keystrokes, we want to process "á" as the
//     final intent, not "ol" first and "á" second as separate bot turns.
//   - This debounce mirrors how most conversational platforms work: the user is composing
//     their thought, and only the final message matters for the bot response.
//   - The 2000ms window is intentionally generous — most users who send two intentional,
//     distinct messages will be at least 2s apart, so legitimate separate turns are not lost.
//
// IF FIFO-queue-all is ever preferred instead (i.e., every message must trigger a bot turn):
//   - Remove scheduleWithDebounce and call runBotForCampaigns() directly from routes.ts.
//   - withPhoneMutex already guarantees sequential execution, so no ordering risk.
//   - Downside: every partial message / accidental duplicate tap triggers a full bot run.
//
// See botConcurrencyPrimitives.ts for the implementation.
// ─────────────────────────────────────────────────────────────────────────────────────────

export function replaceVariables(
  template: string,
  data: Record<string, string>
): string {
  if (!template) return template;

  const lowerMap = new Map<string, string>();
  for (const [k, v] of Object.entries(data)) {
    lowerMap.set(k.toLowerCase(), v ?? '');
    lowerMap.set(k, v ?? '');
  }
  const keys = Object.keys(data);

  let result = template;

  result = result.replace(/\{\{(\d+)\}\}/g, (_match, numStr) => {
    const idx = parseInt(numStr, 10);
    if (idx >= 1 && idx <= keys.length) {
      const val = data[keys[idx - 1]];
      if (val !== undefined) return val;
    }
    return '';
  });

  result = result.replace(/\{\{(\w+)\}\}/g, (_match, varName) => {
    const key = varName.toLowerCase();
    if (lowerMap.has(key)) return lowerMap.get(key)!;
    if (lowerMap.has(varName)) return lowerMap.get(varName)!;
    return '';
  });

  return result;
}

function evaluateCondition(
  condition: BotNodeCondition,
  messageBody: string
): boolean {
  const body = messageBody.trim();
  const value = condition.matchValue || '';

  switch (condition.matchType) {
    case 'any':
      return true;

    case 'exact':
      return body.toLowerCase() === value.toLowerCase();

    case 'keyword':
      return body.toLowerCase().includes(value.toLowerCase());

    case 'regex':
      try {
        const regex = new RegExp(value, 'i');
        return regex.test(body);
      } catch (e: any) {
        logError('BotFlowEngine.invalidRegex', { pattern: value }, e);
        return false;
      }

    default:
      return false;
  }
}

function randomDelay(minS: number, maxS: number): Promise<void> {
  const range = Math.max(1, Math.floor((maxS - minS) * 1000));
  const ms = minS * 1000 + crypto.randomInt(0, range);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function interNodeDelay(): Promise<void> {
  const ms = 300 + crypto.randomInt(0, 501);
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function validateAudioUrl(url: string): { valid: boolean; error?: string } {
  if (!url || !url.trim()) return { valid: false, error: 'URL do áudio vazia' };
  if (!url.startsWith('https://')) return { valid: false, error: 'URL do áudio deve usar HTTPS' };
  const urlPath = url.split('?')[0].split('#')[0];
  if (!/\.(mp3|ogg|opus|wav|aac|m4a|oga|webm|amr|mp4)$/i.test(urlPath)) {
    if (!/\.(mp3|ogg|opus|wav|aac|m4a|oga|webm|amr|mp4)(\?|$)/i.test(url)) {
      return { valid: false, error: 'Formato de áudio inválido (aceito: mp3, ogg, opus, wav, aac, m4a, webm)' };
    }
  }
  return { valid: true };
}

const TRANSIENT_400_AUDIO_CODES = [131048, 131053, 131000, 500];


export async function sendAudioWithRetry(
  phoneNumberId: string,
  phone: string,
  audioUrl: string,
  accessToken: string,
  maxRetries: number = 3,
  asVoiceNote: boolean = true
): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (asVoiceNote) {
        const { buffer, mimeType, filename } = await fetchAudioBuffer(audioUrl);
        if (buffer.length < 1024) {
          throw new Error(`Áudio inválido: arquivo muito pequeno (${buffer.length} bytes, mínimo 1KB). URL: ${audioUrl.substring(0, 80)}`);
        }
        const ext = path.extname(filename).toLowerCase();
        const detectedFormat = detectAudioFormat(buffer);
        const isOggByMagic = detectedFormat === 'ogg';

        let finalBuffer: Buffer;
        let finalMime: string;
        let finalFilename: string;

        if (isOggByMagic) {
          finalBuffer = buffer;
          finalMime = 'audio/ogg';
          finalFilename = filename.replace(/\.(opus|oga)$/i, '.ogg');
        } else {
          const ffmpegAvail = await isFfmpegAvailable();
          if (ffmpegAvail) {
            logBotEvent('info', phone, `sendAudioWithRetry: convertendo ${detectedFormat || ext} para OGG/Opus via ffmpeg`, { audioUrl: audioUrl.substring(0, 80) });
            const tmpPath = path.join(
              path.resolve(__dirname_engine, '../../../uploads'),
              `bot_audio_tmp_${Date.now()}_${crypto.randomInt(0, 99999)}.audio`
            );
            finalBuffer = await convertBufferToOgg(buffer, tmpPath);
            finalMime = 'audio/ogg';
            finalFilename = filename.replace(/\.[^.]+$/, '') + '.ogg';
          } else {
            logBotEvent('warn', phone, `sendAudioWithRetry: ffmpeg indisponível, enviando áudio no formato original`, { detectedFormat, ext });
            finalBuffer = buffer;
            finalMime = mimeType;
            finalFilename = filename;
          }
        }

        const mediaId = await metaAPI.uploadMediaToMeta(phoneNumberId, finalBuffer, finalMime, finalFilename, accessToken);
        await metaAPI.sendVoiceNoteMessage(phoneNumberId, phone, mediaId, accessToken);
      } else {
        await metaAPI.sendAudioMessage(phoneNumberId, phone, audioUrl, accessToken);
      }
      return;
    } catch (err: any) {
      lastError = err;
      const statusCode = (err instanceof MetaAPIError) ? err.statusCode : err?.response?.status;
      const metaCode = (err instanceof MetaAPIError) ? err.metaCode : undefined;
      const isRetryableStatus = statusCode === 429 || (statusCode !== undefined && statusCode >= 500 && statusCode < 600);
      const isTransient400 = statusCode === 400 && metaCode !== undefined && TRANSIENT_400_AUDIO_CODES.includes(metaCode);
      const isRetryable = isRetryableStatus || isTransient400;
      if (!isRetryable || attempt === maxRetries) {
        if (attempt === maxRetries) {
          logBotEvent('error', phone, `sendAudioWithRetry: esgotadas ${maxRetries} tentativas`, {
            op: 'sendAudioWithRetry',
            phone,
            audioUrl,
            asVoiceNote,
            statusCode,
            metaCode,
            error: err.message,
            stack: err.stack,
          });
        }
        break;
      }
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
      const jitter = crypto.randomInt(0, Math.max(1, Math.floor(backoffMs * 0.2)));
      logBotEvent('warn', phone, `Retry áudio tentativa ${attempt}/${maxRetries}`, { statusCode, metaCode, backoffMs: Math.round(backoffMs + jitter) });
      await new Promise(resolve => setTimeout(resolve, backoffMs + jitter));
    }
  }
  throw lastError || new Error('Falha ao enviar áudio após retries');
}

export function validateButtons(buttons: ButtonPayloadItem[]): { valid: boolean; sanitized: ButtonPayloadItem[]; error?: string } {
  if (!Array.isArray(buttons) || buttons.length === 0) {
    return { valid: false, sanitized: [], error: 'Payload de botões vazio' };
  }
  if (buttons.length > 3) {
    return { valid: false, sanitized: [], error: 'Máximo de 3 botões permitido' };
  }
  const sanitized: ButtonPayloadItem[] = [];
  for (const b of buttons) {
    const title = (b.title || '').trim();
    if (!title) return { valid: false, sanitized: [], error: 'Título de botão não pode ser vazio' };
    if (title.length > 20) return { valid: false, sanitized: [], error: `Título "${title}" excede 20 caracteres` };
    sanitized.push({ id: b.id || title, title });
  }
  return { valid: true, sanitized };
}

function resolveCswFallback(nodeFallback: CswFallbackAction | undefined, globalFallback: CswFallbackAction | undefined): CswFallbackAction {
  if (nodeFallback && nodeFallback !== 'campaign_default') return nodeFallback;
  if (globalFallback && globalFallback !== 'campaign_default') return globalFallback;
  return 'text_only';
}

export async function sendButtons(
  phoneNumberId: string,
  phone: string,
  bodyText: string,
  payload: ButtonPayloadItem[] | ButtonsPayloadMeta,
  accessToken: string,
  globalCswFallback?: CswFallbackAction
): Promise<'sent' | 'fallback_text' | 'fallback_skip' | 'fallback_end'> {
  let nodeCswFallback: CswFallbackAction | undefined;

  let buttons: ButtonPayloadItem[];
  let headerText: string | undefined;
  let headerImageUrl: string | undefined;
  let footerText: string | undefined;

  if (Array.isArray(payload)) {
    buttons = payload;
  } else {
    buttons = payload.items || [];
    nodeCswFallback = payload.cswFallback;
    if (payload.header?.type === 'text' && payload.header.value) {
      headerText = payload.header.value;
    } else if (payload.header?.type === 'image' && payload.header.value) {
      headerImageUrl = payload.header.value;
    }
    if (payload.footer) {
      footerText = payload.footer;
    }
  }

  const isOpen = await cswTracker.isCSWOpen(phone);
  if (!isOpen) {
    const action = resolveCswFallback(nodeCswFallback, globalCswFallback);
    logBotEvent('info', phone, `CSW fechada para botões — fallback: ${action}`);
    if (action === 'text_only') {
      await metaAPI.sendFreeFormMessage(phoneNumberId, phone, bodyText, accessToken);
      return 'fallback_text';
    }
    if (action === 'skip') return 'fallback_skip';
    if (action === 'end') return 'fallback_end';
    await metaAPI.sendFreeFormMessage(phoneNumberId, phone, bodyText, accessToken);
    return 'fallback_text';
  }

  const validation = validateButtons(buttons);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  await metaAPI.sendInteractiveButtons(
    phoneNumberId, phone, bodyText,
    validation.sanitized.map(b => ({ id: b.id || b.title || '', title: b.title || '' })),
    headerText, footerText, accessToken, headerImageUrl
  );
  return 'sent';
}

export async function sendList(
  phoneNumberId: string,
  phone: string,
  bodyText: string,
  listPayload: ListPayload,
  accessToken: string,
  globalCswFallback?: CswFallbackAction
): Promise<'sent' | 'fallback_text' | 'fallback_skip' | 'fallback_end'> {
  const isOpen = await cswTracker.isCSWOpen(phone);
  if (!isOpen) {
    const action = resolveCswFallback(listPayload.cswFallback, globalCswFallback);
    logBotEvent('info', phone, `CSW fechada para lista — fallback: ${action}`);
    if (action === 'text_only') {
      await metaAPI.sendFreeFormMessage(phoneNumberId, phone, bodyText, accessToken);
      return 'fallback_text';
    }
    if (action === 'skip') return 'fallback_skip';
    if (action === 'end') return 'fallback_end';
    await metaAPI.sendFreeFormMessage(phoneNumberId, phone, bodyText, accessToken);
    return 'fallback_text';
  }

  const sections = (listPayload.sections || []).map(s => ({
    title: s.title || '',
    rows: (s.rows || []).map(r => ({ id: r.id || '', title: r.title || '', description: r.description })),
  }));

  let headerText: string | undefined;
  let headerImageUrl: string | undefined;
  let footerText: string | undefined;
  if (listPayload.header?.type === 'text' && listPayload.header.value) {
    headerText = listPayload.header.value;
  } else if (listPayload.header?.type === 'image' && listPayload.header.value) {
    headerImageUrl = listPayload.header.value;
  }
  if (listPayload.footer) {
    footerText = listPayload.footer;
  }

  await metaAPI.sendInteractiveList(
    phoneNumberId, phone, bodyText,
    listPayload.button || 'Menu',
    sections,
    headerText, footerText, accessToken, headerImageUrl
  );
  return 'sent';
}

export function canonicalPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (!digits.startsWith('55') && (digits.length === 10 || digits.length === 11)) {
    digits = '55' + digits;
  }
  if (digits.startsWith('55') && digits.length === 12) {
    const ddd = digits.slice(2, 4);
    const numero = digits.slice(4);
    if (['6','7','8','9'].includes(numero[0])) {
      digits = '55' + ddd + '9' + numero;
    }
  }
  return digits;
}


const alertCounters = { botFailures: 0, mediaFailures: 0, unknownLeads: 0 };
let lastAlertReport = Date.now();
const ALERT_REPORT_INTERVAL_MS = 5 * 60 * 1000;

function maybeReportAlerts() {
  if (Date.now() - lastAlertReport >= ALERT_REPORT_INTERVAL_MS) {
    if (alertCounters.botFailures > 0 || alertCounters.mediaFailures > 0 || alertCounters.unknownLeads > 0) {
      console.log(`[ALERT_REPORT] bot_failures=${alertCounters.botFailures} media_failures=${alertCounters.mediaFailures} unknown_leads=${alertCounters.unknownLeads} (last ${ALERT_REPORT_INTERVAL_MS / 60000}min)`);
    }
    alertCounters.botFailures = 0;
    alertCounters.mediaFailures = 0;
    alertCounters.unknownLeads = 0;
    lastAlertReport = Date.now();
  }
}

setInterval(maybeReportAlerts, ALERT_REPORT_INTERVAL_MS).unref?.();

export function incrementAlertCounter(counter: 'botFailures' | 'mediaFailures' | 'unknownLeads') {
  alertCounters[counter]++;
}

function logBotEvent(level: 'info' | 'warn' | 'error', phone: string, event: string, details?: Record<string, any>) {
  const ts = new Date().toISOString();
  const prefix = `[BOT][${ts}][${phone}]`;
  const ctx = { phone, event, ...(details || {}) };
  if (level === 'error') {
    const err = details?.stack ? Object.assign(new Error(event), { stack: details.stack }) : new Error(event);
    logError(`${prefix} ${event}`, ctx, err);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${event}`, ctx);
  } else {
    console.log(`${prefix} ${event}`, ctx);
  }
}

export class BotFlowEngine {
  private fallbackMessage: string = DEFAULT_FALLBACK_MESSAGE;

  setFallbackMessage(msg: string): void {
    this.fallbackMessage = msg;
  }

  async getActiveFlowForCampaign(campaignId: string): Promise<BotFlow | null> {
    const [flow] = await db.select().from(botFlows)
      .where(and(eq(botFlows.campaignId, campaignId), eq(botFlows.isActive, true)));
    return flow || null;
  }

  async getFlowNodes(flowId: string): Promise<BotFlowNode[]> {
    return db.select().from(botFlowNodes)
      .where(eq(botFlowNodes.flowId, flowId))
      .orderBy(asc(botFlowNodes.sortOrder));
  }

  async getConversationState(flowId: string, phone: string): Promise<BotConversationState | null> {
    const [state] = await db.select().from(botConversationStates)
      .where(and(
        eq(botConversationStates.flowId, flowId),
        eq(botConversationStates.phone, phone),
        eq(botConversationStates.status, 'active')
      ));
    return state || null;
  }

  async processInboundMessage(
    rawPhone: string,
    messageBody: string,
    wabaId: string,
    convoId: string,
    campaignId: string,
    phoneNumberId: string,
    accessToken: string,
    inboundMessageId?: string,
    buttonReplyId?: string,
    buttonReplyTitle?: string
  ): Promise<'handled' | 'config_error' | 'graceful_skip'> {
    const phone = canonicalPhone(rawPhone);
    const mutexKey = `${phone}:${wabaId}`;

    return withPhoneMutex(mutexKey, () =>
      this.runFlow(phone, messageBody, wabaId, convoId, campaignId, phoneNumberId, accessToken, inboundMessageId, buttonReplyId, buttonReplyTitle)
    );
  }

  /**
   * Inner bot flow execution — called inside withPhoneMutex by processInboundMessage.
   * Protected so test subclasses can override the DB/API logic while the mutex wrapping
   * in processInboundMessage remains the real production code under test.
   */
  protected async runFlow(
    phone: string,
    messageBody: string,
    wabaId: string,
    convoId: string,
    campaignId: string,
    phoneNumberId: string,
    accessToken: string,
    inboundMessageId?: string,
    buttonReplyId?: string,
    buttonReplyTitle?: string
  ): Promise<'handled' | 'config_error' | 'graceful_skip'> {
      const flow = await this.getActiveFlowForCampaign(campaignId);
      if (!flow) {
        console.log(`[BOT_CONFIG_ERROR] campaignId=${campaignId} — no active flow found`, { phone, wabaId });
        logBotEvent('info', phone, '[BOT_CONFIG_ERROR] Nenhum fluxo ativo encontrado para a campanha — usando fallback', { campaignId, wabaId });
        return 'config_error';
      }

      if (!flow.isActive) {
        console.log(`[BOT_CONFIG_ERROR] flowId=${flow.id} — flow is not active (isActive=false)`, { phone, campaignId });
        logBotEvent('warn', phone, '[BOT_CONFIG_ERROR] Fluxo encontrado mas isActive=false — usando fallback', { campaignId, flowId: flow.id });
        return 'config_error';
      }

      const nodes = await this.getFlowNodes(flow.id);
      if (nodes.length === 0) {
        console.log(`[BOT_CONFIG_ERROR] flowId=${flow.id} — flow has no nodes`, { phone, campaignId });
        logBotEvent('warn', phone, '[BOT_CONFIG_ERROR] Fluxo não tem nós — usando fallback', { campaignId, flowId: flow.id });
        return 'config_error';
      }

      const entryNode = nodes.find(n => n.nodeType === 'start') || nodes[0];
      if (!entryNode) {
        console.log(`[BOT_CONFIG_ERROR] flowId=${flow.id} — no entry node found`, { phone, campaignId });
        logBotEvent('warn', phone, '[BOT_CONFIG_ERROR] Nenhum nó de entrada encontrado — usando fallback', { campaignId, flowId: flow.id });
        return 'config_error';
      }

      console.log(`[FLOW_SELECTED] campaignId=${campaignId} flowId=${flow.id}`, { phone, wabaId, entryNodeId: entryNode.id });

      // ── Phase 1+2: Unified atomic transaction ────────────────────────────────
      // A Postgres advisory lock (pg_try_advisory_xact_lock) on the hash of
      // (flowId, phone) serialises concurrent inserts within this transaction,
      // preventing duplicate active state rows under multi-instance concurrency.
      // The FOR UPDATE row-lock on any existing row covers the processing path.
      type TransitionAction = 'duplicate' | 'fallback' | 'send' | 'end' | 'skip';
      interface TransitionResult {
        action: TransitionAction;
        currentNode?: BotFlowNode;
        nextNode?: BotFlowNode;
        state?: BotConversationState;
        capturedStateId?: string;
      }

      const transition: TransitionResult = await db.transaction(async (tx) => {
        // Serialise concurrent inserts for the same (flowId, phone) pair
        const lockKey = `${flow.id}:${phone}`;
        let hash = 0;
        for (let i = 0; i < lockKey.length; i++) {
          hash = Math.imul(31, hash) + lockKey.charCodeAt(i) | 0;
        }
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${hash})`);

        const [existing] = await tx.select({ id: botConversationStates.id })
          .from(botConversationStates)
          .where(and(
            eq(botConversationStates.flowId, flow.id),
            eq(botConversationStates.phone, phone),
            eq(botConversationStates.status, 'active')
          ));

        if (!existing) {
          const [pausedState] = await tx.select({ id: botConversationStates.id })
            .from(botConversationStates)
            .where(and(
              eq(botConversationStates.flowId, flow.id),
              eq(botConversationStates.phone, phone),
              eq(botConversationStates.status, 'paused_csw')
            ));
          if (pausedState) {
            await tx.update(botConversationStates).set({
              status: 'active',
              lastActivityAt: new Date(),
            }).where(eq(botConversationStates.id, pausedState.id));
            console.log(`[CSW_RESUME] phone=${phone} stateId=${pausedState.id}`, { flowId: flow.id });
            logBotEvent('info', phone, '[CSW_RESUME] Retomando conversa paused_csw — CSW reaberta por mensagem recebida', { flowId: flow.id, stateId: pausedState.id });
          }

          if (!pausedState) {
            const [timedOutState] = await tx.select({ id: botConversationStates.id })
              .from(botConversationStates)
              .where(and(
                eq(botConversationStates.flowId, flow.id),
                eq(botConversationStates.phone, phone),
                eq(botConversationStates.status, 'timed_out')
              ));
            if (timedOutState) {
              const startNode = nodes.find(n => n.nodeType === 'start') || nodes[0];
              await tx.update(botConversationStates).set({
                status: 'active',
                currentNodeId: startNode.id,
                lastActivityAt: new Date(),
                completedAt: null,
                variables: {},
                lastResponse: null,
              }).where(eq(botConversationStates.id, timedOutState.id));
              logBotEvent('info', phone, 'Restarted timed_out conversation from start node', { flowId: flow.id, stateId: timedOutState.id, startNodeId: startNode.id });
            }
          }
        }

        const [existingOrResumed] = existing
          ? [existing]
          : await tx.select({ id: botConversationStates.id })
              .from(botConversationStates)
              .where(and(
                eq(botConversationStates.flowId, flow.id),
                eq(botConversationStates.phone, phone),
                eq(botConversationStates.status, 'active')
              ));

        let capturedStateId: string;

        if (!existingOrResumed) {
          // No active state found — start the flow for any phone (unknown or known).
          // Lead verification is intentionally removed: any inbound message triggers the flow.
          const startNode = nodes.find(n => n.nodeType === 'start') || nodes[0];
          console.log(`[BOT_UNKNOWN_LEAD] phone=${phone} → flow started anyway`, { campaignId, flowId: flow.id, startNodeId: startNode.id });
          logBotEvent('info', phone, '[BOT_UNKNOWN_LEAD] No active state — creating new conversation state and starting flow', { campaignId, flowId: flow.id, startNodeId: startNode.id });

          const [newState] = await tx.insert(botConversationStates).values({
            flowId: flow.id,
            campaignId,
            phone,
            currentNodeId: startNode.id,
            variables: {},
            status: 'active',
            lastResponse: null,
          }).returning({ id: botConversationStates.id });

          capturedStateId = newState.id;
          logBotEvent('info', phone, 'Conversa iniciada', { flowId: flow.id, nodeId: startNode.id });
        } else {
          capturedStateId = existingOrResumed.id;
        }

        // Row-level lock on the state row (covers both new and existing rows)
        const [freshState] = await tx.select()
          .from(botConversationStates)
          .where(eq(botConversationStates.id, capturedStateId))
          .for('update');

        if (!freshState || freshState.status !== 'active') {
          return { action: 'skip' };
        }

        // Idempotency: if this message was already successfully processed, skip
        // (lastInboundMessageId is only written after a successful send in Phase 4)
        if (inboundMessageId && freshState.lastInboundMessageId === inboundMessageId) {
          logBotEvent('warn', phone, 'Duplicate inbound message ignored', { op: 'processInboundMessage', inboundMessageId });
          return { action: 'duplicate' };
        }

        let currentNode = nodes.find(n => n.id === freshState.currentNodeId);
        if (!currentNode) {
          const startNode = nodes.find(n => n.nodeType === 'start') || nodes[0];
          logBotEvent('warn', phone, 'Nó atual não encontrado (deletado/modificado) — resetando para start', { oldNodeId: freshState.currentNodeId, newNodeId: startNode.id });
          await tx.update(botConversationStates).set({
            currentNodeId: startNode.id,
            lastActivityAt: new Date(),
          }).where(eq(botConversationStates.id, capturedStateId));
          currentNode = startNode;
        }

        console.log(`[NODE_EXECUTION] nodeId=${currentNode.id} nodeType=${currentNode.nodeType} phone=${phone}`, { flowId: flow.id, campaignId });
        logBotEvent('info', phone, '[NODE_EXECUTION] Mensagem recebida', { currentNodeId: currentNode.id, nodeType: currentNode.nodeType, messageBody: messageBody.substring(0, 100), buttonReplyId, buttonReplyTitle });

        let nextNodeId: string | null = null;

        if (buttonReplyId || buttonReplyTitle) {
          logBotEvent('info', phone, 'button_reply recebido', { buttonReplyId, buttonReplyTitle });
          const directNodeId = this.findButtonDirectRoute(currentNode, buttonReplyId, buttonReplyTitle, campaignId);
          if (directNodeId) {
            nextNodeId = directNodeId;
            logBotEvent('info', phone, 'payload identificado — roteamento direto via botão', { buttonReplyId, buttonReplyTitle, targetNodeId: directNodeId });
          } else {
            const campaignDirectNodeId = await this.findCampaignButtonDirectRoute(campaignId, buttonReplyId, buttonReplyTitle, nodes);
            if (campaignDirectNodeId) {
              nextNodeId = campaignDirectNodeId;
              logBotEvent('info', phone, 'nó disparado via botão de campanha (firstResponseButtons)', { buttonReplyId, buttonReplyTitle, targetNodeId: campaignDirectNodeId });
            } else {
              logBotEvent('info', phone, 'payload sem nextNodeId — fallback para keyword match', { buttonReplyId, buttonReplyTitle });
            }
          }
        }

        if (!nextNodeId) {
          const conditions = (currentNode.conditions as BotNodeCondition[]) || [];
          for (const condition of conditions) {
            if (evaluateCondition(condition, messageBody)) {
              nextNodeId = condition.nextNodeId;
              break;
            }
          }
        }
        if (!nextNodeId && currentNode.defaultNextNodeId) {
          nextNodeId = currentNode.defaultNextNodeId;
        }

        // Build variable snapshot (update tracking but NOT currentNodeId yet)
        const vars = (freshState.variables as Record<string, string>) || {};
        if (currentNode.variableCapture) {
          vars[currentNode.variableCapture] = messageBody.trim();
        }
        vars['resposta_anterior'] = messageBody.trim();

        const trackingUpdate = {
          variables: vars,
          lastResponse: messageBody.trim(),
          lastActivityAt: new Date(),
          // NOTE: lastInboundMessageId is intentionally NOT written here.
          // It is written ONLY after a successful send (Phase 4 / fallback success).
          // Writing it here would prevent retries when the send fails.
          // Concurrent serialisation is handled by pg_advisory_xact_lock + FOR UPDATE.
        };

        await tx.update(botConversationStates).set(trackingUpdate)
          .where(eq(botConversationStates.id, freshState.id));

        if (!nextNodeId) {
          return { action: 'fallback', currentNode, state: { ...freshState, ...trackingUpdate } as BotConversationState, capturedStateId };
        }

        const nextNode = nodes.find(n => n.id === nextNodeId);
        if (!nextNode) {
          // Target node missing — reset to start node instead of ending the conversation
          const startNode = nodes.find(n => n.nodeType === 'start') || nodes[0];
          console.log(`[FLOW_NODE_RECOVERY] nodeId=${nextNodeId} → reset to start`, { phone, startNodeId: startNode.id });
          logBotEvent('warn', phone, '[FLOW_NODE_RECOVERY] Nó de destino não encontrado — resetando para nó inicial', { nextNodeId, startNodeId: startNode.id });
          await tx.update(botConversationStates).set({
            currentNodeId: startNode.id,
            lastActivityAt: new Date(),
          }).where(eq(botConversationStates.id, freshState.id));
          return { action: 'skip' };
        }

        const action: TransitionAction = nextNode.nodeType === 'end' ? 'end' : 'send';
        return {
          action,
          currentNode,
          nextNode,
          state: { ...freshState, ...trackingUpdate } as BotConversationState,
          capturedStateId,
        };
      });

      // ── Phase 3: Send message outside transaction ─────────────────────────
      if (transition.action === 'skip') return 'graceful_skip';
      if (transition.action === 'duplicate') return 'handled';

      if (transition.action === 'fallback') {
        console.log(`[FLOW_FALLBACK_REASON] reason=unrecognized_response phone=${phone}`, { nodeId: transition.currentNode?.id, messageBody: messageBody.substring(0, 100) });
        logBotEvent('warn', phone, '[FLOW_FALLBACK_REASON] Resposta não reconhecida — mantendo etapa atual', {
          reason: 'unrecognized_response',
          messageBody: messageBody.substring(0, 100),
          nodeId: transition.currentNode?.id,
        });
        const isOpen = await cswTracker.isCSWOpen(phone);
        if (!isOpen) {
          console.warn(`[ALERT_CSW_BLOCK]`, { phone, campaignId, context: 'fallback' });
        }
        if (isOpen) {
          let fallbackSent = false;
          const campaignFallbackMsg = await this.getMediaFallbackMessage(campaignId);
          try {
            await withSendQueue(phone, () =>
              metaAPI.sendFreeFormMessage(phoneNumberId, phone, campaignFallbackMsg, accessToken)
            );
            fallbackSent = true;
            await wabaStorage.createMessage({
              conversationId: convoId,
              direction: 'outbound',
              body: campaignFallbackMsg,
              type: 'text',
              status: 'sent',
            });
          } catch (err: any) {
            logBotEvent('error', phone, 'Erro ao enviar fallback', { op: 'fallback', phone, error: err.message, stack: err.stack });
          }
          if (fallbackSent && inboundMessageId && transition.capturedStateId) {
            await db.update(botConversationStates)
              .set({ lastInboundMessageId: inboundMessageId, lastActivityAt: new Date() })
              .where(eq(botConversationStates.id, transition.capturedStateId));
          }
        }
        return 'handled';
      }

      // action === 'send' | 'end'
      if (!transition.nextNode || !transition.state || !transition.capturedStateId) return 'handled';
      const resolvedStateId = transition.capturedStateId;

      if (transition.action === 'end' && !transition.nextNode.messageContent) {
        console.log(`[FLOW_COMPLETED] phone=${phone}`, { nodeId: transition.nextNode.id, campaignId, flowId: flow.id });
        logBotEvent('info', phone, '[FLOW_COMPLETED] Conversa finalizada sem mensagem final', { nodeId: transition.nextNode.id });
        await db.update(botConversationStates).set({
          currentNodeId: transition.nextNode.id,
          status: 'completed',
          completedAt: new Date(),
          lastInboundMessageId: inboundMessageId ?? null,
        }).where(eq(botConversationStates.id, resolvedStateId));
        return 'handled';
      }

      const sendResult = await this.sendNodeMessage(
        transition.nextNode, phone, phoneNumberId, accessToken, convoId, transition.state
      );

      // ── Phase 4: Advance state only after successful send ─────────────────
      if (!sendResult.success) {
        logBotEvent('error', phone, 'Falha ao enviar mensagem, estado NÃO avançado (retry seguro)', {
          op: 'processInboundMessage',
          nodeId: transition.nextNode.id,
          error: sendResult.error,
        });
        incrementAlertCounter('botFailures');
        return 'graceful_skip';
      } else if (sendResult.cswAction === 'end') {
        await db.update(botConversationStates).set({
          currentNodeId: transition.nextNode.id,
          status: 'completed',
          completedAt: new Date(),
          lastActivityAt: new Date(),
          lastInboundMessageId: inboundMessageId ?? null,
        }).where(eq(botConversationStates.id, resolvedStateId));
        logBotEvent('info', phone, 'CSW fallback end — conversa encerrada', { nodeId: transition.nextNode.id });
      } else if (sendResult.cswAction === 'skip') {
        const skippedNodeId = transition.nextNode.id;
        let advanceToId: string | null = transition.nextNode.defaultNextNodeId;
        if (!advanceToId) {
          const allNodes = await this.getFlowNodes(flow.id);
          const skippedIdx = allNodes.findIndex(n => n.id === skippedNodeId);
          if (skippedIdx >= 0 && skippedIdx < allNodes.length - 1) {
            advanceToId = allNodes[skippedIdx + 1].id;
          }
        }
        if (advanceToId) {
          const [advanceNode] = await db.select().from(botFlowNodes).where(eq(botFlowNodes.id, advanceToId));
          const isEnd = advanceNode?.nodeType === 'end';
          await db.update(botConversationStates).set({
            currentNodeId: advanceToId,
            lastActivityAt: new Date(),
            lastInboundMessageId: inboundMessageId ?? null,
            ...(isEnd ? { status: 'completed' as const, completedAt: new Date() } : {}),
          }).where(eq(botConversationStates.id, resolvedStateId));
          logBotEvent('info', phone, `CSW fallback skip — avançou de ${skippedNodeId} para ${advanceToId}`, { skippedNodeId, advanceToId });
        } else {
          await db.update(botConversationStates).set({
            currentNodeId: skippedNodeId,
            status: 'completed',
            completedAt: new Date(),
            lastActivityAt: new Date(),
            lastInboundMessageId: inboundMessageId ?? null,
          }).where(eq(botConversationStates.id, resolvedStateId));
          logBotEvent('info', phone, 'CSW fallback skip — sem próximo nó, conversa finalizada', { skippedNodeId });
        }
      } else {
        const [check] = await db.select({ status: botConversationStates.status })
          .from(botConversationStates)
          .where(eq(botConversationStates.id, resolvedStateId));

        if (check && check.status !== 'paused_csw') {
          await db.update(botConversationStates).set({
            currentNodeId: transition.nextNode.id,
            lastActivityAt: new Date(),
            lastInboundMessageId: inboundMessageId ?? null,
            ...(transition.action === 'end' ? { status: 'completed' as const, completedAt: new Date() } : {}),
          }).where(eq(botConversationStates.id, resolvedStateId));
        }

        if (transition.action === 'end') {
          console.log(`[FLOW_COMPLETED] phone=${phone}`, { nodeId: transition.nextNode.id, campaignId, flowId: flow.id });
          logBotEvent('info', phone, '[FLOW_COMPLETED] Conversa finalizada', { fromNodeId: transition.currentNode?.id, toNodeId: transition.nextNode.id });
        } else {
          logBotEvent('info', phone, 'Estado avançado', { fromNodeId: transition.currentNode?.id, toNodeId: transition.nextNode.id });
        }
      }

      return 'handled';
  }

  private async getGlobalCswFallback(campaignId: string): Promise<CswFallbackAction | undefined> {
    try {
      const [campaign] = await db.select({ botConfig: campaigns.botConfig })
        .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (campaign?.botConfig && typeof campaign.botConfig === 'object') {
        const cfg = campaign.botConfig as Record<string, unknown>;
        const val = cfg.cswFallbackDefault;
        if (val === 'text_only' || val === 'skip' || val === 'end') return val;
      }
    } catch (err: any) {
      logBotEvent('warn', '', 'Erro ao buscar cswFallbackDefault da campanha', { campaignId, error: err.message });
    }
    return undefined;
  }

  private async getMediaFallbackMessage(campaignId: string): Promise<string> {
    try {
      const [campaign] = await db.select({ botConfig: campaigns.botConfig })
        .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (campaign?.botConfig && typeof campaign.botConfig === 'object') {
        const cfg = campaign.botConfig as Record<string, unknown>;
        if (typeof cfg.fallbackMessage === 'string' && cfg.fallbackMessage.trim()) {
          return cfg.fallbackMessage.trim();
        }
      }
    } catch (err: any) {
      logBotEvent('warn', '', 'Erro ao buscar fallbackMessage da campanha', { campaignId, error: err.message });
    }
    return this.fallbackMessage;
  }

  private async findCampaignButtonDirectRoute(
    campaignId: string,
    buttonReplyId?: string,
    buttonReplyTitle?: string,
    flowNodes?: BotFlowNode[]
  ): Promise<string | null> {
    try {
      const [campaign] = await db.select({ campaignConfig: campaigns.campaignConfig })
        .from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (!campaign?.campaignConfig) return null;

      const cfg = campaign.campaignConfig as Record<string, any>;
      const firstResponseButtons = cfg.firstResponseButtons as Array<{ id?: string; title?: string; nextNodeId?: string }> | undefined;
      if (!firstResponseButtons || firstResponseButtons.length === 0) return null;

      for (const btn of firstResponseButtons) {
        if (!btn.nextNodeId) continue;
        const idMatch = buttonReplyId && (btn.id === buttonReplyId || btn.title === buttonReplyId);
        const titleMatch = buttonReplyTitle && (btn.title === buttonReplyTitle || btn.id === buttonReplyTitle);
        if (idMatch || titleMatch) {
          if (flowNodes) {
            const targetExists = flowNodes.some(n => n.id === btn.nextNodeId);
            if (!targetExists) {
              logBotEvent('warn', 'system', 'firstResponseButtons nextNodeId aponta para nó inexistente', { nextNodeId: btn.nextNodeId, campaignId });
              return null;
            }
          }
          return btn.nextNodeId;
        }
      }
    } catch (err: any) {
      logBotEvent('error', 'system', 'Erro ao buscar firstResponseButtons da campanha', { campaignId, error: err.message });
    }
    return null;
  }

  private findButtonDirectRoute(
    currentNode: BotFlowNode,
    buttonReplyId?: string,
    buttonReplyTitle?: string,
    _campaignId?: string
  ): string | null {
    if (!currentNode.buttonPayload) return null;

    const rawPayload = currentNode.buttonPayload;
    let buttons: ButtonPayloadItem[] = [];

    if (Array.isArray(rawPayload)) {
      buttons = rawPayload as ButtonPayloadItem[];
    } else if (rawPayload !== null && typeof rawPayload === 'object' && 'items' in rawPayload) {
      buttons = (rawPayload as ButtonsPayloadMeta).items || [];
    } else if (rawPayload !== null && typeof rawPayload === 'object' && 'sections' in rawPayload) {
      const listPayload = rawPayload as ListPayload;
      for (const section of (listPayload.sections || [])) {
        for (const row of (section.rows || [])) {
          if (row.nextNodeId) {
            const rowIdMatch = buttonReplyId && (row.id === buttonReplyId);
            const rowTitleMatch = buttonReplyTitle && (row.title === buttonReplyTitle);
            if (rowIdMatch || rowTitleMatch) {
              return row.nextNodeId;
            }
          }
        }
      }
      return null;
    }

    for (const btn of buttons) {
      if (!btn.nextNodeId) continue;
      const idMatch = buttonReplyId && (btn.id === buttonReplyId || btn.title === buttonReplyId);
      const titleMatch = buttonReplyTitle && (btn.title === buttonReplyTitle || btn.id === buttonReplyTitle);
      if (idMatch || titleMatch) {
        return btn.nextNodeId;
      }
    }

    return null;
  }

  protected async sendNodeMessage(
    node: BotFlowNode,
    phone: string,
    phoneNumberId: string,
    accessToken: string,
    convoId: string,
    state: BotConversationState
  ): Promise<SendResult> {
    if (!phoneNumberId || !phoneNumberId.trim()) {
      logBotEvent('error', phone, 'sendNodeMessage called with empty phoneNumberId — cannot send', { nodeId: node.id, convoId });
      return { success: false, error: 'phoneNumberId is empty' };
    }
    if (!accessToken || !accessToken.trim()) {
      logBotEvent('error', phone, 'sendNodeMessage called with empty accessToken — cannot send', { nodeId: node.id, convoId });
      return { success: false, error: 'accessToken is empty' };
    }

    const msgType = node.messageType || 'text';
    if (!node.messageContent && msgType === 'text') {
      console.warn(`[ALERT_BOT_EMPTY_NODE]`, { nodeId: node.id, phone, convoId });
      try {
        await withSendQueue(phone, () =>
          metaAPI.sendFreeFormMessage(phoneNumberId, phone, 'Obrigado pelo contato!', accessToken)
        );
      } catch (err: any) {
        logBotEvent('error', phone, 'Erro ao enviar fallback de nó vazio', { nodeId: node.id, error: err.message });
      }
      return { success: true };
    }
    const isInteractive = msgType === 'buttons' || msgType === 'list';

    const isOpen = await cswTracker.isCSWOpen(phone);
    if (!isOpen && !isInteractive) {
      console.warn(`[ALERT_CSW_BLOCK]`, { phone, campaignId: state.campaignId, nodeId: node.id });
      logBotEvent('warn', phone, 'CSW fechada, marcando como paused_csw');
      await db.update(botConversationStates).set({
        status: 'paused_csw',
        lastActivityAt: new Date(),
      }).where(eq(botConversationStates.id, state.id));
      return { success: false, error: 'CSW fechada' };
    }

    const leadData = await this.getLeadData(phone);
    const conversationVars = (state.variables as Record<string, string>) || {};
    const allVars: Record<string, string> = { ...leadData, ...conversationVars };

    const nodeRecord = node as BotFlowNode & { linkUrl?: string | null };
    if (nodeRecord.linkUrl) {
      allVars['link'] = nodeRecord.linkUrl;
      const cpf = leadData.cpf || '';
      allVars['dynamic_link'] = cpf ? `${nodeRecord.linkUrl}/${cpf}` : nodeRecord.linkUrl;
    }

    const messageText = replaceVariables(node.messageContent || '', allVars);

    await interNodeDelay();

    type CswResult = 'sent' | 'fallback_text' | 'fallback_skip' | 'fallback_end';
    let sendSuccess = true;
    let errorMsg = '';
    const cswResultHolder: { value: CswResult } = { value: 'sent' };

    let _imageTemplateIdemMessageId: string | undefined;
    let _imageTemplateTemplateId: string | undefined;

    try {
      await withSendQueue(phone, async () => {
        if (msgType === 'combined' && node.mediaUrl) {
          if (node.mediaUrl.match(/\.(mp3|ogg|opus|wav|aac|m4a|oga)(\?|$)/i)) {
            let textSent = false;
            if (messageText) {
              await metaAPI.sendFreeFormMessage(phoneNumberId, phone, messageText, accessToken);
              textSent = true;
              await interNodeDelay();
            }

            const audioValidation = validateAudioUrl(node.mediaUrl);
            if (!audioValidation.valid) {
              if (textSent) {
                logBotEvent('warn', phone, 'Entrega parcial: texto enviado mas áudio inválido', {
                  op: 'sendNodeMessage',
                  mediaUrl: node.mediaUrl,
                  validationError: audioValidation.error,
                });
              }
              throw new Error(audioValidation.error);
            }

            const combinedAudioReachable = await checkMediaUrlReachable(node.mediaUrl);
            if (!combinedAudioReachable) {
              console.warn(`[MEDIA_PREFLIGHT_FAIL] combined/audio URL unreachable, sending fallback. url=${node.mediaUrl} phone=${phone}`);
              const fallbackMsg = await this.getMediaFallbackMessage(state.campaignId);
              await metaAPI.sendFreeFormMessage(phoneNumberId, phone, fallbackMsg, accessToken);
            } else {
              await interNodeDelay();
              try {
                await this.sendAudioWithRetry(phoneNumberId, phone, node.mediaUrl, accessToken);
              } catch (audioErr: any) {
                if (textSent) {
                  logBotEvent('warn', phone, 'Entrega parcial: texto enviado mas áudio falhou', {
                    op: 'sendNodeMessage',
                    mediaUrl: node.mediaUrl,
                    error: audioErr.message,
                    stack: audioErr.stack,
                  });
                }
                throw audioErr;
              }
              await interNodeDelay();
            }
          } else {
            const combinedImgReachable = await checkMediaUrlReachable(node.mediaUrl);
            if (!combinedImgReachable) {
              console.warn(`[MEDIA_PREFLIGHT_FAIL] combined/image URL unreachable, sending fallback. url=${node.mediaUrl} phone=${phone}`);
              const fallbackMsg = await this.getMediaFallbackMessage(state.campaignId);
              await metaAPI.sendFreeFormMessage(phoneNumberId, phone, fallbackMsg, accessToken);
            } else {
              await metaAPI.sendImageMessage(phoneNumberId, phone, node.mediaUrl, messageText || undefined, accessToken);
            }
          }
        } else if (msgType === 'audio' && node.mediaUrl) {
          const audioValidation = validateAudioUrl(node.mediaUrl);
          if (!audioValidation.valid) {
            throw new Error(audioValidation.error);
          }
          const audioReachable = await checkMediaUrlReachable(node.mediaUrl);
          if (!audioReachable) {
            console.warn(`[MEDIA_PREFLIGHT_FAIL] audio URL unreachable, sending fallback. url=${node.mediaUrl} phone=${phone}`);
            const fallbackMsg = await this.getMediaFallbackMessage(state.campaignId);
            await metaAPI.sendFreeFormMessage(phoneNumberId, phone, fallbackMsg, accessToken);
          } else {
            await interNodeDelay();
            await this.sendAudioWithRetry(phoneNumberId, phone, node.mediaUrl, accessToken);
            await interNodeDelay();
          }
        } else if (msgType === 'tts_audio' && node.mediaUrl && node.messageContent) {
          const ttsFlowStartMs = Date.now();
          const voiceProfileId = node.mediaUrl;
          logBotEvent('info', phone, '[tts_audio] Step 1: Looking up voice profile and campaign', { voiceProfileId });
          const [campaign] = state.campaignId
            ? await db.select().from(campaigns).where(eq(campaigns.id, state.campaignId))
            : [null];
          const campaignUserId = campaign?.userId;
          const [voiceProfile] = campaignUserId
            ? await db.select().from(voiceProfiles).where(and(eq(voiceProfiles.id, voiceProfileId), eq(voiceProfiles.userId, campaignUserId)))
            : await db.select().from(voiceProfiles).where(eq(voiceProfiles.id, voiceProfileId));
          if (!voiceProfile) {
            logBotEvent('warn', phone, '[tts_audio] Perfil de voz não encontrado, enviando texto como fallback', { voiceProfileId, elapsed_ms: Date.now() - ttsFlowStartMs });
            await metaAPI.sendFreeFormMessage(phoneNumberId, phone, messageText, accessToken);
          } else {
            const ttsVars: Record<string, string> = {
              nome: leadData.nome || leadData.name || '',
              telefone: leadData.telefone || phone,
              cpf: leadData.cpf || '',
              produto: String(leadData.produto || conversationVars.produto || ''),
              valor: String(leadData.valor || conversationVars.valor || ''),
              codigo_rastreio: String(leadData.codigo_rastreio || conversationVars.codigo_rastreio || ''),
              ...conversationVars,
            };
            const buildFallbackText = () => (node.messageContent ?? '')
              .replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => ttsVars[k] ?? `[${k}]`)
              .trim();

            logBotEvent('info', phone, '[tts_audio] Step 2: Health pre-check', { voiceProfileId });
            const ttsHealth = await ttsService.checkHealth();
            if (!ttsHealth.available) {
              const healthError = {
                step: 'health_check',
                error: 'TTS service unavailable',
                details: { voiceProfileId, health: ttsHealth, elapsed_ms: Date.now() - ttsFlowStartMs },
              };
              logBotEvent('warn', phone, '[tts_audio] Structured TTS error — falling back to text', healthError);
              console.error(`[TTS_BOT_FLOW_ERROR] step=health_check voiceProfileId=${voiceProfileId} error=service_unavailable`);
              await interNodeDelay();
              await metaAPI.sendFreeFormMessage(phoneNumberId, phone, buildFallbackText() || messageText, accessToken);
              await interNodeDelay();
            } else if (!ttsHealth.modelLoaded) {
              const healthError = {
                step: 'health_check',
                error: 'TTS model not loaded',
                details: { voiceProfileId, health: ttsHealth, elapsed_ms: Date.now() - ttsFlowStartMs },
              };
              logBotEvent('warn', phone, '[tts_audio] Structured TTS error — falling back to text', healthError);
              console.error(`[TTS_BOT_FLOW_ERROR] step=health_check voiceProfileId=${voiceProfileId} error=model_not_loaded`);
              await interNodeDelay();
              await metaAPI.sendFreeFormMessage(phoneNumberId, phone, buildFallbackText() || messageText, accessToken);
              await interNodeDelay();
            } else {
            logBotEvent('info', phone, '[tts_audio] Step 3: Preparing TTS generation', { voiceProfileId, refPath: voiceProfile.referenceAudioPath });
            logBotEvent('info', phone, '[tts_audio] Step 4: Generating audio via AudioStitchingService', { voiceProfileId, template: node.messageContent.substring(0, 60) });
            let ttsCfg: { speed?: number; humanize?: boolean; pitch?: number; volume?: number; pauseLevel?: number; expressiveness?: number } = {};
            try { if (node.linkUrl) ttsCfg = JSON.parse(node.linkUrl); } catch (parseErr) { logBotEvent('warn', phone, '[tts_audio] Failed to parse TTS config from linkUrl', { linkUrl: node.linkUrl, error: String(parseErr) }); }
            const ttsSpeed = Math.max(0.5, Math.min(2.0, Number(ttsCfg.speed ?? 1.0)));
            const ttsHumanize = ttsCfg.humanize !== false;

            let ttsStep = 'audio_generation';
            try {
              const audioBuffer = await audioStitchingService.generateForLead({
                template: node.messageContent,
                variables: ttsVars,
                referenceWavPath: voiceProfile.referenceAudioPath,
                voiceProfileId,
                speed: ttsSpeed,
                humanize: ttsHumanize,
                pitch: ttsCfg.pitch,
                volume: ttsCfg.volume,
                pauseLevel: ttsCfg.pauseLevel,
                expressiveness: ttsCfg.expressiveness,
              });

              ttsStep = 'buffer_validation';
              if (!audioBuffer || audioBuffer.length < 1024) {
                throw new Error(`TTS generation returned audio too small to be valid (${audioBuffer?.length ?? 0} bytes, mínimo 1KB)`);
              }

              ttsStep = 'upload';
              logBotEvent('info', phone, '[tts_audio] Step 5: Uploading audio to Meta', { voiceProfileId, audioBytes: audioBuffer.length, elapsed_ms: Date.now() - ttsFlowStartMs });
              const mediaId = await metaAPI.uploadMediaToMeta(
                phoneNumberId,
                audioBuffer,
                'audio/ogg',
                `tts_${phone.slice(-6)}_${Date.now()}.ogg`,
                accessToken
              );

              ttsStep = 'send';
              logBotEvent('info', phone, '[tts_audio] Step 6: Sending voice note', { voiceProfileId, mediaId, elapsed_ms: Date.now() - ttsFlowStartMs });
              await interNodeDelay();
              await metaAPI.sendVoiceNoteMessage(phoneNumberId, phone, mediaId, accessToken);
              logBotEvent('info', phone, '[tts_audio] Step 7: Complete', { voiceProfileId, elapsed_ms: Date.now() - ttsFlowStartMs });
              await interNodeDelay();
            } catch (ttsErr: any) {
              const structuredError = {
                step: ttsStep,
                error: ttsErr?.message || String(ttsErr),
                details: {
                  voiceProfileId,
                  elapsed_ms: Date.now() - ttsFlowStartMs,
                  stack: ttsErr?.stack?.slice(0, 300),
                  code: ttsErr?.code || null,
                },
              };
              logBotEvent('warn', phone, '[tts_audio] Structured TTS error — falling back to text', structuredError);
              console.error(`[TTS_BOT_FLOW_ERROR] step=${ttsStep} voiceProfileId=${voiceProfileId} error=${ttsErr?.message?.slice(0, 200)}`);
              await interNodeDelay();
              await metaAPI.sendFreeFormMessage(phoneNumberId, phone, buildFallbackText() || messageText, accessToken);
              await interNodeDelay();
            }
          }
          }
        } else if (msgType === 'image' && node.mediaUrl) {
          if (!node.mediaUrl.startsWith('https://')) {
            throw new Error(`[ALERT_MEDIA_FAILURE] Image URL must be HTTPS: ${node.mediaUrl}`);
          }
          const imgReachable = await checkMediaUrlReachable(node.mediaUrl);
          if (!imgReachable) {
            console.warn(`[MEDIA_PREFLIGHT_FAIL] image URL unreachable, sending fallback. url=${node.mediaUrl} phone=${phone}`);
            const fallbackMsg = await this.getMediaFallbackMessage(state.campaignId);
            await metaAPI.sendFreeFormMessage(phoneNumberId, phone, fallbackMsg, accessToken);
          } else {
            await metaAPI.sendImageMessage(phoneNumberId, phone, node.mediaUrl, messageText || undefined, accessToken);
          }
        } else if (msgType === 'buttons' && node.buttonPayload) {
          const rawPayload = node.buttonPayload;
          let payload: ButtonPayloadItem[] | ButtonsPayloadMeta;
          if (Array.isArray(rawPayload)) {
            payload = rawPayload as ButtonPayloadItem[];
          } else if (rawPayload !== null && typeof rawPayload === 'object' && 'items' in rawPayload) {
            payload = rawPayload as ButtonsPayloadMeta;
          } else {
            payload = rawPayload as ButtonPayloadItem[];
          }
          const globalFb = await this.getGlobalCswFallback(state.campaignId);
          cswResultHolder.value = await sendButtons(phoneNumberId, phone, messageText, payload, accessToken, globalFb);
        } else if (msgType === 'list' && node.buttonPayload) {
          const listPayload = node.buttonPayload as ListPayload;
          const globalFb = await this.getGlobalCswFallback(state.campaignId);
          cswResultHolder.value = await sendList(phoneNumberId, phone, messageText, listPayload, accessToken, globalFb);
        } else if (msgType === 'image_template' && node.mediaUrl) {
          const templateId = node.mediaUrl;
          const imgPipelineStart = Date.now();

          const idemMessageId = buildImageIdemKey(state.id, node.id);
          _imageTemplateIdemMessageId = idemMessageId;
          _imageTemplateTemplateId = templateId;
          const claimed = await claimSendRight(idemMessageId, phone, templateId);
          if (!claimed) {
            logBotEvent('warn', phone, '[image_template] Idempotency: already claimed/confirmed — skipping duplicate delivery', { templateId, nodeId: node.id, idemMessageId });
            return;
          }
          const [tpl] = await db.select().from(imageTemplates).where(eq(imageTemplates.id, templateId));
          if (!tpl) throw new Error(`Template de imagem não encontrado: ${templateId}`);

          const leadDataForImg = {
            name: leadData.nome || leadData.name || 'CLIENTE',
            cpf: leadData.cpf || '',
            // Pass conversation variables so {{produto}}, {{valor}}, and other
            // custom fields in the template are substituted correctly at render time.
            extraVars: conversationVars,
          };

          logBotEvent('info', phone, '[image_template] Pipeline iniciado', {
            templateId,
            leadName: leadDataForImg.name.substring(0, 20),
            leadCpfMasked: leadDataForImg.cpf ? leadDataForImg.cpf.replace(/\d(?=\d{4})/g, '*') : '',
            fieldCount: Array.isArray(tpl.fields) ? tpl.fields.length : 0,
          });

          const generateImgBuffer = async (): Promise<Buffer> => {
            let baseBuffer: Buffer;
            const basePathExists = tpl.baseImagePath
              ? await fs.promises.access(tpl.baseImagePath).then(() => true).catch(() => false)
              : false;

            if (!basePathExists && tpl.baseImageData) {
              const safeBasePath = tpl.baseImagePath || path.join(BOT_IMAGES_DIR, 'templates', `${tpl.id}.jpg`);
              const dir = path.dirname(safeBasePath);
              await fs.promises.mkdir(dir, { recursive: true });
              const restoredBuf = Buffer.from(tpl.baseImageData, 'base64');
              await fs.promises.writeFile(safeBasePath, restoredBuf);
              if (!tpl.baseImagePath) {
                await db.update(imageTemplates).set({ baseImagePath: safeBasePath }).where(eq(imageTemplates.id, tpl.id));
                tpl.baseImagePath = safeBasePath;
              }
              baseBuffer = restoredBuf;
            } else if (basePathExists) {
              baseBuffer = await fs.promises.readFile(tpl.baseImagePath!);
            } else {
              throw new Error('Arquivo base do template não encontrado e sem dados no banco');
            }
            const tplFields = (tpl.fields || []) as ImageTemplateField[];
            logGenerationStart(phone, templateId);
            let baseBuffer_: Buffer | null = baseBuffer;
            try {
              const genStart = Date.now();
              const result = await generateFromCustomTemplate(baseBuffer_!, tplFields, leadDataForImg, { templateId });
              logGenerationEnd(phone, templateId);
              logBotEvent('info', phone, '[image_template] Renderização concluída', {
                templateId,
                renderMs: Date.now() - genStart,
                outputBytes: result.length,
                fieldPositions: tplFields.map(f => ({ id: f.id, type: f.type, x: f.x, y: f.y })),
              });
              return result;
            } catch (genErr: unknown) {
              const e = genErr instanceof Error ? genErr : new Error(String(genErr));
              logGenerationEnd(phone, templateId, e.message);
              throw e;
            } finally {
              baseBuffer_ = null;
            }
          };

          const safePhone = phone.replace(/\D/g, '');
          const botImgDir = path.join(BOT_IMAGES_DIR, 'bot');
          await fs.promises.mkdir(botImgDir, { recursive: true });
          const imgPath = path.join(botImgDir, `${safePhone}.jpg`);

          let imgBuffer: Buffer | null = await generateImgBuffer();
          await fs.promises.writeFile(imgPath, imgBuffer);

          const existingVars = (state.variables as Record<string, unknown>) || {};
          const customVars: Record<string, string> = {};
          for (const [k, v] of Object.entries(allVars)) {
            if (!k.startsWith('_') && typeof v === 'string') customVars[k] = v;
          }
          const updatedVars: Record<string, unknown> = {
            ...existingVars,
            _lastImageTemplateId: templateId,
            _lastImageParams: { name: leadDataForImg.name, cpf: leadDataForImg.cpf, ...customVars },
          };
          await db.update(botConversationStates).set({ variables: updatedVars }).where(eq(botConversationStates.id, state.id));

          let sentWithMediaId = false;
          try {
            logBotEvent('info', phone, '[image_template] Upload Meta iniciado', { templateId, imgBytes: imgBuffer.length });
            const mediaId = await metaAPI.uploadMediaToMeta(phoneNumberId, imgBuffer, 'image/jpeg', `${safePhone}.jpg`, accessToken);
            await metaAPI.sendImageMessageById(phoneNumberId, phone, mediaId, messageText || undefined, accessToken);
            sentWithMediaId = true;
            await confirmSendRight(idemMessageId, phone, templateId);
            logBotEvent('info', phone, '[image_template] Enviado via mediaId', {
              templateId,
              mediaId,
              pipelineMs: Date.now() - imgPipelineStart,
            });
          } catch (mediaIdErr: unknown) {
            const mErr = mediaIdErr instanceof Error ? mediaIdErr : new Error(String(mediaIdErr));
            logBotEvent('warn', phone, '[image_template] Primeira tentativa de upload falhou', {
              templateId,
              leadName: leadDataForImg.name,
              leadCpfMasked: leadDataForImg.cpf ? leadDataForImg.cpf.replace(/\d(?=\d{4})/g, '*') : '',
              error: mErr.message,
            });
            try {
              imgBuffer = await generateImgBuffer();
              await fs.promises.writeFile(imgPath, imgBuffer);
              const newMediaId = await metaAPI.uploadMediaToMeta(phoneNumberId, imgBuffer, 'image/jpeg', `${safePhone}.jpg`, accessToken);
              await metaAPI.sendImageMessageById(phoneNumberId, phone, newMediaId, messageText || undefined, accessToken);
              sentWithMediaId = true;
              await confirmSendRight(idemMessageId, phone, templateId);
              logBotEvent('info', phone, '[image_template] Re-upload bem-sucedido via mediaId', {
                templateId,
                newMediaId,
                pipelineMs: Date.now() - imgPipelineStart,
              });
            } catch (refreshErr: unknown) {
              const rErr = refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr));
              logBotEvent('error', phone, '[image_template] Re-upload também falhou — tentando URL assinada', {
                templateId,
                leadName: leadDataForImg.name,
                leadCpfMasked: leadDataForImg.cpf ? leadDataForImg.cpf.replace(/\d(?=\d{4})/g, '*') : '',
                error: rErr.message,
              });
            }
          }

          if (!sentWithMediaId) {
            // Signed URL fallback: 72h expiry ensures image remains accessible until Meta retrieves it.
            // The file is written to disk before this point and persists for the cleanup job to handle.
            const publicDomain = getBotPublicDomain();
            const signedUrlExpiryMs = 72 * 60 * 60 * 1000; // 72 hours
            const imageUrl = generateSignedImageUrl(publicDomain, 'bot', safePhone, signedUrlExpiryMs);

            // Pre-send accessibility check: validate that the signed URL is reachable
            // before forwarding it to Meta's API, which would silently fail if unreachable.
            const signedUrlPreflightTimeoutMs = parseInt(process.env.SIGNED_URL_PREFLIGHT_TIMEOUT_MS || '5000', 10);
            const urlCheck = await validateSignedUrlAccessibility(imageUrl, signedUrlPreflightTimeoutMs);
            // Mask token in logs: signed URL tokens grant media access until expiry.
            // Log only the token prefix (8 chars) to preserve traceability without leaking access.
            const imageUrlTokenPrefix = imageUrl.split('/').pop()?.slice(0, 8) ?? '';
            if (!urlCheck.ok) {
              logBotEvent('warn', phone, '[image_template] Signed URL preflight FAILED — sending anyway as last resort', {
                templateId,
                reason: urlCheck.reason,
                imageUrlTokenPrefix,
              });
            } else {
              logBotEvent('info', phone, '[image_template] Signed URL preflight OK', {
                templateId,
                signedUrlExpiryHours: 72,
              });
            }

            logBotEvent('info', phone, '[image_template] Enviando via URL assinada (fallback)', {
              templateId,
              signedUrlExpiryHours: 72,
              imgPath,
              preflightOk: urlCheck.ok,
            });
            await metaAPI.sendImageMessage(phoneNumberId, phone, imageUrl, messageText || undefined, accessToken);
            await confirmSendRight(idemMessageId, phone, templateId);
            logBotEvent('info', phone, '[image_template] Enviado via URL assinada', {
              templateId,
              pipelineMs: Date.now() - imgPipelineStart,
            });
          }
          imgBuffer = null;
        } else {
          await metaAPI.sendFreeFormMessage(phoneNumberId, phone, messageText, accessToken);
        }
      });
    } catch (err: any) {
      errorMsg = err?.message || String(err);
      console.error(`[ALERT_META_SEND_FAIL] attempt=1 phone=${phone} nodeId=${node.id}`, { msgType, error: errorMsg });
      logBotEvent('error', phone, `[ALERT_META_SEND_FAIL] Falha ao enviar ${msgType} (tentativa 1)`, { op: 'sendNodeMessage', msgType, mediaUrl: node.mediaUrl || undefined, error: errorMsg, stack: err?.stack });

      // For image_template: release the pending send claim so the retry can reclaim it
      // immediately instead of being blocked by `fresh_pending`.
      // This is safe because we have a caught exception — the send did NOT reach Meta.
      if (msgType === 'image_template' && _imageTemplateIdemMessageId) {
        logBotEvent('info', phone, '[image_template] Releasing pending send right before retry', { idemMessageId: _imageTemplateIdemMessageId, templateId: _imageTemplateTemplateId });
        await releaseSendRight(_imageTemplateIdemMessageId, phone, _imageTemplateTemplateId);
      }

      // Retry once before giving up — resend the same payload type as the original attempt
      try {
        await new Promise(r => setTimeout(r, 2000));
        await withSendQueue(phone, async () => {
          if (msgType === 'buttons' && node.buttonPayload) {
            const rawPayload = node.buttonPayload;
            let payload: ButtonPayloadItem[] | ButtonsPayloadMeta;
            if (Array.isArray(rawPayload)) {
              payload = rawPayload as ButtonPayloadItem[];
            } else if (rawPayload !== null && typeof rawPayload === 'object' && 'items' in rawPayload) {
              payload = rawPayload as ButtonsPayloadMeta;
            } else {
              payload = rawPayload as ButtonPayloadItem[];
            }
            const globalFb = await this.getGlobalCswFallback(state.campaignId);
            cswResultHolder.value = await sendButtons(phoneNumberId, phone, messageText, payload, accessToken, globalFb);
          } else if (msgType === 'list' && node.buttonPayload) {
            const listPayload = node.buttonPayload as ListPayload;
            const globalFb = await this.getGlobalCswFallback(state.campaignId);
            cswResultHolder.value = await sendList(phoneNumberId, phone, messageText, listPayload, accessToken, globalFb);
          } else if ((msgType === 'image' || (msgType === 'combined' && node.mediaUrl && !node.mediaUrl.match(/\.(mp3|ogg|opus|wav|aac|m4a|oga)(\?|$)/i))) && node.mediaUrl) {
            await metaAPI.sendImageMessage(phoneNumberId, phone, node.mediaUrl, messageText || undefined, accessToken);
          } else if (msgType === 'audio' && node.mediaUrl) {
            await this.sendAudioWithRetry(phoneNumberId, phone, node.mediaUrl, accessToken);
          } else if (msgType === 'image_template' && node.mediaUrl) {
            const retryTemplateId = node.mediaUrl;

            const retryIdemMessageId = buildImageIdemKey(state.id, node.id);
            const retryGate = await isAlreadyConfirmed(retryIdemMessageId, phone, retryTemplateId);
            if (retryGate === 'confirmed') {
              logBotEvent('warn', phone, '[image_template] Idempotency: confirmed on retry — skipping duplicate (original delivered)', { templateId: retryTemplateId, nodeId: node.id });
              return;
            }
            if (retryGate === 'fresh_pending') {
              logBotEvent('warn', phone, '[image_template] Idempotency: fresh-pending on retry — delivery outcome ambiguous, blocking retry to prevent duplicate', { templateId: retryTemplateId, nodeId: node.id });
              throw new Error('[image_template] Retry suppressed: original send outcome is ambiguous (fresh pending). Message may or may not have been delivered.');
            }

            // Atomic reclaim: even though isAlreadyConfirmed returned false (stale pending
            // or no record), multiple concurrent retry workers can reach this point.
            // claimSendRight() uses a DB-level compare-and-set (UPDATE WHERE stale) so that
            // exactly one worker wins the reclaim race. The loser gets rowCount=0 → skip.
            const retryRightClaimed = await claimSendRight(retryIdemMessageId, phone, retryTemplateId);
            if (!retryRightClaimed) {
              logBotEvent('warn', phone, '[image_template] Idempotency: concurrent retry worker already claimed send right — skipping', { templateId: retryTemplateId, nodeId: node.id });
              throw new Error('[image_template] Retry suppressed: concurrent worker already claimed the send right (atomic reclaim lost race).');
            }

            const [retryTpl] = await db.select().from(imageTemplates).where(eq(imageTemplates.id, retryTemplateId));
            if (!retryTpl) throw new Error(`Template de imagem não encontrado no retry: ${retryTemplateId}`);
            const retryLeadDataForImg = {
              name: leadData.nome || leadData.name || 'CLIENTE',
              cpf: leadData.cpf || '',
              extraVars: conversationVars,
            };
            const retryGenerateImgBuffer = async (): Promise<Buffer> => {
              let retryBaseBuffer: Buffer;
              const retryBasePathExists = retryTpl.baseImagePath
                ? await fs.promises.access(retryTpl.baseImagePath).then(() => true).catch(() => false)
                : false;
              if (!retryBasePathExists && retryTpl.baseImageData) {
                const safeRetryBasePath = retryTpl.baseImagePath || path.join(BOT_IMAGES_DIR, 'templates', `${retryTpl.id}.jpg`);
                const retryDir = path.dirname(safeRetryBasePath);
                await fs.promises.mkdir(retryDir, { recursive: true });
                const retryRestoredBuf = Buffer.from(retryTpl.baseImageData, 'base64');
                await fs.promises.writeFile(safeRetryBasePath, retryRestoredBuf);
                if (!retryTpl.baseImagePath) {
                  await db.update(imageTemplates).set({ baseImagePath: safeRetryBasePath }).where(eq(imageTemplates.id, retryTpl.id));
                  retryTpl.baseImagePath = safeRetryBasePath;
                }
                retryBaseBuffer = retryRestoredBuf;
              } else if (retryBasePathExists) {
                retryBaseBuffer = await fs.promises.readFile(retryTpl.baseImagePath!);
              } else {
                throw new Error('Arquivo base do template não encontrado e sem dados no banco (retry)');
              }
              const retryTplFields = (retryTpl.fields || []) as ImageTemplateField[];
              let retryBaseBuffer_: Buffer | null = retryBaseBuffer;
              try {
                const buf = await generateFromCustomTemplate(retryBaseBuffer_!, retryTplFields, retryLeadDataForImg, { templateId: retryTemplateId });
                return buf;
              } finally {
                retryBaseBuffer_ = null;
              }
            };
            const retrySafePhone = phone.replace(/\D/g, '');
            const retryBotImgDir = path.join(BOT_IMAGES_DIR, 'bot');
            await fs.promises.mkdir(retryBotImgDir, { recursive: true });
            const retryImgPath = path.join(retryBotImgDir, `${retrySafePhone}.jpg`);
            let retryImgBuffer: Buffer | null = await retryGenerateImgBuffer();
            await fs.promises.writeFile(retryImgPath, retryImgBuffer);
            let retrySentWithMediaId = false;
            try {
              const retryMediaId = await metaAPI.uploadMediaToMeta(phoneNumberId, retryImgBuffer, 'image/jpeg', `${retrySafePhone}.jpg`, accessToken);
              await metaAPI.sendImageMessageById(phoneNumberId, phone, retryMediaId, messageText || undefined, accessToken);
              retrySentWithMediaId = true;
              await confirmSendRight(retryIdemMessageId, phone, retryTemplateId);
              logBotEvent('info', phone, '[image_template] Retry com mediaId bem-sucedido', { templateId: retryTemplateId });
            } catch (retryMediaErr: unknown) {
              const rmErr = retryMediaErr instanceof Error ? retryMediaErr : new Error(String(retryMediaErr));
              logBotEvent('warn', phone, '[image_template] Retry upload falhou — tentando URL assinada', { templateId: retryTemplateId, leadName: retryLeadDataForImg.name, leadCpfMasked: retryLeadDataForImg.cpf ? retryLeadDataForImg.cpf.replace(/\d(?=\d{4})/g, '*') : '', error: rmErr.message });
              retryImgBuffer = null;
            }
            if (!retrySentWithMediaId) {
              const retryPublicDomain = getBotPublicDomain();
              const retryImageUrl = generateSignedImageUrl(retryPublicDomain, 'bot', retrySafePhone, 72 * 60 * 60 * 1000);
              const retryPreflightTimeoutMs = parseInt(process.env.SIGNED_URL_PREFLIGHT_TIMEOUT_MS || '5000', 10);
              const retryUrlCheck = await validateSignedUrlAccessibility(retryImageUrl, retryPreflightTimeoutMs);
              if (!retryUrlCheck.ok) {
                logBotEvent('warn', phone, '[image_template] Retry signed URL preflight FAILED — sending anyway as last resort', {
                  templateId: retryTemplateId,
                  reason: retryUrlCheck.reason,
                });
              }
              await metaAPI.sendImageMessage(phoneNumberId, phone, retryImageUrl, messageText || undefined, accessToken);
              await confirmSendRight(retryIdemMessageId, phone, retryTemplateId);
            }
            retryImgBuffer = null;
          } else {
            await metaAPI.sendFreeFormMessage(phoneNumberId, phone, messageText, accessToken);
          }
        });
        sendSuccess = true;
        errorMsg = '';
        logBotEvent('info', phone, '[ALERT_META_SEND_FAIL] Retry bem-sucedido na tentativa 2', { nodeId: node.id });
      } catch (retryErr: any) {
        const retryErrMsg = retryErr?.message || String(retryErr);
        console.error(`[ALERT_META_SEND_FAIL] attempt=2 phone=${phone} nodeId=${node.id}`, { msgType, error: retryErrMsg });
        logBotEvent('error', phone, `[ALERT_META_SEND_FAIL] Falha ao enviar ${msgType} (tentativa 2 — definitiva)`, { op: 'sendNodeMessage', msgType, error: retryErrMsg });
        sendSuccess = false;
        errorMsg = retryErrMsg;

        // After 2 failures, send per-campaign fallback to user but do NOT set sendSuccess = true.
        // State must NOT advance — caller sees success=false and will not advance currentNodeId.
        try {
          const campaignFallbackMsg = await this.getMediaFallbackMessage(state.campaignId);
          await withSendQueue(phone, () =>
            metaAPI.sendFreeFormMessage(phoneNumberId, phone, campaignFallbackMsg, accessToken)
          );
          logBotEvent('warn', phone, '[ALERT_META_SEND_FAIL] Fallback enviado após 2 falhas — estado NÃO avançado', { nodeId: node.id });
          alertCounters.mediaFailures++;
        } catch (fallbackSendErr: any) {
          logBotEvent('error', phone, '[ALERT_META_SEND_FAIL] Falha ao enviar fallback após 2 tentativas', { error: fallbackSendErr.message });
        }
      }
    }

    if (cswResultHolder.value === 'fallback_skip') {
      logBotEvent('info', phone, 'CSW fallback: skip — nó pulado silenciosamente', { nodeId: node.id });
      return { success: true, cswAction: 'skip' };
    }

    if (cswResultHolder.value === 'fallback_end') {
      logBotEvent('info', phone, 'CSW fallback: end — encerrando conversa', { nodeId: node.id });
      return { success: true, cswAction: 'end' };
    }

    const messageTypeForLog = cswResultHolder.value === 'fallback_text' ? 'text' : (msgType === 'buttons' || msgType === 'list' ? 'interactive' : msgType);

    await wabaStorage.createMessage({
      conversationId: convoId,
      direction: 'outbound',
      body: messageText || (msgType === 'image_template' ? '📷 Imagem Personalizada' : `[${msgType}]`),
      type: messageTypeForLog,
      mediaUrl: node.mediaUrl || undefined,
      status: sendSuccess ? 'sent' : 'failed',
    });

    return sendSuccess ? { success: true } : { success: false, error: errorMsg };
  }

  private async sendAudioWithRetry(
    phoneNumberId: string,
    phone: string,
    audioUrl: string,
    accessToken: string,
    maxRetries: number = 3
  ): Promise<void> {
    return sendAudioWithRetry(phoneNumberId, phone, audioUrl, accessToken, maxRetries, true);
  }

  private async getLeadData(phone: string): Promise<Record<string, string>> {
    const normalizedPhone = phone.replace(/\D/g, '');
    try {
      const [lead] = await db.select().from(leads)
        .where(eq(leads.phone, normalizedPhone));

      if (lead) {
        return {
          nome: lead.name || '',
          name: lead.name || '',
          cpf: lead.cpf || '',
          email: lead.email || '',
          endereco: lead.endereco || '',
          produto: lead.produto || '',
          valor: lead.valor || '',
          codigo_rastreio: lead.codigoRastreio || '',
          codigorastreio: lead.codigoRastreio || '',
          phone: lead.phone || '',
          telefone: lead.phone || '',
        };
      }
    } catch (err: any) {
      logBotEvent('error', phone, 'getLeadData: erro ao consultar lead no banco', {
        op: 'getLeadData',
        phone: normalizedPhone,
        error: err.message,
        stack: err.stack,
      });
    }
    return { phone: normalizedPhone, telefone: normalizedPhone };
  }

  async getTimedOutStates(batchSize: number = 50): Promise<Array<{
    state: BotConversationState;
    node: BotFlowNode;
  }>> {
    const activeStates = await db.select().from(botConversationStates)
      .where(eq(botConversationStates.status, 'active'))
      .limit(batchSize);

    const results: Array<{ state: BotConversationState; node: BotFlowNode }> = [];

    for (const state of activeStates) {
      if (!state.currentNodeId) continue;

      const [node] = await db.select().from(botFlowNodes)
        .where(eq(botFlowNodes.id, state.currentNodeId));

      if (!node || !node.timeoutMinutes) continue;

      const lastActivity = state.lastActivityAt || state.startedAt || state.createdAt;
      if (!lastActivity) continue;

      const timeoutAt = new Date(new Date(lastActivity).getTime() + node.timeoutMinutes * 60 * 1000);
      if (new Date() > timeoutAt) {
        results.push({ state, node });
      }
    }

    return results;
  }

  async handleTimeout(
    state: BotConversationState,
    node: BotFlowNode,
    phoneNumberId: string,
    accessToken: string,
    convoId: string
  ): Promise<void> {
    const action = node.timeoutAction || 'end';

    if (action === 'reminder' && node.timeoutMessage) {
      const vars = (state.variables as Record<string, string>) || {};
      const reminderKey = `_reminder_sent_${node.id}`;
      if (vars[reminderKey]) {
        await db.update(botConversationStates).set({
          status: 'timed_out',
          completedAt: new Date(),
        }).where(eq(botConversationStates.id, state.id));
        return;
      }

      const isOpen = await cswTracker.isCSWOpen(state.phone);
      if (!isOpen) {
        logBotEvent('warn', state.phone, 'CSW fechada no timeout, marcando paused_csw');
        await db.update(botConversationStates).set({
          status: 'paused_csw',
          completedAt: new Date(),
        }).where(eq(botConversationStates.id, state.id));
        return;
      }

      const leadData = await this.getLeadData(state.phone);
      const allVars = { ...leadData, ...vars };
      const reminderText = replaceVariables(node.timeoutMessage, allVars);

      try {
        await withSendQueue(state.phone, () =>
          metaAPI.sendFreeFormMessage(phoneNumberId, state.phone, reminderText, accessToken)
        );
        await wabaStorage.createMessage({
          conversationId: convoId,
          direction: 'outbound',
          body: reminderText,
          type: 'text',
          status: 'sent',
        });
      } catch (err: any) {
        logBotEvent('error', state.phone, 'Erro ao enviar reminder de timeout', { op: 'sendTimeoutReminder', stateId: state.id, error: err.message, stack: err.stack });
      }

      vars[reminderKey] = '1';
      await db.update(botConversationStates).set({
        variables: vars,
        lastActivityAt: new Date(),
      }).where(eq(botConversationStates.id, state.id));
    } else if (action === 'next') {
      let targetNodeId = node.timeoutNextNodeId;

      if (!targetNodeId) {
        targetNodeId = node.defaultNextNodeId;
      }

      if (!targetNodeId) {
        const flowNodes = await this.getFlowNodes(state.flowId);
        const currentIndex = flowNodes.findIndex(n => n.id === node.id);
        if (currentIndex >= 0 && currentIndex < flowNodes.length - 1) {
          targetNodeId = flowNodes[currentIndex + 1].id;
        }
      }

      if (targetNodeId) {
        const [nextNode] = await db.select().from(botFlowNodes)
          .where(eq(botFlowNodes.id, targetNodeId));

        if (nextNode) {
          const result = await this.sendNodeMessage(nextNode, state.phone, phoneNumberId, accessToken, convoId, state);
          if (!result.success) {
            logBotEvent('error', state.phone, 'Falha ao enviar mensagem no timeout, estado NÃO avançado', { error: result.error });
            return;
          }
        }

        if (nextNode && nextNode.nodeType === 'end') {
          await db.transaction(async (tx) => {
            await tx.update(botConversationStates).set({
              currentNodeId: targetNodeId!,
              status: 'completed',
              completedAt: new Date(),
            }).where(eq(botConversationStates.id, state.id));
          });
        } else {
          await db.transaction(async (tx) => {
            await tx.update(botConversationStates).set({
              currentNodeId: targetNodeId!,
              lastActivityAt: new Date(),
            }).where(eq(botConversationStates.id, state.id));
          });
        }
      } else {
        await db.update(botConversationStates).set({
          status: 'timed_out',
          completedAt: new Date(),
        }).where(eq(botConversationStates.id, state.id));
      }
    } else {
      await db.update(botConversationStates).set({
        status: 'timed_out',
        completedAt: new Date(),
      }).where(eq(botConversationStates.id, state.id));
    }
  }

  async migrateAutomationRulesToFlow(campaignId: string): Promise<BotFlow | null> {
    const [existingFlow] = await db.select().from(botFlows)
      .where(eq(botFlows.campaignId, campaignId));
    if (existingFlow) return existingFlow;

    const rules = await db.select().from(campaignAutomationRules)
      .where(and(
        eq(campaignAutomationRules.campaignId, campaignId),
        eq(campaignAutomationRules.isActive, true)
      ))
      .orderBy(asc(campaignAutomationRules.priority));

    if (rules.length === 0) return null;

    const [flow] = await db.insert(botFlows).values({
      campaignId,
      name: "Fluxo migrado (regras automaticas)",
      isActive: false,
      version: 1,
    }).returning();

    const startNodeId = crypto.randomUUID();
    const endNodeId = crypto.randomUUID();

    const [startNode] = await db.insert(botFlowNodes).values({
      flowId: flow.id,
      nodeType: 'start',
      sortOrder: 0,
      label: 'Inicio',
      messageContent: null,
      messageType: 'text',
      conditions: rules.map((rule, idx) => ({
        id: `migrated_${idx}`,
        matchType: 'keyword' as const,
        matchValue: rule.keyword,
        nextNodeId: `rule_node_${idx}`,
      })),
      defaultNextNodeId: endNodeId,
      delaySeconds: 1,
    }).returning();

    const ruleNodeIds: Record<string, string> = {};

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      const [ruleNode] = await db.insert(botFlowNodes).values({
        flowId: flow.id,
        nodeType: 'end',
        sortOrder: i + 1,
        label: `Resposta: ${rule.keyword}`,
        messageContent: rule.response,
        messageType: rule.responseType || 'text',
        mediaUrl: rule.mediaUrl || null,
        buttonPayload: rule.buttonPayload || null,
        conditions: [],
        defaultNextNodeId: null,
        delaySeconds: 3,
      }).returning();
      ruleNodeIds[`rule_node_${i}`] = ruleNode.id;
    }

    const [endNode] = await db.insert(botFlowNodes).values({
      flowId: flow.id,
      nodeType: 'end',
      sortOrder: rules.length + 1,
      label: 'Fim',
      messageContent: null,
      messageType: 'text',
      conditions: [],
      defaultNextNodeId: null,
      delaySeconds: 1,
    }).returning();

    const mappedConditions = (startNode.conditions as BotNodeCondition[]).map(c => ({
      ...c,
      nextNodeId: ruleNodeIds[c.nextNodeId] || c.nextNodeId,
    }));

    await db.update(botFlowNodes).set({
      conditions: mappedConditions,
      defaultNextNodeId: endNode.id,
    }).where(eq(botFlowNodes.id, startNode.id));

    return flow;
  }
}

export const botFlowEngine = new BotFlowEngine();
