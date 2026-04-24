import { metricsPublisher, GlobalCampaignMetrics, CampaignEvent } from '../observability/CampaignMetricsPublisher';

export interface ErrorMapEntry {
  code: string;
  count: number;
  lastOccurrence: number;
  lastMessage: string;
  lastPhone?: string;
}

export interface CampaignState {
  campaignId: string;
  totalLeads: number;
  processed: number;
  accepted: number;
  delivered: number;
  read: number;
  failed: number;
  blocked: number;
  retryCount: number;
  preflightFailed: number;
  errorMap: Map<string, ErrorMapEntry>;
  status: 'INIT' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'FINALIZING';
  tier: string;
  speedCurrent: number;
  speedAverage: number;
  speedPeak: number;
  startTime: number;
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
  safeModeActive: boolean;
  circuitState: string;
  healthState: string;
  burstPhase: string;
  concurrency: number;
  rttTarget: number;
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
  environmentStatus: 'ok' | 'blocked' | 'unknown';
  failSafeActive: boolean;
  pauseActive: boolean;
  indicators?: {
    health: 'GREEN' | 'YELLOW' | 'RED';
    speed: 'FAST' | 'NORMAL' | 'SLOW';
    risk: 'LOW' | 'MEDIUM' | 'HIGH';
    healthReason: string;
    speedReason: string;
    riskReason: string;
  };
}

export interface LogEntry {
  timestamp: number;
  type: 'INFO' | 'WARN' | 'ERROR' | 'SEND';
  message: string;
  data?: any;
}

class CampaignStore {
  private campaigns: Map<string, CampaignState> = new Map();
  private logs: Map<string, LogEntry[]> = new Map();
  private static instance: CampaignStore;

  static getInstance(): CampaignStore {
    if (!CampaignStore.instance) {
      CampaignStore.instance = new CampaignStore();
    }
    return CampaignStore.instance;
  }

  init(campaignId: string, totalLeads: number): void {
    const state: CampaignState = {
      campaignId,
      totalLeads,
      processed: 0,
      accepted: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      blocked: 0,
      retryCount: 0,
      preflightFailed: 0,
      errorMap: new Map(),
      status: 'INIT',
      tier: '',
      speedCurrent: 0,
      speedAverage: 0,
      speedPeak: 0,
      startTime: Date.now(),
      eta: { remainingSeconds: 0, estimatedCompletion: new Date().toISOString(), confidenceLevel: 'low' },
      latency: { p50: 0, p95: 0, p99: 0, avg: 0, trend: 'stable' },
      safeModeActive: false,
      circuitState: 'CLOSED',
      healthState: 'HEALTHY',
      burstPhase: 'adaptive',
      concurrency: 0,
      rttTarget: 280,
      errors: { total: 0, rateLimitErrors: 0, payloadErrors: 0, networkErrors: 0, authErrors: 0, environmentErrors: 0, templateErrors: 0, timeoutErrors: 0 },
      metaBlockedCount: 0,
      environmentStatus: 'ok',
      failSafeActive: false,
      pauseActive: false,
    };
    this.campaigns.set(campaignId, state);
    this.logs.set(campaignId, []);
    this.addLog(campaignId, 'INFO', `Campanha ${campaignId} inicializada com ${totalLeads} leads`);
  }

  get(id: string): CampaignState | undefined {
    return this.campaigns.get(id);
  }

  update(id: string, partial: Partial<CampaignState>): void {
    const existing = this.campaigns.get(id);
    if (!existing) return;
    Object.assign(existing, partial);
    this.emitSSE(id);
  }

  increment(id: string, field: 'accepted' | 'delivered' | 'read' | 'failed' | 'blocked' | 'processed' | 'retryCount' | 'preflightFailed', amount: number = 1): void {
    const existing = this.campaigns.get(id);
    if (!existing) return;
    existing[field] += amount;
    this.emitSSE(id);
  }

  updateErrorMap(id: string, errorCode: string, errorMessage: string, phone?: string): void {
    const existing = this.campaigns.get(id);
    if (!existing) return;

    const entry = existing.errorMap.get(errorCode);
    if (entry) {
      entry.count++;
      entry.lastOccurrence = Date.now();
      entry.lastMessage = errorMessage;
      if (phone) entry.lastPhone = phone;
    } else {
      existing.errorMap.set(errorCode, {
        code: errorCode,
        count: 1,
        lastOccurrence: Date.now(),
        lastMessage: errorMessage,
        lastPhone: phone,
      });
    }
  }

