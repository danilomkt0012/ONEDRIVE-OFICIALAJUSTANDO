import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import WhatsAppPreview from "@/components/WhatsAppPreview";
import {
  Plus, Trash2, Save, Play, Pause, GripVertical,
  Clock, ArrowRight, ChevronDown, ChevronUp,
  Settings, Type, Image, Mic, List, Variable,
  AlertTriangle, Copy, Sparkles, Info, RefreshCw, ExternalLink,
  Volume2, Loader2,
} from "lucide-react";
import AudioRecorder from "@/components/AudioRecorder";
import AudioFileUpload from "@/components/AudioFileUpload";
import ImageTemplateModal from "@/components/ImageTemplateModal";
import VoiceConfigPanel from "@/components/bot/VoiceConfigPanel";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface MessageHeader {
  type: "text" | "image";
  value: string;
}

interface ButtonPayloadItem {
  id?: string;
  title?: string;
  nextNodeId?: string;
}

interface ListSection {
  title: string;
  rows: Array<{ id: string; title: string; description?: string; nextNodeId?: string }>;
}

interface ListPayload {
  button: string;
  sections: ListSection[];
  header?: MessageHeader;
  footer?: string;
  cswFallback?: CswFallbackAction;
}

type CswFallbackAction = "text_only" | "skip" | "end" | "campaign_default";

interface ButtonsPayloadMeta {
  items: ButtonPayloadItem[];
  header?: MessageHeader;
  footer?: string;
  cswFallback?: CswFallbackAction;
}

type ButtonsOrListPayload = ButtonPayloadItem[] | ListPayload | ButtonsPayloadMeta | null;

interface NodeCondition {
  id: string;
  matchType: "keyword" | "regex" | "exact" | "any";
  matchValue: string;
  nextNodeId: string;
}

interface FlowNode {
  tempId: string;
  nodeType: "start" | "message" | "end";
  sortOrder: number;
  label: string;
  messageContent: string;
  messageType: "text" | "image" | "audio" | "buttons" | "list" | "combined" | "image_template" | "tts_audio";
  mediaUrl: string;
  buttonPayload: ButtonsOrListPayload;
  conditions: NodeCondition[];
  defaultNextNodeId: string;
  timeoutMinutes: number | null;
  timeoutAction: "end" | "reminder" | "next";
  timeoutNextNodeId: string;
  timeoutMessage: string;
  delaySeconds: number;
  variableCapture: string;
  linkUrl: string;
}

const BTN_COND_PREFIX = "cond_btn_";
const ROW_COND_PREFIX = "cond_row_";

function isButtonsPayloadMeta(payload: ButtonsOrListPayload): payload is ButtonsPayloadMeta {
  return payload !== null && !Array.isArray(payload) && "items" in payload;
}

function isListPayloadObj(payload: ButtonsOrListPayload): payload is ListPayload {
  return payload !== null && !Array.isArray(payload) && "sections" in payload;
}

function getButtonsPayloadMeta(payload: ButtonsOrListPayload): ButtonsPayloadMeta {
  if (isButtonsPayloadMeta(payload)) return payload;
  const items: ButtonPayloadItem[] = Array.isArray(payload) ? payload : [];
  return { items };
}

function getListPayload(payload: ButtonsOrListPayload): ListPayload {
  if (isListPayloadObj(payload)) return payload;
  return { button: "Menu", sections: [{ title: "Opções", rows: [{ id: "1", title: "Opção 1" }] }] };
}

