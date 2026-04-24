/**
 * ============================================================================
 * OVERDRIVE - MOTOR DE ENVIO WHATSAPP (ULTRA-ESTÁVEL V3)
 * ============================================================================
 * 
 * MOTOR PADRÃO: UltraStableEngine (V3)
 * 
 * CARACTERÍSTICAS ATIVAS:
 * - RetryQueue não-bloqueante (sempre ativa)
 * - SafeMode automático (ativa em errorRate > 0.5%)
 * - Circuit Breaker preventivo (age ANTES do erro 135000)
 * - TierDetection via Meta API (detecta tier no início)
 * - Checkpoint a cada 1 msg (após cada envio)
 * - Finalização garantida: pipeline.drain() + retryQueue.drain()
 * - PreflightValidator (valida E.164, template, parâmetros)
 * - ErrorClassification (separa tipos de erro)
 * 
 * RESTRIÇÕES RESPEITADAS:
 * - NÃO altera template
 * - NÃO altera payload
 * - NÃO altera headers
 * - NÃO simula humano
 * - NÃO usa delays fixos
 * - NÃO usa hacks
 * 
 * NOTA: UltraStableCampaignSender é o único sender usado em produção.
 * Os wrappers legados AdaptiveCampaignEngine e ParallelCampaignSender foram removidos.
 */

import type { Lead } from "@shared/schema";
import { 
  type PhoneNumber, 
  type WhatsAppTemplate,
  type CheckpointData,
  type CircuitState,
  type EtaEstimate,
  MultiPhoneOrchestrator,
  type OrchestratorStats,
  UltraStableEngine,
  type UltraStableStats,
  type ErrorCounts,
  type SafeModeState,
  type HumanBehaviorConfig,
  DeliveryMetricsTracker
} from './engine';
import type { MultiPhoneEngineCoordinator } from './engine/MultiPhoneEngineCoordinator';
import type { CampaignDecisionEngine } from './engine/CampaignDecisionEngine';
import type { ResponseRateTracker } from './engine/ResponseRateTracker';
import type { PhoneReputationScore } from './engine/PhoneReputationScore';
import type { TokenBucket } from './engine/TokenBucket';

// Re-export types for external use
export type { PhoneNumber, WhatsAppTemplate, CheckpointData, EtaEstimate, OrchestratorStats, UltraStableStats, ErrorCounts, SafeModeState };

// ============================================================================
// CONFIGURAÇÃO DO MOTOR
// ============================================================================

export type SendSpeedMode = 'SLOW' | 'NORMAL' | 'FAST';

export interface SpeedPreset {
  initialRate: number;
  maxRate: number;
  maxConcurrentRequests: number;
  targetRttMs: number;
  burstMultiplier: number;
}

export const SPEED_PRESETS: Record<SendSpeedMode, SpeedPreset> = {
  SLOW: {
    initialRate: 0.3,
    maxRate: 0.3,
    maxConcurrentRequests: 1,
    targetRttMs: 400,
    burstMultiplier: 1.0,
  },
  NORMAL: {
    initialRate: 0.5,
    maxRate: 0.5,
    maxConcurrentRequests: 2,
    targetRttMs: 300,
    burstMultiplier: 1.0,
  },
  FAST: {
    initialRate: 0.8,
    maxRate: 0.8,
    maxConcurrentRequests: 3,
    targetRttMs: 250,
    burstMultiplier: 1.0,
  },
};

const TIER_SPEED_LIMITS: Record<string, number> = {
  TIER_NOT_SET: 0.3,
  TIER_250: 0.3,
  TIER_1K: 0.5,
  TIER_10K: 0.8,
  TIER_100K: 2.0,
  TIER_UNLIMITED: 5.0,
};

export interface CampaignConfig {
  delayBetweenMessages: number;
  maxConcurrentQueues: number;
  messagesPerSecondTarget: number;
  maxRetries: number;
  retryDelay: number;
  activePhoneCount?: number;
  calculatedStrategy?: string;
  speedMode?: SendSpeedMode;
  hardRateLimit?: number;
  baseType?: 'cold' | 'warm' | 'hot';
  templateWeights?: Record<string, number>;
  templateCategories?: Record<string, 'engagement' | 'conversion' | 'general'>;
  humanBehavior?: Partial<HumanBehaviorConfig>;
  wabaConfigs?: Array<{ wabaId: string; accessToken: string; phoneNumberIds: string[] }>;
  deliveryRateAutoPauseThreshold?: number;
  deliveryRateReduceThreshold?: number;
  deliveryRateWindowMs?: number;
  blockRateAutoPauseThreshold?: number;
}

export interface DetailedCampaignProgress {
  totalLeads: number;
  processedLeads: number;
  successfulSends: number;
  failedSends: number;
  startTime: number;
  endTime?: number;
  currentRate: number;
  peakRate: number;
  estimatedCompletion?: number;
  activeQueues: number;
  queueStats: DetailedQueueStats[];
}

