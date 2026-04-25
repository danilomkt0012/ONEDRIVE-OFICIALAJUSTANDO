import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import BotFlowEditor from "@/components/BotFlowEditor";
import AudioRecorder from "@/components/AudioRecorder";
import AudioFileUpload from "@/components/AudioFileUpload";
import {
  ArrowLeft,
  BarChart3,
  MessageSquare,
  Users,
  FileText,
  Play,
  Pause,
  Settings,
  Loader2,
  Send,
  CheckCircle2,
  XCircle,
  Eye,
  MessageCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  Bot,
  Plus,
  Trash2,
  Type,
  ImageIcon,
  Music,
  Tag,
  Info,
  ExternalLink,
  Globe,
  Shield,
  Copy,
  CheckCircle,
  Key,
  Zap,
  Activity,
  Gauge,
  TrendingUp,
  TrendingDown,
} from "lucide-react";

const statusConfig: Record<string, { label: string; color: string }> = {
  draft: { label: "Rascunho", color: "bg-gray-100 text-gray-700" },
  active: { label: "Ativa", color: "bg-green-100 text-green-700" },
  running: { label: "Enviando", color: "bg-blue-100 text-blue-700" },
  paused: { label: "Pausada", color: "bg-yellow-100 text-yellow-700" },
  completed: { label: "Concluída", color: "bg-emerald-100 text-emerald-700" },
  failed: { label: "Falhou", color: "bg-red-100 text-red-700" },
  generating_audio: { label: "Gerando Áudio", color: "bg-orange-100 text-orange-700" },
};

