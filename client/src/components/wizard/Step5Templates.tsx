import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MessageSquare, Eye, RotateCcw, Shuffle, AlertCircle, Link, Smartphone, Building2, Phone } from "lucide-react";
import { LEAD_VARIABLES, detectTemplateParams } from "./types";

interface Step5TemplatesProps {
  templates: any[];
  selectedTemplates: string[];
  setSelectedTemplates: (v: string[]) => void;
  templateParams: Record<string, Record<string, string>>;
  setTemplateParams: (v: Record<string, Record<string, string>> | ((prev: Record<string, Record<string, string>>) => Record<string, Record<string, string>>)) => void;
  templatePreviewId: string | null;
  setTemplatePreviewId: (v: string | null) => void;
  rotationMode: "sequential" | "distributed";
  setRotationMode: (v: "sequential" | "distributed") => void;
  conversionMessage: string;
  setConversionMessage: (v: string) => void;
  conversionLink: string;
  setConversionLink: (v: string) => void;
  conversionDelayMs: number;
  setConversionDelayMs: (v: number) => void;
  wabas: any[];
  selectedWabas?: any[];
  wabaNumberGroups?: Array<{ wabaId: string; wabaLabel: string; numbers: any[]; loading: boolean }>;
  validationErrors: string[];
}

