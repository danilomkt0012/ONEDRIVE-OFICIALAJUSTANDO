import path from "path";
import fsp from "fs/promises";
import fs from "fs";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type ConnectionState,
  type GroupParticipant,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { HttpsProxyAgent } from "https-proxy-agent";
import { logError } from "../../utils/logger";
import { proxyPoolManager, maskProxyUrl, ProxyUnavailableError } from "../proxyPool/ProxyPoolManager";

const SESSIONS_DIR = path.resolve("data/whatsapp-sessions");

export type SessionStatus = "idle" | "waiting_qr" | "connected" | "disconnected" | "error";

export class WaExtractorUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaExtractorUserError";
  }
}

interface SessionEntry {
  userId: string;
  generation: number;
  status: SessionStatus;
  qrCode: string | null;
  phoneNumber: string | null;
  error: string | null;
  socket: WASocket | null;
  saveCreds: (() => Promise<void>) | null;
}

interface BoomLike {
  output?: { statusCode?: number };
}

function isBoomLike(err: unknown): err is BoomLike {
  return typeof err === "object" && err !== null && "output" in err;
}

interface ILogger {
  level: string;
  child(obj: Record<string, unknown>): ILogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

class SilentLogger implements ILogger {
  level = "silent";
  child(_obj: Record<string, unknown>): ILogger { return this; }
  trace(_obj: unknown, _msg?: string): void { /* silent */ }
  debug(_obj: unknown, _msg?: string): void { /* silent */ }
  info(_obj: unknown, _msg?: string): void { /* silent */ }
  warn(_obj: unknown, _msg?: string): void { /* silent */ }
  error(_obj: unknown, _msg?: string): void { /* silent */ }
}

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

function _isExtractorProxyConnectionError(msg: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("tunnel") ||
    lower.includes("proxy") ||
    lower.includes("407") ||
    lower.includes("socket hang up")
  );
}

class WhatsAppExtractorService {
  private sessions: Map<string, SessionEntry> = new Map();

  constructor() {
    proxyPoolManager.onSessionProxyFailed((sessionId, _proxyUrl) => {
      this._handleSessionProxyFailed(sessionId);
    });
  }

  private sessionPath(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(SESSIONS_DIR, safe);
  }

  async startSession(userId: string): Promise<{ status: SessionStatus; qrCode?: string; phoneNumber?: string }> {
    const existing = this.sessions.get(userId);
    if (existing?.status === "connected") {
      return {
        status: "connected",
        phoneNumber: existing.phoneNumber ?? undefined,
      };
    }

    if (proxyPoolManager.size > 0) {
      const hasAvailableProxy = proxyPoolManager.getAll().some(
        (p) => p.active && (p.assignedSessionId === null || p.assignedSessionId === userId)
      );
      if (!hasAvailableProxy) {
        throw new ProxyUnavailableError(
          "Nenhum proxy disponível no pool para iniciar sessão WhatsApp. Aguarde um proxy ficar disponível ou adicione mais proxies em PROXY_POOL."
        );
      }
    }

    if (existing?.socket) {
      try { existing.socket.end(undefined); } catch { /* ignore */ }
    }

    const nextGeneration = (existing?.generation ?? 0) + 1;
    const entry: SessionEntry = {
      userId,
      generation: nextGeneration,
      status: "waiting_qr",
      qrCode: null,
      phoneNumber: null,
      error: null,
      socket: null,
      saveCreds: null,
    };
    this.sessions.set(userId, entry);

    this._initBaileys(userId, entry, nextGeneration).catch((err: unknown) => {
      logError("WhatsAppExtractorService.initBaileys", { userId }, err);
      if (this._isActiveGeneration(userId, nextGeneration)) {
        entry.status = "error";
        entry.error = err instanceof Error ? err.message : "Erro ao iniciar sessão";
      }
    });

    return { status: "waiting_qr" };
  }

  private _isActiveGeneration(userId: string, generation: number): boolean {
    return this.sessions.get(userId)?.generation === generation;
  }

