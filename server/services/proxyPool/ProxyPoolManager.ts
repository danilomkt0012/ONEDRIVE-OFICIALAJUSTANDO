import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { logError } from "../../utils/logger";
import { db } from "../../db";
import { proxies as proxiesTable } from "@shared/schema";
import { eq } from "drizzle-orm";

export interface ProxyEntry {
  id?: string;
  url: string;
  label?: string | null;
  /**
   * Runtime reachability — updated by health checks and markProxyFailed.
   * A proxy can be userDisabled=false but active=false if health check fails.
   */
  active: boolean;
  /**
   * User intent — set by setProxyActive(). When true, health checks will
   * not re-enable this proxy (it is excluded from the eligible pool).
   */
  userDisabled: boolean;
  latencyMs: number | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  assignedSessionId: string | null;
}

export interface SafeProxyEntry {
  id?: string;
  url: string;
  label?: string | null;
  active: boolean;
  userDisabled: boolean;
  latencyMs: number | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  assignedSessionId: string | null;
}

export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = u.username.slice(0, 3) + "***";
    return u.toString();
  } catch {
    return url.slice(0, 20) + "...";
  }
}

export class ProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyUnavailableError";
  }
}

function parseProxyPool(): string[] {
  const raw = process.env.PROXY_POOL || "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      try {
        new URL(s);
        return true;
      } catch {
        console.warn(`[ProxyPool] URL inválida ignorada: "${s}"`);
        return false;
      }
    });
}

type SessionProxyFailedCallback = (sessionId: string, proxyUrl: string) => void;

class ProxyPoolManager {
  /**
   * All proxies in the runtime pool, including user-disabled ones.
   * User-disabled proxies remain here so their state is visible in the UI,
   * but they are excluded from routing/health-check reactivation.
   */
  private proxies: ProxyEntry[] = [];
  private rrIndex: number = 0;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private sessionProxyFailedCallbacks: SessionProxyFailedCallback[] = [];

  constructor() {
    this._loadFromEnv();
  }

  private _loadFromEnv(): void {
    const urls = parseProxyPool();
    this.proxies = urls.map((url) => ({
      url,
      active: true,
      userDisabled: false,
      latencyMs: null,
      lastCheckedAt: null,
      lastError: null,
      assignedSessionId: null,
    }));
    if (urls.length > 0) {
      console.info(`[ProxyPool] ${urls.length} proxy(s) carregados da variável de ambiente.`);
    } else {
      console.info("[ProxyPool] Nenhum proxy via PROXY_POOL. Verificando banco de dados...");
    }
  }

  async loadFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(proxiesTable);
      if (rows.length === 0) {
        // No DB proxies registered — env fallback applies
        if (this.proxies.length === 0) {
          console.info("[ProxyPool] Nenhum proxy no banco de dados. Tráfego direto.");
        } else {
          console.info("[ProxyPool] Nenhum proxy no banco de dados. Usando variável de ambiente como fallback.");
        }
        return;
      }

