import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SimpleCampaignStatus } from "@/components/SimpleCampaignStatus";
import { 
  CheckCircle, XCircle, Phone, MessageSquare, Upload, Activity, 
  Check, ArrowRight, ArrowLeft, Key, Shield, Eye, EyeOff, RefreshCw, 
  AlertTriangle, FileText, Play,
  Gauge, Settings, Link2, Clock, Plus, Trash2, Globe,
  Crosshair, ToggleLeft, Package, ShieldCheck, BarChart, Target, Ban,
  Wifi, WifiOff, Loader2
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { WhatsappTemplate, Campaign, ApiConfiguration } from "@shared/schema";
import BotFlowEditor from "@/components/BotFlowEditor";
import ImageTemplateModal from "@/components/ImageTemplateModal";

interface PhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  messaging_limit_tier?: string;
}

interface ValidLead {
  name: string;
  phone: string;
  email: string | null;
  cpf?: string;
  endereco?: string;
  produto?: string;
  valor?: string;
  codigoRastreio?: string;
  leadListId: string;
  isValid: boolean;
}

interface ValidationResult {
  validLeads: Array<{
    nome: string;
    numero: string;
    cpf: string;
  }>;
  invalidLeads: Array<{ line: string; errors: string[] }>;
  summary: {
    total: number;
    valid: number;
    invalid: number;
  };
}

function getTierLabel(tier?: string): string {
  if (!tier) return 'Padrão';
  if (tier.includes('UNLIMITED')) return 'Ilimitado';
  if (tier.includes('100K')) return '100K/dia';
  if (tier.includes('10K')) return '10K/dia';
  if (tier.includes('1K')) return '1K/dia';
  if (tier.includes('250')) return '250/dia';
  return tier;
}

function getQualityInfo(quality: string) {
  switch (quality) {
    case 'GREEN': return { dot: 'bg-[#38A169]', label: 'Excelente', text: 'text-[#38A169]' };
    case 'YELLOW': return { dot: 'bg-slate-400', label: 'Atenção', text: 'text-slate-500' };
    case 'RED': return { dot: 'bg-red-500', label: 'Baixo', text: 'text-red-600' };
    default: return { dot: 'bg-[#A0AEC0]', label: 'Desconhecido', text: 'text-[#A0AEC0]' };
  }
}

const STEPS = [
  { num: 1, icon: Key, label: 'Conexão' },
  { num: 2, icon: Crosshair, label: 'Parâmetros' },
  { num: 3, icon: Phone, label: 'Números' },
  { num: 4, icon: FileText, label: 'Leads' },
  { num: 5, icon: MessageSquare, label: 'Templates' },
  { num: 6, icon: Settings, label: 'Enviar' }
];

