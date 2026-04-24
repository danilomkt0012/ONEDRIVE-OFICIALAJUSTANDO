import { useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Image, Upload, Move, Plus, Save, Eye, Trash2, X, Loader2 } from "lucide-react";
import type { ImageTemplateField } from "@shared/schema";
import { applyTextTransform, fontFamilyMap, createDefaultImageField } from "./types";

interface Step6ImageProps {
  usePackageImage: boolean;
  setUsePackageImage: (v: boolean) => void;
  customImageTemplateId: string;
  setCustomImageTemplateId: (v: string) => void;
  imageTemplates: Array<{ id: string; name: string; baseImageUrl: string; width: number; height: number; fields?: ImageTemplateField[] }>;
  uploadingImage: boolean;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  editorFields: ImageTemplateField[];
  setEditorFields: (v: ImageTemplateField[] | ((prev: ImageTemplateField[]) => ImageTemplateField[])) => void;
  editorSelectedFieldId: string | null;
  setEditorSelectedFieldId: (v: string | null) => void;
  editorDragging: { fieldId: string; offsetX: number; offsetY: number } | null;
  setEditorDragging: (v: { fieldId: string; offsetX: number; offsetY: number } | null) => void;
  editorImgDims: { width: number; height: number };
  setEditorImgDims: (v: { width: number; height: number }) => void;
  editorRenderedDims: { width: number; height: number };
  setEditorRenderedDims: (v: { width: number; height: number }) => void;
  editorSaving: boolean;
  saveEditorFields: () => void;
  imagePreviewUrl: string | null;
  imagePreviewLoading: boolean;
  handlePreviewImage: () => void;
  name: string;
}

