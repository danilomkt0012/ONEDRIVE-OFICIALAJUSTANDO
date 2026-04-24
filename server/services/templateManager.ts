import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES_DIR = path.resolve(__dirname, "../../uploads/templates");
const FALLBACK_TEMPLATES = [
  path.resolve(__dirname, "../../attached_assets/DIRPF_TEMPLATE.png"),
  path.resolve(__dirname, "../../attached_assets/FOTO_PRODUTO_CORREIOS_1774527170319.jpg"),
];

export type TemplateImageType = "dirpf" | "correios" | "auto";

export interface TemplateInfo {
  filePath: string;
  filename: string;
  imageType: TemplateImageType;
}

export interface TemplateIntelligenceStats {
  templateName: string;
  sent: number;
  replies: number;
  blocked: number;
  ctr: number;
  blockRate: number;
  score: number;
  needsRotation: boolean;
  lastUpdated: number;
}

const SCORE_LOW_THRESHOLD = 0.4;
const BLOCK_RATE_HIGH_THRESHOLD = 0.15;

let lastUsedIndex: number = -1;
const usageCount = new Map<string, number>();
const performanceScores = new Map<string, number>();

interface TemplateMetricsEntry {
  sent: number;
  replies: number;
  blocked: number;
  lastUpdated: number;
}

const templateMetrics = new Map<string, TemplateMetricsEntry>();

/**
 * campaignTemplateMap: fallback for campaigns using a single template
 * Maps campaignId → templateName when only one template is active.
 */
const campaignTemplateMap = new Map<string, string>();

/**
 * messageTemplateMap: accurate per-message attribution
 * Maps metaMessageId (wamid) → templateName so that webhook events
 * (replies, delivery updates) can always identify the correct template,
 * even when a campaign rotates templates mid-run.
 * Capped at 200k entries to prevent unbounded memory growth.
 */
const messageTemplateMap = new Map<string, string>();
const MESSAGE_MAP_MAX_SIZE = 200_000;

export function setCampaignTemplate(campaignId: string, templateName: string): void {
  campaignTemplateMap.set(campaignId, templateName);
}

export function getCampaignTemplate(campaignId: string): string | undefined {
  return campaignTemplateMap.get(campaignId);
}

export function clearCampaignTemplate(campaignId: string): void {
  campaignTemplateMap.delete(campaignId);
}

/**
 * Record a message→template mapping at send time.
 * Call this after a successful API send when you have the metaMessageId (wamid).
 */
export function registerMessageTemplate(metaMessageId: string, templateName: string): void {
  if (messageTemplateMap.size >= MESSAGE_MAP_MAX_SIZE) {
    const firstKey = messageTemplateMap.keys().next().value;
    if (firstKey !== undefined) messageTemplateMap.delete(firstKey);
  }
  messageTemplateMap.set(metaMessageId, templateName);
}

/**
 * Attribution precedence: per-message wamid first, then campaign-level fallback.
 */
export function recordTemplateReplyByMessageId(metaMessageId: string, campaignId?: string): void {
  const templateName = messageTemplateMap.get(metaMessageId)
    ?? (campaignId ? campaignTemplateMap.get(campaignId) : undefined);
  if (templateName) {
    recordTemplateReply(templateName);
  }
}

/** Legacy campaign-level fallback (used when no wamid is available) */
export function recordTemplateReplyByCampaign(campaignId: string): void {
  const templateName = campaignTemplateMap.get(campaignId);
  if (templateName) {
    recordTemplateReply(templateName);
  }
}

function getOrCreateMetrics(templateName: string): TemplateMetricsEntry {
  let m = templateMetrics.get(templateName);
  if (!m) {
    m = { sent: 0, replies: 0, blocked: 0, lastUpdated: Date.now() };
    templateMetrics.set(templateName, m);
  }
  return m;
}

export function recordTemplateSent(templateName: string): void {
  const m = getOrCreateMetrics(templateName);
  m.sent++;
  m.lastUpdated = Date.now();
}

export function recordTemplateReply(templateName: string): void {
  const m = getOrCreateMetrics(templateName);
  m.replies++;
  m.lastUpdated = Date.now();
}

export function recordTemplateBlocked(templateName: string): void {
  const m = getOrCreateMetrics(templateName);
  m.blocked++;
  m.lastUpdated = Date.now();
}

function computeTemplateScore(sent: number, replies: number, blocked: number): number {
  if (sent === 0) return 1.0;
  const ctr = replies / sent;
  const blockRate = blocked / sent;
  return Math.max(0, Math.min(1, (ctr * 0.5) + (1 - blockRate) * 0.5));
}

export function getTemplateIntelligence(templateName: string): TemplateIntelligenceStats {
  const m = templateMetrics.get(templateName) || { sent: 0, replies: 0, blocked: 0, lastUpdated: Date.now() };
  const ctr = m.sent > 0 ? m.replies / m.sent : 0;
  const blockRate = m.sent > 0 ? m.blocked / m.sent : 0;
  const score = computeTemplateScore(m.sent, m.replies, m.blocked);
  return {
    templateName,
    sent: m.sent,
    replies: m.replies,
    blocked: m.blocked,
    ctr,
    blockRate,
    score,
    needsRotation: score < SCORE_LOW_THRESHOLD || blockRate > BLOCK_RATE_HIGH_THRESHOLD,
    lastUpdated: m.lastUpdated,
  };
}

