/**
 * ============================================================================
 * ADAPTIVE SCORING — Score de Confiança 0–100 por número
 * ============================================================================
 *
 * Recalcula a cada N envios. Score determina o peso na rotação:
 * - Número novo (sem histórico): score inicial = 30 (entra direto, peso baixo)
 * - Número conhecido: score inicial = 50
 * - Número GREEN com histórico: score inicial = 80
 *
 * Sinais que SOBEM o score:
 *  + delivered rate > 95%   → +10
 *  + read rate > 40%        → +5
 *  + reply recebida          → +15
 *
 * Sinais que DESCEM o score (mas NUNCA pausam):
 *  - delivered rate < 80%   → -15
 *  - erro 131049 detectado  → -10
 *  - quality cai p/ YELLOW  → -10
 *  - quality cai p/ RED     → -25 (continua enviando, peso menor)
 *
 * Distribuição de mensagens é proporcional ao score, com mínimo de 5%
 * para todos (todos sempre recebem alguma msg, ninguém é zerado).
 */

import { db, pool } from '../../db';
import { wabaNumbers, senderScoreHistory } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logError } from '../../utils/logger';

export interface SenderScore {
  phoneNumberId: string;
  score: number;
  samples: number;
  lastUpdated: Date | null;
  qualityRating: string;
}

export interface ScoreSignals {
  sentDelta: number;
  deliveredDelta: number;
  readDelta: number;
  repliedDelta: number;
  errors131049Delta: number;
  errorsOtherDelta: number;
  qualityRating?: string | null;
  previousQuality?: string | null;
}

const RECALC_EVERY_N_SENT = 50;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const MIN_WEIGHT_SHARE = 0.05; // todo número recebe pelo menos 5% das msgs

const cache = new Map<string, SenderScore>();
const sentSinceLastRecalc = new Map<string, number>();

function clamp(n: number, min = SCORE_MIN, max = SCORE_MAX): number {
  return Math.max(min, Math.min(max, n));
}

export function getInitialScore(qualityRating?: string | null, isNew = false): number {
  if (isNew) return 30;
  switch ((qualityRating || '').toUpperCase()) {
    case 'GREEN': return 80;
    case 'YELLOW': return 45;
    case 'RED': return 25;
    case 'UNKNOWN':
    case '':
      return 30;
    default: return 50;
  }
}

export async function getScore(phoneNumberId: string): Promise<SenderScore> {
  const cached = cache.get(phoneNumberId);
  if (cached) return cached;

  try {
    const [row] = await db
      .select({
        score: wabaNumbers.confidenceScore,
        samples: wabaNumbers.scoreSamples,
        updatedAt: wabaNumbers.scoreUpdatedAt,
        quality: wabaNumbers.qualityRating,
      })
      .from(wabaNumbers)
      .where(eq(wabaNumbers.phoneNumberId, phoneNumberId))
      .limit(1);

    if (row) {
      const result: SenderScore = {
        phoneNumberId,
        score: row.score ?? getInitialScore(row.quality, false),
        samples: row.samples ?? 0,
        lastUpdated: row.updatedAt,
        qualityRating: row.quality || 'UNKNOWN',
      };
      cache.set(phoneNumberId, result);
      return result;
    }
  } catch (err) {
    logError('AdaptiveScoring.getScore', { phoneNumberId }, err);
  }

  // Fallback (nunca cai aqui em produção)
  const fallback: SenderScore = {
    phoneNumberId,
    score: 30,
    samples: 0,
    lastUpdated: null,
    qualityRating: 'UNKNOWN',
  };
  cache.set(phoneNumberId, fallback);
  return fallback;
}

export async function getScoresMany(phoneNumberIds: string[]): Promise<Map<string, SenderScore>> {
  const result = new Map<string, SenderScore>();
  await Promise.all(
    phoneNumberIds.map(async (id) => {
      const s = await getScore(id);
      result.set(id, s);
    })
  );
  return result;
}

/**
 * Registra envio (incrementa contador). Retorna true se atingiu janela de recálculo.
 */
export function recordSend(phoneNumberId: string): boolean {
  const cur = (sentSinceLastRecalc.get(phoneNumberId) ?? 0) + 1;
  sentSinceLastRecalc.set(phoneNumberId, cur);
  return cur >= RECALC_EVERY_N_SENT;
}

/**
 * Aplica sinais e recalcula score. Persiste no DB e em histórico.
 */
