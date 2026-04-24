import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Eye,
  RefreshCw,
  Gauge,
  Phone,
  FileText,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";

interface QualityDashboardData {
  templates: Array<{
    name: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
    readRate: number;
    responseRate: number;
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
    responseRate: number;
    failRate: number;
  }>;
  overall: {
    totalSent: number;
    totalDelivered: number;
    totalRead: number;
    totalFailed: number;
    overallDeliveryRate: number;
    overallReadRate: number;
    overallResponseRate: number;
    overallFailRate: number;
  };
  windowedRates: {
    windowMs: number;
    sent: number;
    delivered: number;
    deliveryRate: number;
    gapRate: number;
    readRate: number;
    responseRate: number;
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

interface TemplateIntelligenceData {
  templates: Array<{
    templateName: string;
    sent: number;
    replies: number;
    blocked: number;
    ctr: number;
    blockRate: number;
    score: number;
    needsRotation: boolean;
    lastUpdated: number;
  }>;
  updatedAt: string;
}

function safeRate(rate: number | undefined | null): number {
  return typeof rate === 'number' && isFinite(rate) ? rate : 0;
}

interface HealthScoreData {
  score: number;
  grade: string;
  deliveryRate: number;
  blockRate: number;
  avgTemplateScore: number;
  risks: string[];
  status: 'healthy' | 'degraded' | 'critical';
  updatedAt: string;
}

function rateColor(rate: number): string {
  if (rate >= 0.8) return "text-green-600";
  if (rate >= 0.6) return "text-yellow-600";
  return "text-red-600";
}

function rateBadge(rate: number) {
  if (rate >= 0.8)
    return <Badge className="bg-green-100 text-green-700">Bom</Badge>;
  if (rate >= 0.6)
    return <Badge className="bg-yellow-100 text-yellow-700">Atenção</Badge>;
  return <Badge className="bg-red-100 text-red-700">Crítico</Badge>;
}

function healthGradeColor(grade: string): string {
  if (grade === 'A') return "text-green-600";
  if (grade === 'B') return "text-blue-600";
  if (grade === 'C') return "text-yellow-600";
  if (grade === 'D') return "text-orange-600";
  return "text-red-600";
}

export default function QualityDashboard() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<QualityDashboardData>({
    queryKey: ["/api/quality-dashboard"],
    refetchInterval: 5000,
  });

  const { data: templateIntel } = useQuery<TemplateIntelligenceData>({
    queryKey: ["/api/template-intelligence"],
    refetchInterval: 10000,
  });

  const { data: healthScore } = useQuery<HealthScoreData>({
    queryKey: ["/api/health-score"],
    refetchInterval: 15000,
  });

  const resetPause = useMutation({
    mutationFn: () =>
      fetch("/api/quality-dashboard/reset-pause", { method: "POST" }).then(
        (r) => r.json()
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/quality-dashboard"] }),
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/quality-dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["/api/template-intelligence"] });
    queryClient.invalidateQueries({ queryKey: ["/api/health-score"] });
  };

  if (isLoading || !data) {
    return (
      <div className="p-3 sm:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-64" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 bg-gray-200 rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const { overall, windowedRates, autoPaused, autoPauseReason } = data;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">
            Painel de Qualidade
          </h1>
          <p className="text-sm text-gray-500">
            Métricas de entrega em tempo real por template e número
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
        >
          <RefreshCw className="w-4 h-4 mr-1" />
          Atualizar
        </Button>
      </div>

      {healthScore && (
        <Card className={`border-2 ${healthScore.status === 'healthy' ? 'border-green-300 bg-green-50' : healthScore.status === 'degraded' ? 'border-yellow-300 bg-yellow-50' : 'border-red-300 bg-red-50'}`}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className={`w-7 h-7 ${healthScore.status === 'healthy' ? 'text-green-600' : healthScore.status === 'degraded' ? 'text-yellow-600' : 'text-red-600'}`} />
                <div>
                  <p className="text-sm font-semibold text-gray-700">Health Score da Conta</p>
                  <p className="text-xs text-gray-500">Entrega + Templates + Block Rate</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-center">
                  <p className={`text-4xl font-black ${healthGradeColor(healthScore.grade)}`}>{healthScore.grade}</p>
                  <p className="text-xs text-gray-500">{healthScore.score}/100</p>
                </div>
                <div className="space-y-1 text-xs text-gray-600 min-w-[140px]">
                  <div className="flex justify-between"><span>Entrega:</span><span className={rateColor(healthScore.deliveryRate)}>{(healthScore.deliveryRate * 100).toFixed(1)}%</span></div>
                  <div className="flex justify-between"><span>Block rate:</span><span className={rateColor(1 - healthScore.blockRate)}>{(healthScore.blockRate * 100).toFixed(1)}%</span></div>
                  <div className="flex justify-between"><span>Score template:</span><span className={rateColor(healthScore.avgTemplateScore)}>{(healthScore.avgTemplateScore * 100).toFixed(0)}%</span></div>
                </div>
              </div>
            </div>
            {healthScore.risks.length > 0 && (
              <div className="mt-3 space-y-1">
                {healthScore.risks.map((risk, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-red-700 bg-red-100 rounded px-2 py-1">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    {risk}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {autoPaused && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              <div>
                <p className="font-semibold text-red-800">
                  Envio Pausado Automaticamente
                </p>
                <p className="text-sm text-red-600">{autoPauseReason}</p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-red-300 text-red-700 hover:bg-red-100"
              onClick={() => resetPause.mutate()}
              disabled={resetPause.isPending}
            >
              Retomar Envio
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className={`border-${data.pacing.status === 'healthy' ? 'green' : data.pacing.status === 'warning' ? 'yellow' : 'red'}-200`}>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gauge className={`w-5 h-5 ${data.pacing.status === 'healthy' ? 'text-green-600' : data.pacing.status === 'warning' ? 'text-yellow-600' : 'text-red-600'}`} />
            <div>
              <p className="font-semibold">
                Pacing: {data.pacing.status === 'healthy' ? 'Saudável' : data.pacing.status === 'warning' ? 'Atenção' : 'Crítico'}
              </p>
              <p className="text-sm text-gray-500">
                {data.pacing.activeEngines} engine(s) ativa(s) | Limiar redução: {(data.pacing.reduceThreshold * 100).toFixed(0)}% | Limiar pausa: {(data.pacing.pauseThreshold * 100).toFixed(0)}%
              </p>
            </div>
          </div>
          {rateBadge(data.pacing.status === 'healthy' ? 1 : data.pacing.status === 'warning' ? 0.7 : 0.3)}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-blue-500" />
              <span className="text-sm text-gray-500">Enviados</span>
            </div>
            <p className="text-2xl font-bold">{overall.totalSent}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-4 h-4 text-green-500" />
              <span className="text-sm text-gray-500">Entregues</span>
            </div>
            <p className="text-2xl font-bold">{overall.totalDelivered}</p>
            <p className={`text-sm ${rateColor(overall.overallDeliveryRate)}`}>
              {(overall.overallDeliveryRate * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Eye className="w-4 h-4 text-purple-500" />
              <span className="text-sm text-gray-500">Visualização</span>
            </div>
            <p className="text-2xl font-bold">{overall.totalRead}</p>
            <p className={`text-sm ${rateColor(safeRate(overall.overallReadRate))}`}>
              {(safeRate(overall.overallReadRate) * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Activity className="w-4 h-4 text-blue-400" />
              <span className="text-sm text-gray-500">Resposta</span>
            </div>
            <p className={`text-2xl font-bold ${rateColor(safeRate(overall.overallResponseRate))}`}>
              {(safeRate(overall.overallResponseRate) * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="w-4 h-4 text-red-500" />
              <span className="text-sm text-gray-500">Falhas</span>
            </div>
            <p className="text-2xl font-bold">{overall.totalFailed}</p>
            <p className={`text-sm ${rateColor(1 - safeRate(overall.overallFailRate))}`}>
              {(safeRate(overall.overallFailRate) * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Gauge className="w-5 h-5" />
            Janela de {windowedRates.windowMs / 1000}s (Tempo Real)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div>
              <p className="text-sm text-gray-500">Enviados (janela)</p>
              <p className="text-xl font-semibold">{windowedRates.sent}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Entregues (janela)</p>
              <p className="text-xl font-semibold">{windowedRates.delivered}</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Taxa de Entrega</p>
              <p
                className={`text-xl font-semibold ${rateColor(safeRate(windowedRates.deliveryRate))}`}
              >
                {(safeRate(windowedRates.deliveryRate) * 100).toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Visualização</p>
              <p
                className={`text-xl font-semibold ${rateColor(safeRate(windowedRates.readRate))}`}
              >
                {(safeRate(windowedRates.readRate) * 100).toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Resposta</p>
              <p
                className={`text-xl font-semibold ${rateColor(safeRate(windowedRates.responseRate))}`}
              >
                {(safeRate(windowedRates.responseRate) * 100).toFixed(1)}%
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Gap Rate</p>
              <p
                className={`text-xl font-semibold ${rateColor(1 - safeRate(windowedRates.gapRate))}`}
              >
                {(safeRate(windowedRates.gapRate) * 100).toFixed(1)}%
              </p>
            </div>
          </div>
          <div className="mt-3">
            <Progress
              value={windowedRates.deliveryRate * 100}
              className="h-2"
            />
          </div>
        </CardContent>
      </Card>

      {templateIntel && templateIntel.templates.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <RotateCcw className="w-5 h-5 text-purple-500" />
              Template Intelligence
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              {(() => {
                const deliveryByName = new Map(data.templates.map(t => [t.name, t]));
                return (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-gray-500">
                    <th className="pb-2 pr-4">Template</th>
                    <th className="pb-2 pr-4 text-right">Enviados</th>
                    <th className="pb-2 pr-4 text-right">Resposta (qtd)</th>
                    <th className="pb-2 pr-4 text-right">Visualização (%)</th>
                    <th className="pb-2 pr-4 text-right">Resposta (%)</th>
                    <th className="pb-2 pr-4 text-right">Block Rate</th>
                    <th className="pb-2 pr-4 text-right">Score</th>
                    <th className="pb-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {templateIntel.templates.map((tpl) => {
                    const tplDelivery = deliveryByName.get(tpl.templateName);
                    return (
                    <tr key={tpl.templateName} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{tpl.templateName}</td>
                      <td className="py-2 pr-4 text-right">{tpl.sent}</td>
                      <td className="py-2 pr-4 text-right">{tpl.replies}</td>
                      <td className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(tplDelivery?.readRate))}`}>
                        {(safeRate(tplDelivery?.readRate) * 100).toFixed(1)}%
                      </td>
                      <td className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(tplDelivery?.responseRate ?? tpl.ctr))}`}>
                        {(safeRate(tplDelivery?.responseRate ?? tpl.ctr) * 100).toFixed(1)}%
                      </td>
                      <td className={`py-2 pr-4 text-right font-semibold ${rateColor(1 - safeRate(tpl.blockRate))}`}>
                        {(safeRate(tpl.blockRate) * 100).toFixed(1)}%
                      </td>
                      <td className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(tpl.score))}`}>
                        {(safeRate(tpl.score) * 100).toFixed(0)}%
                      </td>
                      <td className="py-2 text-center">
                        {tpl.needsRotation ? (
                          <Badge className="bg-red-100 text-red-700 flex items-center gap-1 w-fit mx-auto">
                            <RotateCcw className="w-3 h-3" /> Rotacionar
                          </Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-700">OK</Badge>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
                );
              })()}
            </div>
          </CardContent>
        </Card>
      )}

      {data.templates.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Métricas por Template
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
                    <th className="pb-2 pr-4 text-right">Visualização (qtd)</th>
                    <th className="pb-2 pr-4 text-right">Falhas</th>
                    <th className="pb-2 pr-4 text-right">Taxa Entrega</th>
                    <th className="pb-2 pr-4 text-right">Visualização (%)</th>
                    <th className="pb-2 pr-4 text-right">Resposta (%)</th>
                    <th className="pb-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.templates.map((tpl) => (
                    <tr key={tpl.name} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{tpl.name}</td>
                      <td className="py-2 pr-4 text-right">{tpl.sent}</td>
                      <td className="py-2 pr-4 text-right">{tpl.delivered}</td>
                      <td className="py-2 pr-4 text-right">{tpl.read}</td>
                      <td className="py-2 pr-4 text-right">{tpl.failed}</td>
                      <td
                        className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(tpl.deliveryRate))}`}
                      >
                        {(safeRate(tpl.deliveryRate) * 100).toFixed(1)}%
                      </td>
                      <td
                        className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(tpl.readRate))}`}
                      >
                        {(safeRate(tpl.readRate) * 100).toFixed(1)}%
                      </td>
                      <td
                        className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(tpl.responseRate))}`}
                      >
                        {(safeRate(tpl.responseRate) * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 text-center">
                        {rateBadge(safeRate(tpl.deliveryRate))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {data.phones.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Phone className="w-5 h-5" />
              Métricas por Número
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
                    <th className="pb-2 pr-4 text-right">Visualização (qtd)</th>
                    <th className="pb-2 pr-4 text-right">Falhas</th>
                    <th className="pb-2 pr-4 text-right">Taxa Entrega</th>
                    <th className="pb-2 pr-4 text-right">Visualização (%)</th>
                    <th className="pb-2 pr-4 text-right">Resposta (%)</th>
                    <th className="pb-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.phones.map((ph) => (
                    <tr
                      key={ph.phoneNumberId}
                      className="border-b last:border-0"
                    >
                      <td className="py-2 pr-4 font-mono text-xs">
                        {ph.phoneNumberId}
                      </td>
                      <td className="py-2 pr-4 text-right">{ph.sent}</td>
                      <td className="py-2 pr-4 text-right">{ph.delivered}</td>
                      <td className="py-2 pr-4 text-right">{ph.read}</td>
                      <td className="py-2 pr-4 text-right">{ph.failed}</td>
                      <td
                        className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(ph.deliveryRate))}`}
                      >
                        {(safeRate(ph.deliveryRate) * 100).toFixed(1)}%
                      </td>
                      <td
                        className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(ph.readRate))}`}
                      >
                        {(safeRate(ph.readRate) * 100).toFixed(1)}%
                      </td>
                      <td
                        className={`py-2 pr-4 text-right font-semibold ${rateColor(safeRate(ph.responseRate))}`}
                      >
                        {(safeRate(ph.responseRate) * 100).toFixed(1)}%
                      </td>
                      <td className="py-2 text-center">
                        {rateBadge(safeRate(ph.deliveryRate))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {data.phones.length > 1 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            <div>
              <p className="font-semibold text-amber-800">
                Alerta de Risco em Cascata
              </p>
              <p className="text-sm text-amber-600">
                {data.phones.length} números ativos. Se pertencerem ao mesmo WABA, problemas em um número podem afetar todos os outros. Considere usar Multi-WABA para isolar riscos.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data.templates.length === 0 && data.phones.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-gray-500">
            <Activity className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-lg font-medium">
              Nenhuma métrica de envio disponível
            </p>
            <p className="text-sm mt-1">
              As métricas aparecerão quando uma campanha estiver em andamento
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
