import { metaAPI } from '../../meta/metaAPI';
import { logError } from '../../utils/logger';

export interface PhoneQualityState {
  phoneNumberId: string;
  qualityScore: number;
  status: string;
  messagingLimitTier: string;
  lastChecked: number;
  isPaused: boolean;
  pausedUntil: number | null;
  quotaBonus: number;
  softQuota?: number;
}

export interface BMQualityConfig {
  pollingIntervalMs: number;
  criticalScoreThreshold: number;
  criticalPauseDurationMs: number;
  bonusScoreMin: number;
  bonusScoreMax: number;
  bonusQuotaAmount: number;
}

const DEFAULT_CONFIG: BMQualityConfig = {
  pollingIntervalMs: 15000,
  criticalScoreThreshold: 85,
  criticalPauseDurationMs: 3600000,
  bonusScoreMin: 90,
  bonusScoreMax: 95,
  bonusQuotaAmount: 1200,
};

export class BMQualityMonitor {
  private config: BMQualityConfig;
  private phoneStates: Map<string, PhoneQualityState> = new Map();
  private pollingTimer: NodeJS.Timeout | null = null;
  private isActive: boolean = false;
  private accessToken: string = '';
  private onCriticalCallbacks: Array<(phoneId: string, score: number) => void> = [];
  private onBonusCallbacks: Array<(phoneId: string, score: number, bonus: number) => void> = [];
  private onResumeCallbacks: Array<(phoneId: string) => void> = [];

  constructor(config?: Partial<BMQualityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(accessToken: string, phoneNumberIds: string[]): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    this.accessToken = accessToken;
    this.isActive = true;

    for (const phoneId of phoneNumberIds) {
      if (!this.phoneStates.has(phoneId)) {
        this.phoneStates.set(phoneId, {
          phoneNumberId: phoneId,
          qualityScore: 100,
          status: 'CONNECTED',
          messagingLimitTier: 'TIER_1K',
          lastChecked: 0,
          isPaused: false,
          pausedUntil: null,
          quotaBonus: 0,
        });
      }
    }

    this.pollingTimer = setInterval(() => this.pollAll(), this.config.pollingIntervalMs);
    console.log(`📊 BMQualityMonitor iniciado: ${phoneNumberIds.length} números, polling a cada ${this.config.pollingIntervalMs / 1000}s`);
  }

  stop(): void {
    this.isActive = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    console.log(`⏹️ BMQualityMonitor parado`);
  }

  private async pollAll(): Promise<void> {
    if (!this.isActive) return;

    for (const [phoneId, state] of this.phoneStates) {
      if (state.isPaused && state.pausedUntil && Date.now() < state.pausedUntil) {
        continue;
      }

      if (state.isPaused && state.pausedUntil && Date.now() >= state.pausedUntil) {
        state.isPaused = false;
        state.pausedUntil = null;
        console.log(`▶️ Número ${phoneId} retomado após pausa de qualidade`);
        for (const cb of this.onResumeCallbacks) { try { cb(phoneId); } catch (_e) { /* skip */ } }
      }

      try {
        await this.checkQuality(phoneId);
      } catch (err: any) {
        logError('BMQualityMonitor.checkQuality', { phoneId }, err);
      }
    }
  }

