import { 
  metricsPublisher, 
  GlobalCampaignMetrics, 
  PhoneMetrics, 
  CampaignEvent,
  SimplifiedIndicators,
  HealthIndicator,
  SpeedIndicator,
  RiskIndicator
} from './CampaignMetricsPublisher';

export interface EngineStats {
  campaignId: string;
  processedLeads: number;
  successfulSends: number;
  failedSends: number;
  preflightFailed?: number;
  totalLeads?: number;
  currentRate: number;
  peakRate: number;
  averageRttMs: number;
  p95RttMs?: number;
  p99RttMs?: number;
  burstState: string;
  circuitBreakerTrips: number;
  totalRetries: number;
  tokenBucketRate: number;
  circuitState: string;
  inFlightRequests: number;
  eta: {
    remainingSeconds: number;
    estimatedCompletion: Date;
    confidence: string;
  };
  retryQueue: {
    size: number;
    processed: number;
    failed: number;
  };
  errorCounts: {
    rateLimitErrors: number;
    payloadErrors: number;
    networkErrors: number;
    authErrors: number;
    environmentErrors: number;
    unknownErrors: number;
    total: number;
  };
  metaBlockedSends?: number;
  safeModeState?: {
    isActive: boolean;
    activationReason?: string;
  };
  detectedTier?: string;
  healthState?: string;
  campaignState?: string;
  pauseState?: {
    isPaused: boolean;
    currentRatePercent: number;
  };
  failSafeActive?: boolean;
}

export interface PhoneStats {
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: string;
  tier?: string;
  isHealthy: boolean;
  circuitState: string;
  safeModeActive: boolean;
  currentRate: number;
  totalSent: number;
  successCount: number;
  failedCount: number;
  pendingRequests: number;
  rttAvg: number;
  rttP95: number;
}

export class CampaignMetricsAdapter {
  private startTime: number = Date.now();
  private peakRate: number = 0;
  private rateHistory: number[] = [];

  constructor(private campaignId: string, private totalLeads: number = 0) {
    this.startTime = Date.now();
  }

  updateFromEngineStats(stats: EngineStats): void {
    const elapsed = (Date.now() - this.startTime) / 1000;
    const currentRate = stats.currentRate;
    
    if (currentRate > this.peakRate) {
      this.peakRate = currentRate;
    }
    
    this.rateHistory.push(currentRate);
    if (this.rateHistory.length > 60) {
      this.rateHistory.shift();
    }
    
    const avgRate = this.rateHistory.length > 0 
      ? this.rateHistory.reduce((a, b) => a + b, 0) / this.rateHistory.length 
      : 0;

    const progressPercent = this.totalLeads > 0 
      ? (stats.processedLeads / this.totalLeads) * 100 
      : 0;

    const errorRate = stats.processedLeads > 0 
      ? (stats.failedSends / stats.processedLeads) * 100 
      : 0;
    
    const indicators = this.calculateIndicators(
      currentRate,
      this.peakRate,
      stats.p95RttMs || stats.averageRttMs || 0,
      errorRate,
      stats.safeModeState?.isActive || false,
      stats.circuitState
    );

    const metrics: GlobalCampaignMetrics = {
      campaignId: this.campaignId,
      state: stats.campaignState || 'RUNNING',
      currentMsgPerSec: Math.round(currentRate * 10) / 10,
      peakMsgPerSec: Math.round(this.peakRate * 10) / 10,
      avgMsgPerSec: Math.round(avgRate * 10) / 10,
      totalProcessed: stats.processedLeads,
      totalSuccess: stats.successfulSends,
      totalFailed: stats.failedSends,
      totalLeads: this.totalLeads || stats.totalLeads || 0,
      progressPercent: Math.round(progressPercent * 10) / 10,
      eta: {
        remainingSeconds: stats.eta?.remainingSeconds || 0,
        estimatedCompletion: stats.eta?.estimatedCompletion?.toISOString() || new Date().toISOString(),
        confidenceLevel: (stats.eta?.confidence === 'high' ? 'high' : 
                         stats.eta?.confidence === 'medium' ? 'medium' : 'low') as 'high' | 'medium' | 'low'
      },
      latency: {
        p50: stats.averageRttMs || 0,
        p95: stats.p95RttMs || stats.averageRttMs || 0,
        p99: stats.p99RttMs || stats.averageRttMs || 0,
        avg: stats.averageRttMs || 0,
        trend: this.calculateTrend()
      },
      errors: {
        total: stats.errorCounts?.total || 0,
        rateLimitErrors: stats.errorCounts?.rateLimitErrors || 0,
        payloadErrors: stats.errorCounts?.payloadErrors || 0,
        networkErrors: stats.errorCounts?.networkErrors || 0,
        authErrors: stats.errorCounts?.authErrors || 0,
        environmentErrors: stats.errorCounts?.environmentErrors || 0,
        templateErrors: 0,
        timeoutErrors: 0
      },
      metaBlockedCount: stats.metaBlockedSends || 0,
      preflightErrors: stats.preflightFailed || 0,
      environmentStatus: (stats.metaBlockedSends || 0) > 0 ? 'blocked' : 'ok',
      safeModeActive: stats.safeModeState?.isActive || false,
      pauseActive: stats.pauseState?.isPaused || false,
      failSafeActive: stats.failSafeActive || false,
      healthState: (stats.healthState as 'HEALTHY' | 'DEGRADED' | 'CRITICAL') || 'HEALTHY',
      burstPhase: stats.burstState || 'adaptive',
      detectedTier: stats.detectedTier,
      indicators
    };

    metricsPublisher.updateGlobalMetrics(this.campaignId, metrics);
  }

