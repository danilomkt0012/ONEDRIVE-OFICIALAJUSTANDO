import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useCampaignMetrics } from '@/hooks/useCampaignMetrics';
import { CampaignErrorPanel } from './CampaignErrorPanel';
import { CampaignConsole } from './CampaignConsole';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Activity, Clock, AlertTriangle, CheckCircle, XCircle,
  Pause, Play, Shield, Phone, TrendingUp, TrendingDown, Minus,
  Wifi, WifiOff, Heart, Gauge, Ban, RotateCcw, BarChart3, Mail
} from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';

interface LiveMetricsDashboardProps {
  campaignId: string;
  enabled?: boolean;
}

const stateColors: Record<string, string> = {
  INIT: 'bg-zinc-600',
  RUNNING: 'bg-emerald-500',
  PAUSED: 'bg-amber-500',
  DEGRADED: 'bg-zinc-500',
  PAUSED_BY_ENGINE: 'bg-zinc-600',
  SAFE_MODE: 'bg-red-500',
  RESUMING: 'bg-emerald-400',
  FINALIZING: 'bg-zinc-500',
  COMPLETED: 'bg-emerald-600',
  FAILED: 'bg-red-600',
  FAILED_GRACEFULLY: 'bg-red-600'
};

const stateLabels: Record<string, string> = {
  INIT: 'Inicializando',
  RUNNING: 'Executando',
  PAUSED: 'Pausado',
  DEGRADED: 'Degradado',
  PAUSED_BY_ENGINE: 'Pausado (Engine)',
  SAFE_MODE: 'Modo Seguro',
  RESUMING: 'Retomando',
  FINALIZING: 'Finalizando',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
  FAILED_GRACEFULLY: 'Falha Controlada'
};

const trendIcons = {
  increasing: TrendingUp,
  stable: Minus,
  decreasing: TrendingDown
};

const trendColors = {
  increasing: 'text-red-400',
  stable: 'text-zinc-500',
  decreasing: 'text-emerald-400'
};