  private async checkQuality(phoneId: string): Promise<void> {
    const state = this.phoneStates.get(phoneId);
    if (!state) return;

    try {
      const response = await fetch(
        `https://graph.facebook.com/v25.0/${phoneId}?fields=quality_score,status,messaging_limit_tier`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );

      if (!response.ok) {
        logError('⚠️ BMQualityMonitor: HTTP ${response.status} para', {}, phoneId);
        return;
      }

      const data = await response.json() as any;
      const qualityScore = this.parseQualityScore(data.quality_score);

      state.qualityScore = qualityScore;
      state.status = data.status || state.status;
      state.messagingLimitTier = data.messaging_limit_tier || state.messagingLimitTier;
      state.lastChecked = Date.now();

      if (qualityScore < this.config.criticalScoreThreshold) {
        state.isPaused = true;
        state.pausedUntil = Date.now() + this.config.criticalPauseDurationMs;
        console.log(`🛑 QUALIDADE CRÍTICA: ${phoneId} score=${qualityScore} < ${this.config.criticalScoreThreshold} → PAUSA ${this.config.criticalPauseDurationMs / 3600000}h`);
        for (const cb of this.onCriticalCallbacks) { try { cb(phoneId, qualityScore); } catch (_e) { /* skip */ } }
      } else if (qualityScore >= this.config.bonusScoreMin && qualityScore <= this.config.bonusScoreMax) {
        state.quotaBonus += this.config.bonusQuotaAmount;
        console.log(`📈 BÔNUS: ${phoneId} score=${qualityScore} (${this.config.bonusScoreMin}-${this.config.bonusScoreMax}) → +${this.config.bonusQuotaAmount} quota`);
        for (const cb of this.onBonusCallbacks) { try { cb(phoneId, qualityScore, this.config.bonusQuotaAmount); } catch (_e) { /* skip */ } }
      }
    } catch (error: any) {
      if (error.message?.includes('1005')) {
        logError('🚫 ERRO 1005 para', {}, phoneId);
      }
      throw error;
    }
  }

  private parseQualityScore(raw: any): number {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed)) return parsed;
      const scoreMap: Record<string, number> = {
        'GREEN': 100,
        'YELLOW': 75,
        'RED': 40,
        'UNKNOWN': 50,
      };
      return scoreMap[raw] || 50;
    }
    if (raw && typeof raw === 'object' && 'score' in raw) {
      return typeof raw.score === 'number' ? raw.score : 50;
    }
    return 50;
  }

  getPhoneState(phoneId: string): PhoneQualityState | undefined {
    return this.phoneStates.get(phoneId);
  }

  isPhonePaused(phoneId: string): boolean {
    const state = this.phoneStates.get(phoneId);
    if (!state) return false;
    if (state.isPaused && state.pausedUntil && Date.now() >= state.pausedUntil) {
      state.isPaused = false;
      state.pausedUntil = null;
    }
    return state.isPaused;
  }

  getQuotaBonus(phoneId: string): number {
    return this.phoneStates.get(phoneId)?.quotaBonus || 0;
  }

  setSoftQuota(phoneId: string, quota: number): void {
    const state = this.phoneStates.get(phoneId);
    if (state) {
      state.softQuota = quota;
      state.quotaBonus = quota;
    }
  }

  onCritical(callback: (phoneId: string, score: number) => void): void {
    this.onCriticalCallbacks.push(callback);
  }

  onBonus(callback: (phoneId: string, score: number, bonus: number) => void): void {
    this.onBonusCallbacks.push(callback);
  }

  onResume(callback: (phoneId: string) => void): void {
    this.onResumeCallbacks.push(callback);
  }

  getAllStates(): PhoneQualityState[] {
    return Array.from(this.phoneStates.values());
  }

  getStats(): {
    isActive: boolean;
    totalPhones: number;
    pausedPhones: number;
    avgQualityScore: number;
    totalBonusQuota: number;
  } {
    const states = this.getAllStates();
    const pausedCount = states.filter(s => s.isPaused).length;
    const avgScore = states.length > 0
      ? states.reduce((sum, s) => sum + s.qualityScore, 0) / states.length
      : 0;
    const totalBonus = states.reduce((sum, s) => sum + s.quotaBonus, 0);

    return {
      isActive: this.isActive,
      totalPhones: states.length,
      pausedPhones: pausedCount,
      avgQualityScore: Math.round(avgScore),
      totalBonusQuota: totalBonus,
    };
  }
}

export const bmQualityMonitor = new BMQualityMonitor();