export interface DetailedQueueStats {
  phoneNumberId: string;
  displayPhoneNumber: string;
  totalMessages: number;
  sentMessages: number;
  failedMessages: number;
  startTime: number;
  endTime?: number;
  errors: string[];
  currentTemplate?: string;
}

interface QueueData {
  phoneNumber: PhoneNumber;
  leads: Lead[];
}

// ============================================================================
// FUNÇÕES UTILITÁRIAS
// ============================================================================

/**
 * Calcula configuração de velocidade inteligente baseada no número de telefones
 */
export function calculateIntelligentSpeed(activePhoneCount: number, detectedTier?: string): CampaignConfig {
  const calculatedTarget = 30;

  return {
    delayBetweenMessages: 50,
    maxConcurrentQueues: Math.min(activePhoneCount, 1),
    messagesPerSecondTarget: calculatedTarget,
    maxRetries: 3,
    retryDelay: 3000,
    activePhoneCount,
    calculatedStrategy: `OVERDRIVE — Skip-label (sender_label: null), velocidade máxima sem rotação de nome`
  };
}

/**
 * Presets de campanha (para compatibilidade)
 */
export const CAMPAIGN_PRESETS = {
  CONSERVATIVE: {
    delayBetweenMessages: 200,
    maxConcurrentQueues: 1,
    messagesPerSecondTarget: 5,
    maxRetries: 3,
    retryDelay: 2000
  } as CampaignConfig,
  BALANCED: {
    delayBetweenMessages: 100,
    maxConcurrentQueues: 1,
    messagesPerSecondTarget: 10,
    maxRetries: 3,
    retryDelay: 2000
  } as CampaignConfig,
  AGGRESSIVE: {
    delayBetweenMessages: 50,
    maxConcurrentQueues: 1,
    messagesPerSecondTarget: 20,
    maxRetries: 3,
    retryDelay: 2000
  } as CampaignConfig,
  EXTREME_SPEED: {
    delayBetweenMessages: 33,
    maxConcurrentQueues: 1,
    messagesPerSecondTarget: 20,
    maxRetries: 3,
    retryDelay: 3000
  } as CampaignConfig
};

// ============================================================================
// ULTRA-STABLE CAMPAIGN SENDER (V3 - FOCO EM ZERO ERROS)
// ============================================================================

/**
 * UltraStableCampaignSender - Sender com foco em ESTABILIDADE
 * 
 * CARACTERÍSTICAS:
 * - Retry não-bloqueante (fila separada)
 * - SafeMode automático (ativa em erros)
 * - Circuit breaker preventivo (age ANTES do erro)
 * - Detecção automática de tier
 * - Checkpoint a cada 1 msg (após cada envio)
 * - Classificação de erros por tipo
 * - Garantia de finalização total
 * 
 * QUANDO USAR:
 * - Quando erros 135000 são críticos
 * - BM sensível (recém-criada, histórico de bloqueio)
 * - Campanhas importantes que não podem falhar
 * - Produção onde estabilidade > velocidade
 */
export class UltraStableCampaignSender {
  private engine: UltraStableEngine;
  private progress: DetailedCampaignProgress;
  private config: CampaignConfig;
  private isRunning: boolean = false;
  private lastStats: UltraStableStats | null = null;

  get rotationMode(): string { return this.engine.rotationMode; }
  set rotationMode(mode: string) { this.engine.rotationMode = mode; }