function syncButtonRouting(
  updatedItems: ButtonPayloadItem[],
  allConditions: NodeCondition[]
): NodeCondition[] {
  const isManaged = (c: NodeCondition) => c.id.startsWith(BTN_COND_PREFIX);
  const managedByTitle = new Map<string, NodeCondition>();
  allConditions.filter(isManaged).forEach(c => managedByTitle.set(c.matchValue, c));
  const unmanaged = allConditions.filter(c => !isManaged(c));

  const newManaged: NodeCondition[] = [];
  for (const btn of updatedItems) {
    if (!btn.title || !btn.nextNodeId) continue;
    const existing = managedByTitle.get(btn.title);
    if (existing) {
      newManaged.push({ ...existing, matchValue: btn.title, nextNodeId: btn.nextNodeId });
    } else {
      newManaged.push({
        id: `${BTN_COND_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        matchType: "keyword",
        matchValue: btn.title,
        nextNodeId: btn.nextNodeId,
      });
    }
  }

  return [...unmanaged, ...newManaged];
}

function syncRowRouting(
  allRows: Array<{ id: string; title: string; description?: string; nextNodeId?: string }>,
  allConditions: NodeCondition[]
): NodeCondition[] {
  const isManaged = (c: NodeCondition) => c.id.startsWith(ROW_COND_PREFIX);
  const managedByTitle = new Map<string, NodeCondition>();
  allConditions.filter(isManaged).forEach(c => managedByTitle.set(c.matchValue, c));
  const unmanaged = allConditions.filter(c => !isManaged(c));

  const newManaged: NodeCondition[] = [];
  for (const row of allRows) {
    if (!row.title || !row.nextNodeId) continue;
    const existing = managedByTitle.get(row.title);
    if (existing) {
      newManaged.push({ ...existing, matchValue: row.title, nextNodeId: row.nextNodeId });
    } else {
      newManaged.push({
        id: `${ROW_COND_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        matchType: "keyword",
        matchValue: row.title,
        nextNodeId: row.nextNodeId,
      });
    }
  }

  return [...unmanaged, ...newManaged];
}

function createEmptyNode(index: number): FlowNode {
  return {
    tempId: `temp_${Date.now()}_${index}`,
    nodeType: "message",
    sortOrder: index,
    label: `Etapa ${index + 1}`,
    messageContent: "",
    messageType: "text",
    mediaUrl: "",
    buttonPayload: null,
    conditions: [],
    defaultNextNodeId: "",
    timeoutMinutes: null,
    timeoutAction: "end",
    timeoutNextNodeId: "",
    timeoutMessage: "",
    delaySeconds: 3,
    variableCapture: "",
    linkUrl: "",
  };
}

function createStartNode(): FlowNode {
  return {
    ...createEmptyNode(0),
    nodeType: "start",
    label: "Inicio (Lead responde ao template)",
    messageContent: "",
    conditions: [{
      id: `cond_${Date.now()}`,
      matchType: "any",
      matchValue: "",
      nextNodeId: "",
    }],
  };
}

const MSG_TYPE_OPTIONS = [
  { value: "text", label: "Texto", icon: Type },
  { value: "image", label: "Imagem", icon: Image },
  { value: "audio", label: "Áudio", icon: Mic },
  { value: "buttons", label: "Botões", icon: List },
  { value: "list", label: "Lista interativa", icon: List },
  { value: "combined", label: "Texto + Mídia", icon: Image },
  { value: "image_template", label: "Imagem Personalizada", icon: Sparkles },
  { value: "tts_audio", label: "Voz TTS", icon: Mic },
];

const MATCH_TYPE_OPTIONS = [
  { value: "any", label: "Qualquer resposta" },
  { value: "keyword", label: "Contem palavra-chave" },
  { value: "exact", label: "Resposta exata" },
  { value: "regex", label: "Expressão regular" },
];

const CHAR_LIMITS = {
  buttonTitle: 20,
  textHeader: 60,
  footer: 60,
};

function InlineAudioPlayer({ src }: { src: string }) {
  const [error, setError] = useState(false);

  useEffect(() => { setError(false); }, [src]);

  if (error) {
    return (
      <p className="text-[10px] text-red-400 mt-1">Não foi possível carregar o áudio</p>
    );
  }

  return (
    <div className="mt-2">
      <audio
        controls
        src={src}
        onError={() => setError(true)}
        className="w-full h-8"
      />
    </div>
  );
}

function CharCounter({ value, max }: { value: string; max: number }) {
  const len = (value || "").length;
  const over = len > max;
  return (
    <span className={`text-[10px] ml-1 ${over ? "text-red-500 font-semibold" : "text-gray-400"}`}>
      {len}/{max}
    </span>
  );
}

function isNodeValid(node: FlowNode): { valid: boolean; error?: string } {
  if (node.nodeType === "start") return { valid: true };
  if (!node.messageContent.trim() && node.messageType !== "audio" && node.messageType !== "image" && node.messageType !== "image_template" && node.messageType !== "tts_audio") {
    return { valid: false, error: "conteúdo obrigatório" };
  }
  if (node.messageType === "audio" && !node.mediaUrl.trim()) {
    return { valid: false, error: "URL do áudio obrigatória" };
  }
  if (node.messageType === "tts_audio" && !node.mediaUrl.trim()) {
    return { valid: false, error: "Perfil de voz obrigatório" };
  }
  if (node.messageType === "tts_audio" && !node.messageContent.trim()) {
    return { valid: false, error: "Template de texto TTS obrigatório" };
  }
  if (node.messageType === "image" && !node.mediaUrl.trim() && !node.messageContent.trim()) {
    return { valid: false, error: "URL ou legenda obrigatória" };
  }
  if (node.messageType === "image_template" && !node.mediaUrl.trim()) {
    return { valid: false, error: "selecione um template de imagem" };
  }
  if (node.messageType === "buttons") {
    const meta = getButtonsPayloadMeta(node.buttonPayload);
    if (meta.header?.type === "text" && meta.header.value && meta.header.value.length > CHAR_LIMITS.textHeader) {
      return { valid: false, error: `Header texto excede ${CHAR_LIMITS.textHeader} chars` };
    }
    if (meta.footer && meta.footer.length > CHAR_LIMITS.footer) {
      return { valid: false, error: `Footer excede ${CHAR_LIMITS.footer} chars` };
    }
    for (const btn of meta.items) {
      if (btn.title && btn.title.length > CHAR_LIMITS.buttonTitle) {
        return { valid: false, error: `Título "${btn.title}" excede ${CHAR_LIMITS.buttonTitle} chars` };
      }
    }
  }
  if (node.messageType === "list") {
    const lp = getListPayload(node.buttonPayload);
    if (lp.header?.type === "text" && lp.header.value && lp.header.value.length > CHAR_LIMITS.textHeader) {
      return { valid: false, error: `Header texto excede ${CHAR_LIMITS.textHeader} chars` };
    }
    if (lp.footer && lp.footer.length > CHAR_LIMITS.footer) {
      return { valid: false, error: `Footer excede ${CHAR_LIMITS.footer} chars` };
    }
  }
  return { valid: true };
}

interface FlowIssue {
  type: "error" | "warning";
  nodeLabel: string;
  message: string;
}

function getNodeStepLabel(node: FlowNode, index: number): string {
  if (node.nodeType === "start") return "Início";
  if (node.nodeType === "end") return "Fim";
  const typeLabel = MSG_TYPE_OPTIONS.find(o => o.value === node.messageType)?.label || node.messageType;
  return `Etapa ${index + 1} — ${typeLabel}`;
}

function detectFlowIssues(nodes: FlowNode[]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const idToIndex = new Map<string, number>();
  nodes.forEach((n, i) => idToIndex.set(n.tempId, i));

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const label = getNodeStepLabel(node, i);

    if (node.nodeType === "end") continue;

    const validResult = isNodeValid(node);
    if (!validResult.valid) {
      issues.push({ type: "error", nodeLabel: label, message: validResult.error || "configuração inválida" });
    }

    for (const cond of node.conditions) {
      if (cond.matchType !== "any" && !cond.matchValue.trim()) {
        issues.push({ type: "error", nodeLabel: label, message: "condição sem texto de resposta (palavra-chave ou padrão vazio)" });
      }
      if (!cond.nextNodeId) {
        issues.push({ type: "warning", nodeLabel: label, message: "condição sem destino configurado (avança automaticamente para a próxima etapa)" });
        continue;
      }
      const targetIdx = idToIndex.get(cond.nextNodeId);
      if (targetIdx === undefined) {
        issues.push({ type: "warning", nodeLabel: label, message: "condição aponta para etapa inexistente" });
      } else if (targetIdx <= i && nodes[targetIdx].nodeType !== "end") {
        const targetLabel = getNodeStepLabel(nodes[targetIdx], targetIdx);
        issues.push({ type: "error", nodeLabel: label, message: `loop detectado: aponta de volta para "${targetLabel}"` });
      }
    }

    if (node.defaultNextNodeId) {
      const targetIdx = idToIndex.get(node.defaultNextNodeId);
      if (targetIdx === undefined) {
        issues.push({ type: "warning", nodeLabel: label, message: "destino padrão aponta para etapa inexistente" });
      } else if (targetIdx <= i && nodes[targetIdx].nodeType !== "end") {
        const targetLabel = getNodeStepLabel(nodes[targetIdx], targetIdx);
        issues.push({ type: "error", nodeLabel: label, message: `loop no destino padrão: aponta para "${targetLabel}"` });
      }
    }

    if (node.timeoutAction === "next" && node.timeoutNextNodeId) {
      const targetIdx = idToIndex.get(node.timeoutNextNodeId);
      if (targetIdx === undefined) {
        issues.push({ type: "warning", nodeLabel: label, message: "destino de timeout aponta para etapa inexistente" });
      } else if (targetIdx <= i && nodes[targetIdx].nodeType !== "end") {
        const targetLabel = getNodeStepLabel(nodes[targetIdx], targetIdx);
        issues.push({ type: "error", nodeLabel: label, message: `loop no timeout: aponta para "${targetLabel}"` });
      }
    }

    const isFreeInputRisk =
      node.messageType === "text" &&
      node.conditions.length === 0 &&
      !node.buttonPayload &&
      node.nodeType !== "start";
    if (isFreeInputRisk) {
      issues.push({
        type: "warning",
        nodeLabel: label,
        message:
          "Nó de entrada livre detectado: aceita qualquer resposta de texto sem filtro. Adicione condições ou botões para guiar o usuário e reduzir risco de spam/ban.",
      });
    }
  }

  return issues;
}

function buildFlowPath(nodes: FlowNode[]): Array<{ node: FlowNode; index: number; hasIssue: boolean }> {
  if (nodes.length === 0) return [];
  const problematicTempIds = detectProblematicNodeIds(nodes);

  return nodes.map((node, index) => ({
    node,
    index,
    hasIssue: problematicTempIds.has(node.tempId),
  }));
}

function detectProblematicNodeIds(nodes: FlowNode[]): Set<string> {
  const idToIndex = new Map<string, number>();
  nodes.forEach((n, i) => idToIndex.set(n.tempId, i));
  const problematic = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.nodeType === "end") continue;

    if (!isNodeValid(node).valid) {
      problematic.add(node.tempId);
    }

    const checkTarget = (targetId: string) => {
      if (!targetId) return;
      const targetIdx = idToIndex.get(targetId);
      if (targetIdx === undefined || (targetIdx <= i && nodes[targetIdx].nodeType !== "end")) {
        problematic.add(node.tempId);
      }
    };

    for (const cond of node.conditions) {
      if (cond.matchType !== "any" && !cond.matchValue.trim()) problematic.add(node.tempId);
      if (!cond.nextNodeId) problematic.add(node.tempId);
      else checkTarget(cond.nextNodeId);
    }
    if (node.defaultNextNodeId) checkTarget(node.defaultNextNodeId);
    if (node.timeoutAction === "next" && node.timeoutNextNodeId) checkTarget(node.timeoutNextNodeId);
  }

  return problematic;
}

