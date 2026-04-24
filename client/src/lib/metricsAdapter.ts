import type {
  GlobalCampaignMetrics,
  PhoneMetrics,
  SimplifiedIndicators,
  HealthIndicator,
  SpeedIndicator,
  RiskIndicator,
} from '@/hooks/useCampaignMetrics';

const devLog = (...args: any[]) => {
  if (import.meta.env.DEV) console.debug('[MetricsAdapter]', ...args);
};

function safeNum(val: any, defaultVal: number): number {
  if (val === null || val === undefined) return defaultVal;
  const n = Number(val);
  if (Number.isNaN(n) || !Number.isFinite(n)) return defaultVal;
  return n;
}

export type CampaignState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'PAUSED'
  | 'BLOCKED'
  | 'TOKEN_EXPIRED';

export interface NormalizedMetrics {
  campaignId: string;
  state: string;
  currentMsgPerSec: number;
  peakMsgPerSec: number;
  avgMsgPerSec: number;
  totalProcessed: number;
  totalSuccess: number;
  totalFailed: number;
  totalLeads: number;
  progressPercent: number;
  eta: {
    remainingSeconds: number;
    estimatedCompletion: string;
    confidenceLevel: 'high' | 'medium' | 'low';
  };
  latency: {
    p50: number;
    p95: number;
    p99: number;
    avg: number;
    trend: 'increasing' | 'stable' | 'decreasing';
  };
  errors: {
    total: number;
    rateLimitErrors: number;
    payloadErrors: number;
    networkErrors: number;
    authErrors: number;
    environmentErrors: number;
    templateErrors: number;
    timeoutErrors: number;
  };
  metaBlockedCount: number;
  preflightErrors: number;
  environmentStatus: 'ok' | 'blocked' | 'unknown';
  safeModeActive: boolean;
  pauseActive: boolean;
  failSafeActive: boolean;
  healthState: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  burstPhase: string;
  detectedTier: string;
  indicators: SimplifiedIndicators;
}

export interface NormalizedPhoneMetrics {
  phoneNumberId: string;
  displayPhone: string;
  qualityRating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  tier: string;
  healthState: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  circuitState: 'closed' | 'open' | 'half_open';
  safeModeActive: boolean;
  currentRate: number;
  messagesSent: number;
  messagesSuccess: number;
  messagesFailed: number;
  pendingQueue: number;
  rttAvg: number;
  rttP95: number;
}

const DEFAULT_ETA: NormalizedMetrics['eta'] = {
  remainingSeconds: 0,
  estimatedCompletion: '',
  confidenceLevel: 'low',
};

const DEFAULT_LATENCY: NormalizedMetrics['latency'] = {
  p50: 0,
  p95: 0,
  p99: 0,
  avg: 0,
  trend: 'stable',
};

const DEFAULT_ERRORS: NormalizedMetrics['errors'] = {
  total: 0,
  rateLimitErrors: 0,
  payloadErrors: 0,
  networkErrors: 0,
  authErrors: 0,
  environmentErrors: 0,
  templateErrors: 0,
  timeoutErrors: 0,
};

const DEFAULT_INDICATORS: SimplifiedIndicators = {
  health: 'GREEN',
  speed: 'NORMAL',
  risk: 'LOW',
  healthReason: '',
  speedReason: '',
  riskReason: '',
};

const DEFAULT_METRICS: NormalizedMetrics = {
  campaignId: '',
  state: 'IDLE',
  currentMsgPerSec: 0,
  peakMsgPerSec: 0,
  avgMsgPerSec: 0,
  totalProcessed: 0,
  totalSuccess: 0,
  totalFailed: 0,
  totalLeads: 0,
  progressPercent: 0,
  eta: { ...DEFAULT_ETA },
  latency: { ...DEFAULT_LATENCY },
  errors: { ...DEFAULT_ERRORS },
  metaBlockedCount: 0,
  preflightErrors: 0,
  environmentStatus: 'unknown',
  safeModeActive: false,
  pauseActive: false,
  failSafeActive: false,
  healthState: 'HEALTHY',
  burstPhase: '',
  detectedTier: '',
  indicators: { ...DEFAULT_INDICATORS },
};

