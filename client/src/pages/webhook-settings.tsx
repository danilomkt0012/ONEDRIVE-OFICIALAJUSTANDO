import { useState, useEffect, useCallback, Component, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getQueryFn, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ProxyPoolStatus } from "@/components/ProxyPoolStatus";
import {
  Globe, Copy, CheckCircle, AlertCircle, Server, Shield,
  Clock, Activity, Wifi, WifiOff, ExternalLink, Play, Info, User, Key, RefreshCw, Save
} from "lucide-react";

class WebhookErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null; retryKey: number }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, retryKey: 0 };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#F5F7FA]">
          <div className="saas-card p-8 max-w-md text-center space-y-4">
            <AlertCircle size={40} className="text-red-500 mx-auto" />
            <h2 className="text-lg font-semibold text-[#1A202C]">Erro ao carregar a página</h2>
            <p className="text-sm text-[#718096]">
              {this.state.error?.message || "Ocorreu um erro inesperado."}
            </p>
            <button
              onClick={() => this.setState((s) => ({ hasError: false, error: null, retryKey: s.retryKey + 1 }))}
              className="px-4 py-2 bg-[#0066FF] text-white rounded-lg text-sm hover:bg-[#0052CC]"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      );
    }
    return <div key={this.state.retryKey}>{this.props.children}</div>;
  }
}

interface ServerStatus {
  environment: string;
  status: string;
  uptime: string;
  uptimeMs: number;
  startedAt: string;
  lastWebhookEvent: string | null;
  webhookUrl: string;
  webhookWarning: string | null;
  domain: string | null;
  envVars: {
    DATABASE_URL: boolean;
    WEBHOOK_VERIFY_TOKEN: boolean;
    STATS_API_KEY: boolean;
    WASENDER_API_KEY: boolean;
    TWO_CHAT_API_KEY: boolean;
    SESSION_SECRET: boolean;
    NODE_ENV: string;
  };
}

interface UserConfig {
  id?: string;
  userId?: string;
  webhookVerifyToken?: string | null;
  appSecret?: string | null;
}

interface WebhookTestResult {
  success: boolean;
  message?: string;
  error?: string;
  statusCode?: number;
  challengeSent?: string;
  challengeReceived?: string;
}

