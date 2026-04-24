import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Copy,
  Trash2,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Upload,
  Save,
  Eye,
  ArrowLeft,
  Palette,
  GripVertical,
} from "lucide-react";
import type { ImageTemplateField } from "@shared/schema";

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function createDefaultField(type: "name" | "cpf" | "custom" = "custom"): ImageTemplateField {
  const labels: Record<string, string> = { name: "Nome", cpf: "CPF", custom: "Campo" };
  const defaults: Record<string, string> = {
    name: "MARIA OLIVEIRA SANTOS",
    cpf: "123.456.789-00",
    custom: "Texto personalizado",
  };
  return {
    id: generateId(),
    label: labels[type],
    type,
    defaultText: defaults[type],
    x: 100,
    y: 100,
    fontSize: 20,
    fontFamily: "sans-serif",
    fontWeight: "normal",
    fontStyle: "normal",
    color: "#000000",
    opacity: 100,
    letterSpacing: 0,
    lineHeight: 1.2,
    rotation: 0,
    textAlign: "left",
    maxWidth: 300,
    textTransform: "none",
    shadowEnabled: false,
    shadowColor: "#000000",
    shadowOffsetX: 2,
    shadowOffsetY: 2,
    shadowBlur: 4,
    strokeEnabled: false,
    strokeColor: "#000000",
    strokeWidth: 1,
  };
}

interface HistoryState {
  fields: ImageTemplateField[];
}

interface TemplateListItem {
  id: string;
  name: string;
  baseImageUrl: string;
  width: number;
  height: number;
  fields: ImageTemplateField[];
  createdAt: string;
}

function applyTextTransform(text: string, transform: string): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    default: return text;
  }
}

