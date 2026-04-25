import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Activity, Calendar, Clock, Music, Info, Zap, Shield, Gauge, Timer, Image as ImageIcon, MessageSquare, Upload, Layers } from "lucide-react";
import AudioRecorder from "@/components/AudioRecorder";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useRef } from "react";

interface EtaResponse {
  selected: { mode: string; label: string; etaMinutes: number; effectiveRate: number; msgsPerHour: number; description: string };
  all: Array<{ mode: string; label: string; description: string; etaMinutes: number; effectiveRate: number; msgsPerHour: number }>;
  totalLeads: number;
  numberCount: number;
}

interface Step8StrategyProps {
  sendSpeed: string;
  setSendSpeed: (v: string) => void;
  burstMode: boolean;
  setBurstMode: (v: boolean) => void;
  businessHoursOnly: boolean;
  setBusinessHoursOnly: (v: boolean) => void;
  businessHoursStart: number;
  setBusinessHoursStart: (v: number) => void;
  businessHoursEnd: number;
  setBusinessHoursEnd: (v: number) => void;
  scheduledAt: string;
  setScheduledAt: (v: string) => void;
  campaignAudioEnabled: boolean;
  setCampaignAudioEnabled: (v: boolean) => void;
  campaignAudioUrl: string;
  setCampaignAudioUrl: (v: string) => void;
  staticImageEnabled?: boolean;
  setStaticImageEnabled?: (v: boolean) => void;
  staticImageUrl?: string;
  setStaticImageUrl?: (v: string) => void;
  extraTextEnabled?: boolean;
  setExtraTextEnabled?: (v: boolean) => void;
  extraTextMessage?: string;
  setExtraTextMessage?: (v: string) => void;
  sequenceEnabled?: boolean;
  setSequenceEnabled?: (v: boolean) => void;
  dispatchMode?: string;
  setDispatchMode?: (v: string) => void;
  estimatedLeads?: number;
  estimatedNumbers?: number;
}

const MODE_META: Record<string, { icon: any; bg: string; ring: string; iconColor: string }> = {
  seguro: { icon: Shield, bg: "bg-green-50", ring: "ring-green-500", iconColor: "text-green-600" },
  equilibrado: { icon: Gauge, bg: "bg-blue-50", ring: "ring-blue-500", iconColor: "text-blue-600" },
  turbo: { icon: Zap, bg: "bg-orange-50", ring: "ring-orange-500", iconColor: "text-orange-600" },
};