export default function WebhookSettings() {
  const [copied, setCopied] = useState(false);
  const [copiedPersonal, setCopiedPersonal] = useState(false);
  const [copiedVerifyToken, setCopiedVerifyToken] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);
  const [customToken, setCustomToken] = useState("");
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [tokenEditing, setTokenEditing] = useState(false);
  const { toast } = useToast();
  const { user, isAdmin } = useAuth();

  const { data: status, isLoading, isError } = useQuery<ServerStatus>({
    queryKey: ["/api/server-status"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 15000,
    staleTime: 5000,
  });

  const queryClient = useQueryClient();
  const [verifyTokenLoading, setVerifyTokenLoading] = useState(false);
  const [autoGenAttempted, setAutoGenAttempted] = useState(false);

  const { data: userConfig } = useQuery<UserConfig>({
    queryKey: ["/api/config"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 10000,
  });

  useEffect(() => {
    if (userConfig?.webhookVerifyToken) {
      setCustomToken(userConfig.webhookVerifyToken);
    }
  }, [userConfig?.webhookVerifyToken]);

  const generateVerifyToken = useCallback(async () => {
    setVerifyTokenLoading(true);
    try {
      const res = await fetch("/api/config/generate-verify-token", { method: "POST", headers: { "Content-Type": "application/json" } });
      if (res.ok) {
        const data = await res.json();
        setCustomToken(data.webhookVerifyToken || "");
        setTokenEditing(false);
        queryClient.invalidateQueries({ queryKey: ["/api/config"] });
        toast({ title: "Token gerado", description: "Novo verify token gerado com sucesso." });
      }
    } catch {}
    setVerifyTokenLoading(false);
  }, [queryClient, toast]);

  useEffect(() => {
    if (userConfig && !userConfig.webhookVerifyToken && !verifyTokenLoading && !autoGenAttempted) {
      setAutoGenAttempted(true);
      generateVerifyToken();
    }
  }, [userConfig, verifyTokenLoading, generateVerifyToken, autoGenAttempted]);

  const saveCustomToken = async () => {
    if (!customToken.trim() || customToken.trim().length < 8) {
      toast({ title: "Token inválido", description: "O token precisa ter no mínimo 8 caracteres.", variant: "destructive" });
      return;
    }
    setIsSavingToken(true);
    try {
      const res = await fetch("/api/config/set-verify-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken.trim() }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["/api/config"] });
        setTokenEditing(false);
        toast({ title: "Token salvo", description: "Verify token atualizado com sucesso. Configure o mesmo valor na Meta." });
      } else {
        const err = await res.json();
        toast({ title: "Erro", description: err.error || "Não foi possível salvar o token.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Erro", description: "Falha ao salvar o token.", variant: "destructive" });
    }
    setIsSavingToken(false);
  };

  const copyText = async (text: string, setter: (v: boolean) => void, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      toast({ title: `${label} copiado`, description: `${label} copiado para a área de transferência` });
      setTimeout(() => setter(false), 2000);
    } catch {
      toast({ title: "Erro", description: "Não foi possível copiar", variant: "destructive" });
    }
  };

  const testWebhook = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const response = await apiRequest("POST", "/api/webhook/test");
      const data: WebhookTestResult = await response.json();
      setTestResult(data);
      if (data.success) {
        toast({ title: "Webhook OK", description: data.message });
      } else {
        toast({ title: "Falha no teste", description: data.error, variant: "destructive" });
      }
    } catch (error: any) {
      setTestResult({ success: false, error: error.message });
      toast({ title: "Erro", description: "Falha ao testar webhook", variant: "destructive" });
    } finally {
      setIsTesting(false);
    }
  };

  const isProduction = status?.environment === "production";
  const personalUrl = user && status?.domain ? `${status.domain}/api/webhook/meta/${user.id}` : null;
  const currentToken = userConfig?.webhookVerifyToken || null;

  return (
    <WebhookErrorBoundary>
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-4 sm:space-y-6">

        <div className="flex items-center gap-4 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[#F7FAFC] border border-[#E2E8F0] flex items-center justify-center">
            <Globe size={20} className="text-[#0066FF]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[#1A202C]">Webhook & Deploy</h1>
            <p className="text-sm text-[#A0AEC0]">Status do servidor e configuração do webhook Meta</p>
          </div>
        </div>

        {/* Status do Servidor */}
        <div className={`saas-card p-6 border-l-4 ${isProduction ? "border-l-[#38A169]" : "border-l-yellow-400"}`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isProduction ? "bg-green-50" : "bg-yellow-50"}`}>
                <Server size={20} className={isProduction ? "text-[#38A169]" : "text-yellow-500"} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-[#1A202C]">Status do Servidor</h2>
                <p className="text-xs text-[#A0AEC0]">
                  {isLoading ? "Carregando..." : isError ? "Indisponível" : `Ambiente: ${status?.envVars.NODE_ENV || "desconhecido"}`}
                </p>
              </div>
            </div>
            {status && (
              <div className={`px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 ${
                isProduction
                  ? "bg-slate-50 text-[#38A169] border border-slate-200"
                  : "bg-slate-50 text-slate-500 border border-slate-200"
              }`}>
                <div className={`w-2 h-2 rounded-full ${isProduction ? "bg-[#38A169]" : "bg-slate-400"}`} />
                {isProduction ? "Produção — Online" : "Desenvolvimento"}
              </div>
            )}
          </div>

          {status && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
              <div className="bg-[#F7FAFC] rounded-lg p-3">
                <div className="flex items-center gap-2 text-[#718096] text-xs mb-1">
                  <Clock size={12} />
                  <span>Uptime</span>
                </div>
                <p className="text-sm font-semibold text-[#1A202C]">{status.uptime}</p>
              </div>
              <div className="bg-[#F7FAFC] rounded-lg p-3">
                <div className="flex items-center gap-2 text-[#718096] text-xs mb-1">
                  <Activity size={12} />
                  <span>Iniciado em</span>
                </div>
                <p className="text-sm font-semibold text-[#1A202C]">
                  {new Date(status.startedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
              <div className="bg-[#F7FAFC] rounded-lg p-3">
                <div className="flex items-center gap-2 text-[#718096] text-xs mb-1">
                  <Wifi size={12} />
                  <span>Último Webhook</span>
                </div>
                <p className="text-sm font-semibold text-[#1A202C]">
                  {status.lastWebhookEvent
                    ? new Date(status.lastWebhookEvent).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
                    : "Nenhum evento"}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Webhook Personalizado por Usuário — PRINCIPAL */}
        {user && status?.domain && (
          <div className="saas-card p-6 border-l-4 border-l-[#0066FF]">
            <div className="flex items-center gap-2 mb-1">
              <User size={16} className="text-[#0066FF]" />
              <h2 className="text-base font-semibold text-[#1A202C]">Seu Webhook — Configure este na Meta</h2>
            </div>
            <p className="text-xs text-[#718096] mb-5">
              Cada usuário tem sua própria URL e token. Use os valores abaixo na configuração do webhook do seu App Meta.
              Você pode ter tokens diferentes para Apps de BMs diferentes.
            </p>

            <div className="space-y-5">
              {/* URL Personalizada */}
              <div>
                <label className="text-xs text-[#718096] font-medium mb-1.5 block">URL de Callback (cole no campo "URL de retorno de chamada" na Meta)</label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-[#F7FAFC] border border-[#E2E8F0] rounded-lg px-4 py-3 font-mono text-sm text-[#1A202C] overflow-x-auto">
                    {personalUrl}
                  </div>
                  <Button
                    onClick={() => copyText(personalUrl!, setCopiedPersonal, "URL")}
                    variant="outline"
                    className="h-11 px-4 border-[#E2E8F0] hover:bg-[#F7FAFC] flex-shrink-0"
                  >
                    {copiedPersonal ? <CheckCircle size={16} className="text-[#38A169]" /> : <Copy size={16} className="text-[#718096]" />}
                  </Button>
                </div>
              </div>

              {/* Verify Token — Editável */}
              <div>
                <label className="text-xs text-[#718096] font-medium mb-1.5 block">
                  Verify Token (cole no campo "Token de verificação" na Meta)
                </label>

                {tokenEditing ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={customToken}
                        onChange={e => setCustomToken(e.target.value)}
                        placeholder="Cole aqui o token que você já configurou na Meta, ou deixe o gerado"
                        className="flex-1 font-mono text-sm h-11 border-[#0066FF] focus-visible:ring-[#0066FF]"
                        autoFocus
                      />
                      <Button
                        onClick={saveCustomToken}
                        disabled={isSavingToken || !customToken.trim()}
                        className="h-11 px-4 bg-[#0066FF] hover:bg-[#0052CC] text-white flex-shrink-0"
                      >
                        <Save size={15} className="mr-1.5" />
                        {isSavingToken ? "Salvando..." : "Salvar"}
                      </Button>
                      <Button
                        onClick={() => { setCustomToken(currentToken || ""); setTokenEditing(false); }}
                        variant="outline"
                        className="h-11 px-4 border-[#E2E8F0] flex-shrink-0 text-xs"
                      >
                        Cancelar
                      </Button>
                    </div>
                    <p className="text-xs text-[#718096]">
                      Cole o token que você já digitou na Meta — ou mantenha o gerado automaticamente. Mínimo 8 caracteres.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-[#F7FAFC] border border-[#E2E8F0] rounded-lg px-4 py-3 font-mono text-sm text-[#1A202C] overflow-x-auto">
                      {verifyTokenLoading ? "Gerando..." : (currentToken || "—")}
                    </div>
                    <Button
                      onClick={() => copyText(currentToken || "", setCopiedVerifyToken, "Token")}
                      variant="outline"
                      className="h-11 px-4 border-[#E2E8F0] hover:bg-[#F7FAFC] flex-shrink-0"
                      disabled={!currentToken}
                    >
                      {copiedVerifyToken ? <CheckCircle size={16} className="text-[#38A169]" /> : <Copy size={16} className="text-[#718096]" />}
                    </Button>
                    <Button
                      onClick={() => setTokenEditing(true)}
                      variant="outline"
                      className="h-11 px-4 border-[#E2E8F0] hover:bg-[#F7FAFC] flex-shrink-0 text-xs gap-1.5"
                      title="Definir um token personalizado (ex: o mesmo que você já colocou na Meta)"
                    >
                      <Key size={14} />
                      Definir token
                    </Button>
                    <Button
                      onClick={() => {
                        if (currentToken) {
                          if (window.confirm("Gerar um novo token vai invalidar o atual configurado na Meta. Você precisará atualizar o token na Meta depois. Continuar?")) {
                            generateVerifyToken();
                          }
                        } else {
                          generateVerifyToken();
                        }
                      }}
                      variant="outline"
                      className="h-11 px-4 border-[#E2E8F0] hover:bg-[#F7FAFC] flex-shrink-0 text-xs gap-1.5"
                      disabled={verifyTokenLoading}
                    >
                      <RefreshCw size={14} className={verifyTokenLoading ? "animate-spin" : ""} />
                      Gerar novo
                    </Button>
                  </div>
                )}
              </div>

              {/* Testar */}
              <div className="pt-1">
                <Button
                  onClick={testWebhook}
                  disabled={isTesting}
                  className="bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold"
                >
                  <Play size={16} className="mr-2" />
                  {isTesting ? "Testando..." : "Testar Webhook"}
                </Button>
              </div>

              {testResult && (
                <div className={`rounded-lg p-4 border ${testResult.success ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    {testResult.success ? (
                      <CheckCircle size={16} className="text-[#38A169]" />
                    ) : (
                      <AlertCircle size={16} className="text-red-500" />
                    )}
                    <span className={`text-sm font-semibold ${testResult.success ? "text-[#38A169]" : "text-red-600"}`}>
                      {testResult.success ? "Webhook funcionando corretamente" : "Falha no teste"}
                    </span>
                  </div>
                  <p className="text-xs text-[#718096] mt-1">
                    {testResult.success ? testResult.message : testResult.error}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Instruções */}
        <div className="saas-card p-5 border-l-2 border-l-[#0066FF]">
          <div className="flex gap-4">
            <div className="w-9 h-9 rounded-lg bg-[#EBF4FF]/50 flex items-center justify-center flex-shrink-0">
              <Info className="h-4 w-4 text-[#0066FF]" />
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-[#1A202C] text-sm mb-3">Como Configurar o Webhook no Meta</h4>
              <div className="space-y-2">
                {[
                  "Acesse developers.facebook.com e abra o App do seu BM",
                  "Vá em WhatsApp > Configuração > Webhook",
                  "No campo 'URL de retorno de chamada', cole a URL personalizada acima",
                  "No campo 'Token de verificação', cole o Verify Token acima — ou defina um token próprio clicando em 'Definir token'",
                  "Clique em 'Verificar e salvar' — se o token bater, a Meta vai confirmar",
                  "Inscreva-se nos campos: messages, message_deliveries, message_reads",
                  "Para usar um App diferente (outro BM), ajuste o token com 'Definir token' para corresponder ao que você colocou naquele App"
                ].map((text, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-[#EBF4FF] text-[#0066FF] text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                    <p className="text-xs text-[#718096]">{text}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* URL do Servidor */}
        {status?.webhookUrl && (
          <div className="saas-card p-6">
            <div className="flex items-center gap-2 mb-2">
              <Globe size={16} className="text-[#718096]" />
              <h2 className="text-base font-semibold text-[#1A202C]">URL do Servidor</h2>
            </div>
            <p className="text-xs text-[#A0AEC0] mb-4">
              URL detectada pelo servidor para este usuário. Use a URL personalizada acima para configurar o webhook na Meta.
            </p>
            {status.webhookWarning && (
              <div className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
                <AlertCircle size={16} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-700">{status.webhookWarning}</p>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-[#F7FAFC] border border-[#E2E8F0] rounded-lg px-4 py-3 font-mono text-sm text-[#1A202C] overflow-x-auto">
                {status.webhookUrl}
              </div>
              <Button
                onClick={() => copyText(status.webhookUrl, setCopied, "URL")}
                variant="outline"
                className="h-11 px-4 border-[#E2E8F0] hover:bg-[#F7FAFC] flex-shrink-0"
              >
                {copied ? <CheckCircle size={16} className="text-[#38A169]" /> : <Copy size={16} className="text-[#718096]" />}
              </Button>
            </div>
          </div>
        )}

        {/* Variáveis de Ambiente */}
        <div className="saas-card p-6">
          <div className="flex items-center gap-2 mb-5">
            <Shield size={16} className="text-[#0066FF]" />
            <h2 className="text-base font-semibold text-[#1A202C]">Variáveis de Ambiente</h2>
          </div>
          <div className="space-y-2">
            {status?.envVars && Object.entries(status.envVars).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between bg-[#F7FAFC] rounded-lg px-4 py-3">
                <span className="text-sm font-mono text-[#1A202C]">{key}</span>
                <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                  value === true || (typeof value === "string" && value !== "not set")
                    ? "bg-green-50 text-[#38A169]"
                    : "bg-red-50 text-red-500"
                }`}>
                  {value === true ? "Configurada" : value === false ? "Ausente" : value}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-[#A0AEC0] mt-3">
            Configure as variáveis de ambiente no painel Secrets da Replit antes de fazer o deploy.
          </p>
        </div>

        {isAdmin && (
          <div className="saas-card">
            <div className="flex items-center gap-2 px-6 py-4 border-b border-[#E2E8F0]">
              <Globe size={16} className="text-[#0066FF]" />
              <h2 className="text-base font-semibold text-[#1A202C]">Pool de Proxies</h2>
            </div>
            <div className="p-6">
              <p className="text-sm text-[#718096] mb-4">
                Cada sessão do extrator WhatsApp recebe um proxy dedicado do pool. As chamadas à Graph API da Meta são roteadas por proxies rotativos. Proxies cadastrados aqui são aplicados imediatamente, sem reiniciar o servidor. Se nenhum proxy estiver cadastrado, o sistema usa a variável <code className="bg-[#EDF2F7] px-1 rounded text-[#2D3748] text-xs">PROXY_POOL</code> como fallback.
              </p>
              <ProxyPoolStatus />
            </div>
          </div>
        )}

      </div>
    </div>
    </WebhookErrorBoundary>
  );
}
