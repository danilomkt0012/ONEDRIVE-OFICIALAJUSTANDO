import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logError } from '../utils/logger';

const __dirname_signedUrl = path.dirname(fileURLToPath(import.meta.url));

let SIGNED_URL_SECRET: string = "";
let _initialized = false;

const DEFAULT_EXPIRY_MS = 2 * 60 * 60 * 1000;

export async function initSignedUrlSecret(): Promise<void> {
  if (process.env.SIGNED_URL_SECRET) {
    SIGNED_URL_SECRET = process.env.SIGNED_URL_SECRET;
    console.log('[SignedUrl] Usando SIGNED_URL_SECRET do ambiente.');
    _initialized = true;
    return;
  }

  try {
    const { pool } = await import('../db');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const generated = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO system_config (key, value) VALUES ('signed_url_secret', $1) ON CONFLICT (key) DO NOTHING",
      [generated]
    );
    const result = await pool.query(
      "SELECT value FROM system_config WHERE key = 'signed_url_secret'"
    );

    if (result.rows.length > 0) {
      const isNew = result.rows[0].value === generated;
      SIGNED_URL_SECRET = result.rows[0].value;
      if (isNew) {
        console.log('[SignedUrl] Secret gerado e persistido no banco de dados — tokens sobreviverão a restarts.');
      } else {
        console.log('[SignedUrl] Secret carregado do banco de dados — tokens sobreviverão a restarts.');
      }
    } else {
      throw new Error('Falha ao persistir ou carregar signed_url_secret do banco de dados.');
    }
  } catch (dbErr) {
    if (process.env.SESSION_SECRET) {
      SIGNED_URL_SECRET = process.env.SESSION_SECRET;
      console.warn('[SignedUrl] AVISO: Falha ao acessar banco para secret; usando SESSION_SECRET. Tokens serão inválidos após mudança de SESSION_SECRET.');
    } else {
      SIGNED_URL_SECRET = crypto.randomBytes(32).toString("hex");
      console.error('[SignedUrl] ERRO CRÍTICO: Nenhuma chave estável disponível — usando chave aleatória. Tokens de mídia serão invalidados a cada restart do servidor. Configure SIGNED_URL_SECRET no painel Secrets.');
    }
  }

  _initialized = true;
}

function requireSecret(): string {
  if (!_initialized || !SIGNED_URL_SECRET) {
    throw new Error('[SignedUrl] Secret não inicializado. Chame initSignedUrlSecret() no boot do servidor.');
  }
  return SIGNED_URL_SECRET;
}

export function generateSignedToken(filePath: string, expiryMs: number = DEFAULT_EXPIRY_MS): string {
  const secret = requireSecret();
  const expires = Date.now() + expiryMs;
  const payload = `${filePath}:${expires}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const token = Buffer.from(JSON.stringify({ p: filePath, e: expires, s: signature })).toString("base64url");
  return token;
}

export function verifySignedToken(token: string): { valid: boolean; filePath?: string } {
  try {
    const secret = requireSecret();
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
    const { p: filePath, e: expires, s: signature } = decoded;
    if (!filePath || !expires || !signature) return { valid: false };
    if (Date.now() > expires) return { valid: false };
    const expectedSig = crypto.createHmac("sha256", secret).update(`${filePath}:${expires}`).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return { valid: false };
    return { valid: true, filePath };
  } catch (e: any) {
    logError('[signedUrl] Token validation failed', {}, new Error('[signedUrl] Token validation failed'));
    return { valid: false };
  }
}

export function generateSignedImageUrl(publicDomain: string, campaignId: string, phone: string, expiryMs?: number): string {
  const safePhone = phone.replace(/\D/g, "");
  const filePath = `campaign-images/${campaignId}/${safePhone}.jpg`;
  const token = generateSignedToken(filePath, expiryMs);
  return `${publicDomain}/api/signed-media/${token}`;
}

/**
 * Validates that a signed URL:
 *   1. Contains a verifiable, non-expired HMAC token
 *   2. Is reachable via an HTTP HEAD request within `timeoutMs` (default 5 s)
 *
 * Used by the bot image-send pipeline as a pre-send sanity check so that
 * unreachable or expired fallback URLs are detected before being forwarded to
 * Meta's WhatsApp API — which would silently fail message delivery.
 *
 * @returns An object with `ok: true` when the URL passes both checks, or
 *          `ok: false` plus a `reason` string describing the specific failure.
 */
export async function validateSignedUrlAccessibility(
  url: string,
  _timeoutMs = 5000
): Promise<{ ok: boolean; reason?: string }> {
  // 1. Extract and verify the token from the URL
  const tokenMatch = url.match(/\/api\/signed-media\/([^/?#]+)/);
  if (!tokenMatch) {
    return { ok: false, reason: 'URL does not contain a signed-media token path segment' };
  }

  const tokenVerification = verifySignedToken(tokenMatch[1]);
  if (!tokenVerification.valid) {
    return { ok: false, reason: 'Signed URL token is invalid or expired — regenerate before sending' };
  }

  // 2. Verify the local file exists via fs.access — avoids SSRF / self-routing failures
  //    inside the container. The file path was already validated by verifySignedToken above.
  //    Resolve to the same absolute path used by /api/signed-media/:token handler:
  //    path.resolve(<server_dir>, "../uploads", filePath)
  const uploadsRoot = path.resolve(__dirname_signedUrl, "../../uploads");
  const absoluteFilePath = path.resolve(uploadsRoot, tokenVerification.filePath!);
  if (!absoluteFilePath.startsWith(uploadsRoot)) {
    return { ok: false, reason: 'Resolved file path escapes uploads directory — token may be tampered' };
  }
  try {
    await fs.promises.access(absoluteFilePath, fs.constants.R_OK);
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `Local file not accessible at path "${absoluteFilePath}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
