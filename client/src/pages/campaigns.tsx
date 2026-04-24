import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Search,
  Megaphone,
  Clock,
  CheckCircle2,
  PauseCircle,
  AlertCircle,
  FileEdit,
  Trash2,
  BarChart3,
  Send,
  Users,
  CheckCircle,
  Globe,
  Copy,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Zap,
  Server,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface ServerStatus {
  environment: string;
  status: string;
  uptime: string;
  webhookUrl: string;
  webhookWarning: string | null;
  domain: string | null;
  lastWebhookEvent: string | null;
}

const statusConfig: Record<string, { label: string; color: string; icon: any }> = {
  draft: { label: "Rascunho", color: "bg-slate-100 text-slate-600 border-slate-200", icon: FileEdit },
  active: { label: "Ativa", color: "bg-slate-100 text-slate-600 border-slate-200", icon: Megaphone },
  running: { label: "Enviando", color: "bg-blue-50 text-blue-700 border-blue-200", icon: Send },
  paused: { label: "Pausada", color: "bg-slate-100 text-slate-600 border-slate-200", icon: PauseCircle },
  completed: { label: "Concluída", color: "bg-slate-100 text-slate-600 border-slate-200", icon: CheckCircle2 },
  failed: { label: "Falhou", color: "bg-red-100 text-red-700 border-red-200", icon: AlertCircle },
  scheduled: { label: "Agendada", color: "bg-slate-100 text-slate-600 border-slate-200", icon: Clock },
};

