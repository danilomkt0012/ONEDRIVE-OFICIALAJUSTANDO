import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, Info, XCircle } from "lucide-react";

interface DeliveryIssue {
  issue: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  solution: string;
  actionItems: string[];
}

interface DeliveryAlertProps {
  templateCategory: string;
  issues: DeliveryIssue[];
  className?: string;
}

export function DeliveryAlert({ templateCategory, issues, className }: DeliveryAlertProps) {
  const criticalIssues = issues.filter(issue => issue.severity === 'critical');
  const hasMarketingIssue = templateCategory === 'MARKETING';
  
  if (!hasMarketingIssue && criticalIssues.length === 0) {
    return (
      <Alert className={`border-slate-200 bg-slate-50 ${className}`}>
        <CheckCircle className="h-4 w-4 text-slate-500" />
        <AlertDescription className="text-slate-600">
          <strong>Template configurado corretamente</strong>
          <br />
          Não foram detectados problemas de entrega.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {hasMarketingIssue && (
        <Alert className="border-red-200 bg-red-50">
          <XCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-800">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <strong>PROBLEMA PRINCIPAL IDENTIFICADO</strong>
                <Badge variant="destructive" className="text-xs">MARKETING</Badge>
              </div>
              <p>
                <strong>Templates MARKETING só entregam para clientes que iniciaram conversa nas últimas 24h.</strong>
              </p>
              <p className="text-sm">
                Mesmo que a API aceite a mensagem (gerando Message IDs), o WhatsApp bloqueia a entrega 
                para contatos que não interagiram recentemente.
              </p>
              <div className="mt-3 p-3 bg-white rounded border-l-4 border-blue-500">
                <p className="font-medium text-blue-800">SOLUÇÃO IMEDIATA:</p>
                <ul className="text-sm text-blue-700 mt-1 space-y-1">
                  <li>• Criar templates categoria <strong>UTILITY</strong> no Business Manager</li>
                  <li>• Templates UTILITY funcionam para qualquer contato</li>
                  <li>• Substituir templates MARKETING por UTILITY nas campanhas</li>
                </ul>
              </div>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {criticalIssues.map((issue, index) => (
        <Alert key={index} className="border-slate-200 bg-slate-50">
          <AlertTriangle className="h-4 w-4 text-slate-500" />
          <AlertDescription className="text-slate-700">
            <div className="space-y-2">
              <strong>{issue.description}</strong>
              <p className="text-sm">
                <strong>Solução:</strong> {issue.solution}
              </p>
              {issue.actionItems.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium">Ações recomendadas:</p>
                  <ul className="text-xs mt-1 space-y-1">
                    {issue.actionItems.map((action, actionIndex) => (
                      <li key={actionIndex}>• {action}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}