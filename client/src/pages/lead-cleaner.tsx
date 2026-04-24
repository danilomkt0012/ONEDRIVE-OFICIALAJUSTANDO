import { useState, useRef, useCallback, useEffect } from "react";
import {
  Upload, Download, CheckCircle2, XCircle, Users, Trash2,
  Loader2, FileSpreadsheet, AlertTriangle, Activity, WifiOff,
  Clock, Gauge, FileText, ClipboardPaste, ShieldX,
  SplitSquareHorizontal, Signal, Smartphone, QrCode, Link, LogOut,
  RefreshCw, UserCheck, PhoneCall
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface ProgressData {
  phase: "parsing" | "normalizing" | "checking_cpf" | "complete" | "error";
  total: number;
  processed: number;
  valid: number;
  invalid: number;
  duplicates: number;
  invalidFormat: number;
  apiErrors: number;
  cacheHits: number;
  cpfInvalid: number;
  currentConcurrency?: number;
  speedPerSecond?: number;
  etaSeconds?: number;
  csvReady: boolean;
  errorMessage: string | null;
  fileCount?: number;
  leadsPerFile?: number;
}

interface FileInfo {
  index: number;
  filename: string;
  leads: number;
}

type WaStatus = "idle" | "waiting_qr" | "connected" | "disconnected" | "error";

interface WaState {
  status: WaStatus;
  qrCode?: string;
  phoneNumber?: string;
}

export default function LeadCleaner() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const qrPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [processId, setProcessId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [connected, setConnected] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [inputMode, setInputMode] = useState<"file" | "text" | "group">("text");
  const [leadsPerFile, setLeadsPerFile] = useState<string>("");
  const [fileList, setFileList] = useState<FileInfo[]>([]);

  // WhatsApp group extractor state
  const [waState, setWaState] = useState<WaState>({ status: "idle" });
  const [waLoading, setWaLoading] = useState(false);
  const [groupLink, setGroupLink] = useState("");
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (qrPollRef.current) clearInterval(qrPollRef.current);
    };
  }, []);

  // Restore existing WA session when user enters group mode
  useEffect(() => {
    if (inputMode !== "group") return;
    (async () => {
      try {
        const res = await fetch("/api/wa-extractor/status");
        if (res.ok) {
          const data = await res.json();
          if (data.status !== "idle") setWaState(data);
        }
      } catch {}
    })();
  }, [inputMode]);

  // Poll WA status every 3 seconds while waiting for QR scan or connected
  useEffect(() => {
    if (inputMode !== "group") {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
      return;
    }
    if (waState.status === "waiting_qr" || waState.status === "connected") {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
      qrPollRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/wa-extractor/status");
          if (res.ok) {
            const data = await res.json();
            setWaState(data);
            if (data.status === "disconnected" || data.status === "error") {
              if (qrPollRef.current) clearInterval(qrPollRef.current);
            }
          }
        } catch {}
      }, 3000);
    }
    return () => {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
    };
  }, [waState.status, inputMode]);

  const fetchFileList = useCallback(async (pid: string) => {
    try {
      const res = await fetch(`/api/lead-cleaner/files/${pid}`);
      if (res.ok) {
        const data = await res.json();
        setFileList(data.files || []);
      }
    } catch {}
  }, []);

  const connectSSE = useCallback((pid: string) => {
    eventSourceRef.current?.close();
    const es = new EventSource(`/api/lead-cleaner/progress/${pid}`);
    eventSourceRef.current = es;

    es.addEventListener("progress", (e) => {
      try {
        setProgress(JSON.parse(e.data));
        setConnected(true);
      } catch {}
    });

    es.addEventListener("complete", (e) => {
      try {
        const data = JSON.parse(e.data);
        setProgress(data);
        if ((data.fileCount || 0) >= 1) {
          fetchFileList(pid);
        }
      } catch {}
      es.close();
      setConnected(false);
    });

    es.onerror = () => { setConnected(false); };
  }, [fetchFileList]);

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    setProcessId(null);
    setProgress(null);
    setUploading(true);
    setConnected(false);
    setFileList([]);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const limit = parseInt(leadsPerFile) || 0;
      if (limit > 0) {
        formData.append("leadsPerFile", String(limit));
      }
      const res = await fetch("/api/lead-cleaner/start", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro no upload");
      }
      const data = await res.json();
      setProcessId(data.processId);
      connectSSE(data.processId);
    } catch (error: unknown) {
      toast({ title: "Erro", description: error instanceof Error ? error.message : "Erro desconhecido", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [connectSSE, toast, leadsPerFile]);

  const handleTextSubmit = useCallback(async () => {
    if (!pastedText.trim()) {
      toast({ title: "Erro", description: "Cole algum texto com leads", variant: "destructive" });
      return;
    }

    setFileName("Texto colado");
    setProcessId(null);
    setProgress(null);
    setUploading(true);
    setConnected(false);
    setFileList([]);

    try {
      const limit = parseInt(leadsPerFile) || 0;
      const res = await fetch("/api/lead-cleaner/start-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: pastedText, leadsPerFile: limit > 0 ? limit : undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao processar");
      }
      const data = await res.json();
      setProcessId(data.processId);
      connectSSE(data.processId);
    } catch (error: unknown) {
      toast({ title: "Erro", description: error instanceof Error ? error.message : "Erro desconhecido", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [pastedText, connectSSE, toast, leadsPerFile]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleReset = () => {
    eventSourceRef.current?.close();
    setProcessId(null);
    setProgress(null);
    setFileName("");
    setConnected(false);
    setPastedText("");
    setFileList([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── WhatsApp group extractor handlers ────────────────────────────────────

  const handleWaConnect = async () => {
    setWaLoading(true);
    try {
      const res = await fetch("/api/wa-extractor/start", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao iniciar sessão");
      }
      const data = await res.json();
      setWaState(data);
    } catch (error: unknown) {
      toast({ title: "Erro", description: error instanceof Error ? error.message : "Erro desconhecido", variant: "destructive" });
      setWaState({ status: "error" });
    } finally {
      setWaLoading(false);
    }
  };

  const handleWaDisconnect = async () => {
    setWaLoading(true);
    let success = false;
    try {
      const res = await fetch("/api/wa-extractor/disconnect", { method: "POST" });
      if (res.ok) {
        success = true;
      } else {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Aviso", description: (body as { error?: string }).error || "Erro ao desconectar", variant: "destructive" });
      }
    } catch (error: unknown) {
      toast({ title: "Aviso", description: error instanceof Error ? error.message : "Erro ao desconectar", variant: "destructive" });
    }
    if (success) {
      if (qrPollRef.current) clearInterval(qrPollRef.current);
      setWaState({ status: "disconnected" });
      setGroupLink("");
    }
    setWaLoading(false);
  };

  const handleWaRefreshQr = async () => {
    setWaLoading(true);
    try {
      const res = await fetch("/api/wa-extractor/status");
      if (res.ok) {
        const data = await res.json();
        setWaState(data);
      }
    } catch {}
    setWaLoading(false);
  };

  const handleExtractParticipants = async () => {
    if (!groupLink.trim()) {
      toast({ title: "Erro", description: "Cole o link do grupo WhatsApp", variant: "destructive" });
      return;
    }
    setExtracting(true);
    try {
      const res = await fetch("/api/wa-extractor/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteLink: groupLink.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Erro ao extrair participantes");
      }
      const data = await res.json();
      const { participants, count } = data as { participants: string[]; count: number };

      if (!participants || participants.length === 0) {
        toast({ title: "Aviso", description: "Nenhum participante encontrado no grupo", variant: "destructive" });
        return;
      }

      toast({ title: "Extraindo…", description: `${count} participantes encontrados — iniciando limpeza` });

      const text = participants.join("\n");
      setFileName(`Grupo WhatsApp (${count} participantes)`);
      setProcessId(null);
      setProgress(null);
      setUploading(true);
      setConnected(false);
      setFileList([]);

      const limit = parseInt(leadsPerFile) || 0;
      const startRes = await fetch("/api/lead-cleaner/start-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, leadsPerFile: limit > 0 ? limit : undefined }),
      });
      if (!startRes.ok) {
        const err = await startRes.json();
        throw new Error(err.error || "Erro ao processar");
      }
      const startData = await startRes.json();
      setProcessId(startData.processId);
      connectSSE(startData.processId);
    } catch (error: unknown) {
      toast({ title: "Erro", description: error instanceof Error ? error.message : "Erro desconhecido", variant: "destructive" });
    } finally {
      setExtracting(false);
      setUploading(false);
    }
  };

  // ── Derived state ─────────────────────────────────────────────────────────

  const phase = progress?.phase;
  const isProcessing = phase === "parsing" || phase === "normalizing" || phase === "checking_cpf";
  const isComplete = phase === "complete";
  const isError = phase === "error";

  const percent = !progress || progress.total === 0 ? 0
    : phase === "parsing" ? 5
    : phase === "normalizing" ? 15
    : phase === "checking_cpf" ? 15 + Math.round((progress.processed / progress.total) * 80)
    : phase === "complete" ? 100
    : 0;

  const showUpload = !processId && !uploading;
  const hasTwoFiles = (progress?.fileCount || 0) === 2 || fileList.length === 2;
  const hasMultipleFiles = (progress?.fileCount || 0) > 1 || fileList.length > 1;

  const formatETA = (s: number) => {
    if (s <= 0) return "--";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return `${m}m ${rest}s`;
  };

  const waStatusLabel: Record<WaStatus, string> = {
    idle: "Desconectado",
    waiting_qr: "Aguardando QR Code…",
    connected: "Conectado",
    disconnected: "Desconectado",
    error: "Erro na conexão",
  };

  const waStatusColor: Record<WaStatus, string> = {
    idle: "text-[#718096]",
    waiting_qr: "text-[#D69E2E]",
    connected: "text-[#38A169]",
    disconnected: "text-[#718096]",
    error: "text-[#E53E3E]",
  };

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-4 sm:space-y-6">

      <div className="saas-card p-5 border-l-4 border-l-[#0066FF]">
        <div className="flex items-center gap-3">
          <Activity size={20} className="text-[#0066FF]" />
          <div>
            <h2 className="text-base font-bold text-[#1A202C]">Lead Cleaner</h2>
            <p className="text-xs text-[#718096]">Upload, cole ou importe de grupo — parsing, deduplicação, validação de CPF e download direto</p>
          </div>
        </div>
      </div>

      {showUpload && (
        <div className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setInputMode("text")}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                inputMode === "text"
                  ? "bg-[#0066FF] text-white shadow-sm"
                  : "bg-white text-[#718096] border border-[#E2E8F0] hover:border-[#0066FF]/40"
              }`}
            >
              <ClipboardPaste size={16} /> Colar Texto
            </button>
            <button
              onClick={() => setInputMode("file")}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                inputMode === "file"
                  ? "bg-[#0066FF] text-white shadow-sm"
                  : "bg-white text-[#718096] border border-[#E2E8F0] hover:border-[#0066FF]/40"
              }`}
            >
              <Upload size={16} /> Enviar Arquivo
            </button>
            <button
              onClick={() => setInputMode("group")}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                inputMode === "group"
                  ? "bg-[#25D366] text-white shadow-sm"
                  : "bg-white text-[#718096] border border-[#E2E8F0] hover:border-[#25D366]/40"
              }`}
            >
              <Smartphone size={16} /> Importar do Grupo
            </button>
          </div>

          {inputMode !== "group" && (
            <div className="saas-card p-4">
              <div className="flex items-center gap-3">
                <SplitSquareHorizontal size={18} className="text-[#0066FF] flex-shrink-0" />
                <div className="flex-1">
                  <label className="text-sm font-medium text-[#1A202C] block mb-1">
                    Quantidade de leads para o arquivo principal
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      placeholder="Ex: 500 (vazio = todos em 1 arquivo)"
                      value={leadsPerFile}
                      onChange={(e) => setLeadsPerFile(e.target.value)}
                      className="w-full max-w-xs h-10 px-3 rounded-lg border border-[#CBD5E0] focus:border-[#0066FF] focus:ring-2 focus:ring-[#0066FF]/20 outline-none text-sm text-[#1A202C] bg-white placeholder:text-[#A0AEC0] transition-all"
                    />
                    <span className="text-xs text-[#A0AEC0] whitespace-nowrap">
                      {parseInt(leadsPerFile) > 0
                        ? `Gera principal com ${parseInt(leadsPerFile)} + arquivo de sobra`
                        : "Todos os leads em 1 arquivo"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {inputMode === "text" && (
            <div className="space-y-3">
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                placeholder={"Cole aqui sua lista em qualquer formato...\n\nExemplos aceitos:\nJoão Silva 91988887777 12345678909\nMARIA,55219877776666,98765432100\nPedro 11 98765-4321\n(85) 99876-5432 Ana Costa\n\nAceita qualquer formato, títulos, endereços, vírgulas, tabulações..."}
                className="w-full h-56 sm:h-72 p-4 rounded-lg border-2 border-[#CBD5E0] focus:border-[#0066FF] focus:ring-2 focus:ring-[#0066FF]/20 outline-none resize-none text-sm font-mono text-[#1A202C] bg-white placeholder:text-[#A0AEC0] transition-all"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#A0AEC0]">
                  {pastedText.trim().split(/\r?\n/).filter(l => l.trim()).length} linhas detectadas
                </span>
                <Button
                  onClick={handleTextSubmit}
                  disabled={!pastedText.trim()}
                  className="h-11 px-6 bg-[#0066FF] hover:bg-[#0052CC] text-white text-sm font-semibold gap-2 min-h-[44px]"
                >
                  <Activity size={16} /> Processar Lista
                </Button>
              </div>
            </div>
          )}

          {inputMode === "file" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`saas-card p-8 sm:p-16 flex flex-col items-center justify-center cursor-pointer transition-all border-2 border-dashed ${
                dragOver ? "border-[#0066FF] bg-[#EBF4FF]" : "border-[#CBD5E0] hover:border-[#0066FF]/40"
              }`}
            >
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.txt" onChange={onFileSelect} className="hidden" />
              <Upload className="w-14 h-14 text-[#A0AEC0] mb-4" />
              <h3 className="text-lg font-semibold text-[#1A202C] mb-1">Arraste o arquivo aqui</h3>
              <p className="text-sm text-[#A0AEC0]">CSV, XLSX, TXT</p>
            </div>
          )}

          {inputMode === "group" && (
            <div className="space-y-4">
              <div className="saas-card p-4 border border-[#C6F6D5] bg-[#F0FFF4]">
                <div className="flex items-start gap-3">
                  <Smartphone size={18} className="text-[#25D366] mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-[#2D6A4F] leading-relaxed space-y-1">
                    <p className="font-semibold text-sm text-[#1A202C]">Importar Participantes de Grupo WhatsApp</p>
                    <p>Conecte seu número pessoal via QR Code para extrair os telefones dos participantes de qualquer grupo.</p>
                    <p className="text-[#718096]">Somente leitura — nenhuma mensagem será enviada. Isolado do sistema principal.</p>
                  </div>
                </div>
              </div>

              {/* Connection panel */}
              <div className="saas-card p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <PhoneCall size={16} className={waStatusColor[waState.status]} />
                    <span className={`text-sm font-medium ${waStatusColor[waState.status]}`}>
                      {waStatusLabel[waState.status]}
                    </span>
                    {waState.phoneNumber && waState.status === "connected" && (
                      <span className="text-xs text-[#718096] bg-[#EDF2F7] px-2 py-0.5 rounded-full">
                        +{waState.phoneNumber}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {(waState.status === "idle" || waState.status === "disconnected" || waState.status === "error") && (
                      <Button
                        onClick={handleWaConnect}
                        disabled={waLoading}
                        className="h-9 px-4 bg-[#25D366] hover:bg-[#1EB85A] text-white text-sm font-semibold gap-2"
                      >
                        {waLoading ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />}
                        Conectar via QR
                      </Button>
                    )}
                    {(waState.status === "waiting_qr" || waState.status === "connected") && (
                      <Button
                        onClick={handleWaDisconnect}
                        disabled={waLoading}
                        variant="outline"
                        className="h-9 px-4 text-sm font-semibold gap-2 border-[#E53E3E] text-[#E53E3E] hover:bg-red-50"
                      >
                        <LogOut size={14} /> Desconectar
                      </Button>
                    )}
                  </div>
                </div>
                {waState.status === "idle" && (
                  <p className="text-xs text-[#A0AEC0] mt-1">
                    Se houver uma sessão anterior, ela será restaurada automaticamente ao conectar.
                  </p>
                )}
                {(waState.status === "disconnected" || waState.status === "error") && (
                  <p className="text-xs text-[#A0AEC0] mt-1">
                    Desconectado — credenciais removidas. Escaneie o QR code para iniciar uma nova sessão.
                  </p>
                )}

                {/* QR Code display */}
                {waState.status === "waiting_qr" && (
                  <div className="flex flex-col items-center gap-4 py-4">
                    {waState.qrCode ? (
                      <div className="space-y-3 flex flex-col items-center">
                        <p className="text-sm text-[#718096] text-center">
                          Abra o WhatsApp no celular → Dispositivos Conectados → Conectar Dispositivo
                        </p>
                        <div className="border-4 border-[#25D366] rounded-2xl p-3 bg-white shadow-md">
                          <img src={waState.qrCode} alt="QR Code WhatsApp" className="w-52 h-52" />
                        </div>
                        <button
                          onClick={handleWaRefreshQr}
                          className="flex items-center gap-1.5 text-xs text-[#718096] hover:text-[#0066FF] transition-colors"
                        >
                          <RefreshCw size={12} /> Atualizar QR
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-3 py-6">
                        <Loader2 size={32} className="text-[#25D366] animate-spin" />
                        <p className="text-sm text-[#718096]">Gerando QR Code…</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Connected state — group link input */}
                {waState.status === "connected" && (
                  <div className="space-y-3 pt-2 border-t border-[#E2E8F0]">
                    <div className="flex items-center gap-2 text-sm text-[#38A169]">
                      <UserCheck size={16} />
                      <span className="font-medium">Sessão ativa — cole o link do grupo para extrair participantes</span>
                    </div>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Link size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A0AEC0]" />
                        <input
                          type="text"
                          value={groupLink}
                          onChange={(e) => setGroupLink(e.target.value)}
                          placeholder="https://chat.whatsapp.com/XXXXXXXXXXXXXX"
                          className="w-full h-11 pl-9 pr-4 rounded-lg border border-[#CBD5E0] focus:border-[#25D366] focus:ring-2 focus:ring-[#25D366]/20 outline-none text-sm text-[#1A202C] bg-white placeholder:text-[#A0AEC0] transition-all"
                        />
                      </div>
                      <Button
                        onClick={handleExtractParticipants}
                        disabled={extracting || !groupLink.trim()}
                        className="h-11 px-5 bg-[#25D366] hover:bg-[#1EB85A] text-white text-sm font-semibold gap-2 whitespace-nowrap"
                      >
                        {extracting ? <Loader2 size={15} className="animate-spin" /> : <Users size={15} />}
                        Extrair Participantes
                      </Button>
                    </div>
                    <p className="text-xs text-[#A0AEC0]">
                      Os números extraídos serão automaticamente processados pelo Lead Cleaner (deduplicação + validação).
                      Links expirados, privados ou com restrição de acesso podem retornar erro — use um link de convite válido e recente.
                    </p>
                  </div>
                )}
              </div>

              {/* leadsPerFile for group mode */}
              {waState.status === "connected" && (
                <div className="saas-card p-4">
                  <div className="flex items-center gap-3">
                    <SplitSquareHorizontal size={18} className="text-[#25D366] flex-shrink-0" />
                    <div className="flex-1">
                      <label className="text-sm font-medium text-[#1A202C] block mb-1">
                        Quantidade de leads para o arquivo principal
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          placeholder="Ex: 500 (vazio = todos em 1 arquivo)"
                          value={leadsPerFile}
                          onChange={(e) => setLeadsPerFile(e.target.value)}
                          className="w-full max-w-xs h-10 px-3 rounded-lg border border-[#CBD5E0] focus:border-[#25D366] focus:ring-2 focus:ring-[#25D366]/20 outline-none text-sm text-[#1A202C] bg-white placeholder:text-[#A0AEC0] transition-all"
                        />
                        <span className="text-xs text-[#A0AEC0] whitespace-nowrap">
                          {parseInt(leadsPerFile) > 0
                            ? `Gera principal com ${parseInt(leadsPerFile)} + arquivo de sobra`
                            : "Todos os leads em 1 arquivo"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {uploading && (
        <div className="saas-card p-12 flex flex-col items-center justify-center">
          <Loader2 className="w-12 h-12 text-[#0066FF] animate-spin mb-4" />
          <p className="text-[#1A202C] font-medium">Processando...</p>
        </div>
      )}

      {processId && !progress && !uploading && (
        <div className="saas-card p-12 flex flex-col items-center justify-center">
          <Loader2 className="w-12 h-12 text-[#0066FF] animate-spin mb-4" />
          <p className="text-[#1A202C] font-medium">Processando lista...</p>
          <p className="text-sm text-[#A0AEC0] mt-1">{fileName}</p>
        </div>
      )}

      {processId && progress && (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileSpreadsheet className="w-5 h-5 text-[#0066FF]" />
              <span className="text-sm font-medium text-[#1A202C]">{fileName}</span>
              {connected && (
                <span className="flex items-center gap-1 text-xs text-[#38A169]">
                  <Signal size={12} className="animate-pulse" /> AO VIVO
                </span>
              )}
              {!connected && isProcessing && (
                <span className="flex items-center gap-1 text-xs text-[#D69E2E]">
                  <WifiOff size={12} /> Reconectando...
                </span>
              )}
            </div>
            {isComplete && (
              <button onClick={handleReset} className="flex items-center gap-1.5 text-xs text-[#718096] hover:text-[#1A202C] transition-colors">
                <Trash2 size={14} /> Nova Lista
              </button>
            )}
          </div>

          <div className="saas-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-[#1A202C]">
                {phase === "parsing" && "Lendo dados..."}
                {phase === "normalizing" && "Normalizando números..."}
                {phase === "checking_cpf" && "Validando CPFs..."}
                {phase === "complete" && "Processamento concluído!"}
                {phase === "error" && "Erro no processamento"}
              </span>
              <span className="text-sm font-bold text-[#1A202C]">{percent}%</span>
            </div>
            <div className="progress-bar-saas">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${
                  isError ? "bg-[#E53E3E]" : isComplete ? "bg-[#38A169]" : "bg-[#0066FF]"
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
            {phase === "checking_cpf" && (
              <div className="mt-2 flex items-center justify-between text-xs text-[#718096]">
                <span>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()}</span>
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1">
                    <Gauge size={12} /> {progress.speedPerSecond ?? 0} /s
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} /> ETA {formatETA(progress.etaSeconds ?? 0)}
                  </span>
                </div>
              </div>
            )}
            {isError && progress.errorMessage && (
              <div className="mt-3 flex items-center gap-2 text-sm text-[#E53E3E]">
                <AlertTriangle size={16} />
                <span>{progress.errorMessage}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <MetricCard label="Total" value={progress.total} color="slate" icon={<Users size={16} />} />
            <MetricCard label="Formato Inválido" value={progress.invalidFormat} color="red" icon={<XCircle size={16} />} />
            <MetricCard label="Duplicados" value={progress.duplicates} color="amber" icon={<XCircle size={16} />} />
            <MetricCard label="CPF Inválido" value={progress.cpfInvalid ?? 0} color="red" icon={<ShieldX size={16} />} active={phase === "checking_cpf"} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3">
            <MetricCard label="Válidos" value={progress.valid} color="emerald" icon={<CheckCircle2 size={16} />} active={isProcessing} />
            <MetricCard label="Erros API" value={progress.apiErrors} color="amber" icon={<AlertTriangle size={16} />} active={isProcessing} />
            <MetricCard label="Processados" value={progress.processed} color="blue" icon={<Gauge size={16} />} active={isProcessing} />
          </div>

          {isComplete && (
            <div className="saas-card p-6 border border-green-200 bg-green-50">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                      <CheckCircle2 className="text-[#38A169]" size={20} />
                    </div>
                    <div>
                      <p className="text-[#1A202C] font-semibold">Lista pronta!</p>
                      <p className="text-sm text-[#718096]">
                        {progress.valid.toLocaleString()} leads válidos
                        {hasMultipleFiles && ` divididos em ${progress.fileCount || fileList.length} arquivos`}
                      </p>
                    </div>
                  </div>
                  {!hasMultipleFiles && (
                    <div className="flex gap-2 w-full sm:w-auto">
                      <a href={`/api/lead-cleaner/download/${processId}`} download className="flex-1 sm:flex-none">
                        <Button className="h-12 px-6 bg-[#38A169] hover:bg-[#2F855A] text-white text-sm font-semibold gap-2 w-full min-h-[44px]">
                          <Download size={18} /> Baixar Lista
                        </Button>
                      </a>
                      <a href={`/api/lead-cleaner/download-log/${processId}`} download className="flex-1 sm:flex-none">
                        <Button variant="outline" className="h-12 px-6 text-sm font-semibold gap-2 w-full min-h-[44px] border-[#38A169] text-[#38A169] hover:bg-green-50">
                          <FileText size={18} /> Log
                        </Button>
                      </a>
                    </div>
                  )}
                </div>

                {hasMultipleFiles && fileList.length > 0 && (
                  <div className="space-y-2">
                    <div className="grid gap-2">
                      {fileList.map((f, idx) => {
                        const isPrincipal = idx === 0;
                        const label = hasTwoFiles
                          ? (isPrincipal ? "Arquivo Principal" : "Sobra")
                          : `Arquivo ${f.index + 1}`;
                        const badgeColor = isPrincipal
                          ? "bg-[#EBF8FF] text-[#2B6CB0] border border-[#90CDF4]"
                          : "bg-[#FFFBEB] text-[#B7791F] border border-[#FAD089]";

                        return (
                          <div key={f.index} className="flex items-center justify-between bg-white rounded-lg px-4 py-3 border border-green-200">
                            <div className="flex items-center gap-3">
                              <FileSpreadsheet size={16} className={isPrincipal ? "text-[#38A169]" : "text-[#D69E2E]"} />
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium text-[#1A202C]">{label}</p>
                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${badgeColor}`}>
                                    {isPrincipal ? "PRINCIPAL" : "SOBRA"}
                                  </span>
                                </div>
                                <p className="text-xs text-[#718096]">{f.leads.toLocaleString()} leads · {f.filename}</p>
                              </div>
                            </div>
                            <a href={`/api/lead-cleaner/download/${processId}?file=${f.index}`} download>
                              <Button size="sm" className={`h-9 px-4 text-white text-xs font-semibold gap-1.5 ${isPrincipal ? "bg-[#38A169] hover:bg-[#2F855A]" : "bg-[#D69E2E] hover:bg-[#B7791F]"}`}>
                                <Download size={14} /> Baixar
                              </Button>
                            </a>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-end">
                      <a href={`/api/lead-cleaner/download-log/${processId}`} download>
                        <Button variant="outline" className="h-10 px-5 text-sm font-semibold gap-2 border-[#38A169] text-[#38A169] hover:bg-green-50">
                          <FileText size={16} /> Baixar Log
                        </Button>
                      </a>
                    </div>
                  </div>
                )}

                {hasMultipleFiles && fileList.length === 0 && (
                  <div className="flex gap-2 w-full sm:w-auto">
                    <a href={`/api/lead-cleaner/download/${processId}`} download className="flex-1 sm:flex-none">
                      <Button className="h-12 px-6 bg-[#38A169] hover:bg-[#2F855A] text-white text-sm font-semibold gap-2 w-full min-h-[44px]">
                        <Download size={18} /> Baixar Lista
                      </Button>
                    </a>
                    <a href={`/api/lead-cleaner/download-log/${processId}`} download className="flex-1 sm:flex-none">
                      <Button variant="outline" className="h-12 px-6 text-sm font-semibold gap-2 w-full min-h-[44px] border-[#38A169] text-[#38A169] hover:bg-green-50">
                        <FileText size={18} /> Log
                      </Button>
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MetricCard({
  label, value, color, icon, active
}: {
  label: string; value: number; color: string; icon: React.ReactNode; active?: boolean;
}) {
  const colorMap: Record<string, string> = {
    slate: "text-[#718096]",
    blue: "text-[#0066FF]",
    emerald: "text-[#38A169]",
    amber: "text-[#D69E2E]",
    red: "text-[#E53E3E]",
  };
  return (
    <div className={`saas-card p-3.5 ${active ? "ring-1 ring-[#0066FF]/30" : ""}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={colorMap[color] || "text-[#718096]"}>{icon}</span>
        <span className="text-[11px] text-[#718096] font-medium truncate">{label}</span>
      </div>
      <span className={`text-xl font-bold text-[#1A202C] ${active ? "tabular-nums" : ""}`}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}
