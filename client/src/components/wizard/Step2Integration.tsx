import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Shield, Globe, Info, Eye, EyeOff, Save,
  Copy, CheckCircle, AlertCircle, Play, Loader2, ChevronDown, ChevronUp, ExternalLink,
  Search, Building2, Hash, Phone, Pencil, X, Plus, Database,
} from "lucide-react";

interface AddedWabaEntry {
  wabaId: string;
  registeredId: string;
  name: string;
  phoneCount: number;
}

export interface SavedAppConfig {
  bmId: string | null;
  appSecret: string | null;
  wabaCount: number;
  label: string;
  wabaIds: string[];
  hasToken: boolean;
  tokenPreview: string;
  _accessToken: string;
}

interface Step2IntegrationProps {
  bmId: string;
  setBmId: (v: string) => void;
  accessToken: string;
  setAccessToken: (v: string) => void;
  discoverLoading: boolean;
  discoverError: string;
  discoveredCount: number | null;
  onDiscoverWabas: () => void;
  manualWabaLoading: boolean;
  manualWabaError: string;
  onManualWabaAdd: (wabaId: string) => Promise<{ registeredId?: string; phoneCount?: number } | void>;
  serverStatus: { webhookUrl: string; webhookWarning?: string | null } | undefined;
  webhookCopied: boolean;
  webhookTesting: boolean;
  webhookTestResult: { success: boolean; message?: string; error?: string } | null;
  handleTestWebhook: () => void;
  copyToClipboard: (text: string) => void;
  webhookInstructionsOpen: boolean;
  setWebhookInstructionsOpen: (v: boolean) => void;
  appSecret: string;
  setAppSecret: (v: string) => void;
  verifyToken: string;
  verifyTokenLoading: boolean;
  onRegenerateVerifyToken: () => void;
  onSaveSecrets?: () => Promise<void>;
  validationErrors: string[];
  savedAppConfigs?: SavedAppConfig[];
  selectedAppConfigIndex?: number | null;
  onSelectAppConfig?: (config: SavedAppConfig, index: number) => void;
  onAddNewConfig?: () => void;
}

