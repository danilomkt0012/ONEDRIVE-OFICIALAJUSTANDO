export type WhatsAppProvider = "wasender" | "2chat";

interface CheckResult {
  exists: boolean | null;
  error?: string;
}

interface ProviderConfig {
  provider: WhatsAppProvider;
  apiKey: string;
  senderNumber?: string;
}

function getProviderConfig(): ProviderConfig | null {
  const wasenderKey = process.env.WASENDER_API_KEY;
  if (wasenderKey) {
    return { provider: "wasender", apiKey: wasenderKey };
  }

  const twoChatKey = process.env.TWO_CHAT_API_KEY;
  const twoChatSender = process.env.TWO_CHAT_SENDER_NUMBER;
  if (twoChatKey && twoChatSender) {
    return { provider: "2chat", apiKey: twoChatKey, senderNumber: twoChatSender };
  }

  return null;
}

async function checkViaWasender(phone: string, apiKey: string): Promise<CheckResult> {
  const cleanPhone = phone.replace(/\D/g, "");
  const url = `https://www.wasenderapi.com/api/on-whatsapp/${cleanPhone}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 429) {
      return { exists: null, error: "rate_limited" };
    }

    if (!response.ok) {
      return { exists: null, error: `http_${response.status}` };
    }

    const data = await response.json();

    if (typeof data?.data?.exists === "boolean") {
      return { exists: data.data.exists };
    }

    if (typeof data?.result?.exists === "boolean") {
      return { exists: data.result.exists };
    }

    if (typeof data?.exists === "boolean") {
      return { exists: data.exists };
    }

    if (typeof data?.on_whatsapp === "boolean") {
      return { exists: data.on_whatsapp };
    }

    if (typeof data?.data?.onWhatsapp === "boolean") {
      return { exists: data.data.onWhatsapp };
    }

    if (typeof data?.result?.onWhatsapp === "boolean") {
      return { exists: data.result.onWhatsapp };
    }

    return { exists: null, error: "unexpected_response" };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return { exists: null, error: "timeout" };
    }
    return { exists: null, error: err.message || "network_error" };
  }
}

async function checkVia2Chat(
  phone: string,
  apiKey: string,
  senderNumber: string
): Promise<CheckResult> {
  const cleanPhone = phone.replace(/\D/g, "");
  const senderClean = senderNumber.replace(/\D/g, "");
  const url = `https://api.p.2chat.io/open/whatsapp/check-number/+${senderClean}/+${cleanPhone}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 429) {
      return { exists: null, error: "rate_limited" };
    }

    if (!response.ok) {
      return { exists: null, error: `http_${response.status}` };
    }

    const data = await response.json();

    if (typeof data?.is_registered === "boolean") {
      return { exists: data.is_registered };
    }

    if (typeof data?.on_whatsapp === "boolean") {
      return { exists: data.on_whatsapp };
    }

    if (typeof data?.exists === "boolean") {
      return { exists: data.exists };
    }

    return { exists: null, error: "unexpected_response" };
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return { exists: null, error: "timeout" };
    }
    return { exists: null, error: err.message || "network_error" };
  }
}

export class WhatsAppChecker {
  private config: ProviderConfig | null = null;

  constructor() {
    this.config = getProviderConfig();
  }

  reload(): void {
    this.config = getProviderConfig();
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  getProviderName(): string {
    if (!this.config) return "nenhum";
    return this.config.provider === "wasender" ? "WasenderAPI" : "2Chat";
  }

  async testConnection(): Promise<boolean> {
    if (!this.config) {
      console.log("[WhatsAppChecker] Nenhuma API configurada. Configure WASENDER_API_KEY ou TWO_CHAT_API_KEY.");
      return false;
    }

    console.log(`[WhatsAppChecker] Testando conexão com ${this.getProviderName()}...`);

    const testPhone = "5511999999999";
    const result = await this.checkNumber(testPhone);

    if (result.error === "timeout" || result.error === "network_error") {
      console.log(`[WhatsAppChecker] ${this.getProviderName()} não acessível: ${result.error}`);
      return false;
    }

    if (result.error && result.error.startsWith("http_4")) {
      const code = result.error.replace("http_", "");
      if (code === "401" || code === "403") {
        console.log(`[WhatsAppChecker] ${this.getProviderName()} - chave API inválida (${code})`);
        return false;
      }
    }

    console.log(`[WhatsAppChecker] ${this.getProviderName()} conectado com sucesso`);
    return true;
  }

  async checkNumber(phone: string): Promise<CheckResult> {
    if (!this.config) {
      return { exists: null, error: "not_configured" };
    }

    switch (this.config.provider) {
      case "wasender":
        return checkViaWasender(phone, this.config.apiKey);
      case "2chat":
        return checkVia2Chat(phone, this.config.apiKey, this.config.senderNumber!);
      default:
        return { exists: null, error: "unknown_provider" };
    }
  }
}

export const whatsappChecker = new WhatsAppChecker();