export default function Step8Strategy({
  sendSpeed, setSendSpeed, burstMode, setBurstMode,
  businessHoursOnly, setBusinessHoursOnly,
  businessHoursStart, setBusinessHoursStart,
  businessHoursEnd, setBusinessHoursEnd,
  scheduledAt, setScheduledAt,
  campaignAudioEnabled, setCampaignAudioEnabled,
  campaignAudioUrl, setCampaignAudioUrl,
  staticImageEnabled = false, setStaticImageEnabled,
  staticImageUrl = "", setStaticImageUrl,
  extraTextEnabled = false, setExtraTextEnabled,
  extraTextMessage = "", setExtraTextMessage,
  sequenceEnabled = false, setSequenceEnabled,
  dispatchMode = "equilibrado",
  setDispatchMode,
  estimatedLeads = 2000,
  estimatedNumbers = 1,
}: Step8StrategyProps) {
  const [selectedMode, setSelectedMode] = useState<string>(dispatchMode);
  const { toast } = useToast();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [imageUploading, setImageUploading] = useState(false);

  const handleImageUpload = async (file: File) => {
    setImageUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch("/api/campaigns/upload-static-image", { method: "POST", body: fd, credentials: "include" });
      const data = await res.json();
      if (!res.ok || !data?.url) throw new Error(data?.error || "Falha no upload");
      setStaticImageUrl?.(data.url);
      setStaticImageEnabled?.(true);
      toast({ title: "Imagem carregada", description: "A mesma imagem será enviada para todos os leads." });
    } catch (err: any) {
      toast({ title: "Erro no upload", description: err.message || "Falha ao enviar imagem", variant: "destructive" });
    } finally {
      setImageUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  useEffect(() => {
    setSelectedMode(dispatchMode);
  }, [dispatchMode]);

  const { data: etaData, isLoading: etaLoading } = useQuery<EtaResponse>({
    queryKey: ["/api/dispatch/eta", estimatedLeads, estimatedNumbers, selectedMode],
    queryFn: async () => {
      const res = await fetch(`/api/dispatch/eta?totalLeads=${estimatedLeads}&numberCount=${Math.max(1, estimatedNumbers)}&mode=${selectedMode}`);
      return res.json();
    },
  });

  const handleModeChange = (mode: string) => {
    setSelectedMode(mode);
    setDispatchMode?.(mode);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Activity className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Estratégia de Envio</h2>
          <p className="text-sm text-muted-foreground">Escolha o modo de disparo. O motor adapta velocidade e segurança automaticamente.</p>
        </div>
      </div>

      {/* Modo de Disparo (NOVO) */}
      <div className="border-2 rounded-xl p-4 space-y-4 shadow-sm bg-gradient-to-br from-white to-gray-50/50">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-semibold">Modo de Disparo</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Selecionado: <span className="font-medium text-gray-900">{etaData?.selected?.label || "Equilibrado"}</span>
              {etaData && (
                <span className="ml-2 text-blue-600">
                  · ETA {etaData.selected.etaMinutes}min para {etaData.totalLeads.toLocaleString("pt-BR")} mensagens
                </span>
              )}
            </p>
          </div>
          <Badge variant="outline" className="text-[10px]">
            {estimatedNumbers} {estimatedNumbers === 1 ? "número" : "números"}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(etaData?.all || [
            { mode: "seguro", label: "Seguro", description: "Mais cauteloso", etaMinutes: 33, effectiveRate: 1, msgsPerHour: 3600 },
            { mode: "equilibrado", label: "Equilibrado", description: "Recomendado", etaMinutes: 28, effectiveRate: 1.2, msgsPerHour: 4320 },
            { mode: "turbo", label: "Turbo", description: "Velocidade máxima", etaMinutes: 22, effectiveRate: 1.5, msgsPerHour: 5400 },
          ]).map((m) => {
            const meta = MODE_META[m.mode] || MODE_META.equilibrado;
            const Icon = meta.icon;
            const isSelected = selectedMode === m.mode;
            return (
              <button
                key={m.mode}
                type="button"
                data-testid={`button-mode-${m.mode}`}
                onClick={() => handleModeChange(m.mode)}
                className={`text-left p-4 rounded-xl border-2 transition-all hover-elevate active-elevate-2 ${
                  isSelected ? `${meta.bg} ring-2 ${meta.ring} border-transparent` : "border-gray-200 hover:border-gray-300 bg-white"
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isSelected ? "bg-white" : meta.bg}`}>
                    <Icon className={`w-4 h-4 ${meta.iconColor}`} />
                  </div>
                  <div className="font-semibold text-sm">{m.label}</div>
                  {isSelected && <Badge className="ml-auto text-[9px] h-4 px-1.5">Ativo</Badge>}
                </div>
                <p className="text-xs text-muted-foreground mb-3 leading-snug">{m.description}</p>
                <div className="flex items-baseline gap-1.5 mb-1">
                  <Timer className="w-3 h-3 text-muted-foreground" />
                  <span className="text-base font-bold tabular-nums">{m.etaMinutes}</span>
                  <span className="text-xs text-muted-foreground">min</span>
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  ~{m.msgsPerHour.toLocaleString("pt-BR")} msg/h
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50/50 border border-blue-100">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-blue-900 leading-relaxed">
            <strong>Política sem auto-pausa:</strong> nenhum dos modos pausa a campanha por queda de qualidade.
            Quando um número degrada, ele apenas recebe menos volume — os outros absorvem. Se ficar muito ruim,
            ele continua enviando com peso mínimo (5%). Você decide quando pausar.
          </div>
        </div>
      </div>

      {/* Velocidade legada (avançado/oculto) */}
      <details className="border rounded-xl">
        <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-muted-foreground hover:text-gray-900">
          Configurações avançadas (legado)
        </summary>
        <div className="p-4 pt-0 space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Velocidade legada (substituída pelo modo acima)</Label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
              {[
                { id: "slow", label: "Lento", desc: "1-2 msg/s" },
                { id: "normal", label: "Normal", desc: "5-10 msg/s" },
                { id: "fast", label: "Rápido", desc: "10-15 msg/s" },
                { id: "custom", label: "Personalizado", desc: "Configurar" },
              ].map((speed) => (
                <div
                  key={speed.id}
                  data-testid={`button-speed-${speed.id}`}
                  className={`p-3 border rounded-xl cursor-pointer text-center transition-all ${
                    sendSpeed === speed.id ? "border-primary bg-primary/5 shadow-sm" : "hover:border-muted-foreground/50"
                  }`}
                  onClick={() => setSendSpeed(speed.id)}
                >
                  <p className="font-medium text-sm">{speed.label}</p>
                  <p className="text-xs text-muted-foreground">{speed.desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/20">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-orange-600" />
              <Label className="text-xs">Burst mode (legado)</Label>
            </div>
            <Switch checked={burstMode} onCheckedChange={setBurstMode} data-testid="switch-burst-mode" />
          </div>
        </div>
      </details>

      <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
            <Clock className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <Label className="text-sm font-medium">Horário Comercial</Label>
            <p className="text-xs text-muted-foreground">Enviar apenas dentro do horário comercial definido</p>
          </div>
        </div>
        <Switch checked={businessHoursOnly} onCheckedChange={setBusinessHoursOnly} data-testid="switch-business-hours" />
      </div>

      {businessHoursOnly && (
        <div className="flex gap-4 pl-4">
          <div className="flex-1">
            <Label className="text-xs">Início</Label>
            <Select value={String(businessHoursStart)} onValueChange={(v) => setBusinessHoursStart(Number(v))}>
              <SelectTrigger data-testid="select-business-start"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <Label className="text-xs">Fim</Label>
            <Select value={String(businessHoursEnd)} onValueChange={(v) => setBusinessHoursEnd(Number(v))}>
              <SelectTrigger data-testid="select-business-end"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Mensagens em sequência (imagem + áudio + texto) */}
      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center justify-between p-4 border-2 border-blue-200 rounded-xl bg-blue-50/40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
              <Layers className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Enviar mensagens em sequência</h3>
              <p className="text-xs text-muted-foreground">Após o template, envia imagem → áudio → texto, sem esperar resposta. Atraso 500–1500ms entre cada uma.</p>
            </div>
          </div>
          <Switch checked={sequenceEnabled} onCheckedChange={(v) => setSequenceEnabled?.(v)} data-testid="switch-sequence-enabled" />
        </div>

        {sequenceEnabled && (
          <>
            {/* Imagem estática (mesma para todos os leads) */}
            <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                  <ImageIcon className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Imagem da Campanha (mesma para todos)</h3>
                  <p className="text-xs text-muted-foreground">Faça upload de uma imagem ou cole uma URL pública. A mesma imagem é enviada para cada lead.</p>
                </div>
              </div>
              <Switch checked={staticImageEnabled} onCheckedChange={(v) => setStaticImageEnabled?.(v)} data-testid="switch-static-image" />
            </div>
            {staticImageEnabled && (
              <div className="space-y-3 pl-4">
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <Label className="text-xs">URL da Imagem</Label>
                    <Input
                      value={staticImageUrl}
                      onChange={(e) => setStaticImageUrl?.(e.target.value)}
                      placeholder="https://exemplo.com/imagem.jpg"
                      className="h-8 text-sm"
                      data-testid="input-static-image-url"
                    />
                  </div>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); }}
                    data-testid="input-file-static-image"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={imageUploading}
                    data-testid="button-upload-static-image"
                  >
                    <Upload className="w-3 h-3 mr-1" />
                    {imageUploading ? "Enviando..." : "Upload"}
                  </Button>
                </div>
                {staticImageUrl && (
                  <div className="flex items-center gap-2 bg-muted/30 p-2 rounded-lg">
                    <img src={staticImageUrl} alt="preview" className="h-12 w-12 rounded object-cover" />
                    <span className="flex-1 text-xs text-muted-foreground truncate">{staticImageUrl}</span>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-red-500" onClick={() => setStaticImageUrl?.("")} data-testid="button-remove-static-image">
                      Remover
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Texto extra após mídia */}
            <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                  <MessageSquare className="w-4 h-4 text-amber-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">Mensagem de texto extra (opcional)</h3>
                  <p className="text-xs text-muted-foreground">Texto enviado depois da mídia, na mesma sequência.</p>
                </div>
              </div>
              <Switch checked={extraTextEnabled} onCheckedChange={(v) => setExtraTextEnabled?.(v)} data-testid="switch-extra-text" />
            </div>
            {extraTextEnabled && (
              <div className="pl-4">
                <Textarea
                  value={extraTextMessage}
                  onChange={(e) => setExtraTextMessage?.(e.target.value)}
                  placeholder="Ex.: Olá! Estamos com uma oferta especial para você..."
                  rows={3}
                  className="text-sm"
                  data-testid="textarea-extra-text"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Máx. ~4096 caracteres. Atualmente: {extraTextMessage.length}.</p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <Music className="w-4 h-4 text-purple-600" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Áudio da Campanha (opcional)</h3>
              <p className="text-xs text-muted-foreground">Grave ou informe um áudio. Será enviado dentro da sequência se "Enviar em sequência" estiver ativado.</p>
            </div>
          </div>
          <Switch checked={campaignAudioEnabled} onCheckedChange={setCampaignAudioEnabled} data-testid="switch-campaign-audio" />
        </div>
        {campaignAudioEnabled && (
          <div className="space-y-3 pl-4">
            <div className="flex gap-2 items-end">
              <div className="flex-1">
                <Label className="text-xs">URL do Áudio</Label>
                <Input
                  value={campaignAudioUrl}
                  onChange={(e) => setCampaignAudioUrl(e.target.value)}
                  placeholder="https://exemplo.com/audio.ogg"
                  className="h-8 text-sm"
                  data-testid="input-audio-url"
                />
              </div>
              <AudioRecorder onRecorded={(url) => setCampaignAudioUrl(url)} />
            </div>
            {campaignAudioUrl && (
              <div className="flex items-center gap-2 bg-muted/30 p-2 rounded-lg">
                <Music className="w-3 h-3 text-primary" />
                <audio controls src={campaignAudioUrl} className="h-8 flex-1" />
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-red-500" onClick={() => setCampaignAudioUrl("")} data-testid="button-remove-audio">
                  Remover
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
            <Calendar className="w-4 h-4 text-green-600" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">Agendamento (opcional)</h3>
            <p className="text-xs text-muted-foreground">Defina uma data e hora para iniciar o envio automaticamente</p>
          </div>
        </div>
        <Input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          data-testid="input-scheduled-at"
        />
        {scheduledAt && (
          <div className="flex items-center gap-2">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Agendado para: {new Date(scheduledAt).toLocaleString("pt-BR")}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setScheduledAt("")} data-testid="button-clear-schedule">
              Remover
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
