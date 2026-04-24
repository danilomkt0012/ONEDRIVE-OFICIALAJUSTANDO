import { useState, useEffect, useRef } from 'react';
import { Terminal, Filter } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { LogEntry } from '@/hooks/useCampaignMetrics';

interface CampaignConsoleProps {
  logs: LogEntry[];
}

const typeColors: Record<string, { bg: string; text: string; border: string }> = {
  INFO: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  WARN: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  ERROR: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
  SEND: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
};

export function CampaignConsole({ logs }: CampaignConsoleProps) {
  const [filter, setFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const filteredLogs = filter ? logs.filter(l => l.type === filter) : logs;
  const filters: Array<{ type: string; label: string }> = [
    { type: 'INFO', label: 'Info' },
    { type: 'WARN', label: 'Warn' },
    { type: 'ERROR', label: 'Erro' },
    { type: 'SEND', label: 'Envio' },
  ];

  return (
    <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-zinc-500" />
          <span className="text-sm font-medium text-zinc-300">Console Live</span>
          <Badge className="text-[10px] bg-zinc-800 text-zinc-500 border-zinc-700">
            {filteredLogs.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Filter className="h-3 w-3 text-zinc-600 mr-1" />
          <button
            onClick={() => setFilter(null)}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              filter === null ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Todos
          </button>
          {filters.map(f => {
            const count = logs.filter(l => l.type === f.type).length;
            if (count === 0) return null;
            return (
              <button
                key={f.type}
                onClick={() => setFilter(filter === f.type ? null : f.type)}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                  filter === f.type 
                    ? `${typeColors[f.type].bg} ${typeColors[f.type].text}` 
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {f.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      <div 
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-48 overflow-y-auto font-mono text-[11px] space-y-0.5 bg-black/30 rounded-lg p-2"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-center text-zinc-600 py-8">
            Aguardando eventos...
          </div>
        ) : (
          filteredLogs.map((log, i) => {
            const colors = typeColors[log.type] || typeColors.INFO;
            return (
              <div key={i} className="flex items-start gap-2 py-0.5">
                <span className="text-zinc-600 flex-shrink-0 w-[65px]">
                  {new Date(log.timestamp).toLocaleTimeString('pt-BR', { 
                    hour: '2-digit', minute: '2-digit', second: '2-digit' 
                  })}
                </span>
                <Badge className={`${colors.bg} ${colors.text} ${colors.border} text-[9px] px-1.5 py-0 flex-shrink-0`}>
                  {log.type}
                </Badge>
                <span className="text-zinc-400 break-all">{log.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
