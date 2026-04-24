/**
 * ============================================================================
 * DETECÇÃO AUTOMÁTICA DE TIER
 * ============================================================================
 * 
 * Detecta o tier do número via API Meta e ajusta parâmetros automaticamente.
 * Não depende do usuário selecionar o tier manualmente.
 * 
 * Tiers oficiais Meta (desde outubro 2025, volume por Business Portfolio):
 * - TIER_250: 250 msgs/24h (Tier 0)
 * - TIER_1K: 1000 msgs/24h (Tier 1)
 * - TIER_10K: 10000 msgs/24h (Tier 2)
 * - TIER_100K: 100000 msgs/24h (Tier 3)
 * - TIER_UNLIMITED: sem limite (Tier 4)
 * 
 * Throughput: 80 msg/s padrao por numero (ate 1000 msg/s no Unlimited)
 */

import { logError } from '../../utils/logger';
import { pool } from '../../db';

export type MessagingTier = 
  | 'TIER_NOT_SET'
  | 'TIER_250'
  | 'TIER_1K'
  | 'TIER_10K'
  | 'TIER_100K'
  | 'TIER_UNLIMITED';

export interface TierLimits {
  maxMessagesPerDay: number;
  maxMessagesPerHour: number;
  recommendedRefillRate: number;
  recommendedConcurrentRequests: number;
  recommendedBurstMultiplier: number;
  safetyMargin: number;
}

export interface PhoneNumberStatus {
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string;
  messagingLimitTier?: MessagingTier;
  isOfficialBusinessAccount: boolean;
  currentThroughput?: {
    sent24h: number;
    remaining24h: number;
  };
}

export interface TierDetectionConfig {
  accessToken: string;
  defaultTier: MessagingTier;
  applyAutomaticLimits: boolean;
}

const TIER_LIMITS: Record<MessagingTier, TierLimits> = {
  'TIER_NOT_SET': {
    maxMessagesPerDay: 250,
    maxMessagesPerHour: 50,
    recommendedRefillRate: 5,
    recommendedConcurrentRequests: 2,
    recommendedBurstMultiplier: 1.2,
    safetyMargin: 0.80
  },
  'TIER_250': {
    maxMessagesPerDay: 250,
    maxMessagesPerHour: 100,
    recommendedRefillRate: 10,
    recommendedConcurrentRequests: 3,
    recommendedBurstMultiplier: 1.5,
    safetyMargin: 0.85
  },
  'TIER_1K': {
    maxMessagesPerDay: 1000,
    maxMessagesPerHour: 500,
    recommendedRefillRate: 20,
    recommendedConcurrentRequests: 5,
    recommendedBurstMultiplier: 2.0,
    safetyMargin: 0.90
  },
  'TIER_10K': {
    maxMessagesPerDay: 10000,
    maxMessagesPerHour: 2000,
    recommendedRefillRate: 35,
    recommendedConcurrentRequests: 8,
    recommendedBurstMultiplier: 2.0,
    safetyMargin: 0.92
  },
  'TIER_100K': {
    maxMessagesPerDay: 100000,
    maxMessagesPerHour: 10000,
    recommendedRefillRate: 50,
    recommendedConcurrentRequests: 10,
    recommendedBurstMultiplier: 2.5,
    safetyMargin: 0.95
  },
  'TIER_UNLIMITED': {
    maxMessagesPerDay: 1000000,
    maxMessagesPerHour: 100000,
    recommendedRefillRate: 50,
    recommendedConcurrentRequests: 10,
    recommendedBurstMultiplier: 2.5,
    safetyMargin: 0.95
  }
};