  private _handleSessionProxyFailed(userId: string): void {
    const entry = this.sessions.get(userId);
    if (!entry) return;

    const currentGen = entry.generation;
    if (this.sessions.get(userId)?.generation !== currentGen) return;

    const poolHasAnotherProxy =
      proxyPoolManager.getAll().some((p) => p.active && p.assignedSessionId === null);

    if (!poolHasAnotherProxy) {
      console.warn(
        `[WhatsAppExtractor] Proxy da sessão userId=${userId} falhou e não há substituto disponível — marcando como erro`
      );
      entry.generation += 1;
      entry.status = "error";
      entry.error =
        "Proxy da sessão ficou inativo e não há proxies disponíveis para substituição. Adicione mais proxies em PROXY_POOL.";
      if (entry.socket) {
        try { entry.socket.end(undefined); } catch { /* ignore */ }
        entry.socket = null;
      }
      return;
    }

    const nextGeneration = currentGen + 1;
    entry.generation = nextGeneration;

    console.warn(
      `[WhatsAppExtractor] Proxy da sessão userId=${userId} falhou — iniciando reconexão com novo proxy (gen=${nextGeneration})`
    );
    entry.status = "waiting_qr";
    entry.qrCode = null;
    if (entry.socket) {
      try { entry.socket.end(undefined); } catch { /* ignore */ }
      entry.socket = null;
    }

    setTimeout(() => {
      if (entry.generation !== nextGeneration) return;
      this._initBaileys(userId, entry, nextGeneration).catch((err: unknown) => {
        if (entry.generation === nextGeneration) {
          logError("WhatsAppExtractorService.proxyFailoverReconnect", { userId }, err);
          entry.status = "error";
          entry.error = err instanceof Error ? err.message : "Erro ao reconectar após falha de proxy";
          proxyPoolManager.releaseSessionProxy(userId);
        }
      });
    }, 1000);
  }

  private async _initBaileys(userId: string, entry: SessionEntry, generation: number): Promise<void> {
    const sessionDir = this.sessionPath(userId);
    await fsp.mkdir(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    if (!this._isActiveGeneration(userId, generation)) return;

    entry.saveCreds = saveCreds;

    let agent: HttpsProxyAgent<string> | undefined;
    if (proxyPoolManager.size > 0) {
      const proxyAgent = proxyPoolManager.buildAgentForSession(userId);
      if (!proxyAgent) {
        throw new ProxyUnavailableError(
          "Nenhum proxy disponível no pool para iniciar sessão WhatsApp. Aguarde um proxy ficar disponível ou adicione mais proxies em PROXY_POOL."
        );
      }
      agent = proxyAgent;
      const assigned = proxyPoolManager.getAll().find((p) => p.assignedSessionId === userId);
      console.info(`[WhatsAppExtractor] Proxy do pool atribuído para userId=${userId}: ${assigned ? maskProxyUrl(assigned.url) : "desconhecido"}`);
    } else {
      const proxyUrl = process.env.WHATSAPP_PROXY_URL;
      if (proxyUrl) {
        try {
          new URL(proxyUrl);
          agent = new HttpsProxyAgent(proxyUrl);
          console.info(`[WhatsAppExtractor] Proxy legado (WHATSAPP_PROXY_URL) ativo para userId=${userId}`);
        } catch {
          console.warn(`[WhatsAppExtractor] WHATSAPP_PROXY_URL inválida — conectando sem proxy.`);
        }
      }
    }

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ["WhatsApp Extractor", "Chrome", "1.0"] as [string, string, string],
      logger: new SilentLogger() as Parameters<typeof makeWASocket>[0]["logger"],
      ...(agent ? { agent } : {}),
    });

    if (!this._isActiveGeneration(userId, generation)) {
      try { sock.end(undefined); } catch { /* ignore */ }
      return;
    }

