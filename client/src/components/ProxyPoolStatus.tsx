import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Globe, CheckCircle, XCircle, Clock, Wifi, Plus, Trash2, Power, PowerOff, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface ProxyRow {
  id: string;
  url: string;
  label: string | null;
  isActive: boolean;
  latencyMs: number | null;
  lastCheckedAt: string | null;
  createdAt: string | null;
  runtimeActive: boolean;
  runtimeLatencyMs: number | null;
  runtimeLastError: string | null;
  assignedSessionId: string | null;
  userDisabled?: boolean;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = u.username.slice(0, 3) + "***";
    return u.toString();
  } catch {
    return url.slice(0, 30) + "...";
  }
}

export function ProxyPoolStatus() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  const { data: proxies = [], isLoading, isError } = useQuery<ProxyRow[]>({
    queryKey: ["/api/proxies"],
    queryFn: async () => {
      const res = await fetch("/api/proxies", { credentials: "include" });
      if (!res.ok) throw new Error("Erro ao carregar proxies");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const healthCheckMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/proxy-pool/health-check", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Erro ao executar health check");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      toast({ title: "Health check concluído", description: "Status dos proxies atualizado." });
    },
  });

  const addMutation = useMutation({
    mutationFn: async ({ url, label }: { url: string; label?: string }) => {
      const res = await apiRequest("POST", "/api/proxies", { url, label: label || undefined });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      setNewUrl("");
      setNewLabel("");
      setIsAdding(false);
      toast({ title: "Proxy adicionado", description: "O proxy foi adicionado ao pool com sucesso." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro ao adicionar proxy", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/proxies/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
    },
    onError: (err: Error) => {
      toast({ title: "Erro", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/proxies/${id}`, undefined);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      toast({ title: "Proxy removido", description: "O proxy foi removido do pool." });
    },
    onError: (err: Error) => {
      toast({ title: "Erro ao remover proxy", description: err.message, variant: "destructive" });
    },
  });

  function convertProxyInput(input: string): string {
    const trimmed = input.trim();
    const parts = trimmed.split(":");
    if (parts.length === 4 && !trimmed.startsWith("http")) {
      const [ip, port, user, pass] = parts;
      return `http://${user}:${pass}@${ip}:${port}`;
    }
    return trimmed;
  }

  const handleAdd = () => {
    if (!newUrl.trim()) {
      toast({ title: "URL obrigatória", description: "Informe a URL do proxy.", variant: "destructive" });
      return;
    }
    const convertedUrl = convertProxyInput(newUrl);
    addMutation.mutate({ url: convertedUrl, label: newLabel.trim() || undefined });
  };

  const handleDelete = (id: string, url: string) => {
    if (!confirm(`Remover o proxy "${maskUrl(url)}"?`)) return;
    deleteMutation.mutate(id);
  };

  const activeCount = proxies.filter((p) => p.isActive && p.runtimeActive).length;
  const latencies = proxies.filter((p) => p.runtimeActive && p.runtimeLatencyMs !== null).map((p) => p.runtimeLatencyMs as number);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#718096] py-4">
        <RefreshCw size={14} className="animate-spin" />
        Carregando proxies...
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-sm text-[#E53E3E] py-2">
        Não foi possível carregar os proxies.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {proxies.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-3 text-center">
            <div className="text-2xl font-bold text-[#1A202C]">{proxies.length}</div>
            <div className="text-xs text-[#718096] mt-0.5">Total</div>
          </div>
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-3 text-center">
            <div className="text-2xl font-bold text-[#38A169]">{activeCount}</div>
            <div className="text-xs text-[#718096] mt-0.5">Ativos</div>
          </div>
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-3 text-center">
            <div className="text-2xl font-bold text-[#718096]">
              {avgLatency !== null ? `${avgLatency}ms` : "—"}
            </div>
            <div className="text-xs text-[#718096] mt-0.5">Latência média</div>
          </div>
        </div>
      )}

      {proxies.length === 0 && !isAdding && (
        <div className="rounded-xl border border-[#E2E8F0] bg-[#F7FAFC] p-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-white border border-[#E2E8F0] flex items-center justify-center flex-shrink-0">
              <Globe size={16} className="text-[#A0AEC0]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[#1A202C]">Nenhum proxy cadastrado</p>
              <p className="text-xs text-[#718096]">
                Adicione proxies abaixo ou configure a variável{" "}
                <code className="bg-[#EDF2F7] px-1 rounded text-[#2D3748]">PROXY_POOL</code> como fallback.
              </p>
            </div>
          </div>
        </div>
      )}

      {proxies.length > 0 && (
        <div className="space-y-2">
          {proxies.map((proxy) => {
            const isOk = proxy.isActive && proxy.runtimeActive;
            return (
              <div
                key={proxy.id}
                className={`flex items-start gap-3 rounded-xl border p-3 ${
                  !proxy.isActive
                    ? "border-[#E2E8F0] bg-[#F7FAFC] opacity-60"
                    : isOk
                    ? "border-[#C6F6D5] bg-[#F0FFF4]"
                    : "border-[#FED7D7] bg-[#FFF5F5]"
                }`}
              >
                <div className="flex-shrink-0 mt-0.5">
                  {!proxy.isActive ? (
                    <XCircle size={16} className="text-[#A0AEC0]" />
                  ) : isOk ? (
                    <CheckCircle size={16} className="text-[#38A169]" />
                  ) : (
                    <XCircle size={16} className="text-[#E53E3E]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-[#2D3748] truncate">
                    {maskUrl(proxy.url)}
                  </p>
                  {proxy.label && (
                    <p className="text-xs text-[#718096] flex items-center gap-1 mt-0.5">
                      <Tag size={10} />
                      {proxy.label}
                    </p>
                  )}
                  {proxy.assignedSessionId && (
                    <p className="text-xs text-[#718096] flex items-center gap-1 mt-0.5">
                      <Wifi size={10} />
                      Sessão: {proxy.assignedSessionId}
                    </p>
                  )}
                  {proxy.runtimeLastError && proxy.isActive && !proxy.runtimeActive && (
                    <p className="text-xs text-[#E53E3E] mt-0.5 truncate">{proxy.runtimeLastError}</p>
                  )}
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                  {proxy.runtimeLatencyMs !== null && proxy.runtimeActive ? (
                    <span className="text-xs text-[#718096] flex items-center gap-1">
                      <Clock size={10} />
                      {proxy.runtimeLatencyMs}ms
                    </span>
                  ) : (
                    <span className="text-xs text-[#A0AEC0]">—</span>
                  )}
                  <button
                    title={proxy.isActive ? "Desativar proxy" : "Ativar proxy"}
                    onClick={() => toggleMutation.mutate({ id: proxy.id, isActive: !proxy.isActive })}
                    disabled={toggleMutation.isPending}
                    className={`p-1 rounded hover:bg-white/60 transition-colors ${proxy.isActive ? "text-[#38A169]" : "text-[#A0AEC0]"}`}
                  >
                    {proxy.isActive ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button
                    title="Remover proxy"
                    onClick={() => handleDelete(proxy.id, proxy.url)}
                    disabled={deleteMutation.isPending}
                    className="p-1 rounded hover:bg-white/60 transition-colors text-[#E53E3E]"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isAdding ? (
        <div className="rounded-xl border border-[#0066FF]/20 bg-[#EBF4FF]/30 p-4 space-y-3">
          <p className="text-sm font-medium text-[#1A202C]">Adicionar novo proxy</p>
          <Input
            placeholder="ip:porta:usuario:senha"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="h-9 text-sm font-mono bg-white border-[#E2E8F0]"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setIsAdding(false); }}
          />
          <Input
            placeholder="Apelido (opcional)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="h-9 text-sm bg-white border-[#E2E8F0]"
            onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setIsAdding(false); }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={addMutation.isPending}
              className="bg-[#0066FF] hover:bg-[#0052CC] text-white"
            >
              {addMutation.isPending ? <RefreshCw size={13} className="animate-spin mr-1" /> : <Plus size={13} className="mr-1" />}
              Adicionar
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setIsAdding(false); setNewUrl(""); setNewLabel(""); }}
              className="border-[#E2E8F0] text-[#718096]"
            >
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsAdding(true)}
          className="w-full border-[#0066FF]/20 text-[#0066FF] hover:bg-[#EBF4FF]"
        >
          <Plus size={14} className="mr-2" />
          Adicionar proxy
        </Button>
      )}

      {proxies.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => healthCheckMutation.mutate()}
          disabled={healthCheckMutation.isPending}
          className="w-full border-[#E2E8F0] text-[#718096] hover:bg-[#F7FAFC] hover:text-[#1A202C]"
        >
          <RefreshCw size={14} className={`mr-2 ${healthCheckMutation.isPending ? "animate-spin" : ""}`} />
          {healthCheckMutation.isPending ? "Verificando..." : "Verificar proxies agora"}
        </Button>
      )}
    </div>
  );
}
