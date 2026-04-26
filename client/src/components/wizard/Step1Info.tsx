import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { FileText, Info, AlertCircle, Megaphone, Bot } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface Step1InfoProps {
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  isTestMode: boolean;
  setIsTestMode: (v: boolean) => void;
  campaignMode: string;
  setCampaignMode: (v: string) => void;
  validationErrors: string[];
}

export default function Step1Info({
  name, setName, description, setDescription, isTestMode, setIsTestMode,
  campaignMode, setCampaignMode, validationErrors,
}: Step1InfoProps) {
  const nameError = validationErrors.find(e => e.includes("Nome"));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <FileText className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Informações Gerais</h2>
          <p className="text-sm text-muted-foreground">Defina o nome, a descrição e o modo de operação da campanha</p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Nome da Campanha *</Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
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
          className={nameError ? "border-red-400 focus:border-red-500" : ""}
        />
        {nameError && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {nameError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">Escolha um nome descritivo para facilitar a identificação da campanha.</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Descrição</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ex: Campanha de Black Friday com 30% de desconto para clientes ativos..."
          rows={4}
        />
        <p className="text-xs text-muted-foreground">Descreva o objetivo e o público-alvo desta campanha (opcional).</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Tipo de Campanha</Label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            data-testid="mode-broadcast"
            onClick={() => setCampaignMode('broadcast')}
            className={`flex items-start gap-3 p-4 border-2 rounded-xl text-left transition-colors ${
              campaignMode === 'broadcast' || !campaignMode
                ? 'border-[#0066FF] bg-[#0066FF]/5'
                : 'border-border bg-background hover:border-muted-foreground/30'
            }`}
          >
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Megaphone className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-medium">Disparo em Massa</p>
              <p className="text-xs text-muted-foreground">Envia templates HSM para uma lista de contatos</p>
            </div>
          </button>
          <button
            type="button"
            data-testid="mode-bot-auto-reply"
            onClick={() => setCampaignMode('bot_auto_reply')}
            className={`flex items-start gap-3 p-4 border-2 rounded-xl text-left transition-colors ${
              campaignMode === 'bot_auto_reply'
                ? 'border-[#0066FF] bg-[#0066FF]/5'
                : 'border-border bg-background hover:border-muted-foreground/30'
            }`}
          >
            <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-green-600" />
            </div>
            <div>
              <p className="text-sm font-medium">Bot Click-to-WhatsApp</p>
              <p className="text-xs text-muted-foreground">Responde automaticamente leads de anúncios com 2 mensagens em sequência</p>
            </div>
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between p-4 border rounded-xl bg-muted/20 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-yellow-100 flex items-center justify-center">
            <Info className="w-4 h-4 text-yellow-600" />
          </div>
          <div>
            <Label className="text-sm font-medium">Modo de Teste</Label>
            <p className="text-xs text-muted-foreground">Ative para simular o envio sem enviar mensagens reais pelo WhatsApp</p>
          </div>
        </div>
        <Switch checked={isTestMode} onCheckedChange={setIsTestMode} />
      </div>
    </div>
  );
}
