import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer,
  FunnelChart, Funnel, LabelList, Cell
} from "recharts";
import {
  Activity, Send, CheckCheck, Eye, MessageCircle, ShieldAlert,
  Download, Copy, Calendar, Filter, Clock, DollarSign,
  ChevronDown, ChevronUp, X, MessageSquare, ExternalLink,
  TrendingUp, Phone, Shield, RefreshCw, AlertTriangle,
  Thermometer
} from "lucide-react";
import { useLocation } from "wouter";

interface CampaignDashboard {
  id: string;
  name: string;
  status: string;
  totalLeads: number;
  wabaId: string | null;
  templateName: string;
  templateCategory: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  scheduledAt: string | null;
  metrics: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    replied: number;
    deliveredPct: number;
    readPct: number;
    blockedPct: number;
  };
}

interface FullMetrics {
  campaign: any;
  funnel: {
    sent: number;
    delivered: number;
    read: number;
    replied: number;
    blocked: number;
    deliveredPct: number;
    readPct: number;
    repliedPct: number;
    blockedPct: number;
  };
  heatmap: Array<{ day: number; hour: number; sent: number; delivered: number; read: number }>;
  contactEvents: Record<string, Array<{ event: string; timestamp: string }>>;
  totalContacts: number;
}

interface CostEstimate {
  totalMessages: number;
  category: string;
  unitPriceUSD: number;
  estimatedCostUSD: number;
  estimatedCostBRL: number;
}

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
const FUNNEL_COLORS = ["#3B82F6", "#22C55E", "#8B5CF6", "#F59E0B", "#EF4444"];

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string; label: string }> = {
    running: { bg: "bg-blue-50", text: "text-blue-700", label: "Em Execução" },
    completed: { bg: "bg-slate-100", text: "text-slate-600", label: "Concluída" },
    draft: { bg: "bg-gray-100", text: "text-gray-600", label: "Rascunho" },
    scheduled: { bg: "bg-slate-100", text: "text-slate-600", label: "Agendada" },
    paused: { bg: "bg-slate-100", text: "text-slate-600", label: "Pausada" },
    failed: { bg: "bg-red-100", text: "text-red-700", label: "Falhou" },
    stopped: { bg: "bg-red-100", text: "text-red-600", label: "Parada" },
  };
  const c = config[status] || config.draft;
  return <Badge className={`${c.bg} ${c.text}`}>{c.label}</Badge>;
}

function MetricPill({ icon: Icon, label, value, pct, color }: {
  icon: any; label: string; value: number; pct?: number; color: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg border border-gray-100">
      <Icon size={14} className={color} />
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm font-semibold text-gray-900">
          {value.toLocaleString()}
          {pct !== undefined && <span className="text-xs text-gray-400 ml-1">({pct}%)</span>}
        </p>
      </div>
    </div>
  );
}

