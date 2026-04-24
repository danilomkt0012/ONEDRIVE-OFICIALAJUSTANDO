import { pool } from '../../db';
import { logError, logWarn } from '../../utils/logger';

interface PortfolioControlConfig {
  dailyLimitPerPortfolio: number;
  slowdownThresholds: { percent: number; reductionPercent: number }[];
  windowMs: number;
}

const DEFAULT_CONFIG: PortfolioControlConfig = {
  dailyLimitPerPortfolio: 100000,
  slowdownThresholds: [
    { percent: 60, reductionPercent: 20 },
    { percent: 80, reductionPercent: 40 },
    { percent: 90, reductionPercent: 60 },
  ],
  windowMs: 24 * 60 * 60 * 1000,
};

export interface PortfolioStatus {
  totalSent: number;
  limit: number;
  usagePercent: number;
  slowdownPercent: number;
  blocked: boolean;
}

export class PortfolioControl {
  private config: PortfolioControlConfig;
  private cachedStatus: Map<string, { status: PortfolioStatus; cachedAt: number }> = new Map();
  private cacheTtlMs: number = 30000;

  constructor(config?: Partial<PortfolioControlConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async getPortfolioStatus(bmId: string): Promise<PortfolioStatus> {
    const cached = this.cachedStatus.get(bmId);
    if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
      return cached.status;
    }

    try {
      const cutoff = new Date(Date.now() - this.config.windowMs);

      const result = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM message_deliveries md
         JOIN campaigns c ON c.id = md.campaign_id
         LEFT JOIN wabas w ON w.waba_id = c.waba_id
         WHERE (w.bm_id = $1 OR c.waba_id IN (
           SELECT waba_id FROM wabas WHERE bm_id = $1
         ))
           AND md.status IN ('sent', 'delivered', 'read')
           AND md.sent_at >= $2`,
        [bmId, cutoff]
      );

      const totalSent = result.rows[0]?.cnt ?? 0;
      const usagePercent = (totalSent / this.config.dailyLimitPerPortfolio) * 100;

      let slowdownPercent = 0;
      for (const threshold of this.config.slowdownThresholds) {
        if (usagePercent >= threshold.percent) {
          slowdownPercent = threshold.reductionPercent;
        }
      }

      const status: PortfolioStatus = {
        totalSent,
        limit: this.config.dailyLimitPerPortfolio,
        usagePercent: Math.round(usagePercent * 100) / 100,
        slowdownPercent,
        blocked: usagePercent >= 100,
      };

      this.cachedStatus.set(bmId, { status, cachedAt: Date.now() });

      if (slowdownPercent > 0) {
        logWarn('PortfolioControl.slowdown', { bmId, usagePercent: status.usagePercent, slowdownPercent }, `Portfolio approaching limit`);
      }

      return status;
    } catch (err) {
      logError('PortfolioControl.getPortfolioStatus', { bmId }, err);
      return {
        totalSent: 0,
        limit: this.config.dailyLimitPerPortfolio,
        usagePercent: 0,
        slowdownPercent: 0,
        blocked: false,
      };
    }
  }

  getSpeedMultiplier(status: PortfolioStatus): number {
    if (status.blocked) return 0;
    return 1 - (status.slowdownPercent / 100);
  }

  updateConfig(config: Partial<PortfolioControlConfig>): void {
    this.config = { ...this.config, ...config };
    this.cachedStatus.clear();
  }

  clearCache(): void {
    this.cachedStatus.clear();
  }
}

export const portfolioControl = new PortfolioControl();
