import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  FileText, Shield, Phone, Users, MessageSquare, Image, Bot, Activity, Save, Play, Loader2,
  CheckCircle, AlertCircle, Smartphone, Building2, Info, Globe, XCircle,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SelectedWaba } from "./Step2WabaSelection";

interface Step9ReviewProps {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  isTestMode: boolean;
  setIsTestMode: (v: boolean) => void;
  selectedWabas: SelectedWaba[];
  selectedNumbers: any[];
  leadListId: string;
  selectedLeadList: any;
  contactInputMode: "list" | "paste" | "file";
  directLeads: any[];
  selectedTemplates: string[];
  selectedTemplateNames: string[];
  templates: any[];
  conversionMessage: string;
  usePackageImage: boolean;
  customImageTemplateId: string;
  selectedImageTemplate: any;
  automationEnabled: boolean;
  botRules: any[];
  sendSpeed: string;
  burstMode: boolean;
  businessHoursOnly: boolean;
  businessHoursStart: number;
  businessHoursEnd: number;
  scheduledAt: string;
  campaignAudioEnabled: boolean;
  campaignAudioUrl: string;
  setCurrentStep: (step: number) => void;
  handleFinish: () => void;
  handleStartCampaign: () => void;
  startMutationPending: boolean;
  canStart: boolean;
  verifyToken?: string;
  appSecret?: string;
  webhookTestResult?: { success: boolean; message?: string; error?: string } | null;
}

