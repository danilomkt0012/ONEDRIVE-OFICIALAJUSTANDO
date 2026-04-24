import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWaba } from "@/contexts/WabaContext";
import { useIsMobile } from "@/hooks/use-mobile";
import { Send, Search, Check, CheckCheck, MessageSquare, Clock, User, X, FileText, Image, Mic, Paperclip, Play, Download, File, ArrowLeft } from "lucide-react";

interface Conversation {
  id: string;
  wabaId: string;
  contactPhone: string;
  contactName: string | null;
  cswExpiresAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number | null;
}

interface ChatMessage {
  id: string;
  conversationId: string;
  direction: string;
  body: string | null;
  type: string | null;
  mediaUrl: string | null;
  metaMessageId: string | null;
  status: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

interface WhatsappTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: any;
}

function getRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("pt-BR");
}

function StatusIcon({ status }: { status: string | null }) {
  if (!status) return null;
  if (status === "failed") return <X size={14} className="text-red-500" />;
  if (status === "sent") return <Check size={14} className="text-gray-400" />;
  if (status === "delivered") return <CheckCheck size={14} className="text-gray-400" />;
  if (status === "read") return <CheckCheck size={14} className="text-blue-500" />;
  return null;
}

function extractTemplateParams(components: any): string[] {
  if (!components || !Array.isArray(components)) return [];
  const body = components.find((c: any) => c.type === "BODY");
  if (!body?.text) return [];
  const matches = body.text.match(/\{\{\d+\}\}/g);
  return matches || [];
}

function resolveMediaUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("meta:")) {
    const mediaId = url.substring(5);
    return `/api/media/${mediaId}`;
  }
  return url;
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isOutbound = msg.direction === "outbound";
  const msgType = msg.type || "text";
  const mediaUrl = resolveMediaUrl(msg.mediaUrl);

  const renderContent = () => {
    if (msgType === "image" && mediaUrl) {
      return (
        <div>
          <img
            src={mediaUrl}
            alt="Imagem"
            className="rounded-lg max-w-full max-h-[300px] object-contain mb-1 cursor-pointer"
            onClick={() => window.open(mediaUrl, "_blank")}
          />
          {msg.body && msg.body !== "[Imagem]" && (
            <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.body}</p>
          )}
        </div>
      );
    }

    if (msgType === "audio") {
      return (
        <div className="flex items-center gap-2 min-w-[200px]">
          <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
            <Play size={14} className="text-white ml-0.5" />
          </div>
          {mediaUrl ? (
            <audio controls className="max-w-[220px] h-8">
              <source src={mediaUrl} />
            </audio>
          ) : (
            <div className="flex-1">
              <div className="h-1 bg-gray-300 rounded-full">
                <div className="h-1 bg-green-500 rounded-full w-0" />
              </div>
              <span className="text-[10px] text-gray-500 mt-0.5">Audio</span>
            </div>
          )}
        </div>
      );
    }

    if (msgType === "document") {
      return (
        <div className="flex items-center gap-2 p-1">
          <File size={20} className="text-blue-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{msg.body || "Documento"}</p>
          </div>
          {mediaUrl && (
            <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
              <Download size={16} className="text-gray-500 hover:text-blue-500" />
            </a>
          )}
        </div>
      );
    }

    if (msgType === "template" && mediaUrl) {
      return (
        <div>
          <img
            src={mediaUrl}
            alt="Template"
            className="rounded-lg max-w-full max-h-[200px] object-contain mb-1"
          />
          <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.body}</p>
        </div>
      );
    }

    return (
      <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{msg.body}</p>
    );
  };

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[70%] rounded-lg px-3 py-2 shadow-sm ${
          isOutbound ? "bg-[#DCF8C6] rounded-tr-none" : "bg-white rounded-tl-none"
        }`}
      >
        {renderContent()}
        <div className="flex items-center justify-end gap-1 mt-1">
          <span className="text-[10px] text-gray-500">
            {msg.sentAt ? new Date(msg.sentAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}
          </span>
          {isOutbound && <StatusIcon status={msg.status} />}
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { wabasList, activeWabaId, setActiveWabaId } = useWaba();
  const isMobile = useIsMobile();
  const [selectedConvoId, setSelectedConvoId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [replyText, setReplyText] = useState("");
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<WhatsappTemplate | null>(null);
  const [templateParams, setTemplateParams] = useState<Record<string, string>>({});
  const [showMediaMenu, setShowMediaMenu] = useState(false);
  const [campaignFilter, setCampaignFilter] = useState<string>("all");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const { data: templates = [] } = useQuery<WhatsappTemplate[]>({
    queryKey: ["/api/templates"],
  });

  const { data: campaignsList = [] } = useQuery<Array<{ id: string; name: string; status: string }>>({
    queryKey: ["/api/campaigns/managed"],
    queryFn: async () => {
      const res = await fetch("/api/campaigns/managed");
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: conversationsResult, refetch: refetchConvos } = useQuery<{ data: Conversation[]; total: number }>({
    queryKey: [`/api/wabas/${activeWabaId}/conversations`, campaignFilter],
    queryFn: async () => {
      if (!activeWabaId) return { data: [], total: 0 };
      let url = `/api/wabas/${activeWabaId}/conversations`;
      if (campaignFilter && campaignFilter !== "all") {
        url += `?campaignId=${campaignFilter}`;
      }
      const res = await fetch(url);
      if (!res.ok) return { data: [], total: 0 };
      return res.json();
    },
    enabled: !!activeWabaId,
    refetchInterval: 10000,
  });
  const conversationsList = conversationsResult?.data || [];

  const { data: messagesList = [], refetch: refetchMessages } = useQuery<ChatMessage[]>({
    queryKey: [`/api/conversations/${selectedConvoId}/messages`],
    enabled: !!selectedConvoId,
  });

  useEffect(() => {
    if (!activeWabaId) return;
    if (eventSourceRef.current) eventSourceRef.current.close();

    const es = new EventSource(`/api/wabas/${activeWabaId}/events`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "new_message" || data.type === "status_update") {
          refetchConvos();
          if (data.conversationId === selectedConvoId) refetchMessages();
        }
      } catch {}
    };

    return () => { es.close(); };
  }, [activeWabaId, selectedConvoId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesList]);

  const replyMutation = useMutation({
    mutationFn: async ({ conversationId, text }: { conversationId: string; text: string }) => {
      const response = await apiRequest("POST", `/api/conversations/${conversationId}/reply`, { text });
      return response.json();
    },
    onSuccess: () => {
      setReplyText("");
      refetchMessages();
      refetchConvos();
    },
    onError: (error: any) => {
      toast({ title: "Erro ao enviar", description: error.message, variant: "destructive" });
    },
  });

  const sendMediaMutation = useMutation({
    mutationFn: async ({ conversationId, type, file, caption }: { conversationId: string; type: string; file: File; caption?: string }) => {
      const formData = new FormData();
      formData.append(type, file);
      if (caption) formData.append("caption", caption);
      if (type === "document") formData.append("filename", file.name);
      const response = await fetch(`/api/conversations/${conversationId}/send-${type}`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Erro ao enviar");
      }
      return response.json();
    },
    onSuccess: () => {
      refetchMessages();
      refetchConvos();
      setShowMediaMenu(false);
    },
    onError: (error: any) => {
      toast({ title: "Erro ao enviar mídia", description: error.message, variant: "destructive" });
    },
  });

  const sendTemplateMutation = useMutation({
    mutationFn: async ({ conversationId, templateName, language, parameters }: { conversationId: string; templateName: string; language: string; parameters: string[] }) => {
      const response = await apiRequest("POST", `/api/conversations/${conversationId}/send-template`, { templateName, language, parameters });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Template enviado" });
      setShowTemplateModal(false);
      setSelectedTemplate(null);
      setTemplateParams({});
      refetchMessages();
      refetchConvos();
    },
    onError: (error: any) => {
      toast({ title: "Erro ao enviar template", description: error.message, variant: "destructive" });
    },
  });

  const selectedConvo = conversationsList.find((c) => c.id === selectedConvoId);
  const isCswActive = selectedConvo?.cswExpiresAt ? new Date(selectedConvo.cswExpiresAt) > new Date() : false;
  const approvedTemplates = templates.filter((t) => t.status === "APPROVED");

  const filteredConversations = conversationsList.filter((c) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (c.contactName?.toLowerCase().includes(term) || c.contactPhone.includes(term));
  });

  const handleSendReply = () => {
    if (!replyText.trim() || !selectedConvoId) return;
    replyMutation.mutate({ conversationId: selectedConvoId, text: replyText });
  };

  const handleSendTemplate = () => {
    if (!selectedTemplate || !selectedConvoId) return;
    const params = extractTemplateParams(selectedTemplate.components);
    const paramValues = params.map((_, i) => templateParams[String(i + 1)] || "");
    sendTemplateMutation.mutate({
      conversationId: selectedConvoId,
      templateName: selectedTemplate.name,
      language: selectedTemplate.language,
      parameters: paramValues.filter((v) => v),
    });
  };

  const handleFileSelect = (type: "image" | "audio" | "document") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedConvoId) return;
    sendMediaMutation.mutate({ conversationId: selectedConvoId, type, file });
    e.target.value = "";
    setShowMediaMenu(false);
  };

  const showConvoList = !isMobile || !selectedConvoId;
  const showThread = !isMobile || !!selectedConvoId;

  return (
    <div className="flex-1">
      <header className="bg-white shadow-sm border-b border-gray-200 px-3 sm:px-6 py-3 sm:py-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg sm:text-2xl font-bold text-gray-900">Conversas</h2>
            <p className="text-xs sm:text-sm text-gray-600 hidden sm:block">Chat WhatsApp Web</p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            <select
              className="border rounded px-2 sm:px-3 py-2 text-xs sm:text-sm max-w-[140px] sm:max-w-none min-h-[44px]"
              value={campaignFilter}
              onChange={(e) => { setCampaignFilter(e.target.value); setSelectedConvoId(null); }}
            >
              <option value="all">Todas</option>
              {campaignsList.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {wabasList.length > 1 && (
              <select
                className="border rounded px-2 sm:px-3 py-2 text-xs sm:text-sm max-w-[120px] sm:max-w-none min-h-[44px]"
                value={activeWabaId || ""}
                onChange={(e) => { setActiveWabaId(e.target.value); setSelectedConvoId(null); }}
              >
                {wabasList.map((w: any) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </header>

      <div className="flex h-[calc(100vh-8rem)]">
        <div className={`${isMobile ? 'w-full' : 'w-[360px]'} border-r bg-white flex flex-col ${showConvoList ? '' : 'hidden'}`}>
          <div className="p-3 border-b">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Buscar conversa..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {filteredConversations.length === 0 ? (
              <div className="p-6 text-center text-gray-500">
                <MessageSquare className="mx-auto mb-2" size={32} />
                <p className="text-sm">Nenhuma conversa encontrada</p>
              </div>
            ) : (
              filteredConversations.map((convo) => (
                <div
                  key={convo.id}
                  className={`flex items-center gap-3 p-3 border-b cursor-pointer hover:bg-gray-50 transition-colors ${selectedConvoId === convo.id ? "bg-blue-50 border-l-2 border-l-blue-500" : ""}`}
                  onClick={() => setSelectedConvoId(convo.id)}
                >
                  <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                    <User size={18} className="text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-gray-900 truncate">
                        {convo.contactName || convo.contactPhone}
                      </span>
                      <span className="text-xs text-gray-400 flex-shrink-0">
                        {getRelativeTime(convo.lastMessageAt)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-gray-500 truncate">
                        {convo.lastMessagePreview || "Sem mensagens"}
                      </p>
                      {(convo.unreadCount ?? 0) > 0 && (
                        <Badge className="bg-green-500 text-white text-xs ml-2 flex-shrink-0">
                          {convo.unreadCount}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className={`flex-1 flex flex-col bg-[#ECE5DD] ${showThread ? '' : 'hidden'}`}>
          {!selectedConvoId ? (
            <div className="flex-1 flex items-center justify-center text-gray-500">
              <div className="text-center">
                <MessageSquare size={64} className="mx-auto mb-4 text-gray-300" />
                <h3 className="text-lg font-medium mb-1">Selecione uma conversa</h3>
                <p className="text-sm">Escolha uma conversa na lista para ver as mensagens</p>
              </div>
            </div>
          ) : (
            <>
              <div className="bg-[#075E54] text-white px-3 sm:px-4 py-3 flex items-center gap-3">
                {isMobile && (
                  <button
                    onClick={() => setSelectedConvoId(null)}
                    className="p-1 min-w-[44px] min-h-[44px] flex items-center justify-center"
                  >
                    <ArrowLeft size={20} />
                  </button>
                )}
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                  <User size={16} />
                </div>
                <div className="flex-1">
                  <p className="font-medium text-sm">
                    {selectedConvo?.contactName || selectedConvo?.contactPhone}
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-white/70">{selectedConvo?.contactPhone}</p>
                    {isCswActive && (
                      <Badge className="bg-green-400/20 text-green-200 text-[10px]">
                        <Clock size={10} className="mr-1" /> CSW Ativa
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {messagesList.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} />
                ))}
                <div ref={messagesEndRef} />
              </div>

              <div className="bg-[#F0F0F0] px-3 sm:px-4 py-3 border-t safe-area-bottom">
                {isCswActive ? (
                  <div className="flex gap-2 items-center">
                    <div className="relative">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-gray-500 hover:text-gray-700"
                        onClick={() => setShowMediaMenu(!showMediaMenu)}
                      >
                        <Paperclip size={18} />
                      </Button>
                      {showMediaMenu && (
                        <div className="absolute bottom-full left-0 mb-2 bg-white rounded-lg shadow-lg border p-2 space-y-1 min-w-[160px] z-10">
                          <button
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-100 rounded"
                            onClick={() => imageInputRef.current?.click()}
                          >
                            <Image size={16} className="text-blue-500" /> Imagem
                          </button>
                          <button
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-100 rounded"
                            onClick={() => audioInputRef.current?.click()}
                          >
                            <Mic size={16} className="text-green-500" /> Audio
                          </button>
                          <button
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-100 rounded"
                            onClick={() => docInputRef.current?.click()}
                          >
                            <File size={16} className="text-orange-500" /> Documento
                          </button>
                        </div>
                      )}
                    </div>
                    <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect("image")} />
                    <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileSelect("audio")} />
                    <input ref={docInputRef} type="file" accept="*/*" className="hidden" onChange={handleFileSelect("document")} />
                    <Input
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Digite uma mensagem..."
                      className="flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSendReply();
                        }
                      }}
                    />
                    <Button
                      onClick={handleSendReply}
                      disabled={replyMutation.isPending || !replyText.trim()}
                      className="bg-[#075E54] hover:bg-[#064E47]"
                    >
                      <Send size={16} />
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-2">
                    <p className="text-sm text-gray-500 mb-2">
                      Janela de atendimento expirada. Envie um template para reabrir.
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setShowTemplateModal(true)}>
                      <FileText size={14} className="mr-1" /> Enviar Template
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h3 className="text-lg font-semibold">Enviar Template</h3>
              <button onClick={() => { setShowTemplateModal(false); setSelectedTemplate(null); setTemplateParams({}); }}>
                <X size={20} className="text-gray-400 hover:text-gray-600" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {!selectedTemplate ? (
                <div className="space-y-2">
                  <Label>Selecione um template aprovado</Label>
                  {approvedTemplates.length === 0 ? (
                    <p className="text-sm text-gray-500">Nenhum template aprovado disponível. Sincronize seus templates primeiro.</p>
                  ) : (
                    approvedTemplates.map((t) => (
                      <div
                        key={t.id}
                        className="border rounded-lg p-3 cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition-colors"
                        onClick={() => setSelectedTemplate(t)}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-sm">{t.name}</span>
                          <Badge className="bg-green-100 text-green-700 text-xs">{t.language}</Badge>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">{t.category}</p>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-medium">{selectedTemplate.name}</h4>
                      <p className="text-xs text-gray-500">{selectedTemplate.language} - {selectedTemplate.category}</p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => { setSelectedTemplate(null); setTemplateParams({}); }}>
                      Trocar
                    </Button>
                  </div>

                  {selectedTemplate.components && Array.isArray(selectedTemplate.components) && (
                    <div className="bg-gray-50 rounded-lg p-3">
                      <p className="text-xs font-medium text-gray-500 mb-1">Preview</p>
                      <p className="text-sm text-gray-800 whitespace-pre-wrap">
                        {(() => {
                          const body = selectedTemplate.components.find((c: any) => c.type === "BODY");
                          if (!body?.text) return "Sem conteúdo";
                          let preview = body.text;
                          const params = preview.match(/\{\{(\d+)\}\}/g) || [];
                          params.forEach((p: string) => {
                            const num = p.replace(/[{}]/g, "");
                            preview = preview.replace(p, templateParams[num] || p);
                          });
                          return preview;
                        })()}
                      </p>
                    </div>
                  )}

                  {(() => {
                    const params = extractTemplateParams(selectedTemplate.components);
                    if (params.length === 0) return null;
                    return (
                      <div className="space-y-3">
                        <Label>Parâmetros do template</Label>
                        {params.map((p, i) => (
                          <div key={i}>
                            <Label className="text-xs text-gray-500">Parâmetro {p}</Label>
                            <Input
                              value={templateParams[String(i + 1)] || ""}
                              onChange={(e) => setTemplateParams({ ...templateParams, [String(i + 1)]: e.target.value })}
                              placeholder={`Valor para ${p}`}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  <Button
                    className="w-full"
                    onClick={handleSendTemplate}
                    disabled={sendTemplateMutation.isPending}
                  >
                    {sendTemplateMutation.isPending ? "Enviando..." : "Enviar Template"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
