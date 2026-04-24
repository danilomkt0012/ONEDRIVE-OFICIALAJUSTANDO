import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { Server, Wifi, WifiOff } from "lucide-react";

interface ServerStatus {
  environment: string;
  status: string;
  uptime: string;
  uptimeMs: number;
  startedAt: string;
  lastWebhookEvent: string | null;
  webhookUrl: string;
  domain: string | null;
  envVars: {
    DATABASE_URL: boolean;
    WEBHOOK_VERIFY_TOKEN: boolean;
    NODE_ENV: string;
  };
}

export function ServerStatusBadge() {
  const { data, isError } = useQuery<ServerStatus>({
    queryKey: ["/api/server-status"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2">
        <WifiOff size={14} className="text-red-400" />
        <span className="text-xs text-red-400 font-medium">Offline</span>
      </div>
    );
  }

  const isProduction = data.environment === "production";

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${isProduction ? "bg-[#38A169]" : "bg-slate-400"}`} />
      <span className={`text-xs font-medium ${isProduction ? "text-[#38A169]" : "text-slate-500"}`}>
        {isProduction ? "Produção" : "Dev"} — {data.status === "online" ? "Online" : "Offline"}
      </span>
    </div>
  );
}

export function ServerStatusDetail() {
  const { data, isError, isLoading } = useQuery<ServerStatus>({
    queryKey: ["/api/server-status"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 10000,
    staleTime: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[#A0AEC0] text-xs">
        <Server size={14} className="animate-spin" />
        <span>Carregando status...</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 text-red-400 text-xs">
        <WifiOff size={14} />
        <span>Servidor indisponível</span>
      </div>
    );
  }

  const isProduction = data.environment === "production";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className={`w-2.5 h-2.5 rounded-full ${isProduction ? "bg-[#38A169]" : "bg-slate-400"}`} />
        <span className={`text-sm font-semibold ${isProduction ? "text-[#38A169]" : "text-slate-500"}`}>
          {isProduction ? "Produção — Online" : "Desenvolvimento"}
        </span>
      </div>
      <div className="text-xs text-[#718096] space-y-1">
        <div>Uptime: {data.uptime}</div>
        {data.lastWebhookEvent && (
          <div>Último webhook: {new Date(data.lastWebhookEvent).toLocaleString("pt-BR")}</div>
        )}
      </div>
    </div>
  );
}
