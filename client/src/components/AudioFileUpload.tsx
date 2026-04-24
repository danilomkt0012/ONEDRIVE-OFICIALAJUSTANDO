import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Upload, Loader2 } from "lucide-react";

interface AudioFileUploadProps {
  onUploaded: (url: string) => void;
  uploadUrl?: string;
  fieldName?: string;
}

const ACCEPTED_AUDIO = ".mp3,.ogg,.wav,.m4a,.webm,.aac,.flac,.opus";

export default function AudioFileUpload({
  onUploaded,
  uploadUrl = "/api/bot/rules/upload-media",
  fieldName = "media",
}: AudioFileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append(fieldName, file, file.name);
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
        } catch { }
        throw new Error(errMsg);
      }
      const data = await res.json();
      onUploaded(data.url);
      toast({ title: "Áudio enviado com sucesso" });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Tente novamente";
      toast({ title: "Erro ao enviar áudio", description: errMsg, variant: "destructive" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_AUDIO}
        className="hidden"
        onChange={handleFileChange}
      />
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        title="Enviar arquivo de áudio"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Enviando...
          </>
        ) : (
          <>
            <Upload className="w-3.5 h-3.5" />
            Upload
          </>
        )}
      </Button>
    </>
  );
}
