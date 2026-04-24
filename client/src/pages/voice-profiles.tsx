import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Mic, Trash2, Plus, Upload, RefreshCw, CheckCircle, AlertCircle, Loader2, Volume2, X, Play, Square,
} from "lucide-react";

interface VoiceProfile {
  id: string;
  name: string;
  gender: string;
  createdAt: string;
}

interface TtsStatus {
  available: boolean;
  modelLoaded: boolean;
  modelLoading: boolean;
  queue?: { pending: number; active: number };
}

export default function VoiceProfilesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newGender, setNewGender] = useState("feminina");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const [previewText, setPreviewText] = useState("Olá, este é um teste da voz clonada.");
  const [previewVoiceId, setPreviewVoiceId] = useState("");
  const [previewSpeed, setPreviewSpeed] = useState(1.0);
  const [previewHumanize, setPreviewHumanize] = useState(true);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<{ step: string; error: string; details: any } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editGender, setEditGender] = useState("feminina");
  const [playingRefId, setPlayingRefId] = useState<string | null>(null);
  const refAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({});

  const { data: profiles = [], isLoading } = useQuery<VoiceProfile[]>({
    queryKey: ["/api/voices"],
    staleTime: 10_000,
  });

  const { data: ttsStatus } = useQuery<TtsStatus>({
    queryKey: ["/api/tts/status"],
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !data.available || data.modelLoading) return 5_000;
      return 30_000;
    },
    staleTime: 4_000,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!newName.trim() || !selectedFile) throw new Error("Nome e arquivo são obrigatórios");
      const formData = new FormData();
      formData.append("name", newName.trim());
      formData.append("gender", newGender);
      formData.append("audio", selectedFile);
      const res = await fetch("/api/voices", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao criar perfil");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Perfil criado", description: "Perfil de voz criado com sucesso." });
      setNewName("");
      setNewGender("feminina");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setShowCreateModal(false);
      queryClient.invalidateQueries({ queryKey: ["/api/voices"] });
    },
    onError: (err: any) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, name, gender }: { id: string; name: string; gender: string }) => {
      const res = await apiRequest("PUT", `/api/voices/${id}`, { name, gender });
      return res;
    },
    onSuccess: () => {
      toast({ title: "Atualizado", description: "Perfil atualizado com sucesso." });
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/voices"] });
    },
    onError: (err: any) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/voices/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Deletado", description: "Perfil de voz removido." });
      queryClient.invalidateQueries({ queryKey: ["/api/voices"] });
    },
    onError: (err: any) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const handlePreview = async () => {
    if (!previewVoiceId || !previewText.trim()) {
      toast({ title: "Preencha os campos", description: "Selecione um perfil e escreva um texto.", variant: "destructive" });
      return;
    }
    setGeneratingPreview(true);
    setPreviewAudioUrl(null);
    setPreviewError(null);
    try {
      const res = await fetch("/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ voiceProfileId: previewVoiceId, text: previewText, speed: previewSpeed, humanize: previewHumanize }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (errData.step) {
          setPreviewError({ step: errData.step, error: errData.error || "Erro desconhecido", details: errData.details });
        } else {
          setPreviewError({ step: "unknown", error: errData.error || "Erro ao gerar áudio", details: null });
        }
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPreviewAudioUrl(url);
    } catch (err: any) {
      setPreviewError({ step: "connection", error: err.message || "Falha de conexão", details: null });
    } finally {
      setGeneratingPreview(false);
    }
  };

  const toggleRefAudio = (profileId: string) => {
    const audio = refAudioRefs.current[profileId];
    if (!audio) return;
    if (playingRefId === profileId) {
      audio.pause();
      audio.currentTime = 0;
      setPlayingRefId(null);
    } else {
      if (playingRefId) {
        const prev = refAudioRefs.current[playingRefId];
        if (prev) { prev.pause(); prev.currentTime = 0; }
      }
      audio.play().catch(() => {});
      setPlayingRefId(profileId);
      audio.onended = () => setPlayingRefId(null);
    }
  };

  const startEdit = (profile: VoiceProfile) => {
    setEditingId(profile.id);
    setEditName(profile.name);
    setEditGender(profile.gender);
  };

  const openCreateModal = () => {
    setNewName("");
    setNewGender("feminina");
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setShowCreateModal(true);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Mic size={24} className="text-purple-500" />
            Perfis de Voz TTS
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Cadastre áudios de referência para clonar vozes em campanhas e bot flows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs">
            {ttsStatus?.available ? (
              ttsStatus.modelLoaded ? (
                <span className="flex items-center gap-1 text-green-600 bg-green-50 border border-green-200 px-2 py-1 rounded-full">
                  <CheckCircle size={11} /> Modelo pronto
                  {ttsStatus.queue && (ttsStatus.queue.pending > 0 || ttsStatus.queue.active > 0) && (
                    <span className="text-green-500 ml-1">· {ttsStatus.queue.active} ativo / {ttsStatus.queue.pending} na fila</span>
                  )}
                </span>
              ) : ttsStatus.modelLoading ? (
                <span className="flex items-center gap-1 text-yellow-700 bg-yellow-50 border border-yellow-200 px-2 py-1 rounded-full">
                  <Loader2 size={11} className="animate-spin" /> Carregando modelo…
                </span>
              ) : (
                <span className="flex items-center gap-1 text-red-600 bg-red-50 border border-red-200 px-2 py-1 rounded-full">
                  <AlertCircle size={11} /> Erro ao carregar modelo
                </span>
              )
            ) : (
              <span className="flex items-center gap-1 text-gray-400 bg-gray-100 border border-gray-200 px-2 py-1 rounded-full">
                <AlertCircle size={11} /> Serviço TTS offline
              </span>
            )}
          </div>
          <Button onClick={openCreateModal} className="bg-purple-600 hover:bg-purple-700 text-white h-9 text-sm">
            <Plus size={14} className="mr-1" /> Novo Perfil
          </Button>
        </div>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800 flex items-center gap-2">
                <Plus size={16} className="text-purple-500" /> Novo Perfil de Voz
              </h2>
              <button onClick={() => setShowCreateModal(false)} className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Nome do perfil</label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Ex: Atendente Feminina"
                  className="h-9 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 block mb-1">Gênero</label>
                <select
                  value={newGender}
                  onChange={(e) => setNewGender(e.target.value)}
                  className="w-full h-9 text-sm border border-gray-200 rounded-md px-2 bg-white"
                >
                  <option value="feminina">Feminina</option>
                  <option value="masculina">Masculina</option>
                  <option value="neutro">Neutro</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Áudio de referência (mínimo 6 segundos, idealmente 10–30s)
              </label>
              <div
                className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center cursor-pointer hover:border-purple-300 hover:bg-purple-50/30 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {selectedFile ? (
                  <div className="flex items-center justify-center gap-2 text-sm text-purple-700">
                    <Mic size={16} />
                    <span className="font-medium">{selectedFile.name}</span>
                    <span className="text-gray-400">({(selectedFile.size / 1024).toFixed(0)} KB)</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Upload size={20} className="mx-auto text-gray-300" />
                    <p className="text-sm text-gray-400">Clique para selecionar ou arraste o arquivo</p>
                    <p className="text-xs text-gray-300">WAV, MP3, OGG, M4A, WebM — máx. 50 MB</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                onClick={() => createMutation.mutate()}
                disabled={!newName.trim() || !selectedFile || createMutation.isPending}
                className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
              >
                {createMutation.isPending ? (
                  <><Loader2 size={14} className="animate-spin mr-2" /> Criando…</>
                ) : (
                  <><Plus size={14} className="mr-2" /> Criar Perfil</>
                )}
              </Button>
              <Button variant="outline" onClick={() => setShowCreateModal(false)} className="flex-1">
                Cancelar
              </Button>
            </div>
          </div>
        </div>
      )}

      {profiles.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <Volume2 size={15} /> Testar Voz (Preview)
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Perfil de voz</label>
              <select
                value={previewVoiceId}
                onChange={(e) => setPreviewVoiceId(e.target.value)}
                className="w-full h-9 text-sm border border-gray-200 rounded-md px-2 bg-white"
              >
                <option value="">Selecione…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Texto de teste</label>
              <Input
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                className="h-9 text-sm"
                placeholder="Olá, este é um teste."
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">
                Velocidade: <span className="text-purple-600 font-semibold">{previewSpeed.toFixed(1)}x</span>
              </label>
              <input
                type="range"
                min={0.5} max={2.0} step={0.1}
                value={previewSpeed}
                onChange={(e) => setPreviewSpeed(parseFloat(e.target.value))}
                className="w-full accent-purple-600"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 block mb-1">Humanização</label>
              <button
                type="button"
                onClick={() => setPreviewHumanize(!previewHumanize)}
                className={`w-full h-9 text-sm font-medium rounded-md border transition-colors ${previewHumanize ? "bg-purple-100 border-purple-300 text-purple-700" : "bg-gray-100 border-gray-200 text-gray-500"}`}
              >
                {previewHumanize ? "✓ Natural (ativo)" : "Literal"}
              </button>
            </div>
          </div>
          <Button
            onClick={handlePreview}
            disabled={!previewVoiceId || !previewText.trim() || generatingPreview}
            variant="outline"
            className="w-full border-purple-200 text-purple-700 hover:bg-purple-50"
          >
            {generatingPreview ? (
              <><Loader2 size={14} className="animate-spin mr-2" /> Gerando áudio…</>
            ) : (
              <><Volume2 size={14} className="mr-2" /> Gerar Preview</>
            )}
          </Button>
          {previewError && (
            previewError.details?.modelLoading ? (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm space-y-1">
                <div className="flex items-center gap-1.5 text-yellow-700 font-medium">
                  <Loader2 size={14} className="animate-spin" /> Modelo TTS carregando…
                </div>
                <div className="text-yellow-600">O modelo está sendo carregado. Tente novamente em alguns instantes.</div>
                <button onClick={() => setPreviewError(null)} className="text-xs text-yellow-500 hover:text-yellow-700 underline mt-1">Fechar</button>
              </div>
            ) : (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm space-y-1">
                <div className="flex items-center gap-1.5 text-red-700 font-medium">
                  <AlertCircle size={14} /> Erro na geração TTS
                </div>
                <div className="text-red-600"><span className="font-medium">Etapa:</span> {previewError.step}</div>
                <div className="text-red-600"><span className="font-medium">Erro:</span> {previewError.error}</div>
                {previewError.details && (
                  <div className="text-red-500 text-xs mt-1 bg-red-100 rounded p-1.5 font-mono break-all">
                    {typeof previewError.details === 'string' ? previewError.details : JSON.stringify(previewError.details)}
                  </div>
                )}
                <button onClick={() => setPreviewError(null)} className="text-xs text-red-400 hover:text-red-600 underline mt-1">Fechar</button>
              </div>
            )
          )}
          {previewAudioUrl && (
            <audio controls src={previewAudioUrl} className="w-full h-10" />
          )}
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Mic size={15} /> Perfis Cadastrados {isLoading && <Loader2 size={12} className="animate-spin text-gray-400" />}
        </h2>
        {!isLoading && profiles.length === 0 && (
          <div className="bg-gray-50 border border-dashed border-gray-200 rounded-lg p-8 text-center">
            <Mic size={32} className="mx-auto text-gray-200 mb-2" />
            <p className="text-sm text-gray-400">Nenhum perfil de voz cadastrado ainda.</p>
            <button onClick={openCreateModal} className="mt-3 text-sm text-purple-600 hover:underline font-medium">
              Criar primeiro perfil
            </button>
          </div>
        )}
        {profiles.map((profile) => (
          <div key={profile.id} className="bg-white border border-gray-200 rounded-lg p-4">
            {editingId === profile.id ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-8 text-sm"
                    placeholder="Nome do perfil"
                  />
                  <select
                    value={editGender}
                    onChange={(e) => setEditGender(e.target.value)}
                    className="h-8 text-sm border border-gray-200 rounded-md px-2 bg-white"
                  >
                    <option value="feminina">Feminina</option>
                    <option value="masculina">Masculina</option>
                    <option value="neutro">Neutro</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => updateMutation.mutate({ id: profile.id, name: editName, gender: editGender })}
                    disabled={!editName.trim() || updateMutation.isPending}
                    className="bg-purple-600 hover:bg-purple-700 text-white h-7 text-xs"
                  >
                    {updateMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : "Salvar"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} className="h-7 text-xs">
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                      <Mic size={16} className="text-purple-500" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-800">{profile.name}</p>
                      <p className="text-xs text-gray-400 capitalize">
                        Voz {profile.gender} · Criado em {new Date(profile.createdAt).toLocaleDateString("pt-BR")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleRefAudio(profile.id)}
                      className={`p-1.5 rounded transition-colors ${playingRefId === profile.id ? "text-purple-600 bg-purple-50" : "text-gray-400 hover:text-purple-600 hover:bg-purple-50"}`}
                      title="Ouvir áudio de referência"
                    >
                      {playingRefId === profile.id ? <Square size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      onClick={() => startEdit(profile)}
                      className="p-1.5 text-gray-400 hover:text-purple-600 rounded hover:bg-purple-50 transition-colors"
                      title="Editar nome"
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Deletar o perfil "${profile.name}"?`)) {
                          deleteMutation.mutate(profile.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      className="p-1.5 text-gray-400 hover:text-red-500 rounded hover:bg-red-50 transition-colors"
                      title="Deletar perfil"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <audio
                  ref={(el) => { refAudioRefs.current[profile.id] = el; }}
                  src={`/api/voices/${profile.id}/audio`}
                  preload="none"
                  className="w-full h-8"
                  controls
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
