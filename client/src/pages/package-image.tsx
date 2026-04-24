import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, Download, Eye, Upload, RefreshCw, CheckCircle, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type TemplateType = "correios" | "dirpf";

const TEMPLATES: { id: TemplateType; label: string; description: string; icon: React.ReactNode; color: string }[] = [
  {
    id: "correios",
    label: "Pacote Correios",
    description: "Etiqueta de entrega dos Correios com campo de destinatário",
    icon: <Package size={18} />,
    color: "yellow",
  },
  {
    id: "dirpf",
    label: "Intimação Fiscal DIRPF",
    description: "Termo de intimação da Receita Federal com campo de nome e CPF",
    icon: <FileText size={18} />,
    color: "red",
  },
];

export default function PackageImagePage() {
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [customImage, setCustomImage] = useState<File | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateType>("correios");
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  function formatCpfInput(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }

  async function handleGenerate() {
    if (!nome.trim()) {
      toast({ title: "Nome obrigatório", variant: "destructive" });
      return;
    }
    if (!cpf.trim()) {
      toast({ title: "CPF obrigatório", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      if (customImage) {
        const formData = new FormData();
        formData.append("nome", nome);
        formData.append("cpf", cpf.replace(/\D/g, ""));
        formData.append("imageType", "auto");
        formData.append("image", customImage);

        const res = await fetch("/api/package-image/generate", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) throw new Error("Erro ao gerar imagem");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(url);
      } else {
        const cpfDigits = cpf.replace(/\D/g, "");
        const url = `/api/package-image/preview?nome=${encodeURIComponent(nome)}&cpf=${cpfDigits}&type=${selectedTemplate}&t=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Erro ao gerar imagem");
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(objectUrl);
      }

      toast({ title: "Imagem gerada com sucesso!", description: "Nome e CPF posicionados na imagem." });
    } catch (err: any) {
      toast({ title: "Erro ao gerar imagem", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  function handleDownload() {
    if (!previewUrl) return;
    const a = document.createElement("a");
    a.href = previewUrl;
    a.download = `${selectedTemplate}_${nome.replace(/\s+/g, "_")}_${cpf.replace(/\D/g, "")}.jpg`;
    a.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setCustomImage(file);
      setPreviewUrl(null);
    }
  }

  function handleRemoveCustomImage() {
    setCustomImage(null);
    setPreviewUrl(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function handleSelectTemplate(id: TemplateType) {
    setSelectedTemplate(id);
    setCustomImage(null);
    setPreviewUrl(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const activeTemplate = TEMPLATES.find((t) => t.id === selectedTemplate)!;

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="bg-yellow-500 p-2 rounded-lg">
          <Package className="text-white" size={22} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Gerar Imagem Personalizada</h1>
          <p className="text-sm text-gray-500">Selecione o modelo e adicione nome e CPF automaticamente</p>
        </div>
      </div>

      {/* Template selector */}
      <div>
        <Label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Modelo de Imagem</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TEMPLATES.map((tpl) => {
            const isSelected = selectedTemplate === tpl.id && !customImage;
            return (
              <button
                key={tpl.id}
                onClick={() => handleSelectTemplate(tpl.id)}
                className={`flex items-start gap-3 p-4 rounded-lg border-2 text-left transition-all ${
                  isSelected
                    ? tpl.id === "dirpf"
                      ? "border-red-500 bg-red-50"
                      : "border-yellow-500 bg-yellow-50"
                    : "border-gray-200 bg-white hover:border-gray-300"
                }`}
              >
                <div
                  className={`mt-0.5 shrink-0 ${
                    isSelected
                      ? tpl.id === "dirpf"
                        ? "text-red-600"
                        : "text-yellow-600"
                      : "text-gray-400"
                  }`}
                >
                  {tpl.icon}
                </div>
                <div>
                  <p className={`font-semibold text-sm ${isSelected ? "text-gray-900" : "text-gray-600"}`}>
                    {tpl.label}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{tpl.description}</p>
                </div>
                {isSelected && (
                  <CheckCircle
                    size={16}
                    className={`ml-auto shrink-0 mt-0.5 ${tpl.id === "dirpf" ? "text-red-500" : "text-yellow-500"}`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <span>Dados do Destinatário</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="nome">Nome Completo</Label>
              <Input
                id="nome"
                placeholder="Ex: MARIA OLIVEIRA SANTOS"
                value={nome}
                onChange={(e) => setNome(e.target.value.toUpperCase())}
                className="font-medium"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cpf">CPF</Label>
              <Input
                id="cpf"
                placeholder="000.000.000-00"
                value={cpf}
                onChange={(e) => setCpf(formatCpfInput(e.target.value))}
                maxLength={14}
              />
            </div>

            <div className="border-t pt-4 space-y-2">
              <Label className="text-xs text-gray-500 uppercase tracking-wider">Imagem Personalizada (opcional)</Label>
              {!customImage ? (
                <div className="flex items-center gap-2">
                  <div
                    className={`flex-1 rounded-md px-3 py-2 text-sm flex items-center gap-2 ${
                      selectedTemplate === "dirpf"
                        ? "bg-red-50 border border-red-200 text-red-800"
                        : "bg-yellow-50 border border-yellow-200 text-yellow-800"
                    }`}
                  >
                    <CheckCircle
                      size={14}
                      className={selectedTemplate === "dirpf" ? "text-red-600" : "text-yellow-600"}
                    />
                    {activeTemplate.label} (padrão)
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    className="shrink-0"
                  >
                    <Upload size={14} className="mr-1" />
                    Trocar
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-blue-50 border border-blue-200 rounded-md px-3 py-2 text-sm text-blue-800 flex items-center gap-2 truncate">
                    <CheckCircle size={14} className="text-blue-600 shrink-0" />
                    <span className="truncate">{customImage.name}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRemoveCustomImage}
                    className="shrink-0 text-red-600 border-red-200 hover:bg-red-50"
                  >
                    Remover
                  </Button>
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                className="hidden"
                onChange={handleFileChange}
              />
              {customImage && (
                <p className="text-xs text-gray-400">
                  O sistema irá posicionar o nome e CPF na área de destinatário detectada automaticamente.
                </p>
              )}
            </div>

            <Button
              className={`w-full font-semibold text-white ${
                selectedTemplate === "dirpf"
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-yellow-500 hover:bg-yellow-600"
              }`}
              onClick={handleGenerate}
              disabled={loading}
            >
              {loading ? (
                <><RefreshCw size={16} className="mr-2 animate-spin" /> Gerando...</>
              ) : (
                <><Eye size={16} className="mr-2" /> Gerar Prévia</>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card className="border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center justify-between">
              <span>Prévia da Imagem</span>
              {previewUrl && (
                <Badge className="bg-green-100 text-green-800 border-green-200 font-normal">
                  Pronto para download
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {previewUrl ? (
              <div className="space-y-3">
                <div className="rounded-lg overflow-hidden border bg-gray-50">
                  <img
                    src={previewUrl}
                    alt="Prévia da imagem com nome e CPF"
                    className="w-full h-auto"
                  />
                </div>
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={handleDownload}
                >
                  <Download size={16} className="mr-2" />
                  Baixar Imagem
                </Button>
              </div>
            ) : (
              <div className="h-64 flex flex-col items-center justify-center text-gray-400 border-2 border-dashed rounded-lg bg-gray-50">
                <Package size={40} className="mb-3 opacity-30" />
                <p className="text-sm font-medium">Nenhuma prévia ainda</p>
                <p className="text-xs mt-1">Preencha os dados e clique em "Gerar Prévia"</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border shadow-sm bg-blue-50 border-blue-100">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-3">
            <div className="text-blue-500 mt-0.5 shrink-0">ℹ️</div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-blue-900">Como funciona o posicionamento automático</p>
              <p className="text-sm text-blue-700">
                Para cada modelo selecionado, o sistema posiciona o nome e CPF nos campos corretos da imagem de forma precisa. 
                O modelo <strong>Pacote Correios</strong> preenche o campo "DESTINATÁRIO", e o modelo <strong>Intimação Fiscal DIRPF</strong> 
                preenche os campos "Nome Completo" e "CPF" do termo da Receita Federal.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