function ReviewCard({
  icon: Icon, title, children, step, setCurrentStep, isComplete,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  step: number;
  setCurrentStep: (s: number) => void;
  isComplete: boolean;
}) {
  return (
    <Card className={`bg-muted/20 border hover:shadow-md transition-all cursor-pointer group ${isComplete ? "border-green-200" : "border-yellow-200"}`} onClick={() => setCurrentStep(step)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="w-4 h-4" />
          <span className="flex-1">{title}</span>
          {isComplete ? (
            <CheckCircle className="w-4 h-4 text-green-500" />
          ) : (
            <AlertCircle className="w-4 h-4 text-yellow-500" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        {children}
        <p className="text-xs text-[#0066FF] opacity-0 group-hover:opacity-100 transition-opacity mt-2">Clique para editar</p>
      </CardContent>
    </Card>
  );
}

function MiniTemplatePreview({ tpl }: { tpl: any }) {
  const bodyComp = tpl.components?.find?.((c: any) => c.type === "BODY");
  const bodyText = bodyComp?.text || "";
  const truncated = bodyText.length > 120 ? bodyText.slice(0, 120) + "…" : bodyText;
  return (
    <div className="bg-[#E5DDD5] rounded-lg p-2 mt-1">
      <div className="flex items-center gap-1.5 mb-1">
        <Smartphone className="w-3 h-3 text-[#075E54]" />
        <span className="text-[10px] font-medium text-[#075E54]">{tpl.name}</span>
      </div>
      <div className="bg-white rounded px-2 py-1.5 text-[11px] text-gray-800 leading-tight whitespace-pre-wrap break-words">
        {truncated || <span className="text-muted-foreground italic">Sem corpo de texto</span>}
      </div>
    </div>
  );
}

interface PrerequisiteItem {
  label: string;
  ok: boolean;
  errorMsg: string;
  goToStep: number;
  goToLabel: string;
}

export default function Step9Review(props: Step9ReviewProps) {
  const {
    name, setName, description, setDescription, isTestMode, setIsTestMode,
    selectedWabas,
    selectedNumbers, leadListId, selectedLeadList,
    contactInputMode, directLeads,
    selectedTemplates, selectedTemplateNames, templates,
    conversionMessage, usePackageImage, customImageTemplateId, selectedImageTemplate,
    automationEnabled, botRules,
    sendSpeed, burstMode, businessHoursOnly,
    businessHoursStart, businessHoursEnd, scheduledAt,
    campaignAudioEnabled, campaignAudioUrl,
    setCurrentStep, handleFinish, handleStartCampaign,
    startMutationPending, canStart,
    verifyToken, appSecret, webhookTestResult,
  } = props;

  const webhookConfigured = !!verifyToken && !!appSecret;
  const webhookTested = webhookTestResult?.success === true;

  const hasContacts = contactInputMode === "list" ? !!leadListId : directLeads.length > 0;
  const imageComplete = !usePackageImage || !!customImageTemplateId;
  const botComplete = !automationEnabled || botRules.some(r => r.keyword && r.response);

  const resolveTemplate = (selId: string) =>
    templates.find((t: any) => t.id === selId || t.templateId === selId || t.name === selId);
  const previewTemplates = selectedTemplates
    .map(resolveTemplate)
    .filter(Boolean)
    .slice(0, 2);

  const nameError = !name.trim();

  const hasApprovedTemplates = selectedTemplates.length > 0 && selectedTemplates.some((selId) => {
    const tpl = resolveTemplate(selId);
    if (!tpl) return true;
    return !tpl.status || tpl.status === "APPROVED" || tpl.status === "approved";
  });

  const templatePrerequisiteOk = selectedTemplates.length > 0 && hasApprovedTemplates;
  const templatePrerequisiteErrorMsg = selectedTemplates.length === 0
    ? "Selecione pelo menos um template na etapa Templates."
    : "Nenhum template selecionado está aprovado pela Meta. Sincronize os templates e aguarde aprovação antes de disparar.";

  const prerequisites: PrerequisiteItem[] = [
    {
      label: "Nome da campanha definido",
      ok: !!name.trim(),
      errorMsg: "Defina um nome para a campanha na seção acima.",
      goToStep: 8,
      goToLabel: "Preencher nome",
    },
    {
      label: "Pelo menos uma WABA selecionada",
      ok: selectedWabas.length > 0,
      errorMsg: "Selecione uma WABA com token válido. Vá para a etapa Integrações e descubra suas WABAs.",
      goToStep: 1,
      goToLabel: "Etapa Integrações",
    },
    {
      label: "Pelo menos um número de disparo selecionado",
      ok: selectedNumbers.length > 0,
      errorMsg: "Selecione pelo menos um número de telefone para disparar a campanha.",
      goToStep: 3,
      goToLabel: "Etapa Números",
    },
    {
      label: "Lista de contatos importada",
      ok: hasContacts,
      errorMsg: "Importe uma lista de leads ou cole os contatos diretamente na etapa Contatos.",
      goToStep: 4,
      goToLabel: "Etapa Contatos",
    },
    {
      label: "Template aprovado selecionado",
      ok: templatePrerequisiteOk,
      errorMsg: templatePrerequisiteErrorMsg,
      goToStep: 5,
      goToLabel: "Etapa Templates",
    },
  ];

  const failedPrerequisites = prerequisites.filter((p) => !p.ok);
  const allPrerequisitesMet = failedPrerequisites.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center">
          <CheckCircle className="w-5 h-5 text-green-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Revisão da Campanha</h2>
          <p className="text-sm text-muted-foreground">Revise todas as configurações antes de iniciar. Clique em qualquer seção para editar.</p>
        </div>
      </div>

      <div className="border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
            <FileText className="w-4 h-4 text-[#0066FF]" />
          </div>
          <div>
            <h3 className="font-semibold text-base">Informações da Campanha</h3>
            <p className="text-xs text-muted-foreground">Nome, descrição e modo de operação</p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <div className="flex items-center gap-2">
              <Label className="text-xs font-medium">Nome da Campanha *</Label>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-3 h-3 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs max-w-xs">Nome usado para identificar a campanha nos relatórios e listagens.</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Black Friday 2024 - Oferta Premium"
              className={nameError ? "border-red-400 focus:border-red-500 mt-1" : "mt-1"}
            />
            {nameError && (
              <p className="text-xs text-red-500 flex items-center gap-1 mt-1">
                <AlertCircle className="w-3 h-3" /> Nome da campanha é obrigatório
              </p>
            )}
          </div>

          <div>
            <Label className="text-xs font-medium">Descrição</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex: Campanha de Black Friday com 30% de desconto..."
              rows={2}
              className="mt-1"
            />
          </div>

          <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/20">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-yellow-600" />
              <div>
                <Label className="text-xs font-medium">Modo de Teste</Label>
                <p className="text-[11px] text-muted-foreground">Simular envio sem enviar mensagens reais</p>
              </div>
            </div>
            <Switch checked={isTestMode} onCheckedChange={setIsTestMode} />
          </div>
        </div>
      </div>

      {failedPrerequisites.length > 0 && (
        <div className="border border-red-300 rounded-xl p-4 bg-red-50 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-100 flex items-center justify-center flex-shrink-0">
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-sm text-red-800 mb-1">
                {failedPrerequisites.length === 1
                  ? "Pré-requisito faltando para iniciar a campanha"
                  : `${failedPrerequisites.length} pré-requisitos faltando para iniciar`}
              </h3>
              <p className="text-xs text-red-700">
                Resolva os itens abaixo antes de lançar a campanha.
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {failedPrerequisites.map((p, i) => (
              <div key={i} className="flex items-start justify-between gap-3 bg-white border border-red-200 rounded-lg px-3 py-2.5">
                <div className="flex items-start gap-2 min-w-0">
                  <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-red-800">{p.label}</p>
                    <p className="text-[11px] text-red-600">{p.errorMsg}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-red-300 text-red-700 hover:bg-red-50 flex-shrink-0"
                  onClick={() => setCurrentStep(p.goToStep)}
                >
                  {p.goToLabel}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {allPrerequisitesMet && (!webhookConfigured || !webhookTested) && (
        <div className="border border-amber-300 rounded-xl p-4 bg-amber-50 flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-amber-800 mb-1">Webhook não configurado — bot pode não funcionar</h3>
            <p className="text-xs text-amber-700 mb-2">
              {!webhookConfigured
                ? "O Verify Token e/ou App Secret não estão configurados. O bot não poderá responder às mensagens dos leads automaticamente."
                : "O webhook ainda não foi testado com sucesso. Configure e teste o webhook na Meta para garantir que o bot funcione."}
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-amber-700">
                <Globe className="w-3.5 h-3.5" />
                <span>{verifyToken ? "Verify Token: configurado" : "Verify Token: ausente"}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-amber-700">
                <Shield className="w-3.5 h-3.5" />
                <span>{appSecret ? "App Secret: configurado" : "App Secret: ausente"}</span>
              </div>
            </div>
            <p className="text-[11px] text-amber-600 mt-2">
              A campanha pode ser iniciada mesmo sem webhook, mas o bot automático não vai funcionar.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-amber-700 border-amber-300 hover:bg-amber-100 text-xs h-8"
              onClick={() => setCurrentStep(1)}
            >
              Ir para etapa de Integração
            </Button>
          </div>
        </div>
      )}

      {allPrerequisitesMet && webhookConfigured && webhookTested && (
        <div className="border border-green-200 rounded-xl p-4 bg-green-50 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-green-800">Tudo pronto para iniciar</p>
            <p className="text-xs text-green-700">Pré-requisitos atendidos e webhook testado com sucesso.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ReviewCard icon={Shield} title="Integrações" step={1} setCurrentStep={setCurrentStep} isComplete={selectedWabas.length > 0}>
          <div><span className="text-muted-foreground">Credenciais:</span> {selectedWabas.length > 0 ? <Badge variant="outline" className="text-xs">Configuradas</Badge> : <span className="text-red-500">Não configuradas</span>}</div>
        </ReviewCard>

        <ReviewCard icon={Building2} title="WABAs" step={2} setCurrentStep={setCurrentStep} isComplete={selectedWabas.length > 0}>
          <div><span className="text-muted-foreground">WABAs selecionadas:</span> {selectedWabas.length > 0 ? (
            <Badge variant="outline" className="text-xs">{selectedWabas.length}</Badge>
          ) : <span className="text-red-500">Nenhuma</span>}</div>
          {selectedWabas.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              {selectedWabas.slice(0, 2).map((w) => w.label).join(", ")}
              {selectedWabas.length > 2 && ` +${selectedWabas.length - 2}`}
            </div>
          )}
        </ReviewCard>

        <ReviewCard icon={Phone} title="Números" step={3} setCurrentStep={setCurrentStep} isComplete={selectedNumbers.length > 0}>
          <div><span className="text-muted-foreground">Números selecionados:</span> {selectedNumbers.length > 0 ? (
            <Badge variant="outline" className="text-xs">{selectedNumbers.length}</Badge>
          ) : <span className="text-yellow-600">Nenhum</span>}</div>
          {selectedNumbers.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1">
              {selectedNumbers.slice(0, 3).map((n: any) => n.displayNumber || n.phoneNumberId).join(", ")}
              {selectedNumbers.length > 3 && ` +${selectedNumbers.length - 3}`}
            </div>
          )}
        </ReviewCard>

        <ReviewCard icon={Users} title="Contatos" step={4} setCurrentStep={setCurrentStep} isComplete={hasContacts}>
          {contactInputMode === "list" ? (
            <>
              <div><span className="text-muted-foreground">Lista:</span> {selectedLeadList?.name || <span className="text-red-500">Não selecionada</span>}</div>
              <div><span className="text-muted-foreground">Contatos:</span> {selectedLeadList?.validLeads || selectedLeadList?.totalLeads || 0}</div>
            </>
          ) : (
            <>
              <div><span className="text-muted-foreground">Modo:</span> {contactInputMode === "paste" ? "Números colados" : "Arquivo importado"}</div>
              <div><span className="text-muted-foreground">Contatos:</span> {directLeads.length}</div>
            </>
          )}
        </ReviewCard>

        <ReviewCard icon={MessageSquare} title="Templates" step={5} setCurrentStep={setCurrentStep} isComplete={selectedTemplates.length > 0}>
          <div><span className="text-muted-foreground">Templates:</span> {selectedTemplateNames.length > 0 ? (
            <span className="text-xs">{selectedTemplateNames.join(", ")}</span>
          ) : <span className="text-red-500">Nenhum selecionado</span>}</div>
          {conversionMessage && <div><span className="text-muted-foreground">Conversão:</span> <Badge variant="outline" className="text-xs">Configurada</Badge></div>}
          {previewTemplates.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {previewTemplates.map((tpl: any) => (
                <MiniTemplatePreview key={tpl.id} tpl={tpl} />
              ))}
              {selectedTemplates.length > 2 && (
                <p className="text-[10px] text-muted-foreground">+{selectedTemplates.length - 2} template(s) adicionais</p>
              )}
            </div>
          )}
        </ReviewCard>

        <ReviewCard icon={Bot} title="Automação" step={6} setCurrentStep={setCurrentStep} isComplete={botComplete}>
          <div><span className="text-muted-foreground">Bot:</span> {automationEnabled ? <Badge variant="outline" className="text-xs">Ativo</Badge> : "Inativo"}</div>
          {automationEnabled && (
            <>
              <div><span className="text-muted-foreground">Regras:</span> {botRules.length}</div>
              {botRules.length > 0 && !botRules.some(r => r.keyword && r.response) && (
                <div className="text-xs text-yellow-600 mt-1">Nenhuma regra com palavra-chave e resposta configuradas</div>
              )}
            </>
          )}
        </ReviewCard>

        <ReviewCard icon={Image} title="Mídia e Envio" step={7} setCurrentStep={setCurrentStep} isComplete={imageComplete}>
          <div><span className="text-muted-foreground">Imagem:</span> {usePackageImage ? <Badge variant="outline" className="text-xs">Sim</Badge> : "Não"}</div>
          {usePackageImage && selectedImageTemplate && (
            <div><span className="text-muted-foreground">Template:</span> {selectedImageTemplate.name}</div>
          )}
          {usePackageImage && !customImageTemplateId && (
            <div className="text-xs text-yellow-600 mt-1">Imagem base não selecionada</div>
          )}
          <div className="mt-2"><span className="text-muted-foreground">Velocidade:</span> {sendSpeed} msg/min</div>
          {burstMode && <div><span className="text-muted-foreground">Envio Simultâneo:</span> <Badge variant="outline" className="text-xs">Ativo</Badge></div>}
          {businessHoursOnly && <div><span className="text-muted-foreground">Horário:</span> {businessHoursStart} - {businessHoursEnd}</div>}
          {scheduledAt && <div><span className="text-muted-foreground">Agendado:</span> {new Date(scheduledAt).toLocaleString("pt-BR")}</div>}
          {campaignAudioEnabled && <div><span className="text-muted-foreground">Áudio:</span> <Badge variant="outline" className="text-xs">Ativo</Badge></div>}
        </ReviewCard>
      </div>

      <div className="flex gap-3 pt-4">
        <Button variant="outline" className="flex-1" onClick={handleFinish}>
          <Save className="w-4 h-4 mr-1" />
          Salvar e Sair
        </Button>
        <Button
          className="flex-1 bg-[#0066FF] hover:bg-[#0052CC]"
          onClick={handleStartCampaign}
          disabled={startMutationPending || !canStart || !allPrerequisitesMet}
          title={!allPrerequisitesMet ? "Resolva os pré-requisitos acima antes de iniciar" : undefined}
        >
          {startMutationPending ? (
            <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Iniciando...</>
          ) : (
            <><Play className="w-4 h-4 mr-1" /> Iniciar Campanha</>
          )}
        </Button>
      </div>
      {!allPrerequisitesMet && (
        <p className="text-xs text-red-500 text-center -mt-2">
          Resolva os pré-requisitos acima para habilitar o lançamento.
        </p>
      )}
    </div>
  );
}
