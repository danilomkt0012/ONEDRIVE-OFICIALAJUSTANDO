import { Component, useState, useEffect, useRef, useCallback, memo } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  ChevronDown, ChevronUp, Clock, CheckCircle,
  AlertTriangle, Phone, XCircle,
  Activity, ArrowLeft,
  TrendingUp, TrendingDown, Minus, Wifi, WifiOff, RotateCcw,
  Pause, Play, Lock, RefreshCw, Terminal, Shield, Gauge
} from 'lucide-react';
import { useCampaignMetricsStore } from '@/hooks/useCampaignMetricsStore';
import type { CampaignStoreState } from '@/hooks/useCampaignMetricsStore';
import type { NormalizedMetrics, NormalizedPhoneMetrics, CampaignState } from '@/lib/metricsAdapter';
import type { CampaignEvent } from '@/hooks/useCampaignMetrics';
import { apiRequest } from '@/lib/queryClient';

type SpeedModeType = 'SLOW' | 'NORMAL' | 'FAST';

interface SimpleCampaignStatusProps {
  campaignId: string;
  enabled?: boolean;
  onNewCampaign?: () => void;
  onRetry?: () => void;
  isRunning?: boolean;
  speedMode?: SpeedModeType;
  templateName?: string;
  totalLeads?: number;
  activePhones?: number;
}

const formatTime = (seconds: number): string => {
  if (seconds <= 0) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
};

const formatEventTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function formatPhoneDisplay(phone: string): string {
  const clean = phone.replace(/\D/g, '');
  if (clean.length >= 12) return `+${clean.slice(0, 2)} ${clean.slice(2, 4)} ${clean.slice(4)}`;
  return phone;
}

const STATE_CONFIG: Record<CampaignState, { label: string; color: string; bg: string; bgFaint: string; icon?: string }> = {
  IDLE: { label: 'Preparando', color: 'text-[#A0AEC0]', bg: 'bg-[#A0AEC0]', bgFaint: 'bg-[#F7FAFC]', icon: 'dot' },
  RUNNING: { label: 'Enviando', color: 'text-[#38A169]', bg: 'bg-[#38A169]', bgFaint: 'bg-slate-50', icon: 'dot' },
  COMPLETED: { label: 'Finalizada', color: 'text-[#3182CE]', bg: 'bg-[#3182CE]', bgFaint: 'bg-slate-50', icon: 'check' },
  FAILED: { label: 'Falha', color: 'text-[#E53E3E]', bg: 'bg-[#E53E3E]', bgFaint: 'bg-red-50', icon: 'x' },
  PAUSED: { label: 'Pausado', color: 'text-[#718096]', bg: 'bg-[#718096]', bgFaint: 'bg-slate-50', icon: 'pause' },
  BLOCKED: { label: 'Bloqueado', color: 'text-[#718096]', bg: 'bg-[#718096]', bgFaint: 'bg-slate-50', icon: 'alert' },
  TOKEN_EXPIRED: { label: 'Token Expirado', color: 'text-[#E53E3E]', bg: 'bg-[#E53E3E]', bgFaint: 'bg-red-50', icon: 'lock' },
};

interface LogEntry {
  id: number;
  timestamp: number;
  text: string;
  type: 'success' | 'blocked' | 'error' | 'info' | 'warning';
}

const LOG_TYPE_COLORS: Record<string, string> = {
  success: 'text-[#38A169]',
  blocked: 'text-[#D69E2E]',
  error: 'text-[#E53E3E]',
  info: 'text-[#718096]',
  warning: 'text-[#D69E2E]',
};

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode; onRetry?: () => void }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode; onRetry?: () => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error('[SimpleCampaignStatus] Error caught:', error, info);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="saas-card p-8 flex flex-col items-center justify-center gap-4">
          <AlertTriangle size={32} className="text-[#E53E3E]" />
          <p className="text-sm font-medium text-[#1A202C]">Erro no painel de monitoramento</p>
          <p className="text-xs text-[#A0AEC0]">Um erro inesperado ocorreu ao renderizar o painel.</p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              this.props.onRetry?.();
            }}
            className="flex items-center gap-2 px-4 py-2 text-sm text-[#718096] hover:text-[#1A202C] border border-[#E2E8F0] rounded-lg transition-colors hover:bg-[#F7FAFC]"
          >
            <RotateCcw size={14} /> Tentar novamente
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const StatusIcon = memo(({ state }: { state: CampaignState }) => {
  const cfg = STATE_CONFIG[state];
  if (cfg.icon === 'check') return <CheckCircle size={14} className={cfg.color} />;
  if (cfg.icon === 'x') return <XCircle size={14} className={cfg.color} />;
  if (cfg.icon === 'pause') return <Pause size={14} className={cfg.color} />;
  if (cfg.icon === 'alert') return <AlertTriangle size={14} className={cfg.color} />;
  if (cfg.icon === 'lock') return <Lock size={14} className={cfg.color} />;
  return <div className={`w-2 h-2 rounded-full ${cfg.bg}`} />;
});