export function normalizeMetrics(raw: any): NormalizedMetrics {
  if (!raw) {
    devLog('normalizeMetrics called with null/undefined, returning defaults');
    return { ...DEFAULT_METRICS, eta: { ...DEFAULT_ETA }, latency: { ...DEFAULT_LATENCY }, errors: { ...DEFAULT_ERRORS }, indicators: { ...DEFAULT_INDICATORS } };
  }

  const rawEta = raw.eta || {};
  const rawLatency = raw.latency || {};
  const rawErrors = raw.errors || {};
  const rawIndicators = raw.indicators || {};

  const progressRaw = safeNum(raw.progressPercent, 0);
  const progressPercent = Math.min(100, Math.max(0, progressRaw));

  if (progressRaw !== progressPercent) {
    devLog('progressPercent clamped', progressRaw, '->', progressPercent);
  }

  const validTrends = ['increasing', 'stable', 'decreasing'] as const;
  const latencyTrend = validTrends.includes(rawLatency.trend) ? rawLatency.trend : 'stable';

  const validConfidence = ['high', 'medium', 'low'] as const;
  const confidence = validConfidence.includes(rawEta.confidenceLevel) ? rawEta.confidenceLevel : 'low';

  const validEnvStatus = ['ok', 'blocked', 'unknown'] as const;
  const envStatus = validEnvStatus.includes(raw.environmentStatus) ? raw.environmentStatus : 'unknown';

  const validHealthState = ['HEALTHY', 'DEGRADED', 'CRITICAL'] as const;
  const healthState = validHealthState.includes(raw.healthState) ? raw.healthState : 'HEALTHY';

  const validQuality: HealthIndicator[] = ['GREEN', 'YELLOW', 'RED'];
  const validSpeed: SpeedIndicator[] = ['FAST', 'NORMAL', 'SLOW'];
  const validRisk: RiskIndicator[] = ['LOW', 'MEDIUM', 'HIGH'];

  return {
    campaignId: String(raw.campaignId ?? ''),
    state: String(raw.state ?? 'IDLE'),
    currentMsgPerSec: safeNum(raw.currentMsgPerSec, 0),
    peakMsgPerSec: safeNum(raw.peakMsgPerSec, 0),
    avgMsgPerSec: safeNum(raw.avgMsgPerSec, 0),
    totalProcessed: safeNum(raw.totalProcessed, 0),
    totalSuccess: safeNum(raw.totalSuccess, 0),
    totalFailed: safeNum(raw.totalFailed, 0),
    totalLeads: safeNum(raw.totalLeads, 0),
    progressPercent,
    eta: {
      remainingSeconds: safeNum(rawEta.remainingSeconds, 0),
      estimatedCompletion: String(rawEta.estimatedCompletion ?? ''),
      confidenceLevel: confidence,
    },
    latency: {
      p50: safeNum(rawLatency.p50, 0),
      p95: safeNum(rawLatency.p95, 0),
      p99: safeNum(rawLatency.p99, 0),
      avg: safeNum(rawLatency.avg, 0),
      trend: latencyTrend,
    },
    errors: {
      total: safeNum(rawErrors.total, 0),
      rateLimitErrors: safeNum(rawErrors.rateLimitErrors, 0),
      payloadErrors: safeNum(rawErrors.payloadErrors, 0),
      networkErrors: safeNum(rawErrors.networkErrors, 0),
      authErrors: safeNum(rawErrors.authErrors, 0),
      environmentErrors: safeNum(rawErrors.environmentErrors, 0),
      templateErrors: safeNum(rawErrors.templateErrors, 0),
      timeoutErrors: safeNum(rawErrors.timeoutErrors, 0),
    },
    metaBlockedCount: safeNum(raw.metaBlockedCount, 0),
    preflightErrors: safeNum(raw.preflightErrors, 0),
    environmentStatus: envStatus,
    safeModeActive: Boolean(raw.safeModeActive),
    pauseActive: Boolean(raw.pauseActive),
    failSafeActive: Boolean(raw.failSafeActive),
    healthState,
    burstPhase: String(raw.burstPhase ?? ''),
    detectedTier: String(raw.detectedTier ?? ''),
    indicators: {
      health: validQuality.includes(rawIndicators.health) ? rawIndicators.health : 'GREEN',
      speed: validSpeed.includes(rawIndicators.speed) ? rawIndicators.speed : 'NORMAL',
      risk: validRisk.includes(rawIndicators.risk) ? rawIndicators.risk : 'LOW',
      healthReason: String(rawIndicators.healthReason ?? ''),
      speedReason: String(rawIndicators.speedReason ?? ''),
      riskReason: String(rawIndicators.riskReason ?? ''),
    },
  };
}