interface NodeEditorProps {
  node: FlowNode;
  index: number;
  total: number;
  nodes: FlowNode[];
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (updates: Partial<FlowNode>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onAddAfter: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}

function NodeEditor({
  node, index, total, nodes, expanded, onToggle, onUpdate, onRemove, onDuplicate, onAddAfter, onMoveUp, onMoveDown, onDragStart, onDragEnd, isDragging
}: NodeEditorProps) {
  const isStart = node.nodeType === "start";
  const isEnd = node.nodeType === "end";
  const validResult = isNodeValid(node);
  const valid = validResult.valid;

  const [imageTemplateModalOpen, setImageTemplateModalOpen] = useState(false);
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  const [linkVarType, setLinkVarType] = useState<"link" | "dynamic_link" | null>(null);
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { data: imageTemplateList = [], refetch: refetchImageTemplates } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["/api/image-templates"],
    enabled: node.messageType === "image_template",
    staleTime: 60_000,
  });

  const { data: voiceProfileList = [] } = useQuery<Array<{ id: string; name: string; gender: string }>>({
    queryKey: ["/api/voices"],
    enabled: node.messageType === "tts_audio",
    staleTime: 30_000,
  });

  const addCondition = () => {
    const nextNode = nodes[index + 1];
    const defaultNextNodeId = nextNode ? nextNode.tempId : "";
    onUpdate({
      conditions: [...node.conditions, {
        id: `cond_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        matchType: "keyword" as const,
        matchValue: "",
        nextNodeId: defaultNextNodeId,
      }],
    });
  };

  const updateCondition = (condId: string, updates: Partial<NodeCondition>) => {
    onUpdate({
      conditions: node.conditions.map(c => c.id === condId ? { ...c, ...updates } : c),
    });
  };

  const removeCondition = (condId: string) => {
    onUpdate({ conditions: node.conditions.filter(c => c.id !== condId) });
  };

  const isLoopTarget = (targetTempId: string): boolean => {
    if (!targetTempId) return false;
    const targetIdx = nodes.findIndex(n => n.tempId === targetTempId);
    return targetIdx !== -1 && targetIdx <= index && nodes[targetIdx].nodeType !== "end";
  };

  const nodeSelectOptions = nodes
    .map((n, i) => ({ node: n, index: i }))
    .filter(({ node: n }) => n.tempId !== node.tempId)
    .map(({ node: n, index: i }) => ({
      value: n.tempId,
      label: getNodeStepLabel(n, i),
      isLoop: n.tempId !== node.tempId && nodes.findIndex(x => x.tempId === n.tempId) <= index && n.nodeType !== "end",
    }));

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`rounded-lg border transition-all duration-150 ${isDragging ? "opacity-40 scale-[0.98]" : "opacity-100"} ${
        !valid && !isStart ? "border-red-300 bg-red-50/30" : expanded ? "border-blue-300 bg-white shadow-sm" : "border-gray-200 bg-white hover:border-gray-300"
      } ${isStart ? "border-l-4 border-l-emerald-500" : isEnd ? "border-l-4 border-l-red-400" : "border-l-4 border-l-blue-500"}`}
    >
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
        onClick={onToggle}
      >
        <div
          className="text-gray-300 hover:text-gray-500 cursor-grab flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical size={16} />
        </div>

        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 ${
          isStart ? "bg-emerald-500" : isEnd ? "bg-red-400" : "bg-blue-500"
        }`}>
          {isStart ? "S" : isEnd ? "F" : index}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-gray-800 truncate">{node.label}</span>
            {!valid && !isStart && (
              <AlertTriangle size={12} className="text-red-500 flex-shrink-0" />
            )}
            {node.messageType !== "text" && !isStart && (
              <span className="text-[9px] bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-medium uppercase flex-shrink-0">
                {node.messageType}
              </span>
            )}
          </div>
          {node.messageType === "tts_audio" && !isStart ? (() => {
            let ttsCfg: { speed?: number; pitch?: number; humanize?: boolean } = {};
            try { ttsCfg = JSON.parse(node.linkUrl || "{}"); } catch {}
            const ttsVoice = voiceProfileList.find(v => v.id === node.mediaUrl);
            const ttsSpeed = (ttsCfg.speed ?? 1.0).toFixed(1);
            const ttsNatural = ttsCfg.humanize !== false ? "Natural" : "Literal";
            return (
              <p className="text-[11px] text-purple-600 truncate mt-0.5 font-medium">
                🎙️ {ttsVoice?.name ?? "—"} • {ttsSpeed}x • {ttsNatural}
                {node.messageContent ? <span className="text-gray-400 font-normal"> · {node.messageContent.substring(0, 30)}</span> : null}
              </p>
            );
          })() : node.messageContent && (
            <p className="text-[11px] text-gray-400 truncate mt-0.5">{node.messageContent.substring(0, 70)}</p>
          )}
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {!isStart && index > 0 && (
            <button className="p-1 text-gray-300 hover:text-gray-600 rounded" onClick={onMoveUp} title="Mover cima">
              <ChevronUp size={14} />
            </button>
          )}
          {!isEnd && index < total - 1 && (
            <button className="p-1 text-gray-300 hover:text-gray-600 rounded" onClick={onMoveDown} title="Mover baixo">
              <ChevronDown size={14} />
            </button>
          )}
          {!isStart && !isEnd && (
            <button className="p-1 text-gray-300 hover:text-blue-500 rounded" onClick={onDuplicate} title="Duplicar">
              <Copy size={13} />
            </button>
          )}
          {!isStart && (
            <button className="p-1 text-gray-300 hover:text-red-500 rounded" onClick={onRemove} title="Remover">
              <Trash2 size={13} />
            </button>
          )}
          <div className="p-1 text-gray-400">
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100 pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-medium text-gray-500 mb-1 block">Nome da etapa</label>
              <Input
                value={node.label}
                onChange={(e) => onUpdate({ label: e.target.value })}
                className="text-sm h-8"
                placeholder="Ex: Solicitar CPF"
              />
            </div>
            {!isStart && (
              <div>
                <label className="text-[11px] font-medium text-gray-500 mb-1 block">Tipo</label>
                <select
                  value={node.messageType}
                  onChange={(e) => onUpdate({ messageType: e.target.value as FlowNode["messageType"] })}
                  className="w-full h-8 text-sm border border-gray-200 rounded-md px-2 bg-white"
                >
                  {MSG_TYPE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {!isStart && (
            <div>
              <label className="text-[11px] font-medium text-gray-500 mb-1 block">
                Mensagem do bot
                {!valid && validResult.error && (
                  <span className="text-red-500 ml-1">— {validResult.error}</span>
                )}
              </label>
              <Textarea
                ref={messageTextareaRef}
                value={node.messageContent}
                onChange={(e) => onUpdate({ messageContent: e.target.value })}
                className={`text-sm min-h-[70px] ${!valid && !node.messageContent.trim() ? "border-red-300 focus:border-red-400" : ""}`}
                placeholder='Ex: Obrigado {{nome}}! Informe seu CPF:'
              />
              <p className="text-[10px] text-gray-400 mt-1">Variáveis: {"{{nome}}"}, {"{{cpf}}"}, {"{{1}}"}, {"{{2}}"}, {"{{link}}"}, {"{{dynamic_link}}"}</p>
            </div>
          )}

          {node.messageType === "text" && !isStart && !isEnd && (
            <div className="border border-blue-100 rounded-lg p-2.5 space-y-2 bg-blue-50/40">
              <p className="text-[10px] font-semibold text-blue-700 uppercase tracking-wide flex items-center gap-1">
                <ExternalLink size={10} /> Inserir variável de link
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setLinkVarType(linkVarType === "link" ? null : "link")}
                  className={`text-[11px] px-2.5 py-1 rounded border font-medium transition-colors ${linkVarType === "link" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-700 border-blue-300 hover:bg-blue-50"}`}
                >
                  Link
                </button>
                <button
                  type="button"
                  onClick={() => setLinkVarType(linkVarType === "dynamic_link" ? null : "dynamic_link")}
                  className={`text-[11px] px-2.5 py-1 rounded border font-medium transition-colors ${linkVarType === "dynamic_link" ? "bg-blue-600 text-white border-blue-600" : "bg-white text-blue-700 border-blue-300 hover:bg-blue-50"}`}
                >
                  Link Dinâmico
                </button>
              </div>
              {linkVarType && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-blue-600">
                    {linkVarType === "link"
                      ? "Cole a URL base. Será inserida exatamente como está."
                      : "Cole a URL base. O CPF do lead será adicionado ao final (ex: /12345678900)."}
                  </p>
                  <div className="flex gap-1.5">
                    <Input
                      value={node.linkUrl}
                      onChange={(e) => onUpdate({ linkUrl: e.target.value })}
                      className="text-xs h-7 flex-1"
                      placeholder="https://site.com/pagina"
                    />
                    <button
                      type="button"
                      disabled={!node.linkUrl.trim()}
                      onClick={() => {
                        const variable = linkVarType === "link" ? "{{link}}" : "{{dynamic_link}}";
                        const ta = messageTextareaRef.current;
                        if (ta) {
                          const start = ta.selectionStart ?? node.messageContent.length;
                          const end = ta.selectionEnd ?? node.messageContent.length;
                          const newContent = node.messageContent.substring(0, start) + variable + node.messageContent.substring(end);
                          onUpdate({ messageContent: newContent });
                          requestAnimationFrame(() => {
                            ta.focus();
                            const pos = start + variable.length;
                            ta.setSelectionRange(pos, pos);
                          });
                        } else {
                          onUpdate({ messageContent: node.messageContent + variable });
                        }
                        setLinkVarType(null);
                      }}
                      className="h-7 px-3 text-[11px] font-medium bg-blue-600 text-white rounded disabled:opacity-40 hover:bg-blue-700 flex-shrink-0"
                    >
                      Inserir
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {(node.messageType === "image" || node.messageType === "audio" || node.messageType === "combined") && !isStart && (
            <div>
              <label className="text-[11px] font-medium text-gray-500 mb-1 block">URL da mídia</label>
              <div className="flex gap-2">
                <Input
                  value={node.mediaUrl}
                  onChange={(e) => onUpdate({ mediaUrl: e.target.value })}
                  className="text-sm h-8 flex-1"
                  placeholder="https://exemplo.com/imagem.jpg"
                />
                {(node.messageType === "audio" || node.messageType === "combined") && (
                  <>
                    <AudioFileUpload
                      onUploaded={(url) => onUpdate({ mediaUrl: url })}
                    />
                    <AudioRecorder
                      onRecorded={(url) => onUpdate({ mediaUrl: url })}
                    />
                  </>
                )}
              </div>
              {node.messageType === "audio" && node.mediaUrl && (
                <InlineAudioPlayer src={node.mediaUrl} />
              )}
            </div>
          )}

          {node.messageType === "image_template" && !isStart && (
            <div className="space-y-2">
              <label className="text-[11px] font-medium text-gray-500 mb-1 block">Template de Imagem Personalizada</label>
              <div className="flex gap-1">
                <select
                  value={node.mediaUrl}
                  onChange={(e) => onUpdate({ mediaUrl: e.target.value })}
                  className="flex-1 h-8 text-sm border border-gray-200 rounded-md px-2 bg-white"
                >
                  <option value="">Selecione um template…</option>
                  {imageTemplateList.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => refetchImageTemplates()}
                  className="h-8 w-8 flex items-center justify-center rounded-md border border-gray-200 bg-white hover:bg-gray-50 text-gray-500 hover:text-gray-700 flex-shrink-0"
                  title="Atualizar lista de templates"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {node.mediaUrl && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
                  <Sparkles size={12} className="text-slate-400 flex-shrink-0" />
                  <span className="text-[11px] text-slate-500">
                    O bot vai gerar uma imagem personalizada com o nome e CPF do lead ao enviar.
                  </span>
                </div>
              )}
              {!node.mediaUrl && imageTemplateList.length === 0 && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-amber-50 border border-amber-200">
                  <Info size={12} className="text-amber-500 flex-shrink-0" />
                  <span className="text-[11px] text-amber-700 flex-1">
                    Nenhum template cadastrado.
                  </span>
                  <button
                    type="button"
                    onClick={() => setImageTemplateModalOpen(true)}
                    className="text-[11px] text-amber-700 font-medium underline underline-offset-2 hover:text-amber-900 flex-shrink-0 flex items-center gap-0.5"
                  >
                    Criar agora
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setImageTemplateModalOpen(true)}
                className="w-full h-7 flex items-center justify-center gap-1.5 text-[11px] font-medium text-purple-700 border border-purple-200 rounded-md bg-purple-50 hover:bg-purple-100"
              >
                <Plus size={12} />
                Criar Template
              </button>
              <ImageTemplateModal
                open={imageTemplateModalOpen}
                onClose={() => setImageTemplateModalOpen(false)}
                onSaved={() => {
                  setImageTemplateModalOpen(false);
                  refetchImageTemplates();
                }}
              />
            </div>
          )}

          {node.messageType === "tts_audio" && !isStart && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full text-xs flex items-center gap-1.5"
                onClick={() => setVoiceSheetOpen(true)}
              >
                <Volume2 className="h-3.5 w-3.5" />
                Configurar Voz TTS
              </Button>

              <Sheet open={voiceSheetOpen} onOpenChange={setVoiceSheetOpen}>
                <SheetContent side="right" className="w-[400px] sm:max-w-[400px] overflow-y-auto">
                  <SheetHeader className="mb-4">
                    <SheetTitle className="flex items-center gap-2 text-base">
                      <Volume2 className="h-4 w-4" />
                      Configuração de Voz TTS
                    </SheetTitle>
                  </SheetHeader>
                  <VoiceConfigPanel
                    node={node}
                    onUpdate={onUpdate}
                    voiceProfileList={voiceProfileList}
                  />
                </SheetContent>
              </Sheet>
            </>
          )}

          {node.messageType === "buttons" && !isStart && (() => {
            const meta = getButtonsPayloadMeta(node.buttonPayload);
            const updateMeta = (updates: Partial<ButtonsPayloadMeta>) => {
              const newMeta = { ...meta, ...updates };
              const newConditions = syncButtonRouting(newMeta.items, node.conditions);
              onUpdate({ buttonPayload: newMeta, conditions: newConditions });
            };

            return (
              <div className="space-y-2">
                <div className="border border-gray-100 rounded-lg p-2 space-y-2 bg-gray-50">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Cabeçalho (opcional)</p>
                  <div className="flex gap-2">
                    <select
                      value={meta.header?.type || "text"}
                      onChange={(e) => updateMeta({ header: { type: e.target.value as "text" | "image", value: meta.header?.value || "" } })}
                      className="text-[11px] border border-gray-200 rounded px-1.5 h-7 bg-white"
                    >
                      <option value="text">Texto</option>
                      <option value="image">URL de imagem</option>
                    </select>
                    <div className="flex-1 relative">
                      <Input
                        value={meta.header?.value || ""}
                        onChange={(e) => updateMeta({ header: { type: meta.header?.type || "text", value: e.target.value } })}
                        className={`text-xs h-7 ${meta.header?.type === "text" ? "pr-14" : ""} ${meta.header?.type === "text" && meta.header.value && meta.header.value.length > CHAR_LIMITS.textHeader ? "border-red-400" : ""}`}
                        placeholder={meta.header?.type === "image" ? "https://..." : "Texto do cabeçalho"}
                      />
                      {meta.header?.type === "text" && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                          <CharCounter value={meta.header?.value || ""} max={CHAR_LIMITS.textHeader} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border border-gray-100 rounded-lg p-2 space-y-2 bg-gray-50">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Rodapé (opcional)</p>
                  <div className="relative">
                    <Input
                      value={meta.footer || ""}
                      onChange={(e) => updateMeta({ footer: e.target.value })}
                      className={`text-xs h-7 pr-14 ${meta.footer && meta.footer.length > CHAR_LIMITS.footer ? "border-red-400" : ""}`}
                      placeholder="Ex: Responda com uma das opções"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                      <CharCounter value={meta.footer || ""} max={CHAR_LIMITS.footer} />
                    </span>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-medium text-gray-500 mb-1 block">Botões (max 3)</label>
                  <div className="space-y-2">
                    {meta.items.map((btn, bi) => (
                      <div key={bi} className="border border-gray-100 rounded p-2 bg-white space-y-1.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 relative">
                            <Input
                              value={btn.title || ""}
                              onChange={(e) => {
                                const items = [...meta.items];
                                items[bi] = { ...items[bi], title: e.target.value, id: e.target.value };
                                updateMeta({ items });
                              }}
                              className={`text-sm h-7 pr-12 ${btn.title && btn.title.length > CHAR_LIMITS.buttonTitle ? "border-red-400" : ""}`}
                              placeholder={`Botão ${bi + 1}`}
                              maxLength={20}
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2">
                              <CharCounter value={btn.title || ""} max={CHAR_LIMITS.buttonTitle} />
                            </span>
                          </div>
                          <button
                            className="text-red-400 hover:text-red-600 flex-shrink-0"
                            onClick={() => {
                              const items = meta.items.filter((_, i) => i !== bi);
                              updateMeta({ items });
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <div className="flex items-center gap-1">
                          <ArrowRight size={10} className="text-gray-400 flex-shrink-0" />
                          {isLoopTarget(btn.nextNodeId || "") && (
                            <AlertTriangle size={10} className="text-red-500 flex-shrink-0" />
                          )}
                          <select
                            value={btn.nextNodeId || ""}
                            onChange={(e) => {
                              const items = [...meta.items];
                              items[bi] = { ...items[bi], nextNodeId: e.target.value };
                              updateMeta({ items });
                            }}
                            className={`text-[10px] border rounded px-1.5 py-1 bg-white flex-1 ${isLoopTarget(btn.nextNodeId || "") ? "border-red-400 text-red-600" : "border-gray-200"}`}
                          >
                            <option value="">Próxima etapa (auto)</option>
                            {nodeSelectOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}{opt.isLoop ? " ⚠ loop" : ""}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                    {meta.items.length < 3 && (
                      <button
                        className="text-[11px] text-blue-500 hover:underline"
                        onClick={() => {
                          const items = [...meta.items, { id: "", title: "" }];
                          updateMeta({ items });
                        }}
                      >
                        + Adicionar botão
                      </button>
                    )}
                  </div>
                </div>

                <div className="border border-amber-100 rounded-lg p-2 space-y-1.5 bg-amber-50/50">
                  <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1">
                    <Clock size={10} /> Janela fechada (CSW)
                  </p>
                  <p className="text-[10px] text-amber-600">
                    Define o que fazer quando a janela de 24h estiver fechada e os botões não puderem ser enviados.
                  </p>
                  <select
                    value={meta.cswFallback || "campaign_default"}
                    onChange={(e) => updateMeta({ cswFallback: e.target.value as CswFallbackAction })}
                    className="w-full text-[11px] border border-amber-200 rounded px-2 h-7 bg-white"
                  >
                    <option value="campaign_default">Usar padrão da campanha</option>
                    <option value="text_only">Enviar só o texto (sem botões)</option>
                    <option value="skip">Pular o nó silenciosamente</option>
                    <option value="end">Encerrar a conversa</option>
                  </select>
                </div>
              </div>
            );
          })()}

          {node.messageType === "list" && !isStart && (() => {
            const lp = getListPayload(node.buttonPayload);
            const updateList = (updates: Partial<ListPayload>) => {
              const newLp = { ...lp, ...updates };
              const allRows = newLp.sections.flatMap(s => s.rows);
              const newConditions = syncRowRouting(allRows, node.conditions);
              onUpdate({ buttonPayload: newLp, conditions: newConditions });
            };

            return (
              <div className="space-y-2">
                <label className="text-[11px] font-medium text-gray-500 mb-1 block">Lista interativa</label>

                <div className="border border-gray-100 rounded-lg p-2 space-y-2 bg-gray-50">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Cabeçalho (opcional)</p>
                  <div className="flex gap-2">
                    <select
                      value={lp.header?.type || "text"}
                      onChange={(e) => updateList({ header: { type: e.target.value as "text" | "image", value: lp.header?.value || "" } })}
                      className="text-[11px] border border-gray-200 rounded px-1.5 h-7 bg-white"
                    >
                      <option value="text">Texto</option>
                      <option value="image">URL de imagem</option>
                    </select>
                    <div className="flex-1 relative">
                      <Input
                        value={lp.header?.value || ""}
                        onChange={(e) => updateList({ header: { type: lp.header?.type || "text", value: e.target.value } })}
                        className={`text-xs h-7 ${lp.header?.type === "text" ? "pr-14" : ""} ${lp.header?.type === "text" && lp.header.value && lp.header.value.length > CHAR_LIMITS.textHeader ? "border-red-400" : ""}`}
                        placeholder={lp.header?.type === "image" ? "https://..." : "Texto do cabeçalho"}
                      />
                      {lp.header?.type === "text" && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                          <CharCounter value={lp.header?.value || ""} max={CHAR_LIMITS.textHeader} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border border-gray-100 rounded-lg p-2 space-y-2 bg-gray-50">
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Rodapé (opcional)</p>
                  <div className="relative">
                    <Input
                      value={lp.footer || ""}
                      onChange={(e) => updateList({ footer: e.target.value })}
                      className={`text-xs h-7 pr-14 ${lp.footer && lp.footer.length > CHAR_LIMITS.footer ? "border-red-400" : ""}`}
                      placeholder="Ex: Selecione uma opção"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                      <CharCounter value={lp.footer || ""} max={CHAR_LIMITS.footer} />
                    </span>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-gray-500 block mb-1">Rótulo do botão de menu</label>
                  <Input
                    value={lp.button}
                    onChange={(e) => updateList({ button: e.target.value })}
                    className="text-sm h-7"
                    placeholder="Ver opções"
                    maxLength={20}
                  />
                </div>

                {lp.sections.map((section, si) => (
                  <div key={si} className="border border-gray-200 rounded p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Input
                        value={section.title}
                        onChange={(e) => {
                          const secs = [...lp.sections];
                          secs[si] = { ...secs[si], title: e.target.value };
                          updateList({ sections: secs });
                        }}
                        className="text-sm h-7 flex-1"
                        placeholder="Título da seção"
                      />
                      <button
                        className="text-red-400 hover:text-red-600"
                        onClick={() => {
                          const secs = lp.sections.filter((_, i) => i !== si);
                          updateList({ sections: secs.length > 0 ? secs : [{ title: "Opções", rows: [] }] });
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {section.rows.map((row, ri) => (
                      <div key={ri} className="border border-gray-100 rounded p-1.5 pl-3 space-y-1 bg-white">
                        <div className="flex items-center gap-1">
                          <Input
                            value={row.title}
                            onChange={(e) => {
                              const secs = [...lp.sections];
                              const rows = [...secs[si].rows];
                              rows[ri] = { ...rows[ri], title: e.target.value, id: e.target.value };
                              secs[si] = { ...secs[si], rows };
                              updateList({ sections: secs });
                            }}
                            className="text-xs h-6 flex-1"
                            placeholder={`Item ${ri + 1}`}
                          />
                          <button
                            className="text-red-400 hover:text-red-600 flex-shrink-0"
                            onClick={() => {
                              const secs = [...lp.sections];
                              const rows = secs[si].rows.filter((_, i) => i !== ri);
                              secs[si] = { ...secs[si], rows };
                              updateList({ sections: secs });
                            }}
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                        <Input
                          value={row.description || ""}
                          onChange={(e) => {
                            const secs = [...lp.sections];
                            const rows = [...secs[si].rows];
                            rows[ri] = { ...rows[ri], description: e.target.value };
                            secs[si] = { ...secs[si], rows };
                            updateList({ sections: secs });
                          }}
                          className="text-[10px] h-5 text-gray-500"
                          placeholder="Descrição (opcional)"
                        />
                        <div className="flex items-center gap-1">
                          <ArrowRight size={9} className="text-gray-400 flex-shrink-0" />
                          {isLoopTarget(row.nextNodeId || "") && (
                            <AlertTriangle size={9} className="text-red-500 flex-shrink-0" />
                          )}
                          <select
                            value={row.nextNodeId || ""}
                            onChange={(e) => {
                              const secs = [...lp.sections];
                              const rows = [...secs[si].rows];
                              rows[ri] = { ...rows[ri], nextNodeId: e.target.value };
                              secs[si] = { ...secs[si], rows };
                              updateList({ sections: secs });
                            }}
                            className={`text-[9px] border rounded px-1 py-0.5 bg-white flex-1 ${isLoopTarget(row.nextNodeId || "") ? "border-red-400 text-red-600" : "border-gray-200"}`}
                          >
                            <option value="">Próxima etapa (auto)</option>
                            {nodeSelectOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>{opt.label}{opt.isLoop ? " ⚠ loop" : ""}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                    <button
                      className="text-[10px] text-blue-500 hover:underline pl-3"
                      onClick={() => {
                        const secs = [...lp.sections];
                        const rows = [...secs[si].rows, { id: `${si}_${secs[si].rows.length}`, title: "" }];
                        secs[si] = { ...secs[si], rows };
                        updateList({ sections: secs });
                      }}
                    >
                      + Adicionar item
                    </button>
                  </div>
                ))}
                <button
                  className="text-[11px] text-blue-500 hover:underline"
                  onClick={() => {
                    const secs = [...lp.sections, { title: `Seção ${lp.sections.length + 1}`, rows: [{ id: "1", title: "" }] }];
                    updateList({ sections: secs });
                  }}
                >
                  + Adicionar seção
                </button>

                <div className="border border-amber-100 rounded-lg p-2 space-y-1.5 bg-amber-50/50">
                  <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1">
                    <Clock size={10} /> Janela fechada (CSW)
                  </p>
                  <p className="text-[10px] text-amber-600">
                    Define o que fazer quando a janela de 24h estiver fechada e a lista não puder ser enviada.
                  </p>
                  <select
                    value={lp.cswFallback || "campaign_default"}
                    onChange={(e) => updateList({ cswFallback: e.target.value as CswFallbackAction })}
                    className="w-full text-[11px] border border-amber-200 rounded px-2 h-7 bg-white"
                  >
                    <option value="campaign_default">Usar padrão da campanha</option>
                    <option value="text_only">Enviar só o texto (sem lista)</option>
                    <option value="skip">Pular o nó silenciosamente</option>
                    <option value="end">Encerrar a conversa</option>
                  </select>
                </div>
              </div>
            );
          })()}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-medium text-gray-500">
                Condições de transição
              </label>
              <button
                className="text-[11px] text-blue-500 hover:underline flex items-center gap-0.5"
                onClick={addCondition}
              >
                <Plus size={11} /> Condição
              </button>
            </div>
            {node.conditions.length === 0 && (
              <p className="text-[11px] text-gray-400 italic">Avança automaticamente para a próxima etapa</p>
            )}
            <div className="space-y-1.5">
              {node.conditions.map((cond) => {
                const loopCond = isLoopTarget(cond.nextNodeId);
                return (
                  <div key={cond.id} className="flex items-center gap-1.5 bg-gray-50 p-1.5 rounded">
                    <select
                      value={cond.matchType}
                      onChange={(e) => updateCondition(cond.id, { matchType: e.target.value as NodeCondition["matchType"] })}
                      className="text-[11px] border border-gray-200 rounded px-1.5 py-1 bg-white"
                    >
                      {MATCH_TYPE_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {cond.matchType !== "any" && (
                      <Input
                        value={cond.matchValue}
                        onChange={(e) => updateCondition(cond.id, { matchValue: e.target.value })}
                        className="text-[11px] h-6 flex-1"
                        placeholder={cond.matchType === "regex" ? "^\\d{11}$" : "Palavra-chave"}
                      />
                    )}
                    <div className="flex items-center gap-0.5 flex-1">
                      {loopCond && (
                        <AlertTriangle size={11} className="text-red-500 flex-shrink-0" />
                      )}
                      <select
                        value={cond.nextNodeId}
                        onChange={(e) => updateCondition(cond.id, { nextNodeId: e.target.value })}
                        className={`text-[11px] border rounded px-1.5 py-1 bg-white flex-1 ${loopCond ? "border-red-400 text-red-600" : "border-gray-200"}`}
                      >
                        <option value="">Próxima (auto)</option>
                        {nodeSelectOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}{opt.isLoop ? " ⚠ loop" : ""}</option>
                        ))}
                      </select>
                    </div>
                    <button className="text-red-400 hover:text-red-600" onClick={() => removeCondition(cond.id)}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {!isStart && !isEnd && (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[11px] font-medium text-gray-500 mb-1 block">
                  <Clock size={10} className="inline mr-1" />Delay (seg)
                </label>
                <Input
                  type="number"
                  value={node.delaySeconds}
                  onChange={(e) => onUpdate({ delaySeconds: parseInt(e.target.value) || 0 })}
                  className="text-sm h-7"
                  min={0}
                  max={30}
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-gray-500 mb-1 block">
                  <Variable size={10} className="inline mr-1" />Capturar variável
                </label>
                <Input
                  value={node.variableCapture}
                  onChange={(e) => onUpdate({ variableCapture: e.target.value })}
                  className="text-sm h-7"
                  placeholder="Ex: cpf"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-gray-500 mb-1 block">
                  <Clock size={10} className="inline mr-1" />Timeout (min)
                </label>
                <Input
                  type="number"
                  value={node.timeoutMinutes || ""}
                  onChange={(e) => onUpdate({ timeoutMinutes: e.target.value ? parseInt(e.target.value) : null })}
                  className="text-sm h-7"
                  placeholder="Sem timeout"
                  min={1}
                />
              </div>
            </div>
          )}

          {node.timeoutMinutes && node.timeoutMinutes > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] font-medium text-gray-500 mb-1 block">Ação no timeout</label>
                <select
                  value={node.timeoutAction}
                  onChange={(e) => onUpdate({ timeoutAction: e.target.value as FlowNode["timeoutAction"] })}
                  className="w-full h-7 text-sm border border-gray-200 rounded px-2 bg-white"
                >
                  <option value="end">Encerrar conversa</option>
                  <option value="reminder">Enviar lembrete</option>
                  <option value="next">Pular para etapa</option>
                </select>
              </div>
              {node.timeoutAction === "reminder" && (
                <div>
                  <label className="text-[11px] font-medium text-gray-500 mb-1 block">Mensagem do lembrete</label>
                  <Input
                    value={node.timeoutMessage}
                    onChange={(e) => onUpdate({ timeoutMessage: e.target.value })}
                    className="text-sm h-7"
                    placeholder="Oi! Ainda está aí?"
                  />
                </div>
              )}
              {node.timeoutAction === "next" && (
                <div>
                  <label className="text-[11px] font-medium text-gray-500 mb-1 block">Pular para qual etapa</label>
                  <div className="flex items-center gap-1">
                    {isLoopTarget(node.timeoutNextNodeId) && (
                      <AlertTriangle size={12} className="text-red-500 flex-shrink-0" />
                    )}
                    <select
                      value={node.timeoutNextNodeId}
                      onChange={(e) => onUpdate({ timeoutNextNodeId: e.target.value })}
                      className={`w-full h-7 text-sm border rounded px-2 bg-white ${isLoopTarget(node.timeoutNextNodeId) ? "border-red-400 text-red-600" : "border-gray-200"}`}
                    >
                      <option value="">Próxima (auto)</option>
                      {nodeSelectOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}{opt.isLoop ? " ⚠ loop" : ""}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            className="text-[11px] text-blue-500 hover:underline flex items-center gap-1 mt-1"
            onClick={onAddAfter}
          >
            <Plus size={11} /> Adicionar etapa abaixo
          </button>
        </div>
      )}
    </div>
  );
}

interface BotFlowData {
  name?: string;
  isActive?: boolean;
  version?: number;
  nodes?: any[];
}

interface BotFlowStats {
  total: number;
  active: number;
  completed: number;
  timedOut: number;
}

interface BotFlowEditorProps {
  campaignId: string;
}

export default function BotFlowEditor({ campaignId }: BotFlowEditorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [flowName, setFlowName] = useState("Fluxo principal");
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(true);

  const flowIssues = useMemo(() => detectFlowIssues(nodes), [nodes]);
  const flowPathItems = useMemo(() => buildFlowPath(nodes), [nodes]);

  const { data: flowData, isLoading } = useQuery<BotFlowData>({
    queryKey: [`/api/campaigns/${campaignId}/bot-flow`],
    enabled: !!campaignId,
  });

  const { data: stats } = useQuery<BotFlowStats>({
    queryKey: [`/api/campaigns/${campaignId}/bot-flow/stats`],
    enabled: !!campaignId,
    refetchInterval: 15000,
  });

  useEffect(() => {
    if (flowData && flowData.nodes && flowData.nodes.length > 0) {
      setFlowName(flowData.name || "Fluxo principal");
      const mapped: FlowNode[] = flowData.nodes.map((n: any, i: number) => ({
        tempId: n.id || `temp_${i}`,
        nodeType: n.nodeType || "message",
        sortOrder: n.sortOrder ?? i,
        label: n.label || `Etapa ${i + 1}`,
        messageContent: n.messageContent || "",
        messageType: n.messageType || "text",
        mediaUrl: n.mediaUrl || "",
        buttonPayload: n.buttonPayload || null,
        conditions: Array.isArray(n.conditions) ? n.conditions : [],
        defaultNextNodeId: n.defaultNextNodeId || "",
        timeoutMinutes: n.timeoutMinutes || null,
        timeoutAction: n.timeoutAction || "end",
        timeoutNextNodeId: n.timeoutNextNodeId || "",
        timeoutMessage: n.timeoutMessage || "",
        delaySeconds: n.delaySeconds ?? 3,
        variableCapture: n.variableCapture || "",
        linkUrl: n.linkUrl || "",
      }));
      setNodes(mapped);
    } else if (!flowData || !flowData?.nodes?.length) {
      setNodes([createStartNode()]);
    }
  }, [flowData]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: flowName,
        nodes: nodes.map((n, i) => ({ ...n, id: n.tempId, sortOrder: i })),
      };
      const res = await apiRequest("PUT", `/api/campaigns/${campaignId}/bot-flow`, payload);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Fluxo salvo", description: `Versão ${data.version}` });
      setHasChanges(false);
      queryClient.invalidateQueries({ queryKey: [`/api/campaigns/${campaignId}/bot-flow`] });
    },
    onError: (err: any) => {
      toast({ title: "Erro ao salvar", description: err.message, variant: "destructive" });
    },
  });

  const activateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/bot-flow/activate`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Fluxo ativado", description: "O bot está respondendo." });
      queryClient.invalidateQueries({ queryKey: [`/api/campaigns/${campaignId}/bot-flow`] });
    },
    onError: (err: any) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/bot-flow/deactivate`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Fluxo desativado" });
      queryClient.invalidateQueries({ queryKey: [`/api/campaigns/${campaignId}/bot-flow`] });
    },
    onError: (err: any) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const migrateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/campaigns/${campaignId}/bot-flow/migrate`);
      return res.json();
    },
    onSuccess: (data) => {
      if (data.migrated) {
        toast({ title: "Regras migradas" });
        queryClient.invalidateQueries({ queryKey: [`/api/campaigns/${campaignId}/bot-flow`] });
      } else {
        toast({ title: "Nada para migrar", description: data.message, variant: "destructive" });
      }
    },
    onError: (err: any) => {
      toast({ title: "Erro na migração", description: err.message, variant: "destructive" });
    },
  });

  const updateNode = useCallback((tempId: string, updates: Partial<FlowNode>) => {
    setNodes(prev => prev.map(n => n.tempId === tempId ? { ...n, ...updates } : n));
    setHasChanges(true);
  }, []);

  const addNodeAfter = useCallback((index: number) => {
    setNodes(prev => {
      const newNodes = [...prev];
      const newNode = createEmptyNode(index + 1);
      newNodes.splice(index + 1, 0, newNode);
      return newNodes.map((n, i) => ({ ...n, sortOrder: i }));
    });
    setHasChanges(true);
  }, []);

  const removeNode = useCallback((tempId: string) => {
    setNodes(prev => {
      const filtered = prev.filter(n => n.tempId !== tempId);
      return filtered.map((n, i) => ({ ...n, sortOrder: i }));
    });
    setHasChanges(true);
  }, []);

  const moveNode = useCallback((index: number, direction: "up" | "down") => {
    setNodes(prev => {
      const newNodes = [...prev];
      const targetIdx = direction === "up" ? index - 1 : index + 1;
      if (targetIdx < 0 || targetIdx >= newNodes.length) return prev;
      [newNodes[index], newNodes[targetIdx]] = [newNodes[targetIdx], newNodes[index]];
      return newNodes.map((n, i) => ({ ...n, sortOrder: i }));
    });
    setHasChanges(true);
  }, []);

  const duplicateNode = useCallback((tempId: string) => {
    setNodes(prev => {
      const idx = prev.findIndex(n => n.tempId === tempId);
      if (idx < 0) return prev;
      const src = prev[idx];
      const dup: FlowNode = {
        ...src,
        tempId: `temp_${Date.now()}_dup`,
        label: `${src.label} (copia)`,
        sortOrder: idx + 1,
        conditions: src.conditions.map(c => ({
          ...c,
          id: `cond_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        })),
      };
      const newNodes = [...prev];
      newNodes.splice(idx + 1, 0, dup);
      return newNodes.map((n, i) => ({ ...n, sortOrder: i }));
    });
    setHasChanges(true);
  }, []);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) return;
    setDragOverIndex(index);
  }, [dragIndex]);

  const handleDrop = useCallback((dropIndex: number) => {
    if (dragIndex === null || dragIndex === dropIndex) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    setNodes(prev => {
      const newNodes = [...prev];
      const [removed] = newNodes.splice(dragIndex, 1);
      newNodes.splice(dropIndex, 0, removed);
      return newNodes.map((n, i) => ({ ...n, sortOrder: i }));
    });
    setHasChanges(true);
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  const isFlowActive = flowData?.isActive === true;
  const criticalIssues = flowIssues.filter(i => i.type === "error");
  const warningIssues = flowIssues.filter(i => i.type === "warning");
  const hasErrors = criticalIssues.length > 0;
  const hasWarnings = warningIssues.length > 0;
  const canSave = hasChanges && !hasErrors;

  if (isLoading) {
    return (
      <div className="p-6 text-center text-gray-400">
        <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2" />
        Carregando fluxo...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between sticky top-0 z-10 bg-white dark:bg-card py-2 -mx-1 px-1 rounded-md border-b border-gray-100 mb-1">
        <div className="flex items-center gap-2">
          <Settings className="text-blue-500" size={18} />
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Bot Programável</h3>
            <p className="text-[10px] text-gray-400">Conversa guiada por etapas</p>
          </div>
          {hasErrors && (
            <div className="flex items-center gap-1 text-[11px] text-red-500 bg-red-50 border border-red-200 rounded px-2 py-0.5">
              <AlertTriangle size={11} /> {criticalIssues.length} erro(s) crítico(s)
            </div>
          )}
          {!hasErrors && hasWarnings && (
            <div className="flex items-center gap-1 text-[11px] text-yellow-600 bg-yellow-50 border border-yellow-200 rounded px-2 py-0.5">
              <AlertTriangle size={11} /> {warningIssues.length} aviso(s)
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {stats && stats.total > 0 && (
            <div className="flex items-center gap-2 text-[10px] text-gray-500 bg-gray-50 px-2 py-1 rounded">
              <span>{stats.active} ativos</span>
              <span>|</span>
              <span>{stats.completed} completos</span>
            </div>
          )}
          {!flowData && (
            <Button
              size="sm"
              variant="outline"
              className="text-purple-600 border-purple-300 hover:bg-purple-50 h-7 text-xs"
              onClick={() => migrateMutation.mutate()}
              disabled={migrateMutation.isPending}
            >
              <ArrowRight size={12} className="mr-1" /> Migrar Regras
            </Button>
          )}
          {isFlowActive ? (
            <Button
              size="sm"
              variant="outline"
              className="text-orange-600 border-orange-300 hover:bg-orange-50 h-7 text-xs"
              onClick={() => deactivateMutation.mutate()}
              disabled={deactivateMutation.isPending}
            >
              <Pause size={12} className="mr-1" /> Pausar
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs"
              onClick={() => {
                if (hasChanges) {
                  toast({ title: "Salve primeiro", description: "Salve as alterações antes de ativar", variant: "destructive" });
                  return;
                }
                activateMutation.mutate();
              }}
              disabled={activateMutation.isPending || nodes.length < 2}
            >
              <Play size={12} className="mr-1" /> Ativar
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !canSave}
            className="bg-blue-600 hover:bg-blue-700 text-white h-7 text-xs"
            title={hasErrors ? `Corrija ${criticalIssues.length} erro(s) antes de salvar` : !hasChanges ? "Nenhuma alteração para salvar" : ""}
          >
            <Save size={12} className="mr-1" /> Salvar
          </Button>
        </div>
      </div>

      {isFlowActive && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#38A169]" />
          <span className="text-xs text-slate-600 font-medium">Fluxo ativo — o bot está respondendo automaticamente</span>
        </div>
      )}

      <div
        className="border border-gray-200 rounded-lg bg-gray-50 overflow-hidden"
      >
        <button
          className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-medium text-gray-600 hover:bg-gray-100 transition-colors"
          onClick={() => setSummaryOpen(v => !v)}
        >
          <span className="flex items-center gap-1.5">
            <Info size={12} className="text-blue-500" />
            Resumo do fluxo
          </span>
          {summaryOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {summaryOpen && (
          <div className="px-3 pb-3 pt-1 space-y-2">
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              {flowPathItems.map(({ node, index, hasIssue }, i) => (
                <span key={node.tempId} className="flex items-center gap-1">
                  <span className={`px-1.5 py-0.5 rounded font-medium ${
                    hasIssue
                      ? "bg-red-100 text-red-600 border border-red-200"
                      : node.nodeType === "start"
                      ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                      : node.nodeType === "end"
                      ? "bg-red-100 text-red-600 border border-red-200"
                      : "bg-blue-50 text-blue-700 border border-blue-100"
                  }`}>
                    {hasIssue && <AlertTriangle size={9} className="inline mr-0.5" />}
                    {getNodeStepLabel(node, index)}
                  </span>
                  {i < flowPathItems.length - 1 && (
                    <ArrowRight size={10} className="text-gray-400 flex-shrink-0" />
                  )}
                </span>
              ))}
            </div>
            {(hasErrors || hasWarnings) && (
              <div className="space-y-1 pt-1 border-t border-gray-200">
                {criticalIssues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px] text-red-600">
                    <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                    <span><strong>{issue.nodeLabel}:</strong> {issue.message}</span>
                  </div>
                ))}
                {warningIssues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[11px] text-yellow-700">
                    <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                    <span><strong>{issue.nodeLabel}:</strong> {issue.message}</span>
                  </div>
                ))}
              </div>
            )}
            {!hasErrors && !hasWarnings && nodes.length > 1 && (
              <p className="text-[11px] text-green-600 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                Nenhum problema detectado no fluxo
              </p>
            )}
          </div>
        )}
      </div>

      {hasErrors && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 space-y-1">
          <p className="text-[11px] font-semibold text-red-600 flex items-center gap-1">
            <AlertTriangle size={12} /> Erros críticos — o botão Salvar está bloqueado até serem corrigidos
          </p>
          {criticalIssues.map((issue, i) => (
            <p key={i} className="text-[11px] text-red-500 pl-4">• <strong>{issue.nodeLabel}:</strong> {issue.message}</p>
          ))}
        </div>
      )}

      {!hasErrors && hasWarnings && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 space-y-1">
          <p className="text-[11px] font-semibold text-yellow-700 flex items-center gap-1">
            <AlertTriangle size={12} /> Avisos — o fluxo pode ser salvo, mas verifique esses pontos
          </p>
          {warningIssues.map((issue, i) => (
            <p key={i} className="text-[11px] text-yellow-600 pl-4">• <strong>{issue.nodeLabel}:</strong> {issue.message}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4" style={{ minHeight: 480 }}>
        <div className="flex flex-col gap-2 overflow-y-auto pr-1" style={{ maxHeight: 600 }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Etapas do fluxo</span>
            <button
              className="text-[11px] text-blue-500 hover:underline flex items-center gap-1"
              onClick={() => addNodeAfter(nodes.length - 1)}
            >
              <Plus size={12} /> Adicionar etapa
            </button>
          </div>

          {nodes.map((node, index) => (
            <div
              key={node.tempId}
              onDragOver={(e) => { e.preventDefault(); handleDragOver(index); }}
              onDrop={() => handleDrop(index)}
              className={`transition-all ${dragOverIndex === index && dragIndex !== index ? "pt-1 border-t-2 border-blue-400" : ""}`}
            >
              <NodeEditor
                node={node}
                index={index}
                total={nodes.length}
                nodes={nodes}
                expanded={expandedNode === node.tempId}
                onToggle={() => setExpandedNode(expandedNode === node.tempId ? null : node.tempId)}
                onUpdate={(updates) => updateNode(node.tempId, updates)}
                onRemove={() => {
                  if (window.confirm(`Remover etapa "${node.label}"?`)) {
                    removeNode(node.tempId);
                  }
                }}
                onDuplicate={() => duplicateNode(node.tempId)}
                onAddAfter={() => addNodeAfter(index)}
                onMoveUp={() => moveNode(index, "up")}
                onMoveDown={() => moveNode(index, "down")}
                onDragStart={(e) => { e.stopPropagation(); handleDragStart(index); }}
                onDragEnd={handleDragEnd}
                isDragging={dragIndex === index}
              />
            </div>
          ))}

          <div
            className="border-2 border-dashed border-gray-200 rounded-lg p-3 text-center text-[11px] text-gray-400 cursor-pointer hover:border-blue-300 hover:text-blue-400 transition-colors"
            onClick={() => addNodeAfter(nodes.length - 1)}
          >
            <Plus size={16} className="mx-auto mb-1" />
            Adicionar etapa
          </div>
        </div>

        <div className="flex flex-col" style={{ minHeight: 480 }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Preview WhatsApp</span>
            <span className="text-[10px] text-gray-400 bg-gray-100 rounded px-2 py-0.5">Tempo real</span>
          </div>
          <div className="flex-1">
            <WhatsAppPreview nodes={nodes} />
          </div>
        </div>
      </div>
    </div>
  );
}