  updatePhoneStats(phones: PhoneStats[]): void {
    for (const phone of phones) {
      const phoneMetrics: PhoneMetrics = {
        phoneNumberId: phone.phoneNumberId,
        displayPhone: phone.displayPhoneNumber,
        qualityRating: (phone.qualityRating as 'GREEN' | 'YELLOW' | 'RED') || 'UNKNOWN',
        tier: phone.tier || 'TIER_1K',
        healthState: phone.isHealthy ? 'HEALTHY' : 'DEGRADED',
        circuitState: (phone.circuitState as 'closed' | 'open' | 'half_open') || 'closed',
        safeModeActive: phone.safeModeActive,
        currentRate: Math.round(phone.currentRate * 10) / 10,
        messagesSent: phone.totalSent,
        messagesSuccess: phone.successCount,
        messagesFailed: phone.failedCount,
        pendingQueue: phone.pendingRequests,
        rttAvg: Math.round(phone.rttAvg),
        rttP95: Math.round(phone.rttP95)
      };

      metricsPublisher.updatePhoneMetrics(this.campaignId, phone.phoneNumberId, phoneMetrics);
    }
  }

  publishStateChange(newState: string, reason?: string): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'state_change',
      timestamp: Date.now(),
      data: { state: newState, reason }
    });
  }

  publishError(errorType: string, errorMessage: string, phoneNumberId?: string): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'error',
      timestamp: Date.now(),
      data: { errorType, errorMessage, phoneNumberId }
    });
  }

  publishPause(reason: string, durationMs: number): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'pause',
      timestamp: Date.now(),
      data: { reason, durationMs }
    });
  }

  publishResume(ratePercent: number): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'resume',
      timestamp: Date.now(),
      data: { ratePercent }
    });
  }

  publishSafeMode(activated: boolean, reason?: string): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'safe_mode',
      timestamp: Date.now(),
      data: { activated, reason }
    });
  }

  publishSendResult(result: { success: boolean; phone: string; errorMessage?: string; errorType?: string; isMetaBlocked?: boolean; isRetry?: boolean; retryAttempt?: number }): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'send_result',
      timestamp: Date.now(),
      data: result
    });
  }

  publishLog(type: 'INFO' | 'WARN' | 'ERROR' | 'SEND', message: string, data?: any): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'log',
      timestamp: Date.now(),
      data: { type, message, data, timestamp: Date.now() }
    });
  }

  publishComplete(summary: { total: number; success: number; failed: number; duration: number }): void {
    metricsPublisher.publishEvent(this.campaignId, {
      type: 'complete',
      timestamp: Date.now(),
      data: summary
    });
    
    metricsPublisher.clearCampaign(this.campaignId);
  }

  private calculateTrend(): 'increasing' | 'stable' | 'decreasing' {
    if (this.rateHistory.length < 5) return 'stable';
    
    const recent = this.rateHistory.slice(-5);
    const older = this.rateHistory.slice(-10, -5);
    
    if (older.length === 0) return 'stable';
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    
    const change = (recentAvg - olderAvg) / olderAvg;
    
    if (change > 0.1) return 'increasing';
    if (change < -0.1) return 'decreasing';
    return 'stable';
  }

  private calculateIndicators(
    currentRate: number,
    peakRate: number,
    p95Rtt: number,
    errorRate: number,
    safeModeActive: boolean,
    circuitState: string
  ): SimplifiedIndicators {
    let health: HealthIndicator = 'GREEN';
    let healthReason = 'Sistema operando normalmente';
    
    if (errorRate > 2 || circuitState === 'OPEN' || safeModeActive) {
      health = 'RED';
      if (errorRate > 2) healthReason = `Taxa de erro alta: ${errorRate.toFixed(1)}%`;
      else if (circuitState === 'OPEN') healthReason = 'Circuit breaker aberto - proteção ativa';
      else healthReason = 'SafeMode ativado - velocidade reduzida';
    } else if (errorRate > 0.5 || circuitState === 'HALF_OPEN' || p95Rtt > 350) {
      health = 'YELLOW';
      if (errorRate > 0.5) healthReason = `Taxa de erro elevada: ${errorRate.toFixed(1)}%`;
      else if (circuitState === 'HALF_OPEN') healthReason = 'Circuit breaker em recuperação';
      else healthReason = `Latência alta: ${p95Rtt.toFixed(0)}ms`;
    }

    let speed: SpeedIndicator = 'NORMAL';
    let speedReason = `Velocidade atual: ${currentRate.toFixed(1)} msg/s`;
    
    if (peakRate > 0) {
      const speedRatio = currentRate / peakRate;
      if (speedRatio >= 0.8) {
        speed = 'FAST';
        speedReason = `Alta velocidade: ${currentRate.toFixed(1)} msg/s (${(speedRatio * 100).toFixed(0)}% do pico)`;
      } else if (speedRatio < 0.4) {
        speed = 'SLOW';
        speedReason = `Velocidade reduzida: ${currentRate.toFixed(1)} msg/s (${(speedRatio * 100).toFixed(0)}% do pico)`;
      }
    }
    
    if (safeModeActive) {
      speed = 'SLOW';
      speedReason = 'SafeMode ativo - velocidade controlada';
    }

    let risk: RiskIndicator = 'LOW';
    let riskReason = 'Operação segura';
    
    if (errorRate > 2 || circuitState === 'OPEN') {
      risk = 'HIGH';
      riskReason = errorRate > 2 
        ? 'Taxa de erro alta pode causar bloqueio' 
        : 'Proteção ativa - aguardando estabilização';
    } else if (errorRate > 0.5 || p95Rtt > 350 || circuitState === 'HALF_OPEN') {
      risk = 'MEDIUM';
      riskReason = 'Monitorando indicadores - atenção recomendada';
    }

    return {
      health,
      speed,
      risk,
      healthReason,
      speedReason,
      riskReason
    };
  }

  getConnectedClients(): number {
    return metricsPublisher.getConnectedClients(this.campaignId);
  }
}

const activeAdapters = new Map<string, CampaignMetricsAdapter>();

export function getOrCreateAdapter(campaignId: string, totalLeads?: number): CampaignMetricsAdapter {
  if (!activeAdapters.has(campaignId)) {
    activeAdapters.set(campaignId, new CampaignMetricsAdapter(campaignId, totalLeads));
  }
  return activeAdapters.get(campaignId)!;
}

export function removeAdapter(campaignId: string): void {
  activeAdapters.delete(campaignId);
}
