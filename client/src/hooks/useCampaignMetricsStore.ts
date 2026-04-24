import { useState, useEffect, useRef, useCallback } from 'react';
import { useCampaignMetrics, CampaignEvent, LogEntry } from '@/hooks/useCampaignMetrics';
import {
  NormalizedMetrics,
  NormalizedPhoneMetrics,
  CampaignState,
  normalizeMetrics,
  normalizePhoneMetrics,
  monotonicMerge,
  deriveCampaignState,
} from '@/lib/metricsAdapter';

const devLog = (...args: any[]) => {
  if (import.meta.env.DEV) console.debug('[CampaignStore]', ...args);
};

const TERMINAL_STATES: CampaignState[] = ['COMPLETED', 'FAILED', 'BLOCKED', 'TOKEN_EXPIRED'];
const SSE_TIMEOUT_MS = 10_000;

function computeHealthScore(m: NormalizedMetrics | null): number {
  if (!m || m.totalProcessed === 0) return 100;
  let score = 100;
  const errorRate = m.totalProcessed > 0 ? (m.totalFailed / m.totalProcessed) * 100 : 0;
  const blockRate = m.totalProcessed > 0 ? (m.metaBlockedCount / m.totalProcessed) * 100 : 0;
  score -= errorRate * 3;
  score -= blockRate * 2;
  if (m.safeModeActive) score -= 10;
  if (m.healthState === 'CRITICAL') score -= 20;
  if (m.healthState === 'DEGRADED') score -= 10;
  if ((m.latency?.p95 || 0) > 350) score -= 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function formatElapsed(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
}

function metricsEqual(a: NormalizedMetrics | null, b: NormalizedMetrics | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.totalProcessed === b.totalProcessed &&
    a.totalSuccess === b.totalSuccess &&
    a.totalFailed === b.totalFailed &&
    a.progressPercent === b.progressPercent &&
    a.state === b.state &&
    a.currentMsgPerSec === b.currentMsgPerSec &&
    a.safeModeActive === b.safeModeActive &&
    a.pauseActive === b.pauseActive &&
    a.healthState === b.healthState &&
    a.metaBlockedCount === b.metaBlockedCount &&
    a.errors.total === b.errors.total &&
    a.environmentStatus === b.environmentStatus
  );
}

export interface CampaignStoreState {
  metrics: NormalizedMetrics | null;
  phoneMetrics: NormalizedPhoneMetrics[];
  campaignState: CampaignState;
  connected: boolean;
  events: CampaignEvent[];
  logs: LogEntry[];
  healthScore: number;
  elapsedDisplay: string;
  isTerminal: boolean;
  isActive: boolean;
  isPaused: boolean;
}

export function useCampaignMetricsStore(options: {
  campaignId: string;
  enabled?: boolean;
  totalLeads?: number;
}): CampaignStoreState {
  const { campaignId, enabled = true, totalLeads } = options;

  const raw = useCampaignMetrics({ campaignId, enabled });

  const [stableMetrics, setStableMetrics] = useState<NormalizedMetrics | null>(null);
  const [stablePhoneMetrics, setStablePhoneMetrics] = useState<NormalizedPhoneMetrics[]>([]);
  const [campaignState, setCampaignState] = useState<CampaignState>('IDLE');
  const [healthScore, setHealthScore] = useState(100);
  const [elapsedDisplay, setElapsedDisplay] = useState('0s');
  const [sseTimeout, setSseTimeout] = useState(false);

  const prevMetricsRef = useRef<NormalizedMetrics | null>(null);
  const lastMetricsTimeRef = useRef<number>(Date.now());
  const startTimestampRef = useRef<number>(Date.now());
  const prevStateRef = useRef<CampaignState>('IDLE');

  useEffect(() => {
    if (!raw.metrics) return;

    lastMetricsTimeRef.current = Date.now();
    setSseTimeout(false);

    let normalized = normalizeMetrics(raw.metrics);

    if (totalLeads && normalized.totalLeads === 0) {
      normalized = { ...normalized, totalLeads };
    }

    const prev = prevMetricsRef.current;
    const merged = prev ? monotonicMerge(prev, normalized) : normalized;

    prevMetricsRef.current = merged;

    if (!metricsEqual(stableMetrics, merged)) {
      setStableMetrics(merged);
    }
  }, [raw.metrics, totalLeads]);

  useEffect(() => {
    if (!raw.phoneMetrics || raw.phoneMetrics.length === 0) {
      if (stablePhoneMetrics.length > 0) setStablePhoneMetrics([]);
      return;
    }
    const normalized = normalizePhoneMetrics(raw.phoneMetrics);
    setStablePhoneMetrics(normalized);
  }, [raw.phoneMetrics]);

  useEffect(() => {
    const newState = deriveCampaignState(stableMetrics, raw.connected, sseTimeout);
    if (newState !== campaignState) {
      devLog('state transition:', prevStateRef.current, '->', newState);
      prevStateRef.current = newState;
      setCampaignState(newState);
    }
  }, [stableMetrics, raw.connected, sseTimeout]);

  useEffect(() => {
    setHealthScore(computeHealthScore(stableMetrics));
  }, [stableMetrics]);

  const isTerminal = TERMINAL_STATES.includes(campaignState);
  const isPaused = campaignState === 'PAUSED';
  const isActive = campaignState === 'RUNNING' || isPaused;

  useEffect(() => {
    if (isTerminal) return;
    const interval = setInterval(() => {
      setElapsedDisplay(formatElapsed(startTimestampRef.current));
    }, 1000);
    return () => clearInterval(interval);
  }, [isTerminal]);

  useEffect(() => {
    if (!enabled || !raw.connected || isTerminal) return;
    const interval = setInterval(() => {
      if (Date.now() - lastMetricsTimeRef.current > SSE_TIMEOUT_MS) {
        setSseTimeout(true);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [enabled, raw.connected, isTerminal]);

  return {
    metrics: stableMetrics,
    phoneMetrics: stablePhoneMetrics,
    campaignState,
    connected: raw.connected,
    events: raw.events,
    logs: raw.logs,
    healthScore,
    elapsedDisplay,
    isTerminal,
    isActive,
    isPaused,
  };
}