  updateFromEngineMetrics(id: string, metrics: GlobalCampaignMetrics): void {
    const existing = this.campaigns.get(id);
    if (!existing) return;

    existing.processed = metrics.totalProcessed;
    existing.accepted = metrics.totalSuccess;
    existing.failed = metrics.totalFailed;
    existing.speedCurrent = metrics.currentMsgPerSec;
    existing.speedAverage = metrics.avgMsgPerSec;
    existing.speedPeak = metrics.peakMsgPerSec;
    existing.eta = metrics.eta;
    existing.latency = metrics.latency;
    existing.safeModeActive = metrics.safeModeActive;
    existing.healthState = metrics.healthState;
    existing.burstPhase = metrics.burstPhase || 'adaptive';
    existing.errors = metrics.errors;
    existing.metaBlockedCount = metrics.metaBlockedCount;
    existing.environmentStatus = metrics.environmentStatus;
    existing.failSafeActive = metrics.failSafeActive;
    existing.tier = metrics.detectedTier || existing.tier;
    existing.circuitState = existing.circuitState;

    if (metrics.indicators) {
      existing.indicators = metrics.indicators;
    }

    if (metrics.state === 'RUNNING' && existing.status !== 'PAUSED') {
      existing.status = 'RUNNING';
    } else if (metrics.state === 'COMPLETED') {
      existing.status = 'COMPLETED';
    } else if (metrics.state === 'FINALIZING') {
      existing.status = 'FINALIZING';
    }
  }

  getSnapshot(id: string): CampaignState & { errorMapArray: ErrorMapEntry[] } | null {
    const state = this.campaigns.get(id);
    if (!state) return null;
    return {
      ...state,
      errorMapArray: Array.from(state.errorMap.values()),
    };
  }

  addLog(id: string, type: LogEntry['type'], message: string, data?: any): void {
    const logs = this.logs.get(id);
    if (!logs) return;
    const entry: LogEntry = { timestamp: Date.now(), type, message, data };
    logs.push(entry);
    if (logs.length > 500) {
      logs.splice(0, logs.length - 500);
    }

    metricsPublisher.publishEvent(id, {
      type: 'log' as any,
      timestamp: entry.timestamp,
      data: entry,
    });
  }

  getLogs(id: string): LogEntry[] {
    return this.logs.get(id) || [];
  }

  remove(id: string): void {
    this.campaigns.delete(id);
    this.logs.delete(id);
  }

  getActiveCampaignIds(): string[] {
    return Array.from(this.campaigns.keys());
  }

  private emitSSE(id: string): void {
    const snapshot = this.getSnapshot(id);
    if (!snapshot) return;

    const globalMetrics: GlobalCampaignMetrics = {
      campaignId: id,
      state: snapshot.status,
      currentMsgPerSec: snapshot.speedCurrent,
      peakMsgPerSec: snapshot.speedPeak,
      avgMsgPerSec: snapshot.speedAverage,
      totalProcessed: snapshot.processed,
      totalSuccess: snapshot.accepted,
      totalFailed: snapshot.failed,
      totalLeads: snapshot.totalLeads,
      progressPercent: snapshot.totalLeads > 0 ? Math.round((snapshot.processed / snapshot.totalLeads) * 1000) / 10 : 0,
      eta: snapshot.eta,
      latency: snapshot.latency,
      errors: snapshot.errors,
      metaBlockedCount: snapshot.metaBlockedCount,
      preflightErrors: snapshot.preflightFailed,
      environmentStatus: snapshot.environmentStatus,
      safeModeActive: snapshot.safeModeActive,
      pauseActive: snapshot.pauseActive,
      failSafeActive: snapshot.failSafeActive,
      healthState: snapshot.healthState as 'HEALTHY' | 'DEGRADED' | 'CRITICAL',
      burstPhase: snapshot.burstPhase,
      detectedTier: snapshot.tier,
      indicators: snapshot.indicators || {
        health: 'GREEN' as const,
        speed: 'NORMAL' as const,
        risk: 'LOW' as const,
        healthReason: 'Operando normalmente',
        speedReason: '',
        riskReason: 'Operação segura',
      },
    };

    metricsPublisher.updateGlobalMetrics(id, globalMetrics);
  }
}

export const campaignStore = CampaignStore.getInstance();