export function getAllTemplateIntelligence(): TemplateIntelligenceStats[] {
  const result: TemplateIntelligenceStats[] = [];
  for (const [name] of templateMetrics) {
    result.push(getTemplateIntelligence(name));
  }
  result.sort((a, b) => a.score - b.score);
  return result;
}

function detectImageType(filename: string): TemplateImageType {
  const lower = filename.toLowerCase();
  if (lower.includes("dirpf") || lower.includes("template1")) return "dirpf";
  if (lower.includes("correios") || lower.includes("template2")) return "correios";
  return "auto";
}

export function loadTemplates(): TemplateInfo[] {
  const templates: TemplateInfo[] = [];

  try {
    if (fs.existsSync(TEMPLATES_DIR)) {
      const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) && !f.startsWith(".");
      });

      for (const file of files) {
        templates.push({
          filePath: path.join(TEMPLATES_DIR, file),
          filename: file,
          imageType: detectImageType(file),
        });
      }
    }
  } catch (dirErr: any) {
    console.warn(`[templateManager] Templates dir not accessible: ${dirErr.message}`);
  }

  if (templates.length === 0) {
    for (const fp of FALLBACK_TEMPLATES) {
      try {
        if (fs.existsSync(fp)) {
          templates.push({
            filePath: fp,
            filename: path.basename(fp),
            imageType: detectImageType(fp),
          });
        }
      } catch (fbErr: any) {
        console.warn(`[templateManager] Fallback template inaccessible: ${fp} — ${fbErr.message}`);
      }
    }
  }

  return templates;
}

export async function loadTemplatesAsync(): Promise<TemplateInfo[]> {
  const templates: TemplateInfo[] = [];

  try {
    await fs.promises.access(TEMPLATES_DIR);
    const files = await fs.promises.readdir(TEMPLATES_DIR);
    const imageFiles = files.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return [".png", ".jpg", ".jpeg", ".webp"].includes(ext) && !f.startsWith(".");
    });

    for (const file of imageFiles) {
      templates.push({
        filePath: path.join(TEMPLATES_DIR, file),
        filename: file,
        imageType: detectImageType(file),
      });
    }
  } catch (dirErr: any) {
    console.warn(`[templateManager] Templates dir not accessible (async): ${dirErr.message}`);
  }

  if (templates.length === 0) {
    for (const fp of FALLBACK_TEMPLATES) {
      try {
        await fs.promises.access(fp);
        templates.push({
          filePath: fp,
          filename: path.basename(fp),
          imageType: detectImageType(fp),
        });
      } catch (fbErr: any) {
        console.warn(`[templateManager] Fallback inaccessible (async): ${fp} — ${fbErr.message}`);
      }
    }
  }

  return templates;
}

export function updateTemplatePerformance(templateName: string, score: number): void {
  performanceScores.set(templateName, Math.max(0.1, Math.min(2.0, score)));
}

export function getTemplatePerformance(templateName: string): number {
  return performanceScores.get(templateName) ?? 1.0;
}

export function getRandomTemplate(templates?: TemplateInfo[]): TemplateInfo {
  const pool = templates ?? loadTemplates();

  if (pool.length === 0) {
    throw new Error("Nenhum template disponível em uploads/templates/");
  }

  if (pool.length === 1) {
    usageCount.set(pool[0].filename, (usageCount.get(pool[0].filename) ?? 0) + 1);
    return pool[0];
  }

  const candidates = pool.filter((_, i) => i !== lastUsedIndex);

  const weights: number[] = candidates.map(c => {
    const usage = usageCount.get(c.filename) ?? 0;
    const perfScore = performanceScores.get(c.filename) ?? 1.0;
    const usageWeight = 1 / (1 + usage);
    return usageWeight * perfScore;
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) {
    const chosen = candidates[0];
    const chosenIndex = pool.findIndex((t) => t.filename === chosen.filename);
    lastUsedIndex = chosenIndex;
    usageCount.set(chosen.filename, (usageCount.get(chosen.filename) ?? 0) + 1);
    return chosen;
  }

  let random = (crypto.randomInt(0, 1000000) / 1000000) * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      const chosen = candidates[i];
      const chosenIndex = pool.findIndex((t) => t.filename === chosen.filename);
      lastUsedIndex = chosenIndex;
      usageCount.set(chosen.filename, (usageCount.get(chosen.filename) ?? 0) + 1);
      return chosen;
    }
  }

  const chosen = candidates[0];
  const chosenIndex = pool.findIndex((t) => t.filename === chosen.filename);
  lastUsedIndex = chosenIndex;
  usageCount.set(chosen.filename, (usageCount.get(chosen.filename) ?? 0) + 1);
  return chosen;
}

export function getTemplateStats(): Record<string, number> {
  return Object.fromEntries(usageCount);
}