function DeliveryStatsCard({ campaignId }: { campaignId: string }) {
  const { data, isLoading } = useQuery<{ sent: number; delivered: number; read: number; failed: number }>({
    queryKey: ["/api/campaigns", campaignId, "delivery-stats"],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/${campaignId}/delivery-stats`);
      if (!res.ok) throw new Error("Falha ao buscar stats");
      return res.json();
    },
    refetchInterval: 10000,
    enabled: !!campaignId,
  });

  if (isLoading || !data) return null;
  const total = (data.sent ?? 0) + (data.delivered ?? 0) + (data.read ?? 0) + (data.failed ?? 0);
  if (total === 0) return null;

  const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;

  return (
    <div className="mt-4 p-4 rounded-xl border border-[#E2E8F0] bg-white space-y-3">
      <p className="text-xs font-semibold text-[#718096] uppercase tracking-widest">Rastreio de Entrega (Webhook)</p>
      {[
        { label: "Enviado", key: "sent" as const, color: "bg-blue-500" },
        { label: "Entregue", key: "delivered" as const, color: "bg-green-500" },
        { label: "Lido", key: "read" as const, color: "bg-purple-500" },
        { label: "Falhou", key: "failed" as const, color: "bg-red-500" },
      ].map(({ label, key, color }) => (
        <div key={key} className="space-y-1">
          <div className="flex justify-between text-xs text-[#4A5568]">
            <span>{label}</span>
            <span>{data[key] ?? 0} <span className="text-[#A0AEC0]">({pct(data[key] ?? 0)}%)</span></span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-[#EDF2F7]">
            <div className={`h-1.5 rounded-full ${color} transition-all duration-500`} style={{ width: `${pct(data[key] ?? 0)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ToggleSwitch({ enabled, onChange, label, description }: { enabled: boolean; onChange: (v: boolean) => void; label: string; description: string }) {
  return (
    <div
      onClick={() => onChange(!enabled)}
      className={`flex items-center gap-3 p-3.5 rounded-xl border cursor-pointer transition-all duration-150 ${
        enabled ? 'border-[#0066FF]/30 bg-[#EBF4FF]' : 'border-[#E2E8F0] bg-white hover:border-[#CBD5E0]'
      }`}
    >
      <div className={`w-10 h-5 rounded-full relative transition-colors flex-shrink-0 ${enabled ? 'bg-[#0066FF]' : 'bg-[#CBD5E0]'}`}>
        <div className={`w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all ${enabled ? 'left-5' : 'left-0.5'}`} />
      </div>
      <div className="min-w-0">
        <div className={`text-sm font-medium ${enabled ? 'text-[#1A202C]' : 'text-[#718096]'}`}>{label}</div>
        <div className="text-[10px] text-[#A0AEC0]">{description}</div>
      </div>
    </div>
  );
}

export default function OverdrivePage() {
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  
  const [metaToken, setMetaToken] = useState("");
  const [whatsappBusinessId, setWhatsappBusinessId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showAppSecret, setShowAppSecret] = useState(false);
  
  const [selectedPhones, setSelectedPhones] = useState<string[]>([]);

  const [paramCount, setParamCount] = useState<number>(0);
  const [paramValues, setParamValues] = useState<Record<number, string>>({});

  const [enableDomainRotation, setEnableDomainRotation] = useState(false);
  const [dominios, setDominios] = useState<string[]>([""]);
  const [enableTextVariations, setEnableTextVariations] = useState(false);
  const [textVariations, setTextVariations] = useState<string[]>([""]);
  const [enableDynamicCpfUrl, setEnableDynamicCpfUrl] = useState(false);
  const [enableBurstMode, setEnableBurstMode] = useState(false);
  const [businessHoursOnly, setBusinessHoursOnly] = useState(false);
  const [usePackageImage, setUsePackageImage] = useState(false);
  const [packageImageType, setPackageImageType] = useState<"custom">("custom");
  const [customImageTemplateId, setCustomImageTemplateId] = useState<string>("");
  const [customTemplates, setCustomTemplates] = useState<Array<{ id: string; name: string; baseImageUrl: string; width: number; height: number }>>([]);
  const [imageTemplateModalOpen, setImageTemplateModalOpen] = useState(false);
  const [deliveryStrategy, setDeliveryStrategy] = useState<'safe' | 'balanced' | 'aggressive'>('balanced');
  const [enableOptOutFilter, setEnableOptOutFilter] = useState(true);
  const [enableWarmup, setEnableWarmup] = useState(false);
  const [enableFollowUp, setEnableFollowUp] = useState(false);
  const [followUpDelayMinutes, setFollowUpDelayMinutes] = useState(1440);
  const [followUpMessage, setFollowUpMessage] = useState('');

  const [leadsText, setLeadsText] = useState("");
  const [validatedLeads, setValidatedLeads] = useState<ValidLead[]>([]);
  const [invalidLeads, setInvalidLeads] = useState<Array<{ line: string; errors: string[] }>>([]);
  const [validationSummary, setValidationSummary] = useState<ValidationResult['summary'] | null>(null);
  const [leadFormat, setLeadFormat] = useState<'legacy' | 'new' | 'cte' | 'cpf'>('cpf');
  
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([]);
  const [templateWeights, setTemplateWeights] = useState<Record<string, number>>({});
  const [speedMode, setSpeedMode] = useState<'SLOW' | 'NORMAL' | 'FAST'>('NORMAL');
  const [conversionMessage, setConversionMessage] = useState('');
  const [conversionLink, setConversionLink] = useState('');
  const [conversionDelayMs, setConversionDelayMs] = useState(5000);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [dispatchProgress, setDispatchProgress] = useState<{
    total: number;
    sent: number;
    success: number;
    failed: number;
    progress: number;
    isRunning: boolean;
    campaignId?: string;
  } | null>(null);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: config, isLoading: configLoading } = useQuery<ApiConfiguration>({
    queryKey: ["/api/config"],
    retry: false,
  });

  useEffect(() => {
    if (config) {
      setMetaToken(config.metaToken || "");
      setWhatsappBusinessId(config.whatsappBusinessId || "");
      setAppSecret(config.appSecret || "");
      setWebhookVerifyToken(config.webhookVerifyToken || "");
      if (config.isValid) {
        setIsConnected(true);
        setCurrentStep(2);
      }
    }
  }, [config]);

  const refreshCustomTemplates = () => {
    fetch("/api/image-templates")
      .then((r) => r.json())
      .then((data) => setCustomTemplates(data || []))
      .catch(() => setCustomTemplates([]));
  };

  useEffect(() => {
    if (usePackageImage) {
      refreshCustomTemplates();
    }
  }, [usePackageImage]);

  const { data: phoneNumbers = [], isLoading: phonesLoading, refetch: refetchPhones } = useQuery<PhoneNumber[]>({
    queryKey: ['/api/phone-numbers'],
    enabled: isConnected
  });

  const { data: templates = [], isLoading: templatesLoading, refetch: refetchTemplates } = useQuery<WhatsappTemplate[]>({
    queryKey: ['/api/templates'],
    enabled: isConnected
  });

  const { data: wabaChecklist, refetch: refetchChecklist } = useQuery<{
    allOk: boolean;
    items: {
      wabaConnected: boolean;
      tokenValid: boolean;
      appSecretPresent: boolean;
      subscribedApps: boolean;
      webhookReceived: boolean;
    };
    metadata: {
      lastWebhookAt: string | null;
      subscribedAppsAt: string | null;
      wabaCount: number;
    };
  }>({
    queryKey: ['/api/wabas/checklist'],
    enabled: isConnected && currentStep === 6,
    refetchInterval: currentStep === 6 ? 8000 : false,
  });

  const [webhookTestStatus, setWebhookTestStatus] = useState<'idle' | 'waiting' | 'success' | 'timeout'>('idle');

  const startWebhookTest = async () => {
    setWebhookTestStatus('waiting');
    try {
      await apiRequest('POST', '/api/webhook/start-reception-test', {});
      const timer = setInterval(async () => {
        try {
          const r = await apiRequest('GET', '/api/webhook/reception-test-status', undefined);
          const data = await r.json();
          if (data.status === 'success') {
            setWebhookTestStatus('success');
            clearInterval(timer);
            refetchChecklist();
          } else if (data.status === 'timeout') {
            setWebhookTestStatus('timeout');
            clearInterval(timer);
          }
        } catch {
        }
      }, 2000);
      setTimeout(() => {
        clearInterval(timer);
        setWebhookTestStatus(prev => prev === 'waiting' ? 'timeout' : prev);
      }, 62000);
    } catch {
      setWebhookTestStatus('idle');
    }
  };

  const validateConnectionMutation = useMutation({
    mutationFn: async (data: { metaToken: string; whatsappBusinessId: string; appSecret?: string; webhookVerifyToken?: string }) => {
      const saveResponse = await apiRequest("POST", "/api/config", data);
      await saveResponse.json();
      const validateResponse = await apiRequest("POST", "/api/config/validate", {});
      return validateResponse.json();
    },
    onSuccess: (result) => {
      if (result.valid) {
        setIsConnected(true);
        setCurrentStep(2);
        toast({ title: "Conectado", description: "Pronto para configurar." });
        queryClient.invalidateQueries({ queryKey: ["/api/config"] });
        refetchPhones();
        refetchTemplates();
      } else {
        toast({ title: "Falha na conexão", description: "Verifique suas credenciais.", variant: "destructive" });
      }
    },
    onError: (error) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const validateLeadsMutation = useMutation({
    mutationFn: async (leadsData: string) => {
      const response = await apiRequest('POST', '/api/leads/validate', { leadsData, format: leadFormat });
      return await response.json() as ValidationResult;
    },
    onSuccess: (result) => {
      const leadsComCpf = result.validLeads.map((lead: any) => ({
        name: lead.nome || lead.name,
        phone: lead.numero || lead.phone,
        cpf: lead.cpf,
        endereco: lead.endereco,
        produto: lead.produto,
        valor: lead.valor,
        codigoRastreio: lead.codigoRastreio,
        email: lead.email,
        leadListId: "",
        isValid: true
      }));
      
      setValidatedLeads(leadsComCpf);
      setInvalidLeads(result.invalidLeads);
      setValidationSummary(result.summary);
      toast({ title: "Leads processados", description: `${result.summary.valid} válidos` });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message || "Erro ao validar", variant: "destructive" });
    }
  });

  const syncTemplatesMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/templates/sync', {});
      return await response.json();
    },
    onSuccess: (result) => {
      toast({ title: "Templates atualizados", description: `${result.count} encontrados` });
      refetchTemplates();
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    }
  });

  const startDispatchMutation = useMutation({
    mutationFn: async (campaignData: any) => {
      const response = await apiRequest('POST', '/api/campaigns/dispatch', campaignData);
      return await response.json();
    },
    onSuccess: (response) => {
      toast({ title: "Disparo iniciado", description: "Monitorando em tempo real." });
      if (response.campaignId) {
        setCampaignId(response.campaignId);
        monitorCampaignProgress(response.campaignId);
      }
      queryClient.invalidateQueries({ queryKey: ['/api/campaigns'] });
    },
    onError: (error: any) => {
      toast({ title: "Erro no disparo", description: error.message, variant: "destructive" });
      setDispatchProgress(null);
    }
  });

  const handleConnect = () => {
    if (!metaToken.trim() || !whatsappBusinessId.trim()) {
      toast({ title: "Campos obrigatórios", description: "Preencha Token e Business ID", variant: "destructive" });
      return;
    }
    validateConnectionMutation.mutate({
      metaToken,
      whatsappBusinessId,
      appSecret: appSecret.trim() || undefined,
      webhookVerifyToken: webhookVerifyToken.trim() || undefined,
    });
  };

  const handlePhoneSelection = (phoneId: string, checked: boolean) => {
    if (checked) {
      setSelectedPhones(prev => [...prev, phoneId]);
    } else {
      setSelectedPhones(prev => prev.filter(id => id !== phoneId));
    }
  };

  const handleValidateLeads = () => {
    if (!leadsText.trim()) {
      toast({ title: "Dados obrigatórios", description: "Cole os leads", variant: "destructive" });
      return;
    }
    validateLeadsMutation.mutate(leadsText);
  };

  const handleTemplateSelection = (templateName: string, checked: boolean) => {
    if (checked) {
      setSelectedTemplates(prev => [...prev, templateName]);
    } else {
      setSelectedTemplates(prev => prev.filter(name => name !== templateName));
    }
  };

  const getDistributionStrategy = (): string => {
    if (deliveryStrategy === 'safe') return 'round_robin';
    if (deliveryStrategy === 'aggressive') return 'weighted';
    return 'adaptive';
  };

  const getStrategySpeedOverride = () => {
    if (deliveryStrategy === 'safe') return { burstMode: false, businessHoursOnly: true };
    if (deliveryStrategy === 'aggressive') return { burstMode: true, businessHoursOnly: false };
    return {};
  };

  const SPEED_RATES: Record<string, number> = { SLOW: 0.3, NORMAL: 0.5, FAST: 0.8 };

  const estimatedTime = useMemo(() => {
    const numPhones = selectedPhones.length;
    const numLeads = validatedLeads.length;

    if (numLeads === 0) return { label: 'Sem leads importados', seconds: 0 };
    if (numPhones === 0) return { label: 'Nenhum número conectado', seconds: 0 };

    const rate = SPEED_RATES[speedMode] || 0.5;
    if (rate <= 0) return { label: 'Velocidade inválida', seconds: 0 };

    const totalSeconds = Math.ceil(numLeads / (rate * numPhones));

    if (totalSeconds < 60) {
      return { label: `${totalSeconds} segundos`, seconds: totalSeconds };
    }
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
      const parts = [`${hours}h ${mins}min`];
      if (secs > 0) parts[0] += ` e ${secs}s`;
      return { label: parts[0], seconds: totalSeconds };
    }
    return { label: secs > 0 ? `${mins} minutos e ${secs} segundos` : `${mins} minutos`, seconds: totalSeconds };
  }, [validatedLeads.length, selectedPhones.length, speedMode]);

  const handleStartDispatch = () => {
    if (validatedLeads.length === 0 || selectedPhones.length === 0 || selectedTemplates.length === 0) {
      toast({ title: "Configuração incompleta", description: "Verifique leads, números e template", variant: "destructive" });
      return;
    }

    if (enableDomainRotation) {
      const doms = dominios.filter(d => d.trim());
      if (doms.length === 0) {
        toast({ title: "Rotação de domínios ativa", description: "Adicione ao menos um domínio", variant: "destructive" });
        return;
      }
    }

    setDispatchProgress({
      total: validatedLeads.length,
      sent: 0,
      success: 0,
      failed: 0,
      progress: 0,
      isRunning: true
    });

    const filledMessages: Record<number, string> = {};
    for (let i = 1; i <= paramCount; i++) {
      const val = (paramValues[i] || '').trim();
      if (val) filledMessages[i] = val.length > 1024 ? val.slice(0, 1024) : val;
    }

    const payload: any = {
      leads: validatedLeads,
      phoneNumbers: selectedPhones,
      templates: selectedTemplates,
      distributionStrategy: getDistributionStrategy(),
      speedMode: speedMode,
      modo: 'template',
    };

    if (Object.keys(filledMessages).length > 0) {
      payload.customMessages = filledMessages;
    }

    if (enableDomainRotation) {
      payload.dominios = dominios.filter(d => d.trim());
    }

    if (enableTextVariations) {
      const vars = textVariations.filter(v => v.trim());
      if (vars.length > 0) {
        payload.variacoes3 = vars;
      }
    }

    if (enableDynamicCpfUrl) {
      payload.isDynamicUrl = true;
    }

    const strategyOverride = getStrategySpeedOverride();
    if (enableBurstMode || strategyOverride.burstMode) {
      payload.burstMode = true;
    }

    if (businessHoursOnly || strategyOverride.businessHoursOnly) {
      payload.businessHoursOnly = true;
    }

    payload.enableOptOutFilter = enableOptOutFilter;
    payload.deliveryStrategy = deliveryStrategy;

    if (enableFollowUp && followUpMessage.trim()) {
      payload.followUpConfig = {
        delayMinutes: followUpDelayMinutes,
        message: followUpMessage.trim(),
      };
    }

    if (conversionMessage.trim()) {
      payload.conversionMessage = conversionMessage.trim();
      payload.conversionLink = conversionLink.trim();
      payload.conversionDelayMs = conversionDelayMs;
    }

    if (usePackageImage) {
      payload.usePackageImage = true;
      payload.packageImageType = packageImageType === "custom" ? "auto" : packageImageType;
      if (packageImageType === "custom" && customImageTemplateId) {
        payload.customImageTemplateId = customImageTemplateId;
      }
    }

    if (selectedTemplates.length > 1 && Object.keys(templateWeights).length > 0) {
      payload.templateWeights = templateWeights;
    }

    startDispatchMutation.mutate(payload);
  };

  const monitorCampaignProgress = (cId: string) => {
    setDispatchProgress({
      total: validatedLeads.length,
      sent: 0,
      success: 0,
      failed: 0,
      progress: 0,
      isRunning: true,
      campaignId: cId
    });
  };

  const handleNewCampaign = () => {
    setCurrentStep(2);
    setDispatchProgress(null);
    setCampaignId(null);
    setValidatedLeads([]);
    setSelectedPhones([]);
    setSelectedTemplates([]);
    setTemplateWeights({});
    setLeadsText("");
    setValidationSummary(null);
    setParamCount(1);
    setParamValues({ 1: '' });
    setEnableDomainRotation(false);
    setDominios([""]);
    setEnableTextVariations(false);
    setTextVariations([""]);
    setEnableDynamicCpfUrl(false);
    setEnableBurstMode(false);
  };

  const approvedTemplates = templates.filter((t: WhatsappTemplate) => t.status === 'APPROVED');
  const canProceedToStep3 = true;
  const canProceedToStep4 = selectedPhones.length > 0;
  const canProceedToStep5 = validatedLeads.length > 0;
  const canProceedToStep6 = selectedTemplates.length > 0;

  const calculateEstimatedTime = () => {
    const leadsCount = validatedLeads.length;
    const phonesCount = selectedPhones.length;
    if (leadsCount === 0 || phonesCount === 0) return '--';
    const ratePerPhone = 25;
    const totalRate = phonesCount * ratePerPhone;
    const seconds = leadsCount / totalRate;
    if (seconds < 60) return `~${Math.ceil(seconds)}s`;
    if (seconds < 3600) return `~${Math.ceil(seconds / 60)}min`;
    return `~${Math.ceil(seconds / 3600)}h`;
  };


  return (
    <div className="min-h-screen">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-8">
        
        <div className="flex items-center justify-start sm:justify-center mb-6 sm:mb-10 overflow-x-auto pb-2 -mx-2 px-2 scrollbar-hide">
          {STEPS.map((step, i) => {
            const isActive = currentStep === step.num;
            const isComplete = currentStep > step.num;
            const Icon = step.icon;
            return (
              <div key={step.num} className="flex items-center flex-shrink-0">
                <button
                  onClick={() => { if (isComplete) setCurrentStep(step.num); }}
                  disabled={!isComplete && !isActive}
                  className={`flex items-center gap-1.5 sm:gap-2.5 px-2.5 sm:px-4 py-2 rounded-lg transition-all duration-150 ${
                    isActive 
                      ? 'bg-[#EBF4FF] text-[#1A202C]' 
                      : isComplete 
                        ? 'text-[#38A169] cursor-pointer hover:bg-[#F7FAFC]' 
                        : 'text-[#A0AEC0] cursor-default'
                  }`}
                >
                  <div className={`w-6 h-6 sm:w-7 sm:h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${
                    isActive 
                      ? 'bg-[#0066FF] text-white' 
                      : isComplete 
                        ? 'bg-[#38A169]/15 text-[#38A169]' 
                        : 'bg-[#EDF2F7] text-[#A0AEC0]'
                  }`}>
                    {isComplete ? <Check size={13} strokeWidth={3} /> : step.num}
                  </div>
                  <span className="text-xs sm:text-sm font-medium whitespace-nowrap">{step.label}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <div className={`w-4 sm:w-8 h-px mx-0.5 sm:mx-1 ${isComplete ? 'bg-[#38A169]/30' : 'bg-[#E2E8F0]'}`} />
                )}
              </div>
            );
          })}
        </div>

        {currentStep === 1 && (
          <div className="max-w-lg mx-auto">
            <div className="saas-card p-8">
              <div className="text-center mb-8">
                <div className="w-14 h-14 rounded-2xl bg-[#F7FAFC] border border-[#E2E8F0] flex items-center justify-center mx-auto mb-4">
                  <Key className="text-[#718096]" size={24} />
                </div>
                <h2 className="text-xl font-semibold text-[#1A202C]">Conectar a Meta</h2>
                <p className="text-sm text-[#718096] mt-1">Insira suas credenciais da API WhatsApp Business</p>
              </div>
              
              <div className="space-y-5">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[#718096] font-medium">Token de Acesso</label>
                    <a href="https://developers.facebook.com/tools/accesstoken/" target="_blank" rel="noopener" className="text-xs text-[#0066FF] hover:underline">Onde obter?</a>
                  </div>
                  <div className="relative">
                    <Input
                      type={showToken ? "text" : "password"}
                      value={metaToken}
                      onChange={(e) => setMetaToken(e.target.value)}
                      placeholder="EAAxxxxxxxxx..."
                      className="h-11 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] pr-12 font-mono text-sm focus:border-[#0066FF] focus:ring-[#0066FF]/10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A0AEC0] hover:text-[#718096]"
                    >
                      {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[#718096] font-medium">WhatsApp Business ID</label>
                    <a href="https://business.facebook.com/settings/whatsapp-business-accounts" target="_blank" rel="noopener" className="text-xs text-[#0066FF] hover:underline">Onde obter?</a>
                  </div>
                  <Input
                    value={whatsappBusinessId}
                    onChange={(e) => setWhatsappBusinessId(e.target.value)}
                    placeholder="123456789..."
                    className="h-11 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] font-mono text-sm focus:border-[#0066FF] focus:ring-[#0066FF]/10"
                  />
                </div>

                <div className="border-t border-[#E2E8F0] pt-5 mt-2">
                  <p className="text-xs text-[#A0AEC0] mb-4">Configurações do Webhook (opcional)</p>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[#718096] font-medium">App Secret</label>
                    <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener" className="text-xs text-[#0066FF] hover:underline">Onde obter?</a>
                  </div>
                  <div className="relative">
                    <Input
                      type={showAppSecret ? "text" : "password"}
                      value={appSecret}
                      onChange={(e) => setAppSecret(e.target.value)}
                      placeholder="App Secret do seu app na Meta..."
                      className="h-11 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] pr-12 font-mono text-sm focus:border-[#0066FF] focus:ring-[#0066FF]/10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAppSecret(!showAppSecret)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#A0AEC0] hover:text-[#718096]"
                    >
                      {showAppSecret ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm text-[#718096] font-medium">Webhook Verify Token</label>
                  </div>
                  <Input
                    value={webhookVerifyToken}
                    onChange={(e) => setWebhookVerifyToken(e.target.value)}
                    placeholder="Token de verificação do webhook..."
                    className="h-11 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] font-mono text-sm focus:border-[#0066FF] focus:ring-[#0066FF]/10"
                  />
                </div>

                <Button 
                  onClick={handleConnect}
                  disabled={validateConnectionMutation.isPending}
                  className="w-full h-11 bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold transition-colors"
                >
                  {validateConnectionMutation.isPending ? (
                    <><RefreshCw className="mr-2 animate-spin" size={18} /> Validando...</>
                  ) : (
                    <><Shield className="mr-2" size={18} /> Conectar</>
                  )}
                </Button>
              </div>

              {isConnected && (
                <div className="mt-4 flex items-center justify-center gap-2 text-[#38A169] text-sm">
                  <CheckCircle size={16} />
                  <span>Conectado com sucesso</span>
                </div>
              )}
            </div>
          </div>
        )}

        {currentStep === 2 && isConnected && (
          <div className="max-w-2xl mx-auto">
            <div className="saas-card p-6 sm:p-8">
              <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-2xl bg-[#F7FAFC] border border-[#E2E8F0] flex items-center justify-center mx-auto mb-4">
                  <Crosshair className="text-[#718096]" size={24} />
                </div>
                <h2 className="text-xl font-semibold text-[#1A202C]">Parâmetros do Template</h2>
                <p className="text-sm text-[#718096] mt-1">Adicione os parâmetros que seu template usa e personalize o conteúdo</p>
              </div>

              <div className="space-y-6">
                <div className="space-y-4">
                  {Array.from({ length: paramCount }, (_, i) => i + 1).map(paramNum => (
                    <div key={paramNum} className="border border-[#E2E8F0] rounded-lg p-4 bg-white relative">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm text-[#718096] font-medium flex items-center gap-2">
                          <code className="text-[#0066FF] font-mono text-xs bg-[#EBF4FF] px-1.5 py-0.5 rounded">{`{{${paramNum}}}`}</code>
                          <span>Mensagem personalizada</span>
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            const newCount = paramCount - 1;
                            const newValues: Record<number, string> = {};
                            for (let i = 1; i <= newCount; i++) {
                              newValues[i] = i < paramNum ? (paramValues[i] || '') : (paramValues[i + 1] || '');
                            }
                            setParamCount(newCount);
                            setParamValues(newValues);
                          }}
                          className="p-1 rounded hover:bg-red-50 text-[#A0AEC0] hover:text-red-500 transition-colors"
                          title="Remover parâmetro"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1 mb-2">
                        {[
                          { tag: '{cpf}', label: 'CPF' },
                          { tag: '{nome}', label: 'Nome' },
                          { tag: '{telefone}', label: 'Telefone' },
                          { tag: '{email}', label: 'Email' },
                          { tag: '{produto}', label: 'Produto' },
                          { tag: '{valor}', label: 'Valor' },
                          { tag: '{codigoRastreio}', label: 'Rastreio' },
                          { tag: '{endereco}', label: 'Endereco' },
                        ].map(v => (
                          <button
                            key={v.tag}
                            type="button"
                            onClick={() => {
                              const current = paramValues[paramNum] || '';
                              const newVal = current + v.tag;
                              if (newVal.length <= 1024) setParamValues(prev => ({ ...prev, [paramNum]: newVal }));
                            }}
                            className="inline-flex items-center gap-1 bg-[#F7FAFC] hover:bg-[#EBF4FF] border border-[#E2E8F0] hover:border-[#0066FF] rounded px-2 py-0.5 text-[11px] transition-colors cursor-pointer"
                          >
                            <code className="text-[#0066FF] font-mono font-bold">{v.tag}</code>
                            <span className="text-[#718096]">{v.label}</span>
                          </button>
                        ))}
                      </div>
                      <Textarea
                        value={paramValues[paramNum] || ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val.length <= 1024) setParamValues(prev => ({ ...prev, [paramNum]: val }));
                        }}
                        placeholder={`Ex: Ola {nome}, seu CPF {cpf} foi aprovado! Clique para mais detalhes.`}
                        className="min-h-[70px] bg-[#F7FAFC] border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] text-sm resize-none focus:border-[#0066FF]"
                      />
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[11px] text-[#A0AEC0]">Clique nas tags acima para inserir dados do lead</span>
                        <span className={`text-xs ${(paramValues[paramNum] || '').length > 900 ? 'text-orange-500' : 'text-[#A0AEC0]'}`}>
                          {(paramValues[paramNum] || '').length}/1024
                        </span>
                      </div>
                    </div>
                  ))}

                  {paramCount === 0 && (
                    <div className="text-center py-6 text-[#A0AEC0] text-sm border border-dashed border-[#E2E8F0] rounded-lg">
                      Nenhum parâmetro adicionado. Clique no botão abaixo para adicionar.
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      const newNum = paramCount + 1;
                      setParamCount(newNum);
                      setParamValues(prev => ({ ...prev, [newNum]: '' }));
                    }}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 border-dashed border-[#E2E8F0] hover:border-[#0066FF] text-[#718096] hover:text-[#0066FF] transition-colors text-sm font-medium"
                  >
                    <Plus size={16} />
                    <span>Adicionar Parâmetro</span>
                  </button>
                </div>

                <div className="border-t border-[#E2E8F0] pt-6">
                  <div className="flex items-center gap-2 mb-4">
                    <ToggleLeft size={16} className="text-[#718096]" />
                    <span className="text-sm font-semibold text-[#1A202C]">Funcionalidades Extras</span>
                  </div>

                  <div className="space-y-3">
                    <ToggleSwitch
                      enabled={enableDomainRotation}
                      onChange={setEnableDomainRotation}
                      label="Rotação de Domínios"
                      description="Alterna entre domínios automaticamente a cada N envios"
                    />

                    {enableDomainRotation && (
                      <div className="ml-4 pl-4 border-l-2 border-[#0066FF]/20 space-y-2">
                        {dominios.map((dom, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-xs text-[#A0AEC0] w-5 text-right flex-shrink-0">{i + 1}.</span>
                            <Input
                              value={dom}
                              onChange={(e) => {
                                const next = [...dominios];
                                next[i] = e.target.value;
                                setDominios(next);
                              }}
                              placeholder="https://seudomínio.com"
                              className="h-9 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#CBD5E0] font-mono text-sm focus:border-[#0066FF]"
                            />
                            <button
                              type="button"
                              onClick={() => setDominios(dominios.filter((_, j) => j !== i))}
                              className="text-[#CBD5E0] hover:text-red-400 transition-colors flex-shrink-0"
                              disabled={dominios.length <= 1}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setDominios([...dominios, ""])}
                          className="flex items-center gap-1.5 text-xs text-[#0066FF] hover:text-[#0052CC] font-medium mt-1"
                        >
                          <Plus size={12} /> Adicionar domínio
                        </button>
                      </div>
                    )}

                    <ToggleSwitch
                      enabled={enableTextVariations}
                      onChange={setEnableTextVariations}
                      label="Variações de Texto"
                      description="Sorteia entre variações para parecer mais natural"
                    />

                    {enableTextVariations && (
                      <div className="ml-4 pl-4 border-l-2 border-[#0066FF]/20 space-y-2">
                        <p className="text-[11px] text-[#A0AEC0] mb-1">Textos alternativos sorteados aleatoriamente por lead</p>
                        {textVariations.map((v, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <span className="text-xs text-[#A0AEC0] w-5 text-right flex-shrink-0">{i + 1}.</span>
                            <Input
                              value={v}
                              onChange={(e) => {
                                const next = [...textVariations];
                                next[i] = e.target.value;
                                setTextVariations(next);
                              }}
                              placeholder="Texto da variação..."
                              className="h-9 bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#CBD5E0] text-sm focus:border-purple-400"
                            />
                            <button
                              type="button"
                              onClick={() => setTextVariations(textVariations.filter((_, j) => j !== i))}
                              className="text-[#CBD5E0] hover:text-red-400 transition-colors flex-shrink-0"
                              disabled={textVariations.length <= 1}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setTextVariations([...textVariations, ""])}
                          className="flex items-center gap-1.5 text-xs text-purple-500 hover:text-purple-700 font-medium mt-1"
                        >
                          <Plus size={12} /> Adicionar variação
                        </button>
                      </div>
                    )}

                    <ToggleSwitch
                      enabled={enableDynamicCpfUrl}
                      onChange={setEnableDynamicCpfUrl}
                      label="URL Dinamica com CPF"
                      description="Substitui o último segmento da URL pelo CPF do lead"
                    />

                    {enableDynamicCpfUrl && (
                      <div className="ml-4 pl-4 border-l-2 border-[#0066FF]/20">
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl">
                          <p className="text-xs text-blue-700">
                            Exemplo: <code className="bg-blue-100 px-1 rounded">https://site.com/registro</code> será enviado como <code className="bg-blue-100 px-1 rounded">https://site.com/01101101105</code> (CPF do lead)
                          </p>
                        </div>
                      </div>
                    )}

                    <ToggleSwitch
                      enabled={enableBurstMode}
                      onChange={setEnableBurstMode}
                      label="Envio Simultâneo"
                      description="Utiliza múltiplos números em paralelo com controle por ciclo"
                    />

                    <ToggleSwitch
                      enabled={businessHoursOnly}
                      onChange={setBusinessHoursOnly}
                      label="Horário Comercial"
                      description="Enviar apenas entre 08:00 e 20:00"
                    />

                    <ToggleSwitch
                      enabled={usePackageImage}
                      onChange={setUsePackageImage}
                      label="Imagem Personalizada"
                      description="Gera imagem com nome e CPF do lead antes do envio"
                    />

                    {usePackageImage && (
                      <div className="ml-4 pl-4 border-l-2 border-yellow-300 space-y-2">
                        <p className="text-[11px] text-[#A0AEC0] mb-1">Selecione um template de imagem</p>
                        {customTemplates.length > 0 ? (
                          <div className="grid grid-cols-2 gap-2">
                            {customTemplates.map((ct) => (
                              <button
                                key={ct.id}
                                type="button"
                                onClick={() => { setPackageImageType("custom"); setCustomImageTemplateId(ct.id); }}
                                className={`flex items-center gap-2 p-3 rounded-lg border-2 text-left transition-all ${
                                  packageImageType === "custom" && customImageTemplateId === ct.id
                                    ? "border-purple-400 bg-purple-50"
                                    : "border-[#E2E8F0] bg-white hover:border-gray-300"
                                }`}
                              >
                                {ct.baseImageUrl ? (
                                  <img src={ct.baseImageUrl} alt={ct.name} className="w-8 h-8 rounded object-cover" />
                                ) : (
                                  <div className="w-8 h-8 rounded bg-purple-100 flex items-center justify-center">
                                    <FileText size={14} className="text-purple-400" />
                                  </div>
                                )}
                                <div>
                                  <p className={`text-xs font-semibold ${packageImageType === "custom" && customImageTemplateId === ct.id ? "text-gray-900" : "text-gray-500"}`}>{ct.name}</p>
                                  <p className="text-[10px] text-gray-400">{ct.width}x{ct.height}</p>
                                </div>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="text-center py-4 bg-[#F7FAFC] rounded-xl border border-[#E2E8F0]">
                            <FileText size={24} className="mx-auto mb-2 text-[#CBD5E0]" />
                            <p className="text-xs text-[#718096] mb-2">Nenhum template de imagem criado</p>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => setImageTemplateModalOpen(true)}
                          className="flex items-center justify-center gap-2 w-full py-2 text-xs font-medium text-purple-600 bg-purple-50 hover:bg-purple-100 rounded-lg border border-purple-200 transition-colors"
                        >
                          <Plus size={14} /> Criar Template no Editor Visual
                        </button>
                        <p className="text-[11px] text-[#A0AEC0]">
                          Crie templates personalizados com campos de nome, CPF e texto customizado no Editor Visual
                        </p>
                        <ImageTemplateModal
                          open={imageTemplateModalOpen}
                          onClose={() => setImageTemplateModalOpen(false)}
                          onSaved={(saved) => {
                            setImageTemplateModalOpen(false);
                            refreshCustomTemplates();
                            setCustomImageTemplateId(saved.id);
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-between mt-6">
                <Button
                  onClick={() => setCurrentStep(1)}
                  variant="ghost"
                  className="text-[#718096] hover:text-[#1A202C]"
                >
                  <ArrowLeft size={16} className="mr-2" /> Voltar
                </Button>
                <Button
                  onClick={() => setCurrentStep(3)}
                  disabled={!canProceedToStep3}
                  className="bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold px-6 disabled:opacity-20"
                >
                  Próximo <ArrowRight size={16} className="ml-2" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {currentStep === 3 && isConnected && (
          <div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
              <div className="lg:col-span-2">
                <div className="saas-card p-6">
                  <div className="flex items-center justify-between mb-5">
                    <div>
                      <h2 className="text-lg font-semibold text-[#1A202C]">Números Disponíveis</h2>
                      <p className="text-xs text-[#718096] mt-0.5">{phoneNumbers.length} encontrados na sua conta</p>
                    </div>
                    {selectedPhones.length > 0 && (
                      <span className="text-xs font-semibold text-slate-600 bg-slate-100 px-3 py-1 rounded-full border border-slate-200">
                        {selectedPhones.length} selecionado{selectedPhones.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  
                  {phonesLoading ? (
                    <div className="flex items-center justify-center py-16">
                      <RefreshCw className="animate-spin text-[#A0AEC0]" size={28} />
                    </div>
                  ) : phoneNumbers.length === 0 ? (
                    <div className="text-center py-16">
                      <Phone className="mx-auto mb-3 text-[#CBD5E0]" size={40} />
                      <p className="text-[#718096] mb-4">Nenhum número encontrado</p>
                      <Button onClick={() => refetchPhones()} variant="outline" size="sm" className="border-[#E2E8F0] text-[#718096]">
                        <RefreshCw size={14} className="mr-2" /> Tentar novamente
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                      {phoneNumbers.map((phone) => {
                        const isSelected = selectedPhones.includes(phone.id);
                        const quality = getQualityInfo(phone.quality_rating);
                        return (
                          <div 
                            key={phone.id}
                            onClick={() => handlePhoneSelection(phone.id, !isSelected)}
                            className={`group flex items-center gap-4 p-4 rounded-xl border cursor-pointer transition-all duration-150 ${
                              isSelected
                                ? 'border-[#0066FF]/30 bg-[#EBF4FF]'
                                : 'border-[#E2E8F0] hover:border-[#CBD5E0] bg-white'
                            }`}
                          >
                            <Checkbox
                              checked={isSelected}
                              className="border-[#CBD5E0] data-[state=checked]:bg-[#0066FF] data-[state=checked]:border-[#0066FF]"
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-3">
                                <span className="font-semibold text-[#1A202C]">{phone.display_phone_number}</span>
                                <div className={`w-2 h-2 rounded-full ${quality.dot}`} />
                                <span className={`text-xs font-medium ${quality.text}`}>{quality.label}</span>
                              </div>
                              <div className="flex items-center gap-3 mt-1">
                                <span className="text-sm text-[#718096]">{phone.verified_name}</span>
                                <span className="text-xs text-[#718096] px-2 py-0.5 rounded bg-[#EDF2F7]">{getTierLabel(phone.messaging_limit_tier)}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                {selectedPhones.length > 1 && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-slate-50 border border-slate-200">
                    <AlertTriangle size={14} className="text-slate-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-slate-600">Alerta de Risco WABA</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Todos os {selectedPhones.length} números pertencem a mesma WABA. Se um número for bloqueado, todos podem ser afetados em cascata. Para maior segurança, use números de WABAs diferentes.
                      </p>
                    </div>
                  </div>
                )}
                {selectedPhones.length > 0 && (
                  <div className="saas-card p-5">
                    <div className="text-center">
                      <div className="text-4xl font-bold text-[#1A202C]">{selectedPhones.length}</div>
                      <div className="text-xs text-[#718096] mt-1">Números Selecionados</div>
                    </div>
                    <div className="mt-4 pt-4 border-t border-[#E2E8F0] flex items-center justify-between text-sm">
                      <span className="text-[#718096]">Capacidade estimada</span>
                      <span className="text-[#0066FF] font-semibold">{(selectedPhones.length * 2000).toLocaleString()}/dia</span>
                    </div>
                  </div>
                )}

                <div className={`saas-card p-4 ${
                  selectedPhones.length >= 10 ? 'border-slate-200 bg-slate-50' : 
                  selectedPhones.length >= 5 ? 'border-slate-200 bg-slate-50' : 
                  selectedPhones.length >= 2 ? 'border-slate-200 bg-slate-50' : ''
                }`}>
                  <div className="flex items-center gap-2 mb-3">
                    <Target size={14} className="text-[#718096]" />
                    <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider">Estratégia Multi-Números</span>
                  </div>
                  <div className="space-y-2">
                    {[
                      { min: 1, label: 'Básico', desc: 'Limite diário restrito', color: 'text-[#A0AEC0]' },
                      { min: 3, label: 'Distribuído', desc: 'Rotação entre números', color: 'text-[#0066FF]' },
                      { min: 5, label: 'Balanceado', desc: 'Distribuição por qualidade', color: 'text-slate-600' },
                      { min: 10, label: 'Alta Capacidade', desc: 'Volume máximo disponível', color: 'text-[#38A169]' },
                    ].map(tier => (
                      <div key={tier.min} className={`flex items-center gap-2 text-xs ${selectedPhones.length >= tier.min ? tier.color + ' font-semibold' : 'text-[#CBD5E0]'}`}>
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${selectedPhones.length >= tier.min ? 'bg-current' : 'bg-[#E2E8F0]'}`} />
                        <span>{tier.min}+ num: {tier.label}</span>
                      </div>
                    ))}
                  </div>
                  {selectedPhones.length > 0 && selectedPhones.length < 3 && (
                    <p className="text-[10px] text-[#A0AEC0] mt-3 border-t border-[#E2E8F0] pt-2">
                      Selecione mais números para ativar rotação automática e distribuição inteligente.
                    </p>
                  )}
                </div>

                {selectedPhones.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPhones(phoneNumbers.map(p => p.id));
                    }}
                    className="w-full text-xs text-[#0066FF] hover:text-[#0052CC] font-medium py-2 rounded-lg border border-[#0066FF]/20 hover:bg-[#EBF4FF] transition-all"
                  >
                    Selecionar Todos ({phoneNumbers.length})
                  </button>
                )}
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <Button 
                onClick={() => setCurrentStep(2)}
                variant="ghost"
                className="text-[#718096] hover:text-[#1A202C]"
              >
                <ArrowLeft size={16} className="mr-2" /> Voltar
              </Button>
              <Button 
                onClick={() => setCurrentStep(4)}
                disabled={!canProceedToStep4}
                className="bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold px-6 disabled:opacity-20"
              >
                Próximo <ArrowRight size={16} className="ml-2" />
              </Button>
            </div>
          </div>
        )}

        {currentStep === 4 && isConnected && (
          <div className="max-w-2xl mx-auto">
            <div className="saas-card p-6">
              <div className="mb-5">
                <h2 className="text-lg font-semibold text-[#1A202C]">Importar Leads</h2>
                <p className="text-xs text-[#718096] mt-0.5">Cole os dados dos contatos (Numero, Nome, CPF)</p>
              </div>
              
              <div className="space-y-4">
                <Textarea
                  value={leadsText}
                  onChange={(e) => setLeadsText(e.target.value)}
                  placeholder={"numero,nome,cpf\n5511999998888,João Silva,123.456.789-00\n5511999997777,Maria Santos,987.654.321-00"}
                  className="min-h-[260px] bg-white border-[#E2E8F0] text-[#1A202C] placeholder:text-[#A0AEC0] font-mono text-sm resize-none focus:border-[#0066FF]"
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-[#A0AEC0]">Formato: numero,nome,cpf (um por linha)</p>
                  <Button 
                    onClick={handleValidateLeads}
                    disabled={validateLeadsMutation.isPending || !leadsText.trim()}
                    className="bg-[#F7FAFC] hover:bg-[#EDF2F7] text-[#1A202C] border border-[#E2E8F0]"
                  >
                    {validateLeadsMutation.isPending ? (
                      <><RefreshCw className="mr-2 animate-spin" size={16} /> Processando...</>
                    ) : (
                      <><Upload className="mr-2" size={16} /> Processar</>
                    )}
                  </Button>
                </div>

                {validationSummary && (
                  <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    <div className="text-center p-4 saas-card-secondary rounded-xl">
                      <div className="text-2xl font-bold text-[#1A202C]">{validationSummary.total}</div>
                      <div className="text-xs text-[#718096] mt-1">Total</div>
                    </div>
                    <div className="text-center p-4 rounded-xl border border-slate-200 bg-slate-50">
                      <div className="text-2xl font-bold text-[#1A202C]">{validationSummary.valid}</div>
                      <div className="text-xs text-[#718096] mt-1">Válidos</div>
                    </div>
                    <div className="text-center p-4 rounded-xl border border-red-200 bg-red-50">
                      <div className="text-2xl font-bold text-[#E53E3E]">{validationSummary.invalid}</div>
                      <div className="text-xs text-[#E53E3E]/70 mt-1">Inválidos</div>
                    </div>
                  </div>
                )}

                {invalidLeads.length > 0 && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                    <p className="text-xs font-medium text-red-600 mb-2">Problemas encontrados:</p>
                    <div className="text-xs text-red-600/70 space-y-1 max-h-24 overflow-y-auto font-mono">
                      {invalidLeads.slice(0, 3).map((lead, i) => (
                        <p key={i}>{lead.line}: {lead.errors.join(', ')}</p>
                      ))}
                      {invalidLeads.length > 3 && <p className="text-red-600">+ {invalidLeads.length - 3} outros</p>}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <Button 
                onClick={() => setCurrentStep(3)}
                variant="ghost"
                className="text-[#718096] hover:text-[#1A202C]"
              >
                <ArrowLeft size={16} className="mr-2" /> Voltar
              </Button>
              <Button 
                onClick={() => setCurrentStep(5)}
                disabled={!canProceedToStep5}
                className="bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold px-6 disabled:opacity-20"
              >
                Próximo <ArrowRight size={16} className="ml-2" />
              </Button>
            </div>
          </div>
        )}

        {currentStep === 5 && isConnected && (
          <div className="max-w-2xl mx-auto">
            <div className="saas-card p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-lg font-semibold text-[#1A202C]">Selecionar Templates</h2>
                  <p className="text-xs text-[#718096] mt-0.5">{approvedTemplates.length} aprovados pela Meta</p>
                </div>
                <Button 
                  onClick={() => syncTemplatesMutation.mutate()} 
                  variant="ghost" 
                  size="sm"
                  disabled={syncTemplatesMutation.isPending}
                  className="text-[#718096] hover:text-[#1A202C] hover:bg-[#F7FAFC]"
                >
                  <RefreshCw size={14} className={syncTemplatesMutation.isPending ? 'animate-spin' : ''} />
                </Button>
              </div>

              {selectedTemplates.length > 0 && (
                <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded-xl border bg-slate-50 border-slate-200">
                  {selectedTemplates.length >= 3 ? (
                    <ShieldCheck size={14} className="text-slate-500 flex-shrink-0" />
                  ) : (
                    <AlertTriangle size={14} className="text-slate-400 flex-shrink-0" />
                  )}
                  <span className="text-xs text-slate-500">
                    {selectedTemplates.length >= 3 
                      ? `${selectedTemplates.length} templates selecionados — rotação anti-spam ativa` 
                      : selectedTemplates.length >= 2 
                        ? `${selectedTemplates.length} templates — selecione 3-5 para melhor proteção` 
                        : '1 template — recomendamos 3-5 para evitar detecção de spam'}
                  </span>
                </div>
              )}
              
              {templatesLoading ? (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw className="animate-spin text-[#A0AEC0]" size={28} />
                </div>
              ) : approvedTemplates.length === 0 ? (
                <div className="text-center py-16">
                  <MessageSquare className="mx-auto mb-3 text-[#CBD5E0]" size={40} />
                  <p className="text-[#718096] mb-4">Nenhum template aprovado</p>
                  <Button onClick={() => syncTemplatesMutation.mutate()} variant="outline" size="sm" className="border-[#E2E8F0] text-[#718096]">
                    <RefreshCw size={14} className="mr-2" /> Sincronizar
                  </Button>
                </div>
              ) : (
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                  {approvedTemplates.map((template) => {
                    const isSelected = selectedTemplates.includes(template.name);
                    const selIndex = selectedTemplates.indexOf(template.name);
                    return (
                      <div 
                        key={template.id}
                        onClick={() => handleTemplateSelection(template.name, !isSelected)}
                        className={`flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-all duration-150 ${
                          isSelected
                            ? 'border-[#0066FF]/30 bg-[#EBF4FF]'
                            : 'border-[#E2E8F0] bg-white hover:border-[#CBD5E0]'
                        }`}
                      >
                        <Checkbox
                          checked={isSelected}
                          className="border-[#CBD5E0] data-[state=checked]:bg-[#0066FF] data-[state=checked]:border-[#0066FF]"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-[#1A202C] block truncate">{template.name}</span>
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#EDF2F7] text-[#718096] border border-[#E2E8F0]">
                              {template.category === 'MARKETING' ? 'Marketing' : template.category === 'UTILITY' ? 'Utilidade' : template.category}
                            </span>
                            <span className="text-xs text-[#A0AEC0]">{template.language}</span>
                          </div>
                        </div>
                        {isSelected && (
                          <span className="text-xs font-bold text-[#0066FF] bg-[#0066FF]/10 w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0">
                            {selIndex + 1}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedTemplates.length > 1 && (
                <div className="mt-4 space-y-3">
                  <div className="p-3 rounded-xl bg-[#F7FAFC] border border-[#E2E8F0]">
                    <div className="flex items-center gap-2 mb-2">
                      <RefreshCw size={12} className="text-[#718096]" />
                      <span className="text-xs font-medium text-[#718096]">Pesos de Rotação</span>
                    </div>
                    <p className="text-[11px] text-[#A0AEC0] mb-3">
                      Configure a probabilidade de cada template ser usado. Pesos maiores = mais frequente.
                    </p>
                    <div className="space-y-2">
                      {selectedTemplates.map((name) => {
                        const weight = templateWeights[name] ?? Math.round(100 / selectedTemplates.length);
                        return (
                          <div key={name} className="flex items-center gap-3">
                            <span className="text-xs text-[#1A202C] flex-1 truncate">{name}</span>
                            <div className="flex items-center gap-1.5">
                              <input
                                type="number"
                                min={1}
                                max={100}
                                value={weight}
                                onChange={(e) => {
                                  const val = Math.max(1, Math.min(100, parseInt(e.target.value) || 1));
                                  setTemplateWeights(prev => ({ ...prev, [name]: val }));
                                }}
                                className="w-14 px-2 py-1 text-xs border border-[#E2E8F0] rounded-lg text-center font-semibold text-[#1A202C] focus:outline-none focus:ring-1 focus:ring-[#0066FF]"
                              />
                              <span className="text-[10px] text-[#A0AEC0]">%</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {(() => {
                      const total = selectedTemplates.reduce((sum, name) => sum + (templateWeights[name] ?? Math.round(100 / selectedTemplates.length)), 0);
                      return total !== 100 ? (
                        <p className="text-[10px] text-orange-500 mt-2 flex items-center gap-1">
                          <AlertTriangle size={10} /> Total: {total}% (recomendado: 100%)
                        </p>
                      ) : (
                        <p className="text-[10px] text-green-600 mt-2 flex items-center gap-1">
                          <Check size={10} /> Total: 100%
                        </p>
                      );
                    })()}
                  </div>
                  {selectedTemplates.length < 3 && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200">
                      <AlertTriangle size={12} className="text-slate-400 flex-shrink-0" />
                      <span className="text-[11px] text-slate-500">
                        Recomendamos usar 3+ templates para reduzir risco de detecção de spam.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-between mt-6">
              <Button 
                onClick={() => setCurrentStep(4)}
                variant="ghost"
                className="text-[#718096] hover:text-[#1A202C]"
              >
                <ArrowLeft size={16} className="mr-2" /> Voltar
              </Button>
              <Button 
                onClick={() => setCurrentStep(6)}
                disabled={!canProceedToStep6}
                className="bg-[#0066FF] hover:bg-[#0052CC] text-white font-semibold px-6 disabled:opacity-20"
              >
                Configurar Envio <ArrowRight size={16} className="ml-2" />
              </Button>
            </div>
          </div>
        )}

        {currentStep === 6 && isConnected && (
          <div className="max-w-4xl mx-auto">
            
            <div className="saas-card p-4 sm:p-6 lg:p-8 mb-4 sm:mb-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[#1A202C]">
                    {dispatchProgress ? 'Disparo em Andamento' : 'Resumo do Disparo'}
                  </h2>
                  <p className="text-sm text-[#718096] mt-0.5">
                    {dispatchProgress ? 'Monitoramento em tempo real' : 'Revise os dados e inicie o envio'}
                  </p>
                </div>
                {!dispatchProgress && (
                  <span className="text-xs font-medium text-[#718096] bg-[#EDF2F7] px-3 py-1.5 rounded-lg border border-[#E2E8F0]">
                    Pronto para envio
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
                <div className="text-center p-3 sm:p-4 saas-card-secondary rounded-xl">
                  <div className="text-2xl sm:text-3xl font-bold text-[#1A202C]">{validatedLeads.length.toLocaleString()}</div>
                  <div className="metric-label">Leads</div>
                </div>
                <div className="text-center p-3 sm:p-4 saas-card-secondary rounded-xl">
                  <div className="text-2xl sm:text-3xl font-bold text-[#1A202C]">{selectedPhones.length}</div>
                  <div className="metric-label">Números</div>
                </div>
                <div className="text-center p-3 sm:p-4 saas-card-secondary rounded-xl">
                  <div className="text-2xl sm:text-3xl font-bold text-[#1A202C]">{selectedTemplates.length}</div>
                  <div className="metric-label">Templates</div>
                </div>
                <div className="text-center p-3 sm:p-4 saas-card-secondary rounded-xl">
                  <div className="text-2xl sm:text-3xl font-bold text-[#0066FF]">{calculateEstimatedTime()}</div>
                  <div className="metric-label">Estimativa</div>
                </div>
              </div>

              {!dispatchProgress && (
                <>
                  <div className="mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Gauge size={16} className="text-[#718096]" />
                      <span className="text-sm font-medium text-[#718096]">Velocidade de Envio</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <button
                        onClick={() => setSpeedMode('SLOW')}
                        className={`rounded-xl border p-4 transition-all duration-150 text-left ${
                          speedMode === 'SLOW'
                            ? 'bg-[#EBF4FF] border-[#0066FF]/30'
                            : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E0]'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <Gauge size={16} className={speedMode === 'SLOW' ? 'text-[#0066FF]' : 'text-[#A0AEC0]'} />
                          <span className={`text-sm font-semibold ${speedMode === 'SLOW' ? 'text-[#0066FF]' : 'text-[#718096]'}`}>LENTO</span>
                        </div>
                        <p className="text-[11px] text-[#718096] leading-relaxed">Aquecimento de BM.</p>
                        <div className="mt-2 text-[10px] text-[#A0AEC0]">~15 msg/min</div>
                      </button>

                      <button
                        onClick={() => setSpeedMode('NORMAL')}
                        className={`relative rounded-xl border p-4 transition-all duration-150 text-left ${
                          speedMode === 'NORMAL'
                            ? 'bg-slate-50 border-[#0066FF]/30'
                            : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E0]'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <Gauge size={16} className={speedMode === 'NORMAL' ? 'text-[#0066FF]' : 'text-[#A0AEC0]'} />
                          <span className={`text-sm font-semibold ${speedMode === 'NORMAL' ? 'text-[#0066FF]' : 'text-[#718096]'}`}>NORMAL</span>
                        </div>
                        <p className="text-[11px] text-[#718096] leading-relaxed">Velocidade segura.</p>
                        <div className="mt-2 text-[10px] text-[#A0AEC0]">~30 msg/min</div>
                        {speedMode === 'NORMAL' && (
                          <div className="absolute -top-2 -right-2 bg-[#0066FF] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">PADRÃO</div>
                        )}
                      </button>

                      <button
                        onClick={() => setSpeedMode('FAST')}
                        className={`rounded-xl border p-4 transition-all duration-150 text-left ${
                          speedMode === 'FAST'
                            ? 'bg-slate-50 border-slate-300'
                            : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E0]'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <Gauge size={16} className={speedMode === 'FAST' ? 'text-slate-600' : 'text-[#A0AEC0]'} />
                          <span className={`text-sm font-semibold ${speedMode === 'FAST' ? 'text-slate-700' : 'text-[#718096]'}`}>RÁPIDO</span>
                        </div>
                        <p className="text-[11px] text-[#718096] leading-relaxed">Tier alto apenas.</p>
                        <div className="mt-2 text-[10px] text-[#A0AEC0]">~50 msg/min</div>
                      </button>
                    </div>
                    {speedMode === 'FAST' && (
                      <div className="flex items-center gap-2 mt-3">
                        <AlertTriangle size={13} className="text-slate-400" />
                        <span className="text-xs text-slate-500">Modo rápido requer tier alto. Em tier baixo, o motor limita automaticamente.</span>
                      </div>
                    )}
                  </div>

                  <div className="mb-6">
                    <div className="flex items-center gap-2 mb-3">
                      <Shield size={16} className="text-[#718096]" />
                      <span className="text-sm font-medium text-[#718096]">Estratégia de Entrega</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <button
                        onClick={() => setDeliveryStrategy('safe')}
                        className={`rounded-xl border p-4 transition-all duration-150 text-left ${
                          deliveryStrategy === 'safe'
                            ? 'bg-slate-50 border-[#0066FF]/30'
                            : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E0]'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <ShieldCheck size={16} className={deliveryStrategy === 'safe' ? 'text-[#0066FF]' : 'text-[#A0AEC0]'} />
                          <span className={`text-sm font-semibold ${deliveryStrategy === 'safe' ? 'text-[#0066FF]' : 'text-[#718096]'}`}>SEGURO</span>
                        </div>
                        <p className="text-[11px] text-[#718096] leading-relaxed">Horário comercial, pacing lento, protege qualidade.</p>
                        <div className="flex flex-wrap gap-1 mt-2">
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Opt-out</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Jitter</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Comercial</span>
                        </div>
                      </button>

                      <button
                        onClick={() => setDeliveryStrategy('balanced')}
                        className={`relative rounded-xl border p-4 transition-all duration-150 text-left ${
                          deliveryStrategy === 'balanced'
                            ? 'bg-[#EBF4FF] border-[#0066FF]/30'
                            : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E0]'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <Target size={16} className={deliveryStrategy === 'balanced' ? 'text-[#0066FF]' : 'text-[#A0AEC0]'} />
                          <span className={`text-sm font-semibold ${deliveryStrategy === 'balanced' ? 'text-[#0066FF]' : 'text-[#718096]'}`}>BALANCEADO</span>
                        </div>
                        <p className="text-[11px] text-[#718096] leading-relaxed">Distribuição adaptativa, velocidade automática.</p>
                        <div className="flex flex-wrap gap-1 mt-2">
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Adaptativo</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">RTT</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Anti-spam</span>
                        </div>
                        {deliveryStrategy === 'balanced' && (
                          <div className="absolute -top-2 -right-2 bg-[#0066FF] text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">PADRÃO</div>
                        )}
                      </button>

                      <button
                        onClick={() => setDeliveryStrategy('aggressive')}
                        className={`rounded-xl border p-4 transition-all duration-150 text-left ${
                          deliveryStrategy === 'aggressive'
                            ? 'bg-slate-50 border-slate-300'
                            : 'bg-white border-[#E2E8F0] hover:border-[#CBD5E0]'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <BarChart size={16} className={deliveryStrategy === 'aggressive' ? 'text-slate-600' : 'text-[#A0AEC0]'} />
                          <span className={`text-sm font-semibold ${deliveryStrategy === 'aggressive' ? 'text-slate-700' : 'text-[#718096]'}`}>ALTA VELOCIDADE</span>
                        </div>
                        <p className="text-[11px] text-[#718096] leading-relaxed">Envio simultâneo, multi-número, velocidade elevada.</p>
                        <div className="flex flex-wrap gap-1 mt-2">
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Paralelo</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Ponderado</span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">Veloz</span>
                        </div>
                      </button>
                    </div>
                    {deliveryStrategy === 'aggressive' && (
                      <div className="flex items-center gap-2 mt-3">
                        <AlertTriangle size={13} className="text-slate-400" />
                        <span className="text-xs text-slate-500">Alta velocidade pode impactar a qualidade da BM. Use com números de tier alto.</span>
                      </div>
                    )}
                  </div>

                  <div className="mb-6">
                    <div className="p-4 rounded-xl border border-[#E2E8F0] bg-white space-y-3">
                      <div className="text-sm font-medium text-[#1A202C] mb-1">Proteção e Engajamento</div>
                      
                      <ToggleSwitch
                        enabled={enableOptOutFilter}
                        onChange={setEnableOptOutFilter}
                        label="Filtro Opt-Out Automático"
                        description="Remove leads que já bloquearam ou deram opt-out"
                      />

                      <ToggleSwitch
                        enabled={enableFollowUp}
                        onChange={setEnableFollowUp}
                        label="Follow-Up Automático"
                        description="Envia mensagem de acompanhamento para quem não respondeu"
                      />

                      {enableFollowUp && (
                        <div className="ml-4 pl-4 border-l-2 border-[#0066FF]/20 space-y-2">
                          <textarea
                            value={followUpMessage}
                            onChange={(e) => setFollowUpMessage(e.target.value)}
                            placeholder="Mensagem de follow-up..."
                            rows={2}
                            className="w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 resize-none"
                          />
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-[#718096]">Enviar apos:</span>
                            <select
                              value={followUpDelayMinutes}
                              onChange={(e) => setFollowUpDelayMinutes(parseInt(e.target.value))}
                              className="text-xs border border-[#E2E8F0] rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
                            >
                              <option value={60}>1 hora</option>
                              <option value={360}>6 horas</option>
                              <option value={720}>12 horas</option>
                              <option value={1440}>24 horas</option>
                              <option value={2880}>48 horas</option>
                              <option value={4320}>72 horas</option>
                            </select>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mb-6">
                    <div className="p-4 rounded-xl border border-[#E2E8F0] bg-white">
                      <div className="text-sm font-medium text-[#1A202C] mb-3">Conversão Pós-Resposta (CSW)</div>
                      <div className="space-y-3">
                        <div>
                          <label className="text-[11px] text-[#718096] uppercase tracking-wider font-medium">Mensagem de conversão</label>
                          <textarea
                            value={conversionMessage}
                            onChange={(e) => setConversionMessage(e.target.value)}
                            placeholder="Ex: Obrigado por responder! Aproveite nossa oferta especial..."
                            rows={2}
                            className="mt-1 w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 resize-none"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[11px] text-[#718096] uppercase tracking-wider font-medium">Link (opcional)</label>
                            <input
                              type="text"
                              value={conversionLink}
                              onChange={(e) => setConversionLink(e.target.value)}
                              placeholder="https://..."
                              className="mt-1 w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
                            />
                          </div>
                          <div>
                            <label className="text-[11px] text-[#718096] uppercase tracking-wider font-medium">Delay (ms)</label>
                            <input
                              type="number"
                              value={conversionDelayMs}
                              onChange={(e) => setConversionDelayMs(Math.max(0, parseInt(e.target.value) || 0))}
                              min={0}
                              max={300000}
                              className="mt-1 w-full px-3 py-2 text-sm border border-[#E2E8F0] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
                            />
                          </div>
                        </div>
                        {conversionMessage.trim() && (
                          <div className="text-[10px] text-[#38A169]">
                            Mensagem de conversão será enviada {conversionDelayMs}ms após resposta do lead dentro da janela CSW de 24h
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {campaignId && (
                    <div className="mb-6">
                      <div className="p-4 rounded-xl border border-[#E2E8F0] bg-white">
                        <BotFlowEditor campaignId={campaignId} />
                      </div>
                    </div>
                  )}

                  {validatedLeads.length > 0 && selectedPhones.length > 0 && (
                    <div className="flex items-center gap-2 mb-4 px-3 py-2.5 bg-[#F7FAFC] rounded-xl border border-[#E2E8F0]">
                      <Clock size={14} className="text-[#718096] flex-shrink-0" />
                      <span className="text-xs text-[#718096]">Tempo estimado:</span>
                      <span className="text-xs font-semibold text-[#1A202C]">{estimatedTime.label}</span>
                      <span className="text-[10px] text-[#A0AEC0] ml-auto">
                        {validatedLeads.length} leads / {SPEED_RATES[speedMode]} msg/s x {selectedPhones.length} num
                      </span>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
                    <div className="saas-card-secondary rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Phone size={14} className="text-[#718096]" />
                        <span className="text-xs text-[#718096] uppercase tracking-wider font-medium">Números</span>
                      </div>
                      <div className="space-y-1">
                        {phoneNumbers.filter(p => selectedPhones.includes(p.id)).map(phone => (
                          <div key={phone.id} className="flex items-center gap-2 text-sm">
                            <div className={`w-1.5 h-1.5 rounded-full ${getQualityInfo(phone.quality_rating).dot}`} />
                            <span className="text-[#1A202C] truncate">{phone.display_phone_number}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="saas-card-secondary rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <MessageSquare size={14} className="text-[#718096]" />
                        <span className="text-xs text-[#718096] uppercase tracking-wider font-medium">Templates</span>
                      </div>
                      <div className="space-y-1">
                        {selectedTemplates.map(name => (
                          <div key={name} className="text-sm text-[#1A202C] truncate">{name}</div>
                        ))}
                      </div>
                    </div>
                    <div className="saas-card-secondary rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Activity size={14} className="text-[#718096]" />
                        <span className="text-xs text-[#718096] uppercase tracking-wider font-medium">Estratégia</span>
                      </div>
                      <div className="text-sm text-[#1A202C] font-semibold">
                        {deliveryStrategy === 'safe' ? 'Seguro' : deliveryStrategy === 'aggressive' ? 'Alta Velocidade' : 'Balanceado'}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {selectedTemplates.length > 1 && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                            {selectedTemplates.length} Templates
                          </span>
                        )}
                        {enableOptOutFilter && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                            Opt-Out
                          </span>
                        )}
                        {enableDomainRotation && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                            Domínios
                          </span>
                        )}
                        {enableTextVariations && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
                            Variações
                          </span>
                        )}
                        {(enableBurstMode || deliveryStrategy === 'aggressive') && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                            Simultâneo
                          </span>
                        )}
                        {enableFollowUp && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                            Follow-Up
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[#A0AEC0] mt-1">
                        {(selectedPhones.length * 2000).toLocaleString()} mensagens/dia
                      </div>
                    </div>
                  </div>

                  {wabaChecklist && (
                    <div className="mb-6 p-4 rounded-xl border border-[#E2E8F0] bg-white">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <ShieldCheck size={16} className={wabaChecklist.allOk ? 'text-[#38A169]' : 'text-[#718096]'} />
                          <span className="text-sm font-medium text-[#1A202C]">Pré-requisitos de Produção</span>
                        </div>
                        <button onClick={() => refetchChecklist()} className="text-xs text-[#718096] hover:text-[#1A202C] flex items-center gap-1">
                          <RefreshCw size={12} /> Atualizar
                        </button>
                      </div>
                      <div className="space-y-2">
                        {[
                          {
                            ok: wabaChecklist.items.wabaConnected,
                            label: 'WABA Conectada',
                            detail: wabaChecklist.items.wabaConnected ? 'Configuração validada' : 'Configure o token e o WABA ID na Etapa 1',
                          },
                          {
                            ok: wabaChecklist.items.tokenValid,
                            label: 'Token de Acesso',
                            detail: wabaChecklist.items.tokenValid ? 'Token configurado' : 'Token não encontrado — vá à Etapa 1',
                          },
                          {
                            ok: wabaChecklist.items.appSecretPresent,
                            label: 'App Secret',
                            detail: wabaChecklist.items.appSecretPresent ? 'Secret configurado' : 'App Secret ausente — necessário para segurança do webhook',
                          },
                          {
                            ok: wabaChecklist.items.subscribedApps,
                            label: 'Inscrição subscribed_apps',
                            detail: wabaChecklist.items.subscribedApps
                              ? `Inscrito em ${wabaChecklist.metadata.subscribedAppsAt ? new Date(wabaChecklist.metadata.subscribedAppsAt).toLocaleString('pt-BR') : '—'}`
                              : 'Aguardando inscrição automática (reinicie o servidor se persistir)',
                          },
                          {
                            ok: wabaChecklist.items.webhookReceived,
                            label: 'Webhook Recebido',
                            detail: wabaChecklist.items.webhookReceived
                              ? `Último recebido: ${wabaChecklist.metadata.lastWebhookAt ? new Date(wabaChecklist.metadata.lastWebhookAt).toLocaleString('pt-BR') : '—'}`
                              : 'Nenhum webhook recebido ainda',
                          },
                        ].map((item) => (
                          <div key={item.label} className="flex items-start gap-3 py-1.5">
                            {item.ok ? (
                              <CheckCircle size={16} className="text-[#38A169] flex-shrink-0 mt-0.5" />
                            ) : (
                              <XCircle size={16} className="text-[#E53E3E] flex-shrink-0 mt-0.5" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className={`text-sm font-medium ${item.ok ? 'text-[#1A202C]' : 'text-[#E53E3E]'}`}>{item.label}</div>
                              <div className="text-[11px] text-[#718096] mt-0.5">{item.detail}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      {!wabaChecklist.items.webhookReceived && (
                        <div className="mt-4 pt-3 border-t border-[#E2E8F0]">
                          <div className="flex items-center justify-between">
                            <div className="text-xs text-[#718096]">
                              {webhookTestStatus === 'waiting' && 'Aguardando mensagem de teste (60s)…'}
                              {webhookTestStatus === 'success' && 'Webhook recebido com sucesso!'}
                              {webhookTestStatus === 'timeout' && 'Tempo esgotado — nenhum webhook recebido.'}
                              {webhookTestStatus === 'idle' && 'Envie uma mensagem para o número da WABA para testar o webhook.'}
                            </div>
                            <button
                              onClick={startWebhookTest}
                              disabled={webhookTestStatus === 'waiting'}
                              className={`ml-3 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors flex-shrink-0 ${
                                webhookTestStatus === 'success'
                                  ? 'bg-[#38A169]/10 text-[#38A169] cursor-default'
                                  : webhookTestStatus === 'waiting'
                                  ? 'bg-[#718096]/10 text-[#718096] cursor-wait'
                                  : 'bg-[#0066FF]/10 text-[#0066FF] hover:bg-[#0066FF]/20'
                              }`}
                            >
                              {webhookTestStatus === 'waiting' ? (
                                <><Loader2 size={12} className="animate-spin" /> Aguardando…</>
                              ) : webhookTestStatus === 'success' ? (
                                <><CheckCircle size={12} /> Recebido!</>
                              ) : (
                                <><Wifi size={12} /> Testar Webhook</>
                              )}
                            </button>
                          </div>
                        </div>
                      )}
                      {wabaChecklist.allOk && (
                        <div className="mt-3 pt-3 border-t border-[#E2E8F0] flex items-center gap-2">
                          <CheckCircle size={14} className="text-[#38A169]" />
                          <span className="text-xs font-semibold text-[#38A169]">Todos os pré-requisitos OK — pronto para disparar</span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-3">
                    <Button 
                      onClick={() => setCurrentStep(5)}
                      variant="ghost"
                      className="text-[#718096] hover:text-[#1A202C] min-h-[44px]"
                    >
                      <ArrowLeft size={16} className="mr-2" /> Voltar
                    </Button>
                    <Button 
                      onClick={handleStartDispatch}
                      disabled={startDispatchMutation.isPending}
                      className="h-12 px-6 sm:px-10 bg-[#38A169] hover:bg-[#2F855A] text-white text-base font-bold transition-colors min-h-[44px]"
                    >
                      {startDispatchMutation.isPending ? (
                        <><RefreshCw className="mr-2 animate-spin" size={20} /> Iniciando...</>
                      ) : (
                        <><Play className="mr-2" size={20} /> Iniciar Disparo</>
                      )}
                    </Button>
                  </div>
                </>
              )}
            </div>

            {dispatchProgress && campaignId && (
              <SimpleCampaignStatus 
                campaignId={campaignId} 
                onNewCampaign={handleNewCampaign}
                isRunning={dispatchProgress?.isRunning}
                speedMode={speedMode}
                templateName={selectedTemplates[0]}
                totalLeads={validatedLeads.length}
                activePhones={selectedPhones.length}
              />
            )}

            {campaignId && <DeliveryStatsCard campaignId={campaignId} />}
          </div>
        )}

      </div>
    </div>
  );
}