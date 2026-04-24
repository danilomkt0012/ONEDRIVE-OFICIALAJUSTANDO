import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Phone,
  Shield,
  ShieldAlert,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  TrendingUp,
  Thermometer,
  Activity,
  Clock,
  Flame,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  type DotProps,
  type TooltipProps,
} from "recharts";

interface RatingHistoryEntry {
  id: string;
  qualityRating: string;
  previousRating: string;
  checkedAt: string;
}

interface NumberHealth {
  phoneNumberId: string;
  displayNumber: string;
  verifiedName?: string;
  wabaId: string;
  wabaName: string;
  qualityRating: string;
  tier: string;
  tierLimit: number;
  sentToday: number;
  dailyQuota: number;
  warmupStage: "none" | "new" | "warming" | "consolidated";
  warmupCurrentLimit: number | null;
  warmupNextTierEstimate: string | null;
  warmupDay: number | null;
  warmupTotalDays: number | null;
  recentHistory: RatingHistoryEntry[];
}

interface CriticalAlert {
  phoneNumberId: string;
  displayNumber: string | null;
  newRating: string;
  previousRating: string | null;
  detectedAt: string;
  recommendedAction: string;
}

interface NumberHealthResponse {
  numbers: NumberHealth[];
  recentAlerts: CriticalAlert[];
  updatedAt: string;
}

interface HistoryEntry {
  qualityRating: string;
  previousRating: string;
  sentCount: number | null;
  checkedAt: string;
}

const RATING_COLORS: Record<string, string> = {
  GREEN: "#22C55E",
  YELLOW: "#EAB308",
  RED: "#EF4444",
  UNKNOWN: "#94A3B8",
};

const RATING_NUM: Record<string, number> = {
  GREEN: 3,
  YELLOW: 2,
  RED: 1,
  UNKNOWN: 0,
};

function QualityBadge({ rating }: { rating: string }) {
  if (rating === "GREEN")
    return (
      <Badge className="bg-green-100 text-green-800 flex items-center gap-1">
        <CheckCircle className="w-3 h-3" /> GREEN
      </Badge>
    );
  if (rating === "YELLOW")
    return (
      <Badge className="bg-yellow-100 text-yellow-800 flex items-center gap-1">
        <AlertTriangle className="w-3 h-3" /> YELLOW
      </Badge>
    );
  if (rating === "RED")
    return (
      <Badge className="bg-red-100 text-red-800 flex items-center gap-1">
        <ShieldAlert className="w-3 h-3" /> RED
      </Badge>
    );
  return (
    <Badge className="bg-gray-100 text-gray-600 flex items-center gap-1">
      <Shield className="w-3 h-3" /> SEM RATING
    </Badge>
  );
}

function WarmupStageBadge({ stage }: { stage: string }) {
  if (stage === "warming")
    return (
      <Badge className="bg-orange-100 text-orange-700 flex items-center gap-1">
        <Flame className="w-3 h-3" /> Em aquecimento
      </Badge>
    );
  if (stage === "new")
    return (
      <Badge className="bg-blue-100 text-blue-700 flex items-center gap-1">
        <Activity className="w-3 h-3" /> Novo (250/dia)
      </Badge>
    );
  if (stage === "consolidated")
    return (
      <Badge className="bg-slate-100 text-slate-600 flex items-center gap-1">
        <CheckCircle className="w-3 h-3" /> Consolidado
      </Badge>
    );
  return null;
}

function tierLabel(tier: string): string {
  if (tier === "TIER_250") return "250 msg/dia";
  if (tier === "TIER_1K") return "1.000 msg/dia";
  if (tier === "TIER_10K") return "10.000 msg/dia";
  if (tier === "TIER_100K") return "100.000 msg/dia";
  if (tier === "TIER_UNLIMITED") return "Ilimitado";
  return tier || "N/A";
}