function ConversionFunnel({ funnel }: { funnel: FullMetrics["funnel"] }) {
  const data = [
    { name: "Enviadas", value: funnel.sent, fill: FUNNEL_COLORS[0] },
    { name: "Entregues", value: funnel.delivered, fill: FUNNEL_COLORS[1] },
    { name: "Lidas", value: funnel.read, fill: FUNNEL_COLORS[2] },
    { name: "Respondidas", value: funnel.replied, fill: FUNNEL_COLORS[3] },
    { name: "Bloqueios", value: funnel.blocked, fill: FUNNEL_COLORS[4] },
  ].filter(d => d.value > 0 || d.name === "Enviadas");

  if (funnel.sent === 0) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        Nenhuma mensagem enviada ainda
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
        <TrendingUp size={14} /> Funil de Conversão
      </h4>
      <div className="space-y-2">
        {[
          { label: "Enviadas", value: funnel.sent, pct: 100, color: "bg-blue-500" },
          { label: "Entregues", value: funnel.delivered, pct: funnel.deliveredPct, color: "bg-[#38A169]" },
          { label: "Lidas", value: funnel.read, pct: funnel.readPct, color: "bg-purple-500" },
          { label: "Respondidas", value: funnel.replied, pct: funnel.repliedPct, color: "bg-[#0066FF]" },
          { label: "Bloqueios", value: funnel.blocked, pct: funnel.blockedPct, color: "bg-red-500" },
        ].map((step, i) => (
          <div key={i}>
            <div className="flex justify-between text-xs text-gray-600 mb-1">
              <span>{step.label}</span>
              <span>{step.value.toLocaleString()} ({step.pct}%)</span>
            </div>
            <div className="w-full h-2 rounded-full bg-gray-100">
              <div
                className={`h-2 rounded-full ${step.color} transition-all duration-500`}
                style={{ width: `${Math.min(step.pct, 100)}%` }}
              />
            </div>
            {i < 3 && funnel.sent > 0 && (
              <div className="text-[10px] text-gray-400 text-right mt-0.5">
                {i === 0 && funnel.deliveredPct > 0 && `→ ${funnel.deliveredPct}% entregues`}
                {i === 1 && funnel.readPct > 0 && `→ ${funnel.readPct}% lidas`}
                {i === 2 && funnel.repliedPct > 0 && `→ ${funnel.repliedPct}% respondidas`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeatmapGrid({ heatmap }: { heatmap: FullMetrics["heatmap"] }) {
  if (heatmap.length === 0) {
    return <div className="text-center py-4 text-gray-400 text-sm">Sem dados de horário</div>;
  }

  const maxVal = Math.max(...heatmap.map(h => h.read + h.delivered), 1);

  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const h of heatmap) {
    grid[h.day][h.hour] = h.read + h.delivered;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
        <Clock size={14} /> Heatmap de Horários
      </h4>
      <div className="overflow-x-auto">
        <div className="inline-block">
          <div className="flex gap-0.5 mb-1 ml-10">
            {Array.from({ length: 24 }, (_, i) => (
              <div key={i} className="w-4 text-[8px] text-gray-400 text-center">{i}</div>
            ))}
          </div>
          {grid.map((row, day) => (
            <div key={day} className="flex items-center gap-0.5">
              <span className="w-9 text-[9px] text-gray-500 text-right pr-1">{DAY_NAMES[day]}</span>
              {row.map((val, hour) => {
                const intensity = val / maxVal;
                const bg = val === 0 ? "bg-gray-50" :
                  intensity < 0.25 ? "bg-blue-100" :
                  intensity < 0.5 ? "bg-blue-300" :
                  intensity < 0.75 ? "bg-blue-500" : "bg-blue-700";
                return (
                  <div
                    key={hour}
                    className={`w-4 h-4 rounded-sm ${bg} transition-colors`}
                    title={`${DAY_NAMES[day]} ${hour}h: ${val} interações`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContactTimeline({ events }: { events: Array<{ event: string; timestamp: string }> }) {
  const eventConfig: Record<string, { color: string; label: string }> = {
    enviou: { color: "bg-blue-500", label: "Enviou" },
    entregou: { color: "bg-green-500", label: "Entregou" },
    leu: { color: "bg-purple-500", label: "Leu" },
    respondeu: { color: "bg-amber-500", label: "Respondeu" },
    bloqueou: { color: "bg-red-500", label: "Bloqueou" },
  };

  return (
    <div className="space-y-2">
      {events.map((e, i) => {
        const cfg = eventConfig[e.event] || { color: "bg-gray-400", label: e.event };
        return (
          <div key={i} className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${cfg.color} flex-shrink-0`} />
            <div className="flex-1 flex items-center justify-between">
              <span className="text-sm text-gray-700">{cfg.label}</span>
              <span className="text-xs text-gray-400">
                {new Date(e.timestamp).toLocaleString("pt-BR")}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CampaignDetailModal({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [segFilter, setSegFilter] = useState<string>("all");
  const [scheduleDate, setScheduleDate] = useState("");

  const { data: metrics, isLoading } = useQuery<FullMetrics>({
    queryKey: [`/api/campaigns/${campaignId}/full-metrics`],
    refetchInterval: 15000,
  });

  const { data: costEstimate } = useQuery<CostEstimate>({
    queryKey: [`/api/campaigns/${campaignId}/cost-estimate`],
  });

  const { data: segmentation } = useQuery<{ total: number; filtered: number; filter: string; leads: any[] }>({
    queryKey: [`/api/campaigns/${campaignId}/segmentation`, segFilter],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/segmentation?filter=${segFilter}`);
      if (!res.ok) throw new Error("Falha");
      return res.json();
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/duplicate`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Campanha duplicada com sucesso" });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/dashboard"] });
    },
    onError: (e: any) => toast({ title: "Erro ao duplicar", description: e.message, variant: "destructive" }),
  });

  const scheduleMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/schedule`, { scheduledAt: scheduleDate });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Campanha agendada" });
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/dashboard"] });
    },
    onError: (e: any) => toast({ title: "Erro ao agendar", description: e.message, variant: "destructive" }),
  });

  const handleExport = async (format: string) => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/export/${format}`);
      if (!res.ok) throw new Error("Falha no export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `campanha_${campaignId}.${format === "pdf" ? "txt" : format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: `Relatório ${format.toUpperCase()} baixado` });
    } catch (e: any) {
      toast({ title: "Erro ao exportar", description: e.message, variant: "destructive" });
    }
  };

  if (isLoading || !metrics) {
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl p-8 text-center">
          <div className="animate-pulse">Carregando métricas...</div>
        </div>
      </div>
    );
  }

  const contacts = Object.entries(metrics.contactEvents || {});

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white z-10">
          <div>
            <h3 className="text-lg font-semibold">{metrics.campaign?.name}</h3>
            <p className="text-xs text-gray-500">
              {metrics.campaign?.createdAt && new Date(metrics.campaign.createdAt).toLocaleString("pt-BR")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => handleExport("csv")}>
              <Download size={14} className="mr-1" /> CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleExport("pdf")}>
              <Download size={14} className="mr-1" /> Relatório
            </Button>
            <Button size="sm" variant="outline" onClick={() => duplicateMutation.mutate()}>
              <Copy size={14} className="mr-1" /> Duplicar
            </Button>
            {metrics.campaign?.wabaId && (
              <Button size="sm" variant="outline" onClick={() => { onClose(); navigate("/chat"); }}>
                <MessageSquare size={14} className="mr-1" /> Chat Ao Vivo
              </Button>
            )}
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
              <X size={20} className="text-gray-400" />
            </button>
          </div>
        </div>

        <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
            <MetricPill icon={Send} label="Enviadas" value={metrics.funnel.sent} color="text-blue-500" />
            <MetricPill icon={CheckCheck} label="Entregues" value={metrics.funnel.delivered} pct={metrics.funnel.deliveredPct} color="text-green-500" />
            <MetricPill icon={Eye} label="Lidas" value={metrics.funnel.read} pct={metrics.funnel.readPct} color="text-purple-500" />
            <MetricPill icon={MessageCircle} label="Respondidas" value={metrics.funnel.replied} pct={metrics.funnel.repliedPct} color="text-amber-500" />
            <MetricPill icon={ShieldAlert} label="Bloqueios" value={metrics.funnel.blocked} pct={metrics.funnel.blockedPct} color="text-red-500" />
          </div>

          {costEstimate && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <DollarSign size={16} className="text-slate-500" />
                <h4 className="text-sm font-semibold text-slate-700">Estimativa de Custo</h4>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-gray-500">Mensagens</p>
                  <p className="font-semibold">{costEstimate.totalMessages.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-gray-500">Categoria</p>
                  <p className="font-semibold capitalize">{costEstimate.category}</p>
                </div>
                <div>
                  <p className="text-gray-500">Custo (USD)</p>
                  <p className="font-semibold text-slate-700">${costEstimate.estimatedCostUSD.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Custo (BRL)</p>
                  <p className="font-semibold text-slate-700">R${costEstimate.estimatedCostBRL.toFixed(2)}</p>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardContent className="pt-4">
                <ConversionFunnel funnel={metrics.funnel} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <HeatmapGrid heatmap={metrics.heatmap} />
              </CardContent>
            </Card>
          </div>

          {metrics.campaign?.status === "draft" && (
            <Card>
              <CardContent className="pt-4">
                <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
                  <Calendar size={14} /> Agendar Campanha
                </h4>
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <Input
                      type="datetime-local"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                      min={new Date().toISOString().slice(0, 16)}
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => scheduleMutation.mutate()}
                    disabled={!scheduleDate || scheduleMutation.isPending}
                  >
                    Agendar
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-4">
              <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-2 mb-3">
                <Filter size={14} /> Segmentação por Engajamento
              </h4>
              <div className="flex flex-wrap gap-2 mb-3">
                {[
                  { value: "all", label: "Todos" },
                  { value: "read", label: "Lidos" },
                  { value: "delivered", label: "Entregues" },
                  { value: "failed", label: "Falhas" },
                  { value: "no_interaction", label: "Sem Interação" },
                ].map((f) => (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={segFilter === f.value ? "default" : "outline"}
                    onClick={() => setSegFilter(f.value)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
              {segmentation && (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    {segmentation.filtered} de {segmentation.total} contatos
                  </p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {segmentation.leads.slice(0, 50).map((lead: any, i: number) => (
                      <div
                        key={i}
                        className="flex items-center justify-between px-3 py-1.5 bg-gray-50 rounded text-sm cursor-pointer hover:bg-gray-100"
                        onClick={() => setSelectedContact(lead.phone)}
                      >
                        <span className="font-mono text-gray-700">{lead.phone}</span>
                        <Badge className={
                          lead.status === "read" ? "bg-purple-100 text-purple-700" :
                          lead.status === "delivered" ? "bg-slate-100 text-slate-600" :
                          lead.status === "failed" ? "bg-red-100 text-red-700" :
                          "bg-gray-100 text-gray-700"
                        }>
                          {lead.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {selectedContact && metrics.contactEvents[selectedContact] && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Timeline: {selectedContact}</CardTitle>
                  <button onClick={() => setSelectedContact(null)} className="p-1 hover:bg-gray-100 rounded">
                    <X size={16} className="text-gray-400" />
                  </button>
                </div>
              </CardHeader>
              <CardContent>
                <ContactTimeline events={metrics.contactEvents[selectedContact]} />
              </CardContent>
            </Card>
          )}

          {contacts.length > 0 && !selectedContact && (
            <Card>
              <CardContent className="pt-4">
                <h4 className="text-sm font-semibold text-gray-700 mb-3">
                  Contatos ({metrics.totalContacts})
                </h4>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {contacts.slice(0, 100).map(([phone, events]) => (
                    <div
                      key={phone}
                      className="flex items-center justify-between px-3 py-1.5 bg-gray-50 rounded text-sm cursor-pointer hover:bg-gray-100"
                      onClick={() => setSelectedContact(phone)}
                    >
                      <span className="font-mono text-gray-700">{phone}</span>
                      <span className="text-xs text-gray-400">{events.length} eventos</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function QualityRatingBadge({ rating }: { rating: string }) {
  const config: Record<string, { bg: string; text: string; icon: any }> = {
    GREEN: { bg: "bg-slate-100", text: "text-slate-600", icon: Shield },
    YELLOW: { bg: "bg-slate-100", text: "text-slate-500", icon: AlertTriangle },
    RED: { bg: "bg-red-100", text: "text-red-700", icon: ShieldAlert },
    UNKNOWN: { bg: "bg-gray-100", text: "text-gray-500", icon: Shield },
  };
  const c = config[rating] || config.UNKNOWN;
  const Icon = c.icon;
  return (
    <Badge className={`${c.bg} ${c.text} flex items-center gap-1`}>
      <Icon size={12} /> {rating}
    </Badge>
  );
}

interface WabaEntry {
  id: string;
  name?: string;
}

interface QualityNumberResult {
  phoneNumberId: string;
  displayNumber: string;
  qualityRating: string;
  previousRating?: string;
  tier?: string;
  accountMode?: string;
  changed?: boolean;
  protectionAction?: string | null;
  error?: string;
  history?: Array<{ id: string; qualityRating: string; previousRating: string; checkedAt: string }>;
}

interface QualityData {
  wabaId: string;
  numbers: QualityNumberResult[];
}

interface WarmupScheduleEntry {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  status: string;
  currentDay: number;
  totalDays: number;
  dailyTargets: number[];
  sentToday: number;
}

interface DeliveryMetrics {
  campaignId: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  deliveryRate: number;
  readRate: number;
  avgDeliveryTimeSec: number;
  replied: number;
}

interface ErrorLogEntry {
  errorCode: string;
  errorMessage: string;
  count: number;
}

function QualityRatingPanel() {
  const [selectedWabaId, setSelectedWabaId] = useState<string | null>(null);

  const { data: wabas = [] } = useQuery<WabaEntry[]>({
    queryKey: ["/api/wabas"],
  });

  const { data: qualityData, isLoading: isPolling, refetch } = useQuery<QualityData>({
    queryKey: ["/api/quality-rating", selectedWabaId],
    queryFn: () => selectedWabaId ? fetch(`/api/quality-rating/${selectedWabaId}`).then(r => r.json()) : Promise.resolve({ numbers: [], wabaId: '' } as QualityData),
    enabled: !!selectedWabaId,
    refetchInterval: 60000,
  });

  if (wabas.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Thermometer size={18} className="text-blue-600" />
            Quality Rating - Números
          </CardTitle>
          <div className="flex items-center gap-2">
            <select
              className="text-xs border rounded px-2 py-1 bg-white"
              value={selectedWabaId || ""}
              onChange={(e) => setSelectedWabaId(e.target.value || null)}
            >
              <option value="">Selecionar WABA</option>
              {wabas.map((w) => (
                <option key={w.id} value={w.id}>{w.name || w.id}</option>
              ))}
            </select>
            {selectedWabaId && (
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isPolling}>
                <RefreshCw size={14} className={isPolling ? "animate-spin" : ""} />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      {selectedWabaId && (
        <CardContent>
          {isPolling && !qualityData ? (
            <div className="text-sm text-gray-400 py-4 text-center">Verificando qualidade...</div>
          ) : qualityData?.numbers?.length ? (
            <div className="space-y-3">
              {qualityData.numbers.map((num: QualityNumberResult) => (
                <div key={num.phoneNumberId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border">
                  <div className="flex items-center gap-3">
                    <Phone size={16} className="text-gray-400" />
                    <div>
                      <p className="text-sm font-medium text-gray-900">{num.displayNumber}</p>
                      <p className="text-xs text-gray-500">
                        Tier: {num.tier || "N/A"}
                        {num.accountMode && ` | Modo: ${num.accountMode}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <QualityRatingBadge rating={num.qualityRating} />
                    {num.changed && (
                      <Badge className="bg-slate-100 text-slate-600 text-xs">
                        Mudou de {num.previousRating}
                      </Badge>
                    )}
                    {num.protectionAction && (
                      <Badge className="bg-slate-100 text-slate-500 text-xs">
                        {num.protectionAction}
                      </Badge>
                    )}
                    {num.error && (
                      <Badge className="bg-red-50 text-red-600 text-xs">Erro</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-400 py-4 text-center">
              Nenhum número encontrado para esta WABA
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function WarmupPanel() {
  const [selectedWabaId, setSelectedWabaId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: wabas = [] } = useQuery<WabaEntry[]>({
    queryKey: ["/api/wabas"],
  });

  const { data: schedules = [] } = useQuery<WarmupScheduleEntry[]>({
    queryKey: ["/api/warmup", selectedWabaId],
    queryFn: () => selectedWabaId ? fetch(`/api/warmup/${selectedWabaId}`).then(r => r.json()) : [],
    enabled: !!selectedWabaId,
    refetchInterval: 30000,
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/warmup/${id}/pause`, { method: "POST" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      toast({ title: "Aquecimento pausado" });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/warmup/${id}/resume`, { method: "POST" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      toast({ title: "Aquecimento retomado" });
    },
  });

  const advanceMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/warmup/${id}/advance`, { method: "POST" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warmup"] });
      toast({ title: "Dia avançado" });
    },
  });

  if (wabas.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity size={18} className="text-slate-500" />
            Aquecimento de Números
          </CardTitle>
          <select
            className="text-xs border rounded px-2 py-1 bg-white"
            value={selectedWabaId || ""}
            onChange={(e) => setSelectedWabaId(e.target.value || null)}
          >
            <option value="">Selecionar WABA</option>
            {wabas.map((w) => (
              <option key={w.id} value={w.id}>{w.name || w.id}</option>
            ))}
          </select>
        </div>
      </CardHeader>
      {selectedWabaId && schedules.length > 0 && (
        <CardContent>
          <div className="space-y-3">
            {schedules.map((s) => {
              const targets = s.dailyTargets || [];
              const currentTarget = targets[Math.min(s.currentDay - 1, targets.length - 1)] || 0;
              const progress = currentTarget > 0 ? Math.min(100, (s.sentToday / currentTarget) * 100) : 0;

              return (
                <div key={s.id} className="p-3 bg-gray-50 rounded-lg border space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Phone size={14} className="text-gray-400" />
                      <span className="text-sm font-medium">{s.phoneNumberId}</span>
                      <Badge className={
                        s.status === "active" ? "bg-blue-50 text-blue-700" :
                        s.status === "paused" ? "bg-slate-100 text-slate-600" :
                        "bg-slate-100 text-slate-600"
                      }>
                        {s.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-gray-500">
                      Dia {s.currentDay}/{s.totalDays}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>Meta: {currentTarget} msgs</span>
                      <span>{s.sentToday}/{currentTarget} ({Math.round(progress)}%)</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-gray-200">
                      <div
                        className="h-2 rounded-full bg-[#0066FF] transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex gap-2">
                    {s.status === "active" ? (
                      <Button size="sm" variant="outline" onClick={() => pauseMutation.mutate(s.id)}>
                        Pausar
                      </Button>
                    ) : s.status === "paused" ? (
                      <Button size="sm" variant="outline" onClick={() => resumeMutation.mutate(s.id)}>
                        Retomar
                      </Button>
                    ) : null}
                    {s.status === "active" && (
                      <Button size="sm" variant="outline" onClick={() => advanceMutation.mutate(s.id)}>
                        Avançar Dia
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      )}
      {selectedWabaId && schedules.length === 0 && (
        <CardContent>
          <div className="text-sm text-gray-400 py-4 text-center">
            Nenhum agendamento de aquecimento ativo
          </div>
        </CardContent>
      )}
    </Card>
  );
}

export default function WabasPage() {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [, navigate] = useLocation();

  const { data: campaigns = [], isLoading } = useQuery<CampaignDashboard[]>({
    queryKey: ["/api/campaigns/dashboard"],
    refetchInterval: 15000,
  });

  const activeCampaigns = campaigns.filter((c) => ["running", "scheduled", "paused"].includes(c.status));
  const completedCampaigns = campaigns.filter((c) => ["completed", "stopped", "failed"].includes(c.status));
  const draftCampaigns = campaigns.filter((c) => c.status === "draft");

  const totalSent = campaigns.reduce((sum, c) => sum + (c.metrics?.sent || 0), 0);
  const totalDelivered = campaigns.reduce((sum, c) => sum + (c.metrics?.delivered || 0), 0);
  const totalRead = campaigns.reduce((sum, c) => sum + (c.metrics?.read || 0), 0);
  const totalFailed = campaigns.reduce((sum, c) => sum + (c.metrics?.failed || 0), 0);

  return (
    <div className="flex-1">
      <header className="bg-white shadow-sm border-b border-gray-200 px-3 sm:px-6 py-3 sm:py-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg sm:text-2xl font-bold text-gray-900">Campanhas Ativas</h2>
            <p className="text-xs sm:text-sm text-gray-600 hidden sm:block">Dashboard de campanhas com métricas e chat ao vivo</p>
          </div>
          <Button size="sm" className="min-h-[44px] w-full sm:w-auto" onClick={() => navigate("/")}>
            Nova Campanha
          </Button>
        </div>
      </header>

      <main className="p-3 sm:p-6 space-y-4 sm:space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                  <Send size={18} className="text-blue-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Enviadas</p>
                  <p className="text-xl font-bold text-gray-900">{totalSent.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-slate-50 flex items-center justify-center">
                  <CheckCheck size={18} className="text-slate-500" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Entregues</p>
                  <p className="text-xl font-bold text-gray-900">{totalDelivered.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
                  <Eye size={18} className="text-purple-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Lidas</p>
                  <p className="text-xl font-bold text-gray-900">{totalRead.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                  <ShieldAlert size={18} className="text-red-600" />
                </div>
                <div>
                  <p className="text-xs text-gray-500">Falhas</p>
                  <p className="text-xl font-bold text-gray-900">{totalFailed.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <QualityRatingPanel />
          <WarmupPanel />
        </div>

        {isLoading ? (
          <div className="animate-pulse space-y-4">
            {[1, 2].map((i) => <div key={i} className="bg-gray-200 rounded-lg h-32" />)}
          </div>
        ) : campaigns.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Activity className="mx-auto text-gray-400 mb-4" size={48} />
              <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhuma campanha encontrada</h3>
              <p className="text-gray-500 mb-4">Crie sua primeira campanha na página Campanha Disparo.</p>
              <Button onClick={() => navigate("/")}>Criar Campanha</Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {activeCampaigns.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                  Em Execução ({activeCampaigns.length})
                </h3>
                {activeCampaigns.map((c) => (
                  <CampaignCard
                    key={c.id}
                    campaign={c}
                    expanded={expandedId === c.id}
                    onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
                    onOpenDetail={() => setDetailId(c.id)}
                    onOpenChat={() => navigate("/chat")}
                  />
                ))}
              </div>
            )}

            {completedCampaigns.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                  Concluídas ({completedCampaigns.length})
                </h3>
                {completedCampaigns.map((c) => (
                  <CampaignCard
                    key={c.id}
                    campaign={c}
                    expanded={expandedId === c.id}
                    onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
                    onOpenDetail={() => setDetailId(c.id)}
                    onOpenChat={() => navigate("/chat")}
                  />
                ))}
              </div>
            )}

            {draftCampaigns.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
                  Rascunhos ({draftCampaigns.length})
                </h3>
                {draftCampaigns.map((c) => (
                  <CampaignCard
                    key={c.id}
                    campaign={c}
                    expanded={expandedId === c.id}
                    onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
                    onOpenDetail={() => setDetailId(c.id)}
                    onOpenChat={() => navigate("/chat")}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {detailId && <CampaignDetailModal campaignId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function CampaignCard({ campaign, expanded, onToggle, onOpenDetail, onOpenChat }: {
  campaign: CampaignDashboard;
  expanded: boolean;
  onToggle: () => void;
  onOpenDetail: () => void;
  onOpenChat: () => void;
}) {
  const m = campaign.metrics;
  return (
    <Card className="overflow-hidden">
      <div
        className="px-5 py-4 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-gray-900 truncate">{campaign.name}</h4>
              <StatusBadge status={campaign.status} />
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
              <span>{campaign.totalLeads} leads</span>
              <span>Template: {campaign.templateName}</span>
              {campaign.createdAt && (
                <span>{new Date(campaign.createdAt).toLocaleDateString("pt-BR")}</span>
              )}
              {campaign.scheduledAt && (
                <span className="text-slate-500 flex items-center gap-1">
                  <Calendar size={10} /> {new Date(campaign.scheduledAt).toLocaleString("pt-BR")}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-4 text-xs mr-4">
            <span className="text-blue-600 font-medium">{m.sent} env</span>
            <span className="text-slate-600 font-medium">{m.delivered} ent ({m.deliveredPct}%)</span>
            <span className="text-purple-600 font-medium">{m.read} lid ({m.readPct}%)</span>
            {m.failed > 0 && <span className="text-red-600 font-medium">{m.failed} falha</span>}
          </div>
          {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t px-5 py-4 bg-gray-50/50 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <MetricPill icon={Send} label="Enviadas" value={m.sent} color="text-blue-500" />
            <MetricPill icon={CheckCheck} label="Entregues" value={m.delivered} pct={m.deliveredPct} color="text-slate-600" />
            <MetricPill icon={Eye} label="Lidas" value={m.read} pct={m.readPct} color="text-purple-500" />
            <MetricPill icon={MessageCircle} label="Respondidas" value={m.replied} color="text-slate-500" />
            <MetricPill icon={ShieldAlert} label="Bloqueios" value={m.failed} pct={m.blockedPct} color="text-red-500" />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onOpenDetail}>
              <Activity size={14} className="mr-1" /> Métricas Completas
            </Button>
            {campaign.wabaId && (
              <Button size="sm" variant="outline" onClick={onOpenChat}>
                <MessageSquare size={14} className="mr-1" /> Chat Ao Vivo
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
