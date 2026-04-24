import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Mic, Volume2, Loader2, Info, Sparkles, ExternalLink } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface TtsNodeConfig {
  speed: number;
  pitch: number;
  volume: number;
  pauseLevel: number;
  expressiveness: number;
  humanize: boolean;
}

interface FlowNodeLike {
  mediaUrl: string;
  messageContent: string;
  linkUrl: string;
}

interface VoiceProfile {
  id: string;
  name: string;
  gender: string;
}

interface VoiceConfigPanelProps {
  node: FlowNodeLike;
  onUpdate: (updates: Partial<FlowNodeLike>) => void;
  voiceProfileList: VoiceProfile[];
}

export default function VoiceConfigPanel({ node, onUpdate, voiceProfileList }: VoiceConfigPanelProps) {
  const { toast } = useToast();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [previewError, setPreviewError] = useState<{ step: string; error: string; details: any } | null>(null);
  const [humanizing, setHumanizing] = useState(false);

  let cfg: Partial<TtsNodeConfig> = {};
  try { cfg = JSON.parse(node.linkUrl || "{}"); } catch {}

  const speed = cfg.speed ?? 1.0;
  const pitch = cfg.pitch ?? 1.0;
  const volume = cfg.volume ?? 1.0;
  const pauseLevel = cfg.pauseLevel ?? 1;
  const expressiveness = cfg.expressiveness ?? 5;
  const humanize = cfg.humanize ?? true;

  const update = (patch: Partial<TtsNodeConfig>) => {
    onUpdate({ linkUrl: JSON.stringify({ speed, pitch, volume, pauseLevel, expressiveness, humanize, ...cfg, ...patch }) });
  };

  const selectedVoice = voiceProfileList.find(v => v.id === node.mediaUrl);

  const handleHumanize = async () => {
    if (!node.messageContent?.trim()) return;
    setHumanizing(true);
    try {
      const res = await fetch("/api/tts/humanize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text: node.messageContent.trim() }),
      });
      if (res.ok) {
        const { humanizedText } = await res.json();
        if (humanizedText) {
          onUpdate({ messageContent: humanizedText });
          toast({ title: "Texto humanizado", description: "O template foi reescrito com linguagem natural." });
        }
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: "Erro ao humanizar", description: data.error || "Tente novamente.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Erro ao humanizar", description: "Falha de conexão. Tente novamente.", variant: "destructive" });
    } finally { setHumanizing(false); }
  };

  const handlePreview = async () => {
    if (!node.mediaUrl || !node.messageContent?.trim()) return;
    setGenerating(true);
    setPreviewUrl(null);
    setPreviewError(null);
    try {
      const res = await fetch("/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          voiceProfileId: node.mediaUrl,
          text: node.messageContent.replace(/\{\{(\w+)\}\}/g, "[$1]"),
          speed,
          pitch,
          volume,
          pauseLevel,
          expressiveness,
          humanize,
        }),
      });
      if (res.ok) {
        const blob = await res.blob();
        setPreviewUrl(URL.createObjectURL(blob));
      } else {
        const data = await res.json().catch(() => ({}));
        if (data.step) {
          setPreviewError({ step: data.step, error: data.error || "Erro desconhecido", details: data.details });
        } else {
          setPreviewError({ step: "unknown", error: data.error || "Tente novamente.", details: null });
        }
      }
    } catch {
      setPreviewError({ step: "connection", error: "Falha de conexão. Tente novamente.", details: null });
    } finally { setGenerating(false); }
  };

  return (
    <div className="space-y-3">
      {selectedVoice && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-purple-50 border border-purple-200 text-[11px] text-purple-800">
          <Mic size={11} className="text-purple-500 flex-shrink-0" />
          <span className="font-semibold">🎙️ {selectedVoice.name}</span>
          <span className="text-purple-400">•</span>
          <span>{speed.toFixed(1)}x</span>
          <span className="text-purple-400">•</span>
          <span>Tom {pitch.toFixed(1)}x</span>
          <span className="text-purple-400">•</span>
          <span>{humanize ? "Natural" : "Literal"}</span>
        </div>
      )}

      <div>
        <label className="text-[11px] font-medium text-gray-500 mb-1 block">Perfil de Voz</label>
        <select
          value={node.mediaUrl}
          onChange={(e) => onUpdate({ mediaUrl: e.target.value })}
          className="w-full h-8 text-sm border border-gray-200 rounded-md px-2 bg-white"
        >
          <option value="">Selecione um perfil de voz…</option>
          {voiceProfileList.map((vp) => (
            <option key={vp.id} value={vp.id}>{vp.name} ({vp.gender})</option>
          ))}
        </select>
        {voiceProfileList.length === 0 && (
          <div className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-amber-50 border border-amber-200 mt-1">
            <Info size={12} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <span className="text-[11px] text-amber-700 flex-1">
              Nenhum perfil cadastrado.{" "}
              <a href="/voice-profiles" target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-amber-800 font-semibold underline hover:text-amber-900">
                Ir para Perfis de Voz
                <ExternalLink size={10} />
              </a>
            </span>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-medium text-gray-500">Template de texto</label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!node.messageContent?.trim() || humanizing}
            onClick={handleHumanize}
            className="h-6 px-2 text-[10px] text-purple-600 hover:text-purple-800 hover:bg-purple-50 gap-1"
          >
            {humanizing ? (
              <><Loader2 size={10} className="animate-spin" /> Humanizando…</>
            ) : (
              <><Sparkles size={10} /> Humanizar Texto</>
            )}
          </Button>
        </div>
        <Textarea
          value={node.messageContent}
          onChange={(e) => onUpdate({ messageContent: e.target.value })}
          className="text-sm min-h-[70px]"
          placeholder="Olá {{nome}}, seu pedido {{codigo_rastreio}} foi aprovado. Valor: {{valor}}."
        />
        <div className="flex flex-wrap gap-1 pt-1">
          {["{{nome}}", "{{telefone}}", "{{cpf}}", "{{produto}}", "{{valor}}", "{{codigo_rastreio}}"].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onUpdate({ messageContent: (node.messageContent || "") + v })}
              className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] font-medium text-gray-500 block mb-1">
            Velocidade: <span className="text-purple-600 font-semibold">{speed.toFixed(1)}x</span>
          </label>
          <input type="range" min={0.5} max={2.0} step={0.1} value={speed}
            onChange={(e) => update({ speed: parseFloat(e.target.value) })}
            className="w-full accent-purple-600" />
          <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
            <span>0.5x</span><span>1.0x</span><span>2.0x</span>
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-500 block mb-1">
            Tom (pitch): <span className="text-purple-600 font-semibold">{pitch.toFixed(1)}x</span>
          </label>
          <input type="range" min={0.5} max={2.0} step={0.1} value={pitch}
            onChange={(e) => update({ pitch: parseFloat(e.target.value) })}
            className="w-full accent-purple-600" />
          <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
            <span>Grave</span><span>Normal</span><span>Agudo</span>
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-500 block mb-1">
            Volume: <span className="text-purple-600 font-semibold">{Math.round(volume * 100)}%</span>
          </label>
          <input type="range" min={0.3} max={1.5} step={0.05} value={volume}
            onChange={(e) => update({ volume: parseFloat(e.target.value) })}
            className="w-full accent-purple-600" />
          <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
            <span>30%</span><span>100%</span><span>150%</span>
          </div>
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-500 block mb-1">
            Expressividade: <span className="text-purple-600 font-semibold">{expressiveness}/10</span>
          </label>
          <input type="range" min={1} max={10} step={1} value={expressiveness}
            onChange={(e) => update({ expressiveness: parseInt(e.target.value) })}
            className="w-full accent-purple-600" />
          <div className="flex justify-between text-[9px] text-gray-400 mt-0.5">
            <span>Neutro</span><span>Médio</span><span>Expressivo</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] font-medium text-gray-500 block mb-1">Nível de pausa</label>
          <select value={pauseLevel} onChange={(e) => update({ pauseLevel: parseInt(e.target.value) })}
            className="w-full h-8 text-[11px] border border-gray-200 rounded-md px-2 bg-white">
            <option value={0}>Nenhuma</option>
            <option value={1}>Suave</option>
            <option value={2}>Moderada</option>
            <option value={3}>Acentuada</option>
          </select>
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-500 block mb-1">Humanização</label>
          <button type="button" onClick={() => update({ humanize: !humanize })}
            className={`w-full h-8 text-[11px] font-medium rounded-md border transition-colors ${humanize ? "bg-purple-100 border-purple-300 text-purple-700" : "bg-gray-100 border-gray-200 text-gray-500"}`}>
            {humanize ? "✓ Natural (ativo)" : "Literal (desativado)"}
          </button>
        </div>
      </div>

      <div>
        <button type="button" onClick={handlePreview}
          disabled={!node.mediaUrl || !node.messageContent?.trim() || generating}
          className="w-full h-8 text-[11px] font-medium rounded-md border border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100 disabled:opacity-40 flex items-center justify-center gap-1.5 transition-colors">
          {generating ? <><Loader2 size={11} className="animate-spin" /> Gerando preview…</> : <><Volume2 size={11} /> Ouvir preview</>}
        </button>
        {previewError && (
          <div className="bg-red-50 border border-red-200 rounded-md p-2 text-[11px] space-y-0.5 mt-1.5">
            <div className="text-red-700 font-medium">Erro na geração TTS</div>
            <div className="text-red-600"><span className="font-medium">Etapa:</span> {previewError.step}</div>
            <div className="text-red-600"><span className="font-medium">Erro:</span> {previewError.error}</div>
            {previewError.details && (
              <div className="text-red-500 text-[10px] bg-red-100 rounded p-1 font-mono break-all">
                {typeof previewError.details === 'string' ? previewError.details : JSON.stringify(previewError.details)}
              </div>
            )}
            <button onClick={() => setPreviewError(null)} className="text-[10px] text-red-400 hover:text-red-600 underline">Fechar</button>
          </div>
        )}
        {previewUrl && (
          <audio controls src={previewUrl} className="w-full mt-1.5 h-8" />
        )}
      </div>
    </div>
  );
}