export function LiveMetricsDashboard({ campaignId, enabled = true }: LiveMetricsDashboardProps) {
  const { metrics, phoneMetrics, connected, events, logs } = useCampaignMetrics({
    campaignId,
    enabled
  });

  const { data: deliveryMetrics } = useQuery<{
    campaignId: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
    readRate: number;
    avgDeliveryTimeSec: number;
    replied: number;
  }>({
    queryKey: [`/api/campaigns/${campaignId}/delivery-metrics`],
    refetchInterval: 15000,
    enabled,
  });

  const { data: errorLogs = [] } = useQuery<Array<{
    errorCode: string;
    errorMessage: string;
    count: number;
  }>>({
    queryKey: [`/api/campaigns/${campaignId}/error-logs`],
    refetchInterval: 30000,
    enabled,
  });

  const [pauseLoading, setPauseLoading] = useState(false);

  const formatTime = (seconds: number): string => {
    if (seconds <= 0) return '—';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const handlePause = useCallback(async () => {
    setPauseLoading(true);
    try {
      await apiRequest('POST', `/api/campaigns/${campaignId}/pause`);
    } catch (err) {
      console.error('Pause error:', err);
    }
    setPauseLoading(false);
  }, [campaignId]);

  const handleResume = useCallback(async () => {
    setPauseLoading(true);
    try {
      await apiRequest('POST', `/api/campaigns/${campaignId}/resume-live`);
    } catch (err) {
      console.error('Resume error:', err);
    }
    setPauseLoading(false);
  }, [campaignId]);

  if (!metrics) {
    return (
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-8">
        <div className="flex items-center justify-center gap-3">
          <Activity className="h-6 w-6 animate-pulse text-zinc-500" />
          <p className="text-zinc-400">
            {connected ? 'Aguardando métricas...' : 'Conectando ao servidor...'}
          </p>
        </div>
      </div>
    );
  }

  const isPaused = metrics.pauseActive || metrics.state === 'PAUSED';
  const isRunning = metrics.state === 'RUNNING' || metrics.state === 'DEGRADED' || metrics.state === 'SAFE_MODE';
  const isComplete = metrics.state === 'COMPLETED' || metrics.state === 'FINALIZING';
  const TrendIcon = trendIcons[metrics.latency.trend];

  const blockRate = metrics.totalProcessed > 0 
    ? (metrics.metaBlockedCount / metrics.totalProcessed) * 100 
    : 0;
  const errorRate = metrics.totalProcessed > 0 
    ? (metrics.totalFailed / metrics.totalProcessed) * 100 
    : 0;

  const riskLevel = blockRate > 5 ? 'HIGH' : blockRate > 2 ? 'MEDIUM' : 'LOW';
  const riskColor = riskLevel === 'HIGH' ? 'border-red-500/50 bg-red-500/5' 
    : riskLevel === 'MEDIUM' ? 'border-amber-500/50 bg-amber-500/5' 
    : 'border-emerald-500/50 bg-emerald-500/5';
  const riskTextColor = riskLevel === 'HIGH' ? 'text-red-400' 
    : riskLevel === 'MEDIUM' ? 'text-amber-400' 
    : 'text-emerald-400';

  return (
    <div className="space-y-4">
      {/* HEADER FIXO */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 sticky top-0 z-10 backdrop-blur-md">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            {connected ? (
              <Badge className="gap-1 bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                <Wifi className="h-3 w-3" />
                Live
              </Badge>
            ) : (
              <Badge className="gap-1 bg-red-500/20 text-red-400 border-red-500/30">
                <WifiOff className="h-3 w-3" />
                Offline
              </Badge>
            )}
            <Badge className={`${stateColors[metrics.state] || 'bg-zinc-600'} text-black font-medium`}>
              {stateLabels[metrics.state] || metrics.state}
            </Badge>
            {metrics.detectedTier && (
              <Badge className="bg-zinc-800 text-zinc-400 border-zinc-700">
                Tier: {metrics.detectedTier}
              </Badge>
            )}
            {metrics.safeModeActive && (
              <Badge className="gap-1 bg-red-500/20 text-red-400 border-red-500/30">
                <Shield className="h-3 w-3" />
                SafeMode
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right mr-2">
              <div className="text-sm font-mono text-white">
                {metrics.currentMsgPerSec.toFixed(1)} <span className="text-zinc-500 text-xs">msg/s</span>
              </div>
              <div className="text-xs text-zinc-500">
                ETA: {formatTime(metrics.eta.remainingSeconds)}
              </div>
            </div>

            {(isRunning || isPaused) && !isComplete && (
              <div className="flex items-center gap-2">
                {isPaused ? (
                  <Button 
                    size="sm" 
                    onClick={handleResume} 
                    disabled={pauseLoading}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white gap-1"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Retomar
                  </Button>
                ) : (
                  <Button 
                    size="sm" 
                    variant="outline"
                    onClick={handlePause} 
                    disabled={pauseLoading}
                    className="border-amber-500/50 text-amber-400 hover:bg-amber-500/10 gap-1"
                  >
                    <Pause className="h-3.5 w-3.5" />
                    Pausar
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* CARD 1: PROGRESSO */}
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-zinc-300">Progresso</span>
          <span className="text-sm text-zinc-400">
            {formatNumber(metrics.totalProcessed)} / {formatNumber(metrics.totalLeads)}
          </span>
        </div>
        <div className="relative h-3 bg-zinc-800 rounded-full overflow-hidden">
          <div 
            className="absolute inset-y-0 left-0 bg-[#38A169] rounded-full transition-all duration-500 ease-out"
            style={{ width: `${Math.min(metrics.progressPercent, 100)}%` }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-zinc-500">
          <span className="font-mono">{metrics.progressPercent.toFixed(1)}%</span>
          <span>
            ETA: {formatTime(metrics.eta.remainingSeconds)}
            <span className="ml-1 text-zinc-600">
              ({metrics.eta.confidenceLevel === 'high' ? 'alta' : 
                metrics.eta.confidenceLevel === 'medium' ? 'média' : 'baixa'} confiança)
            </span>
          </span>
        </div>
      </div>

      {/* GRID DE CARDS */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* CARD 2: ENVIO */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4 col-span-2 lg:col-span-2">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle className="h-4 w-4 text-emerald-400" />
            <span className="text-sm font-medium text-zinc-300">Envio</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-xl font-bold text-emerald-400 transition-all duration-300">
                {formatNumber(metrics.totalSuccess)}
              </div>
              <div className="text-[10px] text-zinc-500">Accepted</div>
            </div>
            <div>
              <div className="text-xl font-bold text-red-400 transition-all duration-300">
                {formatNumber(metrics.totalFailed)}
              </div>
              <div className="text-[10px] text-zinc-500">Failed</div>
            </div>
            <div>
              <div className="text-xl font-bold text-amber-400 transition-all duration-300">
                {formatNumber(metrics.metaBlockedCount)}
              </div>
              <div className="text-[10px] text-zinc-500">Blocked</div>
            </div>
          </div>
        </div>

        {/* CARD 3: SAÚDE */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Heart className="h-4 w-4 text-zinc-400" />
            <span className="text-sm font-medium text-zinc-300">Saúde</span>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">Block Rate</span>
              <span className={blockRate > 5 ? 'text-red-400' : blockRate > 2 ? 'text-amber-400' : 'text-emerald-400'}>
                {blockRate.toFixed(1)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Error Rate</span>
              <span className={errorRate > 2 ? 'text-red-400' : errorRate > 0.5 ? 'text-amber-400' : 'text-emerald-400'}>
                {errorRate.toFixed(2)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">SafeMode</span>
              <span className={metrics.safeModeActive ? 'text-red-400' : 'text-emerald-400'}>
                {metrics.safeModeActive ? 'Ativo' : 'Inativo'}
              </span>
            </div>
          </div>
        </div>

        {/* CARD 4: PERFORMANCE */}
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Gauge className="h-4 w-4 text-zinc-400" />
            <span className="text-sm font-medium text-zinc-300">Performance</span>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-500">Atual</span>
              <span className="text-white font-mono">{metrics.currentMsgPerSec.toFixed(1)}/s</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Média</span>
              <span className="text-zinc-300 font-mono">{metrics.avgMsgPerSec.toFixed(1)}/s</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">RTT p95</span>
              <span className="text-zinc-300 font-mono">{metrics.latency.p95.toFixed(0)}ms</span>
            </div>
          </div>
        </div>

        {/* CARD 5: RISCO */}
        <div className={`rounded-xl p-4 border transition-all duration-500 ${riskColor}`}>
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className={`h-4 w-4 ${riskTextColor}`} />
            <span className="text-sm font-medium text-zinc-300">Risco</span>
          </div>
          <div className="text-center">
            <div className={`text-2xl font-bold ${riskTextColor} transition-all duration-300`}>
              {riskLevel === 'HIGH' ? 'ALTO' : riskLevel === 'MEDIUM' ? 'MÉDIO' : 'BAIXO'}
            </div>
            <div className="text-[10px] text-zinc-500 mt-1">
              {riskLevel === 'HIGH' ? 'Block rate > 5%' : riskLevel === 'MEDIUM' ? 'Block rate 2-5%' : 'Operação segura'}
            </div>
          </div>
        </div>
      </div>

      {/* LATÊNCIA DETALHADA */}
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-300">Latência</span>
          <div className="ml-auto flex items-center gap-1 text-xs">
            <TrendIcon className={`h-3 w-3 ${trendColors[metrics.latency.trend]}`} />
            <span className={trendColors[metrics.latency.trend]}>
              {metrics.latency.trend === 'increasing' ? 'subindo' : 
               metrics.latency.trend === 'decreasing' ? 'caindo' : 'estável'}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-lg font-semibold text-white font-mono">{metrics.latency.avg.toFixed(0)}</div>
            <div className="text-[10px] text-zinc-500">Média (ms)</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-white font-mono">{metrics.latency.p50.toFixed(0)}</div>
            <div className="text-[10px] text-zinc-500">p50 (ms)</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-zinc-300 font-mono">{metrics.latency.p95.toFixed(0)}</div>
            <div className="text-[10px] text-zinc-500">p95 (ms)</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-red-400 font-mono">{metrics.latency.p99.toFixed(0)}</div>
            <div className="text-[10px] text-zinc-500">p99 (ms)</div>
          </div>
        </div>
      </div>

      {/* DELIVERY METRICS (from webhook data) */}
      {deliveryMetrics && (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <BarChart3 className="h-4 w-4 text-emerald-500" />
            <span className="text-sm font-medium text-zinc-300">Delivery Metrics (Webhook)</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-emerald-400 font-mono">
                {deliveryMetrics.deliveryRate}%
              </div>
              <div className="text-[10px] text-zinc-500">Taxa Entrega</div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-purple-400 font-mono">
                {deliveryMetrics.readRate}%
              </div>
              <div className="text-[10px] text-zinc-500">Taxa Leitura</div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-blue-400 font-mono">
                {deliveryMetrics.avgDeliveryTimeSec}s
              </div>
              <div className="text-[10px] text-zinc-500">Tempo Médio Entrega</div>
            </div>
            <div className="bg-zinc-800/50 rounded-lg p-3 text-center">
              <div className="text-lg font-bold text-red-400 font-mono">
                {deliveryMetrics.failed}
              </div>
              <div className="text-[10px] text-zinc-500">Falhas Confirmadas</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs text-zinc-400">
            <div>
              <span className="text-zinc-300 font-medium">{deliveryMetrics.sent}</span> Enviadas
            </div>
            <div>
              <span className="text-emerald-400 font-medium">{deliveryMetrics.delivered}</span> Entregues
            </div>
            <div>
              <span className="text-purple-400 font-medium">{deliveryMetrics.read}</span> Lidas
            </div>
          </div>
        </div>
      )}

      {/* STRUCTURED ERROR LOGS */}
      {errorLogs.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <span className="text-sm font-medium text-zinc-300">Erros Estruturados ({errorLogs.length})</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {errorLogs.slice(0, 20).map((err, i) => (
              <div key={i} className="flex items-center justify-between text-xs p-2 bg-zinc-800/50 rounded">
                <div className="flex items-center gap-2">
                  <Badge className="text-[9px] bg-red-500/20 text-red-400 border-red-500/30">
                    {err.errorCode}
                  </Badge>
                  <span className="text-zinc-400 truncate max-w-[300px]">{err.errorMessage}</span>
                </div>
                <span className="text-zinc-500 font-mono">{err.count}x</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ERROS */}
      <CampaignErrorPanel errors={metrics.errors} events={events} />

      {/* NÚMEROS DE TELEFONE */}
      {phoneMetrics.length > 0 && (
        <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Phone className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-medium text-zinc-300">Números ({phoneMetrics.length})</span>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {phoneMetrics.map((phone) => (
              <div 
                key={phone.phoneNumberId} 
                className="flex items-center justify-between p-2 bg-zinc-800/50 rounded-lg text-sm"
              >
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    phone.healthState === 'HEALTHY' ? 'bg-emerald-500' :
                    phone.healthState === 'DEGRADED' ? 'bg-amber-400' : 'bg-red-500'
                  }`} />
                  <span className="font-medium text-white text-xs">{phone.displayPhone}</span>
                  {phone.safeModeActive && (
                    <Badge className="text-[9px] bg-red-500/20 text-red-400 border-red-500/30">Safe</Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                  <span className="text-emerald-400">{phone.messagesSuccess}</span>
                  <span className="text-red-400">{phone.messagesFailed}</span>
                  <span className="font-mono">{phone.currentRate.toFixed(1)}/s</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* CONSOLE LIVE */}
      <CampaignConsole logs={logs} />
    </div>
  );
}
