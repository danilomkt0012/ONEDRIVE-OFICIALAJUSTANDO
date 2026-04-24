import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bot, Info, Plus, Trash2, Settings, Type, ImageIcon, Music, Tag, Clock, MessageCircle } from "lucide-react";
import AudioRecorder from "@/components/AudioRecorder";
import AudioFileUpload from "@/components/AudioFileUpload";
import BotFlowEditor from "@/components/BotFlowEditor";

export interface FirstResponseButton {
  id: string;
  title: string;
  nextNodeId?: string;
}

interface Step7BotProps {
  automationEnabled: boolean;
  setAutomationEnabled: (v: boolean) => void;
  automationFallback: string;
  setAutomationFallback: (v: string) => void;
  botRules: Array<{ keyword: string; response: string; responseType: string; mediaUrl: string }>;
  setBotRules: (v: Array<{ keyword: string; response: string; responseType: string; mediaUrl: string }>) => void;
  campaignId: string | undefined;
  cswFallbackDefault?: string;
  setCswFallbackDefault?: (v: string) => void;
  firstResponseButtons?: FirstResponseButton[];
  setFirstResponseButtons?: (v: FirstResponseButton[]) => void;
  firstResponseBodyText?: string;
  setFirstResponseBodyText?: (v: string) => void;
  botFallbackMessage?: string;
  setBotFallbackMessage?: (v: string) => void;
}

interface BotFlowNode {
  id: string;
  label: string;
}

