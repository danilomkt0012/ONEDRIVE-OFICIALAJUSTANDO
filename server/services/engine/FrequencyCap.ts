import { pool } from '../../db';
import { logError } from '../../utils/logger';

interface FrequencyCapConfig {
  maxMessagesPerRecipient24h: number;
  windowMs: number;
}

const DEFAULT_CONFIG: FrequencyCapConfig = {
  maxMessagesPerRecipient24h: 2,
  windowMs: 24 * 60 * 60 * 1000,
};

export interface FrequencyCapResult {
  allowed: boolean;
  sentCount: number;
  reason?: string;
}

export class FrequencyCap {
  private config: FrequencyCapConfig;

  constructor(config?: Partial<FrequencyCapConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async checkRecipient(phone: string): Promise<FrequencyCapResult> {
    try {
      const cutoff = new Date(Date.now() - this.config.windowMs);
      const normalizedPhone = phone.replace(/\D/g, '');

      const result = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM message_deliveries
         WHERE (phone_number = $1 OR phone_number = $2)
           AND status IN ('sent', 'delivered', 'read')
           AND sent_at >= $3`,
        [phone, normalizedPhone, cutoff]
      );

      const sentCount = result.rows[0]?.cnt ?? 0;

      if (sentCount >= this.config.maxMessagesPerRecipient24h) {
        return {
          allowed: false,
          sentCount,
          reason: `frequency_cap: recipient received ${sentCount} messages in last 24h (limit: ${this.config.maxMessagesPerRecipient24h})`,
        };
      }

      return { allowed: true, sentCount };
    } catch (err) {
      logError('FrequencyCap.checkRecipient', { phone }, err);
      return { allowed: true, sentCount: 0 };
    }
  }

  updateConfig(config: Partial<FrequencyCapConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): FrequencyCapConfig {
    return { ...this.config };
  }
}

export const frequencyCap = new FrequencyCap();
