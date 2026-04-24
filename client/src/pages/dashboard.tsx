import type { ElementType } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Users, 
  Send, 
  CheckCircle, 
  Megaphone, 
  XCircle,
  BarChart3,
  Clock,
  Activity,
  Eye,
  AlertTriangle,
  Gauge,
  Phone,
  FileText,
  RefreshCw,
} from "lucide-react";
import type { DashboardStats } from "@/lib/types";
import type { Campaign } from "@shared/schema";

function StatsCard({ title, value, icon: Icon, color, subtitle }: {
  title: string;
  value: string | number;
  icon: ElementType;
  color: string;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent className="p-3 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">{title}</p>
            <p className="text-xl sm:text-3xl font-bold text-gray-900">{value}</p>
            {subtitle && (
              <p className="text-[10px] sm:text-xs text-gray-500 mt-1">{subtitle}</p>
            )}
          </div>
          <div className={`w-8 h-8 sm:w-12 sm:h-12 ${color} rounded-lg flex items-center justify-center flex-shrink-0`}>
            <Icon className="text-white" size={18} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ActiveCampaignCard({ campaign, onClick }: { campaign: Campaign; onClick: () => void }) {
  const sent = campaign.sentMessages || campaign.sentCount || 0;
  const failed = campaign.failedMessages || campaign.failedCount || 0;
  const success = campaign.successMessages || 0;
  const total = campaign.totalLeads || 0;
  const processed = sent + failed;
  const progress = total > 0 ? (processed / total) * 100 : 0;
  const pending = Math.max(0, total - processed);

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'running': return { label: 'Enviando', color: 'bg-slate-100 text-slate-700', dot: 'bg-[#0066FF]' };
      case 'completed': return { label: 'Concluída', color: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' };
      case 'paused': return { label: 'Pausada', color: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' };
      case 'failed': return { label: 'Falhou', color: 'bg-red-100 text-red-700', dot: 'bg-red-500' };
      default: return { label: status, color: 'bg-gray-100 text-gray-700', dot: 'bg-gray-500' };
    }
  };

  const sc = getStatusConfig(campaign.status);

  return (
    <div className="border border-gray-200 rounded-lg p-4 cursor-pointer hover:bg-gray-50 transition-colors" onClick={onClick}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-3">
          <h4 className="font-medium text-gray-900">{campaign.name}</h4>
          <Badge className={sc.color}>
            <div className={`w-2 h-2 rounded-full ${sc.dot} mr-1.5`} />
            {sc.label}
          </Badge>
        </div>
        {campaign.status === 'running' && (
          <span className="text-xs text-gray-500">
            <Clock size={12} className="inline mr-1" />
            {campaign.estimatedTime || 'Calculando...'}
          </span>
        )}
      </div>
      
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 sm:gap-3 mb-4">
        <div className="text-center">
          <p className="text-xl font-bold text-gray-900">{total.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Total</p>
        </div>
        <div className="text-center">
          <p className="text-xl font-bold text-green-600">{success.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Sucesso</p>
        </div>
        <div className="text-center">
          <p className="text-xl font-bold text-blue-600">{sent.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Enviadas</p>
        </div>
        <div className="text-center">
          <p className="text-xl font-bold text-red-500">{failed.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Falhas</p>
        </div>
        <div className="text-center">
          <p className="text-xl font-bold text-amber-600">{pending.toLocaleString()}</p>
          <p className="text-xs text-gray-500">Pendentes</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">Progresso</span>
          <span className="font-medium text-gray-900">{progress.toFixed(1)}%</span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>
    </div>
  );
}

interface QualityDashboardData {
  templates: Array<{
    name: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
    readRate: number;
    failRate: number;
  }>;
  phones: Array<{
    phoneNumberId: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
    readRate: number;
    failRate: number;
  }>;
  overall: {
    totalSent: number;
    totalDelivered: number;
    totalRead: number;
    totalFailed: number;
    overallDeliveryRate: number;
    overallReadRate: number;
    overallFailRate: number;
  };
  windowedRates: {
    windowMs: number;
    sent: number;
    delivered: number;
    deliveryRate: number;
    gapRate: number;
  };
  autoPaused: boolean;
  autoPauseReason: string | null;
  pacing: {
    status: 'healthy' | 'warning' | 'critical';
    activeEngines: number;
    reduceThreshold: number;
    pauseThreshold: number;
  };
}

function rateColor(rate: number): string {
  if (rate >= 0.8) return "text-green-600";
  if (rate >= 0.6) return "text-yellow-600";
  return "text-red-600";
}

function rateBadge(rate: number) {
  if (rate >= 0.8) return <Badge className="bg-green-100 text-green-700">Bom</Badge>;
  if (rate >= 0.6) return <Badge className="bg-yellow-100 text-yellow-700">Atenção</Badge>;
  return <Badge className="bg-red-100 text-red-700">Crítico</Badge>;
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard/stats"],
    refetchInterval: 3000,
  });

  const { data: allCampaigns = [], isLoading: campaignsLoading } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
    refetchInterval: 3000,
  });

  const { data: activeCampaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns/active"],
    refetchInterval: 2000,
  });

  const { data: qualityData } = useQuery<QualityDashboardData>({
    queryKey: ["/api/quality-dashboard"],
    refetchInterval: 5000,
  });

  const resetPause = useMutation({
    mutationFn: () =>
      fetch("/api/quality-dashboard/reset-pause", { method: "POST" }).then((r) => r.json()),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/quality-dashboard"] }),
  });

  const recentCampaigns = allCampaigns.slice(0, 5);

  if (statsLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-gray-200 rounded w-64" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-gray-200 rounded-lg h-32" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-xs sm:text-sm text-gray-500">Monitoramento global de campanhas e qualidade de envio</p>
        </div>
        <div className="flex items-center gap-3">
          {(stats?.activeCampaigns || 0) > 0 && (
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 bg-[#38A169] rounded-full" />
              <span className="text-xs sm:text-sm text-[#38A169] font-medium">
                {stats?.activeCampaigns} ativa(s)
              </span>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
              queryClient.invalidateQueries({ queryKey: ["/api/quality-dashboard"] });
            }}
          >
            <RefreshCw className="w-4 h-4 mr-1" />
            <span className="hidden sm:inline">Atualizar</span>
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview" className="gap-1">
            <BarChart3 className="w-4 h-4" /> Visao Geral
          </TabsTrigger>
          <TabsTrigger value="quality" className="gap-1">
            <Gauge className="w-4 h-4" /> Qualidade de Envio
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
            <StatsCard title="Total de Leads" value={stats?.totalLeads?.toLocaleString() || "0"} icon={Users} color="bg-blue-500" />
            <StatsCard title="Mensagens Enviadas" value={stats?.messagesSent?.toLocaleString() || "0"} icon={Send} color="bg-indigo-500" />
            <StatsCard title="Sucesso" value={stats?.messagesSuccess?.toLocaleString() || "0"} icon={CheckCircle} color="bg-green-500" />
            <StatsCard title="Total de Erros" value={stats?.messagesFailed?.toLocaleString() || "0"} icon={XCircle} color="bg-red-500" />
            <StatsCard title="Taxa de Entrega" value={`${stats?.deliveryRate || 0}%`} icon={BarChart3} color="bg-amber-500" />
            <StatsCard title="Campanhas" value={`${stats?.activeCampaigns || 0} / ${stats?.totalCampaigns || 0}`} icon={Megaphone} color="bg-purple-500" subtitle="ativas / total" />
          </div>

          {activeCampaigns.length > 0 && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 bg-[#38A169] rounded-full" />
                    Campanhas em Tempo Real
                  </CardTitle>
                  <Badge variant="outline" className="text-slate-600 border-slate-200">
                    {activeCampaigns.length} ativa(s)
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {activeCampaigns.map((campaign) => (
                    <ActiveCampaignCard
                      key={campaign.id}
                      campaign={campaign}
                      onClick={() => navigate(`/campaigns/${campaign.id}`)}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {recentCampaigns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Campanhas Recentes</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {recentCampaigns.map((campaign) => {
                    const sent = campaign.sentMessages || campaign.sentCount || 0;
                    const failed = campaign.failedMessages || campaign.failedCount || 0;
                    const total = campaign.totalLeads || 0;
                    const progress = total > 0 ? ((sent + failed) / total) * 100 : 0;

                    const statusConfig: Record<string, { label: string; color: string }> = {
                      running: { label: 'Enviando', color: 'bg-blue-100 text-blue-700' },
                      completed: { label: 'Concluída', color: 'bg-green-100 text-green-700' },
                      paused: { label: 'Pausada', color: 'bg-yellow-100 text-yellow-700' },
                      failed: { label: 'Falhou', color: 'bg-red-100 text-red-700' },
                      draft: { label: 'Rascunho', color: 'bg-gray-100 text-gray-700' },
                    };
                    const sc = statusConfig[campaign.status] || { label: campaign.status, color: 'bg-gray-100 text-gray-700' };

                    return (
                      <div
                        key={campaign.id}
                        className="flex items-center justify-between p-3 border border-gray-100 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
                        onClick={() => navigate(`/campaigns/${campaign.id}`)}
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 truncate">{campaign.name}</p>
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                              <span>{total.toLocaleString()} leads</span>
                              <span className="text-green-600">{(campaign.successMessages || 0).toLocaleString()} sucesso</span>
                              {failed > 0 && <span className="text-red-500">{failed.toLocaleString()} erros</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 ml-3">
                          <div className="w-24">
                            <Progress value={progress} className="h-1.5" />
                            <p className="text-[10px] text-gray-400 text-right mt-0.5">{progress.toFixed(0)}%</p>
                          </div>
                          <Badge className={sc.color}>{sc.label}</Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {allCampaigns.length === 0 && !campaignsLoading && (
            <Card>
              <CardContent className="p-12 text-center">
                <Megaphone className="mx-auto text-gray-300 mb-4" size={48} />
                <h3 className="text-lg font-medium text-gray-700">Nenhuma campanha ainda</h3>
                <p className="text-gray-500 mt-2">Crie sua primeira campanha na página de Campanhas.</p>
                <Button className="mt-4" onClick={() => navigate("/campaigns")}>
                  Ir para Campanhas
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="quality" className="mt-4 space-y-6">
          {!qualityData ? (
            <div className="animate-pulse space-y-4">
              <div className="grid grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-24 bg-gray-200 rounded" />
                ))}
              </div>
            </div>
          ) : (
            <>
              {qualityData.autoPaused && (
                <Card className="border-red-300 bg-red-50">
                  <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0" />
                      <div>
                        <p className="font-semibold text-red-800 text-sm sm:text-base">Envio Pausado Automaticamente</p>
                        <p className="text-xs sm:text-sm text-red-600">{qualityData.autoPauseReason}</p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-300 text-red-700 hover:bg-red-100 min-h-[44px] w-full sm:w-auto"
                      onClick={() => resetPause.mutate()}
                      disabled={resetPause.isPending}
                    >
                      Retomar Envio
                    </Button>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <Gauge className={`w-5 h-5 flex-shrink-0 ${qualityData.pacing.status === 'healthy' ? 'text-green-600' : qualityData.pacing.status === 'warning' ? 'text-yellow-600' : 'text-red-600'}`} />
                    <div>
                      <p className="font-semibold text-sm sm:text-base">
                        Pacing: {qualityData.pacing.status === 'healthy' ? 'Saudável' : qualityData.pacing.status === 'warning' ? 'Atenção' : 'Crítico'}
                      </p>
                      <p className="text-xs sm:text-sm text-gray-500">
                        {qualityData.pacing.activeEngines} engine(s) | Redução: {(qualityData.pacing.reduceThreshold * 100).toFixed(0)}% | Pausa: {(qualityData.pacing.pauseThreshold * 100).toFixed(0)}%
                      </p>
                    </div>
                  </div>
                  {rateBadge(qualityData.pacing.status === 'healthy' ? 1 : qualityData.pacing.status === 'warning' ? 0.7 : 0.3)}
                </CardContent>
              </Card>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                <Card>
                  <CardContent className="p-3 sm:p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Activity className="w-4 h-4 text-blue-500" />
                      <span className="text-sm text-gray-500">Enviados</span>
                    </div>
                    <p className="text-2xl font-bold">{qualityData.overall.totalSent}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle className="w-4 h-4 text-green-500" />
                      <span className="text-sm text-gray-500">Entregues</span>
                    </div>
                    <p className="text-2xl font-bold">{qualityData.overall.totalDelivered}</p>
                    <p className={`text-sm ${rateColor(qualityData.overall.overallDeliveryRate)}`}>
                      {(qualityData.overall.overallDeliveryRate * 100).toFixed(1)}%
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Eye className="w-4 h-4 text-purple-500" />
                      <span className="text-sm text-gray-500">Lidos</span>
                    </div>
                    <p className="text-2xl font-bold">{qualityData.overall.totalRead}</p>
                    <p className={`text-sm ${rateColor(qualityData.overall.overallReadRate)}`}>
                      {(qualityData.overall.overallReadRate * 100).toFixed(1)}%
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <XCircle className="w-4 h-4 text-red-500" />
                      <span className="text-sm text-gray-500">Falhas</span>
                    </div>
                    <p className="text-2xl font-bold">{qualityData.overall.totalFailed}</p>
                    <p className={`text-sm ${rateColor(1 - qualityData.overall.overallFailRate)}`}>
                      {(qualityData.overall.overallFailRate * 100).toFixed(1)}%
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Gauge className="w-5 h-5" />
                    Janela de {qualityData.windowedRates.windowMs / 1000}s (Tempo Real)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-sm text-gray-500">Enviados (janela)</p>
                      <p className="text-xl font-semibold">{qualityData.windowedRates.sent}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Entregues (janela)</p>
                      <p className="text-xl font-semibold">{qualityData.windowedRates.delivered}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Taxa de Entrega</p>
                      <p className={`text-xl font-semibold ${rateColor(qualityData.windowedRates.deliveryRate)}`}>
                        {(qualityData.windowedRates.deliveryRate * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Gap Rate</p>
                      <p className={`text-xl font-semibold ${rateColor(1 - qualityData.windowedRates.gapRate)}`}>
                        {(qualityData.windowedRates.gapRate * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <Progress value={qualityData.windowedRates.deliveryRate * 100} className="h-2" />
                  </div>
                </CardContent>
              </Card>

              {qualityData.templates.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <FileText className="w-5 h-5" /> Métricas por Template
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-gray-500">
                            <th className="pb-2 pr-4">Template</th>
                            <th className="pb-2 pr-4 text-right">Enviados</th>
                            <th className="pb-2 pr-4 text-right">Entregues</th>
                            <th className="pb-2 pr-4 text-right">Lidos</th>
                            <th className="pb-2 pr-4 text-right">Falhas</th>
                            <th className="pb-2 pr-4 text-right">Taxa Entrega</th>
                            <th className="pb-2 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {qualityData.templates.map((tpl) => (
                            <tr key={tpl.name} className="border-b last:border-0">
                              <td className="py-2 pr-4 font-medium">{tpl.name}</td>
                              <td className="py-2 pr-4 text-right">{tpl.sent}</td>
                              <td className="py-2 pr-4 text-right">{tpl.delivered}</td>
                              <td className="py-2 pr-4 text-right">{tpl.read}</td>
                              <td className="py-2 pr-4 text-right">{tpl.failed}</td>
                              <td className={`py-2 pr-4 text-right font-semibold ${rateColor(tpl.deliveryRate)}`}>
                                {(tpl.deliveryRate * 100).toFixed(1)}%
                              </td>
                              <td className="py-2 text-center">{rateBadge(tpl.deliveryRate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {qualityData.phones.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-lg flex items-center gap-2">
                      <Phone className="w-5 h-5" /> Métricas por Número
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left text-gray-500">
                            <th className="pb-2 pr-4">Número</th>
                            <th className="pb-2 pr-4 text-right">Enviados</th>
                            <th className="pb-2 pr-4 text-right">Entregues</th>
                            <th className="pb-2 pr-4 text-right">Lidos</th>
                            <th className="pb-2 pr-4 text-right">Falhas</th>
                            <th className="pb-2 pr-4 text-right">Taxa Entrega</th>
                            <th className="pb-2 text-center">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {qualityData.phones.map((ph) => (
                            <tr key={ph.phoneNumberId} className="border-b last:border-0">
                              <td className="py-2 pr-4 font-mono text-xs">{ph.phoneNumberId}</td>
                              <td className="py-2 pr-4 text-right">{ph.sent}</td>
                              <td className="py-2 pr-4 text-right">{ph.delivered}</td>
                              <td className="py-2 pr-4 text-right">{ph.read}</td>
                              <td className="py-2 pr-4 text-right">{ph.failed}</td>
                              <td className={`py-2 pr-4 text-right font-semibold ${rateColor(ph.deliveryRate)}`}>
                                {(ph.deliveryRate * 100).toFixed(1)}%
                              </td>
                              <td className="py-2 text-center">{rateBadge(ph.deliveryRate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              )}

              {qualityData.templates.length === 0 && qualityData.phones.length === 0 && (
                <Card>
                  <CardContent className="p-8 text-center text-gray-500">
                    <Activity className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p className="text-lg font-medium">Nenhuma métrica de envio disponível</p>
                    <p className="text-sm mt-1">As métricas aparecerão quando uma campanha estiver em andamento</p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