export function normalizePhoneMetrics(raw: any[]): NormalizedPhoneMetrics[] {
  if (!Array.isArray(raw)) {
    devLog('normalizePhoneMetrics called with non-array, returning []');
    return [];
  }

  return raw.map((item): NormalizedPhoneMetrics => {
    if (!item) {
      return {
        phoneNumberId: '',
        displayPhone: '',
        qualityRating: 'UNKNOWN',
        tier: '',
        healthState: 'HEALTHY',
        circuitState: 'closed',
        safeModeActive: false,
        currentRate: 0,
        messagesSent: 0,
        messagesSuccess: 0,
        messagesFailed: 0,
        pendingQueue: 0,
        rttAvg: 0,
        rttP95: 0,
      };
    }

    const validQR = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'] as const;
    const validHS = ['HEALTHY', 'DEGRADED', 'CRITICAL'] as const;
    const validCS = ['closed', 'open', 'half_open'] as const;

    return {
      phoneNumberId: String(item.phoneNumberId ?? ''),
      displayPhone: String(item.displayPhone ?? ''),
      qualityRating: validQR.includes(item.qualityRating) ? item.qualityRating : 'UNKNOWN',
      tier: String(item.tier ?? ''),
      healthState: validHS.includes(item.healthState) ? item.healthState : 'HEALTHY',
      circuitState: validCS.includes(item.circuitState) ? item.circuitState : 'closed',
      safeModeActive: Boolean(item.safeModeActive),
      currentRate: safeNum(item.currentRate, 0),
      messagesSent: safeNum(item.messagesSent, 0),
      messagesSuccess: safeNum(item.messagesSuccess, 0),
      messagesFailed: safeNum(item.messagesFailed, 0),
      pendingQueue: safeNum(item.pendingQueue, 0),
      rttAvg: safeNum(item.rttAvg, 0),
      rttP95: safeNum(item.rttP95, 0),
    };
  });
}

const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'FAILED_GRACEFULLY', 'FINALIZING'];

export function monotonicMerge(
  prev: NormalizedMetrics,
  next: NormalizedMetrics,
): NormalizedMetrics {
  const isTerminal = TERMINAL_STATES.includes(next.state);

  const monotonicMax = (field: keyof NormalizedMetrics, p: number, n: number): number => {
    if (isTerminal) return n;
    if (n < p) {
      devLog(`monotonic violation: ${String(field)} decreased from ${p} to ${n}, keeping ${p}`);
      return p;
    }
    return n;
  };

  const mergedErrorsTotal = isTerminal
    ? next.errors.total
    : Math.max(prev.errors.total, next.errors.total);

  if (!isTerminal && next.errors.total < prev.errors.total) {
    devLog('monotonic violation: errors.total decreased from', prev.errors.total, 'to', next.errors.total);
  }

  return {
    ...next,
    totalProcessed: monotonicMax('totalProcessed', prev.totalProcessed, next.totalProcessed),
    totalSuccess: monotonicMax('totalSuccess', prev.totalSuccess, next.totalSuccess),
    totalFailed: monotonicMax('totalFailed', prev.totalFailed, next.totalFailed),
    totalLeads: monotonicMax('totalLeads', prev.totalLeads, next.totalLeads),
    progressPercent: monotonicMax('progressPercent', prev.progressPercent, next.progressPercent),
    metaBlockedCount: isTerminal
      ? next.metaBlockedCount
      : Math.max(prev.metaBlockedCount, next.metaBlockedCount),
    errors: {
      ...next.errors,
      total: mergedErrorsTotal,
    },
  };
}

export function deriveCampaignState(
  metrics: NormalizedMetrics | null,
  connected: boolean,
  hasTimedOut: boolean,
): CampaignState {
  if (!metrics) {
    if (!connected && hasTimedOut) return 'IDLE';
    return 'IDLE';
  }

  const state = metrics.state.toUpperCase();

  if (metrics.errors.authErrors > 0) return 'TOKEN_EXPIRED';

  if (state === 'COMPLETED' || state === 'FINALIZING') return 'COMPLETED';
  if (state === 'FAILED' || state === 'FAILED_GRACEFULLY') return 'FAILED';

  if (state === 'BLOCKED_BY_META' || state === 'BLOCKED') return 'BLOCKED';
  if (metrics.environmentStatus === 'blocked' && metrics.totalSuccess === 0 && metrics.totalProcessed > 0) return 'BLOCKED';

  if (metrics.pauseActive || state === 'PAUSED') return 'PAUSED';

  if (
    state === 'RUNNING' ||
    state === 'SENDING' ||
    state === 'SAFE_MODE' ||
    state === 'WARMING_UP' ||
    state === 'BURST'
  ) {
    return 'RUNNING';
  }

  if (metrics.totalProcessed > 0) return 'RUNNING';

  return 'IDLE';
}