export async function recalcScore(
  phoneNumberId: string,
  signals: ScoreSignals,
  reason = 'window_recalc'
): Promise<SenderScore> {
  const current = await getScore(phoneNumberId);
  let next = current.score;

  const sent = Math.max(1, signals.sentDelta);
  const deliveredRate = signals.deliveredDelta / sent;
  const readRate = signals.readDelta / sent;
  const errorRate131049 = signals.errors131049Delta / sent;
  const errorRateOther = signals.errorsOtherDelta / sent;

  // Sinais positivos
  if (deliveredRate > 0.95) next += 10;
  else if (deliveredRate > 0.85) next += 4;

  if (readRate > 0.40) next += 5;
  else if (readRate > 0.20) next += 2;

  if (signals.repliedDelta > 0) next += Math.min(15, signals.repliedDelta * 3);

  // Sinais negativos (NUNCA pausa)
  if (deliveredRate < 0.80 && sent >= 10) next -= 15;
  else if (deliveredRate < 0.90 && sent >= 10) next -= 5;

  if (errorRate131049 > 0.02) next -= 10;
  if (errorRateOther > 0.10) next -= 8;

  // Quality rating mudou no meio da janela
  const prev = (signals.previousQuality || '').toUpperCase();
  const cur = (signals.qualityRating || '').toUpperCase();
  if (prev !== cur) {
    if (cur === 'YELLOW') next -= 10;
    else if (cur === 'RED') next -= 25;
    else if (cur === 'GREEN' && (prev === 'YELLOW' || prev === 'RED')) next += 15;
  }

  next = clamp(next);

  const updated: SenderScore = {
    phoneNumberId,
    score: next,
    samples: current.samples + signals.sentDelta,
    lastUpdated: new Date(),
    qualityRating: signals.qualityRating || current.qualityRating,
  };

  cache.set(phoneNumberId, updated);
  sentSinceLastRecalc.set(phoneNumberId, 0);

  try {
    await db
      .update(wabaNumbers)
      .set({
        confidenceScore: next,
        scoreSamples: updated.samples,
        scoreUpdatedAt: new Date(),
      })
      .where(eq(wabaNumbers.phoneNumberId, phoneNumberId));

    await db.insert(senderScoreHistory).values({
      phoneNumberId,
      score: next,
      deliveredRate: Math.round(deliveredRate * 10000),
      errorRate: Math.round((errorRate131049 + errorRateOther) * 10000),
      reason: `${reason}: deliv=${Math.round(deliveredRate * 100)}% reply=${signals.repliedDelta} err=${signals.errors131049Delta + signals.errorsOtherDelta}`,
    });

    console.log(`[AdaptiveScoring] ${phoneNumberId}: ${current.score} → ${next} (${reason})`);
  } catch (err) {
    logError('AdaptiveScoring.recalcScore', { phoneNumberId }, err);
  }

  return updated;
}

/**
 * Calcula pesos de distribuição garantindo mínimo de 5% por número.
 */
export function computeWeights(scores: Map<string, SenderScore>): Map<string, number> {
  const weights = new Map<string, number>();
  const ids = Array.from(scores.keys());
  if (ids.length === 0) return weights;

  let total = 0;
  for (const id of ids) {
    const s = scores.get(id)!;
    const w = Math.max(1, s.score);
    weights.set(id, w);
    total += w;
  }

  if (total <= 0) {
    for (const id of ids) weights.set(id, 1 / ids.length);
    return weights;
  }

  const minShare = MIN_WEIGHT_SHARE;
  const minWeight = total * minShare;
  let totalAfter = 0;

  for (const id of ids) {
    const cur = weights.get(id)!;
    const adj = Math.max(minWeight, cur);
    weights.set(id, adj);
    totalAfter += adj;
  }

  // Normaliza para somar 1
  for (const id of ids) {
    weights.set(id, weights.get(id)! / totalAfter);
  }

  return weights;
}

/**
 * Garante que um número novo tenha um registro inicial em wabaNumbers com score apropriado.
 */
export async function ensureScoreInitialized(
  phoneNumberId: string,
  qualityRating?: string | null
): Promise<void> {
  try {
    const [row] = await db
      .select({ score: wabaNumbers.confidenceScore })
      .from(wabaNumbers)
      .where(eq(wabaNumbers.phoneNumberId, phoneNumberId))
      .limit(1);

    if (row && row.score !== null && row.score !== undefined) return;

    const initial = getInitialScore(qualityRating, !row);
    await db
      .update(wabaNumbers)
      .set({
        confidenceScore: initial,
        scoreUpdatedAt: new Date(),
        scoreSamples: 0,
      })
      .where(eq(wabaNumbers.phoneNumberId, phoneNumberId));
    cache.delete(phoneNumberId);
  } catch (err) {
    logError('AdaptiveScoring.ensureScoreInitialized', { phoneNumberId }, err);
  }
}

export function invalidateCache(phoneNumberId?: string): void {
  if (phoneNumberId) cache.delete(phoneNumberId);
  else cache.clear();
}

/**
 * Retorna saúde resumida de todos os números em uma lista.
 */
export async function getHealthSummary(phoneNumberIds: string[]): Promise<Array<{
  phoneNumberId: string;
  score: number;
  samples: number;
  qualityRating: string;
  weightShare: number;
  status: 'excelente' | 'bom' | 'regular' | 'atencao' | 'critico';
}>> {
  const scores = await getScoresMany(phoneNumberIds);
  const weights = computeWeights(scores);
  return phoneNumberIds.map((id) => {
    const s = scores.get(id)!;
    const w = weights.get(id) ?? 0;
    let status: 'excelente' | 'bom' | 'regular' | 'atencao' | 'critico';
    if (s.score >= 80) status = 'excelente';
    else if (s.score >= 60) status = 'bom';
    else if (s.score >= 40) status = 'regular';
    else if (s.score >= 20) status = 'atencao';
    else status = 'critico';
    return {
      phoneNumberId: id,
      score: s.score,
      samples: s.samples,
      qualityRating: s.qualityRating,
      weightShare: w,
      status,
    };
  });
}