export default function TemplateEditorPage() {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("Novo Template");
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [baseImageFile, setBaseImageFile] = useState<File | null>(null);
  const [imgDimensions, setImgDimensions] = useState({ width: 0, height: 0 });
  const [fields, setFields] = useState<ImageTemplateField[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [history, setHistory] = useState<HistoryState[]>([{ fields: [] }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [dragging, setDragging] = useState<{ fieldId: string; offsetX: number; offsetY: number } | null>(null);
  const [resizing, setResizing] = useState<{ fieldId: string; startX: number; startY: number; startMaxWidth: number; startFontSize: number; handle: string } | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [previewMode, setPreviewMode] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const selectedField = fields.find((f) => f.id === selectedFieldId) || null;

  useEffect(() => {
    fetchTemplates();
  }, []);

  async function fetchTemplates() {
    try {
      const res = await fetch("/api/image-templates");
      if (res.ok) {
        const data = await res.json();
        setTemplates(data);
      }
    } catch (err) {
      console.error("Error fetching templates:", err);
    } finally {
      setLoadingTemplates(false);
    }
  }

  function pushHistory(newFields: ImageTemplateField[]) {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push({ fields: JSON.parse(JSON.stringify(newFields)) });
    if (newHistory.length > 50) newHistory.shift();
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }

  function undo() {
    if (historyIndex <= 0) return;
    const prev = history[historyIndex - 1];
    setFields(JSON.parse(JSON.stringify(prev.fields)));
    setHistoryIndex(historyIndex - 1);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    const next = history[historyIndex + 1];
    setFields(JSON.parse(JSON.stringify(next.fields)));
    setHistoryIndex(historyIndex + 1);
  }

  function updateFields(newFields: ImageTemplateField[]) {
    setFields(newFields);
    pushHistory(newFields);
  }

  function addField(type: "name" | "cpf" | "custom") {
    const f = createDefaultField(type);
    f.x = 50 + fields.length * 20;
    f.y = 50 + fields.length * 30;
    const newFields = [...fields, f];
    updateFields(newFields);
    setSelectedFieldId(f.id);
  }

  function duplicateField() {
    if (!selectedField) return;
    const dup = { ...JSON.parse(JSON.stringify(selectedField)), id: generateId() };
    dup.x += 20;
    dup.y += 20;
    dup.label = `${dup.label} (cópia)`;
    const newFields = [...fields, dup];
    updateFields(newFields);
    setSelectedFieldId(dup.id);
  }

  function deleteField() {
    if (!selectedFieldId) return;
    const newFields = fields.filter((f) => f.id !== selectedFieldId);
    updateFields(newFields);
    setSelectedFieldId(newFields.length > 0 ? newFields[newFields.length - 1].id : null);
  }

  function resetPositions() {
    const newFields = fields.map((f, i) => ({
      ...f,
      x: 100,
      y: 100 + i * 40,
      rotation: 0,
    }));
    updateFields(newFields);
  }

  function updateSelectedField(updates: Partial<ImageTemplateField>) {
    if (!selectedFieldId) return;
    const newFields = fields.map((f) =>
      f.id === selectedFieldId ? { ...f, ...updates } : f
    );
    updateFields(newFields);
  }

  function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBaseImageFile(file);
    const url = URL.createObjectURL(file);
    setBaseImage(url);
    const img = new Image();
    img.onload = () => {
      setImgDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = url;
  }

  function getFieldBounds(f: ImageTemplateField) {
    const textW = Math.max(f.maxWidth, f.fontSize * f.defaultText.length * 0.6);
    const textH = f.fontSize * f.lineHeight;
    return { x: f.x, y: f.y - textH, w: textW, h: textH };
  }

  function handleCanvasMouseDown(e: React.MouseEvent) {
    if (!canvasRef.current || previewMode) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / zoom;
    const my = (e.clientY - rect.top) / zoom;
    const handleSize = 8 / zoom;

    if (selectedFieldId) {
      const sel = fields.find((f) => f.id === selectedFieldId);
      if (sel) {
        const b = getFieldBounds(sel);
        const rightEdge = b.x + b.w;
        const bottomEdge = b.y + b.h;
        if (mx >= rightEdge - handleSize && mx <= rightEdge + handleSize && my >= bottomEdge - handleSize && my <= bottomEdge + handleSize) {
          setResizing({ fieldId: sel.id, startX: mx, startY: my, startMaxWidth: sel.maxWidth, startFontSize: sel.fontSize, handle: "se" });
          return;
        }
        if (mx >= rightEdge - handleSize && mx <= rightEdge + handleSize && my >= b.y + b.h / 2 - handleSize && my <= b.y + b.h / 2 + handleSize) {
          setResizing({ fieldId: sel.id, startX: mx, startY: my, startMaxWidth: sel.maxWidth, startFontSize: sel.fontSize, handle: "e" });
          return;
        }
      }
    }

    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i];
      const b = getFieldBounds(f);
      if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
        setSelectedFieldId(f.id);
        setDragging({ fieldId: f.id, offsetX: mx - f.x, offsetY: my - f.y });
        return;
      }
    }
    setSelectedFieldId(null);
  }

  function handleCanvasMouseMove(e: React.MouseEvent) {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / zoom;
    const my = (e.clientY - rect.top) / zoom;

    if (resizing) {
      const deltaX = mx - resizing.startX;
      const deltaY = my - resizing.startY;
      if (resizing.handle === "e") {
        const newMaxWidth = Math.max(30, resizing.startMaxWidth + deltaX);
        setFields((prev) => prev.map((f) => (f.id === resizing.fieldId ? { ...f, maxWidth: Math.round(newMaxWidth) } : f)));
      } else if (resizing.handle === "se") {
        const newMaxWidth = Math.max(30, resizing.startMaxWidth + deltaX);
        const scale = Math.max(0.3, (resizing.startFontSize + deltaY * 0.5) / resizing.startFontSize);
        const newFontSize = Math.max(8, Math.min(200, Math.round(resizing.startFontSize * scale)));
        setFields((prev) => prev.map((f) => (f.id === resizing.fieldId ? { ...f, maxWidth: Math.round(newMaxWidth), fontSize: newFontSize } : f)));
      }
      return;
    }

    if (dragging) {
      const newX = Math.max(0, Math.min(imgDimensions.width, mx - dragging.offsetX));
      const newY = Math.max(0, Math.min(imgDimensions.height, my - dragging.offsetY));
      setFields((prev) =>
        prev.map((f) => (f.id === dragging.fieldId ? { ...f, x: Math.round(newX), y: Math.round(newY) } : f))
      );
    }
  }

  function handleCanvasMouseUp() {
    if (dragging) {
      pushHistory(fields);
      setDragging(null);
    }
    if (resizing) {
      pushHistory(fields);
      setResizing(null);
    }
  }

  async function handleSave() {
    if (!baseImage || !templateName.trim()) {
      toast({ title: "Preencha o nome e faça upload de uma imagem", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("name", templateName);
      formData.append("fields", JSON.stringify(fields));
      formData.append("width", String(imgDimensions.width));
      formData.append("height", String(imgDimensions.height));

      if (baseImageFile) {
        formData.append("image", baseImageFile);
      }

      let url = "/api/image-templates";
      let method = "POST";
      if (editingTemplateId) {
        url = `/api/image-templates/${editingTemplateId}`;
        method = "PUT";
      }

      const res = await fetch(url, { method, body: formData });
      if (!res.ok) throw new Error("Erro ao salvar template");
      const saved = await res.json();
      toast({ title: "Template salvo com sucesso!" });
      await fetchTemplates();
      setEditingTemplateId(saved.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast({ title: "Erro ao salvar", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteTemplate(id: string) {
    try {
      const res = await fetch(`/api/image-templates/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Erro ao excluir");
      toast({ title: "Template excluído" });
      await fetchTemplates();
      if (editingTemplateId === id) {
        setShowEditor(false);
        setEditingTemplateId(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro desconhecido";
      toast({ title: "Erro", description: message, variant: "destructive" });
    }
  }

  function handleEditTemplate(tpl: TemplateListItem) {
    setEditingTemplateId(tpl.id);
    setTemplateName(tpl.name);
    setBaseImage(tpl.baseImageUrl);
    setBaseImageFile(null);
    setImgDimensions({ width: tpl.width, height: tpl.height });
    setFields(tpl.fields || []);
    setHistory([{ fields: JSON.parse(JSON.stringify(tpl.fields || [])) }]);
    setHistoryIndex(0);
    setSelectedFieldId(null);
    setZoom(1);
    setShowEditor(true);
  }

  function handleNewTemplate() {
    setEditingTemplateId(null);
    setTemplateName("Novo Template");
    setBaseImage(null);
    setBaseImageFile(null);
    setImgDimensions({ width: 0, height: 0 });
    setFields([]);
    setHistory([{ fields: [] }]);
    setHistoryIndex(0);
    setSelectedFieldId(null);
    setZoom(1);
    setShowEditor(true);
  }

  const getFontFamilyCSS = useCallback((family: string) => {
    const map: Record<string, string> = {
      "sans-serif": "Arial, Helvetica, sans-serif",
      "serif": "Georgia, 'Times New Roman', serif",
      "monospace": "'Courier New', Courier, monospace",
      "handwriting": "'Comic Sans MS', 'Segoe Script', cursive",
    };
    return map[family] || family;
  }, []);

  if (!showEditor) {
    return (
      <div className="max-w-5xl mx-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="bg-purple-500 p-2 rounded-lg">
              <Palette className="text-white" size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Editor de Templates</h1>
              <p className="text-sm text-gray-500">Crie e edite templates de imagem com posicionamento visual</p>
            </div>
          </div>
          <Button onClick={handleNewTemplate} className="bg-purple-600 hover:bg-purple-700">
            <Plus size={16} className="mr-2" /> Novo Template
          </Button>
        </div>

        {loadingTemplates ? (
          <div className="text-center py-12 text-gray-500">Carregando templates...</div>
        ) : templates.length === 0 ? (
          <Card className="border-dashed border-2 border-gray-300">
            <CardContent className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Palette size={48} className="mb-4 opacity-30" />
              <p className="text-lg font-medium">Nenhum template criado</p>
              <p className="text-sm mt-1">Clique em "Novo Template" para começar</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <Card key={tpl.id} className="border shadow-sm hover:shadow-md transition-shadow cursor-pointer group">
                <div
                  className="aspect-video bg-gray-100 rounded-t-lg overflow-hidden"
                  onClick={() => handleEditTemplate(tpl)}
                >
                  {tpl.baseImageUrl && (
                    <img
                      src={tpl.baseImageUrl}
                      alt={tpl.name}
                      className="w-full h-full object-cover"
                    />
                  )}
                </div>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{tpl.name}</p>
                      <p className="text-xs text-gray-400">
                        {(tpl.fields as ImageTemplateField[])?.length || 0} campo(s) · {tpl.width}x{tpl.height}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleEditTemplate(tpl); }}
                      >
                        Editar
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-500 hover:text-red-700"
                        onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(tpl.id); }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-white shrink-0">
        <Button variant="ghost" size="sm" onClick={() => setShowEditor(false)}>
          <ArrowLeft size={16} className="mr-1" /> Voltar
        </Button>
        <Input
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          className="w-64 font-semibold"
          placeholder="Nome do template"
        />
        <div className="flex gap-1 ml-auto">
          <Button variant="outline" size="sm" onClick={() => addField("name")} title="Adicionar campo Nome">
            <Plus size={14} className="mr-1" /> Nome
          </Button>
          <Button variant="outline" size="sm" onClick={() => addField("cpf")} title="Adicionar campo CPF">
            <Plus size={14} className="mr-1" /> CPF
          </Button>
          <Button variant="outline" size="sm" onClick={() => addField("custom")} title="Adicionar campo livre">
            <Plus size={14} className="mr-1" /> Campo
          </Button>
          <div className="w-px bg-gray-200 mx-1" />
          <Button variant="outline" size="sm" onClick={duplicateField} disabled={!selectedField} title="Duplicar">
            <Copy size={14} />
          </Button>
          <Button variant="outline" size="sm" onClick={deleteField} disabled={!selectedField} title="Excluir" className="text-red-500">
            <Trash2 size={14} />
          </Button>
          <div className="w-px bg-gray-200 mx-1" />
          <Button variant="outline" size="sm" onClick={undo} disabled={historyIndex <= 0} title="Desfazer">
            <Undo2 size={14} />
          </Button>
          <Button variant="outline" size="sm" onClick={redo} disabled={historyIndex >= history.length - 1} title="Refazer">
            <Redo2 size={14} />
          </Button>
          <div className="w-px bg-gray-200 mx-1" />
          <Button variant="outline" size="sm" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} title="Zoom +">
            <ZoomIn size={14} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} title="Zoom -">
            <ZoomOut size={14} />
          </Button>
          <Button variant="outline" size="sm" onClick={resetPositions} title="Resetar posições">
            <RotateCcw size={14} />
          </Button>
          <Button
            variant={previewMode ? "default" : "outline"}
            size="sm"
            onClick={() => setPreviewMode(!previewMode)}
            title="Preview"
            className={previewMode ? "bg-green-600 hover:bg-green-700" : ""}
          >
            <Eye size={14} className="mr-1" /> Preview
          </Button>
          <div className="w-px bg-gray-200 mx-1" />
          <Button onClick={handleSave} disabled={saving || !baseImage} className="bg-purple-600 hover:bg-purple-700">
            <Save size={14} className="mr-1" /> {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto bg-gray-100 p-4" style={{ cursor: resizing ? (resizing.handle === "se" ? "nwse-resize" : "ew-resize") : dragging ? "grabbing" : "default" }}>
          {!baseImage ? (
            <div className="flex flex-col items-center justify-center h-full">
              <div
                className="border-2 border-dashed border-gray-300 rounded-xl p-12 text-center cursor-pointer hover:border-purple-400 hover:bg-purple-50 transition-all"
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={48} className="mx-auto mb-4 text-gray-300" />
                <p className="text-lg font-medium text-gray-600">Faça upload da imagem base</p>
                <p className="text-sm text-gray-400 mt-1">PNG, JPG ou WebP</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                className="hidden"
                onChange={handleImageUpload}
              />
            </div>
          ) : (
            <div className="flex justify-center">
              <div
                ref={canvasRef}
                className="relative inline-block shadow-lg"
                style={{
                  width: imgDimensions.width * zoom,
                  height: imgDimensions.height * zoom,
                  transformOrigin: "top left",
                }}
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasMouseUp}
              >
                <img
                  src={baseImage}
                  alt="Template base"
                  className="w-full h-full pointer-events-none select-none"
                  draggable={false}
                />
                {fields.map((f) => {
                  const isSelected = f.id === selectedFieldId && !previewMode;
                  const displayText = applyTextTransform(f.defaultText, f.textTransform);
                  return (
                    <div
                      key={f.id}
                      className={`absolute select-none ${isSelected ? "ring-2 ring-purple-500 ring-offset-1" : ""}`}
                      style={{
                        left: f.x * zoom,
                        top: (f.y - f.fontSize * f.lineHeight) * zoom,
                        fontSize: f.fontSize * zoom,
                        fontFamily: getFontFamilyCSS(f.fontFamily),
                        fontWeight: f.fontWeight,
                        fontStyle: f.fontStyle,
                        color: f.color,
                        opacity: f.opacity / 100,
                        letterSpacing: `${f.letterSpacing}px`,
                        lineHeight: f.lineHeight,
                        textAlign: f.textAlign as React.CSSProperties["textAlign"],
                        maxWidth: f.maxWidth * zoom,
                        transform: `rotate(${f.rotation}deg)`,
                        transformOrigin: "top left",
                        textTransform: "none",
                        cursor: previewMode ? "default" : "grab",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        textShadow: f.shadowEnabled
                          ? `${f.shadowOffsetX}px ${f.shadowOffsetY}px ${f.shadowBlur}px ${f.shadowColor}`
                          : "none",
                        WebkitTextStroke: f.strokeEnabled
                          ? `${f.strokeWidth}px ${f.strokeColor}`
                          : "none",
                        pointerEvents: previewMode ? "none" : "auto",
                      }}
                    >
                      {!previewMode && isSelected && (
                        <div className="absolute -top-5 left-0 bg-purple-600 text-white text-[10px] px-1.5 py-0.5 rounded-sm whitespace-nowrap z-10">
                          {f.label} ({f.type})
                        </div>
                      )}
                      {!previewMode && isSelected && (
                        <>
                          <div
                            className="absolute bg-white border-2 border-purple-500 rounded-sm z-20"
                            style={{
                              width: 8,
                              height: 8,
                              right: -4,
                              top: "50%",
                              marginTop: -4,
                              cursor: "ew-resize",
                            }}
                          />
                          <div
                            className="absolute bg-white border-2 border-purple-500 rounded-sm z-20"
                            style={{
                              width: 8,
                              height: 8,
                              right: -4,
                              bottom: -4,
                              cursor: "nwse-resize",
                            }}
                          />
                        </>
                      )}
                      {displayText}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="w-80 border-l bg-white overflow-y-auto shrink-0">
          {!baseImage ? (
            <div className="p-4 text-center text-gray-400 text-sm mt-12">
              Faça upload de uma imagem para começar
            </div>
          ) : !selectedField ? (
            <div className="p-4 space-y-4">
              <p className="text-sm text-gray-500 text-center mt-8">
                Selecione um campo no canvas ou adicione um novo campo usando a barra de ferramentas
              </p>
              {fields.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs uppercase text-gray-400 tracking-wider">Campos</Label>
                  {fields.map((f) => (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 p-2 rounded-lg border cursor-pointer hover:bg-gray-50"
                      onClick={() => setSelectedFieldId(f.id)}
                    >
                      <GripVertical size={14} className="text-gray-300" />
                      <div>
                        <p className="text-sm font-medium">{f.label}</p>
                        <p className="text-xs text-gray-400">{f.type} · ({f.x}, {f.y})</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">Propriedades</h3>
                <Button variant="ghost" size="sm" onClick={() => setSelectedFieldId(null)}>
                  &times;
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Label</Label>
                <Input
                  value={selectedField.label}
                  onChange={(e) => updateSelectedField({ label: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Texto padrão</Label>
                <Input
                  value={selectedField.defaultText}
                  onChange={(e) => updateSelectedField({ defaultText: e.target.value })}
                  className="h-8 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">X</Label>
                  <Input
                    type="number"
                    value={selectedField.x}
                    onChange={(e) => updateSelectedField({ x: Number(e.target.value) })}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Y</Label>
                  <Input
                    type="number"
                    value={selectedField.y}
                    onChange={(e) => updateSelectedField({ y: Number(e.target.value) })}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Tamanho da fonte: {selectedField.fontSize}px</Label>
                <div className="flex gap-2 items-center">
                  <Slider
                    value={[selectedField.fontSize]}
                    min={8}
                    max={120}
                    step={1}
                    onValueChange={([v]) => updateSelectedField({ fontSize: v })}
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    value={selectedField.fontSize}
                    onChange={(e) => updateSelectedField({ fontSize: Number(e.target.value) })}
                    className="w-16 h-8 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Família da fonte</Label>
                <Select
                  value={selectedField.fontFamily}
                  onValueChange={(v) => updateSelectedField({ fontFamily: v })}
                >
                  <SelectTrigger className="h-8 text-sm">
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

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Peso</Label>
                  <Select
                    value={selectedField.fontWeight}
                    onValueChange={(v) => updateSelectedField({ fontWeight: v })}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="bold">Bold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Estilo</Label>
                  <Select
                    value={selectedField.fontStyle}
                    onValueChange={(v) => updateSelectedField({ fontStyle: v })}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="italic">Itálico</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Cor do texto</Label>
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={selectedField.color}
                    onChange={(e) => updateSelectedField({ color: e.target.value })}
                    className="w-8 h-8 rounded border cursor-pointer"
                  />
                  <Input
                    value={selectedField.color}
                    onChange={(e) => updateSelectedField({ color: e.target.value })}
                    className="h-8 text-sm flex-1"
                    placeholder="#000000"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Opacidade: {selectedField.opacity}%</Label>
                <Slider
                  value={[selectedField.opacity]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={([v]) => updateSelectedField({ opacity: v })}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Espaçamento entre letras: {selectedField.letterSpacing}px</Label>
                <Slider
                  value={[selectedField.letterSpacing]}
                  min={-5}
                  max={20}
                  step={0.1}
                  onValueChange={([v]) => updateSelectedField({ letterSpacing: v })}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Altura da linha: {selectedField.lineHeight}</Label>
                <Slider
                  value={[selectedField.lineHeight]}
                  min={0.5}
                  max={3}
                  step={0.1}
                  onValueChange={([v]) => updateSelectedField({ lineHeight: v })}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Rotação: {selectedField.rotation}°</Label>
                <div className="flex gap-2 items-center">
                  <Slider
                    value={[selectedField.rotation]}
                    min={-180}
                    max={180}
                    step={1}
                    onValueChange={([v]) => updateSelectedField({ rotation: v })}
                    className="flex-1"
                  />
                  <Input
                    type="number"
                    value={selectedField.rotation}
                    onChange={(e) => updateSelectedField({ rotation: Number(e.target.value) })}
                    className="w-16 h-8 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Alinhamento</Label>
                <Select
                  value={selectedField.textAlign}
                  onValueChange={(v) => updateSelectedField({ textAlign: v })}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="left">Esquerda</SelectItem>
                    <SelectItem value="center">Centro</SelectItem>
                    <SelectItem value="right">Direita</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Largura máxima: {selectedField.maxWidth}px</Label>
                <Slider
                  value={[selectedField.maxWidth]}
                  min={50}
                  max={Math.max(imgDimensions.width, 500)}
                  step={1}
                  onValueChange={([v]) => updateSelectedField({ maxWidth: v })}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Transformação de texto</Label>
                <Select
                  value={selectedField.textTransform}
                  onValueChange={(v) => updateSelectedField({ textTransform: v })}
                >
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Normal</SelectItem>
                    <SelectItem value="uppercase">MAIÚSCULAS</SelectItem>
                    <SelectItem value="lowercase">minúsculas</SelectItem>
                    <SelectItem value="capitalize">Capitalizado</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="border-t pt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Sombra do texto</Label>
                  <Switch
                    checked={selectedField.shadowEnabled}
                    onCheckedChange={(v) => updateSelectedField({ shadowEnabled: v })}
                  />
                </div>
                {selectedField.shadowEnabled && (
                  <div className="space-y-2 pl-2 border-l-2 border-purple-200">
                    <div className="flex gap-2 items-center">
                      <Label className="text-xs w-12">Cor</Label>
                      <input
                        type="color"
                        value={selectedField.shadowColor}
                        onChange={(e) => updateSelectedField({ shadowColor: e.target.value })}
                        className="w-6 h-6 rounded border cursor-pointer"
                      />
                      <Input
                        value={selectedField.shadowColor}
                        onChange={(e) => updateSelectedField({ shadowColor: e.target.value })}
                        className="h-7 text-xs flex-1"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">Offset X: {selectedField.shadowOffsetX}</Label>
                        <Slider
                          value={[selectedField.shadowOffsetX]}
                          min={-20}
                          max={20}
                          step={1}
                          onValueChange={([v]) => updateSelectedField({ shadowOffsetX: v })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Offset Y: {selectedField.shadowOffsetY}</Label>
                        <Slider
                          value={[selectedField.shadowOffsetY]}
                          min={-20}
                          max={20}
                          step={1}
                          onValueChange={([v]) => updateSelectedField({ shadowOffsetY: v })}
                        />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs">Blur: {selectedField.shadowBlur}</Label>
                      <Slider
                        value={[selectedField.shadowBlur]}
                        min={0}
                        max={30}
                        step={1}
                        onValueChange={([v]) => updateSelectedField({ shadowBlur: v })}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t pt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold">Contorno (Stroke)</Label>
                  <Switch
                    checked={selectedField.strokeEnabled}
                    onCheckedChange={(v) => updateSelectedField({ strokeEnabled: v })}
                  />
                </div>
                {selectedField.strokeEnabled && (
                  <div className="space-y-2 pl-2 border-l-2 border-purple-200">
                    <div className="flex gap-2 items-center">
                      <Label className="text-xs w-12">Cor</Label>
                      <input
                        type="color"
                        value={selectedField.strokeColor}
                        onChange={(e) => updateSelectedField({ strokeColor: e.target.value })}
                        className="w-6 h-6 rounded border cursor-pointer"
                      />
                      <Input
                        value={selectedField.strokeColor}
                        onChange={(e) => updateSelectedField({ strokeColor: e.target.value })}
                        className="h-7 text-xs flex-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Espessura: {selectedField.strokeWidth}px</Label>
                      <Slider
                        value={[selectedField.strokeWidth]}
                        min={0.5}
                        max={10}
                        step={0.5}
                        onValueChange={([v]) => updateSelectedField({ strokeWidth: v })}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden"
        onChange={handleImageUpload}
      />
    </div>
  );
}