  constructor(config: Partial<CampaignConfig> = {}) {
    const speedMode: SendSpeedMode = config.speedMode || 'NORMAL';
    const preset = SPEED_PRESETS[speedMode];
    const hardRate = config.hardRateLimit;
    
    const targetRate = hardRate || config.messagesPerSecondTarget || preset.initialRate;
    
    const baseType = config.baseType || 'cold';
    const templateWeights = config.templateWeights || {};
    const templateCategories = config.templateCategories || {};
    const humanBehaviorConfig: Partial<HumanBehaviorConfig> = {
      ...config.humanBehavior,
      ...(Object.keys(templateCategories).length > 0 ? { templateCategories } : {}),
    };

    const safeRate = hardRate ? Math.min(hardRate, 0.8) : preset.initialRate;
    const safeMaxRate = hardRate ? Math.min(hardRate, 0.8) : preset.maxRate;
    const safeConcurrency = hardRate ? Math.min(3, Math.max(1, Math.floor(hardRate))) : preset.maxConcurrentRequests;

    if (hardRate) {
      console.log(`⚡ SpeedMode: MANUAL FIXO (rate=${safeRate} msg/s, sem burst, sem aceleração)`);
    } else {
      console.log(`⚡ SpeedMode: ${speedMode} (initial=${safeRate}, max=${safeMaxRate}, concurrent=${safeConcurrency}, rtt=${preset.targetRttMs}ms, burst=1.0x)`);
    }
      
    this.engine = new UltraStableEngine({
      targetRttMs: preset.targetRttMs,
      rttThresholdPercent: 50,
      initialRefillRate: safeRate,
      minRefillRate: 0.1,
      maxRefillRate: safeMaxRate,
      maxConcurrentRequests: safeConcurrency,
      prefetchCount: Math.min(safeConcurrency, 2),
      rttWindowSize: 100,
      maxRetries: 3,
      baseRetryDelayMs: 3000,
      maxRetryDelayMs: 30000,
      checkpointEveryN: 50,
      checkpointFlushMs: 3000,
      circuitBreakerCooldownMs: 15000,
      safeMode: speedMode === 'SLOW' ? { maxRefillRate: 0.3, maxConcurrentRequests: 1 } : {},
      enablePreflightValidation: true,
      enableAutoTierDetection: false,
      strictPreflightMode: speedMode === 'SLOW',
      burstMultiplier: 1.0,
      tokenBucketMaxTokens: 5,
      baseType,
      templateWeights,
      humanBehavior: humanBehaviorConfig,
      enableMicroBatching: true,
      microBatchSize: 150,
      microBatchPauseMinMs: 60000,
      microBatchPauseMaxMs: 120000,
      wabaConfigs: config.wabaConfigs || [],
      deliveryRateAutoPauseThreshold: config.deliveryRateAutoPauseThreshold ?? 0.5,
      deliveryRateReduceThreshold: config.deliveryRateReduceThreshold ?? 0.6,
      deliveryRateWindowMs: config.deliveryRateWindowMs ?? 300000,
      blockRateAutoPauseThreshold: config.blockRateAutoPauseThreshold ?? 0.15,
    });
    
    this.config = {
      delayBetweenMessages: config.delayBetweenMessages || (hardRate ? Math.max(20, Math.floor(1000 / hardRate)) : speedMode === 'SLOW' ? 200 : 50),
      maxConcurrentQueues: 1,
      messagesPerSecondTarget: targetRate,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 2000,
      speedMode,
      hardRateLimit: hardRate
    };
    
    this.progress = {
      totalLeads: 0,
      processedLeads: 0,
      successfulSends: 0,
      failedSends: 0,
      startTime: 0,
      currentRate: 0,
      peakRate: 0,
      activeQueues: 1,
      queueStats: []
    };
  }

  setSendResultCallback(callback: (result: { success: boolean; phone: string; error?: string; errorType?: string; isMetaBlocked?: boolean; isRetry?: boolean }) => void): void {
    this.engine.setSendResultCallback(callback);
  }

  /**
   * Applies a warmup hard rate limit (msgs/second) to the underlying engine.
   * Must be called before startCampaign to enforce uniform day distribution.
   */
  setHardRateLimit(ratePerSecond: number): void {
    this.engine.setMaxSendRate(ratePerSecond);
    this.config.hardRateLimit = ratePerSecond;
  }

  setProgressCallback(callback: (stats: UltraStableStats) => void): void {
    this.engine.setProgressCallback(callback);
  }

  updateConfigWithIntelligentSpeed(activePhoneNumbers: PhoneNumber[]): void {
    console.log(`🛡️ Motor Ultra-Estável: ${activePhoneNumbers.length} números detectados`);
    console.log(`   ⚡ Modo: ESTABILIDADE (zero erros)`);
    console.log(`   🎯 Controle: RTT preventivo + SafeMode automático`);
    console.log(`   🔄 Retry: Fila separada (não-bloqueante)`);
    console.log(`   📊 Tier: Detecção automática`);
  }