export default function Step7Bot({
  automationEnabled, setAutomationEnabled,
  automationFallback, setAutomationFallback,
  botRules, setBotRules, campaignId,
  cswFallbackDefault, setCswFallbackDefault,
  firstResponseButtons = [], setFirstResponseButtons,
  firstResponseBodyText = '', setFirstResponseBodyText,
  botFallbackMessage = '', setBotFallbackMessage,
}: Step7BotProps) {
  const [botFlowNodes, setBotFlowNodes] = useState<BotFlowNode[]>([]);

  useEffect(() => {
    if (!campaignId) return;
    fetch(`/api/campaigns/${campaignId}/bot-flow`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.nodes && Array.isArray(data.nodes)) {
          setBotFlowNodes(data.nodes.map((n: any, i: number) => ({
            id: n.id || `node_${i}`,
            label: n.label || `Etapa ${i + 1}`,
          })));
        }
      })
      .catch(() => {});
  }, [campaignId]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Bot className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Automação e Respostas</h2>
          <p className="text-sm text-muted-foreground">Configure o bot automático para responder mensagens recebidas dos contatos</p>
        </div>
      </div>

      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-blue-800">
            Após criar a campanha, você pode editar todas as configurações do bot a qualquer momento na aba <strong>Bot</strong> da página de detalhes da campanha — mesmo com a campanha em andamento.
          </p>
        </div>
      </div>

      {setFirstResponseButtons && (
        <div className="border rounded-xl p-4 space-y-3 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-green-100 flex items-center justify-center">
              <MessageCircle className="w-3.5 h-3.5 text-green-600" />
            </div>
            <div>
              <Label className="text-sm font-medium">Botões de resposta rápida</Label>
              <p className="text-xs text-muted-foreground">Enviados automaticamente quando o lead responde ao template inicial (máx. 3 botões)</p>
            </div>
          </div>

          {setFirstResponseBodyText && (
            <div>
              <Label className="text-xs text-muted-foreground">Texto da mensagem com botões</Label>
              <Input
                value={firstResponseBodyText}
                onChange={(e) => setFirstResponseBodyText(e.target.value)}
                placeholder="Selecione uma opção:"
                className="h-8 text-sm"
                maxLength={1024}
              />
            </div>
          )}

          {firstResponseButtons.map((btn, idx) => (
            <div key={idx} className="flex items-center gap-2 p-2 border rounded-lg bg-gray-50">
              <span className="text-xs font-medium text-muted-foreground w-5">#{idx + 1}</span>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Título do botão (máx. 20 chars)"
                    value={btn.title}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val.length <= 20) {
                        const updated = [...firstResponseButtons];
                        updated[idx] = { ...updated[idx], title: val };
                        setFirstResponseButtons(updated);
                      }
                    }}
                    className="flex-1 h-7 text-sm"
                    maxLength={20}
                  />
                  <span className={`text-[10px] ${btn.title.length > 20 ? "text-red-500 font-semibold" : "text-gray-400"}`}>
                    {btn.title.length}/20
                  </span>
                </div>
                {botFlowNodes.length > 0 && (
                  <Select
                    value={btn.nextNodeId || "none"}
                    onValueChange={(val) => {
                      const updated = [...firstResponseButtons];
                      updated[idx] = { ...updated[idx], nextNodeId: val === "none" ? undefined : val };
                      setFirstResponseButtons(updated);
                    }}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder="Nó destino (opcional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sem roteamento direto</SelectItem>
                      {botFlowNodes.map(node => (
                        <SelectItem key={node.id} value={node.id}>{node.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-red-500"
                onClick={() => setFirstResponseButtons(firstResponseButtons.filter((_, i) => i !== idx))}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}

          {firstResponseButtons.length < 3 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const newBtn: FirstResponseButton = { id: `btn_${Date.now()}_${firstResponseButtons.length}`, title: '' };
                setFirstResponseButtons([...firstResponseButtons, newBtn]);
              }}
            >
              <Plus className="w-3 h-3 mr-1" />
              Adicionar Botão
            </Button>
          )}

          {firstResponseButtons.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              Nenhum botão configurado. O lead receberá apenas a resposta do bot após responder ao template.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
            <Bot className="w-4 h-4 text-purple-600" />
          </div>
          <div>
            <Label className="text-sm font-medium">Bot Automático</Label>
            <p className="text-xs text-muted-foreground">Ative para responder automaticamente a mensagens recebidas. O bot pode enviar texto, imagem, áudio ou combinações.</p>
          </div>
        </div>
        <Switch checked={automationEnabled} onCheckedChange={setAutomationEnabled} />
      </div>

      {automationEnabled && (
        <>
          <div className="border rounded-xl p-4 space-y-3 shadow-sm">
            <Label className="text-sm font-medium">Fallback (quando não há regra)</Label>
            <p className="text-xs text-muted-foreground mb-1">Define o que acontece quando a mensagem do contato não corresponde a nenhuma palavra-chave configurada nas regras abaixo.</p>
            <Select value={automationFallback} onValueChange={setAutomationFallback}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="silence">Silêncio (não responder)</SelectItem>
                <SelectItem value="default">Mensagem padrão</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="border rounded-xl p-4 space-y-3 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-amber-500" />
              <Label className="text-sm font-medium">Comportamento fora da janela de 24h</Label>
            </div>
            <p className="text-xs text-muted-foreground mb-1">
              Quando a janela de atendimento (CSW) está fechada, botões e listas interativas não podem ser enviados. Escolha o comportamento padrão para todos os nós que não tenham configuração própria.
            </p>
            <Select value={cswFallbackDefault || "text_only"} onValueChange={(v) => setCswFallbackDefault?.(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text_only">Enviar só o texto (sem botões/lista)</SelectItem>
                <SelectItem value="skip">Pular o nó silenciosamente</SelectItem>
                <SelectItem value="end">Encerrar a conversa</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {setBotFallbackMessage && (
            <div className="border rounded-xl p-4 space-y-3 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <MessageCircle className="w-4 h-4 text-orange-500" />
                <Label className="text-sm font-medium">Mensagem de fallback de mídia</Label>
              </div>
              <p className="text-xs text-muted-foreground mb-1">
                Enviada ao contato quando o bot falhar ao entregar uma mídia (áudio, imagem). Se vazio, usa o texto padrão: "Desculpe, não entendi sua resposta. Por favor, tente novamente."
              </p>
              <Textarea
                placeholder="Desculpe, não entendi sua resposta. Por favor, tente novamente."
                value={botFallbackMessage}
                onChange={(e) => setBotFallbackMessage(e.target.value)}
                rows={3}
                className="text-sm"
                maxLength={500}
              />
              {botFallbackMessage.length > 0 && (
                <p className="text-[10px] text-muted-foreground text-right">{botFallbackMessage.length}/500</p>
              )}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Regras de Resposta</Label>
              <p className="text-xs text-muted-foreground">Cada regra associa uma <strong>palavra-chave</strong> a uma resposta automática. Quando o contato enviar uma mensagem contendo essa palavra, o bot envia a resposta configurada.</p>
            </div>
            {botRules.map((rule, idx) => (
              <div key={idx} className="border rounded-xl p-3 space-y-2 shadow-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground w-6">#{idx + 1}</span>
                  <Input
                    placeholder="Ex: preço, desconto, pix..."
                    value={rule.keyword}
                    onChange={(e) => {
                      const updated = [...botRules];
                      updated[idx] = { ...updated[idx], keyword: e.target.value };
                      setBotRules(updated);
                    }}
                    className="flex-1 h-8 text-sm"
                  />
                  <Select
                    value={rule.responseType || "text"}
                    onValueChange={(v) => {
                      const updated = [...botRules];
                      updated[idx] = { ...updated[idx], responseType: v };
                      setBotRules(updated);
                    }}
                  >
                    <SelectTrigger className="w-32 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text"><span className="flex items-center gap-1"><Type className="w-3 h-3" /> Texto</span></SelectItem>
                      <SelectItem value="image"><span className="flex items-center gap-1"><ImageIcon className="w-3 h-3" /> Imagem</span></SelectItem>
                      <SelectItem value="audio"><span className="flex items-center gap-1"><Music className="w-3 h-3" /> Áudio</span></SelectItem>
                      <SelectItem value="combined"><span className="flex items-center gap-1"><Tag className="w-3 h-3" /> Combinado</span></SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-red-500"
                    onClick={() => setBotRules(botRules.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>

                <div>
                  <Textarea
                    placeholder="Texto da resposta automática..."
                    value={rule.response}
                    onChange={(e) => {
                      const updated = [...botRules];
                      updated[idx] = { ...updated[idx], response: e.target.value };
                      setBotRules(updated);
                    }}
                    rows={2}
                    className="text-sm"
                  />
                </div>

                {(rule.responseType === "image" || rule.responseType === "audio" || rule.responseType === "combined") && (
                  <div>
                    <Label className="text-xs">
                      {rule.responseType === "image" ? "URL da Imagem" : rule.responseType === "audio" ? "URL do Áudio" : "URL da Mídia (imagem ou áudio)"}
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        placeholder="https://exemplo.com/mídia.jpg"
                        value={rule.mediaUrl || ""}
                        onChange={(e) => {
                          const updated = [...botRules];
                          updated[idx] = { ...updated[idx], mediaUrl: e.target.value };
                          setBotRules(updated);
                        }}
                        className="h-8 text-sm flex-1"
                      />
                      {(rule.responseType === "audio" || rule.responseType === "combined") && (
                        <>
                          <AudioFileUpload
                            onUploaded={(url) => {
                              const updated = [...botRules];
                              updated[idx] = { ...updated[idx], mediaUrl: url };
                              setBotRules(updated);
                            }}
                          />
                          <AudioRecorder
                            onRecorded={(url) => {
                              const updated = [...botRules];
                              updated[idx] = { ...updated[idx], mediaUrl: url };
                              setBotRules(updated);
                            }}
                          />
                        </>
                      )}
                    </div>
                  </div>
                )}

                {rule.responseType === "combined" && (
                  <p className="text-[10px] text-muted-foreground">
                    Combinado: envia o texto + a mídia na mesma regra. O texto será enviado como caption da mídia.
                  </p>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBotRules([...botRules, { keyword: "", response: "", responseType: "text", mediaUrl: "" }])}
            >
              <Plus className="w-3 h-3 mr-1" />
              Adicionar Regra
            </Button>
          </div>

          {campaignId && (
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-primary" />
                <div>
                  <h3 className="font-semibold text-sm">Fluxo de Conversa Avançado</h3>
                  <p className="text-xs text-muted-foreground">Configure um funil de conversa guiado com etapas, condições e timeouts</p>
                </div>
              </div>
              <BotFlowEditor campaignId={campaignId} />
            </div>
          )}
          {!campaignId && (
            <div className="bg-muted/30 border border-dashed rounded-xl p-3">
              <div className="flex items-start gap-2">
                <Info className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  Após criar a campanha, você poderá configurar um fluxo de conversa avançado
                  com etapas, condições e timeouts diretamente neste passo.
                  As regras acima já estarão ativas para respostas simples.
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
