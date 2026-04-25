import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft, ChevronRight, Check, Phone, MessageSquare, Bot, Users, Settings,
  Save, Loader2, ArrowLeft, Image, Shield, CheckCircle, AlertCircle, Building2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ImageTemplateField } from "@shared/schema";
import { createDefaultImageField, detectTemplateParams, type ProcessedLead } from "@/components/wizard/types";
import {
  Step1Integration, Step2WabaSelection, Step3Numbers, Step4Contacts,
  Step5Templates, Step6Image, Step7Bot, Step8Strategy,
} from "@/components/wizard";
import Step8Review from "@/components/wizard/Step9Review";
import type { DiscoveredWaba, SelectedWaba } from "@/components/wizard";
import type { SavedAppConfig } from "@/components/wizard/Step2Integration";

const STEPS = [
  { id: 1, label: "Integrações", icon: Shield, desc: "Credenciais e segurança" },
  { id: 2, label: "WABA", icon: Building2, desc: "Seleção de WABAs" },
  { id: 3, label: "Números", icon: Phone, desc: "Números de disparo" },
  { id: 4, label: "Contatos", icon: Users, desc: "Lista de leads" },
  { id: 5, label: "Templates", icon: MessageSquare, desc: "Templates e conversão" },
  { id: 6, label: "Bot", icon: Bot, desc: "Automação e respostas" },
  { id: 7, label: "Mídia/Envio", icon: Settings, desc: "Imagem e estratégia" },
  { id: 8, label: "Revisão", icon: CheckCircle, desc: "Confirmar e iniciar" },
];

