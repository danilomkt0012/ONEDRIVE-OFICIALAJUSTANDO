import { useState, useEffect, useRef, useCallback } from "react";
import { Play, Send, ChevronRight, Mic, X, AlertTriangle } from "lucide-react";

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
}

interface ButtonsPayloadMeta {
  items: ButtonPayloadItem[];
  header?: MessageHeader;
  footer?: string;
}

interface NodeCondition {
  id: string;
  matchType: "keyword" | "regex" | "exact" | "any";
  matchValue: string;
  nextNodeId: string;
}

export interface FlowNode {
  tempId: string;
  nodeType: "start" | "message" | "end";
  sortOrder: number;
  label: string;
  messageContent: string;
  messageType: "text" | "image" | "audio" | "buttons" | "list" | "combined" | "image_template" | "tts_audio";
  mediaUrl: string;
  buttonPayload: ButtonPayloadItem[] | ListPayload | ButtonsPayloadMeta | null;
  conditions: NodeCondition[];
  defaultNextNodeId: string;
  timeoutMinutes: number | null;
  timeoutAction: "end" | "reminder" | "next";
  timeoutNextNodeId: string;
  timeoutMessage: string;
  delaySeconds: number;
  variableCapture: string;
}

interface PreviewMessage {
  id: string;
  from: "bot" | "user";
  content: string;
  type: FlowNode["messageType"] | "typing" | "text" | "image_template";
  mediaUrl?: string;
  buttonPayload?: ButtonPayloadItem[] | ListPayload | ButtonsPayloadMeta | null;
  time: string;
}

const MOCK_VARS: Record<string, string> = {
  "{{1}}": "Joao",
  "{{2}}": "R$100",
  "{{3}}": "Silva",
  "{{nome}}": "Joao Silva",
  "{{cpf}}": "123.456.789-00",
  "{{email}}": "joao@email.com",
  "{{resposta_anterior}}": "Sim, confirmo",
  "{{produto}}": "Plano Premium",
  "{{valor}}": "R$ 99,90",
};

function replaceMockVars(text: string): string {
  let result = text;
  for (const [key, val] of Object.entries(MOCK_VARS)) {
    result = result.replace(new RegExp(key.replace(/[{}]/g, "\\$&"), "g"), val);
  }
  return result;
}

