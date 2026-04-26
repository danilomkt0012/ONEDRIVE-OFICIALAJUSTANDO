import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import AudioRecorder from "@/components/AudioRecorder";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Bot, Plus, Trash2, Save, Power, PowerOff, GripVertical,
  MessageSquare, Image, Mic, List, LayoutGrid, X, Upload, Eye, EyeOff,
  ChevronRight, AlertTriangle, CheckCircle,
} from "lucide-react";
import { queryClient } from "@/lib/queryClient";

interface BotRule {
  id: string;
  userId: string;
  keyword: string;
  response: string;
  responseType: string | null;
  mediaUrl: string | null;
  buttonPayload: any;
  isActive: boolean | null;
  priority: number | null;
  createdAt: string;
}

interface BotSettings {
  id?: string;
  isActive: boolean;
  fallbackMessage: string | null;
}

interface BotMediaAlert {
  id: string;
  mediaUrl: string;
  mediaType: string;
  nodeId: string | null;
  flowId: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

function BotMediaAlertsPanel() {
  const { toast } = useToast();

  const { data: alerts = [] } = useQuery<BotMediaAlert[]>({
    queryKey: ['/api/bot/media-alerts'],
    refetchInterval: 60_000,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: string) =>
      apiRequest('PATCH', `/api/bot/media-alerts/${id}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/bot/media-alerts'] });
      toast({ title: 'Alerta resolvido', description: 'Marque o áudio como atualizado quando fizer o upload.' });
    },
  });

  if (alerts.length === 0) return null;

  const mediaTypeLabel: Record<string, string> = {
    audio: 'Áudio',
    image: 'Imagem',
    combined_audio: 'Áudio (nó combinado)',
    combined_image: 'Imagem (nó combinado)',
  };

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 space-y-3" data-testid="bot-media-alerts-panel">
      <div className="flex items-center gap-2">
        <AlertTriangle size={18} className="text-amber-600 flex-shrink-0" />
        <span className="font-semibold text-amber-900 text-sm">
          {alerts.length === 1
            ? '1 mídia do bot está inacessível'
            : `${alerts.length} mídias do bot estão inacessíveis`}
        </span>
      </div>
      <p className="text-xs text-amber-800">
        O bot detectou que os arquivos abaixo não estão mais acessíveis. Enquanto isso, ele envia uma mensagem de texto no lugar. Faça o upload novamente e clique em <strong>Já atualizei</strong>.
      </p>
      <div className="space-y-2">
        {alerts.map((alert) => (
          <div
            key={alert.id}
            className="bg-white border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3"
            data-testid={`bot-media-alert-${alert.id}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                  {mediaTypeLabel[alert.mediaType] ?? alert.mediaType}
                </span>
                <span className="text-xs text-gray-500">
                  {alert.occurrenceCount}× falhou · última vez {new Date(alert.lastSeenAt).toLocaleString('pt-BR')}
                </span>
              </div>
              <p className="text-xs text-gray-700 mt-1 truncate max-w-xs sm:max-w-md" title={alert.mediaUrl}>
                {alert.mediaUrl.split('/').pop() ?? alert.mediaUrl}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="flex-shrink-0 text-xs border-green-400 text-green-700 hover:bg-green-50"
              disabled={resolveMutation.isPending}
              onClick={() => resolveMutation.mutate(alert.id)}
              data-testid={`resolve-alert-${alert.id}`}
            >
              <CheckCircle size={13} className="mr-1" /> Já atualizei
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

const RESPONSE_TYPES = [
  { value: "text", label: "Texto", icon: MessageSquare },
  { value: "image", label: "Imagem", icon: Image },
  { value: "audio", label: "Áudio", icon: Mic },
  { value: "buttons", label: "Botões", icon: LayoutGrid },
  { value: "list", label: "Lista", icon: List },
];

function RuleEditor({ rule, onSave, onCancel }: { rule?: BotRule; onSave: (data: any) => void; onCancel: () => void }) {
  const [keyword, setKeyword] = useState(rule?.keyword || "");
  const [response, setResponse] = useState(rule?.response || "");
  const [responseType, setResponseType] = useState(rule?.responseType || "text");
  const [mediaUrl, setMediaUrl] = useState(rule?.mediaUrl || "");
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const [buttonPayload, setButtonPayload] = useState<any>(rule?.buttonPayload || []);
  const [showPreview, setShowPreview] = useState(false);
  const previewAutoOpened = useRef(false);
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const step1Done = keyword.trim().length > 0;
  const step2Done = step1Done && responseType.length > 0;
  const mediaOptional = responseType === "image" || responseType === "audio";
  const step3Done = step2Done && (response.trim().length > 0 || (mediaOptional && mediaUrl.trim().length > 0));

  useEffect(() => {
    if (step3Done && !previewAutoOpened.current) {
      previewAutoOpened.current = true;
      setShowPreview(true);
    }
  }, [step3Done]);

  const handleUploadMedia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("media", file);
    try {
      const res = await fetch("/api/bot/rules/upload-media", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Falha no upload");
      const data = await res.json();
      setMediaUrl(data.url);
      toast({ title: "Upload concluído" });
    } catch {
      toast({ title: "Erro no upload", variant: "destructive" });
    }
    e.target.value = "";
  };

  const handleSubmit = () => {
    if (!keyword.trim()) {
      toast({ title: "Preencha o gatilho", variant: "destructive" });
      return;
    }
    if (!response.trim() && !(mediaOptional && mediaUrl.trim())) {
      toast({ title: "Preencha a resposta ou faça upload de mídia", variant: "destructive" });
      return;
    }
    onSave({
      keyword: keyword.trim(),
      response: response.trim(),
      responseType,
      mediaUrl: mediaUrl || null,
      buttonPayload: (responseType === "buttons" || responseType === "list") ? buttonPayload : null,
      isActive,
    });
  };

  return (
    <div className="bg-white rounded-xl border shadow-sm p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">{rule ? "Editar Regra" : "Nova Regra"}</h3>
        <button onClick={onCancel}><X size={20} className="text-gray-400 hover:text-gray-600" /></button>
      </div>

      <div className="space-y-5">
        <div>
          <Label className="text-base font-medium text-gray-800">
            <span className="inline-flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">1</span>
              Quando o cliente escrever...
            </span>
          </Label>
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Ex: preço, oi, ajuda"
            className="mt-2"
          />
          <p className="text-xs text-gray-500 mt-1">O bot responde quando a mensagem contem essa palavra</p>
        </div>

        {step1Done && (
          <div>
            <Label className="text-base font-medium text-gray-800">
              <span className="inline-flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">2</span>
                O bot vai responder com...
              </span>
            </Label>
            <div className="flex flex-wrap gap-2 mt-2">
              {RESPONSE_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setResponseType(t.value)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors ${
                    responseType === t.value ? "bg-blue-50 border-blue-500 text-blue-700 font-medium" : "border-gray-200 hover:bg-gray-50 text-gray-600"
                  }`}
                >
                  <t.icon size={14} /> {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {step2Done && (
          <div>
            <Label className="text-base font-medium text-gray-800">
              <span className="inline-flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">3</span>
                {responseType === "image" ? "Legenda da imagem" : responseType === "audio" ? "Mensagem de acompanhamento (opcional)" : "Conteúdo da resposta"}
              </span>
            </Label>
            <textarea
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              className="w-full border rounded-lg p-3 text-sm min-h-[80px] resize-y mt-2"
              placeholder={
                responseType === "image"
                  ? "Legenda da imagem (opcional — pode usar só a imagem abaixo)"
                  : responseType === "audio"
                  ? "Mensagem de acompanhamento (opcional — pode enviar só o áudio)"
                  : "Digite a resposta do bot..."
              }
            />
          </div>
        )}

        {step2Done && (responseType === "image" || responseType === "audio") && (
          <div>
            <Label className="text-sm font-medium text-gray-700">
              {responseType === "image" ? "Arquivo de imagem" : "Arquivo de áudio"}
            </Label>
            <div className="flex gap-2 mt-1">
              <Input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} placeholder="https://..." className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} className="mr-1" /> Upload
              </Button>
              <input ref={fileInputRef} type="file" accept={responseType === "audio" ? "audio/*" : "image/*"} className="hidden" onChange={handleUploadMedia} />
              {responseType === "audio" && (
                <AudioRecorder onRecorded={(url) => setMediaUrl(url)} />
              )}
            </div>
            {mediaUrl && responseType === "image" && (
              <img src={mediaUrl} alt="Preview" className="mt-2 max-h-[120px] rounded-lg border" />
            )}
          </div>
        )}

        {step2Done && responseType === "buttons" && (
          <div>
            <Label className="text-sm font-medium text-gray-700">Botões de resposta rápida (max 3)</Label>
            <div className="space-y-2 mt-1">
              {(Array.isArray(buttonPayload) ? buttonPayload : []).map((btn: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <Input
                    value={btn.title || ""}
                    onChange={(e) => {
                      const newBtns = [...(Array.isArray(buttonPayload) ? buttonPayload : [])];
                      newBtns[i] = { ...newBtns[i], title: e.target.value, id: e.target.value };
                      setButtonPayload(newBtns);
                    }}
                    placeholder={`Botão ${i + 1}`}
                    className="flex-1"
                  />
                  <Button variant="ghost" size="sm" onClick={() => {
                    const newBtns = [...(Array.isArray(buttonPayload) ? buttonPayload : [])];
                    newBtns.splice(i, 1);
                    setButtonPayload(newBtns);
                  }}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
              {(Array.isArray(buttonPayload) ? buttonPayload : []).length < 3 && (
                <Button variant="outline" size="sm" onClick={() => setButtonPayload([...(Array.isArray(buttonPayload) ? buttonPayload : []), { id: "", title: "" }])}>
                  <Plus size={14} className="mr-1" /> Adicionar Botão
                </Button>
              )}
            </div>
          </div>
        )}

        {step2Done && responseType === "list" && (
          <div>
            <Label className="text-sm font-medium text-gray-700">Título do botão da lista</Label>
            <Input
              value={(buttonPayload as any)?.button || ""}
              onChange={(e) => setButtonPayload({ ...(buttonPayload || {}), button: e.target.value, sections: (buttonPayload as any)?.sections || [] })}
              placeholder="Ex: Ver Opções"
              className="mt-1"
            />
          </div>
        )}

        {step3Done && showPreview && (
          <div className="bg-[#ECE5DD] rounded-lg p-4">
            <p className="text-xs font-medium text-gray-500 mb-2">Preview WhatsApp</p>
            <div className="bg-[#DCF8C6] rounded-lg rounded-tr-none px-3 py-2 max-w-[75%] ml-auto shadow-sm">
              {responseType === "image" && mediaUrl && (
                <img src={mediaUrl} alt="" className="rounded max-h-[150px] mb-1" />
              )}
              {responseType === "audio" && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Mic size={14} /> Audio
                </div>
              )}
              <p className="text-sm">{response || "..."}</p>
              {responseType === "buttons" && Array.isArray(buttonPayload) && buttonPayload.length > 0 && (
                <div className="mt-2 space-y-1 border-t pt-2">
                  {buttonPayload.map((b: any, i: number) => (
                    <div key={i} className="text-center text-sm text-blue-600 py-1 border rounded">{b.title || `Botão ${i + 1}`}</div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t">
        <div className="flex items-center gap-2">
          <Switch checked={isActive} onCheckedChange={setIsActive} />
          <span className="text-sm text-gray-600">{isActive ? "Regra ativa" : "Regra inativa"}</span>
        </div>
        <div className="flex gap-2">
          {step3Done && (
            <Button variant="outline" size="sm" onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? <><EyeOff size={14} className="mr-1" /> Fechar Preview</> : <><Eye size={14} className="mr-1" /> Preview WhatsApp</>}
            </Button>
          )}
          <Button variant="outline" onClick={onCancel}>Cancelar</Button>
          <Button onClick={handleSubmit} className="bg-blue-600 hover:bg-blue-700" disabled={!step3Done}>
            <Save size={14} className="mr-1" /> Salvar
          </Button>
        </div>
      </div>
    </div>
  );
}

function SortableRuleCard({ rule, onEdit, onDelete, onToggle }: {
  rule: BotRule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const typeInfo = RESPONSE_TYPES.find((t) => t.value === (rule.responseType || "text"));
  const TypeIcon = typeInfo?.icon || MessageSquare;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white rounded-xl border shadow-sm p-4 transition-all ${rule.isActive ? "" : "opacity-60"} ${isDragging ? "shadow-lg" : ""}`}
    >
      <div className="flex items-center gap-3">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 transition-colors flex-shrink-0 touch-none"
          title="Arrastar para reordenar"
        >
          <GripVertical size={18} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Badge variant="outline" className="font-mono text-xs">{rule.keyword}</Badge>
            <div className="flex items-center gap-1 text-xs text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
              <TypeIcon size={11} /> {typeInfo?.label}
            </div>
          </div>
          <p className="text-sm text-gray-700 truncate">{rule.response || <span className="italic text-gray-400">sem texto</span>}</p>
          {rule.mediaUrl && (
            <p className="text-xs text-blue-500 truncate mt-0.5">{rule.mediaUrl}</p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <Switch
              checked={rule.isActive ?? false}
              onCheckedChange={onToggle}
              title={rule.isActive ? "Desativar regra" : "Ativar regra"}
            />
            <span className={`text-xs font-medium ${rule.isActive ? "text-green-600" : "text-gray-400"}`}>
              {rule.isActive ? "Ativa" : "Inativa"}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onEdit} title="Editar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            title="Remover"
          >
            <Trash2 size={14} className="text-red-500" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function BotPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingRule, setEditingRule] = useState<BotRule | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [localRules, setLocalRules] = useState<BotRule[] | null>(null);

  const { data: settings } = useQuery<BotSettings>({
    queryKey: ["/api/bot/settings"],
  });

  const { data: rulesData = [] } = useQuery<BotRule[]>({
    queryKey: ["/api/bot/rules"],
    select: (data) => [...data].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)),
  });


  const rules = localRules ?? rulesData;

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: Partial<BotSettings>) => {
      const response = await apiRequest("PUT", "/api/bot/settings", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/settings"] });
    },
  });

  const createRuleMutation = useMutation({
    mutationFn: async (data: any) => {
      const response = await apiRequest("POST", "/api/bot/rules", data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
      setLocalRules(null);
      setIsCreating(false);
      toast({ title: "Regra criada" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await apiRequest("PUT", `/api/bot/rules/${id}`, data);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
      setLocalRules(null);
      setEditingRule(null);
      toast({ title: "Regra atualizada" });
    },
    onError: (error: any) => {
      toast({ title: "Erro", description: error.message, variant: "destructive" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest("DELETE", `/api/bot/rules/${id}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
      setLocalRules(null);
      toast({ title: "Regra removida" });
    },
  });

  const toggleRuleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const response = await apiRequest("PUT", `/api/bot/rules/${id}`, { isActive });
      return response.json();
    },
    onMutate: ({ id, isActive }) => {
      setLocalRules((prev) =>
        prev ? prev.map((r) => (r.id === id ? { ...r, isActive } : r)) : null
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
    },
    onError: () => {
      setLocalRules(null);
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      const response = await apiRequest("PUT", "/api/bot/rules/reorder", { orderedIds });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
      setLocalRules(null);
    },
    onError: () => {
      setLocalRules(null);
      queryClient.invalidateQueries({ queryKey: ["/api/bot/rules"] });
      toast({ title: "Erro ao reordenar regras", variant: "destructive" });
    },
  });

  const [fallbackMsg, setFallbackMsg] = useState("");
  const fallbackInitialized = useRef(false);
  if (settings && !fallbackInitialized.current) {
    setFallbackMsg(settings.fallbackMessage || "");
    fallbackInitialized.current = true;
  }

  const botActive = settings?.isActive ?? false;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = rules.findIndex((r) => r.id === active.id);
    const newIndex = rules.findIndex((r) => r.id === over.id);
    const reordered = arrayMove(rules, oldIndex, newIndex);
    setLocalRules(reordered);
    reorderMutation.mutate(reordered.map((r) => r.id));
  };

  return (
    <div className="flex-1">
      <header className="bg-white shadow-sm border-b border-gray-200 px-3 sm:px-6 py-3 sm:py-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 sm:w-10 h-8 sm:h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
              <Bot size={18} className="text-blue-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg sm:text-2xl font-bold text-gray-900">Bot Automático</h2>
              <p className="text-gray-600 mt-0.5 text-xs sm:text-sm hidden sm:block">Regras de resposta automática por keyword</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Button
              onClick={() => updateSettingsMutation.mutate({ isActive: !botActive, fallbackMessage: settings?.fallbackMessage })}
              variant={botActive ? "default" : "outline"}
              size="sm"
              className={`min-h-[44px] ${botActive ? "bg-green-600 hover:bg-green-700" : ""}`}
            >
              {botActive ? <><Power size={16} className="sm:mr-2" /> <span className="hidden sm:inline">Bot Ativo</span></> : <><PowerOff size={16} className="sm:mr-2" /> <span className="hidden sm:inline">Bot Inativo</span></>}
            </Button>
            <Button size="sm" className="min-h-[44px]" onClick={() => { setIsCreating(true); setEditingRule(null); }}>
              <Plus size={16} className="sm:mr-2" /> <span className="hidden sm:inline">Nova Regra</span>
            </Button>
          </div>
        </div>
      </header>

      <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-4 sm:space-y-6">
        <BotMediaAlertsPanel />

        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <MessageSquare size={16} className="text-blue-600" />
            </div>
            <div>
              <h4 className="font-semibold text-blue-900 text-sm">Bot Programável (Conversa Guiada)</h4>
              <p className="text-xs text-blue-700 mt-0.5">
                Para criar fluxos de conversa guiada por etapas (template → resposta → próxima mensagem → ...),
                acesse a campanha no <strong>Campanha Disparo</strong> e configure o Bot Programável na aba de envio.
                Cada campanha pode ter seu próprio fluxo de conversa independente.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border shadow-sm p-5">
          <h3 className="font-semibold mb-3">Configurações Globais</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Status do Bot</Label>
              <div className={`mt-1 flex items-center gap-2 px-3 py-2 rounded-lg ${botActive ? "bg-green-50 text-green-700" : "bg-gray-50 text-gray-500"}`}>
                {botActive ? <Power size={16} /> : <PowerOff size={16} />}
                <span className="text-sm font-medium">{botActive ? "Ativo - Respondendo automaticamente" : "Inativo - Nenhuma resposta automática"}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">O bot funciona independente de campanhas ativas</p>
            </div>
            <div>
              <Label>Mensagem Fallback</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={fallbackMsg}
                  onChange={(e) => setFallbackMsg(e.target.value)}
                  placeholder="Mensagem quando nenhuma keyword bate..."
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    updateSettingsMutation.mutate({ isActive: botActive, fallbackMessage: fallbackMsg || null });
                    toast({ title: "Fallback salvo" });
                  }}
                >
                  <Save size={14} />
                </Button>
              </div>
              <p className="text-xs text-gray-500 mt-1">Enviada quando nenhuma regra corresponde (deixe vazio para não responder)</p>
            </div>
          </div>
        </div>

        {(isCreating || editingRule) && (
          <RuleEditor
            rule={editingRule || undefined}
            onSave={(data) => {
              if (editingRule) {
                updateRuleMutation.mutate({ id: editingRule.id, data });
              } else {
                createRuleMutation.mutate(data);
              }
            }}
            onCancel={() => { setIsCreating(false); setEditingRule(null); }}
          />
        )}

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-lg">Regras ({rules.length})</h3>
            <p className="text-xs text-gray-400 flex items-center gap-1">
              <GripVertical size={12} /> Arraste para reordenar a prioridade
            </p>
          </div>

          {rules.length === 0 ? (
            <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
              <Bot size={48} className="mx-auto mb-3 text-gray-300" />
              <h3 className="text-lg font-medium text-gray-700 mb-1">Nenhuma regra configurada</h3>
              <p className="text-sm text-gray-500 mb-4">Crie sua primeira regra de resposta automática</p>
              <Button onClick={() => setIsCreating(true)}>
                <Plus size={16} className="mr-2" /> Criar Primeira Regra
              </Button>
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-2">
                  {rules.map((rule) => (
                    <SortableRuleCard
                      key={rule.id}
                      rule={rule}
                      onEdit={() => { setEditingRule(rule); setIsCreating(false); }}
                      onDelete={() => {
                        if (confirm("Remover esta regra?")) deleteRuleMutation.mutate(rule.id);
                      }}
                      onToggle={() => toggleRuleMutation.mutate({ id: rule.id, isActive: !rule.isActive })}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>
    </div>
  );
}