      // DB has rows — it is now the source of truth; discard any env proxies
      this.proxies = rows.map((r) => ({
        id: r.id,
        url: r.url,
        label: r.label,
        active: r.isActive, // initially set from DB intent
        userDisabled: !r.isActive, // user intent
        latencyMs: r.latencyMs ?? null,
        lastCheckedAt: r.lastCheckedAt ?? null,
        lastError: null,
        assignedSessionId: null,
      }));
      const activeCount = this.proxies.filter((p) => !p.userDisabled).length;
      if (activeCount > 0) {
        console.info(`[ProxyPool] ${activeCount}/${this.proxies.length} proxy(s) ativos carregados do banco de dados.`);
      } else {
        console.info("[ProxyPool] Banco tem proxies registrados, mas todos estão desativados pelo usuário. Tráfego direto.");
      }
    } catch (err: unknown) {
      logError("ProxyPool.loadFromDb", {}, err);
      console.warn("[ProxyPool] Falha ao carregar proxies do banco. Usando variável de ambiente como fallback.");
    }
  }

  async reloadFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(proxiesTable);
      if (rows.length === 0) {
        // No DB proxies — use env fallback
        const envUrls = parseProxyPool();
        if (envUrls.length > 0) {
          this.proxies = envUrls.map((url) => ({
            url,
            active: true,
            userDisabled: false,
            latencyMs: null,
            lastCheckedAt: null,
            lastError: null,
            assignedSessionId: null,
          }));
          console.info(`[ProxyPool] Nenhum proxy no banco. Fallback: ${envUrls.length} proxy(s) da variável de ambiente.`);
        } else {
          this.proxies = [];
          console.info("[ProxyPool] Pool esvaziado. Tráfego direto.");
        }
        return;
      }

      // DB has rows — it is the source of truth; preserve runtime state for existing proxies
      const newProxies: ProxyEntry[] = rows.map((r) => {
        const existing = this.proxies.find((p) => p.id === r.id || p.url === r.url);
        return {
          id: r.id,
          url: r.url,
          label: r.label,
          userDisabled: !r.isActive,
          active: existing ? existing.active && r.isActive : r.isActive,
          latencyMs: existing ? existing.latencyMs : (r.latencyMs ?? null),
          lastCheckedAt: existing ? existing.lastCheckedAt : (r.lastCheckedAt ?? null),
          lastError: existing ? existing.lastError : null,
          assignedSessionId: existing ? existing.assignedSessionId : null,
        };
      });
      this.proxies = newProxies;
      const activeCount = this.proxies.filter((p) => !p.userDisabled).length;
      console.info(`[ProxyPool] Pool recarregado: ${activeCount}/${this.proxies.length} proxy(s) habilitados pelo usuário.`);
    } catch (err: unknown) {
      logError("ProxyPool.reloadFromDb", {}, err);
    }
  }

  async addProxy(url: string, label?: string): Promise<void> {
    try {
      await db.insert(proxiesTable).values({ url, label: label || null, isActive: true });
      console.info(`[ProxyPool] Proxy adicionado ao banco: "${maskProxyUrl(url)}". Reconciliando pool...`);
      // Reconcile from DB — this enforces that DB is source of truth
      // and removes env proxies from runtime when first DB proxy is added
      await this.reloadFromDb();
    } catch (err: unknown) {
      logError("ProxyPool.addProxy", { url }, err);
      throw err;
    }
  }

  async removeProxy(id: string): Promise<void> {
    try {
      // Release session before removal
      const proxy = this.proxies.find((p) => p.id === id);
      if (proxy?.assignedSessionId) {
        const affectedSession = proxy.assignedSessionId;
        proxy.assignedSessionId = null;
        this._notifySessionProxyFailed(affectedSession, proxy.url);
      }
      await db.delete(proxiesTable).where(eq(proxiesTable.id, id));
      console.info(`[ProxyPool] Proxy removido do banco: id=${id}. Reconciliando pool...`);
      // Reconcile from DB — this enforces source-of-truth and restores env
      // fallback if DB is now empty
      await this.reloadFromDb();
    } catch (err: unknown) {
      logError("ProxyPool.removeProxy", { id }, err);
      throw err;
    }
  }

  async setProxyActive(id: string, active: boolean): Promise<void> {
    try {
      await db.update(proxiesTable).set({ isActive: active, updatedAt: new Date() }).where(eq(proxiesTable.id, id));
      const proxy = this.proxies.find((p) => p.id === id);
      if (proxy) {
        proxy.userDisabled = !active;
        if (!active) {
          // Mark as inactive and release session if held
          const wasActive = proxy.active;
          proxy.active = false;
          if (wasActive && proxy.assignedSessionId) {
            const affectedSession = proxy.assignedSessionId;
            proxy.assignedSessionId = null;
            this._notifySessionProxyFailed(affectedSession, proxy.url);
          }
        } else {
          // Re-enable: start as active (health check will verify soon)
          proxy.active = true;
          proxy.lastError = null;
        }
        console.info(`[ProxyPool] Proxy "${maskProxyUrl(proxy.url)}" ${active ? "habilitado" : "desabilitado"} pelo usuário`);
      } else if (active) {
        // Proxy was not in the in-memory pool (e.g. was inactive at startup) — load from DB
        const [row] = await db.select().from(proxiesTable).where(eq(proxiesTable.id, id));
        if (row) {
          const entry: ProxyEntry = {
            id: row.id,
            url: row.url,
            label: row.label,
            active: true,
            userDisabled: false,
            latencyMs: row.latencyMs ?? null,
            lastCheckedAt: row.lastCheckedAt ?? null,
            lastError: null,
            assignedSessionId: null,
          };
          this.proxies.push(entry);
          console.info(`[ProxyPool] Proxy "${maskProxyUrl(row.url)}" adicionado ao pool via ativação`);
        }
      }
    } catch (err: unknown) {
      logError("ProxyPool.setProxyActive", { id, active }, err);
      throw err;
    }
  }

  get size(): number {
    return this.proxies.filter((p) => !p.userDisabled).length;
  }

  getAll(): ProxyEntry[] {
    return this.proxies.map((p) => ({ ...p }));
  }

  getStatus(): {
    total: number;
    active: number;
    inactive: number;
    avgLatencyMs: number | null;
    proxies: SafeProxyEntry[];
  } {
    const eligible = this.proxies.filter((p) => !p.userDisabled);
    const active = eligible.filter((p) => p.active).length;
    const latencies = eligible
      .filter((p) => p.active && p.latencyMs !== null)
      .map((p) => p.latencyMs as number);
    const avgLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;

    return {
      total: this.proxies.length,
      active,
      inactive: eligible.length - active,
      avgLatencyMs,
      proxies: this.proxies.map((p) => ({
        ...p,
        url: maskProxyUrl(p.url),
      })),
    };
  }

  onSessionProxyFailed(cb: SessionProxyFailedCallback): void {
    this.sessionProxyFailedCallbacks.push(cb);
  }

  private _notifySessionProxyFailed(sessionId: string, proxyUrl: string): void {
    for (const cb of this.sessionProxyFailedCallbacks) {
      try {
        cb(sessionId, proxyUrl);
      } catch (err) {
        logError("ProxyPool.sessionProxyFailedCallback", { sessionId }, err);
      }
    }
  }

  markProxyFailed(proxyUrl: string, reason: string): void {
    const proxy = this.proxies.find((p) => p.url === proxyUrl);
    if (!proxy) return;
    if (proxy.userDisabled) return; // already excluded; no state change needed
    if (proxy.active) {
      console.warn(
        `[ProxyPool] Proxy "${maskProxyUrl(proxyUrl)}" marcado como INATIVO por falha em requisição: ${reason}`
      );
    }
    proxy.active = false;
    proxy.lastError = reason;
    proxy.lastCheckedAt = new Date();
    if (proxy.assignedSessionId) {
      const affectedSession = proxy.assignedSessionId;
      console.warn(
        `[ProxyPool] Sessão "${affectedSession}" perdeu seu proxy — notificando para reconexão`
      );
      proxy.assignedSessionId = null;
      this._notifySessionProxyFailed(affectedSession, proxyUrl);
    }
    if (proxy.id) {
      db.update(proxiesTable)
        .set({ latencyMs: null, lastCheckedAt: new Date(), updatedAt: new Date() })
        .where(eq(proxiesTable.id, proxy.id))
        .catch((err: unknown) => logError("ProxyPool.markProxyFailed.dbUpdate", { id: proxy.id }, err));
    }
  }

  getNextForRotation(): ProxyEntry | null {
    if (this.proxies.length === 0) return null;

    const active = this.proxies.filter((p) => !p.userDisabled && p.active);
    if (active.length === 0) return null;

    const picked = active[this.rrIndex % active.length];
    this.rrIndex = (this.rrIndex + 1) % active.length;
    return picked;
  }

  assignProxyToSession(sessionId: string): ProxyEntry | null {
    if (this.proxies.length === 0) return null;

    const alreadyAssigned = this.proxies.find(
      (p) => p.assignedSessionId === sessionId
    );
    if (alreadyAssigned) {
      if (!alreadyAssigned.userDisabled && alreadyAssigned.active) {
        return alreadyAssigned;
      }
      alreadyAssigned.assignedSessionId = null;
      console.warn(
        `[ProxyPool] Proxy "${maskProxyUrl(alreadyAssigned.url)}" da sessão "${sessionId}" está inativo — selecionando substituto`
      );
    }

    const unassigned = this.proxies.filter(
      (p) => !p.userDisabled && p.active && p.assignedSessionId === null
    );
    if (unassigned.length > 0) {
      const proxy = unassigned[0];
      proxy.assignedSessionId = sessionId;
      console.info(
        `[ProxyPool] Proxy "${maskProxyUrl(proxy.url)}" atribuído à sessão "${sessionId}"`
      );
      return proxy;
    }

    return null;
  }

  releaseSessionProxy(sessionId: string): void {
    const proxy = this.proxies.find((p) => p.assignedSessionId === sessionId);
    if (proxy) {
      proxy.assignedSessionId = null;
      console.info(
        `[ProxyPool] Proxy "${maskProxyUrl(proxy.url)}" liberado da sessão "${sessionId}"`
      );
    }
  }

  buildAgent(proxyEntry: ProxyEntry): HttpsProxyAgent<string> {
    return new HttpsProxyAgent(proxyEntry.url);
  }

  buildAgentForSession(sessionId: string): HttpsProxyAgent<string> | null {
    const proxy = this.assignProxyToSession(sessionId);
    if (!proxy) return null;
    return this.buildAgent(proxy);
  }

  buildAgentForRotation(): { agent: HttpsProxyAgent<string>; proxyUrl: string } | null {
    const proxy = this.getNextForRotation();
    if (!proxy) return null;
    return { agent: this.buildAgent(proxy), proxyUrl: proxy.url };
  }

  private async _checkProxy(proxy: ProxyEntry): Promise<void> {
    // Skip health check for user-disabled proxies — they must not be re-activated
    if (proxy.userDisabled) return;

    const start = Date.now();
    try {
      const agent = this.buildAgent(proxy);
      await axios.head("https://graph.facebook.com/", {
        httpsAgent: agent,
        timeout: 8000,
        validateStatus: (status) => {
          if (status === 407) return false;
          return true;
        },
      });
      const latency = Date.now() - start;
      proxy.latencyMs = latency;
      proxy.lastCheckedAt = new Date();
      proxy.lastError = null;
      if (!proxy.active) {
        console.info(
          `[ProxyPool] Proxy "${maskProxyUrl(proxy.url)}" reativado após health check (latência: ${latency}ms)`
        );
      }
      proxy.active = true;
      // Only update telemetry columns — do NOT touch isActive (user intent)
      if (proxy.id) {
        db.update(proxiesTable)
          .set({ latencyMs: latency, lastCheckedAt: new Date(), updatedAt: new Date() })
          .where(eq(proxiesTable.id, proxy.id))
          .catch((err: unknown) => logError("ProxyPool.checkProxy.dbUpdate", { id: proxy.id }, err));
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      proxy.latencyMs = null;
      proxy.lastCheckedAt = new Date();
      proxy.lastError = errMsg;
      const wasActive = proxy.active;
      proxy.active = false;
      if (wasActive) {
        console.warn(
          `[ProxyPool] Proxy "${maskProxyUrl(proxy.url)}" marcado como INATIVO: ${errMsg}`
        );
        if (proxy.assignedSessionId) {
          const affectedSession = proxy.assignedSessionId;
          console.warn(
            `[ProxyPool] Sessão "${affectedSession}" perdeu seu proxy via health check — notificando para reconexão`
          );
          proxy.assignedSessionId = null;
          this._notifySessionProxyFailed(affectedSession, proxy.url);
        }
      }
      // Only update telemetry columns — do NOT touch isActive (user intent)
      if (proxy.id) {
        db.update(proxiesTable)
          .set({ latencyMs: null, lastCheckedAt: new Date(), updatedAt: new Date() })
          .where(eq(proxiesTable.id, proxy.id))
          .catch((err2: unknown) => logError("ProxyPool.checkProxy.dbUpdateFail", { id: proxy.id }, err2));
      }
    }
  }

  async runHealthChecks(): Promise<void> {
    const eligible = this.proxies.filter((p) => !p.userDisabled);
    if (eligible.length === 0) return;
    console.info(`[ProxyPool] Health check iniciado para ${eligible.length} proxy(s) habilitados...`);
    await Promise.allSettled(eligible.map((p) => this._checkProxy(p)));
    const status = this.getStatus();
    console.info(
      `[ProxyPool] Health check concluído: ${status.active}/${eligible.length} ativos, latência média: ${status.avgLatencyMs ?? "N/A"}ms`
    );
  }

  startHealthCheckJob(intervalMs: number = 5 * 60 * 1000): void {
    if (this.healthCheckInterval) return;
    const eligible = this.proxies.filter((p) => !p.userDisabled);
    if (eligible.length > 0) {
      this.runHealthChecks().catch((err: unknown) => {
        logError("ProxyPool.healthCheckJob.startup", {}, err);
      });
    }
    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks().catch((err: unknown) => {
        logError("ProxyPool.healthCheckJob", {}, err);
      });
    }, intervalMs);
    console.info(
      `[ProxyPool] Job de health check iniciado (intervalo: ${intervalMs / 1000}s)`
    );
  }

  stopHealthCheckJob(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }
}

export const proxyPoolManager = new ProxyPoolManager();
