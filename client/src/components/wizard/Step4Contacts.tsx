import { useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Type, FileUp, Upload, CheckCircle, AlertCircle } from "lucide-react";
import type { ProcessedLead } from "./types";
import { processLeadLines } from "./types";

interface Step4ContactsProps {
  contactInputMode: "list" | "paste" | "file";
  setContactInputMode: (v: "list" | "paste" | "file") => void;
  leadLists: any[];
  leadListId: string;
  setLeadListId: (v: string) => void;
  pastedNumbers: string;
  setPastedNumbers: (v: string) => void;
  processedLeads: { total: number; valid: ProcessedLead[]; duplicates: number; invalid: number; errors: string[] } | null;
  setProcessedLeads: (v: { total: number; valid: ProcessedLead[]; duplicates: number; invalid: number; errors: string[] } | null) => void;
  directLeads: ProcessedLead[];
  setDirectLeads: (v: ProcessedLead[]) => void;
  validationErrors: string[];
}

export default function Step4Contacts({
  contactInputMode, setContactInputMode, leadLists, leadListId, setLeadListId,
  pastedNumbers, setPastedNumbers, processedLeads, setProcessedLeads, directLeads, setDirectLeads, validationErrors,
}: Step4ContactsProps) {
  const leadFileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#0066FF]/10 flex items-center justify-center">
          <Users className="w-5 h-5 text-[#0066FF]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Contatos da Campanha</h2>
          <p className="text-sm text-muted-foreground">Escolha como fornecer os contatos para esta campanha</p>
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

      <div className="flex gap-2">
        {[
          { id: "list" as const, label: "Lista existente", icon: Users },
          { id: "paste" as const, label: "Colar números", icon: Type },
          { id: "file" as const, label: "Importar arquivo", icon: FileUp },
        ].map((mode) => {
          const Icon = mode.icon;
          return (
            <button
              key={mode.id}
              onClick={() => { setContactInputMode(mode.id); setProcessedLeads(null); }}
              className={`flex-1 flex items-center justify-center gap-2 p-3 border rounded-xl text-sm transition-colors ${
                contactInputMode === mode.id ? "border-primary bg-primary/5 font-medium shadow-sm" : "hover:border-muted-foreground/50"
              }`}
            >
              <Icon className="w-4 h-4" />
              {mode.label}
            </button>
          );
        })}
      </div>

      {contactInputMode === "list" && (
        <div className="space-y-2">
          {leadLists.length === 0 ? (
            <div className="text-center py-8 border-2 border-dashed rounded-xl">
              <Users className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">Nenhuma lista encontrada.</p>
              <p className="text-xs text-muted-foreground mt-1">Importe contatos na página "Preparar Lista" primeiro.</p>
            </div>
          ) : (
            leadLists.map((list: any) => {
              const isSelected = leadListId === list.id;
              return (
                <div
                  key={list.id}
                  className={`p-3 border rounded-xl cursor-pointer transition-all ${
                    isSelected ? "border-primary bg-primary/5 shadow-sm" : "hover:border-muted-foreground/50"
                  }`}
                  onClick={() => setLeadListId(list.id)}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{list.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {list.validLeads || list.totalLeads} contatos válidos
                      </p>
                    </div>
                    <Badge variant="outline">{list.status}</Badge>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {contactInputMode === "paste" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs font-medium">Cole os leads (formato: número, nome, cpf — um por linha)</Label>
            <p className="text-[11px] text-muted-foreground mb-1">Aceita: número,nome,cpf | número,nome | somente número</p>
            <Textarea
              value={pastedNumbers}
              onChange={(e) => setPastedNumbers(e.target.value)}
              placeholder={"5511999998888, Maria Silva, 12345678900\n5521988887777, João Santos, 98765432100\n11977776666, Ana Costa\n+5531966665555"}
              rows={8}
              className="font-mono text-sm"
            />
          </div>
          <Button
            onClick={() => {
              const result = processLeadLines(pastedNumbers);
              setProcessedLeads(result);
              setDirectLeads(result.valid);
            }}
            disabled={!pastedNumbers.trim()}
          >
            <CheckCircle className="w-4 h-4 mr-1" />
            Processar Leads
          </Button>
        </div>
      )}

      {contactInputMode === "file" && (
        <div className="space-y-3">
          <div className="text-center py-6 border-2 border-dashed rounded-xl">
            <FileUp className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground mb-2">Arquivo CSV ou TXT com números de telefone</p>
            <Button variant="outline" onClick={() => leadFileRef.current?.click()}>
              <Upload className="w-4 h-4 mr-1" />
              Selecionar Arquivo
            </Button>
            <input
              ref={leadFileRef}
              type="file"
              accept=".csv,.txt,.tsv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (ev) => {
                  const text = ev.target?.result as string;
                  setPastedNumbers(text);
                  const result = processLeadLines(text);
                  setProcessedLeads(result);
                  setDirectLeads(result.valid);
                };
                reader.readAsText(file);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      )}

      {processedLeads && (
        <div className="border rounded-xl p-4 space-y-2 bg-muted/30 shadow-sm">
          <h4 className="font-semibold text-sm">Resultado do Processamento</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="text-center p-2 bg-background rounded-lg border">
              <p className="text-lg font-bold">{processedLeads.total}</p>
              <p className="text-xs text-muted-foreground">Total de linhas</p>
            </div>
            <div className="text-center p-2 bg-green-50 rounded-lg border border-green-200">
              <p className="text-lg font-bold text-green-700">{processedLeads.valid.length}</p>
              <p className="text-xs text-green-600">Válidos</p>
            </div>
            <div className="text-center p-2 bg-yellow-50 rounded-lg border border-yellow-200">
              <p className="text-lg font-bold text-yellow-700">{processedLeads.duplicates}</p>
              <p className="text-xs text-yellow-600">Duplicados removidos</p>
            </div>
            <div className="text-center p-2 bg-red-50 rounded-lg border border-red-200">
              <p className="text-lg font-bold text-red-700">{processedLeads.invalid}</p>
              <p className="text-xs text-red-600">Inválidos</p>
            </div>
          </div>
          {processedLeads.valid.length > 0 && (
            <div className="mt-2 max-h-32 overflow-auto text-xs font-mono bg-background rounded border p-2 space-y-0.5">
              {processedLeads.valid.slice(0, 10).map((l, i) => (
                <div key={i} className="text-muted-foreground">
                  {l.phone} {l.name && `| ${l.name}`} {l.cpf && `| ${l.cpf}`}
                </div>
              ))}
              {processedLeads.valid.length > 10 && (
                <div className="text-muted-foreground/60">... +{processedLeads.valid.length - 10} leads</div>
              )}
            </div>
          )}
          {processedLeads.errors.length > 0 && (
            <div className="mt-1 max-h-20 overflow-auto text-xs text-red-500 bg-red-50 rounded border border-red-200 p-2 space-y-0.5">
              {processedLeads.errors.slice(0, 5).map((e, i) => (
                <div key={i}>{e}</div>
              ))}
              {processedLeads.errors.length > 5 && (
                <div className="text-red-400">... +{processedLeads.errors.length - 5} erros</div>
              )}
            </div>
          )}
        </div>
      )}

      {directLeads.length > 0 && contactInputMode !== "list" && (
        <p className="text-xs text-green-600 font-medium flex items-center gap-1">
          <CheckCircle className="w-3 h-3" />
          {directLeads.length} contato(s) prontos para envio
          {directLeads.filter(l => l.name).length > 0 && ` (${directLeads.filter(l => l.name).length} com nome)`}
          {directLeads.filter(l => l.cpf).length > 0 && ` (${directLeads.filter(l => l.cpf).length} com CPF)`}
        </p>
      )}
    </div>
  );
}