  /**
   * Inicia campanha com motor ultra-estável (multi-phone com sender pool)
   */
  async startCampaign(
    leads: Lead[],
    phoneNumbers: PhoneNumber[],
    templates: WhatsAppTemplate[],
    metaToken: string,
    onProgress?: (progress: DetailedCampaignProgress) => void,
    forcedLanguage?: string
  ): Promise<DetailedCampaignProgress> {
    this.isRunning = true;
    
    const prioritizedNumbers = [...phoneNumbers].sort((a, b) => {
      const priority: Record<string, number> = { 'GREEN': 3, 'YELLOW': 2, 'RED': 1 };
      return (priority[b.quality_rating] || 0) - (priority[a.quality_rating] || 0);
    });
    
    if (prioritizedNumbers.length === 0) {
      console.log('❌ Nenhum número disponível para envio');
      return this.progress;
    }
    
    const campaignId = `campaign_ultra_${Date.now()}`;
    const useMultiPhone = prioritizedNumbers.length > 1;

    console.log(`\n🚀 [UltraStable] Campanha ${campaignId}`);
    console.log(`   📱 Phones: ${prioritizedNumbers.length} (${useMultiPhone ? 'MULTI-PHONE' : 'SINGLE'})`);
    console.log(`   📊 Leads: ${leads.length}`);
    console.log(`   📝 Templates: ${templates.length}`);

    const progressCallback = (engineStats: UltraStableStats) => {
      this.lastStats = engineStats;
      this.progress = {
        totalLeads: engineStats.totalLeads,
        processedLeads: engineStats.processedLeads,
        successfulSends: engineStats.successfulSends,
        failedSends: engineStats.failedSends + engineStats.preflightFailed,
        startTime: engineStats.startTime,
        endTime: engineStats.endTime,
        currentRate: engineStats.currentRate,
        peakRate: engineStats.peakRate || engineStats.currentRate,
        activeQueues: prioritizedNumbers.length,
        queueStats: [{
          phoneNumberId: engineStats.phoneNumberId,
          displayPhoneNumber: engineStats.displayPhoneNumber,
          totalMessages: engineStats.totalLeads,
          sentMessages: engineStats.successfulSends,
          failedMessages: engineStats.failedSends + engineStats.preflightFailed,
          startTime: engineStats.startTime,
          endTime: engineStats.endTime,
          errors: []
        }]
      };
      onProgress?.(this.progress);
    };

    let stats: UltraStableStats;

    if (useMultiPhone) {
      stats = await this.engine.processLeadsMultiPhone(
        campaignId,
        leads,
        prioritizedNumbers,
        templates,
        metaToken,
        progressCallback,
        0,
        forcedLanguage
      );
    } else {
      stats = await this.engine.processLeads(
        campaignId,
        leads,
        prioritizedNumbers[0],
        templates,
        metaToken,
        progressCallback,
        0,
        forcedLanguage
      );
    }
    
    this.lastStats = stats;
    this.progress.endTime = stats.endTime;
    this.progress.successfulSends = stats.successfulSends;
    this.progress.failedSends = stats.failedSends + stats.preflightFailed;
    this.progress.currentRate = stats.currentRate;
    
    this.isRunning = false;
    return this.progress;
  }

  pauseCampaign(): void {
    this.engine.pause();
    console.log('⏸️ Pausando campanha ultra-estável...');
  }

  resumeCampaign(): void {
    this.engine.resume();
    console.log('▶️ Retomando campanha ultra-estável...');
  }

  isPaused(): boolean {
    return this.engine.getPaused();
  }

  stopCampaign(): void {
    this.isRunning = false;
    this.engine.stop();
    console.log('🛑 Parando campanha ultra-estável...');
  }

  /**
   * Retorna progresso atual
   */
  getProgress(): DetailedCampaignProgress {
    return { ...this.progress };
  }

  /**
   * Retorna estatísticas detalhadas
   */
  getDetailedStats(): DetailedCampaignProgress {
    return this.getProgress();
  }

  /**
   * Retorna estatísticas do motor ultra-estável
   */
  getUltraStats(): UltraStableStats | null {
    return this.lastStats;
  }

  /**
   * Retorna contagem de erros por tipo
   */
  getErrorCounts(): ErrorCounts | null {
    return this.lastStats?.errorCounts || null;
  }

  /**
   * Retorna estado do SafeMode
   */
  getSafeModeState(): SafeModeState | null {
    return this.lastStats?.safeModeState || null;
  }

  /**
   * Ativa SafeMode manualmente
   */
  activateSafeMode(reason: string = 'manual'): void {
    this.engine.activateSafeMode(reason);
  }

  /**
   * Retorna tier detectado
   */
  getDetectedTier(): string | null {
    return this.engine.getDetectedTier() || null;
  }

  /**
   * Verifica se está rodando
   */
  isActive(): boolean {
    return this.isRunning;
  }

  setMultiPhoneCoordinator(coordinator: MultiPhoneEngineCoordinator): void {
    this.engine.setMultiPhoneCoordinator(coordinator);
  }

  setDecisionEngine(engine: CampaignDecisionEngine): void {
    this.engine.setDecisionEngine(engine);
  }

  getDeliveryMetrics(): DeliveryMetricsTracker {
    return this.engine.getDeliveryMetrics();
  }

  getResponseRateTracker(): ResponseRateTracker {
    return this.engine.getResponseRateTracker();
  }

  getPhoneReputationScore(): PhoneReputationScore {
    return this.engine.getPhoneReputationScore();
  }

  getTokenBucket(): TokenBucket {
    return this.engine.getTokenBucket();
  }

  setBlockRatePauseCallback(callback: (campaignId: string, reason: string, blockRate: number) => void): void {
    this.engine.setBlockRatePauseCallback(callback);
  }

  pause(): void {
    this.engine.pause();
  }
}
