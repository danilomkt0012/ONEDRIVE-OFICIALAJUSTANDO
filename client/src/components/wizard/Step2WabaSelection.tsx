import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Building2, Check, Plus, X, Info, AlertCircle, Phone, Wifi, WifiOff, HelpCircle, Users,
} from "lucide-react";
import type { DiscoveredWaba, SelectedWaba } from "./types";

export type { DiscoveredWaba, SelectedWaba };

interface Step2WabaSelectionProps {
  discoveredWabas: DiscoveredWaba[];
  selectedWabas: SelectedWaba[];
  setSelectedWabas: (v: SelectedWaba[]) => void;
  registeredWabas: any[];
  validationErrors: string[];
}

export default function Step2WabaSelection({
  discoveredWabas, selectedWabas, setSelectedWabas, registeredWabas, validationErrors,
}: Step2WabaSelectionProps) {
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualWabaId, setManualWabaId] = useState("");
  const [manualLabel, setManualLabel] = useState("");

  const isWabaSelected = (wabaId: string) =>
    selectedWabas.some((w) => w.wabaId === wabaId);

  const toggleWaba = (waba: DiscoveredWaba) => {
    if (isWabaSelected(waba.wabaId)) {
      setSelectedWabas(selectedWabas.filter((w) => w.wabaId !== waba.wabaId));
    } else {
      setSelectedWabas([...selectedWabas, {
        wabaId: waba.wabaId,
        label: waba.wabaName?.trim() || waba.wabaId,
        phoneCount: waba.phoneCount,
        source: "discovered",
      }]);
    }
  };

  const toggleRegisteredWaba = (waba: any) => {
    if (isWabaSelected(waba.wabaId || waba.id)) {
      setSelectedWabas(selectedWabas.filter((w) => w.wabaId !== (waba.wabaId || waba.id)));
    } else {
      setSelectedWabas([...selectedWabas, {
        wabaId: waba.wabaId || waba.id,
        label: waba.name?.trim() || waba.wabaId || waba.id,
        phoneCount: 0,
        source: "discovered",
      }]);
    }
  };

  const addManualWaba = () => {
    if (!manualWabaId.trim()) return;
    if (isWabaSelected(manualWabaId.trim())) return;
    setSelectedWabas([...selectedWabas, {
      wabaId: manualWabaId.trim(),
      label: manualLabel.trim() || `WABA ${manualWabaId.trim()}`,
      phoneCount: 0,
      source: "manual",
    }]);
    setManualWabaId("");
    setManualLabel("");
    setShowManualInput(false);
  };

  const removeWaba = (wabaId: string) => {
    setSelectedWabas(selectedWabas.filter((w) => w.wabaId !== wabaId));
  };

  const totalPhones = selectedWabas.reduce((sum, w) => sum + w.phoneCount, 0);

  const statusIcon = (status: string) => {
    switch (status) {
      case "active": return <Wifi className="w-3.5 h-3.5 text-green-500" />;
      case "no_phones": return <Phone className="w-3.5 h-3.5 text-yellow-500" />;
      case "error": return <WifiOff className="w-3.5 h-3.5 text-red-500" />;
      default: return <HelpCircle className="w-3.5 h-3.5 text-muted-foreground" />;
    }
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "active": return "Ativa";
      case "no_phones": return "Sem números";
      case "error": return "Erro de acesso";
      default: return "Desconhecido";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Building2 className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Seleção de WABA</h2>
          <p className="text-sm text-muted-foreground">Selecione as contas WhatsApp Business que serão usadas nesta campanha</p>
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

      {selectedWabas.length > 0 && (
        <div className="bg-blue-50/50 border border-blue-100 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-blue-900">WABAs Selecionadas</h4>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs bg-white">
                {selectedWabas.length} WABA(s)
              </Badge>
              {totalPhones > 0 && (
                <Badge variant="outline" className="text-xs bg-white">
                  <Phone className="w-3 h-3 mr-1" />
                  {totalPhones} número(s)
                </Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedWabas.map((w) => (
              <div
                key={w.wabaId}
                className="flex items-center gap-1.5 bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-xs font-medium text-blue-800"
              >
                <Check className="w-3 h-3 text-blue-600" />
                <span>{w.label}</span>
                <span className="text-blue-400">({w.wabaId})</span>
                {w.source === "manual" && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-yellow-50 text-yellow-700 border-yellow-200">
                    Manual
                  </Badge>
                )}
                <button
                  onClick={() => removeWaba(w.wabaId)}
                  className="ml-1 text-blue-400 hover:text-red-500 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {discoveredWabas.length > 0 && (
        <div className="border rounded-xl p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
              <Wifi className="w-4 h-4 text-green-600" />
            </div>
            <div>
              <h3 className="font-semibold text-base">WABAs Descobertas Automaticamente</h3>
              <p className="text-xs text-muted-foreground">
                {discoveredWabas.length} conta(s) encontrada(s) no seu Business Manager. Clique para selecionar.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {discoveredWabas.map((waba) => {
              const selected = isWabaSelected(waba.wabaId);
              return (
                <div
                  key={waba.wabaId}
                  onClick={() => toggleWaba(waba)}
                  className={`relative p-4 border-2 rounded-xl cursor-pointer transition-all ${
                    selected
                      ? "border-[#0066FF] bg-[#0066FF]/5 shadow-md"
                      : "border-muted hover:border-muted-foreground/30 bg-white hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      selected ? "bg-[#0066FF] border-[#0066FF]" : "border-muted-foreground/40"
                    }`}>
                      {selected && <Check className="w-3.5 h-3.5 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-semibold text-sm truncate">{waba.wabaName?.trim() || waba.wabaId}</p>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              {statusIcon(waba.status)}
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="text-xs">{statusLabel(waba.status)}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">ID: {waba.wabaId}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <Badge variant="outline" className="text-[10px]">
                          <Phone className="w-3 h-3 mr-1" />
                          {waba.phoneCount} número(s)
                        </Badge>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${
                            waba.status === "active"
                              ? "bg-green-50 text-green-700 border-green-200"
                              : waba.status === "error"
                              ? "bg-red-50 text-red-700 border-red-200"
                              : "bg-yellow-50 text-yellow-700 border-yellow-200"
                          }`}
                        >
                          {statusLabel(waba.status)}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {registeredWabas.length > 0 && discoveredWabas.length === 0 && (
        <div className="border rounded-xl p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-[#0066FF]" />
            </div>
            <div>
              <h3 className="font-semibold text-base">WABAs Cadastradas</h3>
              <p className="text-xs text-muted-foreground">Selecione entre as WABAs já cadastradas no sistema</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {registeredWabas.map((waba: any) => {
              const id = waba.wabaId || waba.id;
              const selected = isWabaSelected(id);
              return (
                <div
                  key={id}
                  onClick={() => toggleRegisteredWaba(waba)}
                  className={`relative p-4 border-2 rounded-xl cursor-pointer transition-all ${
                    selected
                      ? "border-[#0066FF] bg-[#0066FF]/5 shadow-md"
                      : "border-muted hover:border-muted-foreground/30 bg-white hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                      selected ? "bg-[#0066FF] border-[#0066FF]" : "border-muted-foreground/40"
                    }`}>
                      {selected && <Check className="w-3.5 h-3.5 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm truncate">{waba.name?.trim() || waba.wabaId || id}</p>
                      <p className="text-xs text-muted-foreground font-mono">ID: {id}</p>
                      {waba.bmId && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Users className="w-3 h-3" />
                          <span className="font-mono">BM: {waba.bmId}</span>
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="border rounded-xl p-5 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-yellow-100 flex items-center justify-center">
              <Plus className="w-4 h-4 text-yellow-600" />
            </div>
            <div>
              <h3 className="font-semibold text-base">Adicionar WABA Manualmente</h3>
              <p className="text-xs text-muted-foreground">Informe o WABA ID caso a busca automática não tenha encontrado</p>
            </div>
          </div>
          <Button
            variant={showManualInput ? "secondary" : "outline"}
            size="sm"
            onClick={() => setShowManualInput(!showManualInput)}
          >
            {showManualInput ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
            {showManualInput ? "Cancelar" : "Adicionar"}
          </Button>
        </div>

        {showManualInput && (
          <div className="border border-dashed border-yellow-300 rounded-xl p-4 space-y-3 bg-yellow-50/30">
            <div>
              <Label className="text-xs font-medium">WABA ID *</Label>
              <p className="text-[11px] text-muted-foreground mb-1">O ID numérico da conta WhatsApp Business</p>
              <Input
                value={manualWabaId}
                onChange={(e) => setManualWabaId(e.target.value)}
                placeholder="Ex: 123456789012345"
              />
            </div>
            <div>
              <Label className="text-xs font-medium">Nome / Label (opcional)</Label>
              <p className="text-[11px] text-muted-foreground mb-1">Um nome amigável para identificar esta WABA</p>
              <Input
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                placeholder="Ex: Conta Principal"
              />
            </div>
            <Button
              onClick={addManualWaba}
              disabled={!manualWabaId.trim()}
              size="sm"
              className="w-full bg-[#0066FF] hover:bg-[#0052CC] text-white"
            >
              <Plus className="w-4 h-4 mr-1" />
              Adicionar WABA
            </Button>
          </div>
        )}
      </div>

      {discoveredWabas.length === 0 && registeredWabas.length === 0 && selectedWabas.length === 0 && (
        <div className="text-center py-8 space-y-3 border-2 border-dashed rounded-xl">
          <Building2 className="w-10 h-10 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">Nenhuma WABA disponível</p>
            <p className="text-xs text-muted-foreground mt-1">
              Configure as credenciais Meta na etapa anterior para buscar WABAs automaticamente,
              ou adicione manualmente usando o botão acima.
            </p>
          </div>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800">
            Selecionar múltiplas WABAs permite distribuir o envio entre diferentes contas,
            reduzindo o risco de bloqueios e aumentando a capacidade de disparo.
          </p>
        </div>
      </div>
    </div>
  );
}