function getTime(): string {
  return new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function matchesCondition(cond: NodeCondition, userInput: string): boolean {
  const input = userInput.trim().toLowerCase();
  const val = (cond.matchValue || "").trim().toLowerCase();
  switch (cond.matchType) {
    case "any": return true;
    case "keyword": return input.includes(val);
    case "exact": return input === val;
    case "regex": {
      try {
        return new RegExp(cond.matchValue, "i").test(userInput.trim());
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

function getNextNodeIndex(currentNode: FlowNode, nodes: FlowNode[], userInput: string): number {
  const currentIdx = nodes.findIndex(n => n.tempId === currentNode.tempId);
  const defaultNext = currentIdx + 1 < nodes.length ? currentIdx + 1 : -1;
  if (!currentNode.conditions || currentNode.conditions.length === 0) return defaultNext;
  for (const cond of currentNode.conditions) {
    if (matchesCondition(cond, userInput)) {
      if (cond.nextNodeId) {
        const idx = nodes.findIndex(n => n.tempId === cond.nextNodeId);
        return idx >= 0 ? idx : defaultNext;
      }
      return defaultNext;
    }
  }
  return defaultNext;
}

type ButtonsOrListPayload = ButtonPayloadItem[] | ListPayload | ButtonsPayloadMeta | null | undefined;

function isButtonsPayloadMeta(payload: ButtonsOrListPayload): payload is ButtonsPayloadMeta {
  return payload != null && !Array.isArray(payload) && "items" in payload;
}

function isListPayloadObj(payload: ButtonsOrListPayload): payload is ListPayload {
  return payload != null && !Array.isArray(payload) && "sections" in payload;
}

function getButtonsMeta(payload: ButtonsOrListPayload): { items: ButtonPayloadItem[]; header?: MessageHeader; footer?: string } | null {
  if (!payload) return null;
  if (Array.isArray(payload)) return { items: payload };
  if (isButtonsPayloadMeta(payload)) return payload;
  return null;
}

function getListPayload(payload: ButtonsOrListPayload): ListPayload | null {
  if (!payload || Array.isArray(payload)) return null;
  if (isListPayloadObj(payload)) return payload;
  return null;
}

function MessageHeader({ header }: { header: MessageHeader }) {
  if (header.type === "image" && header.value) {
    return (
      <img
        src={header.value}
        alt="Header"
        className="rounded-t-lg w-full max-h-[120px] object-cover mb-1"
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  if (header.type === "text" && header.value) {
    return <p className="text-sm font-bold text-gray-900 mb-1">{header.value}</p>;
  }
  return null;
}

function MessageFooter({ footer }: { footer: string }) {
  if (!footer) return null;
  return <p className="text-[10px] text-gray-400 mt-1 italic">{footer}</p>;
}

function BotBubble({ msg }: { msg: PreviewMessage }) {
  if (msg.type === "typing") {
    return (
      <div className="flex justify-start mb-2">
        <div className="bg-[#DCF8C6] rounded-lg rounded-tl-none px-3 py-2 shadow-sm">
          <div className="flex items-center gap-1 py-1">
            <span className="w-2 h-2 bg-[#25D366] rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-2 h-2 bg-[#25D366] rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-2 h-2 bg-[#25D366] rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (msg.type === "image") {
      return (
        <div>
          {msg.mediaUrl ? (
            <img
              src={msg.mediaUrl}
              alt="Imagem"
              className="rounded-lg max-w-full max-h-[180px] object-cover mb-1"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="rounded-lg h-[90px] bg-gray-200 flex items-center justify-center flex-col text-gray-400 text-xs mb-1">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span className="mt-1">Imagem</span>
            </div>
          )}
          {msg.content && <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.content}</p>}
        </div>
      );
    }

    if (msg.type === "image_template") {
      return (
        <div>
          <div className="rounded-lg h-[100px] bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center flex-col text-slate-400 text-xs mb-1 border border-slate-200">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span className="mt-1.5 font-medium">Imagem Personalizada</span>
            <span className="text-[10px] text-slate-300 mt-0.5">Gerada com dados do lead</span>
          </div>
          {msg.content && <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.content}</p>}
        </div>
      );
    }

    if (msg.type === "audio" || msg.type === "tts_audio") {
      if (msg.mediaUrl) {
        return (
          <AudioPlayerPreview src={msg.mediaUrl} />
        );
      }
      return (
        <div className="flex items-center gap-2 min-w-[180px]">
          <div className="w-8 h-8 rounded-full bg-[#25D366] flex items-center justify-center flex-shrink-0">
            <Play size={14} className="text-white ml-0.5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-0.5 h-5 mb-0.5">
              {[3,5,7,4,6,8,5,4,7,5,6,4,5,7,4].map((h, i) => (
                <div key={i} className="w-0.5 bg-[#25D366] rounded-full opacity-70" style={{ height: `${h * 2}px` }} />
              ))}
            </div>
            <span className="text-[10px] text-gray-500">0:08</span>
          </div>
        </div>
      );
    }

    if (msg.type === "combined") {
      return (
        <div>
          {msg.mediaUrl ? (
            <img
              src={msg.mediaUrl}
              alt="Mídia"
              className="rounded-lg max-w-full max-h-[140px] object-cover mb-1 w-full"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          ) : (
            <div className="rounded-lg h-[80px] bg-gray-200 flex items-center justify-center flex-col text-gray-400 text-xs mb-1">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span className="mt-0.5">Mídia</span>
            </div>
          )}
          {msg.content && <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.content}</p>}
        </div>
      );
    }

    if (msg.type === "buttons") {
      const meta = getButtonsMeta(msg.buttonPayload);
      const btns = meta?.items || [];
      const header = meta?.header;
      const footer = meta?.footer;
      return (
        <div>
          {header && header.value && <MessageHeader header={header} />}
          <p className="text-sm text-gray-900 whitespace-pre-wrap break-words mb-2">{msg.content}</p>
          {btns.length > 0 && (
            <div className="border-t border-green-300 pt-2 space-y-1">
              {btns.map((btn, i) => (
                <div key={i} className="text-center text-sm text-[#0078FF] py-1.5 border border-green-200 rounded-lg bg-white/50">
                  {btn.title || `Botão ${i + 1}`}
                </div>
              ))}
            </div>
          )}
          {footer && <MessageFooter footer={footer} />}
        </div>
      );
    }

    if (msg.type === "list") {
      const lp = getListPayload(msg.buttonPayload);
      if (lp) {
        const header = lp.header;
        const footer = lp.footer;
        return (
          <div>
            {header && header.value && <MessageHeader header={header} />}
            <p className="text-sm text-gray-900 whitespace-pre-wrap break-words mb-2">{msg.content}</p>
            <div className="border-t border-green-300 pt-2">
              <div className="flex items-center justify-center gap-1 w-full text-sm text-[#0078FF] py-1.5 rounded">
                <ChevronRight size={14} />
                {lp.button || "Ver opções"}
              </div>
            </div>
            {footer && <MessageFooter footer={footer} />}
          </div>
        );
      }
    }

    return <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.content}</p>;
  };

  return (
    <div className="flex justify-start mb-2">
      <div className="bg-[#DCF8C6] rounded-lg rounded-tl-none px-3 py-2 shadow-sm max-w-[80%]">
        {renderContent()}
        <div className="flex items-center justify-end mt-1">
          <span className="text-[10px] text-gray-500">{msg.time}</span>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ msg }: { msg: PreviewMessage }) {
  return (
    <div className="flex justify-end mb-2">
      <div className="bg-white rounded-lg rounded-tr-none px-3 py-2 shadow-sm max-w-[80%]">
        <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.content}</p>
        <div className="flex items-center justify-end mt-1">
          <span className="text-[10px] text-gray-500">{msg.time}</span>
        </div>
      </div>
    </div>
  );
}

function AudioPlayerPreview({ src }: { src: string }) {
  const [error, setError] = useState(false);

  useEffect(() => { setError(false); }, [src]);

  if (error) {
    return (
      <div className="flex items-center gap-2 min-w-[180px]">
        <div className="w-8 h-8 rounded-full bg-[#25D366] flex items-center justify-center flex-shrink-0">
          <Play size={14} className="text-white ml-0.5" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-0.5 h-5 mb-0.5">
            {[3,5,7,4,6,8,5,4,7,5,6,4,5,7,4].map((h, i) => (
              <div key={i} className="w-0.5 bg-[#25D366] rounded-full opacity-70" style={{ height: `${h * 2}px` }} />
            ))}
          </div>
          <span className="text-[10px] text-red-400">Não foi possível carregar o áudio</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-[180px]">
      <audio
        controls
        src={src}
        onError={() => setError(true)}
        className="w-full h-8"
        style={{ maxWidth: "220px" }}
      />
    </div>
  );
}

interface WhatsAppPreviewProps {
  nodes: FlowNode[];
}

export default function WhatsAppPreview({ nodes }: WhatsAppPreviewProps) {
  const messageNodes = nodes.filter(n => n.nodeType !== "start");

  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [currentNodeIndex, setCurrentNodeIndex] = useState(0);
  const [showSimInput, setShowSimInput] = useState(false);
  const [simInputVisible, setSimInputVisible] = useState(false);
  const [simInput, setSimInput] = useState("");
  const [awaitingInput, setAwaitingInput] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const generationRef = useRef(0);
  const timerIdsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearAllTimers = useCallback(() => {
    timerIdsRef.current.forEach(id => clearTimeout(id));
    timerIdsRef.current = [];
  }, []);

  const playBotNode = useCallback((
    node: FlowNode,
    prevMessages: PreviewMessage[],
    delayMs: number,
    gen: number,
    onDone: (finalMessages: PreviewMessage[], nodeIdx: number) => void,
    nodeIdx: number
  ) => {
    const typingDuration = Math.max(400, Math.min((node.delaySeconds || 1) * 1000, 2500));

    const t1 = setTimeout(() => {
      if (generationRef.current !== gen) return;
      const typingId = `typing_${node.tempId}_${gen}`;
      setMessages([...prevMessages, {
        id: typingId,
        from: "bot",
        content: "",
        type: "typing",
        time: getTime(),
      }]);

      const t2 = setTimeout(() => {
        if (generationRef.current !== gen) return;
        const botMsg: PreviewMessage = {
          id: `bot_${node.tempId}_${gen}_${Date.now()}`,
          from: "bot",
          content: replaceMockVars(node.messageContent || ""),
          type: node.messageType,
          mediaUrl: node.mediaUrl || undefined,
          buttonPayload: node.buttonPayload,
          time: getTime(),
        };
        const finalMsgs = [...prevMessages, botMsg];
        setMessages(finalMsgs);
        if (generationRef.current === gen) {
          onDone(finalMsgs, nodeIdx);
        }
      }, typingDuration);

      timerIdsRef.current.push(t2);
    }, delayMs);

    timerIdsRef.current.push(t1);
  }, []);

  const startConversation = useCallback((msgNodes: FlowNode[]) => {
    clearAllTimers();
    generationRef.current += 1;
    const gen = generationRef.current;

    setMessages([]);
    setCurrentNodeIndex(0);
    setShowSimInput(false);
    setSimInputVisible(false);
    setSimInput("");
    setAwaitingInput(false);

    if (msgNodes.length === 0) return;

    playBotNode(msgNodes[0], [], 400, gen, (finalMsgs, idx) => {
      if (generationRef.current !== gen) return;
      setCurrentNodeIndex(idx);
      if (msgNodes[idx].nodeType !== "end") {
        setShowSimInput(true);
        setSimInputVisible(false);
        setAwaitingInput(true);
      }
    }, 0);
  }, [clearAllTimers, playBotNode]);

  const prevContentRef = useRef<string>("");

  useEffect(() => {
    const newContent = JSON.stringify(messageNodes.map(n => ({
      id: n.tempId,
      content: n.messageContent,
      type: n.messageType,
      mediaUrl: n.mediaUrl,
      buttonPayload: n.buttonPayload,
      label: n.label,
    })));

    const prevContent = prevContentRef.current;
    prevContentRef.current = newContent;

    if (newContent !== prevContent) {
      startConversation(messageNodes);
    }
  }, [nodes]);

  useEffect(() => {
    if (messageNodes.length > 0) {
      startConversation(messageNodes);
    }
    return () => {
      clearAllTimers();
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const advanceToNext = useCallback((userText: string, currentIdx: number, currentMsgs: PreviewMessage[]) => {
    const currentNode = messageNodes[currentIdx];
    if (!currentNode) return;

    const nextIdx = getNextNodeIndex(currentNode, messageNodes, userText);
    if (nextIdx < 0 || nextIdx >= messageNodes.length) return;

    const nextNode = messageNodes[nextIdx];
    clearAllTimers();
    generationRef.current += 1;
    const gen = generationRef.current;

    setShowSimInput(false);
    setSimInputVisible(false);
    setAwaitingInput(false);

    playBotNode(nextNode, currentMsgs, 300, gen, (finalMsgs) => {
      if (generationRef.current !== gen) return;
      setCurrentNodeIndex(nextIdx);
      if (nextNode.nodeType !== "end") {
        setShowSimInput(true);
        setSimInputVisible(false);
        setAwaitingInput(true);
      }
    }, nextIdx);
  }, [messageNodes, clearAllTimers, playBotNode]);

  const handleSimulate = () => {
    if (!awaitingInput) return;
    const userText = simInput.trim() || "Resposta do usuario";
    setSimInput("");
    setSimInputVisible(false);
    setShowSimInput(false);
    setAwaitingInput(false);

    const userMsg: PreviewMessage = {
      id: `user_${Date.now()}`,
      from: "user",
      content: userText,
      type: "text",
      time: getTime(),
    };

    setMessages(prev => {
      const updated = [...prev, userMsg];
      setTimeout(() => advanceToNext(userText, currentNodeIndex, updated), 0);
      return updated;
    });
  };

  const handleButtonClick = (title: string) => {
    if (!awaitingInput) return;
    setShowSimInput(false);
    setSimInputVisible(false);
    setAwaitingInput(false);
    setSimInput("");

    const userMsg: PreviewMessage = {
      id: `user_btn_${Date.now()}`,
      from: "user",
      content: title,
      type: "text",
      time: getTime(),
    };

    setMessages(prev => {
      const updated = [...prev, userMsg];
      setTimeout(() => advanceToNext(title, currentNodeIndex, updated), 0);
      return updated;
    });
  };

  const currentNode = messageNodes[currentNodeIndex];
  const isButtonsNode = showSimInput && currentNode?.messageType === "buttons";
  const isListNode = showSimInput && currentNode?.messageType === "list";
  const isTextInput = showSimInput && !isButtonsNode && !isListNode;

  const currentButtonsMeta = isButtonsNode ? getButtonsMeta(currentNode?.buttonPayload) : null;
  const currentButtons = currentButtonsMeta?.items || [];

  const currentListSections = isListNode ? (getListPayload(currentNode?.buttonPayload)?.sections || []) : [];

  return (
    <div className="flex flex-col h-full rounded-xl overflow-hidden border border-gray-200 shadow-lg" style={{ minHeight: 480 }}>
      <div className="bg-[#075E54] px-3 py-2.5 flex items-center gap-3 flex-shrink-0">
        <div className="w-9 h-9 rounded-full bg-[#128C7E] flex items-center justify-center flex-shrink-0 text-white text-sm font-bold">
          B
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-semibold leading-none">Bot da Campanha</p>
          <p className="text-[#B2DFDB] text-[11px] mt-0.5">online</p>
        </div>
        <button
          onClick={() => startConversation(messageNodes)}
          className="text-[#B2DFDB] hover:text-white transition-colors text-[10px] flex items-center gap-1 border border-[#B2DFDB]/40 rounded px-2 py-1 flex-shrink-0"
        >
          <X size={10} /> Reiniciar
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3"
        style={{
          background: "#ECE5DD",
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23c9c0b3' fill-opacity='0.15'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
        }}
      >
        {messageNodes.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-500 text-sm bg-white/60 rounded-xl px-6 py-8 shadow-sm">
              <div className="text-4xl mb-2">💬</div>
              <p>Adicione etapas para ver o preview</p>
            </div>
          </div>
        )}

        {messages.map((msg) =>
          msg.from === "bot" ? (
            <BotBubble key={msg.id} msg={msg} />
          ) : (
            <UserBubble key={msg.id} msg={msg} />
          )
        )}

        {showSimInput && isButtonsNode && currentButtons.length > 0 && (
          <div className="mt-1 mb-2 space-y-1">
            {currentButtons.map((btn, i) => (
              <button
                key={i}
                onClick={() => handleButtonClick(btn.title || `Botão ${i + 1}`)}
                className="w-full text-center text-sm text-[#0078FF] py-2 bg-white border border-gray-200 rounded-lg hover:bg-blue-50 transition-colors shadow-sm"
              >
                {btn.title || `Botão ${i + 1}`}
              </button>
            ))}
          </div>
        )}

        {showSimInput && isListNode && currentListSections.length > 0 && (
          <div className="mt-1 mb-2 space-y-1">
            {currentListSections.flatMap(s => s.rows).map((row, i) => (
              <button
                key={i}
                onClick={() => handleButtonClick(row.title || `Item ${i + 1}`)}
                className="w-full text-left text-sm text-[#0078FF] py-2 px-3 bg-white border border-gray-200 rounded-lg hover:bg-blue-50 transition-colors shadow-sm flex items-center justify-between"
              >
                <div>
                  <span>{row.title || `Item ${i + 1}`}</span>
                  {row.description && <p className="text-[10px] text-gray-400 mt-0.5">{row.description}</p>}
                </div>
                <ChevronRight size={14} className="flex-shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {currentNode && (currentNode.messageType === "buttons" || currentNode.messageType === "list") && (
        <div className="bg-amber-50 border-t border-amber-200 px-3 py-2 flex items-start gap-2 flex-shrink-0">
          <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-700 leading-tight">
            {currentNode.messageType === "buttons" ? "Botões interativos" : "Lista interativa"}: só aparecem para contatos dentro da janela de 24h (CSW). Fora da janela, o fallback configurado será aplicado.
          </p>
        </div>
      )}

      <div className="bg-[#F0F0F0] px-2 py-2 flex-shrink-0 border-t border-gray-300">
        {isTextInput && simInputVisible ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-white rounded-full px-3 py-1.5 flex items-center gap-2 shadow-sm">
              <Mic size={16} className="text-gray-400 flex-shrink-0" />
              <input
                autoFocus
                className="flex-1 text-sm outline-none bg-transparent placeholder:text-gray-400"
                placeholder="Digite a resposta simulada..."
                value={simInput}
                onChange={(e) => setSimInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSimulate();
                  if (e.key === "Escape") setSimInputVisible(false);
                }}
              />
            </div>
            <button
              onClick={handleSimulate}
              className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center shadow-sm hover:bg-[#1eba58] transition-colors flex-shrink-0"
            >
              <Send size={15} className="text-white" />
            </button>
          </div>
        ) : isTextInput && !simInputVisible ? (
          <button
            onClick={() => setSimInputVisible(true)}
            className="w-full text-center text-sm text-white bg-[#25D366] hover:bg-[#1eba58] py-2 rounded-full shadow-sm transition-colors font-medium"
          >
            Simular resposta
          </button>
        ) : (
          <div className="flex items-center gap-2 opacity-40 pointer-events-none">
            <div className="flex-1 bg-white rounded-full px-3 py-1.5 flex items-center gap-2">
              <Mic size={16} className="text-gray-400" />
              <span className="text-sm text-gray-400">
                {!showSimInput && currentNodeIndex >= messageNodes.length - 1
                  ? "Fim do fluxo"
                  : isButtonsNode || isListNode
                  ? "Selecione uma opção acima"
                  : "Aguardando..."}
              </span>
            </div>
            <div className="w-9 h-9 rounded-full bg-[#25D366] flex items-center justify-center">
              <Send size={15} className="text-white" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