export default function CampaignWizardPage() {
  const [, params] = useRoute("/campaigns/:id/wizard");
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const campaignId = params?.id;

  const [currentStep, setCurrentStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [stepValidationErrors, setStepValidationErrors] = useState<string[]>([]);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isTestMode, setIsTestMode] = useState(false);

  const [bmId, setBmId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [verifyTokenLoading, setVerifyTokenLoading] = useState(false);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [discoveredWabas, setDiscoveredWabas] = useState<DiscoveredWaba[]>([]);
  const [manualWabaLoading, setManualWabaLoading] = useState(false);
  const [manualWabaError, setManualWabaError] = useState("");
  const [selectedWabas, setSelectedWabas] = useState<SelectedWaba[]>([]);

  const [selectedNumbers, setSelectedNumbers] = useState<any[]>([]);
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([]);
  const [automationEnabled, setAutomationEnabled] = useState(false);
  const [automationFallback, setAutomationFallback] = useState("silence");
  const [cswFallbackDefault, setCswFallbackDefault] = useState("text_only");
  const [botFallbackMessage, setBotFallbackMessage] = useState("");
  const [botRules, setBotRules] = useState<Array<{ keyword: string; response: string; responseType: string; mediaUrl: string }>>([]);
  const [leadListId, setLeadListId] = useState("");
  const [contactInputMode, setContactInputMode] = useState<"list" | "paste" | "file">("list");
  const [pastedNumbers, setPastedNumbers] = useState("");
  const [processedLeads, setProcessedLeads] = useState<{ total: number; valid: ProcessedLead[]; duplicates: number; invalid: number; errors: string[] } | null>(null);
  const [directLeads, setDirectLeads] = useState<ProcessedLead[]>([]);
  const [creatingLeadList, setCreatingLeadList] = useState(false);

  const [templateParams, setTemplateParams] = useState<Record<string, Record<string, string>>>({});
  const [rotationMode, setRotationMode] = useState<"sequential" | "distributed">("sequential");
  const [templatePreviewId, setTemplatePreviewId] = useState<string | null>(null);

  const [sendSpeed, setSendSpeed] = useState("normal");
  const [burstMode, setBurstMode] = useState(false);
  const [dispatchMode, setDispatchMode] = useState<string>("equilibrado");
  const [businessHoursOnly, setBusinessHoursOnly] = useState(false);
  const [businessHoursStart, setBusinessHoursStart] = useState(8);
  const [businessHoursEnd, setBusinessHoursEnd] = useState(20);
  const [scheduledAt, setScheduledAt] = useState("");
  const [conversionMessage, setConversionMessage] = useState("");
  const [conversionLink, setConversionLink] = useState("");
  const [conversionDelayMs, setConversionDelayMs] = useState(5000);

  const [usePackageImage, setUsePackageImage] = useState(false);
  const [customImageTemplateId, setCustomImageTemplateId] = useState("");
  const [imageTemplates, setImageTemplates] = useState<Array<{ id: string; name: string; baseImageUrl: string; width: number; height: number; fields?: ImageTemplateField[] }>>([]);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [imagePreviewLoading, setImagePreviewLoading] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);

  const [editorFields, setEditorFields] = useState<ImageTemplateField[]>([]);
  const [editorSelectedFieldId, setEditorSelectedFieldId] = useState<string | null>(null);
  const [editorDragging, setEditorDragging] = useState<{ fieldId: string; offsetX: number; offsetY: number } | null>(null);
  const [editorImgDims, setEditorImgDims] = useState({ width: 0, height: 0 });
  const [editorRenderedDims, setEditorRenderedDims] = useState({ width: 0, height: 0 });
  const [editorSaving, setEditorSaving] = useState(false);

  const [campaignAudioUrl, setCampaignAudioUrl] = useState("");
  const [campaignAudioEnabled, setCampaignAudioEnabled] = useState(false);

  const [firstResponseButtons, setFirstResponseButtons] = useState<Array<{ id: string; title: string; nextNodeId?: string }>>([]);
  const [firstResponseBodyText, setFirstResponseBodyText] = useState("Selecione uma opção:");

  const [webhookCopied, setWebhookCopied] = useState(false);
  const [webhookTesting, setWebhookTesting] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [webhookInstructionsOpen, setWebhookInstructionsOpen] = useState(false);

  const { toast } = useToast();

  const { data: campaign, isLoading: campaignLoading } = useQuery({
    queryKey: ["/api/campaigns/managed", campaignId],
    queryFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}`);
      if (!res.ok) throw new Error("Campanha não encontrada");
      return res.json();
    },
    enabled: !!campaignId,
  });

  const { data: wabas = [] } = useQuery({
    queryKey: ["/api/wabas"],
    queryFn: async () => {
      const res = await fetch("/api/wabas");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: savedAppConfigs = [] } = useQuery<SavedAppConfig[]>({
    queryKey: ["/api/wabas/app-configs"],
    queryFn: async () => {
      const res = await fetch("/api/wabas/app-configs");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const [selectedAppConfigIndex, setSelectedAppConfigIndex] = useState<number | null>(null);

  const [wabaNumberGroups, setWabaNumberGroups] = useState<Array<{
    wabaId: string;
    wabaLabel: string;
    numbers: any[];
    loading: boolean;
  }>>([]);

  useEffect(() => {
    if (selectedWabas.length === 0) {
      setWabaNumberGroups([]);
      return;
    }

    const fetchNumbers = async () => {
      const groups = selectedWabas.map((sw) => ({
        wabaId: sw.wabaId,
        wabaLabel: sw.label,
        numbers: [] as any[],
        loading: true,
      }));
      setWabaNumberGroups(groups);

      const updatedGroups = await Promise.all(
        selectedWabas.map(async (sw) => {
          const registeredWaba = wabas.find((w: any) => w.wabaId === sw.wabaId || w.id === sw.wabaId);
          const id = registeredWaba?.id || sw.wabaId;
          try {
            const res = await fetch(`/api/wabas/${id}/numbers`);
            if (!res.ok) return { wabaId: sw.wabaId, wabaLabel: sw.label, numbers: [], loading: false };
            const nums = await res.json();
            return { wabaId: sw.wabaId, wabaLabel: sw.label, numbers: nums, loading: false };
          } catch {
            return { wabaId: sw.wabaId, wabaLabel: sw.label, numbers: [], loading: false };
          }
        })
      );
      setWabaNumberGroups(updatedGroups);
    };

    fetchNumbers();
  }, [selectedWabas, wabas]);

  const [templates, setTemplates] = useState<any[]>([]);

  useEffect(() => {
    if (selectedWabas.length === 0) {
      setTemplates([]);
      return;
    }

    let cancelled = false;

    const fetchAllTemplates = async () => {
      const results = await Promise.all(
        selectedWabas.map(async (sw) => {
          const registered = wabas.find((w: any) => w.wabaId === sw.wabaId || w.id === sw.wabaId);
          const id = registered?.id || sw.wabaId;
          try {
            const res = await fetch(`/api/wabas/${id}/templates`);
            if (!res.ok) return [];
            const tpls = await res.json();
            return tpls.map((tpl: any) => ({ ...tpl, wabaId: sw.wabaId, wabaLabel: sw.label }));
          } catch {
            return [];
          }
        })
      );

      if (cancelled) return;

      const seen = new Set<string>();
      const merged: any[] = [];
      for (const list of results) {
        for (const tpl of list) {
          const key = `${tpl.wabaId ?? ""}::${tpl.name ?? tpl.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(tpl);
          }
        }
      }
      setTemplates(merged);
    };

    fetchAllTemplates();

    return () => { cancelled = true; };
  }, [selectedWabas, wabas]);

  const { data: leadLists = [] } = useQuery({
    queryKey: ["/api/lead-lists"],
    queryFn: async () => {
      const res = await fetch("/api/lead-lists");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: serverStatus } = useQuery<{
    webhookUrl: string;
    webhookWarning?: string | null;
  }>({
    queryKey: ["/api/server-status"],
    queryFn: async () => {
      const res = await fetch("/api/server-status");
      if (!res.ok) return { webhookUrl: "" };
      return res.json();
    },
    staleTime: 30000,
  });

  const generateVerifyToken = useCallback(async () => {
    setVerifyTokenLoading(true);
    try {
      const res = await fetch("/api/config/generate-verify-token", { method: "POST", headers: { "Content-Type": "application/json" } });
      if (res.ok) {
        const data = await res.json();
        if (data.webhookVerifyToken) {
          setVerifyToken(data.webhookVerifyToken);
        }
      }
    } catch {}
    setVerifyTokenLoading(false);
  }, []);

  const saveWebhookSecrets = useCallback(async () => {
    const configRes = await fetch("/api/config");
    if (!configRes.ok) throw new Error("Falha ao carregar configuração");
    const config = await configRes.json();
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        metaToken: config.metaToken || accessToken,
        whatsappBusinessId: config.whatsappBusinessId || "",
        appSecret: appSecret || undefined,
        webhookVerifyToken: config.webhookVerifyToken || verifyToken || undefined,
      }),
    });
    if (!res.ok) throw new Error("Falha ao salvar");
  }, [accessToken, appSecret, verifyToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const data = await res.json();
          if (data.webhookVerifyToken) {
            if (!cancelled) setVerifyToken(data.webhookVerifyToken);
          } else {
            if (!cancelled) {
              setVerifyTokenLoading(true);
              const genRes = await fetch("/api/config/generate-verify-token", { method: "POST", headers: { "Content-Type": "application/json" } });
              if (genRes.ok) {
                const genData = await genRes.json();
                if (!cancelled && genData.webhookVerifyToken) {
                  setVerifyToken(genData.webhookVerifyToken);
                }
              }
              if (!cancelled) setVerifyTokenLoading(false);
            }
          }
          if (data.appSecret && !cancelled) setAppSecret(data.appSecret);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (usePackageImage || currentStep === 6) {
      fetch("/api/image-templates")
        .then((r) => r.json())
        .then((data) => setImageTemplates(data || []))
        .catch(() => setImageTemplates([]));
    }
  }, [usePackageImage, currentStep]);

  useEffect(() => {
    if (customImageTemplateId) {
      const tpl = imageTemplates.find((t) => t.id === customImageTemplateId);
      if (tpl) {
        const existing = (tpl.fields || []) as ImageTemplateField[];
        if (existing.length > 0) {
          setEditorFields(existing);
        } else {
          setEditorFields([createDefaultImageField("name"), createDefaultImageField("cpf")]);
        }
        setEditorImgDims({ width: tpl.width, height: tpl.height });
        setEditorSelectedFieldId(null);
      }
    }
  }, [customImageTemplateId, imageTemplates]);

  const onDiscoverWabas = async () => {
    setDiscoverLoading(true);
    setDiscoverError("");
    try {
      const res = await fetch("/api/wabas/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bmId, accessToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDiscoverError(data.error || "Erro ao buscar WABAs");
        return;
      }
      if (!data.wabas || data.wabas.length === 0) {
        setDiscoverError("Nenhuma WABA encontrada neste Business Manager.");
        return;
      }
      setDiscoveredWabas(data.wabas);

      let registered = 0;
      for (const dw of data.wabas) {
        const alreadyRegistered = wabas.some((w: any) => w.wabaId === dw.wabaId);
        if (!alreadyRegistered) {
          try {
            const regRes = await fetch("/api/wabas", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: dw.wabaName,
                wabaId: dw.wabaId,
                bmId,
                accessToken,
                appSecret: appSecret || undefined,
              }),
            });
            if (regRes.ok) {
              const created = await regRes.json();
              await fetch(`/api/wabas/${created.id}/test`, { method: "POST" });
              registered++;
              if (created.subscriptionError) {
                toast({
                  title: "WABA registrada — Falha na inscrição",
                  description: `${dw.wabaName || dw.wabaId}: ${created.subscriptionError}`,
                  variant: "destructive",
                });
              }
            }
          } catch (regErr: any) {
            console.error(`[WabaAutoRegister] Failed to register WABA ${dw.wabaId}:`, regErr);
            toast({
              title: "Erro ao registrar WABA",
              description: `Não foi possível registrar ${dw.wabaName || dw.wabaId}: ${regErr?.message || "erro desconhecido"}`,
              variant: "destructive",
            });
          }
        }
      }

      if (registered > 0) {
        queryClient.invalidateQueries({ queryKey: ["/api/wabas"] });
        queryClient.invalidateQueries({ queryKey: ["/api/wabas/app-configs"] });
      }

      toast({ title: "WABAs encontradas", description: `${data.wabas.length} WABA(s) encontrada(s)${registered > 0 ? `, ${registered} registrada(s) automaticamente` : ""}. Selecione na próxima etapa.` });
    } catch (e: any) {
      setDiscoverError(e.message || "Erro inesperado ao buscar WABAs");
    } finally {
      setDiscoverLoading(false);
    }
  };

  const onManualWabaAdd = async (wabaId: string): Promise<{ registeredId?: string; phoneCount?: number } | void> => {
    setManualWabaLoading(true);
    setManualWabaError("");
    try {
      const res = await fetch("/api/wabas/validate-by-id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wabaId, accessToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setManualWabaError(data.error || "Erro ao validar WABA ID");
        return;
      }

      let registeredId: string | undefined;
      const existingWaba = wabas.find((w: any) => w.wabaId === wabaId);
      if (!existingWaba) {
        const regRes = await fetch("/api/wabas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `WABA ${wabaId}`,
            wabaId,
            bmId: bmId || undefined,
            accessToken,
            appSecret: appSecret || undefined,
          }),
        });
        if (regRes.ok) {
          const created = await regRes.json();
          registeredId = created.id;
          await fetch(`/api/wabas/${created.id}/test`, { method: "POST" });
          queryClient.invalidateQueries({ queryKey: ["/api/wabas"] });
          queryClient.invalidateQueries({ queryKey: ["/api/wabas/app-configs"] });
          if (created.subscriptionError) {
            toast({
              title: "WABA registrada — Falha na inscrição",
              description: `${wabaId}: ${created.subscriptionError}`,
              variant: "destructive",
            });
          }
        }
      } else {
        registeredId = existingWaba.id;
        await fetch(`/api/wabas/${existingWaba.id}/test`, { method: "POST" });
      }

      const newDiscovered: DiscoveredWaba = {
        wabaId,
        wabaName: `WABA ${wabaId}`,
        phoneCount: data.phoneCount || 0,
        status: "active",
      };
      setDiscoveredWabas(prev => {
        const exists = prev.some(w => w.wabaId === wabaId);
        return exists ? prev : [...prev, newDiscovered];
      });

      toast({ title: "WABA validada", description: `WABA ${wabaId} validada com sucesso. ${data.phoneCount} número(s) encontrado(s).` });
      return { registeredId, phoneCount: data.phoneCount || 0 };
    } catch (e: any) {
      setManualWabaError(e.message || "Erro inesperado ao validar WABA");
    } finally {
      setManualWabaLoading(false);
    }
  };

  const handleTestWebhook = async () => {
    setWebhookTesting(true);
    setWebhookTestResult(null);
    try {
      const res = await fetch("/api/webhook/test", { method: "POST" });
      const data = await res.json();
      setWebhookTestResult(data);
      if (data.success) {
        toast({ title: "Webhook OK", description: data.message });
      } else {
        toast({ title: "Falha no teste", description: data.error, variant: "destructive" });
      }
    } catch (e: any) {
      setWebhookTestResult({ success: false, error: e.message });
      toast({ title: "Erro", description: "Falha ao testar webhook", variant: "destructive" });
    } finally {
      setWebhookTesting(false);
    }
  };

  const handleSelectAppConfig = useCallback((config: SavedAppConfig, index: number) => {
    setSelectedAppConfigIndex(index);
    setAccessToken(config._accessToken);
    setBmId(config.bmId ?? "");
    setAppSecret(config.appSecret ?? "");
    setDiscoveredWabas([]);
    setDiscoverError("");
  }, []);

  const handleAddNewConfig = useCallback(() => {
    setSelectedAppConfigIndex(null);
    setAccessToken("");
    setBmId("");
    setAppSecret("");
    setDiscoveredWabas([]);
    setDiscoverError("");
  }, []);

  const handleSetSelectedWabas = useCallback(async (newWabas: SelectedWaba[]) => {
    const prevIds = new Set(selectedWabas.map(w => w.wabaId));
    const addedManual = newWabas.filter(w => w.source === "manual" && !prevIds.has(w.wabaId));

    setSelectedWabas(newWabas);

    for (const mw of addedManual) {
      const alreadyRegistered = wabas.some((w: any) => w.wabaId === mw.wabaId);
      if (!alreadyRegistered && accessToken) {
        try {
          const regRes = await fetch("/api/wabas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: mw.label,
              wabaId: mw.wabaId,
              bmId,
              accessToken,
              appSecret: appSecret || undefined,
            }),
          });
          if (regRes.ok) {
            const created = await regRes.json();
            queryClient.invalidateQueries({ queryKey: ["/api/wabas"] });
            queryClient.invalidateQueries({ queryKey: ["/api/wabas/app-configs"] });
            if (created.subscriptionError) {
              toast({
                title: "WABA registrada — Falha na inscrição",
                description: `${mw.label}: ${created.subscriptionError}`,
                variant: "destructive",
              });
            } else {
              toast({ title: "WABA registrada", description: `${mw.label} registrada automaticamente.` });
            }
          }
        } catch (err: any) {
          console.error(`[ManualWabaRegister] Failed to register ${mw.wabaId}:`, err);
          toast({
            title: "Erro ao registrar WABA manual",
            description: `${mw.label}: ${err?.message || "erro desconhecido"}`,
            variant: "destructive",
          });
        }
      }
    }
  }, [selectedWabas, wabas, accessToken, bmId, appSecret, queryClient, toast]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setWebhookCopied(true);
      setTimeout(() => setWebhookCopied(false), 2000);
      toast({ title: "Copiado", description: "Copiado para a área de transferência" });
    } catch {
      toast({ title: "Erro", description: "Não foi possível copiar", variant: "destructive" });
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append("name", `Wizard - ${name || "Campanha"}`);
      formData.append("image", file);
      formData.append("fields", JSON.stringify([
        { id: "name", label: "Nome", type: "name", defaultText: "MARIA OLIVEIRA SANTOS", x: 100, y: 100, fontSize: 20, fontFamily: "sans-serif", fontWeight: "bold", fontStyle: "normal", color: "#000000", opacity: 100, letterSpacing: 0, lineHeight: 1.2, rotation: 0, textAlign: "left", maxWidth: 400, textTransform: "uppercase", shadowEnabled: false, shadowColor: "#000000", shadowOffsetX: 2, shadowOffsetY: 2, shadowBlur: 4, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 1 },
        { id: "cpf", label: "CPF", type: "cpf", defaultText: "123.456.789-00", x: 100, y: 140, fontSize: 18, fontFamily: "sans-serif", fontWeight: "normal", fontStyle: "normal", color: "#000000", opacity: 100, letterSpacing: 0, lineHeight: 1.2, rotation: 0, textAlign: "left", maxWidth: 300, textTransform: "none", shadowEnabled: false, shadowColor: "#000000", shadowOffsetX: 2, shadowOffsetY: 2, shadowBlur: 4, strokeEnabled: false, strokeColor: "#000000", strokeWidth: 1 },
      ]));
      const img = new window.Image();
      const url = URL.createObjectURL(file);
      await new Promise<void>((resolve) => {
        img.onload = () => {
          formData.append("width", String(img.naturalWidth));
          formData.append("height", String(img.naturalHeight));
          resolve();
        };
        img.src = url;
      });
      URL.revokeObjectURL(url);

      const res = await fetch("/api/image-templates", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Erro ao salvar template de imagem");
      const saved = await res.json();
      setCustomImageTemplateId(saved.id);
      setImageTemplates((prev) => [...prev, saved]);
      toast({ title: "Imagem enviada", description: "Template de imagem criado. Posicione os campos no editor abaixo." });
    } catch (err: any) {
      toast({ title: "Erro ao enviar imagem", description: err.message, variant: "destructive" });
    } finally {
      setUploadingImage(false);
      if (e.target) e.target.value = "";
    }
  };

  const handlePreviewImage = async () => {
    if (!customImageTemplateId) return;
    setImagePreviewLoading(true);
    try {
      const url = `/api/package-image/preview?nome=MARIA+OLIVEIRA&cpf=12345678900&templateId=${customImageTemplateId}&t=${Date.now()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Erro ao gerar preview");
      const blob = await res.blob();
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
      setImagePreviewUrl(URL.createObjectURL(blob));
    } catch {
      toast({ title: "Erro", description: "Não foi possível gerar preview da imagem", variant: "destructive" });
    } finally {
      setImagePreviewLoading(false);
    }
  };

  const saveEditorFields = async () => {
    if (!customImageTemplateId || editorFields.length === 0) return;
    setEditorSaving(true);
    try {
      const formData = new FormData();
      formData.append("fields", JSON.stringify(editorFields));
      formData.append("width", String(editorImgDims.width));
      formData.append("height", String(editorImgDims.height));
      const tpl = imageTemplates.find((t) => t.id === customImageTemplateId);
      formData.append("name", tpl?.name || "Template");

      const res = await fetch(`/api/image-templates/${customImageTemplateId}`, {
        method: "PUT",
        body: formData,
      });
      if (!res.ok) throw new Error("Erro ao salvar posições");
      toast({ title: "Posições salvas", description: "Campos atualizados no template." });
      setImageTemplates((prev) =>
        prev.map((t) => (t.id === customImageTemplateId ? { ...t, fields: editorFields } : t))
      );
    } catch (err: any) {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    } finally {
      setEditorSaving(false);
    }
  };

  useEffect(() => {
    if (campaign) {
      setName(campaign.name || "");
      setDescription(campaign.description || "");
      setIsTestMode(campaign.isTestMode || false);

      const sendCfg = campaign.sendConfig as Record<string, any> || {};
      const campCfg = campaign.campaignConfig as Record<string, any> || {};

      if (campCfg.bmId) setBmId(campCfg.bmId);

      if (sendCfg.wabaConfigs && Array.isArray(sendCfg.wabaConfigs) && sendCfg.wabaConfigs.length > 0) {
        setSelectedWabas(sendCfg.wabaConfigs.map((wc: any) => ({
          wabaId: wc.wabaExternalId || wc.wabaId,
          label: wc.label || `WABA ${wc.wabaExternalId || wc.wabaId}`,
          phoneCount: wc.phoneNumbers?.length || 0,
          source: "discovered" as const,
        })));
        const restoredNumbers = sendCfg.wabaConfigs.flatMap((wc: any) =>
          (wc.phoneNumbers || []).map((pn: any) => ({ ...pn, wabaId: wc.wabaExternalId || wc.wabaId }))
        );
        if (restoredNumbers.length > 0) {
          setSelectedNumbers(restoredNumbers);
        }
      } else if (campaign.wabaId) {
        const registeredWaba = wabas.find((w: any) => w.id === campaign.wabaId);
        if (registeredWaba) {
          setSelectedWabas([{
            wabaId: registeredWaba.wabaId || registeredWaba.id,
            label: registeredWaba.name,
            phoneCount: 0,
            source: "discovered",
          }]);
        }
      }

      if (!sendCfg.wabaConfigs?.length && Array.isArray(campaign.selectedNumbers) && campaign.selectedNumbers.length > 0) {
        setSelectedNumbers(campaign.selectedNumbers);
      }
      setSelectedTemplates(Array.isArray(campaign.templateIds) ? campaign.templateIds : campaign.templateId ? [campaign.templateId] : []);
      setAutomationEnabled(campaign.automationEnabled || false);
      setAutomationFallback(campaign.automationFallback || "silence");
      const bc = campaign.botConfig as Record<string, unknown> | null;
      if (bc?.cswFallbackDefault && typeof bc.cswFallbackDefault === "string") {
        setCswFallbackDefault(bc.cswFallbackDefault);
      }
      if (bc?.fallbackMessage && typeof bc.fallbackMessage === "string") {
        setBotFallbackMessage(bc.fallbackMessage);
      } else {
        setBotFallbackMessage("");
      }
      setLeadListId(campaign.leadListId || "");
      setBurstMode(campaign.burstMode || false);
      if ((campaign as any).dispatchMode) setDispatchMode((campaign as any).dispatchMode);
      setBusinessHoursOnly(campaign.businessHoursOnly || false);
      setBusinessHoursStart(campaign.businessHoursStart || 8);
      setBusinessHoursEnd(campaign.businessHoursEnd || 20);
      setConversionMessage(campaign.conversionMessage || "");
      setConversionLink(campaign.conversionLink || "");
      setConversionDelayMs(campaign.conversionDelayMs || 5000);
      if (campaign.scheduledAt) setScheduledAt(new Date(campaign.scheduledAt).toISOString().slice(0, 16));
      if (sendCfg.speed) setSendSpeed(sendCfg.speed);
      if (campaign.automationRules) {
        setBotRules(campaign.automationRules.map((r: any) => ({
          keyword: r.keyword,
          response: r.response,
          responseType: r.responseType || "text",
          mediaUrl: r.mediaUrl || "",
        })));
      }
      if (campCfg) {
        if (campCfg.usePackageImage) setUsePackageImage(true);
        if (campCfg.customImageTemplateId) setCustomImageTemplateId(campCfg.customImageTemplateId);
        if (campCfg.templateParams) setTemplateParams(campCfg.templateParams);
        if (campCfg.rotationMode) setRotationMode(campCfg.rotationMode);
        if (campCfg.campaignAudioEnabled) setCampaignAudioEnabled(true);
        if (campCfg.campaignAudioUrl) setCampaignAudioUrl(campCfg.campaignAudioUrl);
        if (Array.isArray(campCfg.firstResponseButtons)) setFirstResponseButtons(campCfg.firstResponseButtons);
        if (campCfg.firstResponseBodyText) setFirstResponseBodyText(campCfg.firstResponseBodyText);
      }
    }
  }, [campaign, wabas]);

  useEffect(() => {
    if (campaign && templates.length > 0 && selectedTemplates.length > 0) {
      const findTpl = (selId: string) =>
        templates.find((t: any) => t.id === selId || t.templateId === selId || t.name === selId);
      const missingTemplates = selectedTemplates.filter(
        (selId: string) => !findTpl(selId)
      );
      if (missingTemplates.length > 0) {
        toast({
          title: "Templates indisponíveis",
          description: `${missingTemplates.length} template(s) selecionado(s) anteriormente não estão mais disponíveis na Meta. Revise a seleção de templates.`,
          variant: "destructive",
        });
        setSelectedTemplates((prev: string[]) => prev.filter(
          (selId: string) => findTpl(selId)
        ));
      }
    }
  }, [templates, campaign]);

  useEffect(() => {
    if (selectedNumbers.length > 0 && selectedWabas.length > 0) {
      const validWabaIds = new Set(selectedWabas.map(w => w.wabaId));
      const pruned = selectedNumbers.filter((n: any) => !n.wabaId || validWabaIds.has(n.wabaId));
      if (pruned.length !== selectedNumbers.length) {
        setSelectedNumbers(pruned);
      }
    } else if (selectedWabas.length === 0 && selectedNumbers.length > 0) {
      setSelectedNumbers([]);
    }
  }, [selectedWabas]);

  const saveSection = useCallback(async (section: string, data: any) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/${section}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        setLastSaved(new Date());
        queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] });
      }
    } finally {
      setSaving(false);
    }
  }, [campaignId, queryClient]);

  const getLatestSendConfig = useCallback(async (): Promise<Record<string, unknown>> => {
    try {
      const res = await fetch(`/api/campaigns/managed/${campaignId}`);
      if (res.ok) {
        const latest = await res.json();
        return (latest.sendConfig as Record<string, unknown>) || {};
      }
    } catch {}
    return (campaign?.sendConfig as Record<string, unknown>) || {};
  }, [campaignId, campaign]);

  const saveCurrentStep = useCallback(async () => {
    switch (currentStep) {
      case 1:
        await saveSection("send-config", {
          campaignConfig: {
            ...(campaign?.campaignConfig || {}),
            bmId,
          },
        });
        break;
      case 2:
        break;
      case 3: {
        const firstWaba = selectedWabas[0];
        const firstRegistered = firstWaba ? wabas.find((w: any) => w.wabaId === firstWaba.wabaId || w.id === firstWaba.wabaId) : undefined;
        const wabaId = firstRegistered?.id || firstWaba?.wabaId || "";
        const wabaConfigs = selectedWabas.map((sw) => {
          const registered = wabas.find((w: any) => w.wabaId === sw.wabaId || w.id === sw.wabaId);
          const numbersForWaba = selectedNumbers.filter((n: any) =>
            n.wabaId === sw.wabaId || (!n.wabaId && selectedWabas.length === 1)
          );
          return {
            wabaId: registered?.id || sw.wabaId,
            wabaExternalId: sw.wabaId,
            label: sw.label,
            phoneNumbers: numbersForWaba,
          };
        });
        await saveSection("waba", { wabaId, selectedNumbers });
        const latestSc3 = await getLatestSendConfig();
        await saveSection("send-config", {
          sendConfig: {
            ...latestSc3,
            wabaConfigs,
          },
        });
        break;
      }
      case 4:
        if (contactInputMode === "list") {
          await saveSection("contacts", { leadListId });
        } else if (directLeads.length > 0) {
          setCreatingLeadList(true);
          try {
            const res = await fetch("/api/lead-lists/create-direct", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: `${name || "Campanha"} - Leads colados`,
                leads: directLeads.map(l => ({
                  phone: l.phone,
                  name: l.name || null,
                  cpf: l.cpf || null,
                })),
              }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: "Erro ao criar lista" }));
              throw new Error(err.error || "Erro ao criar lista de leads");
            }
            const result = await res.json();
            setLeadListId(result.leadListId);
            await saveSection("contacts", { leadListId: result.leadListId, totalLeads: result.totalLeads });
          } finally {
            setCreatingLeadList(false);
          }
        }
        break;
      case 5:
        await saveSection("templates", { templateIds: selectedTemplates, templateId: selectedTemplates[0] || null });
        await saveSection("send-config", {
          conversionMessage,
          conversionLink,
          conversionDelayMs,
          campaignConfig: {
            ...(campaign?.campaignConfig || {}),
            templateParams,
            rotationMode,
            usePackageImage,
            customImageTemplateId: usePackageImage ? customImageTemplateId : null,
          },
        });
        break;
      case 6:
        await saveSection("bot", {
          automationEnabled,
          automationFallback,
          botConfig: {
            ...(campaign?.botConfig as Record<string, unknown> || {}),
            cswFallbackDefault,
            fallbackMessage: botFallbackMessage || undefined,
          },
          rules: botRules.map((r) => ({
            keyword: r.keyword,
            response: r.response,
            responseType: r.responseType || "text",
            mediaUrl: r.mediaUrl || undefined,
          })),
        });
        {
          const validButtons = firstResponseButtons.filter(b => b.title.trim());
          const latestForButtons = await fetch(`/api/campaigns/managed/${campaignId}`).then(r => r.ok ? r.json() : null).catch(() => null);
          const latestCampCfg = (latestForButtons?.campaignConfig || campaign?.campaignConfig || {}) as Record<string, unknown>;
          await saveSection("send-config", {
            campaignConfig: {
              ...latestCampCfg,
              firstResponseButtons: validButtons.length > 0 ? validButtons : undefined,
              firstResponseBodyText: validButtons.length > 0 ? firstResponseBodyText : undefined,
            },
          });
        }
        break;
      case 7: {
        const latestSc7 = await getLatestSendConfig();
        await saveSection("send-config", {
          sendConfig: {
            ...latestSc7,
            speed: sendSpeed,
          },
          burstMode,
          dispatchMode,
          businessHoursOnly,
          businessHoursStart,
          businessHoursEnd,
          scheduledAt: scheduledAt || null,
          campaignConfig: {
            ...(campaign?.campaignConfig || {}),
            templateParams,
            rotationMode,
            usePackageImage,
            customImageTemplateId: usePackageImage ? customImageTemplateId : null,
            campaignAudioEnabled,
            campaignAudioUrl: campaignAudioEnabled ? campaignAudioUrl : null,
          },
        });
        if (usePackageImage && customImageTemplateId && editorFields.length > 0) {
          await saveEditorFields();
        }
        break;
      }
      case 8:
        await saveSection("info", { name, description, isTestMode });
        break;
    }
  }, [currentStep, name, description, isTestMode, selectedWabas, selectedNumbers, selectedTemplates, automationEnabled, automationFallback, cswFallbackDefault, botFallbackMessage, botRules, leadListId, contactInputMode, directLeads, templateParams, rotationMode, sendSpeed, burstMode, businessHoursOnly, businessHoursStart, businessHoursEnd, scheduledAt, conversionMessage, conversionLink, conversionDelayMs, usePackageImage, customImageTemplateId, campaign, saveSection, campaignAudioEnabled, campaignAudioUrl, wabas, bmId, accessToken, appSecret, verifyToken, getLatestSendConfig, firstResponseButtons, firstResponseBodyText]);

  const validateStep = (step: number): string[] => {
    const errors: string[] = [];
    switch (step) {
      case 1:
        if (!accessToken.trim()) errors.push("Access Token é obrigatório.");
        if (!bmId.trim() && discoveredWabas.length === 0) errors.push("Informe o BM ID para buscar WABAs automaticamente, ou adicione um WABA ID manualmente.");
        break;
      case 2:
        if (selectedWabas.length === 0) errors.push("Selecione pelo menos uma WABA antes de avançar.");
        break;
      case 3:
        if (selectedWabas.length === 0) errors.push("Selecione uma WABA antes de avançar.");
        if (selectedNumbers.length === 0) errors.push("Selecione pelo menos um número para envio.");
        break;
      case 4:
        if (contactInputMode === "list" && !leadListId) errors.push("Selecione uma lista de contatos.");
        if (contactInputMode !== "list" && directLeads.length === 0) errors.push("Adicione contatos antes de avançar.");
        break;
      case 5:
        if (selectedTemplates.length === 0) errors.push("Selecione pelo menos um template.");
        for (const selId of selectedTemplates) {
          const tpl = templates.find((t: any) => t.id === selId || t.templateId === selId || t.name === selId);
          if (!tpl) continue;
          const params = detectTemplateParams(tpl.components || []);
          for (const p of params) {
            const val = templateParams[tpl.id]?.[p.key];
            if (!val || val.trim() === "") {
              errors.push(`Parâmetro ${p.section} {{${p.index}}} do template "${tpl.name}" está em branco. Digite o texto ou use {nome} / {cpf}.`);
            }
          }
        }
        break;
      case 6:
        if (automationEnabled && firstResponseButtons.length > 0) {
          const emptyTitleButtons = firstResponseButtons.filter(b => !b.title.trim());
          if (emptyTitleButtons.length > 0) {
            errors.push(`${emptyTitleButtons.length} botão(ões) de resposta rápida sem título. Preencha todos os títulos ou remova os botões vazios.`);
          }
        }
        if (automationEnabled && botRules.some(r => r.keyword && !r.response.trim())) {
          errors.push("Existem regras de bot com palavra-chave mas sem resposta definida. Preencha todas as respostas ou remova as regras incompletas.");
        }
        break;
      case 7:
        if (usePackageImage && !customImageTemplateId) {
          errors.push("Imagem personalizada ativada mas nenhum template de imagem selecionado. Selecione um template ou desative a imagem personalizada.");
        }
        break;
      case 8:
        if (!name.trim()) errors.push("Nome da campanha é obrigatório.");
        break;
    }
    return errors;
  };

  const goToStep = async (step: number) => {
    if (step > currentStep) {
      const requiredSteps = [1, 2, 3, 4, 5, 6, 7];
      for (const s of requiredSteps) {
        if (s > currentStep) break;
        if (s >= step) break;
        const priorErrors = validateStep(s);
        if (priorErrors.length > 0) {
          setStepValidationErrors(priorErrors);
          setCurrentStep(s);
          toast({ title: `Etapa ${s} incompleta`, description: priorErrors[0], variant: "destructive" });
          return;
        }
      }

      const errors = validateStep(currentStep);
      if (errors.length > 0) {
        setStepValidationErrors(errors);
        toast({ title: "Campos obrigatórios", description: errors[0], variant: "destructive" });
        return;
      }
    }
    setStepValidationErrors([]);

    if (step > 3 && selectedWabas.length === 0) {
      toast({ title: "WABA obrigatória", description: "Selecione pelo menos uma WABA na etapa de seleção antes de avançar.", variant: "destructive" });
      return;
    }

    if ((currentStep === 5 && step > 5) || step === 8) {
      if (selectedTemplates.length === 0 && step > 5) {
        toast({ title: "Templates obrigatórios", description: "Selecione pelo menos um template antes de avançar.", variant: "destructive" });
        return;
      }
      if (selectedTemplates.length > 0) {
        const findTpl = (selId: string) =>
          templates.find((t: any) => t.id === selId || t.templateId === selId || t.name === selId);
        const missingFromMeta = selectedTemplates.filter(
          (selId: string) => !findTpl(selId)
        );
        if (missingFromMeta.length > 0) {
          toast({ title: "Templates indisponíveis", description: `${missingFromMeta.length} template(s) selecionado(s) não foram encontrados. Revise a seleção de templates.`, variant: "destructive" });
          return;
        }
        const invalidTemplates = selectedTemplates.filter((selId: string) => {
          const tpl = findTpl(selId);
          return tpl && tpl.status !== "APPROVED";
        });
        if (invalidTemplates.length > 0) {
          const names = invalidTemplates.map((selId: string) => {
            const tpl = findTpl(selId);
            return tpl?.name || selId;
          }).join(", ");
          toast({ title: "Templates não aprovados", description: `Os seguintes templates não estão aprovados: ${names}. Remova-os antes de avançar.`, variant: "destructive" });
          return;
        }
      }
    }

    await saveCurrentStep();
    setCurrentStep(step);
  };

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/campaigns/managed/${campaignId}/start`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Falha ao iniciar" }));
        throw new Error(err.error || "Falha ao iniciar campanha");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/campaigns/managed", campaignId] });
      toast({ title: "Campanha iniciada!", description: "O envio foi iniciado com sucesso." });
      navigate(`/campaigns/${campaignId}`);
    },
    onError: (err: any) => {
      toast({ title: "Erro ao iniciar", description: err.message, variant: "destructive" });
    },
  });

  const handleFinish = async () => {
    await saveCurrentStep();
    navigate("/campaigns");
  };

  const handleStartCampaign = async () => {
    const errors: string[] = [];
    if (!name) errors.push("Nome da campanha é obrigatório.");
    if (selectedWabas.length === 0) errors.push("Selecione pelo menos uma WABA.");
    if (selectedNumbers.length === 0) errors.push("Selecione pelo menos um número de envio.");
    if (!leadListId && directLeads.length === 0) {
      errors.push("Adicione contatos na etapa de contatos.");
    } else if (leadListId && selectedLeadList) {
      const listCount = selectedLeadList.validLeads || selectedLeadList.totalLeads || 0;
      if (listCount === 0) errors.push("A lista de leads selecionada está vazia. Adicione contatos antes de iniciar.");
    }
    if (selectedTemplates.length === 0) {
      errors.push("Selecione pelo menos um template.");
    } else {
      const hasApproved = selectedTemplates.some((selId) => {
        const tpl = templates.find((t: any) => t.id === selId || t.templateId === selId || t.name === selId);
        if (!tpl) return true;
        return !tpl.status || tpl.status === "APPROVED" || tpl.status === "approved";
      });
      if (!hasApproved) {
        errors.push("Nenhum template selecionado está aprovado pela Meta. Sincronize os templates e aguarde aprovação antes de disparar.");
      }
    }

    if (errors.length > 0) {
      toast({
        title: "Configuração incompleta",
        description: errors.join(" "),
        variant: "destructive",
      });
      return;
    }

    await saveCurrentStep();

    try {
      const validateRes = await fetch(`/api/campaigns/managed/${campaignId}/validate`);
      if (!validateRes.ok) {
        toast({
          title: "Erro na validação",
          description: "Não foi possível validar a campanha. Tente novamente.",
          variant: "destructive",
        });
        return;
      }
      const validation = await validateRes.json();
      if (validation.errors && validation.errors.length > 0) {
        toast({
          title: "Configuração inválida",
          description: validation.errors.join(" "),
          variant: "destructive",
        });
        return;
      }
      if (validation.warnings && validation.warnings.length > 0) {
        for (const w of validation.warnings) {
          toast({
            title: "Aviso",
            description: w,
          });
        }
      }
    } catch (valErr) {
      console.warn("Pre-send validation failed:", valErr);
      toast({
        title: "Erro na validação",
        description: "Falha na comunicação com o servidor. Tente novamente.",
        variant: "destructive",
      });
      return;
    }

    const wabaConfigs = selectedWabas.map((sw) => {
      const registered = wabas.find((w: any) => w.wabaId === sw.wabaId || w.id === sw.wabaId);
      const numbersForWaba = selectedNumbers.filter((n: any) =>
        n.wabaId === sw.wabaId || (!n.wabaId && selectedWabas.length === 1)
      );
      return {
        wabaId: registered?.id || sw.wabaId,
        wabaExternalId: sw.wabaId,
        label: sw.label,
        phoneNumbers: numbersForWaba,
      };
    });
    const latestSc = await getLatestSendConfig();
    await saveSection("send-config", {
      sendConfig: { ...latestSc, wabaConfigs },
    });

    startMutation.mutate();
  };

  if (campaignLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const selectedLeadList = leadLists.find((l: any) => l.id === leadListId);
  const resolveTemplate = (selId: string) =>
    templates.find((t: any) => t.id === selId || t.templateId === selId || t.name === selId);
  const selectedTemplateNames = selectedTemplates.map((selId: string) => {
    const tpl = resolveTemplate(selId);
    return tpl ? tpl.name : selId;
  });
  const selectedImageTemplate = imageTemplates.find((t) => t.id === customImageTemplateId);

  const isStepComplete = (stepId: number): boolean => {
    switch (stepId) {
      case 1: return !!accessToken && (!!bmId || discoveredWabas.length > 0);
      case 2: return selectedWabas.length > 0;
      case 3: return selectedWabas.length > 0 && selectedNumbers.length > 0;
      case 4: return !!(leadListId || directLeads.length > 0);
      case 5: return selectedTemplates.length > 0;
      case 6: return !automationEnabled ||
        botRules.some(r => r.keyword && r.response) ||
        (firstResponseButtons.length > 0 && firstResponseButtons.every(b => b.title.trim() !== ""));
      case 7: return true;
      case 8: return !!name;
      default: return true;
    }
  };

  const getStepStatus = (stepId: number): "complete" | "incomplete" | "active" => {
    if (stepId === currentStep) return "active";
    return isStepComplete(stepId) ? "complete" : "incomplete";
  };

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-4 sm:space-y-6 pb-24 sm:pb-6">
      <div className="flex items-center gap-2 sm:gap-3">
        <Button variant="ghost" size="sm" className="min-h-[44px] px-2 sm:px-3" onClick={() => navigate("/campaigns")}>
          <ArrowLeft className="w-4 h-4 sm:mr-1" />
          <span className="hidden sm:inline">Voltar</span>
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base sm:text-xl font-bold truncate">{name || "Nova Campanha"}</h1>
          <p className="text-xs sm:text-sm text-muted-foreground hidden sm:block">Configuração da campanha</p>
        </div>
        <div className="flex items-center gap-2 text-xs sm:text-sm text-muted-foreground flex-shrink-0">
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {lastSaved && !saving && (
            <span className="flex items-center gap-1">
              <Save className="w-3 h-3" />
              <span className="hidden sm:inline">Salvo {lastSaved.toLocaleTimeString("pt-BR")}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-2 scrollbar-hide">
        {STEPS.map((step) => {
          const status = getStepStatus(step.id);
          const isRequired = [2, 3, 4, 5, 8].includes(step.id);
          const showAlert = status === "incomplete" && isRequired;
          return (
            <button
              key={step.id}
              onClick={() => goToStep(step.id)}
              className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 rounded-xl text-xs sm:text-sm whitespace-nowrap transition-all flex-shrink-0 min-h-[44px] ${
                status === "active"
                  ? "bg-[#0066FF] text-white shadow-md"
                  : status === "complete"
                  ? "bg-slate-50 text-slate-600 border border-slate-200"
                  : showAlert
                  ? "bg-slate-50 text-slate-500 border border-slate-200"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${
                status === "active"
                  ? "bg-white text-[#0066FF]"
                  : status === "complete"
                  ? "bg-slate-500 text-white"
                  : showAlert
                  ? "bg-slate-400 text-white"
                  : "bg-background text-muted-foreground"
              }`}>
                {status === "complete" ? <Check className="w-3 h-3" /> : showAlert ? <AlertCircle className="w-3 h-3" /> : step.id}
              </span>
              <span className="hidden sm:inline">{step.label}</span>
            </button>
          );
        })}
      </div>

      <Card className="shadow-sm border">
        <CardContent className="pt-6">
          {currentStep === 1 && (
            <Step1Integration
              bmId={bmId} setBmId={setBmId}
              accessToken={accessToken} setAccessToken={setAccessToken}
              discoverLoading={discoverLoading}
              discoverError={discoverError}
              discoveredCount={discoveredWabas.length > 0 ? discoveredWabas.length : null}
              onDiscoverWabas={onDiscoverWabas}
              manualWabaLoading={manualWabaLoading}
              manualWabaError={manualWabaError}
              onManualWabaAdd={onManualWabaAdd}
              serverStatus={serverStatus}
              webhookCopied={webhookCopied}
              webhookTesting={webhookTesting}
              webhookTestResult={webhookTestResult}
              handleTestWebhook={handleTestWebhook}
              copyToClipboard={copyToClipboard}
              webhookInstructionsOpen={webhookInstructionsOpen}
              setWebhookInstructionsOpen={setWebhookInstructionsOpen}
              appSecret={appSecret}
              setAppSecret={setAppSecret}
              verifyToken={verifyToken}
              verifyTokenLoading={verifyTokenLoading}
              onRegenerateVerifyToken={generateVerifyToken}
              onSaveSecrets={saveWebhookSecrets}
              validationErrors={stepValidationErrors}
              savedAppConfigs={savedAppConfigs}
              selectedAppConfigIndex={selectedAppConfigIndex}
              onSelectAppConfig={handleSelectAppConfig}
              onAddNewConfig={handleAddNewConfig}
            />
          )}

          {currentStep === 2 && (
            <Step2WabaSelection
              discoveredWabas={discoveredWabas}
              selectedWabas={selectedWabas}
              setSelectedWabas={handleSetSelectedWabas}
              registeredWabas={
                selectedAppConfigIndex !== null && savedAppConfigs[selectedAppConfigIndex]
                  ? wabas.filter((w: any) =>
                      savedAppConfigs[selectedAppConfigIndex].wabaIds.includes(w.wabaId)
                    )
                  : wabas
              }
              validationErrors={stepValidationErrors}
            />
          )}

          {currentStep === 3 && (
            <Step3Numbers
              selectedWabas={selectedWabas}
              wabaNumberGroups={wabaNumberGroups}
              selectedNumbers={selectedNumbers}
              setSelectedNumbers={setSelectedNumbers}
              setCurrentStep={setCurrentStep}
              validationErrors={stepValidationErrors}
            />
          )}

          {currentStep === 4 && (
            <Step4Contacts
              contactInputMode={contactInputMode} setContactInputMode={setContactInputMode}
              leadLists={leadLists} leadListId={leadListId} setLeadListId={setLeadListId}
              pastedNumbers={pastedNumbers} setPastedNumbers={setPastedNumbers}
              processedLeads={processedLeads} setProcessedLeads={setProcessedLeads}
              directLeads={directLeads} setDirectLeads={setDirectLeads}
              validationErrors={stepValidationErrors}
            />
          )}

          {currentStep === 5 && (
            <Step5Templates
              templates={templates}
              selectedTemplates={selectedTemplates} setSelectedTemplates={setSelectedTemplates}
              templateParams={templateParams} setTemplateParams={setTemplateParams}
              templatePreviewId={templatePreviewId} setTemplatePreviewId={setTemplatePreviewId}
              rotationMode={rotationMode} setRotationMode={setRotationMode}
              conversionMessage={conversionMessage} setConversionMessage={setConversionMessage}
              conversionLink={conversionLink} setConversionLink={setConversionLink}
              conversionDelayMs={conversionDelayMs} setConversionDelayMs={setConversionDelayMs}
              wabas={wabas}
              selectedWabas={selectedWabas}
              wabaNumberGroups={wabaNumberGroups}
              validationErrors={stepValidationErrors}
            />
          )}

          {currentStep === 6 && (
            <Step7Bot
              automationEnabled={automationEnabled} setAutomationEnabled={setAutomationEnabled}
              automationFallback={automationFallback} setAutomationFallback={setAutomationFallback}
              botRules={botRules} setBotRules={setBotRules}
              campaignId={campaignId}
              cswFallbackDefault={cswFallbackDefault} setCswFallbackDefault={setCswFallbackDefault}
              firstResponseButtons={firstResponseButtons}
              setFirstResponseButtons={setFirstResponseButtons}
              firstResponseBodyText={firstResponseBodyText}
              setFirstResponseBodyText={setFirstResponseBodyText}
              botFallbackMessage={botFallbackMessage}
              setBotFallbackMessage={setBotFallbackMessage}
            />
          )}

          {currentStep === 7 && (
            <div className="space-y-8">
              <Step6Image
                usePackageImage={usePackageImage} setUsePackageImage={setUsePackageImage}
                customImageTemplateId={customImageTemplateId} setCustomImageTemplateId={setCustomImageTemplateId}
                imageTemplates={imageTemplates}
                uploadingImage={uploadingImage} handleImageUpload={handleImageUpload}
                editorFields={editorFields} setEditorFields={setEditorFields}
                editorSelectedFieldId={editorSelectedFieldId} setEditorSelectedFieldId={setEditorSelectedFieldId}
                editorDragging={editorDragging} setEditorDragging={setEditorDragging}
                editorImgDims={editorImgDims} setEditorImgDims={setEditorImgDims}
                editorRenderedDims={editorRenderedDims} setEditorRenderedDims={setEditorRenderedDims}
                editorSaving={editorSaving} saveEditorFields={saveEditorFields}
                imagePreviewUrl={imagePreviewUrl} imagePreviewLoading={imagePreviewLoading}
                handlePreviewImage={handlePreviewImage}
                name={name}
              />
              <div className="border-t pt-6">
                <Step8Strategy
                  sendSpeed={sendSpeed} setSendSpeed={setSendSpeed}
                  burstMode={burstMode} setBurstMode={setBurstMode}
                  businessHoursOnly={businessHoursOnly} setBusinessHoursOnly={setBusinessHoursOnly}
                  businessHoursStart={businessHoursStart} setBusinessHoursStart={setBusinessHoursStart}
                  businessHoursEnd={businessHoursEnd} setBusinessHoursEnd={setBusinessHoursEnd}
                  scheduledAt={scheduledAt} setScheduledAt={setScheduledAt}
                  campaignAudioEnabled={campaignAudioEnabled} setCampaignAudioEnabled={setCampaignAudioEnabled}
                  campaignAudioUrl={campaignAudioUrl} setCampaignAudioUrl={setCampaignAudioUrl}
                  dispatchMode={dispatchMode}
                  setDispatchMode={setDispatchMode}
                  estimatedLeads={(directLeads.length || (selectedLeadList?.validLeads ?? selectedLeadList?.totalLeads ?? 2000))}
                  estimatedNumbers={Math.max(1, selectedNumbers.length)}
                />
              </div>
            </div>
          )}

          {currentStep === 8 && (
            <Step8Review
              name={name} setName={setName}
              description={description} setDescription={setDescription}
              isTestMode={isTestMode} setIsTestMode={setIsTestMode}
              selectedWabas={selectedWabas}
              selectedNumbers={selectedNumbers}
              leadListId={leadListId} selectedLeadList={selectedLeadList}
              contactInputMode={contactInputMode} directLeads={directLeads}
              selectedTemplates={selectedTemplates} selectedTemplateNames={selectedTemplateNames}
              templates={templates}
              conversionMessage={conversionMessage}
              usePackageImage={usePackageImage} customImageTemplateId={customImageTemplateId} selectedImageTemplate={selectedImageTemplate}
              automationEnabled={automationEnabled} botRules={botRules}
              sendSpeed={sendSpeed} burstMode={burstMode}
              businessHoursOnly={businessHoursOnly}
              businessHoursStart={businessHoursStart} businessHoursEnd={businessHoursEnd}
              scheduledAt={scheduledAt}
              campaignAudioEnabled={campaignAudioEnabled} campaignAudioUrl={campaignAudioUrl}
              setCurrentStep={setCurrentStep}
              handleFinish={handleFinish} handleStartCampaign={handleStartCampaign}
              startMutationPending={startMutation.isPending}
              canStart={!!name && selectedWabas.length > 0 && (!!leadListId || directLeads.length > 0) && selectedTemplates.length > 0}
              verifyToken={verifyToken}
              appSecret={appSecret}
              webhookTestResult={webhookTestResult}
            />
          )}
        </CardContent>
      </Card>

      {currentStep < 8 && (
        <div className="fixed bottom-0 left-0 right-0 sm:static bg-white sm:bg-transparent border-t sm:border-0 p-3 sm:p-0 z-30 safe-area-bottom flex items-center justify-between gap-2">
          <Button
            variant="outline"
            disabled={currentStep === 1}
            onClick={() => goToStep(currentStep - 1)}
            className="min-h-[44px]"
          >
            <ChevronLeft className="w-4 h-4 sm:mr-1" />
            <span className="hidden sm:inline">Anterior</span>
          </Button>

          <div className="flex gap-2">
            <Button variant="outline" onClick={saveCurrentStep} disabled={saving} className="min-h-[44px]">
              {saving ? <Loader2 className="w-4 h-4 sm:mr-1 animate-spin" /> : <Save className="w-4 h-4 sm:mr-1" />}
              <span className="hidden sm:inline">Salvar</span>
            </Button>
            <Button onClick={() => goToStep(currentStep + 1)} className="min-h-[44px] bg-[#0066FF] hover:bg-[#0052CC]">
              <span className="hidden sm:inline">Próximo</span>
              <ChevronRight className="w-4 h-4 sm:ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