export default function Step6Image(props: Step6ImageProps) {
  const {
    usePackageImage, setUsePackageImage,
    customImageTemplateId, setCustomImageTemplateId,
    imageTemplates, uploadingImage, handleImageUpload,
    editorFields, setEditorFields,
    editorSelectedFieldId, setEditorSelectedFieldId,
    editorDragging, setEditorDragging,
    editorImgDims, setEditorImgDims,
    editorRenderedDims, setEditorRenderedDims,
    editorSaving, saveEditorFields,
    imagePreviewUrl, imagePreviewLoading, handlePreviewImage,
  } = props;

  const imageFileRef = useRef<HTMLInputElement>(null);
  const editorCanvasRef = useRef<HTMLDivElement>(null);

  const selectedImageTemplate = imageTemplates.find((t) => t.id === customImageTemplateId);
  const editorSelectedField = editorFields.find((f) => f.id === editorSelectedFieldId) || null;

  const getEditorScale = useCallback(() => {
    if (!editorCanvasRef.current || editorImgDims.width === 0) return 1;
    const renderedWidth = editorCanvasRef.current.querySelector('img')?.clientWidth || editorCanvasRef.current.clientWidth;
    return renderedWidth / editorImgDims.width;
  }, [editorImgDims.width]);

  useEffect(() => {
    if (!editorCanvasRef.current) return;
    const observer = new ResizeObserver(() => {
      const img = editorCanvasRef.current?.querySelector('img');
      if (img && img.clientWidth > 0) {
        setEditorRenderedDims({ width: img.clientWidth, height: img.clientHeight });
      }
    });
    observer.observe(editorCanvasRef.current);
    return () => observer.disconnect();
  }, [customImageTemplateId]);

  const handleEditorCanvasMouseDown = (e: React.MouseEvent) => {
    if (!editorCanvasRef.current) return;
    const rect = editorCanvasRef.current.getBoundingClientRect();
    const scale = getEditorScale();
    const mx = (e.clientX - rect.left + editorCanvasRef.current.scrollLeft) / scale;
    const my = (e.clientY - rect.top + editorCanvasRef.current.scrollTop) / scale;

    for (let i = editorFields.length - 1; i >= 0; i--) {
      const f = editorFields[i];
      const textH = f.fontSize * f.lineHeight;
      const bx = f.x;
      const by = f.y - textH;
      const bw = Math.max(f.maxWidth, f.fontSize * f.defaultText.length * 0.6);
      const bh = textH;
      if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
        setEditorSelectedFieldId(f.id);
        setEditorDragging({ fieldId: f.id, offsetX: mx - f.x, offsetY: my - f.y });
        return;
      }
    }
    setEditorSelectedFieldId(null);
  };

  const handleEditorCanvasMouseMove = (e: React.MouseEvent) => {
    if (!editorDragging || !editorCanvasRef.current) return;
    const rect = editorCanvasRef.current.getBoundingClientRect();
    const scale = getEditorScale();
    const mx = (e.clientX - rect.left + editorCanvasRef.current.scrollLeft) / scale;
    const my = (e.clientY - rect.top + editorCanvasRef.current.scrollTop) / scale;
    const newX = Math.max(0, Math.min(editorImgDims.width, mx - editorDragging.offsetX));
    const newY = Math.max(0, Math.min(editorImgDims.height, my - editorDragging.offsetY));
    setEditorFields((prev: ImageTemplateField[]) =>
      prev.map((f: ImageTemplateField) => (f.id === editorDragging.fieldId ? { ...f, x: Math.round(newX), y: Math.round(newY) } : f))
    );
  };

  const handleEditorCanvasMouseUp = () => {
    setEditorDragging(null);
  };

  const updateEditorField = (fieldId: string, updates: Partial<ImageTemplateField>) => {
    setEditorFields((prev: ImageTemplateField[]) => prev.map((f: ImageTemplateField) => (f.id === fieldId ? { ...f, ...updates } : f)));
  };

  const addEditorField = (type: "name" | "cpf") => {
    const f = createDefaultImageField(type);
    f.y = 120 + editorFields.length * 50;
    setEditorFields((prev: ImageTemplateField[]) => [...prev, f]);
    setEditorSelectedFieldId(f.id);
  };

  const deleteEditorField = (fieldId: string) => {
    setEditorFields((prev: ImageTemplateField[]) => prev.filter((f: ImageTemplateField) => f.id !== fieldId));
    if (editorSelectedFieldId === fieldId) setEditorSelectedFieldId(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Image className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Imagem Personalizada</h2>
          <p className="text-sm text-muted-foreground">Configure uma imagem única por lead com nome e CPF posicionados</p>
        </div>
      </div>

      <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
        <div>
          <Label className="text-sm font-medium">Enviar com Imagem Personalizada</Label>
          <p className="text-xs text-muted-foreground">Gera uma imagem única por lead com nome e CPF posicionados</p>
        </div>
        <Switch checked={usePackageImage} onCheckedChange={setUsePackageImage} />
      </div>

      {usePackageImage && (
        <>
          <div className="border rounded-xl p-4 space-y-4 shadow-sm">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Upload className="w-4 h-4 text-primary" />
              Imagem Base
            </h3>

            {imageTemplates.length > 0 && (
              <div>
                <Label className="text-xs">Selecionar template existente</Label>
                <Select value={customImageTemplateId} onValueChange={setCustomImageTemplateId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Escolha um template de imagem" />
                  </SelectTrigger>
                  <SelectContent>
                    {imageTemplates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name} ({t.width}x{t.height})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-2">Ou faça upload de uma nova imagem base</p>
              <Button
                variant="outline"
                onClick={() => imageFileRef.current?.click()}
                disabled={uploadingImage}
              >
                {uploadingImage ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
                {uploadingImage ? "Enviando..." : "Enviar Imagem"}
              </Button>
              <input
                ref={imageFileRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                className="hidden"
                onChange={handleImageUpload}
              />
            </div>
          </div>

          {selectedImageTemplate && (
            <div className="space-y-4">
              <div className="border rounded-xl p-4 space-y-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-sm flex items-center gap-2">
                    <Move className="w-4 h-4 text-primary" />
                    Posicionar Campos na Imagem
                  </h3>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => addEditorField("name")}>
                      <Plus className="w-3 h-3 mr-1" /> Nome
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addEditorField("cpf")}>
                      <Plus className="w-3 h-3 mr-1" /> CPF
                    </Button>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Arraste os campos de texto sobre a imagem para posicioná-los. Clique em um campo para editar suas propriedades.
                </p>

                <div className="flex gap-4">
                  <div
                    ref={editorCanvasRef}
                    className="relative border rounded-lg overflow-y-auto bg-gray-100 flex-1"
                    style={{
                      maxHeight: 600,
                      cursor: editorDragging ? "grabbing" : "default",
                    }}
                    onMouseDown={handleEditorCanvasMouseDown}
                    onMouseMove={handleEditorCanvasMouseMove}
                    onMouseUp={handleEditorCanvasMouseUp}
                    onMouseLeave={handleEditorCanvasMouseUp}
                  >
                    <img
                      src={selectedImageTemplate.baseImageUrl}
                      alt={selectedImageTemplate.name}
                      className="w-full h-auto pointer-events-none select-none"
                      draggable={false}
                      onLoad={(e) => {
                        const img = e.target as HTMLImageElement;
                        if (editorImgDims.width === 0) {
                          setEditorImgDims({ width: img.naturalWidth, height: img.naturalHeight });
                        }
                        setEditorRenderedDims({ width: img.clientWidth, height: img.clientHeight });
                      }}
                    />
                    {editorFields.map((f) => {
                      const isSelected = f.id === editorSelectedFieldId;
                      const displayText = applyTextTransform(f.defaultText, f.textTransform);
                      const scale = editorImgDims.width > 0
                        ? (editorRenderedDims.width || editorCanvasRef.current?.querySelector('img')?.clientWidth || 1) / editorImgDims.width
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
                            cursor: editorDragging ? "grabbing" : "grab",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            textShadow: f.shadowEnabled
                              ? `${f.shadowOffsetX * scale}px ${f.shadowOffsetY * scale}px ${f.shadowBlur * scale}px ${f.shadowColor}`
                              : "none",
                            WebkitTextStroke: f.strokeEnabled
                              ? `${f.strokeWidth * scale}px ${f.strokeColor}`
                              : "none",
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
              </div>

              {editorSelectedField && (
                <div className="border rounded-xl p-4 space-y-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">Propriedades: {editorSelectedField.label}</h3>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="text-red-500 h-7" onClick={() => deleteEditorField(editorSelectedField.id)}>
                        <Trash2 className="w-3 h-3 mr-1" /> Remover
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7" onClick={() => setEditorSelectedFieldId(null)}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Texto padrão</Label>
                      <Input
                        value={editorSelectedField.defaultText}
                        onChange={(e) => updateEditorField(editorSelectedField.id, { defaultText: e.target.value })}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Cor</Label>
                      <div className="flex gap-1.5">
                        <input
                          type="color"
                          value={editorSelectedField.color}
                          onChange={(e) => updateEditorField(editorSelectedField.id, { color: e.target.value })}
                          className="w-8 h-8 rounded border cursor-pointer"
                        />
                        <Input
                          value={editorSelectedField.color}
                          onChange={(e) => updateEditorField(editorSelectedField.id, { color: e.target.value })}
                          className="h-8 text-sm flex-1"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">X: {editorSelectedField.x}</Label>
                      <Slider
                        value={[editorSelectedField.x]}
                        min={0}
                        max={editorImgDims.width || 1000}
                        step={1}
                        onValueChange={([v]) => updateEditorField(editorSelectedField.id, { x: v })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Y: {editorSelectedField.y}</Label>
                      <Slider
                        value={[editorSelectedField.y]}
                        min={0}
                        max={editorImgDims.height || 1000}
                        step={1}
                        onValueChange={([v]) => updateEditorField(editorSelectedField.id, { y: v })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <Label className="text-xs">Tamanho: {editorSelectedField.fontSize}px</Label>
                      <Slider
                        value={[editorSelectedField.fontSize]}
                        min={8}
                        max={120}
                        step={1}
                        onValueChange={([v]) => updateEditorField(editorSelectedField.id, { fontSize: v })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Fonte</Label>
                      <Select
                        value={editorSelectedField.fontFamily}
                        onValueChange={(v) => updateEditorField(editorSelectedField.id, { fontFamily: v })}
                      >
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
                      <Select
                        value={editorSelectedField.fontWeight}
                        onValueChange={(v) => updateEditorField(editorSelectedField.id, { fontWeight: v })}
                      >
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
                        checked={editorSelectedField.shadowEnabled}
                        onCheckedChange={(v) => updateEditorField(editorSelectedField.id, { shadowEnabled: v })}
                      />
                      <Label className="text-xs">Sombra</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={editorSelectedField.strokeEnabled}
                        onCheckedChange={(v) => updateEditorField(editorSelectedField.id, { strokeEnabled: v })}
                      />
                      <Label className="text-xs">Contorno</Label>
                    </div>
                    <Select
                      value={editorSelectedField.textTransform}
                      onValueChange={(v) => updateEditorField(editorSelectedField.id, { textTransform: v })}
                    >
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

              <div className="flex gap-3">
                <Button variant="outline" onClick={saveEditorFields} disabled={editorSaving || editorFields.length === 0} className="flex-1">
                  {editorSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                  Salvar Posições
                </Button>
                <Button variant="outline" onClick={handlePreviewImage} disabled={imagePreviewLoading} className="flex-1">
                  {imagePreviewLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Eye className="w-4 h-4 mr-1" />}
                  Gerar Preview
                </Button>
              </div>

              {imagePreviewUrl && (
                <div className="border rounded-xl p-4 shadow-sm">
                  <p className="text-xs text-muted-foreground mb-2">Preview com dados fictícios (MARIA OLIVEIRA / 12345678900)</p>
                  <img
                    src={imagePreviewUrl}
                    alt="Preview"
                    className="rounded-lg border max-h-64 w-full object-contain bg-gray-50"
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
