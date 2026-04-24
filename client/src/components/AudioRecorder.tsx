import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Mic, Square, Loader2 } from "lucide-react";

interface AudioRecorderProps {
  onRecorded: (url: string) => void;
  uploadUrl?: string;
  fieldName?: string;
}

const MIME_CANDIDATES: { mime: string; ext: string }[] = [
  { mime: "audio/ogg; codecs=opus", ext: ".ogg" },
  { mime: "audio/webm; codecs=opus", ext: ".webm" },
  { mime: "audio/webm", ext: ".webm" },
  { mime: "audio/mp4", ext: ".mp4" },
];

function getSupportedMime(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mime)) {
      return candidate;
    }
  }
  return null;
}

export default function AudioRecorder({
  onRecorded,
  uploadUrl = "/api/bot/rules/upload-media",
  fieldName = "media",
}: AudioRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [supported, setSupported] = useState(true);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedMimeRef = useRef<{ mime: string; ext: string } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    const hasMic = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const hasRecorder = typeof MediaRecorder !== "undefined";
    const mimeInfo = getSupportedMime();
    if (!hasMic || !hasRecorder || !mimeInfo) {
      setSupported(false);
    } else {
      selectedMimeRef.current = mimeInfo;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const startRecording = useCallback(async () => {
    const mimeInfo = selectedMimeRef.current || getSupportedMime();
    if (!mimeInfo) {
      toast({
        title: "Formato não suportado",
        description: "Seu navegador não suporta nenhum formato de gravação de áudio compatível.",
        variant: "destructive",
      });
      return;
    }
    selectedMimeRef.current = mimeInfo;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];

      let recorder: MediaRecorder;
      let activeMime = mimeInfo;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mimeInfo.mime });
      } catch {
        let fallbackRecorder: MediaRecorder | null = null;
        for (const candidate of MIME_CANDIDATES) {
          if (candidate.mime === mimeInfo.mime) continue;
          try {
            fallbackRecorder = new MediaRecorder(stream, { mimeType: candidate.mime });
            activeMime = candidate;
            break;
          } catch {
            continue;
          }
        }
        if (!fallbackRecorder) {
          stream.getTracks().forEach((t) => t.stop());
          toast({
            title: "Formato não suportado",
            description: "Seu navegador não suporta nenhum formato de gravação de áudio compatível.",
            variant: "destructive",
          });
          return;
        }
        recorder = fallbackRecorder;
      }
      selectedMimeRef.current = activeMime;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        const usedMime = selectedMimeRef.current || activeMime;
        const blob = new Blob(chunksRef.current, { type: usedMime.mime });

        setUploading(true);
        try {
          const formData = new FormData();
          formData.append(fieldName, blob, `voice-recording${usedMime.ext}`);
          const res = await fetch(uploadUrl, { method: "POST", body: formData });
          if (!res.ok) {
            let errMsg = `Erro ${res.status}`;
            try {
              const rawText = await res.text();
              if (rawText) {
                try {
                  const errData = JSON.parse(rawText);
                  if (errData?.error) errMsg = errData.error;
                  else errMsg = rawText;
                } catch {
                  errMsg = rawText;
                }
              }
            } catch { /* ignore */ }
            throw new Error(errMsg);
          }
          const data = await res.json();
          onRecorded(data.url);
          toast({ title: "Áudio gravado com sucesso" });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : "Tente novamente";
          console.error("[AudioRecorder] upload error:", err);
          toast({ title: "Erro ao enviar áudio", description: errMsg, variant: "destructive" });
        } finally {
          setUploading(false);
          setElapsed(0);
        }
      };

      recorder.start(250);
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((prev) => prev + 1), 1000);
    } catch {
      toast({ title: "Microfone não disponível", description: "Permita o acesso ao microfone no navegador", variant: "destructive" });
    }
  }, [onRecorded, uploadUrl, fieldName, toast]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  }, []);

  if (!supported) {
    return (
      <span className="text-xs text-muted-foreground" title="Seu navegador não suporta gravação de áudio. Tente usar Chrome, Firefox, Safari ou Edge atualizado.">
        Gravação indisponível
      </span>
    );
  }

  if (uploading) {
    return (
      <Button variant="outline" size="sm" disabled className="gap-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Enviando...
      </Button>
    );
  }

  if (recording) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={stopRecording}
        className="gap-1.5 border-red-300 text-red-600 hover:bg-red-50"
      >
        <Square className="w-3.5 h-3.5 fill-red-500" />
        {formatTime(elapsed)}
      </Button>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={startRecording} className="gap-1.5" title="Gravar audio">
      <Mic className="w-3.5 h-3.5" />
      Gravar
    </Button>
  );
}
