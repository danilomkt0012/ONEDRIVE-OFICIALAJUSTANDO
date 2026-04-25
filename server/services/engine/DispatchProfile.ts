/**
 * ============================================================================
 * PERFIS DE DISPARO (3 modos)
 * ============================================================================
 *
 * Define presets de comportamento do motor para cada modo escolhido pelo usuário.
 * Cada modo entrega 2k mensagens em ≤40 minutos com 5 números, com diferentes
 * trade-offs entre velocidade e variabilidade humana.
 *
 * NENHUM modo pausa por queda de qualidade — apenas redistribui pesos.
 */

export type DispatchMode = 'seguro' | 'equilibrado' | 'turbo';

export interface DispatchProfile {
  mode: DispatchMode;
  label: string;
  description: string;
  // Velocidade — token bucket (msgs/segundo POR número)
  refillRatePerNumber: number;
  maxConcurrentPerNumber: number;
  // Atrasos humanos (ms)
  baseDelayMeanMs: number;
  baseDelayStdDevMs: number;
  baseDelayMinMs: number;
  baseDelayMaxMs: number;
  // Pausas longas
  longPauseMinMs: number;
  longPauseMaxMs: number;
  longPauseEveryMin: number;
  longPauseEveryMax: number;
  cyclePauseMinMs: number;
  cyclePauseMaxMs: number;
  cyclePauseEveryMin: number;
  cyclePauseEveryMax: number;
  // Comportamento
  microBatchSize: number;
  enableMicroBatching: boolean;
  // Política de qualidade — NUNCA pausa, apenas reduz peso
  autoPauseOnRedRating: false;
  reduceWeightOnYellow: number; // 0.5 = -50%
  reduceWeightOnRed: number;    // 0.2 = -80% (mas continua enviando)
  // Frequency cap por destinatário (msgs/24h)
  maxMessagesPerRecipient24h: number;
}

export const DISPATCH_PROFILES: Record<DispatchMode, DispatchProfile> = {
  seguro: {
    mode: 'seguro',
    label: 'Seguro',
    description: '2k em ~33min · pausas humanas mais longas · menor risco',
    refillRatePerNumber: 0.6,
    maxConcurrentPerNumber: 2,
    baseDelayMeanMs: 4500,
    baseDelayStdDevMs: 1000,
    baseDelayMinMs: 2500,
    baseDelayMaxMs: 7000,
    longPauseMinMs: 6000,
    longPauseMaxMs: 12000,
    longPauseEveryMin: 60,
    longPauseEveryMax: 90,
    cyclePauseMinMs: 15000,
    cyclePauseMaxMs: 35000,
    cyclePauseEveryMin: 350,
    cyclePauseEveryMax: 500,
    microBatchSize: 25,
    enableMicroBatching: true,
    autoPauseOnRedRating: false,
    reduceWeightOnYellow: 0.7,
    reduceWeightOnRed: 0.3,
    maxMessagesPerRecipient24h: 1,
  },
  equilibrado: {
    mode: 'equilibrado',
    label: 'Equilibrado',
    description: '2k em ~28min · padrão recomendado · velocidade + segurança',
    refillRatePerNumber: 0.85,
    maxConcurrentPerNumber: 3,
    baseDelayMeanMs: 3500,
    baseDelayStdDevMs: 900,
    baseDelayMinMs: 1800,
    baseDelayMaxMs: 6000,
    longPauseMinMs: 4000,
    longPauseMaxMs: 9000,
    longPauseEveryMin: 80,
    longPauseEveryMax: 120,
    cyclePauseMinMs: 10000,
    cyclePauseMaxMs: 25000,
    cyclePauseEveryMin: 400,
    cyclePauseEveryMax: 600,
    microBatchSize: 50,
    enableMicroBatching: true,
    autoPauseOnRedRating: false,
    reduceWeightOnYellow: 0.6,
    reduceWeightOnRed: 0.25,
    maxMessagesPerRecipient24h: 2,
  },
  turbo: {
    mode: 'turbo',
    label: 'Turbo',
    description: '2k em ~22min · velocidade máxima · sem pausa por qualidade',
    refillRatePerNumber: 1.2,
    maxConcurrentPerNumber: 4,
    baseDelayMeanMs: 2200,
    baseDelayStdDevMs: 700,
    baseDelayMinMs: 1100,
    baseDelayMaxMs: 4500,
    longPauseMinMs: 2500,
    longPauseMaxMs: 6000,
    longPauseEveryMin: 120,
    longPauseEveryMax: 180,
    cyclePauseMinMs: 6000,
    cyclePauseMaxMs: 15000,
    cyclePauseEveryMin: 600,
    cyclePauseEveryMax: 900,
    microBatchSize: 75,
    enableMicroBatching: false,
    autoPauseOnRedRating: false,
    reduceWeightOnYellow: 0.5,
    reduceWeightOnRed: 0.2,
    maxMessagesPerRecipient24h: 2,
  },
};

export function getDispatchProfile(mode?: string | null): DispatchProfile {
  const m = (mode || 'equilibrado').toLowerCase() as DispatchMode;
  return DISPATCH_PROFILES[m] ?? DISPATCH_PROFILES.equilibrado;
}

/**
 * Calcula ETA estimado em minutos para enviar `totalLeads` com `numberCount` números
 * e o perfil escolhido. Considera concorrência, delays humanos médios e pausas longas.
 */
export function estimateEtaMinutes(
  totalLeads: number,
  numberCount: number,
  mode: DispatchMode | string = 'equilibrado'
): { etaMinutes: number; etaSeconds: number; effectiveRate: number; profile: DispatchProfile } {
  const profile = getDispatchProfile(mode);
  const numbers = Math.max(1, numberCount);

  // Taxa efetiva considera o limite mais conservador entre token bucket e delay médio
  const tokenBucketRate = profile.refillRatePerNumber * numbers;
  const meanDelaySec = profile.baseDelayMeanMs / 1000;
  // Concorrência ajuda a paralelizar dentro de cada número
  const delayBoundedRate = (numbers * profile.maxConcurrentPerNumber) / meanDelaySec;
  // A real é o menor entre os dois
  let effectiveRate = Math.min(tokenBucketRate, delayBoundedRate);

  // Penalidade por pausas longas (estimativa: ~5% do tempo)
  const longPauseFactor = profile.enableMicroBatching ? 1.08 : 1.04;
  effectiveRate = effectiveRate / longPauseFactor;

  const etaSeconds = totalLeads / Math.max(0.1, effectiveRate);
  const etaMinutes = etaSeconds / 60;

  return { etaMinutes, etaSeconds, effectiveRate, profile };
}