const ErrorTag = memo(({ label, count, critical }: { label: string; count: number; critical?: boolean }) => (
  <span className={`text-xs px-3 py-1 rounded-lg font-medium ${
    critical ? 'text-[#E53E3E] border border-red-200 bg-red-50' : 'text-[#718096] border border-[#E2E8F0] bg-[#F7FAFC]'
  }`}>
    {count.toLocaleString()} {label}
  </span>
));

const Row = memo(({ label, value, color }: { label: string; value: string; color?: string }) => (
  <div className="flex justify-between">
    <span className="text-[#718096]">{label}</span>
    <span className={`font-semibold tabular-nums ${color || 'text-[#1A202C]'}`}>{value}</span>
  </div>
));

const TechCell = memo(({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="text-center p-3 rounded-lg bg-[#F7FAFC]">
    <div className="text-[11px] text-[#A0AEC0] uppercase tracking-wide font-medium">{label}</div>
    <div className={`text-sm font-mono font-semibold mt-1 ${warn ? 'text-[#718096]' : 'text-[#1A202C]'}`}>{value}</div>
  </div>
));

const PhoneRow = memo(({ phone }: { phone: NormalizedPhoneMetrics }) => {
  const healthDot = phone.healthState === 'HEALTHY' ? 'bg-[#38A169]' :
                    phone.healthState === 'DEGRADED' ? 'bg-[#718096]' : 'bg-[#E53E3E]';
  return (
    <div className="px-3 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-1">
      <div className="flex items-center gap-2 min-w-0">
        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${healthDot}`} />
        <span className="text-xs font-mono text-[#1A202C] truncate">{phone.displayPhone}</span>
        <span className="text-[10px] text-[#A0AEC0]">{phone.qualityRating}</span>
        {phone.safeModeActive && <span className="text-[9px] text-[#718096] font-semibold bg-slate-100 px-1.5 py-0.5 rounded">SM</span>}
      </div>
      <div className="flex items-center gap-3 sm:gap-4 text-[11px] tabular-nums font-mono">
        <span className="text-[#718096]">{phone.currentRate.toFixed(1)}/s</span>
        <span className="text-[#38A169]">{phone.messagesSuccess.toLocaleString()}</span>
        <span className="text-[#E53E3E]">{phone.messagesFailed.toLocaleString()}</span>
      </div>
    </div>
  );
});

function CampaignDashboard({
  campaignId, enabled = true, onNewCampaign, onRetry, isRunning, speedMode,
  templateName, totalLeads: initialTotalLeads, activePhones
}: SimpleCampaignStatusProps) {
  const [showPhones, setShowPhones] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showErrors, setShowErrors] = useState(true);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [pauseLoading, setPauseLoading] = useState(false);
  const logIdRef = useRef(0);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const lastProcessedEventCount = useRef(0);

  const store = useCampaignMetricsStore({
    campaignId,
    enabled,
    totalLeads: initialTotalLeads,
  });

  const { metrics, phoneMetrics, campaignState, connected, events, healthScore, elapsedDisplay, isTerminal, isActive, isPaused } = store;

  const sc = STATE_CONFIG[campaignState];

  useEffect(() => {
    if (!metrics && events.length === 0) return;
    const newEntries: LogEntry[] = [];
    const unprocessed = events.slice(lastProcessedEventCount.current);
    lastProcessedEventCount.current = events.length;

    for (const event of unprocessed) {
      if (event.type === 'send_result') {
        const d = event.data;
        const phone = d.phone ? formatPhoneDisplay(d.phone) : '';
        if (d.success) {
          newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: `Enviada para ${phone}`, type: 'success' });
        } else if (d.isMetaBlocked) {
          newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: `Bloqueada Meta: ${phone}`, type: 'blocked' });
        } else {
          newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: `Erro: ${phone} - ${(d.errorType || '').substring(0, 30)}`, type: 'error' });
        }
      }
      if (event.type === 'state_change') {
        const state = event.data?.state;
        if (state === 'RUNNING') newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: 'Motor de envio iniciado', type: 'info' });
        if (state === 'COMPLETED') newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: 'Disparo finalizado', type: 'info' });
        if (state === 'SAFE_MODE') newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: 'SafeMode ativado', type: 'warning' });
        if (state === 'PAUSED') newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: 'Disparo pausado', type: 'warning' });
      }
      if (event.type === 'error') {
        newEntries.push({ id: logIdRef.current++, timestamp: event.timestamp, text: (event.data?.errorMessage || 'Erro').substring(0, 60), type: 'error' });
      }
    }
    if (newEntries.length > 0) setLogEntries(prev => [...prev, ...newEntries].slice(-200));
  }, [events.length]);

  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [logEntries]);

  const handlePause = useCallback(async () => {
    setPauseLoading(true);
    try { await apiRequest('POST', `/api/campaigns/${campaignId}/pause`); } catch {}
    setPauseLoading(false);
  }, [campaignId]);

  const handleResume = useCallback(async () => {
    setPauseLoading(true);
    try { await apiRequest('POST', `/api/campaigns/${campaignId}/resume-live`); } catch {}
    setPauseLoading(false);
  }, [campaignId]);

  const metaBlocked = metrics?.metaBlockedCount ?? 0;
  const preflightErrors = metrics?.preflightErrors ?? 0;
  const realErrors = Math.max(0, metrics?.totalFailed ?? 0);
  const totalLeadsCount = metrics?.totalLeads || initialTotalLeads || 0;
  const remaining = Math.max(0, totalLeadsCount - (metrics?.totalProcessed ?? 0));
  const totalProcessed = metrics?.totalProcessed ?? 0;
  const errorRate = totalProcessed > 0 ? ((realErrors / totalProcessed) * 100) : 0;
  const blockRate = totalProcessed > 0 ? ((metaBlocked / totalProcessed) * 100) : 0;

  const healthColor = healthScore >= 80 ? 'text-[#38A169]' : healthScore >= 50 ? 'text-[#718096]' : 'text-[#E53E3E]';
  const healthBg = healthScore >= 80 ? 'bg-slate-50 border-slate-200' : healthScore >= 50 ? 'bg-slate-50 border-slate-200' : 'bg-red-50 border-red-200';

  if (campaignState === 'IDLE' && !metrics) {
    return (
      <div className="space-y-3 sm:space-y-4">
        <div className="saas-card p-4 sm:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full border-2 border-[#E2E8F0] border-t-[#0066FF] animate-spin" />
            <div>
              <p className="text-sm text-[#718096]">
                {connected ? 'Iniciando motor de envio...' : 'Conectando ao servidor...'}
              </p>
              <div className="flex items-center gap-1.5 mt-1">
                {connected ? <Wifi size={11} className="text-[#38A169]" /> : <WifiOff size={11} className="text-[#A0AEC0]" />}
                <span className="text-[10px] text-[#A0AEC0]">{connected ? 'Conectado' : 'Aguardando conexão'}</span>
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <div className="animate-pulse h-20 rounded-lg bg-[#EDF2F7]" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="animate-pulse h-16 rounded-lg bg-[#EDF2F7]" />
              <div className="animate-pulse h-16 rounded-lg bg-[#EDF2F7]" />
              <div className="animate-pulse h-16 rounded-lg bg-[#EDF2F7]" />
              <div className="animate-pulse h-16 rounded-lg bg-[#EDF2F7]" />
            </div>
            <div className="animate-pulse h-16 rounded-lg bg-[#EDF2F7]" />
          </div>
        </div>
      </div>
    );
  }

  const hasErrors = metrics && metrics.errors && (metrics.errors.total > 0 || metrics.errors.environmentErrors > 0);

  return (
    <div className="space-y-3 sm:space-y-4">

      {/* Header */}
      <div className="saas-card p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <StatusIcon state={campaignState} />
              <span className={`text-sm font-semibold ${sc.color}`}>{sc.label}</span>
            </div>
            {metrics?.safeModeActive && (
              <span className="text-[10px] px-2 py-0.5 rounded-md border border-slate-200 bg-slate-50 text-[#718096] font-medium">
                SafeMode
              </span>
            )}
            {metrics?.detectedTier && (
              <span className="text-[10px] text-[#A0AEC0] font-mono">{metrics.detectedTier}</span>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 rounded-lg border ${healthBg}`}>
              <Shield size={13} className={healthColor} />
              <span className={`text-sm font-bold tabular-nums ${healthColor}`}>{healthScore.toLocaleString()}</span>
              <span className="text-[10px] text-[#A0AEC0] hidden sm:inline">/ 100</span>
            </div>

            {(isActive && !isTerminal) && (
              isPaused ? (
                <button onClick={handleResume} disabled={pauseLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#38A169] border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-40 min-h-[44px]">
                  <Play size={12} /> Retomar
                </button>
              ) : (
                <button onClick={handlePause} disabled={pauseLoading} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#718096] border border-[#E2E8F0] rounded-lg hover:bg-[#F7FAFC] transition-colors disabled:opacity-40 min-h-[44px]">
                  <Pause size={12} /> Pausar
                </button>
              )
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-3 pt-3 border-t border-[#E2E8F0] text-[11px] text-[#A0AEC0]">
          <span className="font-mono text-[#718096]">{campaignId.slice(0, 12)}...</span>
          {templateName && <span className="hidden sm:inline">Template: <span className="text-[#718096]">{templateName}</span></span>}
          <span>Leads: <span className="text-[#718096]">{totalLeadsCount.toLocaleString()}</span></span>
          {(activePhones || phoneMetrics.length > 0) && (
            <span>Números: <span className="text-[#718096]">{(phoneMetrics.length || activePhones || 0).toLocaleString()}</span></span>
          )}
          {speedMode && <span className="text-[#718096] font-medium uppercase">{speedMode}</span>}
        </div>
      </div>

      {/* Alert Banners */}
      {campaignState === 'TOKEN_EXPIRED' && (
        <div className="saas-card p-4 border-red-200 bg-red-50">
          <div className="flex items-center gap-2 mb-1.5">
            <Lock size={14} className="text-[#E53E3E]" />
            <span className="text-sm font-medium text-[#E53E3E]">Token de acesso expirado</span>
          </div>
          <p className="text-xs text-[#718096]">Acesse as configurações e atualize o token para continuar.</p>
          {onNewCampaign && (
            <button onClick={onNewCampaign} className="mt-3 flex items-center gap-2 text-xs text-[#E53E3E] hover:text-red-700 transition-colors">
              <ArrowLeft size={12} /> Voltar e atualizar token
            </button>
          )}
        </div>
      )}

      {campaignState === 'BLOCKED' && (
        <div className="saas-card p-4 border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertTriangle size={14} className="text-[#718096]" />
            <span className="text-sm font-medium text-[#718096]">Meta bloqueando envios</span>
          </div>
          <p className="text-xs text-[#718096]">Verifique se sua conta está fora do modo sandbox.</p>
        </div>
      )}

      {campaignState === 'FAILED' && metrics && (
        <div className="saas-card p-4 border-red-200 bg-red-50">
          <div className="flex items-center gap-2 mb-1.5">
            <XCircle size={14} className="text-[#E53E3E]" />
            <span className="text-sm font-medium text-[#E53E3E]">Disparo com falha</span>
          </div>
          <p className="text-xs text-[#718096] mt-1">
            {realErrors > 0 ? `${realErrors.toLocaleString()} erros detectados (${errorRate.toFixed(1)}% taxa de erro)` : 'O motor encontrou uma falha crítica'}
          </p>
          {onRetry && (
            <button onClick={onRetry} className="mt-3 flex items-center gap-2 text-xs text-[#E53E3E] hover:text-red-700 transition-colors">
              <RotateCcw size={12} /> Tentar novamente
            </button>
          )}
        </div>
      )}

      {/* Progress */}
      {metrics && (
        <div className="saas-card p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs text-[#718096] uppercase tracking-wider font-semibold">Progresso</span>
            <span className="text-xl sm:text-2xl font-bold text-[#1A202C] tabular-nums">{(metrics.progressPercent ?? 0).toFixed(1)}%</span>
          </div>
          <div className="progress-bar-saas">
            <div
              className={`progress-fill transition-all duration-500 ease-out ${isTerminal && campaignState === 'COMPLETED' ? 'progress-fill-success' : ''}`}
              style={{ width: `${Math.min(metrics.progressPercent ?? 0, 100)}%` }}
            />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mt-4 text-center">
            <div>
              <div className="text-[11px] text-[#718096] uppercase tracking-wide font-medium">Processados</div>
              <div className="text-xs sm:text-sm font-semibold text-[#1A202C] tabular-nums mt-0.5">{totalProcessed.toLocaleString()}/{totalLeadsCount.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#718096] uppercase tracking-wide font-medium">ETA</div>
              <div className="text-xs sm:text-sm font-semibold text-[#1A202C] tabular-nums mt-0.5">{formatTime(metrics.eta?.remainingSeconds ?? 0)}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#718096] uppercase tracking-wide font-medium">Decorrido</div>
              <div className="text-xs sm:text-sm font-semibold text-[#1A202C] tabular-nums mt-0.5">{elapsedDisplay}</div>
            </div>
            <div>
              <div className="text-[11px] text-[#718096] uppercase tracking-wide font-medium">Restantes</div>
              <div className="text-xs sm:text-sm font-semibold text-[#1A202C] tabular-nums mt-0.5">{remaining.toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      {/* Delivery Metrics */}
      {metrics && (
        <div>
          <div className="text-xs text-[#718096] uppercase tracking-wider font-semibold mb-3 px-1">Entrega</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div className="metric-card">
              <div className="metric-value text-[#38A169]">{(metrics.totalSuccess ?? 0).toLocaleString()}</div>
              <div className="metric-label">Enviadas</div>
            </div>
            <div className="metric-card">
              <div className={`metric-value ${metaBlocked > 0 ? 'text-[#D69E2E]' : 'text-[#A0AEC0]'}`}>{metaBlocked.toLocaleString()}</div>
              <div className="metric-label">Bloqueadas</div>
            </div>
            <div className="metric-card">
              <div className={`metric-value ${realErrors > 0 ? 'text-[#E53E3E]' : 'text-[#A0AEC0]'}`}>{realErrors.toLocaleString()}</div>
              <div className="metric-label">Erros</div>
            </div>
            <div className="metric-card">
              <div className={`metric-value ${preflightErrors > 0 ? 'text-[#D69E2E]' : 'text-[#A0AEC0]'}`}>{preflightErrors.toLocaleString()}</div>
              <div className="metric-label">Preflight</div>
            </div>
          </div>
        </div>
      )}

      {/* Performance Metrics */}
      {metrics && (
        <div>
          <div className="text-xs text-[#718096] uppercase tracking-wider font-semibold mb-3 px-1">Performance</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div className="metric-card">
              <div className="metric-value text-[#0066FF]">{(metrics.currentMsgPerSec ?? 0).toFixed(1)}<span className="text-lg text-[#A0AEC0]">/s</span></div>
              <div className="metric-label">Velocidade Atual</div>
            </div>
            <div className="metric-card">
              <div className="metric-value text-[#1A202C]">{(metrics.peakMsgPerSec ?? 0).toFixed(1)}<span className="text-lg text-[#A0AEC0]">/s</span></div>
              <div className="metric-label">Velocidade Pico</div>
            </div>
            <div className="metric-card">
              <div className={`metric-value ${(metrics.latency?.avg ?? 0) > 300 ? 'text-[#D69E2E]' : 'text-[#1A202C]'}`}>{(metrics.latency?.avg ?? 0).toFixed(0)}<span className="text-lg text-[#A0AEC0]">ms</span></div>
              <div className="metric-label">RTT Médio</div>
            </div>
            <div className="metric-card">
              <div className="flex items-center justify-center gap-2">
                {metrics.latency?.trend === 'increasing' && <TrendingUp size={20} className="text-[#E53E3E]" />}
                {metrics.latency?.trend === 'stable' && <Minus size={20} className="text-[#A0AEC0]" />}
                {metrics.latency?.trend === 'decreasing' && <TrendingDown size={20} className="text-[#38A169]" />}
                <span className="metric-value text-[#718096]" style={{ fontSize: '1.25rem' }}>
                  {metrics.latency?.trend === 'increasing' ? 'Alto' : metrics.latency?.trend === 'decreasing' ? 'Baixo' : 'Estável'}
                </span>
              </div>
              <div className="metric-label">Tendência</div>
            </div>
          </div>
        </div>
      )}

      {/* Health Metrics */}
      {metrics && (
        <div>
          <div className="text-xs text-[#718096] uppercase tracking-wider font-semibold mb-3 px-1">Saúde</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div className="metric-card">
              <div className={`metric-value ${blockRate > 5 ? 'text-[#D69E2E]' : 'text-[#718096]'}`}>{blockRate.toFixed(1)}%</div>
              <div className="metric-label">Block Rate</div>
            </div>
            <div className="metric-card">
              <div className={`metric-value ${errorRate > 3 ? 'text-[#E53E3E]' : errorRate > 1 ? 'text-[#D69E2E]' : 'text-[#718096]'}`}>{errorRate.toFixed(1)}%</div>
              <div className="metric-label">Error Rate</div>
            </div>
            <div className="metric-card">
              <div className="metric-value text-[#718096]">{metrics.safeModeActive ? 'ON' : 'OFF'}</div>
              <div className="metric-label">SafeMode</div>
            </div>
            <div className="metric-card">
              <div className="metric-value text-[#718096]">{metrics.healthState === 'CRITICAL' ? 'ON' : 'OFF'}</div>
              <div className="metric-label">Circuit Breaker</div>
            </div>
          </div>
        </div>
      )}

      {/* Error Details */}
      {hasErrors && (
        <div className="saas-card overflow-hidden">
          <button onClick={() => setShowErrors(!showErrors)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-[#F7FAFC] transition-colors">
            <div className="flex items-center gap-2">
              <AlertTriangle size={13} className="text-[#A0AEC0]" />
              <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider">Erros Detectados</span>
              <span className="text-[10px] text-[#A0AEC0] font-mono">{(metrics?.errors?.total ?? 0).toLocaleString()}</span>
            </div>
            {showErrors ? <ChevronUp size={14} className="text-[#A0AEC0]" /> : <ChevronDown size={14} className="text-[#A0AEC0]" />}
          </button>
          {showErrors && metrics && (
            <div className="border-t border-[#E2E8F0] p-5">
              <div className="flex flex-wrap gap-2">
                {metrics.errors.rateLimitErrors > 0 && <ErrorTag label="Rate Limit" count={metrics.errors.rateLimitErrors} />}
                {metrics.errors.payloadErrors > 0 && <ErrorTag label="Payload" count={metrics.errors.payloadErrors} />}
                {metrics.errors.networkErrors > 0 && <ErrorTag label="Rede" count={metrics.errors.networkErrors} />}
                {metrics.errors.authErrors > 0 && <ErrorTag label="Auth" count={metrics.errors.authErrors} critical />}
                {metrics.errors.environmentErrors > 0 && <ErrorTag label="Ambiente" count={metrics.errors.environmentErrors} />}
                {metrics.errors.templateErrors > 0 && <ErrorTag label="Template" count={metrics.errors.templateErrors} />}
                {metrics.errors.timeoutErrors > 0 && <ErrorTag label="Timeout" count={metrics.errors.timeoutErrors} />}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Technical Details */}
      {metrics && (
        <div className="saas-card overflow-hidden">
          <button onClick={() => setShowTechnical(!showTechnical)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-[#F7FAFC] transition-colors">
            <div className="flex items-center gap-2">
              <Gauge size={13} className="text-[#A0AEC0]" />
              <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider">Detalhes Técnicos</span>
            </div>
            {showTechnical ? <ChevronUp size={14} className="text-[#A0AEC0]" /> : <ChevronDown size={14} className="text-[#A0AEC0]" />}
          </button>
          {showTechnical && (
            <div className="border-t border-[#E2E8F0] p-5 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
                <TechCell label="RTT Médio" value={`${(metrics.latency?.avg ?? 0).toFixed(0)}ms`} />
                <TechCell label="p50" value={`${(metrics.latency?.p50 ?? 0).toFixed(0)}ms`} />
                <TechCell label="p95" value={`${(metrics.latency?.p95 ?? 0).toFixed(0)}ms`} warn={(metrics.latency?.p95 ?? 0) > 260} />
                <TechCell label="p99" value={`${(metrics.latency?.p99 ?? 0).toFixed(0)}ms`} warn={(metrics.latency?.p99 ?? 0) > 350} />
              </div>
              <div className="grid grid-cols-3 gap-2 sm:gap-4">
                <TechCell label="Paralelo" value={metrics.burstPhase || 'N/A'} />
                <TechCell label="Pico" value={`${(metrics.peakMsgPerSec ?? 0).toFixed(1)} msg/s`} />
                <TechCell label="SafeMode" value={metrics.safeModeActive ? 'Ativo' : 'Inativo'} warn={metrics.safeModeActive} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Console */}
      <div className="saas-card overflow-hidden">
        <button onClick={() => setShowLog(!showLog)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-[#F7FAFC] transition-colors">
          <div className="flex items-center gap-2">
            <Terminal size={13} className="text-[#A0AEC0]" />
            <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider">Console</span>
            <span className="text-[10px] text-[#A0AEC0] font-mono">{logEntries.length.toLocaleString()}</span>
          </div>
          {showLog ? <ChevronUp size={14} className="text-[#A0AEC0]" /> : <ChevronDown size={14} className="text-[#A0AEC0]" />}
        </button>
        {showLog && (
          <div ref={logContainerRef} className="border-t border-[#E2E8F0] px-4 py-3 max-h-56 overflow-y-auto bg-[#F7FAFC]">
            {logEntries.length === 0 ? (
              <p className="text-[11px] text-[#A0AEC0] text-center py-4 font-mono">Aguardando eventos...</p>
            ) : (
              <div className="space-y-px">
                {logEntries.slice(-100).map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2.5 py-[2px]">
                    <span className="text-[10px] text-[#A0AEC0] w-16 flex-shrink-0 text-right tabular-nums font-mono">{formatEventTime(entry.timestamp)}</span>
                    <span className={`text-[11px] font-mono ${LOG_TYPE_COLORS[entry.type] ?? 'text-[#718096]'} truncate`}>{entry.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Phone Metrics */}
      {phoneMetrics.length > 0 && (
        <div className="saas-card overflow-hidden">
          <button onClick={() => setShowPhones(!showPhones)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-[#F7FAFC] transition-colors">
            <div className="flex items-center gap-2">
              <Phone size={13} className="text-[#A0AEC0]" />
              <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider">Números</span>
              <span className="text-[10px] text-[#A0AEC0] font-mono">{phoneMetrics.length.toLocaleString()}</span>
            </div>
            {showPhones ? <ChevronUp size={14} className="text-[#A0AEC0]" /> : <ChevronDown size={14} className="text-[#A0AEC0]" />}
          </button>
          {showPhones && (
            <div className="border-t border-[#E2E8F0] divide-y divide-[#E2E8F0]">
              {phoneMetrics.map((phone) => (
                <PhoneRow key={phone.phoneNumberId} phone={phone} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Final Summary */}
      {isTerminal && metrics && (
        <div className="saas-card p-6">
          <div className="text-xs text-[#718096] uppercase tracking-wider font-semibold mb-4">Resumo Final</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5 text-sm">
            <Row label="Enviadas" value={(metrics.totalSuccess ?? 0).toLocaleString()} color="text-[#38A169]" />
            <Row label="Bloqueadas Meta" value={metaBlocked.toLocaleString()} color="text-[#D69E2E]" />
            <Row label="Erros reais" value={realErrors.toLocaleString()} color="text-[#E53E3E]" />
            <Row label="Preflight" value={preflightErrors.toLocaleString()} color="text-[#D69E2E]" />
            <Row label="Processados" value={totalProcessed.toLocaleString()} />
            <Row label="Pico" value={`${(metrics.peakMsgPerSec ?? 0).toFixed(1)} msg/s`} />
            <Row label="Duração" value={elapsedDisplay} />
            <Row label="Taxa erro" value={`${errorRate.toFixed(1)}%`} color={errorRate > 3 ? 'text-[#E53E3E]' : undefined} />
          </div>
        </div>
      )}

      {/* Terminal Actions */}
      {isTerminal && (
        <div className="flex justify-center gap-3 pt-1">
          {onNewCampaign && (
            <button onClick={onNewCampaign} className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-[#718096] hover:text-[#1A202C] border border-[#E2E8F0] rounded-lg transition-colors hover:bg-[#F7FAFC]">
              <ArrowLeft size={14} /> Novo Disparo
            </button>
          )}
          {onRetry && (campaignState === 'FAILED' || campaignState === 'BLOCKED') && (
            <button onClick={onRetry} className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-[#718096] hover:text-[#1A202C] border border-[#E2E8F0] rounded-lg transition-colors hover:bg-[#F7FAFC]">
              <RefreshCw size={14} /> Tentar Novamente
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SimpleCampaignStatus(props: SimpleCampaignStatusProps) {
  return (
    <ErrorBoundary onRetry={props.onRetry}>
      <CampaignDashboard {...props} />
    </ErrorBoundary>
  );
}
