import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Eye, EyeOff, Search, RefreshCw, MessageSquare, 
  Phone, User, CheckCircle, Clock, AlertCircle, Info,
  Key, Building, Users, Shield, Activity, Building2, Pencil, Save, X, Loader2, Megaphone,
  Wifi, WifiOff
} from "lucide-react";

interface PhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  code_verification_status: string;
  quality_rating: string;
  platform: string;
}

interface Waba {
  id: string;
  wabaId: string;
  name: string;
  bmId: string | null;
  isActive: boolean;
  subscribedAppsStatus: string | null;
  subscribedAppsAt: string | null;
  phoneNumbers?: { id: string; display_phone_number: string; verified_name: string }[];
}

interface Campaign {
  id: number;
  name: string;
  wabaId: string;
}

export default function Config() {
  const [showToken, setShowToken] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [registerProgress, setRegisterProgress] = useState(0);
  const [registerText, setRegisterText] = useState("");
  const [showPhones, setShowPhones] = useState(false);
  const [editingWabaId, setEditingWabaId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: wabasList = [] } = useQuery<Waba[]>({
    queryKey: ["/api/wabas"],
  });

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: ["/api/campaigns"],
  });

  const [resubscribingId, setResubscribingId] = useState<string | null>(null);

  const updateWabaName = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PATCH", `/api/wabas/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wabas"] });
      setEditingWabaId(null);
      toast({ title: "Nome atualizado", description: "O nome da WABA foi atualizado com sucesso." });
    },
    onError: () => {
      toast({ title: "Erro", description: "Falha ao atualizar o nome da WABA.", variant: "destructive" });
    },
  });

  const resubscribeWaba = async (wabaId: string) => {
    setResubscribingId(wabaId);
    try {
      const res = await fetch(`/api/wabas/${wabaId}/subscribe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (res.ok && data.success) {
        toast({ title: "Re-inscrição bem-sucedida", description: "WABA inscrita no app com sucesso." });
      } else {
        const errorMsg = data.error || "Erro desconhecido";
        toast({ title: "Falha na re-inscrição", description: errorMsg, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Erro de comunicação", description: err.message || "Falha na comunicação com o servidor", variant: "destructive" });
    } finally {
      setResubscribingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/wabas"] });
    }
  };

  const getWabaCampaigns = (wabaId: string) =>
    campaigns.filter((c: Campaign) => c.wabaId === wabaId);

  const buscarNumeros = async () => {
    if (!accessToken) {
      toast({ title: "Erro", description: "Por favor, insira o Token de Acesso", variant: "destructive" });
      return;
    }
    if (!businessAccountId) {
      toast({ title: "Erro", description: "Por favor, insira a Identificação da Conta WhatsApp Business", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    setPhoneNumbers([]);
    setShowPhones(false);

    try {
      const response = await apiRequest("POST", "/api/buscar-numeros", {
        business_account_id: businessAccountId,
        access_token: accessToken
      });
      const data = await response.json();

      if (data.success) {
        setPhoneNumbers(data.phones);
        setShowPhones(true);
        toast({ title: "Sucesso", description: `${data.phones.length} números encontrados` });
      } else {
        toast({ title: "Erro ao buscar números", description: data.error, variant: "destructive" });
      }
    } catch (error) {
      console.error("Erro:", error);
      toast({ title: "Erro de Comunicação", description: "Falha na comunicação com o servidor", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const registrarNumero = async (phone: PhoneNumber, index: number) => {
    if (!accessToken) {
      toast({ title: "Erro", description: "Token de acesso é obrigatório", variant: "destructive" });
      return;
    }

    try {
      const response = await apiRequest("POST", "/api/registrar-numero", {
        phone_id: phone.id,
        phone_number: phone.display_phone_number,
        access_token: accessToken
      });
      const data = await response.json();

      if (data.success) {
        const updatedPhones = [...phoneNumbers];
        updatedPhones[index] = { ...phone, platform: "CLOUD_API" };
        setPhoneNumbers(updatedPhones);
        toast({ title: "Sucesso", description: `${phone.display_phone_number} registrado na Cloud API` });
      } else {
        toast({ title: "Erro", description: data.error, variant: "destructive" });
      }
    } catch (error) {
      console.error("Erro:", error);
      toast({ title: "Erro", description: "Falha na comunicação com o servidor", variant: "destructive" });
    }
  };

  const registrarTodos = async () => {
    const numerosParaRegistrar = phoneNumbers.filter(p => p.platform !== "CLOUD_API");
    
    if (numerosParaRegistrar.length === 0) {
      toast({ title: "Info", description: "Todos os números já estão registrados na Cloud API" });
      return;
    }

    if (!confirm(`Registrar ${numerosParaRegistrar.length} números na Cloud API?`)) return;

    setIsRegistering(true);
    setRegisterProgress(0);
    setRegisterText("Iniciando registro em massa...");

    for (let i = 0; i < numerosParaRegistrar.length; i++) {
      const phone = numerosParaRegistrar[i];
      const progress = ((i + 1) / numerosParaRegistrar.length) * 100;
      setRegisterProgress(progress);
      setRegisterText(`Registrando ${phone.display_phone_number} (${i + 1}/${numerosParaRegistrar.length})`);

      try {
        const response = await apiRequest("POST", "/api/registrar-numero", {
          phone_id: phone.id,
          phone_number: phone.display_phone_number,
          access_token: accessToken
        });
        const data = await response.json();

        if (data.success) {
          const idx = phoneNumbers.findIndex(p => p.id === phone.id);
          if (idx !== -1) {
            const updated = [...phoneNumbers];
            updated[idx] = { ...phone, platform: "CLOUD_API" };
            setPhoneNumbers(updated);
          }
        }
      } catch (error) {
        console.error("Erro:", error);
      }
    }

    setIsRegistering(false);
    toast({ title: "Registro em massa concluído", description: "Verifique o status dos números" });
  };

  const solicitarSMS = () => {
    if (!accessToken) {
      toast({ title: "Erro", description: "Por favor, preencha o Token de Acesso primeiro", variant: "destructive" });
      return;
    }

    const phoneId = prompt("Digite o Phone ID do número que já está na Business Manager:");
    if (!phoneId) return;

    solicitarSMSAPI(phoneId);
  };

  const solicitarSMSAPI = async (phoneId: string) => {
    try {
      const response = await apiRequest("POST", "/api/solicitar-sms", {
        phone_id: phoneId,
        access_token: accessToken
      });
      const data = await response.json();

      if (data.success) {
        alert(`SMS solicitado com sucesso!\n\nPhone ID: ${phoneId}\nApós receber o SMS, clique em "Verificar SMS".`);
        buscarNumeros();
      } else {
        toast({ title: "Erro ao solicitar SMS", description: data.error, variant: "destructive" });
      }
    } catch (error) {
      console.error("Erro:", error);
      toast({ title: "Erro", description: "Falha na comunicação com o servidor", variant: "destructive" });
    }
  };

  const verificarSMS = () => {
    if (!accessToken) {
      toast({ title: "Erro", description: "Por favor, preencha o Token de Acesso primeiro", variant: "destructive" });
      return;
    }

    const phoneId = prompt("Digite o Phone ID do número que recebeu o SMS:");
    if (!phoneId) return;

    const smsCode = prompt("Digite o código SMS recebido (6 dígitos):");
    if (!smsCode) return;

    verificarSMSAPI(phoneId, smsCode);
  };

  const verificarSMSAPI = async (phoneId: string, smsCode: string) => {
    try {
      const response = await apiRequest("POST", "/api/verificar-sms", {
        phone_id: phoneId,
        sms_code: smsCode,
        access_token: accessToken
      });
      const data = await response.json();

      if (data.success) {
        toast({ title: "Sucesso", description: data.message });
        buscarNumeros();
      } else {
        toast({ title: "Erro", description: data.error, variant: "destructive" });
      }
    } catch (error) {
      console.error("Erro:", error);
      toast({ title: "Erro", description: "Falha na comunicação com o servidor", variant: "destructive" });
    }
  };

  const getQualityColor = (quality: string) => {
    switch (quality) {
      case 'GREEN': return 'bg-[#38A169]';
      case 'YELLOW': return 'bg-slate-400';
      case 'RED': return 'bg-red-500';
      default: return 'bg-slate-500';
    }
  };

  return (
    <div className="min-h-screen">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8 space-y-4 sm:space-y-6">

        {/* WABAs Section */}
        {wabasList.length > 0 && (
          <div className="saas-card">
            <div className="flex items-center gap-2 px-6 py-4 border-b border-[#E2E8F0]">
              <Building2 size={16} className="text-[#0066FF]" />
              <h2 className="text-base font-semibold text-[#1A202C]">WABAs Registradas</h2>
              <span className="ml-auto text-xs font-semibold text-[#0066FF] bg-[#EBF4FF] px-3 py-1 rounded-full border border-[#0066FF]/20">
                {wabasList.length} {wabasList.length === 1 ? "WABA" : "WABAs"}
              </span>
            </div>
            <div className="divide-y divide-[#E2E8F0]">
              {wabasList.map((waba) => {
                const wabaCampaigns = getWabaCampaigns(waba.id);
                const isEditing = editingWabaId === waba.id;
                return (
                  <div key={waba.id} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0 space-y-2">
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              className="h-8 text-sm"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") updateWabaName.mutate({ id: waba.id, name: editingName });
                                if (e.key === "Escape") setEditingWabaId(null);
                              }}
                            />
                            <button
                              className="text-[#38A169] hover:text-[#2F855A] p-1"
                              onClick={() => updateWabaName.mutate({ id: waba.id, name: editingName })}
                              disabled={updateWabaName.isPending}
                            >
                              {updateWabaName.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                            </button>
                            <button
                              className="text-[#A0AEC0] hover:text-[#718096] p-1"
                              onClick={() => setEditingWabaId(null)}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[#1A202C] text-sm">{waba.name?.trim() || waba.wabaId}</span>
                            <button
                              className="text-[#A0AEC0] hover:text-[#718096] p-0.5"
                              onClick={() => { setEditingWabaId(waba.id); setEditingName(waba.name?.trim() || waba.wabaId); }}
                            >
                              <Pencil size={13} />
                            </button>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#718096]">
                          <span className="flex items-center gap-1">
                            <Building size={12} className="text-[#A0AEC0]" />
                            <span className="font-mono">{waba.wabaId}</span>
                          </span>
                          {waba.bmId && (
                            <span className="flex items-center gap-1">
                              <Users size={12} className="text-[#A0AEC0]" />
                              BM: <span className="font-mono">{waba.bmId}</span>
                            </span>
                          )}
                        </div>
                        {wabaCampaigns.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {wabaCampaigns.map((c) => (
                              <span key={c.id} className="flex items-center gap-1 text-[10px] bg-[#EBF4FF] text-[#0066FF] border border-[#0066FF]/20 rounded-full px-2 py-0.5">
                                <Megaphone size={10} />
                                {c.name}
                              </span>
                            ))}
                          </div>
                        )}
                        {wabaCampaigns.length === 0 && (
                          <p className="text-[11px] text-[#A0AEC0]">Sem campanhas vinculadas</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          {waba.subscribedAppsStatus === 'success' ? (
                            <span className="flex items-center gap-1 text-[11px] text-[#38A169]">
                              <Wifi size={11} /> Inscrito no app
                              {waba.subscribedAppsAt && (
                                <span className="text-[#A0AEC0] ml-1">
                                  {new Date(waba.subscribedAppsAt).toLocaleString("pt-BR")}
                                </span>
                              )}
                            </span>
                          ) : waba.subscribedAppsStatus ? (
                            <span className="flex items-center gap-1 text-[11px] text-red-500" title={waba.subscribedAppsStatus}>
                              <WifiOff size={11} /> Falha na inscrição
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-[#A0AEC0]">
                              <WifiOff size={11} /> Inscrição pendente
                            </span>
                          )}
                          <button
                            className="flex items-center gap-1 text-[11px] text-[#0066FF] hover:text-[#0052CC] underline disabled:opacity-50"
                            onClick={() => resubscribeWaba(waba.id)}
                            disabled={resubscribingId === waba.id}
                            title="Re-inscrever no App Meta"
                          >
                            {resubscribingId === waba.id ? (
                              <Loader2 size={11} className="animate-spin" />
                            ) : (
                              <RefreshCw size={11} />
                            )}
                            Re-inscrever no App
                          </button>
                        </div>
                      </div>
                      <div className="flex-shrink-0">
                        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${waba.isActive ? 'text-[#38A169] bg-[#F0FFF4] border border-[#38A169]/20' : 'text-[#A0AEC0] bg-[#F7FAFC] border border-[#E2E8F0]'}`}>
                          {waba.isActive ? "Ativa" : "Inativa"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-4 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[#F7FAFC] border border-[#E2E8F0] flex items-center justify-center">
            <Phone size={20} className="text-[#0066FF]" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-[#1A202C]">Registrar Números</h1>
            <p className="text-sm text-[#A0AEC0]">Cloud API WhatsApp Business</p>
          </div>
        </div>

        {/* Credentials */}
        <div className="saas-card p-6">
          <div className="flex items-center gap-2 mb-6">
            <Key size={16} className="text-[#0066FF]" />
            <h2 className="text-base font-semibold text-[#1A202C]">Credenciais de Acesso</h2>
          </div>

          <div className="space-y-5">
            <div>
              <label className="text-sm text-[#718096] font-medium flex items-center gap-2 mb-2">
                <Shield size={14} className="text-[#0066FF]" /> Token de Acesso WhatsApp Business API
              </label>
              <div className="relative">
                <Input
                  type={showToken ? "text" : "password"}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="Cole seu token de acesso aqui..."
                  className="h-11 pr-12 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] focus:border-[#0066FF] focus:ring-[#0066FF]/10"
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A0AEC0] hover:text-[#718096]"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <p className="text-xs text-[#A0AEC0] mt-1.5 flex items-center gap-1">
                <Info size={12} /> Token não é armazenado no servidor. Usado apenas nesta sessão.
              </p>
            </div>

            <div>
              <label className="text-sm text-[#718096] font-medium flex items-center gap-2 mb-2">
                <Building size={14} className="text-[#0066FF]" /> Identificação da Conta WhatsApp Business
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <Input
                  type="text"
                  value={businessAccountId}
                  onChange={(e) => setBusinessAccountId(e.target.value)}
                  placeholder="Ex: 639849885789886"
                  className="h-11 flex-1 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] focus:border-[#0066FF] focus:ring-[#0066FF]/10"
                />
                <Button
                  onClick={buscarNumeros}
                  disabled={isLoading}
                  className="h-11 px-5 bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold min-h-[44px] flex-shrink-0"
                >
                  {isLoading ? (
                    <RefreshCw size={18} className="animate-spin mr-2" />
                  ) : (
                    <Search size={18} className="mr-2" />
                  )}
                  Buscar Números
                </Button>
              </div>
              <p className="text-xs text-[#A0AEC0] mt-1.5">ID da Business Manager onde estão os números</p>
            </div>
          </div>
        </div>

        {/* Instructions */}
        <div className="saas-card p-5 border-l-2 border-l-[#0066FF]">
          <div className="flex gap-4">
            <div className="w-9 h-9 rounded-lg bg-[#EBF4FF]/50 flex items-center justify-center flex-shrink-0">
              <Info className="h-4 w-4 text-[#0066FF]" />
            </div>
            <div className="flex-1">
              <h4 className="font-semibold text-[#1A202C] text-sm mb-3">Como Adicionar Novos Números</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  'Adicione o número no Facebook Developer Console',
                  'Copie o Phone ID do número',
                  'Use "Solicitar SMS" para receber código',
                  'Use "Verificar SMS" para ativar'
                ].map((text, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-[#EBF4FF] text-[#0066FF] text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                    <p className="text-xs text-[#718096]">{text}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-[#A0AEC0] mt-3 flex items-center gap-1">
                <AlertCircle size={11} />
                Números não podem ser adicionados via API. Use o console web primeiro.
              </p>
            </div>
          </div>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="saas-card p-12 text-center">
            <RefreshCw className="h-10 w-10 animate-spin text-[#0066FF] mx-auto" />
            <p className="mt-4 text-[#1A202C] font-medium">Buscando números na Business Manager...</p>
            <p className="text-sm text-[#A0AEC0] mt-1">Isso pode levar alguns segundos</p>
          </div>
        )}

        {/* Registration Progress */}
        {isRegistering && (
          <div className="saas-card p-6 space-y-4">
            <div className="flex items-center gap-2 text-[#1A202C]">
              <Activity size={16} className="text-[#0066FF]" />
              <span className="font-medium text-sm">Progresso do Registro</span>
              <span className="ml-auto text-sm text-[#718096]">{Math.round(registerProgress)}%</span>
            </div>
            <div className="progress-bar-saas">
              <div className="progress-fill" style={{ width: `${registerProgress}%` }} />
            </div>
            <p className="text-sm text-[#718096]">{registerText}</p>
          </div>
        )}

        {/* Phone Numbers List */}
        {showPhones && phoneNumbers.length > 0 && (
          <div className="saas-card">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2E8F0]">
              <div className="flex items-center gap-2">
                <Phone size={16} className="text-[#0066FF]" />
                <h3 className="text-base font-semibold text-[#1A202C]">Números Encontrados</h3>
              </div>
              <span className="text-xs font-semibold text-[#0066FF] bg-[#EBF4FF] px-3 py-1 rounded-full border border-[#0066FF]/20">
                {phoneNumbers.length} números
              </span>
            </div>
            <div className="p-4 space-y-2 max-h-[450px] overflow-y-auto">
              {phoneNumbers.map((phone, index) => {
                const isVerified = phone.platform === "CLOUD_API";
                return (
                  <div
                    key={phone.id}
                    className={`rounded-xl p-4 transition-all border ${
                      isVerified 
                        ? "bg-slate-50 border-slate-200" 
                        : "bg-[#F7FAFC] border-[#E2E8F0]"
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
                      <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4">
                        <div>
                          <h6 className="font-semibold text-[#1A202C] flex items-center gap-2 text-sm">
                            <Phone size={14} className="text-[#718096]" /> {phone.display_phone_number}
                          </h6>
                          <p className="text-[11px] text-[#A0AEC0] mt-0.5 font-mono truncate max-w-[200px]">ID: {phone.id}</p>
                        </div>
                        <div className="text-sm text-[#718096] flex items-center gap-2">
                          <User size={13} className="text-[#A0AEC0]" /> <span className="truncate">{phone.verified_name}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 sm:gap-4">
                        <div className="flex items-center gap-2 sm:gap-3 text-xs text-[#718096]">
                          <span className="flex items-center gap-1">
                            <span className={`w-2 h-2 rounded-full ${getQualityColor(phone.quality_rating)}`} />
                            {phone.quality_rating}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${isVerified ? 'text-[#38A169] bg-slate-50' : 'text-[#A0AEC0] bg-[#EDF2F7]'}`}>
                            {isVerified ? 'Cloud API' : 'Pendente'}
                          </span>
                        </div>
                        {!isVerified ? (
                          <Button
                            size="sm"
                            className="bg-[#0066FF] hover:bg-[#0052CC] text-white text-xs min-h-[44px]"
                            onClick={() => registrarNumero(phone, index)}
                          >
                            <CheckCircle size={13} className="mr-1" /> Registrar
                          </Button>
                        ) : (
                          <div className="flex items-center gap-1.5 text-[#38A169]">
                            <CheckCircle size={16} />
                            <span className="text-xs font-medium">Ativo</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* No phones found */}
        {showPhones && phoneNumbers.length === 0 && !isLoading && (
          <div className="saas-card p-6 border-l-2 border-l-[#E2E8F0]">
            <div className="flex gap-4 items-center">
              <div className="w-9 h-9 rounded-lg bg-[#F7FAFC] border border-[#E2E8F0] flex items-center justify-center">
                <AlertCircle className="h-4 w-4 text-[#A0AEC0]" />
              </div>
              <div>
                <h4 className="font-semibold text-[#1A202C] text-sm">Nenhum número encontrado</h4>
                <p className="text-sm text-[#A0AEC0]">Nenhum número encontrado nesta Business Manager.</p>
              </div>
            </div>
          </div>
        )}

        {/* Mass Actions */}
        {showPhones && phoneNumbers.length > 0 && (
          <div className="flex flex-wrap gap-2 sm:gap-3 justify-center">
            <Button
              onClick={registrarTodos}
              disabled={isRegistering}
              className="bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold"
            >
              <CheckCircle size={16} className="mr-2" /> Registrar Todos na Cloud API
            </Button>
            <Button
              variant="outline"
              onClick={buscarNumeros}
              disabled={isLoading}
              className="border-[#E2E8F0] text-[#718096] hover:bg-[#F7FAFC] hover:text-[#1A202C]"
            >
              <RefreshCw size={16} className="mr-2" /> Atualizar Status
            </Button>
            <Button
              variant="outline"
              className="border-[#E2E8F0] text-[#718096] hover:bg-[#F7FAFC] hover:text-[#1A202C]"
              onClick={solicitarSMS}
            >
              <MessageSquare size={16} className="mr-2" /> Solicitar SMS
            </Button>
            <Button
              variant="outline"
              className="border-[#0066FF]/20 text-[#0066FF] hover:bg-[#EBF4FF]"
              onClick={verificarSMS}
            >
              <CheckCircle size={16} className="mr-2" /> Verificar SMS
            </Button>
          </div>
        )}
      </div>

    </div>
  );
}
