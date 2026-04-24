import { storage } from '../../storage';
import { logError } from '../../utils/logger';

const CSW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CSWSession {
  phone: string;
  campaignId: string | null;
  phoneNumberId: string | null;
  lastInboundAt: number;
  windowExpiresAt: number;
  conversionSent: boolean;
  conversionSentAt: number | null;
}

class CSWTracker {
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      storage.cleanupExpiredCSWSessions().catch((err: any) => {
        logError('CSW cleanup error:', {}, err);
      });
    }, 60_000);
  }

  async registerInbound(phone: string, campaignId: string | null, phoneNumberId: string | null): Promise<CSWSession> {
    const dbSession = await storage.upsertCSWSession(phone, campaignId, phoneNumberId);

    const session: CSWSession = {
      phone,
      campaignId: dbSession.campaignId,
      phoneNumberId: dbSession.phoneNumberId,
      lastInboundAt: new Date(dbSession.lastInboundAt).getTime(),
      windowExpiresAt: new Date(dbSession.windowExpiresAt).getTime(),
      conversionSent: dbSession.conversionSent,
      conversionSentAt: dbSession.conversionSentAt ? new Date(dbSession.conversionSentAt).getTime() : null,
    };

    console.log(`📩 CSW aberta: ${phone} (expira em 24h)`);
    return session;
  }

  async isCSWOpen(phone: string): Promise<boolean> {
    const session = await storage.getCSWSession(phone);
    return session !== null;
  }

  async getSession(phone: string): Promise<CSWSession | null> {
    const dbSession = await storage.getCSWSession(phone);
    if (!dbSession) return null;

    return {
      phone: dbSession.phone,
      campaignId: dbSession.campaignId,
      phoneNumberId: dbSession.phoneNumberId,
      lastInboundAt: new Date(dbSession.lastInboundAt).getTime(),
      windowExpiresAt: new Date(dbSession.windowExpiresAt).getTime(),
      conversionSent: dbSession.conversionSent,
      conversionSentAt: dbSession.conversionSentAt ? new Date(dbSession.conversionSentAt).getTime() : null,
    };
  }

  async markConversionSent(phone: string): Promise<void> {
    await storage.markCSWConversionSent(phone);
  }

  async hasConversionBeenSent(phone: string): Promise<boolean> {
    const session = await storage.getCSWSession(phone);
    return session?.conversionSent ?? false;
  }

  async getOpenSessionsForCampaign(campaignId: string): Promise<CSWSession[]> {
    const dbSessions = await storage.getOpenCSWSessionsForCampaign(campaignId);
    return dbSessions.map((s: any) => ({
      phone: s.phone,
      campaignId: s.campaignId,
      phoneNumberId: s.phoneNumberId,
      lastInboundAt: new Date(s.lastInboundAt).getTime(),
      windowExpiresAt: new Date(s.windowExpiresAt).getTime(),
      conversionSent: s.conversionSent,
      conversionSentAt: s.conversionSentAt ? new Date(s.conversionSentAt).getTime() : null,
    }));
  }

  getStats(): { totalOpen: number; totalConversionsSent: number } {
    return { totalOpen: 0, totalConversionsSent: 0 };
  }

  async getStatsAsync(): Promise<{ totalOpen: number; totalConversionsSent: number }> {
    return { totalOpen: 0, totalConversionsSent: 0 };
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export const cswTracker = new CSWTracker();
