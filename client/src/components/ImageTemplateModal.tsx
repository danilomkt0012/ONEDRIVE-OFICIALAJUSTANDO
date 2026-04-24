import { useState, useRef, useCallback, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, Plus, Save, Eye, Trash2, X, Loader2, Image, Move } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { ImageTemplateField } from "@shared/schema";
import { applyTextTransform, fontFamilyMap, createDefaultImageField } from "./wizard/types";

interface ImageTemplate {
  id: string;
  name: string;
  baseImageUrl: string;
  width: number;
  height: number;
  fields?: ImageTemplateField[];
}

interface ImageTemplateModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (template: ImageTemplate) => void;
}

export default function ImageTemplateModal({ open, onClose, onSaved }: ImageTemplateModalProps) {
  const { toast } = useToast();

  const [templateName, setTemplateName] = useState("");
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [imgDims, setImgDims] = useState({ width: 0, height: 0 });
  const [renderedDims, setRenderedDims] = useState({ width: 0, height: 0 });
  const [fields, setFields] = useState<ImageTemplateField[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ fieldId: string; offsetX: number; offsetY: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const selectedField = fields.find((f) => f.id === selectedFieldId) || null;

  const getScale = useCallback(() => {
    if (!canvasRef.current || imgDims.width === 0) return 1;
    const img = canvasRef.current.querySelector("img");
    return (img?.clientWidth || canvasRef.current.clientWidth) / imgDims.width;
  }, [imgDims.width]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver(() => {
      const img = canvasRef.current?.querySelector("img");
      if (img && img.clientWidth > 0) {
        setRenderedDims({ width: img.clientWidth, height: img.clientHeight });
      }
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [previewSrc]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      setPreviewSrc(src);
      setImgDims({ width: 0, height: 0 });
      setRenderedDims({ width: 0, height: 0 });
      setPreviewUrl(null);
    };
    reader.readAsDataURL(file);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = getScale();
    const mx = (e.clientX - rect.left + canvasRef.current.scrollLeft) / scale;
    const my = (e.clientY - rect.top + canvasRef.current.scrollTop) / scale;

    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i];
      const textH = f.fontSize * f.lineHeight;
      const bx = f.x;
      const by = f.y - textH;
      const bw = Math.max(f.maxWidth, f.fontSize * f.defaultText.length * 0.6);
      const bh = textH;
      if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
        setSelectedFieldId(f.id);
        setDragging({ fieldId: f.id, offsetX: mx - f.x, offsetY: my - f.y });
        return;
      }
    }
    setSelectedFieldId(null);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const scale = getScale();
    const mx = (e.clientX - rect.left + canvasRef.current.scrollLeft) / scale;
    const my = (e.clientY - rect.top + canvasRef.current.scrollTop) / scale;
    const newX = Math.max(0, Math.min(imgDims.width, mx - dragging.offsetX));
    const newY = Math.max(0, Math.min(imgDims.height, my - dragging.offsetY));
    setFields((prev) =>
      prev.map((f) => (f.id === dragging.fieldId ? { ...f, x: Math.round(newX), y: Math.round(newY) } : f))
    );
  };

  const handleCanvasMouseUp = () => setDragging(null);

  const updateField = (fieldId: string, updates: Partial<ImageTemplateField>) => {
    setFields((prev) => prev.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)));
  };

  const addField = (type: "name" | "cpf") => {
    const f = createDefaultImageField(type);
    f.y = 120 + fields.length * 50;
    setFields((prev) => [...prev, f]);
    setSelectedFieldId(f.id);
  };

  const deleteField = (fieldId: string) => {
    setFields((prev) => prev.filter((f) => f.id !== fieldId));
    if (selectedFieldId === fieldId) setSelectedFieldId(null);
  };

  const handleSave = async () => {
    if (!templateName.trim()) {
      toast({ title: "Nome obrigatório", description: "Informe um nome para o template.", variant: "destructive" });
      return;
    }
    if (!uploadedFile && !previewSrc) {
      toast({ title: "Imagem obrigatória", description: "Faça upload de uma imagem base.", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("name", templateName.trim());
      formData.append("fields", JSON.stringify(fields));
      formData.append("width", String(imgDims.width));
      formData.append("height", String(imgDims.height));
      if (uploadedFile) {
        formData.append("image", uploadedFile);
      }

      const resp = await fetch("/api/image-templates", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Erro desconhecido" }));
        throw new Error(err.error || "Falha ao salvar template");
      }

      const saved: ImageTemplate = await resp.json();
      toast({ title: "Template salvo!", description: `"${saved.name}" criado com sucesso.` });
      onSaved(saved);
      handleClose();
    } catch (err: any) {
      toast({ title: "Erro ao salvar", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!previewSrc || !uploadedFile) return;
    setPreviewLoading(true);
    let tempId: string | null = null;
    try {
      const formData = new FormData();
      formData.append("name", templateName || "__preview__");
      formData.append("fields", JSON.stringify(fields));
      formData.append("width", String(imgDims.width));
      formData.append("height", String(imgDims.height));
      formData.append("image", uploadedFile);

      const resp = await fetch("/api/image-templates", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Erro ao criar template temporário" }));
        throw new Error(err.error);
      }

      const saved: ImageTemplate & { id: string } = await resp.json();
      tempId = saved.id;

      const previewResp = await fetch(`/api/image-templates/${saved.id}/debug-render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "MARIA OLIVEIRA", cpf: "12345678900", debugOverlay: false }),
        credentials: "include",
      });

      if (previewResp.ok) {
        const blob = await previewResp.blob();
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreviewUrl(url);
      } else {
        const err = await previewResp.json().catch(() => ({ error: "Falha ao gerar preview" }));
        throw new Error(err.error);
      }
    } catch (err: any) {
      toast({ title: "Erro ao gerar preview", description: err.message, variant: "destructive" });
    } finally {
      if (tempId) {
        await fetch(`/api/image-templates/${tempId}`, {
          method: "DELETE",
          credentials: "include",
        }).catch(() => {});
      }
      setPreviewLoading(false);
    }
  };

  const handleClose = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setTemplateName("");
    setUploadedFile(null);
    setPreviewSrc(null);
    setImgDims({ width: 0, height: 0 });
    setRenderedDims({ width: 0, height: 0 });
    setFields([]);
    setSelectedFieldId(null);
    setDragging(null);
    setPreviewUrl(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-4xl w-full max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
              <Image className="w-4 h-4 text-purple-600" />
            </div>
            Criar Template de Imagem
          </DialogTitle>
        </DialogHeader>

        <div className="px-6 py-5 space-y-5">
          <div>
            <Label className="text-sm font-medium">Nome do Template</Label>
            <Input
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Ex: Certificado de Participação"
              className="mt-1"
            />
          </div>

          <div className="border rounded-xl p-4 space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Upload className="w-4 h-4 text-purple-500" />
              Imagem Base
            </h3>
            {previewSrc ? (
              <div className="flex items-center gap-3">
                <img src={previewSrc} alt="base" className="h-14 rounded-lg border object-cover" />
                <div className="text-sm text-muted-foreground">{uploadedFile?.name}</div>
                <Button variant="ghost" size="sm" className="ml-auto text-red-500" onClick={() => { setPreviewSrc(null); setUploadedFile(null); setImgDims({ width: 0, height: 0 }); setFields([]); }}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <div className="text-center py-4">
                <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="w-4 h-4 mr-1" />
                  Selecionar Imagem
                </Button>
                <p className="text-xs text-muted-foreground mt-1">JPG, PNG ou WebP</p>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/webp"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          {previewSrc && (
            <div className="border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <Move className="w-4 h-4 text-purple-500" />
                  Posicionar Campos
                </h3>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => addField("name")}>
                    <Plus className="w-3 h-3 mr-1" /> Nome
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => addField("cpf")}>
                    <Plus className="w-3 h-3 mr-1" /> CPF
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Arraste os campos de texto sobre a imagem para posicioná-los. Clique em um campo para editar as propriedades.
              </p>

              <div
                ref={canvasRef}
                className="relative border rounded-lg overflow-auto bg-gray-100"
                style={{ maxHeight: 400, cursor: dragging ? "grabbing" : "default" }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
              >
                <img
                  src={previewSrc}
                  alt="base"
                  className="w-full h-auto pointer-events-none select-none"
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.target as HTMLImageElement;
                    if (imgDims.width === 0) {
                      setImgDims({ width: img.naturalWidth, height: img.naturalHeight });
                    }
                    setRenderedDims({ width: img.clientWidth, height: img.clientHeight });
                  }}
                />
                {fields.map((f) => {
                  const isSelected = f.id === selectedFieldId;
                  const displayText = applyTextTransform(f.defaultText, f.textTransform);
                  const scale = imgDims.width > 0
                    ? (renderedDims.width || canvasRef.current?.querySelector("img")?.clientWidth || 1) / imgDims.width
                    : 1;
                  return (
                    <div
                      key={f.id}
                      className={`absolute select-none ${isSelected ? "ring-2 ring-purple-500 ring-offset-1" : ""}`}
                      style={{
                        left: f.x * scale,
                        top: (f.y - f.fontSize * f.lineHeight) * scale,
                        fontSize: f.fontSize * scale,
                        fontFamily: fontFamilyMap[f.fontFamily] || f.fontFamily,
                        fontWeight: f.fontWeight,
                        fontStyle: f.fontStyle,
                        color: f.color,
                        opacity: f.opacity / 100,
                        letterSpacing: f.letterSpacing * scale,
                        lineHeight: f.lineHeight,
                        textAlign: f.textAlign as React.CSSProperties["textAlign"],
                        maxWidth: f.maxWidth * scale,
                        transform: `rotate(${f.rotation}deg)`,
                        transformOrigin: "top left",
                        cursor: dragging ? "grabbing" : "grab",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        textShadow: f.shadowEnabled
                          ? `${f.shadowOffsetX * scale}px ${f.shadowOffsetY * scale}px ${f.shadowBlur * scale}px ${f.shadowColor}`
                          : "none",
                        WebkitTextStroke: f.strokeEnabled ? `${f.strokeWidth * scale}px ${f.strokeColor}` : "none",
                        pointerEvents: "auto",
                      }}
                    >
                      {isSelected && (
                        <div className="absolute -top-5 left-0 bg-purple-600 text-white text-[10px] px-1.5 py-0.5 rounded-sm whitespace-nowrap z-10">
                          {f.label} ({f.type})
                        </div>
                      )}
                      {displayText}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {selectedField && (
            <div className="border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">Propriedades: {selectedField.label}</h3>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" className="text-red-500 h-7" onClick={() => deleteField(selectedField.id)}>
                    <Trash2 className="w-3 h-3 mr-1" /> Remover
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setSelectedFieldId(null)}>
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Texto padrão</Label>
                  <Input
                    value={selectedField.defaultText}
                    onChange={(e) => updateField(selectedField.id, { defaultText: e.target.value })}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-xs">Cor</Label>
                  <div className="flex gap-1.5">
                    <input
                      type="color"
                      value={selectedField.color}
                      onChange={(e) => updateField(selectedField.id, { color: e.target.value })}
                      className="w-8 h-8 rounded border cursor-pointer"
                    />
                    <Input
                      value={selectedField.color}
                      onChange={(e) => updateField(selectedField.id, { color: e.target.value })}
                      className="h-8 text-sm flex-1"
                    />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">X: {selectedField.x}</Label>
                  <Slider
                    value={[selectedField.x]}
                    min={0}
                    max={imgDims.width || 1000}
                    step={1}
                    onValueChange={([v]) => updateField(selectedField.id, { x: v })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Y: {selectedField.y}</Label>
                  <Slider
                    value={[selectedField.y]}
                    min={0}
                    max={imgDims.height || 1000}
                    step={1}
                    onValueChange={([v]) => updateField(selectedField.id, { y: v })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs">Tamanho: {selectedField.fontSize}px</Label>
                  <Slider
                    value={[selectedField.fontSize]}
                    min={8}
                    max={120}
                    step={1}
                    onValueChange={([v]) => updateField(selectedField.id, { fontSize: v })}
                  />
                </div>
                <div>
                  <Label className="text-xs">Fonte</Label>
                  <Select value={selectedField.fontFamily} onValueChange={(v) => updateField(selectedField.id, { fontFamily: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sans-serif">Sans-serif</SelectItem>
                      <SelectItem value="serif">Serif</SelectItem>
                      <SelectItem value="monospace">Monospace</SelectItem>
                      <SelectItem value="handwriting">Handwriting</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Peso</Label>
                  <Select value={selectedField.fontWeight} onValueChange={(v) => updateField(selectedField.id, { fontWeight: v })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="bold">Bold</SelectItem>
                      <SelectItem value="600">Semi-bold</SelectItem>
                      <SelectItem value="900">Extra-bold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={selectedField.shadowEnabled}
                    onCheckedChange={(v) => updateField(selectedField.id, { shadowEnabled: v })}
                  />
                  <Label className="text-xs">Sombra</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={selectedField.strokeEnabled}
                    onCheckedChange={(v) => updateField(selectedField.id, { strokeEnabled: v })}
                  />
                  <Label className="text-xs">Contorno</Label>
                </div>
                <Select value={selectedField.textTransform} onValueChange={(v) => updateField(selectedField.id, { textTransform: v })}>
                  <SelectTrigger className="h-7 text-xs w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Normal</SelectItem>
                    <SelectItem value="uppercase">MAIÚSCULA</SelectItem>
                    <SelectItem value="lowercase">minúscula</SelectItem>
                    <SelectItem value="capitalize">Capitalizar</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {previewUrl && (
            <div className="border rounded-xl p-4">
              <p className="text-xs text-muted-foreground mb-2">Preview com dados fictícios (MARIA OLIVEIRA / 12345678900)</p>
              <img src={previewUrl} alt="Preview" className="rounded-lg border max-h-64 w-full object-contain bg-gray-50" />
            </div>
          )}
        </div>

        <div className="px-6 pb-6 flex gap-3 border-t pt-4">
          <Button variant="outline" onClick={handleClose} className="flex-1">
            Cancelar
          </Button>
          {previewSrc && (
            <Button variant="outline" onClick={handlePreview} disabled={previewLoading} className="flex-1">
              {previewLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Eye className="w-4 h-4 mr-1" />}
              Gerar Preview
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving || !templateName.trim() || !uploadedFile} className="flex-1 bg-purple-600 hover:bg-purple-700">
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Salvar Template
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
