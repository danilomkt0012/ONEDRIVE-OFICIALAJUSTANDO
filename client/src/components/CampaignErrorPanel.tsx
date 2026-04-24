import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Clock, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface ErrorMapEntry {
  code: string;
  count: number;
  lastOccurrence: number;
  lastMessage: string;
  lastPhone?: string;
}

interface CampaignErrorPanelProps {
  errors: {
    total: number;
    rateLimitErrors: number;
    payloadErrors: number;
    networkErrors: number;
    authErrors: number;
    environmentErrors: number;
    templateErrors: number;
    timeoutErrors: number;
  };
  events: Array<{ type: string; timestamp: number; data: any }>;
}

export function CampaignErrorPanel({ errors, events }: CampaignErrorPanelProps) {
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const errorEvents = events.filter(e => 
    e.type === 'send_result' && e.data && !e.data.success && e.data.errorMessage
  );

  const errorMap = new Map<string, ErrorMapEntry>();
  for (const event of errorEvents) {
    const errorMsg = event.data.errorMessage || '';
    const codeMatch = errorMsg.match(/(\d{5,6})/);
    const code = codeMatch?.[1] || 'unknown';
    
    const existing = errorMap.get(code);
    if (existing) {
      existing.count++;
      existing.lastOccurrence = event.timestamp;
      existing.lastMessage = errorMsg;
      if (event.data.phone) existing.lastPhone = event.data.phone;
    } else {
      errorMap.set(code, {
        code,
        count: 1,
        lastOccurrence: event.timestamp,
        lastMessage: errorMsg,
        lastPhone: event.data.phone,
      });
    }
  }

  const errorEntries = Array.from(errorMap.values()).sort((a, b) => b.count - a.count);

  if (errors.total === 0 && errorEntries.length === 0) {
    return (
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-300">Erros</span>
        </div>
        <div className="text-center py-4 text-zinc-500 text-sm">
          Nenhum erro detectado
        </div>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <span className="text-sm font-medium text-zinc-300">Erros Detectados</span>
        </div>
        <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs">
          {errors.total} total
        </Badge>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center text-xs mb-4">
        {errors.rateLimitErrors > 0 && (
          <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="font-semibold text-red-400">{errors.rateLimitErrors}</div>
            <div className="text-zinc-500">Rate Limit</div>
          </div>
        )}
        {errors.payloadErrors > 0 && (
          <div className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg">
            <div className="font-semibold text-zinc-300">{errors.payloadErrors}</div>
            <div className="text-zinc-500">Payload</div>
          </div>
        )}
        {errors.networkErrors > 0 && (
          <div className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg">
            <div className="font-semibold text-zinc-300">{errors.networkErrors}</div>
            <div className="text-zinc-500">Network</div>
          </div>
        )}
        {errors.authErrors > 0 && (
          <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-lg">
            <div className="font-semibold text-red-400">{errors.authErrors}</div>
            <div className="text-zinc-500">Auth</div>
          </div>
        )}
        {errors.environmentErrors > 0 && (
          <div className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg">
            <div className="font-semibold text-zinc-300">{errors.environmentErrors}</div>
            <div className="text-zinc-500">Ambiente</div>
          </div>
        )}
        {errors.templateErrors > 0 && (
          <div className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg">
            <div className="font-semibold text-zinc-300">{errors.templateErrors}</div>
            <div className="text-zinc-500">Template</div>
          </div>
        )}
      </div>

      {errorEntries.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          <div className="grid grid-cols-[80px_60px_1fr] gap-2 text-xs text-zinc-500 font-medium px-2 pb-1 border-b border-zinc-800">
            <span>Código</span>
            <span className="text-center">Qtd</span>
            <span>Última Ocorrência</span>
          </div>
          {errorEntries.map((entry) => (
            <div key={entry.code}>
              <button 
                onClick={() => setExpandedCode(expandedCode === entry.code ? null : entry.code)}
                className="w-full grid grid-cols-[80px_60px_1fr_20px] gap-2 items-center text-xs px-2 py-1.5 hover:bg-zinc-800/50 rounded transition-colors"
              >
                <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[10px] justify-center">
                  {entry.code}
                </Badge>
                <span className="text-center font-semibold text-zinc-300">{entry.count}</span>
                <span className="text-zinc-500 text-left truncate">
                  {new Date(entry.lastOccurrence).toLocaleTimeString('pt-BR')}
                </span>
                {expandedCode === entry.code ? (
                  <ChevronUp className="h-3 w-3 text-zinc-600" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-zinc-600" />
                )}
              </button>
              {expandedCode === entry.code && (
                <div className="ml-4 px-3 py-2 bg-zinc-800/30 rounded-lg text-xs space-y-1 mb-1">
                  <div className="flex items-center gap-2 text-zinc-400">
                    <AlertTriangle className="h-3 w-3 text-red-400 flex-shrink-0" />
                    <span className="break-all">{entry.lastMessage}</span>
                  </div>
                  {entry.lastPhone && (
                    <div className="flex items-center gap-2 text-zinc-500">
                      <Phone className="h-3 w-3 flex-shrink-0" />
                      <span>{entry.lastPhone}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-zinc-600">
                    <Clock className="h-3 w-3 flex-shrink-0" />
                    <span>{new Date(entry.lastOccurrence).toLocaleString('pt-BR')}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
