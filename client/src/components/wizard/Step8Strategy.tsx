import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Activity, Calendar, Clock, Music, Info } from "lucide-react";
import AudioRecorder from "@/components/AudioRecorder";

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
}

export default function Step8Strategy({
  sendSpeed, setSendSpeed, burstMode, setBurstMode,
  businessHoursOnly, setBusinessHoursOnly,
  businessHoursStart, setBusinessHoursStart,
  businessHoursEnd, setBusinessHoursEnd,
  scheduledAt, setScheduledAt,
  campaignAudioEnabled, setCampaignAudioEnabled,
  campaignAudioUrl, setCampaignAudioUrl,
}: Step8StrategyProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Activity className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Estratégia de Envio</h2>
          <p className="text-sm text-muted-foreground">Configure a velocidade, horários e agendamento do disparo</p>
        </div>
      </div>

      <div className="border rounded-xl p-4 space-y-3 shadow-sm">
        <Label className="text-sm font-medium">Velocidade de Envio</Label>
        <p className="text-xs text-muted-foreground">Escolha a velocidade de acordo com o volume de envios e a tolerância ao risco</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
          {[
            { id: "slow", label: "Lento", desc: "1-2 msg/s" },
            { id: "normal", label: "Normal", desc: "5-10 msg/s" },
            { id: "fast", label: "Rápido", desc: "10-15 msg/s" },
            { id: "custom", label: "Personalizado", desc: "Configurar" },
          ].map((speed) => (
            <div
              key={speed.id}
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

      <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-orange-100 flex items-center justify-center">
            <Activity className="w-4 h-4 text-orange-600" />
          </div>
          <div>
            <div className="flex items-center gap-1">
              <Label className="text-sm font-medium">Envio Simultâneo</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild><Info className="w-3 h-3 text-muted-foreground cursor-help" /></TooltipTrigger>
                  <TooltipContent><p className="text-xs max-w-xs">Envio em rajada com alta velocidade. Use com cuidado — pode causar bloqueios temporários em números com qualidade baixa.</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <p className="text-xs text-muted-foreground">Utiliza múltiplos números em paralelo (use com cuidado)</p>
          </div>
        </div>
        <Switch checked={burstMode} onCheckedChange={setBurstMode} />
      </div>

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
        <Switch checked={businessHoursOnly} onCheckedChange={setBusinessHoursOnly} />
      </div>

      {businessHoursOnly && (
        <div className="flex gap-4 pl-4">
          <div className="flex-1">
            <Label className="text-xs">Início</Label>
            <Select value={String(businessHoursStart)} onValueChange={(v) => setBusinessHoursStart(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
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
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => (
                  <SelectItem key={i} value={String(i)}>{String(i).padStart(2, "0")}:00</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <Music className="w-4 h-4 text-purple-600" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Áudio da Campanha (opcional)</h3>
              <p className="text-xs text-muted-foreground">Grave ou informe um áudio para enviar junto com a campanha</p>
            </div>
          </div>
          <Switch checked={campaignAudioEnabled} onCheckedChange={setCampaignAudioEnabled} />
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
                />
              </div>
              <AudioRecorder
                onRecorded={(url) => setCampaignAudioUrl(url)}
              />
            </div>
            {campaignAudioUrl && (
              <div className="flex items-center gap-2 bg-muted/30 p-2 rounded-lg">
                <Music className="w-3 h-3 text-primary" />
                <audio controls src={campaignAudioUrl} className="h-8 flex-1" />
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-red-500" onClick={() => setCampaignAudioUrl("")}>
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
        />
        {scheduledAt && (
          <div className="flex items-center gap-2">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Agendado para: {new Date(scheduledAt).toLocaleString("pt-BR")}
            </span>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setScheduledAt("")}>
              Remover
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