    entry.socket = sock;

    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      if (!this._isActiveGeneration(userId, generation)) return;

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          entry.qrCode = await QRCode.toDataURL(qr);
          entry.status = "waiting_qr";
        } catch (err: unknown) {
          logError("WhatsAppExtractorService.qrGenerate", { userId }, err);
        }
      }

      if (connection === "open") {
        entry.status = "connected";
        entry.qrCode = null;
        const rawId: string = sock.user?.id ?? "";
        entry.phoneNumber = rawId.split(":")[0] || rawId || null;
      }

      if (connection === "close") {
        const boomErr: unknown = lastDisconnect?.error;
        const statusCode: number | undefined = isBoomLike(boomErr)
          ? boomErr.output?.statusCode
          : undefined;
        const errMsg: string = boomErr instanceof Error ? boomErr.message : "";

        if (proxyPoolManager.size > 0 && _isExtractorProxyConnectionError(errMsg)) {
          const assignedProxy = proxyPoolManager.getAll().find((p) => p.assignedSessionId === userId);
          if (assignedProxy) {
            console.warn(
              `[WhatsAppExtractor] Erro de proxy detectado na sessão userId=${userId}: ${errMsg} — marcando proxy como inativo`
            );
            proxyPoolManager.markProxyFailed(assignedProxy.url, errMsg);
          }
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && this._isActiveGeneration(userId, generation)) {
          entry.status = "waiting_qr";
          entry.qrCode = null;
          setTimeout(() => {
            if (!this._isActiveGeneration(userId, generation)) return;
            this._initBaileys(userId, entry, generation).catch((err: unknown) => {
              if (this._isActiveGeneration(userId, generation)) {
                logError("WhatsAppExtractorService.reconnect", { userId }, err);
                entry.status = "error";
                entry.error = err instanceof Error ? err.message : "Erro ao reconectar";
                proxyPoolManager.releaseSessionProxy(userId);
              }
            });
          }, 3000);
        } else if (this._isActiveGeneration(userId, generation)) {
          entry.status = "disconnected";
          proxyPoolManager.releaseSessionProxy(userId);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
  }

  getQrCode(userId: string): { status: SessionStatus; qrCode?: string; phoneNumber?: string; proxyUrl?: string } {
    const entry = this.sessions.get(userId);
    if (!entry) return { status: "idle" };
    const assignedProxy = proxyPoolManager.getAll().find((p) => p.assignedSessionId === userId);
    return {
      status: entry.status,
      qrCode: entry.qrCode ?? undefined,
      phoneNumber: entry.phoneNumber ?? undefined,
      proxyUrl: assignedProxy ? maskProxyUrl(assignedProxy.url) : undefined,
    };
  }

  hasCredentialsOnDisk(userId: string): boolean {
    const credsPath = path.join(this.sessionPath(userId), "creds.json");
    return fs.existsSync(credsPath);
  }

  async disconnect(userId: string): Promise<void> {
    const entry = this.sessions.get(userId);

    if (entry) {
      entry.generation += 1;

      try {
        if (entry.socket) {
          entry.socket.end(undefined);
          entry.socket = null;
        }
      } catch (err: unknown) {
        logError("WhatsAppExtractorService.disconnect", { userId }, err);
      }
      entry.status = "disconnected";
      entry.qrCode = null;
      proxyPoolManager.releaseSessionProxy(userId);
      this.sessions.delete(userId);
    }

    try {
      const sessionDir = this.sessionPath(userId);
      await fsp.rm(sessionDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }

  async extractParticipants(userId: string, inviteLink: string): Promise<string[]> {
    const entry = this.sessions.get(userId);
    if (!entry || entry.status !== "connected" || !entry.socket) {
      throw new WaExtractorUserError("Sessão WhatsApp não conectada. Escaneie o QR code primeiro.");
    }

    const match = inviteLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
    if (!match) {
      throw new WaExtractorUserError("Link de convite inválido. Use o formato: https://chat.whatsapp.com/CODIGO");
    }
    const inviteCode = match[1];
    const sock = entry.socket;

    let participants: GroupParticipant[];
    try {
      const metadata = await sock.groupGetInviteInfo(inviteCode);
      participants = metadata.participants ?? [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const isUserFacing =
        msg.includes("invalid") ||
        msg.includes("not-authorized") ||
        msg.includes("forbidden") ||
        msg.includes("gone") ||
        msg.includes("item-not-found") ||
        msg.includes("not found") ||
        msg.includes("expired") ||
        msg.includes("bad request");
      if (isUserFacing) {
        throw new WaExtractorUserError(
          "Link inválido, expirado ou sem permissão de acesso ao grupo."
        );
      }
      const raw = err instanceof Error ? err.message : "erro desconhecido";
      throw new Error(`Não foi possível obter participantes do grupo: ${raw}`);
    }

    return [
      ...new Set(
        participants
          .map((p: GroupParticipant) => (p.id ?? "").replace(/@.*$/, "").replace(/[^0-9]/g, ""))
          .filter((n: string) => n.length >= 8)
      ),
    ];
  }
}

export const whatsAppExtractorService = new WhatsAppExtractorService();
