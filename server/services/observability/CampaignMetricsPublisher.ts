import { Response } from 'express';
import { logError } from '../../utils/logger';

export type HealthIndicator = 'GREEN' | 'YELLOW' | 'RED';
export type SpeedIndicator = 'FAST' | 'NORMAL' | 'SLOW';
export type RiskIndicator = 'LOW' | 'MEDIUM' | 'HIGH';

export interface SimplifiedIndicators {
  health: HealthIndicator;
  speed: SpeedIndicator;
  risk: RiskIndicator;
  healthReason: string;
  speedReason: string;
  riskReason: string;
}

export interface GlobalCampaignMetrics {
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
  burstPhase?: string;
  detectedTier?: string;
  indicators: SimplifiedIndicators;
}

export interface PhoneMetrics {
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

export interface CampaignEvent {
  type: 'metrics' | 'state_change' | 'error' | 'phone_update' | 'pause' | 'resume' | 'safe_mode' | 'complete' | 'send_result' | 'log';
  timestamp: number;
  data: any;
}

interface SSEClient {
  id: string;
  campaignId: string;
  res: Response;
  lastActivity: number;
}

const COMPLETED_METRICS_TTL_MS = 5 * 60 * 1000;

export class CampaignMetricsPublisher {
  private clients: Map<string, SSEClient> = new Map();
  private metricsBuffer: Map<string, GlobalCampaignMetrics> = new Map();
  private phoneMetricsBuffer: Map<string, Map<string, PhoneMetrics>> = new Map();
  private metricsLastUpdated: Map<string, number> = new Map();
  private publishIntervalMs: number;
  private intervalId: NodeJS.Timeout | null = null;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  constructor(publishIntervalMs: number = 500) {
    this.publishIntervalMs = publishIntervalMs;
  }

  start(): void {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(() => {
      this.publishBufferedMetrics();
    }, this.publishIntervalMs);
    
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupStaleClients();
      this.cleanupOrphanedBuffers();
    }, 30000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  addClient(clientId: string, campaignId: string, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId, campaignId })}\n\n`);
    
    this.clients.set(clientId, {
      id: clientId,
      campaignId,
      res,
      lastActivity: Date.now()
    });

    res.on('close', () => {
      this.removeClient(clientId);
    });

    const currentMetrics = this.metricsBuffer.get(campaignId);
    if (currentMetrics) {
      this.sendToClient(clientId, {
        type: 'metrics',
        timestamp: Date.now(),
        data: currentMetrics
      });
    }
    
    const phoneMetrics = this.phoneMetricsBuffer.get(campaignId);
    if (phoneMetrics) {
      this.sendToClient(clientId, {
        type: 'phone_update',
        timestamp: Date.now(),
        data: Array.from(phoneMetrics.values())
      });
    }
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.res.end();
      } catch (e: any) {
        logError("metricsPublisher.removeClient", { clientId, campaignId: client.campaignId }, e);
      }
      this.clients.delete(clientId);
    }
  }

  updateGlobalMetrics(campaignId: string, metrics: GlobalCampaignMetrics): void {
    this.metricsBuffer.set(campaignId, metrics);
    this.metricsLastUpdated.set(campaignId, Date.now());
  }

  updatePhoneMetrics(campaignId: string, phoneId: string, metrics: PhoneMetrics): void {
    if (!this.phoneMetricsBuffer.has(campaignId)) {
      this.phoneMetricsBuffer.set(campaignId, new Map());
    }
    this.phoneMetricsBuffer.get(campaignId)!.set(phoneId, metrics);
    this.metricsLastUpdated.set(campaignId, Date.now());
  }

  publishEvent(campaignId: string, event: CampaignEvent): void {
    const clients = this.getClientsForCampaign(campaignId);
    for (const client of clients) {
      this.sendToClient(client.id, event);
    }
  }

  private publishBufferedMetrics(): void {
    const metricsEntries = Array.from(this.metricsBuffer.entries());
    for (const [campaignId, metrics] of metricsEntries) {
      const clients = this.getClientsForCampaign(campaignId);
      if (clients.length === 0) continue;
      
      const event: CampaignEvent = {
        type: 'metrics',
        timestamp: Date.now(),
        data: metrics
      };
      
      for (const client of clients) {
        this.sendToClient(client.id, event);
      }
    }
    
    const phoneMetricsEntries = Array.from(this.phoneMetricsBuffer.entries());
    for (const [campaignId, phoneMap] of phoneMetricsEntries) {
      const clients = this.getClientsForCampaign(campaignId);
      if (clients.length === 0) continue;
      
      const event: CampaignEvent = {
        type: 'phone_update',
        timestamp: Date.now(),
        data: Array.from(phoneMap.values())
      };
      
      for (const client of clients) {
        this.sendToClient(client.id, event);
      }
    }
  }

  private sendToClient(clientId: string, event: CampaignEvent): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    try {
      client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      client.lastActivity = Date.now();
    } catch (error) {
      this.removeClient(clientId);
    }
  }

  private getClientsForCampaign(campaignId: string): SSEClient[] {
    return Array.from(this.clients.values()).filter(c => c.campaignId === campaignId);
  }

  private cleanupStaleClients(): void {
    const staleThreshold = 60000;
    const now = Date.now();
    
    const clientEntries = Array.from(this.clients.entries());
    for (const [clientId, client] of clientEntries) {
      if (now - client.lastActivity > staleThreshold) {
        try {
          client.res.write(`event: ping\ndata: {}\n\n`);
        } catch (e) {
          this.removeClient(clientId);
        }
      }
    }
  }

  getConnectedClients(campaignId: string): number {
    return this.getClientsForCampaign(campaignId).length;
  }

  clearCampaign(campaignId: string): void {
    this.metricsBuffer.delete(campaignId);
    this.phoneMetricsBuffer.delete(campaignId);
    this.metricsLastUpdated.delete(campaignId);
    
    const clients = this.getClientsForCampaign(campaignId);
    for (const client of clients) {
      this.sendToClient(client.id, {
        type: 'complete',
        timestamp: Date.now(),
        data: { campaignId }
      });
    }
  }

  private cleanupOrphanedBuffers(): void {
    const now = Date.now();
    const allCampaignIds = new Set([
      ...this.metricsBuffer.keys(),
      ...this.phoneMetricsBuffer.keys(),
    ]);
    for (const campaignId of allCampaignIds) {
      const lastUpdated = this.metricsLastUpdated.get(campaignId) ?? 0;
      const hasActiveClients = this.getClientsForCampaign(campaignId).length > 0;
      if (!hasActiveClients && now - lastUpdated > COMPLETED_METRICS_TTL_MS) {
        this.metricsBuffer.delete(campaignId);
        this.phoneMetricsBuffer.delete(campaignId);
        this.metricsLastUpdated.delete(campaignId);
      }
    }
  }
}

export const metricsPublisher = new CampaignMetricsPublisher(500);
metricsPublisher.start();
