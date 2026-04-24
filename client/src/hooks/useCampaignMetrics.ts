import { useState, useEffect, useCallback, useRef } from 'react';

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
  indicators?: SimplifiedIndicators;
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

export interface LogEntry {
  timestamp: number;
  type: 'INFO' | 'WARN' | 'ERROR' | 'SEND';
  message: string;
  data?: any;
}

interface UseCampaignMetricsOptions {
  campaignId: string;
  enabled?: boolean;
  onStateChange?: (state: string) => void;
  onError?: (error: CampaignEvent) => void;
  onComplete?: () => void;
}

export function useCampaignMetrics({
  campaignId,
  enabled = true,
  onStateChange,
  onError,
  onComplete
}: UseCampaignMetricsOptions) {
  const [metrics, setMetrics] = useState<GlobalCampaignMetrics | null>(null);
  const [phoneMetrics, setPhoneMetrics] = useState<PhoneMetrics[]>([]);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!campaignId || !enabled) return;
    
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = `/api/campaigns/${campaignId}/metrics/stream`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
    };

    eventSource.onerror = () => {
      setConnected(false);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (enabled) connect();
      }, 3000);
    };

    eventSource.addEventListener('connected', () => {
      setConnected(true);
    });

    eventSource.addEventListener('metrics', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        setMetrics(event.data as GlobalCampaignMetrics);
      } catch (err) {
        console.warn('[SSE] Failed to parse metrics event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('phone_update', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        setPhoneMetrics(event.data as PhoneMetrics[]);
      } catch (err) {
        console.warn('[SSE] Failed to parse phone_update event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('state_change', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        onStateChange?.(event.data.state);
        setEvents(prev => [...prev.slice(-99), event]);
      } catch (err) {
        console.warn('[SSE] Failed to parse state_change event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('error', (e) => {
      try {
        const event: CampaignEvent = JSON.parse((e as MessageEvent).data);
        onError?.(event);
        setEvents(prev => [...prev.slice(-99), event]);
      } catch (err) {
        console.warn('[SSE] Failed to parse error event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('complete', () => {
      onComplete?.();
      eventSource.close();
      setConnected(false);
    });

    eventSource.addEventListener('pause', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        setEvents(prev => [...prev.slice(-99), event]);
      } catch (err) {
        console.warn('[SSE] Failed to parse pause event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('resume', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        setEvents(prev => [...prev.slice(-99), event]);
      } catch (err) {
        console.warn('[SSE] Failed to parse resume event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('safe_mode', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        setEvents(prev => [...prev.slice(-99), event]);
      } catch (err) {
        console.warn('[SSE] Failed to parse safe_mode event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('send_result', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        setEvents(prev => [...prev.slice(-199), event]);
      } catch (err) {
        console.warn('[SSE] Failed to parse send_result event', { campaignId, error: (err as Error).message });
      }
    });

    eventSource.addEventListener('log', (e) => {
      try {
        const event: CampaignEvent = JSON.parse(e.data);
        const logEntry = event.data as LogEntry;
        setLogs(prev => [...prev.slice(-299), logEntry]);
      } catch (err) {
        console.warn('[SSE] Failed to parse log event', { campaignId, error: (err as Error).message });
      }
    });

  }, [campaignId, enabled, onStateChange, onError, onComplete]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [enabled, connect, disconnect]);

  return {
    metrics,
    phoneMetrics,
    connected,
    events,
    logs,
    connect,
    disconnect
  };
}