function RatingHistoryChart({ phoneNumberId }: { phoneNumberId: string }) {
  const { data: history = [], isLoading } = useQuery<HistoryEntry[]>({
    queryKey: ["/api/quality-rating-history-30d", phoneNumberId],
    queryFn: () =>
      fetch(`/api/quality-rating-history-30d/${phoneNumberId}`).then((r) =>
        r.json()
      ),
  });

  if (isLoading) {
    return (
      <div className="h-16 animate-pulse bg-gray-100 rounded" />
    );
  }

  if (!history || history.length === 0) {
    return (
      <p className="text-xs text-gray-400 italic">Sem histórico de rating disponível</p>
    );
  }

  const chartData = [...history]
    .reverse()
    .map((h, i) => ({
      idx: i,
      rating: RATING_NUM[h.qualityRating] ?? 0,
      label: h.qualityRating,
      volume: h.sentCount ?? 0,
      date: new Date(h.checkedAt).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
      }),
    }));

  return (
    <div className="mt-2">
      <p className="text-xs text-gray-500 mb-1">
        Rating + volume enviado (últimos 30 dias — {history.length} registros)
      </p>
      <ResponsiveContainer width="100%" height={90}>
        <ComposedChart data={chartData}>
          <XAxis dataKey="date" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
          <YAxis yAxisId="rating" domain={[0, 3]} hide />
          <YAxis yAxisId="volume" orientation="right" tick={{ fontSize: 9 }} width={30} />
          <Tooltip
            content={({ payload, label }: TooltipProps<number, string>) => {
              if (!payload || payload.length === 0) return null;
              const ratingLabel = (payload[0]?.payload as { label?: string })?.label ?? "";
              const vol = (payload[0]?.payload as { volume?: number })?.volume ?? 0;
              return (
                <div className="bg-white border rounded shadow px-2 py-1 text-xs">
                  <p className="text-gray-500">Data: {label}</p>
                  <p className="font-semibold">Rating: {ratingLabel}</p>
                  <p className="text-blue-600">Volume: {vol} msgs</p>
                </div>
              );
            }}
          />
          <Bar yAxisId="volume" dataKey="volume" fill="#BFDBFE" opacity={0.8} radius={[2, 2, 0, 0]} />
          <ReferenceLine yAxisId="rating" y={3} stroke="#22C55E" strokeDasharray="3 3" />
          <ReferenceLine yAxisId="rating" y={2} stroke="#EAB308" strokeDasharray="3 3" />
          <ReferenceLine yAxisId="rating" y={1} stroke="#EF4444" strokeDasharray="3 3" />
          <Line
            yAxisId="rating"
            type="stepAfter"
            dataKey="rating"
            stroke="#3B82F6"
            strokeWidth={2}
            dot={(dotProps: DotProps & { payload?: { label?: string }; index?: number }) => {
              const color = RATING_COLORS[dotProps.payload?.label ?? ""] ?? "#94A3B8";
              return (
                <circle
                  key={dotProps.index}
                  cx={dotProps.cx}
                  cy={dotProps.cy}
                  r={4}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1}
                />
              );
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function NumberCard({ num }: { num: NumberHealth }) {
  const [showHistory, setShowHistory] = useState(false);
  const effectiveLimit =
    num.warmupCurrentLimit !== null ? num.warmupCurrentLimit : num.dailyQuota;
  const usagePct = effectiveLimit > 0 ? Math.min(100, (num.sentToday / effectiveLimit) * 100) : 0;

  const isYellow = num.qualityRating === "YELLOW";
  const isRed = num.qualityRating === "RED";

  return (
    <Card
      className={`transition-colors ${
        isRed
          ? "border-red-300 bg-red-50"
          : isYellow
          ? "border-yellow-300 bg-yellow-50"
          : ""
      }`}
    >
      <CardContent className="p-4 space-y-3">
        {isRed && (
          <div className="flex items-center gap-2 p-2 bg-red-100 rounded text-red-800 text-xs font-medium">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            Campanhas pausadas automaticamente — rating RED detectado.
          </div>
        )}
        {isYellow && (
          <div className="flex items-center gap-2 p-2 bg-yellow-100 rounded text-yellow-800 text-xs font-medium">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            Atenção: rating YELLOW. Reduza volume e monitore.
          </div>
        )}

        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                isRed
                  ? "bg-red-200"
                  : isYellow
                  ? "bg-yellow-200"
                  : "bg-blue-100"
              }`}
            >
              <Phone className="w-4 h-4 text-gray-600" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 text-sm">
                {num.displayNumber || num.phoneNumberId}
              </p>
              {num.verifiedName && (
                <p className="text-xs text-gray-500 truncate">{num.verifiedName}</p>
              )}
              <p className="text-xs text-gray-400">{num.wabaName}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <QualityBadge rating={num.qualityRating} />
            <WarmupStageBadge stage={num.warmupStage} />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <p className="text-xs text-gray-500">Tier Meta</p>
            <p className="font-medium text-gray-800">{tierLabel(num.tier)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Limite efetivo/dia</p>
            <p className="font-medium text-gray-800">
              {effectiveLimit.toLocaleString()}
              {num.warmupCurrentLimit !== null && (
                <span className="text-xs text-orange-600 ml-1">(warmup)</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Enviado hoje</p>
            <p className="font-medium text-gray-800">{num.sentToday.toLocaleString()}</p>
          </div>
          {num.warmupStage === "warming" && num.warmupDay !== null && (
            <div>
              <p className="text-xs text-gray-500">Estágio warmup</p>
              <p className="font-medium text-gray-800">
                Dia {num.warmupDay}/{num.warmupTotalDays}
                {num.warmupNextTierEstimate && (
                  <span className="text-xs text-gray-400 ml-1">
                    (+{num.warmupNextTierEstimate})
                  </span>
                )}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Volume hoje</span>
            <span>
              {num.sentToday}/{effectiveLimit} ({Math.round(usagePct)}%)
            </span>
          </div>
          <Progress
            value={usagePct}
            className={`h-2 ${isRed ? "bg-red-100" : isYellow ? "bg-yellow-100" : ""}`}
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-7 px-2"
            onClick={() => setShowHistory(!showHistory)}
          >
            <TrendingUp className="w-3 h-3 mr-1" />
            {showHistory ? "Ocultar histórico" : "Ver histórico de rating"}
          </Button>
        </div>

        {showHistory && <RatingHistoryChart phoneNumberId={num.phoneNumberId} />}
      </CardContent>
    </Card>
  );
}

export default function NumberHealthPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isFetching } = useQuery<NumberHealthResponse>({
    queryKey: ["/api/number-health"],
    refetchInterval: 60000,
  });

  const pollMutation = useMutation({
    mutationFn: () =>
      fetch("/api/quality-rating/poll", { method: "POST" }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Polling executado", description: "Quality ratings atualizados" });
      queryClient.invalidateQueries({ queryKey: ["/api/number-health"] });
    },
    onError: () => {
      toast({ title: "Erro ao executar polling", variant: "destructive" });
    },
  });

  const numbers = data?.numbers ?? [];
  const recentAlerts = data?.recentAlerts ?? [];

  const redCount = numbers.filter((n) => n.qualityRating === "RED").length;
  const yellowCount = numbers.filter((n) => n.qualityRating === "YELLOW").length;
  const greenCount = numbers.filter((n) => n.qualityRating === "GREEN").length;
  const unknownCount = numbers.filter((n) => n.qualityRating === "UNKNOWN").length;
  const warmingCount = numbers.filter((n) => n.warmupStage === "warming" || n.warmupStage === "new").length;

  return (
    <div className="flex-1">
      <header className="bg-white shadow-sm border-b border-gray-200 px-3 sm:px-6 py-3 sm:py-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg sm:text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Thermometer className="w-6 h-6 text-blue-600" />
              Saúde dos Números
            </h2>
            <p className="text-xs sm:text-sm text-gray-600">
              Quality Rating, Warmup e Limites de Envio — polling automático a cada 15 min
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => pollMutation.mutate()}
            disabled={pollMutation.isPending || isFetching}
          >
            <RefreshCw
              className={`w-4 h-4 mr-1 ${pollMutation.isPending ? "animate-spin" : ""}`}
            />
            Atualizar agora
          </Button>
        </div>
      </header>

      <main className="p-3 sm:p-6 space-y-4 sm:space-y-6">
        {recentAlerts.length > 0 && (
          <div className="space-y-2">
            {recentAlerts.map((alert, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 p-3 rounded-lg border text-sm ${
                  alert.newRating === "RED"
                    ? "bg-red-50 border-red-300 text-red-900"
                    : "bg-yellow-50 border-yellow-300 text-yellow-900"
                }`}
              >
                {alert.newRating === "RED" ? (
                  <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">
                    {alert.newRating === "RED" ? "🚨 Alerta crítico" : "⚠️ Atenção"} —{" "}
                    {alert.displayNumber ?? alert.phoneNumberId}:{" "}
                    {alert.previousRating ?? "?"} → {alert.newRating}
                  </p>
                  <p className="text-xs mt-0.5 opacity-80">{alert.recommendedAction}</p>
                  <p className="text-xs mt-0.5 opacity-60">
                    Detectado:{" "}
                    {new Date(alert.detectedAt).toLocaleString("pt-BR")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-gray-500">Total</p>
              <p className="text-2xl font-bold text-gray-900">{numbers.length}</p>
            </CardContent>
          </Card>
          <Card className={greenCount > 0 ? "border-green-200" : ""}>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> GREEN
              </p>
              <p className="text-2xl font-bold text-green-700">{greenCount}</p>
            </CardContent>
          </Card>
          <Card className={yellowCount > 0 ? "border-yellow-300" : ""}>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-yellow-600 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> YELLOW
              </p>
              <p className="text-2xl font-bold text-yellow-700">{yellowCount}</p>
            </CardContent>
          </Card>
          <Card className={redCount > 0 ? "border-red-300" : ""}>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-red-600 flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" /> RED
              </p>
              <p className="text-2xl font-bold text-red-700">{redCount}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-3 px-4">
              <p className="text-xs text-orange-600 flex items-center gap-1">
                <Flame className="w-3 h-3" /> Warmup
              </p>
              <p className="text-2xl font-bold text-orange-700">{warmingCount}</p>
            </CardContent>
          </Card>
        </div>

        {data?.updatedAt && (
          <p className="text-xs text-gray-400 flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Última atualização: {new Date(data.updatedAt).toLocaleString("pt-BR")}
          </p>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-40 bg-gray-100 animate-pulse rounded-lg" />
            ))}
          </div>
        ) : numbers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Thermometer className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-900 mb-1">
                Nenhum número cadastrado
              </h3>
              <p className="text-sm text-gray-500">
                Adicione WABAs e números no wizard de campanhas para monitorar a saúde aqui.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {redCount > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-red-700 uppercase tracking-wider flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4" />
                  Crítico — Rating RED ({redCount})
                </h3>
                {numbers
                  .filter((n) => n.qualityRating === "RED")
                  .map((n) => (
                    <NumberCard key={n.phoneNumberId} num={n} />
                  ))}
              </div>
            )}
            {yellowCount > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-yellow-700 uppercase tracking-wider flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  Atenção — Rating YELLOW ({yellowCount})
                </h3>
                {numbers
                  .filter((n) => n.qualityRating === "YELLOW")
                  .map((n) => (
                    <NumberCard key={n.phoneNumberId} num={n} />
                  ))}
              </div>
            )}
            {greenCount > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-green-700 uppercase tracking-wider flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" />
                  Saudável — Rating GREEN ({greenCount})
                </h3>
                {numbers
                  .filter((n) => n.qualityRating === "GREEN")
                  .map((n) => (
                    <NumberCard key={n.phoneNumberId} num={n} />
                  ))}
              </div>
            )}
            {unknownCount > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
                  <Shield className="w-4 h-4" />
                  Novos / Sem Rating ({unknownCount})
                </h3>
                {numbers
                  .filter((n) => n.qualityRating === "UNKNOWN")
                  .map((n) => (
                    <NumberCard key={n.phoneNumberId} num={n} />
                  ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