export default function Step2Integration(props: Step2IntegrationProps) {
  const {
    bmId, setBmId, accessToken, setAccessToken,
    discoverLoading, discoverError, discoveredCount, onDiscoverWabas,
    manualWabaLoading, manualWabaError, onManualWabaAdd,
    serverStatus, webhookCopied, webhookTesting, webhookTestResult,
    handleTestWebhook, copyToClipboard,
    webhookInstructionsOpen, setWebhookInstructionsOpen,
    appSecret, setAppSecret, verifyToken,
    verifyTokenLoading, onRegenerateVerifyToken, onSaveSecrets,
    savedAppConfigs = [], selectedAppConfigIndex = null,
    onSelectAppConfig, onAddNewConfig,
  } = props;

  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showVerifyToken, setShowVerifyToken] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [inputMode, setInputMode] = useState<"bm" | "waba">("bm");
  const [manualWabaId, setManualWabaId] = useState("");
  const [addedWabas, setAddedWabas] = useState<AddedWabaEntry[]>([]);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);

  const credentialsOk = !!accessToken && (!!bmId || (discoveredCount !== null && discoveredCount > 0) || addedWabas.length > 0);
  const webhookOk = !!serverStatus?.webhookUrl && !serverStatus?.webhookWarning;
  const secretsOk = !!appSecret || !!verifyToken;

  const handleSaveSecrets = async () => {
    setSaveStatus("saving");
    try {
      if (onSaveSecrets) {
        await onSaveSecrets();
      } else {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appSecret: appSecret || undefined }),
        });
        if (!res.ok) throw new Error("Falha ao salvar");
      }
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const handleManualWabaAdd = async () => {
    const wabaIdTrimmed = manualWabaId.trim();
    if (!wabaIdTrimmed) return;
    const result = await onManualWabaAdd(wabaIdTrimmed);
    if (result && result.registeredId) {
      const alreadyInList = addedWabas.some((w) => w.wabaId === wabaIdTrimmed);
      if (!alreadyInList) {
        setAddedWabas((prev) => [
          ...prev,
          {
            wabaId: wabaIdTrimmed,
            registeredId: result.registeredId!,
            name: `WABA ${wabaIdTrimmed}`,
            phoneCount: result.phoneCount || 0,
          },
        ]);
      }
      setManualWabaId("");
    }
  };

  const startEditName = (entry: AddedWabaEntry) => {
    setEditingNameId(entry.wabaId);
    setEditingNameValue(entry.name);
  };

  const saveEditName = async (entry: AddedWabaEntry) => {
    const newName = editingNameValue.trim() || entry.name;
    setNameSaving(true);
    try {
      const res = await fetch(`/api/wabas/${entry.registeredId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) {
        setAddedWabas((prev) =>
          prev.map((w) => (w.wabaId === entry.wabaId ? { ...w, name: newName } : w))
        );
      } else {
        const data = await res.json().catch(() => ({}));
        console.error("[Step2Integration] Failed to update WABA name:", data.error || res.status);
      }
    } catch (err) {
      console.error("[Step2Integration] Network error updating WABA name:", err);
    }
    setEditingNameId(null);
    setNameSaving(false);
  };

  const removeAddedWaba = (wabaId: string) => {
    setAddedWabas((prev) => prev.filter((w) => w.wabaId !== wabaId));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Shield className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Integrações e Segurança</h2>
          <p className="text-sm text-muted-foreground">Configure as credenciais Meta e o webhook para receber eventos do WhatsApp</p>
        </div>
      </div>

      {savedAppConfigs.length > 0 && (
        <div className="border rounded-xl p-4 space-y-3 bg-slate-50/50 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-indigo-100 flex items-center justify-center">
                <Database className="w-3.5 h-3.5 text-indigo-600" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-gray-800">Configurações Salvas</h3>
                <p className="text-[11px] text-muted-foreground">Selecione uma configuração existente ou adicione nova</p>
              </div>
            </div>
            {onAddNewConfig && (
              <button
                type="button"
                onClick={onAddNewConfig}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                  selectedAppConfigIndex === null
                    ? "bg-[#0066FF] border-[#0066FF] text-white"
                    : "bg-white border-gray-200 text-gray-600 hover:border-[#0066FF] hover:text-[#0066FF]"
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                Nova configuração
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {savedAppConfigs.map((config, idx) => {
              const isSelected = selectedAppConfigIndex === idx;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onSelectAppConfig && onSelectAppConfig(config, idx)}
                  className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
                    isSelected
                      ? "bg-[#0066FF]/5 border-[#0066FF] ring-1 ring-[#0066FF]/20"
                      : "bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm"
                  }`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${
                    isSelected ? "bg-[#0066FF]/10" : "bg-gray-100"
                  }`}>
                    <Building2 className={`w-4 h-4 ${isSelected ? "text-[#0066FF]" : "text-gray-500"}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className={`text-xs font-semibold truncate ${isSelected ? "text-[#0066FF]" : "text-gray-800"}`}>
                        {config.label}
                      </p>
                      {isSelected && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] bg-[#0066FF] text-white px-1.5 py-0.5 rounded-full flex-shrink-0">
                          <CheckCircle className="w-2.5 h-2.5" />
                          Ativa
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {config.bmId && (
                        <span className="text-[10px] text-muted-foreground font-mono">BM: {config.bmId}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground">
                        {config.wabaCount} WABA{config.wabaCount !== 1 ? "s" : ""}
                      </span>
                      {config.appSecret && (
                        <span className="text-[10px] text-green-600 font-medium">App Secret ✓</span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 font-mono truncate">
                      Token: {config.tokenPreview}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {props.validationErrors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          {props.validationErrors.map((err, i) => (
            <p key={i} className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {err}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Credenciais Meta", ok: credentialsOk },
          { label: "Webhook configurado", ok: webhookOk },
          { label: "Secrets configurados", ok: secretsOk },
        ].map((item) => (
          <div key={item.label} className={`flex items-center gap-2 p-3 rounded-xl border text-xs font-medium transition-colors ${
            item.ok ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-gray-50 border-gray-200 text-gray-400"
          }`}>
            {item.ok ? (
              <CheckCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-gray-300 flex-shrink-0" />
            )}
            <span>{item.label}</span>
          </div>
        ))}
      </div>

      <div className="border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
            <Building2 className="w-4 h-4 text-[#0066FF]" />
          </div>
          <div>
            <h3 className="font-semibold text-base">Credenciais Meta</h3>
            <p className="text-xs text-muted-foreground">Configure o Access Token e escolha o modo de busca das suas WABAs</p>
          </div>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-blue-800 space-y-1.5">
              <p className="font-semibold">Permissões necessárias do Access Token:</p>
              <div className="space-y-1">
                <div className="flex items-start gap-1.5">
                  <span className="font-mono bg-blue-100 text-blue-700 px-1 rounded text-[10px] mt-0.5">whatsapp_business_management</span>
                  <span>— necessário para ambos os modos</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <span className="font-mono bg-blue-100 text-blue-700 px-1 rounded text-[10px] mt-0.5">business_management</span>
                  <span>— necessário apenas para o modo BM Discovery</span>
                </div>
              </div>
              <p>
                <a
                  href="https://developers.facebook.com/docs/whatsapp/business-management-api/get-started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium inline-flex items-center gap-1"
                >
                  Ver documentação da Meta <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-1">
              <Label className="text-xs font-medium">Access Token *</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                  <TooltipContent><p className="text-xs max-w-xs">Token permanente com permissões de WhatsApp. Gere em: developers.facebook.com → Seu App → WhatsApp → API Setup.</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-[11px] text-muted-foreground mb-1">Token permanente com permissão <span className="font-mono">whatsapp_business_management</span></p>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="EAAxxxxxxxxxxxxxxxxxxxxxxxx..."
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="border rounded-lg p-4 space-y-3 bg-slate-50/50">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-gray-700">Como deseja localizar suas WABAs?</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setInputMode("bm")}
                className={`flex items-center gap-2 p-3 rounded-lg border text-left transition-colors ${
                  inputMode === "bm"
                    ? "bg-[#0066FF]/10 border-[#0066FF] text-[#0066FF]"
                    : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                <Search className="w-4 h-4 flex-shrink-0" />
                <div>
                  <p className="text-xs font-semibold">BM Discovery</p>
                  <p className="text-[10px] opacity-75">Usa o BM ID para listar todas as WABAs automaticamente</p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setInputMode("waba")}
                className={`flex items-center gap-2 p-3 rounded-lg border text-left transition-colors ${
                  inputMode === "waba"
                    ? "bg-[#0066FF]/10 border-[#0066FF] text-[#0066FF]"
                    : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                <Hash className="w-4 h-4 flex-shrink-0" />
                <div>
                  <p className="text-xs font-semibold">Tenho o WABA ID</p>
                  <p className="text-[10px] opacity-75">Informa o WABA ID diretamente (sem precisar de business_management)</p>
                </div>
              </button>
            </div>

            {inputMode === "bm" && (
              <div className="space-y-3 pt-1">
                <div>
                  <div className="flex items-center gap-1">
                    <Label className="text-xs font-medium">Business Manager ID *</Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                        <TooltipContent><p className="text-xs max-w-xs">ID numérico do seu Business Manager. Encontre em: Meta Business Suite → Configurações → Informações da empresa.</p></TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-[11px] text-muted-foreground mb-1">Encontre em: Meta Business Suite → Configurações → Informações da empresa</p>
                  <Input
                    value={bmId}
                    onChange={(e) => setBmId(e.target.value)}
                    placeholder="Ex: 987654321098765"
                  />
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                  <p className="text-[11px] text-amber-800">
                    <strong>Requer:</strong> <span className="font-mono">business_management</span> + <span className="font-mono">whatsapp_business_management</span>. Se receber erro 403, use o modo "Tenho o WABA ID".
                  </p>
                </div>
                <Button
                  onClick={onDiscoverWabas}
                  disabled={!bmId || !accessToken || discoverLoading}
                  className="w-full bg-[#0066FF] hover:bg-[#0052CC] text-white"
                  size="sm"
                >
                  {discoverLoading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Buscando WABAs...</>
                  ) : (
                    <><Search className="w-4 h-4 mr-2" /> Buscar WABAs</>
                  )}
                </Button>
                {discoveredCount !== null && !discoverLoading && !discoverError && (
                  <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <CheckCircle className="w-4 h-4 text-slate-500 flex-shrink-0" />
                    <p className="text-xs text-slate-600 font-medium">
                      {discoveredCount} WABA(s) encontrada(s). Selecione na próxima etapa.
                    </p>
                  </div>
                )}
                {discoverError && (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-xs text-red-700 font-medium">Erro ao buscar WABAs:</p>
                      <p className="text-xs text-red-700">{discoverError}</p>
                      {(discoverError.includes("403") || discoverError.toLowerCase().includes("business_management") || discoverError.toLowerCase().includes("permission")) && (
                        <p className="text-xs text-red-600 mt-1">
                          Seu token não tem a permissão <span className="font-mono font-semibold">business_management</span>. Tente usar o modo "Tenho o WABA ID" acima.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {inputMode === "waba" && (
              <div className="space-y-3 pt-1">
                <div>
                  <div className="flex items-center gap-1">
                    <Label className="text-xs font-medium">WABA ID *</Label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                        <TooltipContent><p className="text-xs max-w-xs">ID da WhatsApp Business Account. Encontre em: Meta Business Suite → WhatsApp → Visão Geral da Conta.</p></TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <p className="text-[11px] text-muted-foreground mb-1">Encontre em: Meta Business Suite → WhatsApp → Visão Geral da Conta</p>
                  <Input
                    value={manualWabaId}
                    onChange={(e) => setManualWabaId(e.target.value)}
                    placeholder="Ex: 123456789012345"
                  />
                </div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-2.5">
                  <p className="text-[11px] text-green-800">
                    <strong>Requer apenas:</strong> <span className="font-mono">whatsapp_business_management</span>. Ideal para tokens sem <span className="font-mono">business_management</span>.
                  </p>
                </div>
                <Button
                  onClick={handleManualWabaAdd}
                  disabled={!manualWabaId.trim() || !accessToken || manualWabaLoading}
                  className="w-full bg-[#0066FF] hover:bg-[#0052CC] text-white"
                  size="sm"
                >
                  {manualWabaLoading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Validando WABA...</>
                  ) : (
                    <><Hash className="w-4 h-4 mr-2" /> Validar e adicionar WABA</>
                  )}
                </Button>
                {manualWabaError && (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-xs text-red-700 font-medium">Erro ao validar WABA:</p>
                      <p className="text-xs text-red-700 whitespace-pre-line">{manualWabaError}</p>
                    </div>
                  </div>
                )}

                {addedWabas.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs font-semibold text-gray-700">WABAs adicionadas nesta sessão:</p>
                    {addedWabas.map((entry) => (
                      <div key={entry.wabaId} className="border border-slate-200 rounded-lg p-3 bg-white space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] text-muted-foreground font-mono truncate">ID: {entry.wabaId}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <Phone className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              <span className="text-[10px] text-muted-foreground">{entry.phoneCount} número(s) encontrado(s)</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeAddedWaba(entry.wabaId)}
                            className="text-muted-foreground hover:text-red-500 transition-colors flex-shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div>
                          <Label className="text-[10px] font-medium text-gray-600">Nome personalizado</Label>
                          {editingNameId === entry.wabaId ? (
                            <div className="flex items-center gap-1 mt-1">
                              <Input
                                value={editingNameValue}
                                onChange={(e) => setEditingNameValue(e.target.value)}
                                placeholder="Ex: BM Principal - Vendas"
                                className="h-7 text-xs"
                                onKeyDown={(e) => { if (e.key === "Enter") saveEditName(entry); if (e.key === "Escape") setEditingNameId(null); }}
                                autoFocus
                              />
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => saveEditName(entry)}
                                disabled={nameSaving}
                              >
                                {nameSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={() => setEditingNameId(null)}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEditName(entry)}
                              className="flex items-center gap-1.5 mt-1 text-xs text-gray-700 hover:text-[#0066FF] transition-colors group"
                            >
                              <span className="font-medium">{entry.name}</span>
                              <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
            <Globe className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <h3 className="font-semibold text-base">Webhook e Secrets</h3>
            <p className="text-xs text-muted-foreground">Configure o webhook e os tokens de segurança para receber eventos</p>
          </div>
        </div>

        <div>
          <Label className="text-xs font-medium">URL do Webhook</Label>
          <p className="text-[11px] text-muted-foreground mb-1">Copie esta URL e cole no campo "Callback URL" do seu App Meta</p>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 bg-muted/50 border rounded-lg px-3 py-2.5 font-mono text-xs overflow-x-auto select-all">
              {serverStatus?.webhookUrl || "Carregando..."}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => serverStatus?.webhookUrl && copyToClipboard(serverStatus.webhookUrl)}
              disabled={!serverStatus?.webhookUrl}
              className="shrink-0"
            >
              {webhookCopied ? <CheckCircle className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          {serverStatus?.webhookWarning && (
            <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-lg p-2 mt-2">
              <AlertCircle className="w-3 h-3 text-slate-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-slate-500">{serverStatus.webhookWarning}</p>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center gap-1 mb-1">
              <Label className="text-xs font-medium">Verify Token</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                  <TooltipContent><p className="text-xs max-w-xs">Token usado pela Meta para verificar a conexão do webhook. Use o mesmo valor no campo "Verify Token" do seu App Meta.</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-[11px] text-muted-foreground mb-2">Token gerado automaticamente e salvo no banco de dados</p>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <div className={`bg-muted/50 border rounded-md px-3 py-2 font-mono text-sm text-foreground overflow-x-auto select-all pr-10 ${!showVerifyToken && verifyToken ? "tracking-widest text-muted-foreground" : ""}`}>
                  {verifyTokenLoading
                    ? "Gerando..."
                    : !verifyToken
                    ? "—"
                    : showVerifyToken
                    ? verifyToken
                    : "•".repeat(Math.min(verifyToken.length, 24))}
                </div>
                {verifyToken && !verifyTokenLoading && (
                  <button
                    type="button"
                    onClick={() => setShowVerifyToken(!showVerifyToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showVerifyToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0 h-9 w-9"
                disabled={!verifyToken}
                onClick={() => verifyToken && copyToClipboard(verifyToken)}
              >
                <Copy className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 text-xs"
                disabled={verifyTokenLoading}
                onClick={() => {
                  if (verifyToken) {
                    if (window.confirm("Gerar um novo token invalidará o token atual configurado na Meta. Deseja continuar?")) {
                      onRegenerateVerifyToken();
                    }
                  } else {
                    onRegenerateVerifyToken();
                  }
                }}
              >
                {verifyTokenLoading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                Gerar novo token
              </Button>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1 mb-1">
              <Label className="text-xs font-medium">App Secret</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                  <TooltipContent><p className="text-xs max-w-xs">Necessário para validar assinaturas de webhooks. Encontre em: developers.facebook.com → Seu App → Settings → Basic.</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-[11px] text-muted-foreground mb-2">Para validar assinaturas de webhook (temporário nesta sessão)</p>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-800">
                  <strong>Importante:</strong> O App Secret deve ser o da <strong>aplicação Meta (App)</strong> correspondente ao WABA selecionado — não é o mesmo para todos os WABAs. Cada WABA está vinculado a um App Meta específico. Encontre em: <span className="font-mono">developers.facebook.com → Seu App → Configurações → Básico → Chave Secreta do App</span>.
                </p>
              </div>
            </div>
            <div className="relative">
              <Input
                type={showSecret ? "text" : "password"}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder="Cole o App Secret aqui"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button
            type="button"
            size="sm"
            onClick={handleSaveSecrets}
            disabled={saveStatus === "saving"}
            className="shrink-0"
          >
            {saveStatus === "saving" ? (
              <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Salvando...</>
            ) : saveStatus === "success" ? (
              <><CheckCircle className="w-4 h-4 mr-1" /> Salvo</>
            ) : saveStatus === "error" ? (
              <><AlertCircle className="w-4 h-4 mr-1" /> Erro ao salvar</>
            ) : (
              <><Save className="w-4 h-4 mr-1" /> Salvar</>
            )}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleTestWebhook} disabled={webhookTesting} size="sm" variant="outline">
            {webhookTesting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
            {webhookTesting ? "Testando..." : "Testar Webhook"}
          </Button>
          {webhookTestResult && (
            <Badge variant={webhookTestResult.success ? "default" : "destructive"} className="text-xs">
              {webhookTestResult.success ? (
                <><CheckCircle className="w-3 h-3 mr-1" /> Webhook funcionando</>
              ) : (
                <><AlertCircle className="w-3 h-3 mr-1" /> {webhookTestResult.error || "Falha no teste"}</>
              )}
            </Badge>
          )}
        </div>

        <div className="border-t pt-3">
          <button
            onClick={() => setWebhookInstructionsOpen(!webhookInstructionsOpen)}
            className="flex items-center gap-2 text-sm font-medium text-[#0066FF] hover:text-[#0052CC] transition-colors w-full"
          >
            {webhookInstructionsOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <Info className="w-4 h-4" />
            Como configurar o Webhook no Meta
            <ExternalLink className="w-3 h-3 ml-auto" />
          </button>
          {webhookInstructionsOpen && (
            <div className="mt-3 bg-blue-50/50 border border-blue-100 rounded-lg p-4 space-y-2">
              {[
                "Acesse developers.facebook.com e abra seu App",
                "Vá em WhatsApp > Configuração > Webhook",
                "Cole a URL acima no campo 'URL de retorno de chamada'",
                "No campo 'Token de verificação', use o mesmo Verify Token informado acima",
                "Clique em 'Verificar e salvar'",
                "Inscreva-se nos campos: messages, message_deliveries, message_reads",
              ].map((text, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="w-5 h-5 rounded-full bg-[#0066FF]/10 text-[#0066FF] text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                  <p className="text-xs text-muted-foreground">{text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