function NextStepsGuide({ webhookUrl, isProduction }: { webhookUrl: string; isProduction: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      toast({ title: "URL copiada", description: "Cole no campo 'URL de retorno de chamada' na Meta." });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast({ title: "Erro", description: "Não foi possível copiar", variant: "destructive" });
    }
  };

  const steps = [
    {
      label: "Configurar WABA na Meta",
      desc: "Acesse developers.facebook.com, abra seu App Meta e vá em WhatsApp > Configuração > Webhook.",
    },
    {
      label: "Colar a URL do Webhook",
      desc: "No campo 'URL de retorno de chamada', cole a URL abaixo. No campo 'Token de verificação', use o token configurado em Webhook & Deploy.",
    },
    {
      label: "Verificar e salvar",
      desc: "Clique em 'Verificar e salvar'. Se o token bater, a Meta vai confirmar o webhook.",
    },
    {
      label: "Inscrever-se nos eventos",
      desc: "Inscreva-se nos campos: messages, message_deliveries, message_reads.",
    },
    {
      label: "Adicionar WABA no painel",
      desc: "Vá em Números / WABAs no menu lateral, adicione suas credenciais e sincronize os números e templates.",
    },
    {
      label: "Importar lista de leads",
      desc: "Use a opção 'Preparar Lista' para importar e validar seus contatos antes de criar a campanha.",
    },
    {
      label: "Criar e lançar campanha",
      desc: "Crie uma nova campanha, configure os templates aprovados e clique em Iniciar.",
    },
  ];

  return (
    <div className="border border-[#0066FF]/20 rounded-xl bg-gradient-to-br from-[#EBF4FF]/60 to-white overflow-hidden">
      <button
        className="w-full flex items-center justify-between p-4 sm:p-5 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isProduction ? "bg-green-100" : "bg-[#EBF4FF]"}`}>
            {isProduction ? (
              <Server size={18} className="text-[#38A169]" />
            ) : (
              <Zap size={18} className="text-[#0066FF]" />
            )}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#1A202C]">
              {isProduction ? "Sistema em Produção — Próximos Passos" : "Como lançar sua primeira campanha"}
            </h3>
            <p className="text-xs text-[#718096]">
              {isProduction
                ? "Siga o guia abaixo para conectar suas WABAs e lançar a primeira campanha"
                : "Configure o webhook e WABAs para começar a disparar"}
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp size={18} className="text-[#A0AEC0] flex-shrink-0" />
        ) : (
          <ChevronDown size={18} className="text-[#A0AEC0] flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-5 space-y-5 border-t border-[#E2E8F0]">
          {webhookUrl && (
            <div className="mt-4">
              <label className="text-xs font-medium text-[#718096] mb-1.5 block">
                URL do Webhook — cole no Meta Business Manager
              </label>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-white border border-[#E2E8F0] rounded-lg px-3 py-2.5 font-mono text-xs text-[#1A202C] overflow-x-auto">
                  {webhookUrl}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-10 px-3 border-[#E2E8F0] hover:bg-[#F7FAFC] flex-shrink-0"
                  onClick={copyUrl}
                >
                  {copied ? (
                    <CheckCircle size={15} className="text-[#38A169]" />
                  ) : (
                    <Copy size={15} className="text-[#718096]" />
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-[#A0AEC0] mt-1">
                Para o token de verificação e instruções completas, acesse{" "}
                <a href="/webhook" className="text-[#0066FF] hover:underline">Webhook & Deploy</a>.
              </p>
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold text-[#718096] uppercase tracking-widest mb-3">Passo a passo</h4>
            <div className="space-y-2.5">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                  <span className="w-5 h-5 rounded-full bg-[#EBF4FF] text-[#0066FF] text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-xs font-medium text-[#1A202C]">{step.label}</p>
                    <p className="text-[11px] text-[#718096]">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold text-[#718096] uppercase tracking-widest mb-3">
              Checklist — antes de lançar
            </h4>
            <div className="space-y-2">
              {[
                { label: "WABA conectada com token válido", link: "/config", linkLabel: "Configurar WABA" },
                { label: "Webhook testado e respondendo na Meta", link: "/webhook", linkLabel: "Ir para Webhook" },
                { label: "Template aprovado sincronizado", link: "/config", linkLabel: "Sincronizar templates" },
                { label: "Lista de leads importada", link: "/lead-cleaner", linkLabel: "Importar lista" },
                { label: "Bot configurado (opcional, mas recomendado)", link: "/bot", linkLabel: "Configurar bot" },
              ].map((item, i) => (
                <div key={i} className="flex items-center justify-between gap-2 bg-white border border-[#E2E8F0] rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded border border-[#CBD5E0] flex-shrink-0" />
                    <span className="text-xs text-[#4A5568]">{item.label}</span>
                  </div>
                  <a
                    href={item.link}
                    className="text-[11px] text-[#0066FF] hover:underline flex items-center gap-1 flex-shrink-0"
                  >
                    {item.linkLabel}
                    <ExternalLink size={10} />
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CampaignsPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["/api/campaigns/managed"],
    queryFn: async () => {
      const res = await fetch("/api/campaigns/managed");
      if (!res.ok) throw new Error("Falha ao carregar campanhas");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: serverStatus } = useQuery<ServerStatus>({
    queryKey: ["/api/server-status"],
    queryFn: async () => {
      const res = await fetch("/api/server-status");
      if (!res.ok) throw new Error("Falha ao buscar status");
      return res.json();
    },
    refetchInterval: 30000,
    staleTime: 10000,
  });

  const { data: wabas = [] } = useQuery({
    queryKey: ["/api/wabas"],
    queryFn: async () => {
      const res = await fetch("/api/wabas");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      const res = await fetch("/api/campaigns/managed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Falha ao criar campanha");
      return res.json();
    },
    onSuccess: (campaign) => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed"] });
      setShowCreateDialog(false);
      setNewName("");
      setNewDescription("");
      navigate(`/campaigns/${campaign.id}/wizard`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/campaigns/managed/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Falha ao excluir");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed"] });
    },
  });

  const filtered = campaigns.filter((c: any) => {
    const matchesSearch = !searchQuery || c.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const statuses = ["all", "draft", "running", "paused", "completed", "failed"];

  const isProduction = serverStatus?.environment === "production";
  const hasWabas = Array.isArray(wabas) && wabas.length > 0;
  const showGuide = !hasWabas || campaigns.length === 0;
  const webhookUrl = serverStatus?.webhookUrl || "";

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold">Campanhas</h1>
            {serverStatus && (
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                isProduction
                  ? "bg-green-50 text-[#38A169] border-green-200"
                  : "bg-slate-50 text-slate-500 border-slate-200"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isProduction ? "bg-[#38A169]" : "bg-slate-400"}`} />
                {isProduction ? "Produção — Online" : "Desenvolvimento"}
              </span>
            )}
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground">Gerencie todas as suas campanhas de disparo</p>
        </div>
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Nova Campanha
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Criar Nova Campanha</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div>
                <Label>Nome da Campanha</Label>
                <Input
                  placeholder="Ex: Black Friday 2024"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              <div>
                <Label>Descrição (opcional)</Label>
                <Textarea
                  placeholder="Descreva o objetivo da campanha..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={3}
                />
              </div>
              <Button
                className="w-full"
                disabled={!newName.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate({ name: newName, description: newDescription })}
              >
                {createMutation.isPending ? "Criando..." : "Criar e Configurar"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {showGuide && (
        <NextStepsGuide
          webhookUrl={webhookUrl}
          isProduction={isProduction}
        />
      )}

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        <div className="relative flex-1 max-w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar campanhas..."
            className="pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-1 overflow-x-auto scrollbar-hide pb-1 sm:pb-0">
          {statuses.map((s) => (
            <Button
              key={s}
              variant={statusFilter === s ? "default" : "outline"}
              size="sm"
              className="flex-shrink-0 min-h-[44px] sm:min-h-0"
              onClick={() => setStatusFilter(s)}
            >
              {s === "all" ? "Todas" : statusConfig[s]?.label || s}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="h-20 bg-muted rounded-t-lg" />
              <CardContent className="space-y-2 pt-4">
                <div className="h-4 bg-muted rounded w-3/4" />
                <div className="h-4 bg-muted rounded w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Megaphone className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold">Nenhuma campanha encontrada</h3>
            <p className="text-muted-foreground mt-1">
              {searchQuery || statusFilter !== "all"
                ? "Tente ajustar os filtros de busca"
                : "Crie sua primeira campanha para começar"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((campaign: any) => {
            const config = statusConfig[campaign.status] || statusConfig.draft;
            const StatusIcon = config.icon;
            const sent = campaign.liveMetrics?.accepted || campaign.sentCount || campaign.sentMessages || 0;
            const total = campaign.totalLeads || 0;
            const failed = campaign.liveMetrics?.failed || campaign.failedCount || campaign.failedMessages || 0;
            const progress = total > 0 ? Math.round((sent / total) * 100) : 0;

            return (
              <Card
                key={campaign.id}
                className="cursor-pointer hover:shadow-md transition-shadow group"
                onClick={() => {
                  if (campaign.status === "draft") {
                    navigate(`/campaigns/${campaign.id}/wizard`);
                  } else {
                    navigate(`/campaigns/${campaign.id}`);
                  }
                }}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <CardTitle className="text-base truncate">{campaign.name}</CardTitle>
                      {campaign.description && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">{campaign.description}</p>
                      )}
                    </div>
                    <Badge variant="outline" className={`ml-2 shrink-0 ${config.color}`}>
                      <StatusIcon className="w-3 h-3 mr-1" />
                      {config.label}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-lg font-bold">{total}</p>
                      <p className="text-xs text-muted-foreground">Contatos</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-green-600">{sent}</p>
                      <p className="text-xs text-muted-foreground">Enviados</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-red-500">{failed}</p>
                      <p className="text-xs text-muted-foreground">Falhas</p>
                    </div>
                  </div>

                  {total > 0 && campaign.status !== "draft" && (
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>Progresso</span>
                        <span>{progress}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[#0066FF] rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-muted-foreground">
                      {campaign.createdAt
                        ? new Date(campaign.createdAt).toLocaleDateString("pt-BR")
                        : ""}
                    </span>
                    <div className="flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                      {campaign.status === "draft" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm("Excluir esta campanha?")) {
                              deleteMutation.mutate(campaign.id);
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-500" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/campaigns/${campaign.id}`);
                        }}
                      >
                        <BarChart3 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