function HotUpdateDialog({ open, onOpenChange, campaign, hotUpdating, onApply, onGoToBotTab }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  campaign: Record<string, unknown>;
  hotUpdating: boolean;
  onApply: (updates: Record<string, unknown>) => void;
  onGoToBotTab: () => void;
}) {
  const [editBurstMode, setEditBurstMode] = useState(false);
  const [editBusinessHours, setEditBusinessHours] = useState(false);
  const [editBotEnabled, setEditBotEnabled] = useState(false);

  useEffect(() => {
    if (open && campaign) {
      setEditBurstMode(!!campaign.burstMode);
      setEditBusinessHours(!!campaign.businessHoursOnly);
      setEditBotEnabled(!!campaign.automationEnabled);
    }
  }, [open, campaign]);

  if (!campaign) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-[#0066FF]" />
            Edição ao Vivo
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
            <AlertTriangle className="w-4 h-4 inline mr-1" />
            O motor será pausado brevemente (~2-5s) para aplicar as mudanças com segurança.
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Envio Simultâneo</Label>
              <Switch checked={editBurstMode} onCheckedChange={setEditBurstMode} />
            </div>

            <div className="flex items-center justify-between">
              <Label>Horário Comercial</Label>
              <Switch checked={editBusinessHours} onCheckedChange={setEditBusinessHours} />
            </div>

            <div className="flex items-center justify-between">
              <Label>Bot Automático</Label>
              <Switch checked={editBotEnabled} onCheckedChange={setEditBotEnabled} />
            </div>
          </div>

          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p>Para configurar regras de palavras-chave, fallback e fluxo avançado do bot, acesse a aba Bot completa.</p>
                <Button
                  variant="link"
                  size="sm"
                  className="text-blue-700 underline p-0 h-auto mt-1"
                  onClick={() => {
                    onOpenChange(false);
                    onGoToBotTab();
                  }}
                >
                  <ExternalLink className="w-3 h-3 mr-1" />
                  Ir para aba Bot
                </Button>
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1"
              disabled={hotUpdating}
              onClick={() => {
                onApply({
                  botConfig: campaign.botConfig,
                  sendConfig: {
                    ...(campaign.sendConfig as Record<string, unknown> || {}),
                    burstMode: editBurstMode,
                    businessHoursOnly: editBusinessHours,
                  },
                  automationEnabled: editBotEnabled,
                });
              }}
            >
              {hotUpdating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  Aplicando...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-1" />
                  Aplicar Mudancas
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function humanizeMetaError(errorCode: string, errorMessage: string): string {
  if (errorCode === "132001" || errorMessage?.includes("132001") || errorMessage?.toLowerCase().includes("template name does not exist")) {
    const templateNameMatch = errorMessage?.match(/template['\s]+(['\w]+)/i) || errorMessage?.match(/'([^']+)'/);
    const templateName = templateNameMatch?.[1] || "desconhecido";
    return `Template '${templateName}' não encontrado na Meta — verifique se ele existe e tem tradução em pt_BR no painel da Meta (WhatsApp → Modelos de mensagem).`;
  }
  if (errorCode === "131047" || errorMessage?.includes("131047") || errorMessage?.toLowerCase().includes("re-engagement")) {
    return "Mensagem fora da janela de 24h — o contato não pode ser alcançado com mensagem de marketing agora. Use um template de utilidade ou aguarde uma interação do contato.";
  }
  if (errorCode === "131026" || errorMessage?.includes("131026") || errorMessage?.toLowerCase().includes("not in whitelist")) {
    return "Número não está na lista de permissões do WhatsApp Business. Verifique o status da conta.";
  }
  if (errorCode === "130429" || errorMessage?.includes("130429") || errorMessage?.toLowerCase().includes("rate limit")) {
    return "Limite de velocidade de envio atingido — o sistema aguardará automaticamente antes de continuar.";
  }
  if (errorCode === "131021" || errorMessage?.includes("131021")) {
    return "Número de destinatário inválido ou não existe no WhatsApp. O número foi ignorado.";
  }
  if (errorMessage?.toLowerCase().includes("access token") || errorMessage?.toLowerCase().includes("oauth")) {
    return "Token de acesso inválido ou expirado — reconfigure as credenciais Meta na etapa de Integração.";
  }
  return errorMessage || `Erro desconhecido (código: ${errorCode})`;
}

function AppWebhookTab({ campaignId }: { campaignId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ["/api/config"],
    queryFn: async () => {
      const res = await fetch("/api/config");
      if (!res.ok) return null;
      return res.json();
    },
  });

  const { data: serverStatus } = useQuery({
    queryKey: ["/api/server-status"],
    queryFn: async () => {
      const res = await fetch("/api/server-status");
      if (!res.ok) return { webhookUrl: "" };
      return res.json();
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (config) {
      setAccessToken(config.metaToken || "");
      setAppSecret(config.appSecret || "");
      setVerifyToken(config.webhookVerifyToken || "");
    }
  }, [config]);

  const webhookOk = !!verifyToken && !!appSecret;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metaToken: accessToken,
          whatsappBusinessId: config?.whatsappBusinessId || "",
          appSecret: appSecret || undefined,
          webhookVerifyToken: verifyToken || undefined,
        }),
      });
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ["/api/config"] });
        toast({ title: "Configurações salvas", description: "As configurações de integração foram atualizadas com sucesso." });
      } else {
        toast({ title: "Erro ao salvar", description: "Não foi possível salvar as configurações.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Erro de conexão", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleTestWebhook = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/webhook/test", { method: "POST" });
      const data = await res.json();
      setTestResult(data);
      if (data.success) {
        toast({ title: "Webhook OK", description: data.message });
      } else {
        toast({ title: "Falha no teste", description: data.error, variant: "destructive" });
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setTestResult({ success: false, error: errMsg });
    } finally {
      setTesting(false);
    }
  };

  const copyWebhookUrl = async () => {
    const url = serverStatus?.webhookUrl || "";
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copiado", description: "URL do webhook copiada." });
    } catch {
      toast({ title: "Erro ao copiar", variant: "destructive" });
    }
  };

  if (configLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {!webhookOk && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">Webhook não configurado</p>
            <p className="text-xs text-red-700 mt-0.5">
              Configure o App Secret e o Verify Token abaixo para que o bot possa responder às mensagens dos leads.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            <CardTitle className="text-base">URL do Webhook</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Configure esta URL no painel da Meta (WhatsApp → Configuração → Webhook).</p>
          {serverStatus?.webhookUrl ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-muted/50 border rounded-lg px-3 py-2 font-mono text-xs overflow-x-auto">
                {serverStatus.webhookUrl}
              </div>
              <Button variant="outline" size="sm" onClick={copyWebhookUrl}>
                {copied ? <CheckCircle className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">URL não disponível (servidor local ou sem deploy).</p>
          )}
          {serverStatus?.webhookWarning && (
            <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-2 py-1">
              {serverStatus.webhookWarning}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <CardTitle className="text-base">Credenciais de Integração</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs font-medium">Access Token Meta</Label>
            <div className="relative mt-1">
              <Input
                type={showToken ? "text" : "password"}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="EAAxxxxxxxxxxxxxxxx..."
                className="pr-10 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <XCircle className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium">App Secret</Label>
            <p className="text-[11px] text-muted-foreground mb-1">Necessário para validar assinaturas das mensagens recebidas pelo webhook.</p>
            <div className="relative">
              <Input
                type={showSecret ? "text" : "password"}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="Seu App Secret do Meta Developer..."
                className="pr-10 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showSecret ? <XCircle className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <Label className="text-xs font-medium">Verify Token</Label>
            <p className="text-[11px] text-muted-foreground mb-1">Token para verificação do webhook pela Meta. Cole o mesmo valor no campo "Token de verificação" no painel Meta.</p>
            <Input
              value={verifyToken}
              onChange={(e) => setVerifyToken(e.target.value)}
              placeholder="Seu verify token..."
              className="text-xs font-mono"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleTestWebhook}
              disabled={testing}
              className="flex-1"
            >
              {testing ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Testando...</>
              ) : (
                <><Globe className="w-4 h-4 mr-1" /> Testar Webhook</>
              )}
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="flex-1"
            >
              {saving ? (
                <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Salvando...</>
              ) : (
                "Salvar Configurações"
              )}
            </Button>
          </div>

          {testResult && (
            <div className={`p-3 rounded-lg border text-xs ${testResult.success ? "bg-green-50 border-green-200 text-green-700" : "bg-red-50 border-red-200 text-red-700"}`}>
              <div className="flex items-center gap-1.5 font-semibold mb-0.5">
                {testResult.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                {testResult.success ? "Webhook funcionando corretamente" : "Falha no teste"}
              </div>
              <p>{testResult.success ? testResult.message : testResult.error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-800 space-y-1">
            <p className="font-semibold">Como configurar o webhook na Meta:</p>
            <ol className="space-y-0.5 list-decimal list-inside">
              <li>Acesse developers.facebook.com → Seu App → WhatsApp → Configuração</li>
              <li>Cole a URL do webhook acima no campo "URL de retorno de chamada"</li>
              <li>Cole o Verify Token no campo "Token de verificação" e clique em "Verificar e salvar"</li>
              <li>Inscreva-se nos campos: messages, message_deliveries, message_reads</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

interface BotRule {
  keyword: string;
  response: string;
  responseType: string;
  mediaUrl?: string;
}

function BotTabContent({ campaignId, campaign }: { campaignId: string; campaign: Record<string, unknown> }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [botEnabled, setBotEnabled] = useState(!!campaign.automationEnabled);
  const [fallback, setFallback] = useState((campaign.automationFallback as string) || "silence");
  const [fallbackMessage, setFallbackMessage] = useState<string>(() => {
    const cfg = campaign.botConfig as Record<string, unknown> | undefined;
    return (cfg?.fallbackMessage as string) || "";
  });
  const [botRules, setBotRules] = useState<BotRule[]>(() => {
    const rules = campaign.automationRules as BotRule[] | undefined;
    return (rules || []).map((r) => ({
      keyword: r.keyword || "",
      response: r.response || "",
      responseType: r.responseType || "text",
      mediaUrl: r.mediaUrl || "",
    }));
  });
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLocalEdit = useRef(false);

  useEffect(() => {
    setBotEnabled(!!campaign.automationEnabled);
    setFallback((campaign.automationFallback as string) || "silence");
    const cfg = campaign.botConfig as Record<string, unknown> | undefined;
    setFallbackMessage((cfg?.fallbackMessage as string) || "");
    if (!isLocalEdit.current) {
      const rules = campaign.automationRules as BotRule[] | undefined;
      setBotRules((rules || []).map((r) => ({
        keyword: r.keyword || "",
        response: r.response || "",
        responseType: r.responseType || "text",
        mediaUrl: r.mediaUrl || "",
      })));
    }
    isLocalEdit.current = false;
  }, [campaign.automationEnabled, campaign.automationFallback, campaign.automationRules, campaign.botConfig]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const persistBotConfig = useCallback(async (enabled: boolean, fb: string, rules: BotRule[], fbMessage: string) => {
    setSaving(true);
    try {
      const existingBotConfig = (campaign.botConfig as Record<string, unknown>) || {};
      const res = await fetch(`/api/campaigns/managed/${campaignId}/bot`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationEnabled: enabled,
          automationFallback: fb,
          fallbackMessage: fbMessage,
          botConfig: { ...existingBotConfig, fallbackMessage: fbMessage },
          rules: rules.map((r) => ({
            keyword: r.keyword,
            response: r.response,
            responseType: r.responseType || "text",
            mediaUrl: r.mediaUrl || undefined,
          })),
        }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] });
      } else {
        toast({ title: "Erro ao salvar", description: "Não foi possível salvar as configurações.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Erro de conexão", description: "Não foi possível conectar ao servidor. Tente novamente.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [campaignId, toast, queryClient, campaign.botConfig]);

  const debouncedSave = useCallback((enabled: boolean, fb: string, rules: BotRule[], fbMessage: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistBotConfig(enabled, fb, rules, fbMessage);
    }, 800);
  }, [persistBotConfig]);

  const handleToggleBot = useCallback((checked: boolean) => {
    setBotEnabled(checked);
    debouncedSave(checked, fallback, botRules, fallbackMessage);
  }, [fallback, botRules, fallbackMessage, debouncedSave]);

  const handleFallbackChange = useCallback((value: string) => {
    setFallback(value);
    debouncedSave(botEnabled, value, botRules, fallbackMessage);
  }, [botEnabled, botRules, fallbackMessage, debouncedSave]);

  const handleFallbackMessageChange = useCallback((value: string) => {
    setFallbackMessage(value);
    debouncedSave(botEnabled, fallback, botRules, value);
  }, [botEnabled, fallback, botRules, debouncedSave]);

  const updateRulesAndSave = useCallback((newRules: BotRule[]) => {
    isLocalEdit.current = true;
    setBotRules(newRules);
    debouncedSave(botEnabled, fallback, newRules, fallbackMessage);
  }, [botEnabled, fallback, fallbackMessage, debouncedSave]);

  return (
    <div className="space-y-4">
      {/* Block 1: Bot Activation */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Bot className="w-4 h-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Ativação do Bot</CardTitle>
                <p className="text-xs text-muted-foreground">Habilite o bot automático para esta campanha</p>
              </div>
            </div>
            {saving && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                Salvando...
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border/50">
            <div>
              <p className="text-sm font-medium">Bot Automático</p>
              <p className="text-xs text-muted-foreground mt-0.5">Responde automaticamente a mensagens recebidas dos contatos</p>
            </div>
            <Switch checked={botEnabled} onCheckedChange={handleToggleBot} />
          </div>
        </CardContent>
      </Card>

      {botEnabled && (
        <>
          {/* Block 2: Fallback Behavior */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                </div>
                <div>
                  <CardTitle className="text-sm font-semibold">Comportamento de Fallback</CardTitle>
                  <p className="text-xs text-muted-foreground">O que acontece quando nenhuma palavra-chave corresponde</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ação ao não reconhecer a mensagem</Label>
                <Select value={fallback} onValueChange={handleFallbackChange}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="silence">Silêncio (não responder)</SelectItem>
                    <SelectItem value="default">Mensagem padrão</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {fallback === "default" && (
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mensagem de fallback</Label>
                  <Textarea
                    placeholder="Ex: Desculpe, não entendi sua resposta. Por favor, tente novamente."
                    value={fallbackMessage}
                    onChange={(e) => handleFallbackMessageChange(e.target.value)}
                    rows={3}
                    className="text-sm resize-none"
                  />
                  <p className="text-xs text-muted-foreground">Esta mensagem será enviada quando nenhuma regra de palavra-chave corresponder.</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Block 3: Keyword Rules */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <Key className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <CardTitle className="text-sm font-semibold">Regras de Palavras-chave</CardTitle>
                  <p className="text-xs text-muted-foreground">Cada regra detecta uma palavra-chave e dispara uma resposta automática</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {botRules.length === 0 && (
                <div className="text-center py-6 border-2 border-dashed rounded-lg">
                  <Key className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">Nenhuma regra configurada</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Adicione regras para responder automaticamente a palavras-chave</p>
                </div>
              )}
              {botRules.map((rule, idx) => (
                <div key={idx} className="border rounded-lg p-4 space-y-3 bg-card">
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                      {idx + 1}
                    </span>
                    <Input
                      placeholder="Palavra-chave (ex: preço, ajuda, sim)"
                      value={rule.keyword}
                      onChange={(e) => {
                        const updated = [...botRules];
                        updated[idx] = { ...updated[idx], keyword: e.target.value };
                        updateRulesAndSave(updated);
                      }}
                      className="flex-1 h-8 text-sm"
                    />
                    <Select
                      value={rule.responseType || "text"}
                      onValueChange={(v) => {
                        const updated = [...botRules];
                        updated[idx] = { ...updated[idx], responseType: v };
                        updateRulesAndSave(updated);
                      }}
                    >
                      <SelectTrigger className="w-32 h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text"><span className="flex items-center gap-1"><Type className="w-3 h-3" /> Texto</span></SelectItem>
                        <SelectItem value="image"><span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" /> Imagem</span></SelectItem>
                        <SelectItem value="audio"><span className="flex items-center gap-1"><Music className="w-3 h-3" /> Áudio</span></SelectItem>
                        <SelectItem value="combined"><span className="flex items-center gap-1"><Tag className="w-3 h-3" /> Combinado</span></SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-red-500 hover:text-red-600 hover:bg-red-50"
                      onClick={() => updateRulesAndSave(botRules.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>

                  <div>
                    <Textarea
                      placeholder="Texto da resposta..."
                      value={rule.response}
                      onChange={(e) => {
                        const updated = [...botRules];
                        updated[idx] = { ...updated[idx], response: e.target.value };
                        updateRulesAndSave(updated);
                      }}
                      rows={2}
                      className="text-sm resize-none"
                    />
                  </div>

                  {(rule.responseType === "image" || rule.responseType === "audio" || rule.responseType === "combined") && (
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">
                        {rule.responseType === "image" ? "URL da Imagem" : rule.responseType === "audio" ? "URL do Áudio" : "URL da Mídia (imagem ou áudio)"}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          placeholder="https://exemplo.com/mídia.jpg"
                          value={rule.mediaUrl || ""}
                          onChange={(e) => {
                            const updated = [...botRules];
                            updated[idx] = { ...updated[idx], mediaUrl: e.target.value };
                            updateRulesAndSave(updated);
                          }}
                          className="h-8 text-sm flex-1"
                        />
                        {(rule.responseType === "audio" || rule.responseType === "combined") && (
                          <>
                            <AudioFileUpload
                              onUploaded={(url) => {
                                const updated = [...botRules];
                                updated[idx] = { ...updated[idx], mediaUrl: url };
                                updateRulesAndSave(updated);
                              }}
                            />
                            <AudioRecorder
                              onRecorded={(url) => {
                                const updated = [...botRules];
                                updated[idx] = { ...updated[idx], mediaUrl: url };
                                updateRulesAndSave(updated);
                              }}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {rule.responseType === "combined" && (
                    <p className="text-[10px] text-muted-foreground bg-muted/30 rounded px-2 py-1">
                      Combinado: envia o texto + a mídia na mesma regra. O texto será enviado como caption da mídia.
                    </p>
                  )}
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => updateRulesAndSave([...botRules, { keyword: "", response: "", responseType: "text", mediaUrl: "" }])}
              >
                <Plus className="w-3 h-3 mr-1.5" />
                Adicionar Regra
              </Button>
            </CardContent>
          </Card>

          {/* Block 4: Advanced Flow */}
          <div className="sticky top-0 z-20 flex items-center justify-between bg-background/95 backdrop-blur-sm border border-purple-200 dark:border-purple-800 rounded-lg px-4 py-2.5 shadow-sm">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                <Zap className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">Fluxo de Conversa Avançado</p>
                <p className="text-xs text-muted-foreground">Funil guiado com etapas, condições e timeouts</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground italic hidden sm:block">Os botões Pausar / Salvar estão no topo do editor</p>
          </div>
          <Card className="border-dashed">
            <CardContent className="pt-4">
              <BotFlowEditor campaignId={campaignId} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

interface SenderHealthItem {
  phoneNumberId: string;
  displayNumber?: string;
  wabaName?: string;
  score: number;
  samples: number;
  qualityRating: string;
  weightShare: number;
  weightSharePercent: number;
  status: 'excelente' | 'bom' | 'regular' | 'atencao' | 'critico';
}

function statusColor(status: string): string {
  switch (status) {
    case 'excelente': return 'bg-green-500';
    case 'bom': return 'bg-emerald-500';
    case 'regular': return 'bg-yellow-500';
    case 'atencao': return 'bg-orange-500';
    case 'critico': return 'bg-red-500';
    default: return 'bg-gray-400';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'excelente': return 'Excelente';
    case 'bom': return 'Bom';
    case 'regular': return 'Regular';
    case 'atencao': return 'Atenção';
    case 'critico': return 'Crítico';
    default: return status;
  }
}

function qualityColor(q: string): string {
  switch ((q || '').toUpperCase()) {
    case 'GREEN': return 'bg-green-100 text-green-700 border-green-200';
    case 'YELLOW': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
    case 'RED': return 'bg-red-100 text-red-700 border-red-200';
    default: return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

function SenderHealthPanel() {
  const { data, isLoading, refetch } = useQuery<{ numbers: SenderHealthItem[]; totalNumbers: number }>({
    queryKey: ["/api/dispatch/sender-health"],
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground mt-2">Carregando saúde dos números...</p>
        </CardContent>
      </Card>
    );
  }

  const numbers = data?.numbers || [];
  if (numbers.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Activity className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" />
          <p className="text-sm text-muted-foreground">Nenhum número registrado ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">Configure uma WABA e registre números na aba <strong>App</strong>.</p>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...numbers].sort((a, b) => b.score - a.score);
  const avgScore = sorted.reduce((s, n) => s + n.score, 0) / sorted.length;
  const totalShare = sorted.reduce((s, n) => s + n.weightSharePercent, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <Gauge className="w-4 h-4 text-blue-600" />
                Saúde dos Números (tempo real)
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Score médio: <strong>{avgScore.toFixed(0)}/100</strong> · {sorted.length} números ativos · distribuição auto-balanceada
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => refetch()} data-testid="button-refresh-health">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {sorted.map((n) => (
            <div
              key={n.phoneNumberId}
              data-testid={`row-sender-${n.phoneNumberId}`}
              className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors"
            >
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor(n.status)}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm tabular-nums" data-testid={`text-sender-number-${n.phoneNumberId}`}>
                    {n.displayNumber || n.phoneNumberId}
                  </span>
                  {n.wabaName && (
                    <span className="text-[10px] text-muted-foreground truncate">· {n.wabaName}</span>
                  )}
                  <Badge variant="outline" className={`text-[10px] h-4 px-1.5 ${qualityColor(n.qualityRating)}`}>
                    {n.qualityRating || 'UNKNOWN'}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                    {statusLabel(n.status)}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <div className="flex-1 max-w-xs">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] text-muted-foreground">Score</span>
                      <span className="text-[10px] font-semibold tabular-nums" data-testid={`text-score-${n.phoneNumberId}`}>{n.score}/100</span>
                    </div>
                    <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${statusColor(n.status)} transition-all`}
                        style={{ width: `${Math.min(100, n.score)}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-muted-foreground">Peso na rotação</div>
                    <div className="text-sm font-semibold tabular-nums" data-testid={`text-share-${n.phoneNumberId}`}>
                      {n.weightSharePercent.toFixed(1)}%
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] text-muted-foreground">Amostras</div>
                    <div className="text-sm font-semibold tabular-nums">{n.samples.toLocaleString("pt-BR")}</div>
                  </div>
                </div>
              </div>
              {n.score >= 70 ? (
                <TrendingUp className="w-4 h-4 text-green-600 flex-shrink-0" />
              ) : n.score < 40 ? (
                <TrendingDown className="w-4 h-4 text-red-500 flex-shrink-0" />
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50/50 border border-blue-100">
        <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-blue-900 leading-relaxed">
          <strong>Política em ação:</strong> nenhum número é pausado automaticamente.
          Quando um cai de qualidade, o peso dele diminui (mínimo 5%) e os outros absorvem o volume.
          Total atual de pesos: <strong>{totalShare.toFixed(1)}%</strong>.
        </div>
      </div>
    </div>
  );
}

export default function CampaignDetailPage() {
  const [, params] = useRoute("/campaigns/:id");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const campaignId = params?.id;

  const [activeTab, setActiveTab] = useState("metrics");
  const [showHotUpdate, setShowHotUpdate] = useState(false);
  const [hotUpdating, setHotUpdating] = useState(false);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data: appConfig } = useQuery({
    queryKey: ["/api/config"],
    queryFn: async () => {
      const res = await fetch("/api/config");
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 30000,
  });

  const { data: campaign, isLoading } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}`);
      if (!res.ok) throw new Error("Campanha não encontrada");
      return res.json();
    },
    enabled: !!campaignId,
    refetchInterval: 5000,
  });

  const isGeneratingAudio = campaign?.status === "generating_audio";
  const isRunning = campaign?.status === "running";
  const isTtsPhase = isGeneratingAudio || isRunning;

  const { data: ttsProgress } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId, "tts-progress"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/tts-progress`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!campaignId && isTtsPhase,
    refetchInterval: isTtsPhase ? 4000 : false,
  });

  const hasPendingTtsJobs = ttsProgress && ttsProgress.total > 0 && ttsProgress.generated + ttsProgress.failed < ttsProgress.total;

  useEffect(() => {
    if (!campaignId) return;
    const evtSource = new EventSource(`/api/campaigns/managed/${campaignId}/sse`);
    evtSource.onmessage = (event) => {
      try {
        const sseData = JSON.parse(event.data);
        queryClient.setQueryData(["/api/campaigns/managed", campaignId], (old: Record<string, unknown> | undefined) => {
          if (!old) return old;
          return { ...old, ...sseData };
        });
        queryClient.setQueryData(["/api/campaigns/managed", campaignId, "metrics"], (old: Record<string, unknown> | undefined) => {
          if (!old) return { ...sseData };
          return { ...old, ...sseData };
        });
      } catch {}
    };
    return () => evtSource.close();
  }, [campaignId, queryClient]);

  const { data: metricsData } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId, "metrics"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/metrics`);
      if (!res.ok) throw new Error("Erro ao buscar métricas");
      return res.json();
    },
    enabled: !!campaignId && activeTab === "metrics",
    refetchInterval: 5000,
  });

  const { data: wabaDistData } = useQuery<{ campaignId: string; active: boolean; distribution: Array<{ wabaId: string; sent: number; success: number; failed: number; blocked: number; successRate: number; errorRate: number; blockRate: number; score: number; weight: number; totalSent: number; totalSuccess: number; totalFailed: number; totalBlocked: number; picked: number }> }>({
    queryKey: ["/api/campaigns", campaignId, "waba-distribution"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/waba-distribution`);
      if (!res.ok) return { campaignId: campaignId!, active: false, distribution: [] };
      return res.json();
    },
    enabled: !!campaignId && activeTab === "metrics",
    refetchInterval: 5000,
  });

  const { data: contacts = [] } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId, "contacts"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/contacts`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!campaignId && activeTab === "contacts",
    refetchInterval: 10000,
  });

  const { data: logsData } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId, "logs"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/logs`);
      if (!res.ok) return { liveLogs: [], errorLogs: [] };
      return res.json();
    },
    enabled: !!campaignId && activeTab === "logs",
    refetchInterval: 5000,
  });

  const { data: chatData } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId, "chat"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/chat`);
      if (!res.ok) return { data: [], total: 0 };
      return res.json();
    },
    enabled: !!campaignId && activeTab === "chat",
    refetchInterval: 10000,
  });

  const { data: chatMessages = [] } = useQuery({
    queryKey: ["/api/conversations", selectedConversation, "messages"],
    queryFn: async () => {
      if (!selectedConversation) return [];
      const res = await fetch(`/api/conversations/${selectedConversation}/messages`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedConversation,
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/start`, { method: "POST" });
      if (!res.ok) throw new Error("Falha ao iniciar campanha");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] }),
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/pause`, { method: "POST" });
      if (!res.ok) throw new Error("Falha ao pausar");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] }),
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/resume`, { method: "POST" });
      if (!res.ok) throw new Error("Falha ao retomar");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] }),
  });

  const restartMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/restart`, { method: "POST" });
      if (!res.ok) throw new Error("Falha ao reiniciar campanha");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] });
      navigate(`/campaigns/${campaignId}/wizard`);
    },
  });

  const hotUpdateMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/hot-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Falha no hot update");
      return res.json();
    },
    onSuccess: () => {
      setShowHotUpdate(false);
      setHotUpdating(false);
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] });
    },
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  if (isLoading || !campaign) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const status = statusConfig[campaign.status] || statusConfig.draft;
  const live = campaign.liveMetrics;
  const sent = live?.accepted || campaign.sentCount || campaign.sentMessages || 0;
  const total = campaign.totalLeads || 0;
  const failed = live?.failed || campaign.failedCount || campaign.failedMessages || 0;
  const delivered = campaign.deliveredCount || 0;
  const read = campaign.readCount || 0;
  const replied = campaign.repliedCount || 0;
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;

  const webhookConfigured = !!(appConfig?.webhookVerifyToken && appConfig?.appSecret);

  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="min-h-[44px] px-2 sm:px-3" onClick={() => navigate("/campaigns")}>
            <ArrowLeft className="w-4 h-4 sm:mr-1" />
            <span className="hidden sm:inline">Campanhas</span>
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base sm:text-xl font-bold truncate">{campaign.name}</h1>
              <Badge className={`${status.color} flex-shrink-0`}>{status.label}</Badge>
              {(campaign as any).dispatchMode && (
                <Badge
                  variant="outline"
                  className={`flex-shrink-0 gap-1 ${
                    (campaign as any).dispatchMode === 'turbo' ? 'border-orange-300 bg-orange-50 text-orange-700'
                    : (campaign as any).dispatchMode === 'seguro' ? 'border-green-300 bg-green-50 text-green-700'
                    : 'border-blue-300 bg-blue-50 text-blue-700'
                  }`}
                  data-testid={`badge-dispatch-${(campaign as any).dispatchMode}`}
                >
                  {(campaign as any).dispatchMode === 'turbo' ? <Zap className="w-3 h-3" />
                    : (campaign as any).dispatchMode === 'seguro' ? <Shield className="w-3 h-3" />
                    : <Gauge className="w-3 h-3" />}
                  {(campaign as any).dispatchMode === 'turbo' ? 'Turbo'
                    : (campaign as any).dispatchMode === 'seguro' ? 'Seguro' : 'Equilibrado'}
                </Badge>
              )}
            </div>
            {campaign.description && (
              <p className="text-xs sm:text-sm text-muted-foreground truncate">{campaign.description}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2 overflow-x-auto scrollbar-hide flex-shrink-0">
          {campaign.status === "draft" && (
            <Button variant="outline" size="sm" className="min-h-[44px] flex-shrink-0" onClick={() => navigate(`/campaigns/${campaignId}/wizard`)}>
              <Settings className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">Configurar</span>
            </Button>
          )}
          {campaign.status === "running" && (
            <>
              <Button variant="outline" size="sm" className="min-h-[44px] flex-shrink-0" onClick={() => setShowHotUpdate(true)}>
                <Settings className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Editar ao Vivo</span>
              </Button>
              <Button variant="outline" size="sm" className="min-h-[44px] flex-shrink-0" onClick={() => pauseMutation.mutate()}>
                <Pause className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Pausar</span>
              </Button>
            </>
          )}
          {campaign.status === "generating_audio" && (
            <Button variant="outline" size="sm" className="min-h-[44px] flex-shrink-0" disabled>
              <Loader2 className="w-4 h-4 sm:mr-1 animate-spin" />
              <span className="hidden sm:inline">Gerando Áudio...</span>
            </Button>
          )}
          {campaign.status === "paused" && (
            <Button size="sm" className="min-h-[44px] flex-shrink-0" onClick={() => resumeMutation.mutate()}>
              <Play className="w-4 h-4 sm:mr-1" />
              Retomar
            </Button>
          )}
          {(campaign.status === "draft" || campaign.status === "paused") && (
            <Button size="sm" className="min-h-[44px] flex-shrink-0" onClick={() => startMutation.mutate()}>
              <Play className="w-4 h-4 sm:mr-1" />
              {campaign.status === "draft" ? "Iniciar" : "Retomar"}
            </Button>
          )}
          {(campaign.status === "failed" || campaign.status === "completed") && (
            <Button variant="outline" size="sm" className="min-h-[44px] flex-shrink-0" onClick={() => restartMutation.mutate()}>
              <RefreshCw className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">Reiniciar</span>
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3">
        {[
          { label: "Total", value: total, icon: Users, color: "text-blue-600" },
          { label: "Enviados", value: sent, icon: Send, color: "text-green-600" },
          { label: "Entregues", value: delivered, icon: CheckCircle2, color: "text-emerald-600" },
          { label: "Lidos", value: read, icon: Eye, color: "text-purple-600" },
          { label: "Respostas", value: replied, icon: MessageCircle, color: "text-indigo-600" },
          { label: "Falhas", value: failed, icon: XCircle, color: "text-red-600" },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardContent className="pt-3 sm:pt-4 pb-2 sm:pb-3 text-center px-2">
              <metric.icon className={`w-4 sm:w-5 h-4 sm:h-5 mx-auto mb-1 ${metric.color}`} />
              <p className="text-lg sm:text-2xl font-bold">{metric.value}</p>
              <p className="text-[10px] sm:text-xs text-muted-foreground">{metric.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {(isGeneratingAudio || (isRunning && hasPendingTtsJobs)) && (
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3 mb-3">
              <Loader2 className="w-5 h-5 text-orange-600 animate-spin flex-shrink-0" />
              <div>
                <p className="font-semibold text-orange-800">
                  {isGeneratingAudio ? "Gerando áudio para todos os leads" : "Gerando áudio em segundo plano"}
                </p>
                <p className="text-sm text-orange-700">
                  {isGeneratingAudio
                    ? "Os primeiros leads já estão sendo processados. A campanha iniciará em breve."
                    : "A campanha está ativa. Áudios dos leads restantes sendo gerados."}
                </p>
              </div>
            </div>
            {ttsProgress && ttsProgress.total > 0 ? (
              <div>
                <div className="flex justify-between text-sm text-orange-700 mb-2">
                  <span>{ttsProgress.generated} / {ttsProgress.total} áudios prontos</span>
                  <span>{Math.round((ttsProgress.generated / ttsProgress.total) * 100)}%</span>
                </div>
                <div className="h-3 bg-orange-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-500 rounded-full transition-all duration-500"
                    style={{ width: `${Math.round((ttsProgress.generated / ttsProgress.total) * 100)}%` }}
                  />
                </div>
                {ttsProgress.failed > 0 && (
                  <p className="text-xs text-red-600 mt-1">{ttsProgress.failed} áudio(s) com erro — a campanha continuará com os que foram gerados com sucesso.</p>
                )}
              </div>
            ) : (
              <div className="h-3 bg-orange-200 rounded-full overflow-hidden">
                <div className="h-full bg-orange-400 rounded-full animate-pulse" style={{ width: "5%" }} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {total > 0 && campaign.status !== "draft" && campaign.status !== "generating_audio" && (
        <div>
          <div className="flex justify-between text-sm text-muted-foreground mb-1">
            <span>Progresso</span>
            <span>{progress}%</span>
          </div>
          <div className="h-3 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-[#0066FF] rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {!webhookConfigured && campaign.status !== "draft" && (
        <div className="p-4 bg-red-50 border border-red-300 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-800">Bot não responderá às mensagens</p>
            <p className="text-xs text-red-700 mt-0.5">
              O Webhook não está configurado corretamente (App Secret ou Verify Token ausente). Respostas dos leads não serão processadas pelo bot enquanto isso não for corrigido.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 text-red-700 border-red-300 hover:bg-red-100 text-xs h-7"
              onClick={() => setActiveTab("app")}
            >
              <Globe className="w-3.5 h-3.5 mr-1" />
              Configurar App/Webhook
            </Button>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="metrics" className="gap-1">
            <BarChart3 className="w-4 h-4" />
            <span className="hidden sm:inline">Métricas</span>
          </TabsTrigger>
          <TabsTrigger value="senders" className="gap-1" data-testid="tab-senders">
            <Activity className="w-4 h-4" />
            <span className="hidden sm:inline">Números</span>
          </TabsTrigger>
          <TabsTrigger value="bot" className="gap-1">
            <Bot className="w-4 h-4" />
            <span className="hidden sm:inline">Bot</span>
          </TabsTrigger>
          <TabsTrigger value="chat" className="gap-1">
            <MessageSquare className="w-4 h-4" />
            <span className="hidden sm:inline">Chat</span>
          </TabsTrigger>
          <TabsTrigger value="contacts" className="gap-1">
            <Users className="w-4 h-4" />
            <span className="hidden sm:inline">Contatos</span>
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1">
            <FileText className="w-4 h-4" />
            <span className="hidden sm:inline">Logs</span>
          </TabsTrigger>
          <TabsTrigger value="app" className={`gap-1 ${!webhookConfigured ? "text-red-600" : ""}`}>
            <Globe className="w-4 h-4" />
            <span className="hidden sm:inline">App</span>
            {!webhookConfigured && <AlertTriangle className="w-3 h-3 text-red-500" />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="senders" className="mt-4">
          <SenderHealthPanel />
        </TabsContent>

        <TabsContent value="metrics" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Velocidade de Envio</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {live?.speedCurrent?.toFixed(1) || "0.0"} <span className="text-sm font-normal text-muted-foreground">msg/s</span>
                </div>
                {live && (
                  <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">Pico:</span>{" "}
                      {live.speedPeak?.toFixed(1) || "0"} msg/s
                    </div>
                    <div>
                      <span className="text-muted-foreground">Media:</span>{" "}
                      {live.speedAverage?.toFixed(1) || "0"} msg/s
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Taxa de Entrega</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {sent > 0 ? Math.round(((delivered || sent) / sent) * 100) : 0}%
                </div>
                <div className="grid grid-cols-3 gap-2 mt-3 text-sm">
                  <div>
                    <span className="text-green-600 font-semibold">{delivered}</span>
                    <p className="text-xs text-muted-foreground">Entregues</p>
                  </div>
                  <div>
                    <span className="text-purple-600 font-semibold">{read}</span>
                    <p className="text-xs text-muted-foreground">Lidos</p>
                  </div>
                  <div>
                    <span className="text-indigo-600 font-semibold">{replied}</span>
                    <p className="text-xs text-muted-foreground">Respostas</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {metricsData?.deliveryBreakdown && Object.keys(metricsData.deliveryBreakdown).length > 0 && (
              <Card className="md:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Breakdown de Entrega</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(metricsData.deliveryBreakdown).map(([status, count]) => (
                      <div key={status} className="text-center p-2 bg-muted/50 rounded-lg">
                        <p className="text-lg font-bold">{count as number}</p>
                        <p className="text-xs text-muted-foreground capitalize">{status}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {live && (
              <Card className="md:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Status do Motor</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-muted-foreground">Estado:</span>{" "}
                      <Badge variant="outline">{live.status}</Badge>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Health:</span>{" "}
                      <Badge variant="outline">{live.healthState || "OK"}</Badge>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Tier:</span>{" "}
                      {live.tier || "N/A"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Concorrencia:</span>{" "}
                      {live.concurrency || 0}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {wabaDistData?.active && wabaDistData.distribution.length > 1 && (
              <Card className="md:col-span-2" data-testid="card-waba-distribution">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center justify-between">
                    <span>Distribuição Multi-WABA (Round-Robin Ponderado)</span>
                    <Badge variant="outline" className="text-xs">
                      {wabaDistData.distribution.length} WABAs ativos
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {wabaDistData.distribution.map((w) => {
                      const totalPicked = wabaDistData.distribution.reduce((s, x) => s + (x.picked || 0), 0);
                      const sharePct = totalPicked > 0 ? (w.picked / totalPicked) * 100 : 0;
                      const scorePct = Math.round(w.score * 100);
                      const scoreColor =
                        w.score >= 0.8 ? "bg-green-500" :
                        w.score >= 0.5 ? "bg-yellow-500" : "bg-red-500";
                      return (
                        <div
                          key={w.wabaId}
                          className="border rounded-lg p-3 space-y-2"
                          data-testid={`waba-card-${w.wabaId}`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className={`inline-block w-2 h-2 rounded-full ${scoreColor}`} />
                              <span className="font-mono text-xs text-muted-foreground" data-testid={`text-waba-id-${w.wabaId}`}>
                                {w.wabaId}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-xs">
                              <Badge variant="secondary" data-testid={`badge-waba-share-${w.wabaId}`}>
                                {sharePct.toFixed(1)}% do tráfego
                              </Badge>
                              <Badge variant="outline" data-testid={`badge-waba-score-${w.wabaId}`}>
                                Score {scorePct}
                              </Badge>
                            </div>
                          </div>
                          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full ${scoreColor} transition-all`}
                              style={{ width: `${Math.max(2, sharePct)}%` }}
                            />
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                            <div>
                              <span className="text-muted-foreground">Janela:</span>{" "}
                              <span className="font-semibold">{w.sent}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Sucesso:</span>{" "}
                              <span className="font-semibold text-green-600" data-testid={`text-waba-success-${w.wabaId}`}>
                                {w.success}
                              </span>
                              <span className="text-muted-foreground"> ({Math.round(w.successRate * 100)}%)</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Erros:</span>{" "}
                              <span className="font-semibold text-orange-600" data-testid={`text-waba-failed-${w.wabaId}`}>
                                {w.failed}
                              </span>
                              <span className="text-muted-foreground"> ({Math.round(w.errorRate * 100)}%)</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Bloqueios:</span>{" "}
                              <span className="font-semibold text-red-600" data-testid={`text-waba-blocked-${w.wabaId}`}>
                                {w.blocked}
                              </span>
                              <span className="text-muted-foreground"> ({Math.round(w.blockRate * 100)}%)</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Total:</span>{" "}
                              <span className="font-semibold" data-testid={`text-waba-total-${w.wabaId}`}>{w.totalSent}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-xs text-muted-foreground pt-1">
                      Score = 0.7·sucesso + 0.2·(1-erro) + 0.1·(1-bloqueio). Rebalanceia a cada 50 mensagens. WABA com score baixo recebe menos tráfego — nunca pausa completamente.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        <TabsContent value="bot" className="mt-4">
          <BotTabContent campaignId={campaignId!} campaign={campaign} />
        </TabsContent>

        <TabsContent value="chat" className="mt-4">
          <Card className="h-[600px]">
            <CardContent className="p-0 h-full flex">
              <div className="w-1/3 border-r overflow-y-auto">
                {chatData?.data?.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                    <MessageSquare className="w-8 h-8 mb-2" />
                    <p className="text-sm">Nenhuma conversa</p>
                  </div>
                ) : (
                  chatData?.data?.map((conv: any) => (
                    <div
                      key={conv.id}
                      className={`p-3 border-b cursor-pointer hover:bg-muted/50 transition-colors ${
                        selectedConversation === conv.id ? "bg-muted" : ""
                      }`}
                      onClick={() => setSelectedConversation(conv.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">
                            {conv.contactName || conv.contactPhone}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {conv.lastMessagePreview || "Sem mensagens"}
                          </p>
                        </div>
                        {conv.unreadCount > 0 && (
                          <Badge className="ml-2 bg-green-500 text-white text-xs">
                            {conv.unreadCount}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="flex-1 flex flex-col">
                {selectedConversation ? (
                  <>
                    <div className="p-3 border-b bg-muted/30">
                      <p className="font-medium text-sm">
                        {chatData?.data?.find((c: any) => c.id === selectedConversation)?.contactName || "Contato"}
                      </p>
                    </div>
                    <ScrollArea className="flex-1 p-3">
                      <div className="space-y-2">
                        {chatMessages.map((msg: any) => (
                          <div
                            key={msg.id}
                            className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[70%] px-3 py-2 rounded-lg text-sm ${
                                msg.direction === "outbound"
                                  ? "bg-green-100 text-green-900"
                                  : "bg-white border text-gray-900"
                              }`}
                            >
                              {msg.body || "[mídia]"}
                              <div className="flex items-center gap-1 mt-1 justify-end">
                                <span className="text-[10px] text-muted-foreground">
                                  {msg.sentAt ? new Date(msg.sentAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}
                                </span>
                                {msg.direction === "outbound" && (
                                  <span className="text-[10px]">
                                    {msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓"}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                        <div ref={chatEndRef} />
                      </div>
                    </ScrollArea>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <MessageSquare className="w-12 h-12 mx-auto mb-2" />
                      <p>Selecione uma conversa</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="contacts" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              {contacts.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-2" />
                  <p>Nenhum contato processado ainda</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-3">Telefone</th>
                        <th className="text-left py-2 px-3">Status</th>
                        <th className="text-left py-2 px-3">Enviado em</th>
                        <th className="text-left py-2 px-3">Entregue em</th>
                        <th className="text-left py-2 px-3">Lido em</th>
                        <th className="text-left py-2 px-3">Erro</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.slice(0, 100).map((contact: any) => (
                        <tr key={contact.id} className="border-b hover:bg-muted/50">
                          <td className="py-2 px-3 font-mono text-xs">{contact.phoneNumber}</td>
                          <td className="py-2 px-3">
                            <Badge
                              variant="outline"
                              className={
                                contact.status === "sent" || contact.status === "delivered"
                                  ? "text-green-700 bg-green-50"
                                  : contact.status === "failed"
                                  ? "text-red-700 bg-red-50"
                                  : contact.status === "read"
                                  ? "text-purple-700 bg-purple-50"
                                  : ""
                              }
                            >
                              {contact.status}
                            </Badge>
                          </td>
                          <td className="py-2 px-3 text-xs text-muted-foreground">
                            {contact.sentAt ? new Date(contact.sentAt).toLocaleString("pt-BR") : "-"}
                          </td>
                          <td className="py-2 px-3 text-xs text-muted-foreground">
                            {contact.deliveredAt ? new Date(contact.deliveredAt).toLocaleString("pt-BR") : "-"}
                          </td>
                          <td className="py-2 px-3 text-xs text-muted-foreground">
                            {contact.readAt ? new Date(contact.readAt).toLocaleString("pt-BR") : "-"}
                          </td>
                          <td className="py-2 px-3 text-xs text-red-500">
                            {contact.errorMessage || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {contacts.length > 100 && (
                    <p className="text-xs text-muted-foreground text-center mt-2">
                      Mostrando 100 de {contacts.length} contatos
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs" className="mt-4">
          <Card>
            <CardContent className="pt-4">
              <div className="space-y-1 max-h-[500px] overflow-y-auto font-mono text-xs">
                {(!logsData?.liveLogs || logsData.liveLogs.length === 0) && (!logsData?.errorLogs || logsData.errorLogs.length === 0) ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="w-8 h-8 mx-auto mb-2" />
                    <p className="font-sans text-sm">Nenhum log disponível</p>
                  </div>
                ) : (
                  <>
                    {logsData?.liveLogs?.map((log: any, idx: number) => (
                      <div
                        key={idx}
                        className={`py-1 px-2 rounded ${
                          log.type === "ERROR"
                            ? "bg-red-50 text-red-700"
                            : log.type === "WARN"
                            ? "bg-yellow-50 text-yellow-700"
                            : log.type === "SEND"
                            ? "bg-green-50 text-green-700"
                            : "text-muted-foreground"
                        }`}
                      >
                        <span className="text-muted-foreground">
                          {new Date(log.timestamp).toLocaleTimeString("pt-BR")}
                        </span>{" "}
                        <span className="font-semibold">[{log.type}]</span>{" "}
                        {log.type === "ERROR" ? humanizeMetaError("", log.message) : log.message}
                      </div>
                    ))}
                    {logsData?.errorLogs?.length > 0 && (
                      <>
                        <div className="border-t my-2 pt-2">
                          <p className="font-sans text-sm font-semibold text-red-600 mb-1">Erros Persistidos</p>
                        </div>
                        {logsData.errorLogs.map((err: any) => (
                          <div key={err.id} className="py-1 px-2 bg-red-50 text-red-700 rounded">
                            <span className="font-semibold">[{err.errorCode}]</span>{" "}
                            {humanizeMetaError(err.errorCode || "", err.errorMessage || "")}{" "}
                            <span className="text-muted-foreground">
                              (x{err.count})
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="app" className="mt-4">
          <AppWebhookTab campaignId={campaignId!} />
        </TabsContent>
      </Tabs>

      <HotUpdateDialog
        open={showHotUpdate}
        onOpenChange={setShowHotUpdate}
        campaign={campaign}
        hotUpdating={hotUpdating}
        onApply={(updates) => {
          setHotUpdating(true);
          hotUpdateMutation.mutate(updates);
        }}
        onGoToBotTab={() => setActiveTab("bot")}
      />
    </div>
  );
}
