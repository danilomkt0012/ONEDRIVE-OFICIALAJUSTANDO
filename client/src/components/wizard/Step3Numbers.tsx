import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, Info, ArrowLeft, Check, AlertCircle, Building2, Loader2 } from "lucide-react";
import type { SelectedWaba } from "./Step2WabaSelection";

interface WabaNumberGroup {
  wabaId: string;
  wabaLabel: string;
  numbers: any[];
  loading: boolean;
}

interface Step3NumbersProps {
  selectedWabas: SelectedWaba[];
  wabaNumberGroups: WabaNumberGroup[];
  selectedNumbers: any[];
  setSelectedNumbers: (v: any[]) => void;
  setCurrentStep: (v: number) => void;
  validationErrors: string[];
}

export default function Step3Numbers({
  selectedWabas, wabaNumberGroups, selectedNumbers, setSelectedNumbers, setCurrentStep, validationErrors,
}: Step3NumbersProps) {
  const toggleNumber = (num: any, wabaId: string) => {
    const isSelected = selectedNumbers.some((n: any) => n.phoneNumberId === num.phoneNumberId);
    if (isSelected) {
      setSelectedNumbers(selectedNumbers.filter((n: any) => n.phoneNumberId !== num.phoneNumberId));
    } else {
      setSelectedNumbers([...selectedNumbers, {
        phoneNumberId: num.phoneNumberId,
        displayNumber: num.displayNumber,
        wabaId,
      }]);
    }
  };

  const selectAllFromWaba = (group: WabaNumberGroup) => {
    const newNumbers = group.numbers
      .filter((num) => !selectedNumbers.some((n: any) => n.phoneNumberId === num.phoneNumberId))
      .map((num) => ({
        phoneNumberId: num.phoneNumberId,
        displayNumber: num.displayNumber,
        wabaId: group.wabaId,
      }));
    setSelectedNumbers([...selectedNumbers, ...newNumbers]);
  };

  const deselectAllFromWaba = (group: WabaNumberGroup) => {
    const phoneIds = new Set(group.numbers.map((n) => n.phoneNumberId));
    setSelectedNumbers(selectedNumbers.filter((n: any) => !phoneIds.has(n.phoneNumberId)));
  };

  const totalAvailable = wabaNumberGroups.reduce((sum, g) => sum + g.numbers.length, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Phone className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Seleção de Números</h2>
          <p className="text-sm text-muted-foreground">Selecione os números de todas as WABAs que serão usados para envio</p>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-800">
            Usar múltiplos números distribui a carga e protege contra bloqueios.
            Os números estão agrupados por WABA de origem.
          </p>
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

      {selectedNumbers.length > 0 && (
        <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-xl">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-green-600" />
            <span className="text-sm font-medium text-green-800">{selectedNumbers.length} número(s) selecionado(s)</span>
          </div>
          <Badge variant="outline" className="text-xs bg-white">
            de {totalAvailable} disponível(is)
          </Badge>
        </div>
      )}

      {selectedWabas.length === 0 ? (
        <div className="text-center py-8 space-y-3 border-2 border-dashed rounded-xl">
          <Building2 className="w-10 h-10 text-muted-foreground mx-auto" />
          <div>
            <p className="text-sm font-medium text-muted-foreground">Nenhuma WABA selecionada</p>
            <p className="text-xs text-muted-foreground mt-1">Volte para a etapa anterior e selecione pelo menos uma WABA.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setCurrentStep(2)}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Ir para Seleção de WABA
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {wabaNumberGroups.map((group) => (
            <div key={group.wabaId} className="border rounded-xl p-5 space-y-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Building2 className="w-4 h-4 text-[#0066FF]" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm">{group.wabaLabel}</h3>
                    <p className="text-xs text-muted-foreground font-mono">ID: {group.wabaId}</p>
                  </div>
                </div>
                {!group.loading && group.numbers.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {group.numbers.filter((n) =>
                        selectedNumbers.some((sn: any) => sn.phoneNumberId === n.phoneNumberId)
                      ).length} / {group.numbers.length}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => {
                        const allSelected = group.numbers.every((n) =>
                          selectedNumbers.some((sn: any) => sn.phoneNumberId === n.phoneNumberId)
                        );
                        if (allSelected) {
                          deselectAllFromWaba(group);
                        } else {
                          selectAllFromWaba(group);
                        }
                      }}
                    >
                      {group.numbers.every((n) =>
                        selectedNumbers.some((sn: any) => sn.phoneNumberId === n.phoneNumberId)
                      ) ? "Desmarcar todos" : "Selecionar todos"}
                    </Button>
                  </div>
                )}
              </div>

              {group.loading ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mr-2" />
                  <span className="text-sm text-muted-foreground">Carregando números...</span>
                </div>
              ) : group.numbers.length === 0 ? (
                <div className="text-center py-4 border-2 border-dashed rounded-lg">
                  <Phone className="w-6 h-6 text-muted-foreground mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">Nenhum número encontrado para esta WABA</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {group.numbers.map((num: any) => {
                    const isSelected = selectedNumbers.some((n: any) => n.phoneNumberId === num.phoneNumberId);
                    const qualityColor = num.qualityRating === "GREEN" ? "text-green-600 bg-green-50 border-green-200" :
                      num.qualityRating === "YELLOW" ? "text-yellow-600 bg-yellow-50 border-yellow-200" :
                      num.qualityRating === "RED" ? "text-red-600 bg-red-50 border-red-200" :
                      "text-muted-foreground bg-muted border-muted";
                    return (
                      <div
                        key={num.id || num.phoneNumberId}
                        className={`p-3 border-2 rounded-xl cursor-pointer transition-all ${
                          isSelected ? "border-[#0066FF] bg-[#0066FF]/5 shadow-sm" : "border-transparent hover:border-muted-foreground/30 bg-muted/30"
                        }`}
                        onClick={() => toggleNumber(num, group.wabaId)}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                            isSelected ? "bg-[#0066FF] border-[#0066FF]" : "border-muted-foreground/40"
                          }`}>
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{num.displayNumber}</p>
                            <p className="text-xs text-muted-foreground truncate">{num.verifiedName || "Sem nome verificado"}</p>
                          </div>
                          <Badge variant="outline" className={`text-[10px] shrink-0 ${qualityColor}`}>
                            {num.qualityRating || "N/A"}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
