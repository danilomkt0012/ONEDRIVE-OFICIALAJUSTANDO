import { cswTracker } from './CSWTracker';
import { metaAPI } from '../../meta/metaAPI';
import { db } from '../../db';
import { campaigns as campaignsSchema, apiConfigurations as apiConfigsSchema } from '@shared/schema';
import { eq } from 'drizzle-orm';
import { logError } from '../../utils/logger';

export interface ConversionConfig {
  campaignId: string;
  conversionMessage: string;
  conversionLink: string;
  delayMs: number;
}

interface PendingConversion {
  phone: string;
  phoneNumberId: string;
  config: ConversionConfig;
  scheduledAt: number;
  timer: NodeJS.Timeout;
}

class ConversionTriggerService {
  private pendingConversions: Map<string, PendingConversion> = new Map();
  private campaignConfigs: Map<string, ConversionConfig> = new Map();
  private conversionCounts: Map<string, number> = new Map();

  registerCampaignConfig(config: ConversionConfig): void {
    this.campaignConfigs.set(config.campaignId, config);
    db.select().from(campaignsSchema).where(eq(campaignsSchema.id, config.campaignId)).then(([campaign]) => {
      if (campaign && campaign.conversionsSent && campaign.conversionsSent > 0) {
        this.conversionCounts.set(config.campaignId, campaign.conversionsSent);
      }
    }).catch(err => logError('ConversionTriggerService.loadInitialCount', { campaignId: config.campaignId }, err));
    console.log(`🔗 Conversão configurada para campanha ${config.campaignId}: delay=${config.delayMs}ms`);
  }

  removeCampaignConfig(campaignId: string): void {
    this.campaignConfigs.delete(campaignId);
    for (const [key, pending] of this.pendingConversions) {
      if (pending.config.campaignId === campaignId) {
        clearTimeout(pending.timer);
        this.pendingConversions.delete(key);
      }
    }
  }

  async onInboundMessage(phone: string, phoneNumberId: string, campaignId: string | null): Promise<void> {
    if (!campaignId) return;

    const config = this.campaignConfigs.get(campaignId);
    if (!config || !config.conversionMessage) return;

    const alreadySent = await cswTracker.hasConversionBeenSent(phone);
    if (alreadySent) {
      console.log(`⏭️ Conversão já enviada para ${phone}, ignorando`);
      return;
    }

    const key = `${phone}:${campaignId}`;
    if (this.pendingConversions.has(key)) {
      console.log(`⏭️ Conversão já agendada para ${phone}`);
      return;
    }

    const delayMs = config.delayMs || 0;

    console.log(`⏰ Agendando conversão para ${phone} em ${delayMs}ms`);

    const timer = setTimeout(() => {
      this.executeConversion(phone, phoneNumberId, config);
      this.pendingConversions.delete(key);
    }, delayMs);

    this.pendingConversions.set(key, {
      phone,
      phoneNumberId,
      config,
      scheduledAt: Date.now(),
      timer,
    });
  }

  private async executeConversion(phone: string, phoneNumberId: string, config: ConversionConfig): Promise<void> {
    const isOpen = await cswTracker.isCSWOpen(phone);
    if (!isOpen) {
      console.log(`❌ CSW fechada para ${phone}, conversão cancelada`);
      return;
    }

    const alreadySent = await cswTracker.hasConversionBeenSent(phone);
    if (alreadySent) {
      console.log(`⏭️ Conversão já enviada para ${phone}`);
      return;
    }

    try {
      let messageText = config.conversionMessage;
      if (config.conversionLink) {
        messageText += `\n\n${config.conversionLink}`;
      }

      const [campaign] = await db.select().from(campaignsSchema).where(eq(campaignsSchema.id, config.campaignId));
      const userId = campaign?.userId;
      if (!userId) {
        console.error(`❌ Campanha ${config.campaignId} não encontrada para conversão`);
        return;
      }
      const [apiConfig] = await db.select().from(apiConfigsSchema).where(eq(apiConfigsSchema.userId, userId));
      if (!apiConfig) {
        console.error(`❌ Configuração API não encontrada para enviar conversão`);
        return;
      }

      await metaAPI.sendFreeFormMessage(
        phoneNumberId,
        phone,
        messageText,
        apiConfig.metaToken
      );

      await cswTracker.markConversionSent(phone);
      const count = (this.conversionCounts.get(config.campaignId) || 0) + 1;
      this.conversionCounts.set(config.campaignId, count);

      try {
        await db.update(campaignsSchema).set({
          conversionsSent: count,
        }).where(eq(campaignsSchema.id, config.campaignId));
      } catch (e: any) {
        logError('ConversionTriggerService.updateConversionCount', {}, e);
      }

      console.log(`✅ Conversão enviada para ${phone} (campanha ${config.campaignId}, total: ${count})`);
    } catch (error: any) {
      logError("conversionTrigger.sendConversion", {}, error);
    }
  }

  getConversionCount(campaignId: string): number {
    return this.conversionCounts.get(campaignId) || 0;
  }

  getPendingCount(): number {
    return this.pendingConversions.size;
  }

  getStats(): { pendingConversions: number; campaignCounts: Record<string, number> } {
    const campaignCounts: Record<string, number> = {};
    for (const [id, count] of this.conversionCounts) {
      campaignCounts[id] = count;
    }
    return {
      pendingConversions: this.pendingConversions.size,
      campaignCounts,
    };
  }

  destroy(): void {
    for (const pending of this.pendingConversions.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingConversions.clear();
  }
}

export const conversionTriggerService = new ConversionTriggerService();