function WhatsAppTemplatePreview({ tpl, params }: { tpl: any; params: Record<string, string> }) {
  const bodyComp = tpl.components?.find?.((c: any) => c.type === "BODY");
  const headerComp = tpl.components?.find?.((c: any) => c.type === "HEADER");
  const footerComp = tpl.components?.find?.((c: any) => c.type === "FOOTER");

  const replaceVars = (text: string, section: string) => {
    return text.replace(/\{\{(\d+)\}\}/g, (_: string, idx: string) => {
      const key = `${section.toLowerCase()}_${idx}`;
      const val = params[key] || `{{${idx}}}`;
      return val
        .replace(/\{nome\}/gi, "Maria Silva")
        .replace(/\{cpf\}/gi, "123.456.789-00");
    });
  };

  const bodyText = bodyComp ? replaceVars(bodyComp.text || "", "BODY") : "";
  const headerText = headerComp?.type === "HEADER" && headerComp.format === "TEXT"
    ? replaceVars(headerComp.text || "", "HEADER")
    : "";
  const footerText = footerComp?.text || "";

  return (
    <div className="border rounded-xl overflow-hidden shadow-sm bg-[#E5DDD5]">
      <div className="bg-[#075E54] text-white px-4 py-2.5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
          <Smartphone className="w-4 h-4" />
        </div>
        <div>
          <p className="text-sm font-medium">Empresa</p>
          <p className="text-[10px] text-white/70">online</p>
        </div>
      </div>
      <div className="p-3 min-h-[120px]">
        <div className="flex justify-start">
          <div className="bg-white rounded-lg rounded-tl-none px-3 py-2 shadow-sm max-w-[85%]">
            {headerText && (
              <p className="text-sm font-bold text-gray-900 mb-1">{headerText}</p>
            )}
            {bodyText && (
              <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">{bodyText}</p>
            )}
            {footerText && (
              <p className="text-[10px] text-gray-400 mt-1 italic">{footerText}</p>
            )}
            <div className="flex items-center justify-end mt-1">
              <span className="text-[10px] text-gray-500">
                {new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Step5Templates({
  templates, selectedTemplates, setSelectedTemplates,
  templateParams, setTemplateParams, templatePreviewId, setTemplatePreviewId,
  rotationMode, setRotationMode,
  conversionMessage, setConversionMessage, conversionLink, setConversionLink,
  conversionDelayMs, setConversionDelayMs, wabas, selectedWabas = [], wabaNumberGroups = [], validationErrors,
}: Step5TemplatesProps) {
  const grouped: Record<string, any[]> = {};
  for (const tpl of templates) {
    const wId = (tpl as any).wabaId || "geral";
    if (!grouped[wId]) grouped[wId] = [];
    grouped[wId].push(tpl);
  }
  const groups = Object.entries(grouped);

  const getWabaInfo = (wId: string) => {
    const sw = selectedWabas.find((w: any) => w.wabaId === wId);
    const registered = wabas.find((w: any) => w.wabaId === wId || w.id === wId);
    const numberGroup = wabaNumberGroups.find((g) => g.wabaId === wId);
    const name = registered?.name || sw?.label || (wId === "geral" ? "Todos" : wId);
    const phones: string[] = (numberGroup?.numbers || []).map((n: any) => n.displayNumber || n.display_phone_number).filter(Boolean);
    return { name, phones };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Templates de Mensagem</h2>
          <p className="text-sm text-muted-foreground">Selecione um ou mais templates aprovados para envio e configure parâmetros</p>
        </div>
      </div>

      {validationErrors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          {validationErrors.map((err, i) => (
            <p key={i} className="text-xs text-red-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {err}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-5">
        {groups.map(([wId, tpls]) => {
          const { name: wabaName, phones } = getWabaInfo(wId);
          return (
            <div key={wId} className="space-y-2">
              <div className="flex items-center gap-2 px-1 py-2 border-b border-gray-200">
                <div className="w-6 h-6 rounded-md bg-[#0066FF]/10 flex items-center justify-center shrink-0">
                  <Building2 className="w-3.5 h-3.5 text-[#0066FF]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 truncate">{wabaName}</p>
                  {phones.length > 0 && (
                    <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                      {phones.map((ph) => (
                        <span key={ph} className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
                          <Phone className="w-2.5 h-2.5" />{ph}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {tpls.length} template{tpls.length !== 1 ? "s" : ""}
                </Badge>
              </div>
              <div className="space-y-3">
                {tpls.map((tpl: any) => {
                  const matchedSelId = selectedTemplates.find((selId: string) => selId === tpl.id || selId === tpl.templateId || selId === tpl.name);
                  const isSelected = !!matchedSelId;
                  const params = detectTemplateParams(tpl.components || []);
                  const { name: tplWabaName, phones: tplPhones } = getWabaInfo(tpl.wabaId || wId);
                  return (
                    <div key={tpl.id} className={`rounded-xl border shadow-sm overflow-hidden transition-all ${isSelected ? "border-primary ring-1 ring-primary/20" : ""}`}>
                      <div
                        className={`p-4 cursor-pointer transition-colors ${
                          isSelected ? "bg-primary/5" : "hover:bg-muted/30"
                        }`}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedTemplates(selectedTemplates.filter((id) => id !== matchedSelId));
                          } else {
                            setSelectedTemplates([...selectedTemplates, tpl.id]);
                          }
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm">{tpl.name}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{tpl.language} - {tpl.category} {params.length > 0 && `- ${params.length} parâmetro(s)`}</p>
                            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 border border-blue-100 text-[10px] text-blue-700 font-medium">
                                <Building2 className="w-2.5 h-2.5" />
                                {tplWabaName}
                              </span>
                              {tplPhones.length > 0 && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-50 border border-gray-200 text-[10px] text-gray-600">
                                  <Phone className="w-2.5 h-2.5" />
                                  {tplPhones[0]}
                                  {tplPhones.length > 1 && ` +${tplPhones.length - 1}`}
                                </span>
                              )}
                            </div>
                            {tpl.components && isSelected && (
                              <div className="mt-3 p-2 bg-muted/50 rounded text-xs text-muted-foreground whitespace-pre-wrap">
                                {tpl.components?.find?.((c: any) => c.type === "BODY")?.text || "Sem corpo de texto"}
                              </div>
                            )}
                          </div>
                          <Badge variant={tpl.status === "APPROVED" ? "default" : "outline"} className="ml-3 shrink-0">
                            {tpl.status}
                          </Badge>
                        </div>
                      </div>

                      {isSelected && params.length > 0 && (
                        <div className="border-t border-primary/20 bg-primary/[0.03] p-4 border-l-4 border-l-primary space-y-3">
                          <p className="text-sm font-semibold text-primary flex items-center gap-1.5">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary" />
                            Parâmetros do template
                          </p>
                          {params.map((p) => (
                            <div key={p.key} className="space-y-1.5">
                              <Label className="text-xs font-medium text-muted-foreground">
                                {p.section} {`{{${p.index}}}`}
                              </Label>
                              <div className="flex flex-col gap-2">
                                <Textarea
                                  value={templateParams[tpl.id]?.[p.key] || ""}
                                  onChange={(e) => {
                                    setTemplateParams((prev: Record<string, Record<string, string>>) => ({
                                      ...prev,
                                      [tpl.id]: { ...(prev[tpl.id] || {}), [p.key]: e.target.value },
                                    }));
                                  }}
                                  placeholder={`Valor para ${p.section} {{${p.index}}} — ex: {nome}, Olá, R$ 99,90...`}
                                  className="text-base w-full min-h-[96px] resize-y"
                                  rows={4}
                                />
                                <div className="flex gap-1 flex-wrap">
                                  {LEAD_VARIABLES.map((v) => (
                                    <button
                                      key={v.value}
                                      type="button"
                                      onClick={() => {
                                        setTemplateParams((prev: Record<string, Record<string, string>>) => ({
                                          ...prev,
                                          [tpl.id]: {
                                            ...(prev[tpl.id] || {}),
                                            [p.key]: (prev[tpl.id]?.[p.key] || "") + v.value,
                                          },
                                        }));
                                      }}
                                      className="px-2 py-1 text-[10px] bg-muted rounded-md border hover:bg-muted/80 transition-colors"
                                    >
                                      {v.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          ))}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setTemplatePreviewId(templatePreviewId === tpl.id ? null : tpl.id)}
                          >
                            <Eye className="w-3 h-3 mr-1" />
                            {templatePreviewId === tpl.id ? "Fechar Preview" : "Preview ao Vivo"}
                          </Button>
                          {templatePreviewId === tpl.id && (
                            <div className="max-w-sm mx-auto">
                              <p className="text-xs font-medium text-muted-foreground mb-2 text-center">
                                Simulação de como a mensagem aparecerá no WhatsApp
                              </p>
                              <WhatsAppTemplatePreview tpl={tpl} params={templateParams[tpl.id] || {}} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <div className="flex items-center justify-between mt-3">
          <p className="text-xs text-muted-foreground">
            {selectedTemplates.length} template(s) selecionado(s)
          </p>
          {selectedTemplates.length > 1 && (
            <div className="flex items-center gap-2">
              <Label className="text-xs">Rotação:</Label>
              <Select value={rotationMode} onValueChange={(v: "sequential" | "distributed") => setRotationMode(v)}>
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sequential">
                    <span className="flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Sequencial</span>
                  </SelectItem>
                  <SelectItem value="distributed">
                    <span className="flex items-center gap-1"><Shuffle className="w-3 h-3" /> Distribuído</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Link className="w-4 h-4 text-primary" />
          <h3 className="font-semibold text-sm">Mensagem de Conversão (opcional)</h3>
        </div>
        <p className="text-xs text-muted-foreground">Mensagem de follow-up enviada automaticamente após o template principal</p>
        <div>
          <Label className="text-xs">Mensagem</Label>
          <Textarea
            value={conversionMessage}
            onChange={(e) => setConversionMessage(e.target.value)}
            placeholder="Ex: Aproveite! Acesse o link abaixo para garantir seu desconto..."
            rows={3}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Link de Conversão</Label>
            <Input
              value={conversionLink}
              onChange={(e) => setConversionLink(e.target.value)}
              placeholder="https://exemplo.com/oferta"
            />
          </div>
          <div>
            <Label className="text-xs">Atraso (ms)</Label>
            <Input
              type="number"
              value={conversionDelayMs}
              onChange={(e) => setConversionDelayMs(Number(e.target.value))}
              min={0}
              placeholder="5000"
            />
            <p className="text-[11px] text-muted-foreground mt-0.5">Tempo de espera antes de enviar a mensagem de conversão</p>
          </div>
        </div>
      </div>
    </div>
  );
}