export class TierDetection {
  private config: TierDetectionConfig;
  private cachedStatus: Map<string, PhoneNumberStatus> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private cacheTTLMs: number = 300000;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TierDetectionConfig) {
    this.config = config;
    this.pruneTimer = setInterval(() => this.pruneExpired(), this.cacheTTLMs);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  /**
   * Detecta tier do número via API
   */
  async detectTier(phoneNumberId: string): Promise<PhoneNumberStatus | null> {
    const cached = this.getCached(phoneNumberId);
    if (cached) return cached;
    
    try {
      const response = await fetch(
        `https://graph.facebook.com/${process.env.META_API_VERSION || process.env.API_VERSION || 'v25.0'}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_score,quality_rating,messaging_limit_tier,is_official_business_account`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      if (!response.ok) {
        console.warn(`[TierDetection] Erro ao buscar status: ${response.status}`);
        return this.getDefaultStatus(phoneNumberId);
      }
      
      const data = await response.json() as any;
      
      const status: PhoneNumberStatus = {
        phoneNumberId,
        displayPhoneNumber: data.display_phone_number || '',
        verifiedName: data.verified_name || '',
        qualityRating: data.quality_rating || 'UNKNOWN',
        messagingLimitTier: this.parseTier(data.messaging_limit_tier),
        isOfficialBusinessAccount: data.is_official_business_account || false
      };
      
      this.setCache(phoneNumberId, status);
      
      console.log(`\n📊 TierDetection para ${phoneNumberId}:`);
      console.log(`   📱 Número: ${status.displayPhoneNumber}`);
      console.log(`   ✅ Tier: ${status.messagingLimitTier}`);
      console.log(`   ⭐ Qualidade: ${status.qualityRating}`);
      
      return status;
    } catch (error: any) {
      logError('TierDetection.detectTier', {}, error);
      return this.getDefaultStatus(phoneNumberId);
    }
  }

  /**
   * Parseia tier da API
   */
  private parseTier(tier: string | undefined): MessagingTier {
    if (!tier) return this.config.defaultTier;
    
    const tierMap: Record<string, MessagingTier> = {
      'TIER_NOT_SET': 'TIER_NOT_SET',
      'TIER_50': 'TIER_250',
      'TIER_250': 'TIER_250',
      'TIER_1K': 'TIER_1K',
      'TIER_2K': 'TIER_1K',
      'TIER_10K': 'TIER_10K',
      'TIER_100K': 'TIER_100K',
      'UNLIMITED': 'TIER_UNLIMITED',
      'TIER_UNLIMITED': 'TIER_UNLIMITED'
    };
    
    return tierMap[tier] || this.config.defaultTier;
  }

  /**
   * Retorna limites recomendados para o tier
   */
  getLimitsForTier(tier: MessagingTier): TierLimits {
    return { ...TIER_LIMITS[tier] };
  }

  /**
   * Retorna limites para um número específico
   */
  async getLimitsForPhone(phoneNumberId: string): Promise<TierLimits> {
    const status = await this.detectTier(phoneNumberId);
    const tier = status?.messagingLimitTier || this.config.defaultTier;
    return this.getLimitsForTier(tier);
  }

  /**
   * Ajusta configuração do engine baseado no tier
   */
  getEngineConfigForTier(tier: MessagingTier): {
    maxConcurrentRequests: number;
    maxRefillRate: number;
    burstMultiplierMax: number;
    rttTargetMs: number;
  } {
    const limits = this.getLimitsForTier(tier);
    
    return {
      maxConcurrentRequests: limits.recommendedConcurrentRequests,
      maxRefillRate: limits.recommendedRefillRate,
      burstMultiplierMax: limits.recommendedBurstMultiplier,
      rttTargetMs: tier === 'TIER_1K' ? 220 : tier === 'TIER_10K' ? 210 : 200
    };
  }

  private _computeEffectiveLimit(status: PhoneNumberStatus): number {
    const tier = status.messagingLimitTier || this.config.defaultTier;
    const limits = TIER_LIMITS[tier];
    const dailyQuota = parseInt(process.env.DAILY_QUOTA || '2000', 10);
    return Math.min(limits.maxMessagesPerDay, dailyQuota);
  }

  isNearDailyLimit(status: PhoneNumberStatus, sentToday: number): boolean {
    const tier = status.messagingLimitTier || this.config.defaultTier;
    const limits = TIER_LIMITS[tier];
    const effectiveLimit = this._computeEffectiveLimit(status);
    return sentToday >= effectiveLimit * limits.safetyMargin;
  }

  async isNearDailyLimitForPhone(phoneNumberId: string): Promise<boolean> {
    const sentToday = await TierDetection.getSentTodayForPhone(phoneNumberId);
    const status = await this.detectTier(phoneNumberId) || this.getDefaultStatus(phoneNumberId);
    return this.isNearDailyLimit(status, sentToday);
  }

  getRemainingMessages(status: PhoneNumberStatus, sentToday: number): number {
    const effectiveLimit = this._computeEffectiveLimit(status);
    return Math.max(0, effectiveLimit - sentToday);
  }

  async getRemainingMessagesForPhone(phoneNumberId: string): Promise<number> {
    const sentToday = await TierDetection.getSentTodayForPhone(phoneNumberId);
    const status = await this.detectTier(phoneNumberId) || this.getDefaultStatus(phoneNumberId);
    return this.getRemainingMessages(status, sentToday);
  }

  isOverDailyLimit(status: PhoneNumberStatus, sentToday: number): boolean {
    const effectiveLimit = this._computeEffectiveLimit(status);
    return sentToday >= effectiveLimit;
  }

  async isOverDailyLimitForPhone(phoneNumberId: string): Promise<boolean> {
    const sentToday = await TierDetection.getSentTodayForPhone(phoneNumberId);
    const status = await this.detectTier(phoneNumberId) || this.getDefaultStatus(phoneNumberId);
    return this.isOverDailyLimit(status, sentToday);
  }

  getRecommendedRate(status: PhoneNumberStatus, sentToday: number): number | null {
    if (this.isOverDailyLimit(status, sentToday)) return 0;
    if (this.isNearDailyLimit(status, sentToday)) {
      const tier = status.messagingLimitTier || this.config.defaultTier;
      const limits = TIER_LIMITS[tier];
      return limits.recommendedRefillRate * 0.5;
    }
    return null;
  }

  static async getSentTodayForPhone(phoneNumberId: string): Promise<number> {
    try {
      const result = await pool.query(
        `SELECT sent_today FROM sender_usage WHERE phone_number_id = $1`,
        [phoneNumberId]
      );
      return parseInt(result.rows[0]?.sent_today || '0', 10);
    } catch (err: any) {
      logError('TierDetection.getSentTodayForPhone', { phoneNumberId }, err);
      throw err;
    }
  }

  /**
   * Retorna status do cache ou busca novo
   */
  private getCached(phoneNumberId: string): PhoneNumberStatus | null {
    const expiry = this.cacheExpiry.get(phoneNumberId);
    if (!expiry || Date.now() > expiry) {
      this.cachedStatus.delete(phoneNumberId);
      this.cacheExpiry.delete(phoneNumberId);
      return null;
    }
    
    return this.cachedStatus.get(phoneNumberId) || null;
  }

  /**
   * Salva no cache
   */
  private setCache(phoneNumberId: string, status: PhoneNumberStatus): void {
    this.cachedStatus.set(phoneNumberId, status);
    this.cacheExpiry.set(phoneNumberId, Date.now() + this.cacheTTLMs);
  }

  /**
   * Retorna status padrão quando API falha
   */
  private getDefaultStatus(phoneNumberId: string): PhoneNumberStatus {
    return {
      phoneNumberId,
      displayPhoneNumber: '',
      verifiedName: '',
      qualityRating: 'UNKNOWN',
      messagingLimitTier: this.config.defaultTier,
      isOfficialBusinessAccount: false
    };
  }

  /**
   * Limpa cache
   */
  clearCache(): void {
    this.cachedStatus.clear();
    this.cacheExpiry.clear();
  }

  destroy(): void {
    this.clearCache();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  pruneExpired(): void {
    const now = Date.now();
    const expired: string[] = [];
    this.cacheExpiry.forEach((expiry, key) => {
      if (now > expiry) expired.push(key);
    });
    for (const key of expired) {
      this.cachedStatus.delete(key);
      this.cacheExpiry.delete(key);
    }
  }

  /**
   * Atualiza token de acesso
   */
  updateAccessToken(token: string): void {
    this.config.accessToken = token;
    this.clearCache();
  }
}

/**
 * Retorna limites estáticos para tier (sem instância)
 */
export function getTierLimits(tier: MessagingTier): TierLimits {
  return { ...TIER_LIMITS[tier] };
}

/**
 * Parseia string de tier para tipo
 */
export function parseTierString(tier: string): MessagingTier {
  const tierMap: Record<string, MessagingTier> = {
    'TIER_NOT_SET': 'TIER_NOT_SET',
    'TIER_50': 'TIER_250',
    'TIER_250': 'TIER_250',
    'TIER_1K': 'TIER_1K',
    'TIER_2K': 'TIER_1K',
    'TIER_10K': 'TIER_10K',
    'TIER_100K': 'TIER_100K',
    'UNLIMITED': 'TIER_UNLIMITED',
    'TIER_UNLIMITED': 'TIER_UNLIMITED'
  };
  
  return tierMap[tier] || 'TIER_1K';
}

export function isUSNumber(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-\(\)]/g, '').trim();
  return /^\+1\d{10}$/.test(cleaned);
}

export function shouldBlockMarketingTemplate(phone: string, templateCategory?: string): boolean {
  if (!templateCategory || templateCategory.toUpperCase() !== 'MARKETING') return false;
  return isUSNumber(phone);
}
