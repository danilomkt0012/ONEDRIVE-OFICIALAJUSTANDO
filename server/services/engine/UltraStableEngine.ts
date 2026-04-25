/**
 * ============================================================================
 * MOTOR DE ENVIO ULTRA-ESTÁVEL (V3)
 * ============================================================================
 * 
 * Motor com foco em ESTABILIDADE e ZERO ERROS:
 * - Retry não-bloqueante (RetryQueue separada)
 * - Pré-validação forte (PreflightValidator)
 * - SafeMode automático
 * - Circuit breaker preventivo (age ANTES do erro)
 * - Detecção automática de Tier
 * - Checkpoint a cada 5 msgs (antes era 10)
 * - Classificação de erros (telemetria)
 * - Garantia de finalização total
 * 
 * RESULTADO ESPERADO:
 * - Erros → praticamente zero
 * - 135000 → raríssimo e isolado
 * - Nenhuma campanha morre no meio
 * - BM 2K / 10K finaliza 100%
 * 
 * RESTRIÇÕES MANTIDAS:
 * - NÃO altera template, payload ou headers
 * - Engenharia defensiva com simulação de comportamento humano (HumanBehavior)
 * - Gaussian delays, micro-pauses, phone desynchronization, template rotation probabilística
 */

import crypto from 'crypto';
import type { Lead } from "@shared/schema";
import { campaignErrorLogs, messageDeliveries } from "@shared/schema";
import { db } from "../../db";
import { sendTemplateMessage, sendTemplateWithButtons, sendAudioMessage, sendImageMessage, metaAPI } from "../../meta/metaAPI";
import { fetchAudioBuffer } from "../../utils/ssrfGuard";
import { detectAudioFormat, isFfmpegAvailable, convertBufferToOgg } from "../../utils/audioConverter";
import path from "path";
import { TokenBucket } from './TokenBucket';
import { SlidingWindow } from './SlidingWindow';
import type { CircuitState } from './CircuitBreaker';

import { AsyncCheckpoint, CheckpointData } from './AsyncCheckpoint';
import { RequestPipeline } from './RequestPipeline';
import { BurstProfile, BurstState } from './BurstProfile';
import { EtaCalculator, EtaEstimate } from './EtaCalculator';
import { RetryQueue, RetryItem, RetryQueueStats } from './RetryQueue';
import { SafeMode, SafeModeState, SafeModeConfig, DEFAULT_SAFE_MODE_CONFIG } from './SafeMode';
import { ErrorClassification, ErrorType, ErrorCounts } from './ErrorClassification';
import { TierDetection, MessagingTier, getTierLimits } from './TierDetection';
import { PreflightValidator, TemplateInfo, ValidationResult, buildDynamicParameterMapping } from './PreflightValidator';
import { RiskEngine, RiskAction } from '../risk/RiskEngine';
import { SlidingWindowMetrics } from '../risk/SlidingWindowMetrics';
import { checkpointStore } from '../campaign/CheckpointStore';
import { nextSender, incrementSender, markDead, shouldSwitchSender, getAllSenders } from './SenderPool';
import { stealthScheduler } from './StealthScheduler';
import { WabaScorer, WabaDistributionEntry } from './WabaScorer';
import { bmQualityMonitor } from './BMQualityMonitor';
import { shouldBlockMarketingTemplate } from './TierDetection';
import { HumanBehavior, TemplatePacingBackoff, type HumanBehaviorConfig, type BaseType } from './HumanBehavior';
import { formatPhoneE164 } from './phoneUtils';
import { DeliveryMetricsTracker, deliveryMetricsTracker, registerActiveTracker, unregisterActiveTracker, registerResponseRateTracker, unregisterResponseRateTracker } from './DeliveryMetricsTracker';
import { ResponseRateTracker } from './ResponseRateTracker';
import { PhoneReputationScore } from './PhoneReputationScore';
import { CampaignDecisionEngine } from './CampaignDecisionEngine';
import { MultiPhoneEngineCoordinator } from './MultiPhoneEngineCoordinator';
import { frequencyCap } from './FrequencyCap';
import { portfolioControl } from './PortfolioControl';
import { proactiveSenderRotation } from './ProactiveSenderRotation';
import { updateTemplatePerformance, getTemplatePerformance, recordTemplateSent, recordTemplateBlocked, registerMessageTemplate } from '../templateManager';
import { pool } from '../../db';
import { logError } from '../../utils/logger';

export interface PhoneNumber {
  id: string;
  display_phone_number: string;
  quality_rating: string;
  verified_name?: string;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  components?: any[];
  /** DB-level WABA id that owns this template (set when available). Used for multi-WABA template isolation. */
  wabaId?: string;
}

export interface WABAConfig {
  wabaId: string;
  accessToken: string;
  phoneNumberIds: string[];
  /** DB-level WABA id (uuid). When set, used for per-job template isolation checks. */
  wabaDbId?: string;
}

export interface UltraStableEngineConfig {
  targetRttMs: number;
  rttThresholdPercent: number;
  initialRefillRate: number;
  minRefillRate: number;
  maxRefillRate: number;
  maxConcurrentRequests: number;
  prefetchCount: number;
  rttWindowSize: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  checkpointEveryN: number;
  checkpointFlushMs: number;
  circuitBreakerCooldownMs: number;
  safeMode: Partial<SafeModeConfig>;
  enablePreflightValidation: boolean;
  enableAutoTierDetection: boolean;
  strictPreflightMode: boolean;
  burstMultiplier: number;
  tokenBucketMaxTokens?: number;
  humanBehavior?: Partial<HumanBehaviorConfig>;
  baseType?: BaseType;
  templateWeights?: Record<string, number>;
  microBatchSize: number;
  microBatchPauseMinMs: number;
  microBatchPauseMaxMs: number;
  enableMicroBatching: boolean;
  wabaConfigs: WABAConfig[];
  deliveryRateAutoPauseThreshold: number;
  deliveryRateReduceThreshold: number;
  deliveryRateWindowMs: number;
  blockRateAutoPauseThreshold: number;
}

export interface UltraStableStats {
  campaignId: string;
  totalLeads: number;
  processedLeads: number;
  successfulSends: number;
  failedSends: number;
  metaBlockedSends: number;
  preflightFailed: number;
  startTime: number;
  endTime?: number;
  currentRate: number;
  peakRate: number;
  averageRttMs: number;
  p95RttMs: number;
  burstState: BurstState;
  circuitBreakerTrips: number;
  totalRetries: number;
  phoneNumberId: string;
  displayPhoneNumber: string;
  tokenBucketRate: number;
  circuitState: CircuitState;
  inFlightRequests: number;
  eta: EtaEstimate;
  retryQueue: RetryQueueStats;
  errorCounts: ErrorCounts;
  safeModeState: SafeModeState;
  detectedTier?: MessagingTier;
}

interface LeadWithIndex {
  lead: Lead;
  index: number;
}

// ============================================================================
// PLANO DE ENVIO (buildPlan)
// ============================================================================
// Um "job" é uma unidade de trabalho: 1 mensagem para 1 contato.
// O plano distribui leads entre phoneIds e alterna templates.
// Skip-label: sender_label=null (usa display name verificado da WABA).
// ============================================================================

export interface SendJob {
  phoneId: string;
  templateIndex: number;
  leadIndex: number;
  delayMs: number;
  seq: number;
}

export interface PlanSummary {
  totalJobs: number;
  estimatedTimeMs: number;
  jobsPerPhone: Record<string, number>;
}

export function buildPlan(
  phoneIds: string[],
  templateCount: number,
  leadCount: number,
  humanBehavior?: HumanBehavior
): { jobs: SendJob[]; summary: PlanSummary } {
  const jobs: SendJob[] = [];
  const phoneCounters: Record<string, number> = {};

  for (const pid of phoneIds) {
    phoneCounters[pid] = 0;
  }

  for (let i = 0; i < leadCount; i++) {
    const phoneIdx = i % phoneIds.length;
    const phoneId = phoneIds[phoneIdx];

    const tplIdx = templateCount === 1 ? 0 : i % templateCount;

    const delayMs = humanBehavior
      ? humanBehavior.getMessageDelay(phoneId)
      : HumanBehavior.gaussianRandom(1200, 400);

    jobs.push({
      phoneId,
      templateIndex: tplIdx,
      leadIndex: i,
      delayMs: Math.max(500, Math.round(delayMs)),
      seq: i,
    });

    phoneCounters[phoneId]++;
  }

  const avgDelayMs = 1200;
  const msgsPerSecond = phoneIds.length * (1000 / avgDelayMs);
  const estimatedTimeMs = Math.ceil((leadCount / msgsPerSecond) * 1000);

  return {
    jobs,
    summary: {
      totalJobs: jobs.length,
      estimatedTimeMs,
      jobsPerPhone: { ...phoneCounters },
    },
  };
}

export class UltraStableEngine {
  private config: UltraStableEngineConfig;
  private tokenBucket: TokenBucket;
  private rttWindow: SlidingWindow;
  private asyncCheckpoint: AsyncCheckpoint;
  private pipeline: RequestPipeline<SendResult>;
  private burstProfile: BurstProfile;
  private etaCalculator: EtaCalculator;
  private retryQueue: RetryQueue<LeadWithIndex>;
  private safeMode: SafeMode;
  private errorClassification: ErrorClassification;
  private tierDetection: TierDetection | null = null;
  private preflightValidator: PreflightValidator | null = null;
  private preflightValidators: Map<number, PreflightValidator> = new Map();
  private riskEngine: RiskEngine;
  private blockWindow: SlidingWindowMetrics;
  private errorWindow: SlidingWindowMetrics;
  private consecutiveErrors: number = 0;
  private riskCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private batchSize: number = 500;
  private humanBehavior: HumanBehavior;
  private templatePacingBackoff: TemplatePacingBackoff;
  private recoveryCheckTimer: ReturnType<typeof setInterval> | null = null;
  private phoneWeightSyncTimer: ReturnType<typeof setInterval> | null = null;
  
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private pauseResolve: (() => void) | null = null;
  private stats: UltraStableStats;
  private peakRate: number = 0;
  private totalRetries: number = 0;
  private startTime: number = 0;
  private successCount: number = 0;
  private failedCount: number = 0;
  private metaBlockedCount: number = 0;
  private preflightFailedCount: number = 0;
  private processedCount: number = 0;
  private detectedTier?: MessagingTier;
  private lastProgressLogTime: number = 0;
  private progressLogIntervalMs: number = 30000;
  
  private currentPhoneNumberId: string = '';
  private currentMetaToken: string = '';
  private currentTemplate: WhatsAppTemplate | null = null;
  private currentForcedLanguage?: string;
  private currentLeads: Lead[] = [];
  public rotationMode: string = 'distributed';
  private pacingTestJobs: Map<number, { phoneId: string; templateName: string }> = new Map();
  private jobContextMap: Map<number, { phoneId: string; templateName: string }> = new Map();
  private phoneOffsetApplied: Set<string> = new Set();
  
  private allPhoneNumbers: PhoneNumber[] = [];
  private senderSentCounters: Map<string, number> = new Map();
  private useSenderPool: boolean = false;
  
  private microBatchSentCount: number = 0;
  private microBatchNumber: number = 0;
  private currentWabaIndex: number = 0;
  private wabaScorer: WabaScorer | null = null;
  private deliveryMetrics: DeliveryMetricsTracker;
  private responseRateTracker: ResponseRateTracker;
  private phoneReputationScore: PhoneReputationScore;
  private decisionEngine: CampaignDecisionEngine | null = null;
  private multiPhoneCoordinator: MultiPhoneEngineCoordinator | null = null;
  private didRegisterResponseRateTracker: boolean = false;
  private ownsDecisionEngine: boolean = false;
  private messageTemplateMap: Map<string, string> = new Map();
  private portfolioBmId: string | null = null;
  private audioMediaIdCache: Map<string, string> = new Map();
  private audioPrepareInflight: Map<string, Promise<string>> = new Map();
  
  private onProgressCallback?: (stats: UltraStableStats) => void;
  private onSendResultCallback?: (result: { success: boolean; phone: string; error?: string; errorType?: string; isMetaBlocked?: boolean; isRetry?: boolean }) => void;
  private externalCheckpointSave?: (checkpoint: CheckpointData) => Promise<void>;
  private onBlockRatePauseCallback?: (campaignId: string, reason: string, blockRate: number) => void;

  constructor(config: Partial<UltraStableEngineConfig> = {}) {
    this.config = {
      targetRttMs: config.targetRttMs ?? 300,
      rttThresholdPercent: config.rttThresholdPercent ?? 50,
      initialRefillRate: config.initialRefillRate ?? 0.5,
      minRefillRate: config.minRefillRate ?? 0.1,
      maxRefillRate: config.maxRefillRate ?? 0.8,
      maxConcurrentRequests: config.maxConcurrentRequests ?? 3,
      prefetchCount: config.prefetchCount ?? 2,
      rttWindowSize: config.rttWindowSize ?? 100,
      maxRetries: config.maxRetries ?? 3,
      baseRetryDelayMs: config.baseRetryDelayMs ?? 3000,
      maxRetryDelayMs: config.maxRetryDelayMs ?? 30000,
      checkpointEveryN: config.checkpointEveryN ?? 50,
      checkpointFlushMs: config.checkpointFlushMs ?? 3000,
      circuitBreakerCooldownMs: config.circuitBreakerCooldownMs ?? 15000,
      safeMode: config.safeMode ?? {},
      enablePreflightValidation: config.enablePreflightValidation ?? true,
      enableAutoTierDetection: config.enableAutoTierDetection ?? true,
      strictPreflightMode: config.strictPreflightMode ?? false,
      burstMultiplier: config.burstMultiplier ?? 1.0,
      microBatchSize: config.microBatchSize ?? 150,
      microBatchPauseMinMs: config.microBatchPauseMinMs ?? 60000,
      microBatchPauseMaxMs: config.microBatchPauseMaxMs ?? 120000,
      enableMicroBatching: config.enableMicroBatching ?? true,
      wabaConfigs: config.wabaConfigs ?? [],
      deliveryRateAutoPauseThreshold: config.deliveryRateAutoPauseThreshold ?? 0.5,
      deliveryRateReduceThreshold: config.deliveryRateReduceThreshold ?? 0.6,
      deliveryRateWindowMs: config.deliveryRateWindowMs ?? 300000,
      blockRateAutoPauseThreshold: config.blockRateAutoPauseThreshold ?? 0.15,
    };

    if (this.config.wabaConfigs.length > 1) {
      const ids = this.config.wabaConfigs.map(w => w.wabaId);
      this.wabaScorer = new WabaScorer(ids, { windowSize: 50, rebalanceEvery: 50 });
    }

    this.tokenBucket = new TokenBucket({
      maxTokens: this.config.tokenBucketMaxTokens ?? 5,
      refillRate: this.config.initialRefillRate,
      minRefillRate: this.config.minRefillRate,
      maxRefillRate: this.config.maxRefillRate,
      burstMultiplier: 1.0
    });
    
    this.rttWindow = new SlidingWindow({
      windowSize: this.config.rttWindowSize
    });
    
    
    this.pipeline = new RequestPipeline({
      maxConcurrentRequests: Math.min(this.config.maxConcurrentRequests, 8),
      prefetchCount: Math.min(this.config.prefetchCount, 4),
      queueHighWaterMark: 12,
      drainLowWaterMark: 2
    });
    
    this.burstProfile = new BurstProfile({
      rampUpTargetMsgPerMin: Math.round(this.config.maxRefillRate * 60),
    });
    this.etaCalculator = new EtaCalculator();
    this.deliveryMetrics = new DeliveryMetricsTracker({
      windowMs: this.config.deliveryRateWindowMs,
      deliveryRateAutoPauseThreshold: this.config.deliveryRateAutoPauseThreshold,
      deliveryRateReduceThreshold: this.config.deliveryRateReduceThreshold,
    });

    this.responseRateTracker = new ResponseRateTracker(this.config.deliveryRateWindowMs);
    this.phoneReputationScore = new PhoneReputationScore(this.deliveryMetrics, this.responseRateTracker);
    
    this.deliveryMetrics.onAutoPause((reason) => {
      console.log(`\n🚨 [Engine] Auto-pause triggered by delivery metrics: ${reason}`);
      if (!this.decisionEngine) this.pause();
    });
    
    this.deliveryMetrics.onAutoReduce((templateName, currentRate) => {
      console.log(`\n⚠️ [Engine] Reducing rate due to low delivery for template ${templateName} (${(currentRate * 100).toFixed(1)}%)`);
      if (!this.decisionEngine) {
        this.burstProfile.reduceRampUpRate();
        const newRate = this.burstProfile.getRampUpRateMsgPerSec();
        this.tokenBucket.setRefillRate(Math.max(this.config.minRefillRate, newRate));
      }
    });

    this.deliveryMetrics.onLatencyReduce((phoneNumberId, latencyMs) => {
      console.log(`\n⚠️ [Engine] Latency reduce triggered: phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}ms`);
      if (!this.decisionEngine) {
        const newRate = this.tokenBucket.getStats().refillRate * 0.7;
        this.tokenBucket.setRefillRate(Math.max(this.config.minRefillRate, newRate));
      }
    });

    this.deliveryMetrics.onLatencyWarning((phoneNumberId, latencyMs) => {
      console.log(`\n⚠️ [Engine] Latency warning: phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}ms`);
    });

    this.deliveryMetrics.onLatencyAutoPause((phoneNumberId, latencyMs) => {
      console.log(`\n🚨 [Engine] Latency auto-pause: phoneNumberId=${phoneNumberId} latencyMs=${latencyMs}ms`);
      if (!this.decisionEngine) this.pause();
    });

    this.phoneReputationScore.onReduceLoad((phoneId, rep) => {
      console.log(`[REPUTATION] Reduce load for phoneId=${phoneId} score=${rep.score.toFixed(3)}`);
      if (this.multiPhoneCoordinator) {
        this.multiPhoneCoordinator.setPhoneWeight(phoneId, 0.4);
      }
      if (!this.decisionEngine) {
        const newRate = this.tokenBucket.getStats().refillRate * 0.6;
        this.tokenBucket.setRefillRate(Math.max(this.config.minRefillRate, newRate));
      }
    });

    this.phoneReputationScore.onDisableTemp((phoneId, rep) => {
      console.log(`[REPUTATION] Disable temp for phoneId=${phoneId} score=${rep.score.toFixed(3)} — pausing engine`);
      if (this.multiPhoneCoordinator) {
        this.multiPhoneCoordinator.setPhoneWeight(phoneId, 0.0);
      }
      if (!this.decisionEngine) this.pause();
    });

    this.phoneReputationScore.onHighTrust((phoneId, rep) => {
      console.log(`[REPUTATION] High trust for phoneId=${phoneId} score=${rep.score.toFixed(3)}`);
      if (this.multiPhoneCoordinator) {
        this.multiPhoneCoordinator.setPhoneWeight(phoneId, 1.0);
      }
    });

    this.phoneReputationScore.onRecover((phoneId, rep) => {
      console.log(`[REPUTATION] Recovered phoneId=${phoneId} tier=${rep.tier} score=${rep.score.toFixed(3)}`);
      if (this.multiPhoneCoordinator) {
        const weight = rep.tier === 'HIGH_TRUST' ? 1.0 : rep.tier === 'NORMAL' ? 0.7 : 0.4;
        this.multiPhoneCoordinator.setPhoneWeight(phoneId, weight);
      }
    });
    
    this.asyncCheckpoint = new AsyncCheckpoint({
      flushIntervalMs: this.config.checkpointFlushMs,
      maxLogBuffer: 100
    });
    
    this.retryQueue = new RetryQueue({
      maxRetries: this.config.maxRetries,
      baseDelayMs: this.config.baseRetryDelayMs,
      maxDelayMs: this.config.maxRetryDelayMs,
      rateLimitDelayMs: 15000,
      backoffMultiplier: 2.0
    });
    
    this.safeMode = new SafeMode({
      ...DEFAULT_SAFE_MODE_CONFIG,
      ...this.config.safeMode
    });
    
    this.errorClassification = new ErrorClassification();
    this.riskEngine = new RiskEngine();
    this.blockWindow = new SlidingWindowMetrics(200);
    this.errorWindow = new SlidingWindowMetrics(200);
    
    this.humanBehavior = new HumanBehavior({
      baseType: config.baseType || 'hot',
      templateWeights: config.templateWeights || {},
      ...config.humanBehavior,
    });
    this.templatePacingBackoff = new TemplatePacingBackoff();
    
    this.stats = this.createInitialStats('');
    this.setupCallbacks();
  }

  private setupCallbacks(): void {
    this.pipeline.setResultCallback((result, leadIndex, rttMs) => {
      this.onRequestComplete(result, rttMs, leadIndex);
    });
    
    this.pipeline.setErrorCallback((error, leadIndex, rttMs) => {
      const errorResult: SendResult = {
        success: false,
        rttMs,
        error: error?.message || 'Pipeline error',
        leadIndex
      };
      this.onRequestComplete(errorResult, rttMs, leadIndex);
    });
    
    
    this.safeMode.onActivate((reason) => {
      this.applyConfigForSafeMode(true);
      this.asyncCheckpoint.warn(`SafeMode ativado: ${reason}`);
    });
    
    this.safeMode.onDeactivate(() => {
      this.applyConfigForSafeMode(false);
      this.asyncCheckpoint.info('SafeMode desativado');
    });
    
    this.retryQueue.setRetryCallback(async (item: RetryItem<LeadWithIndex>) => {
      return this.executeRetry(item);
    });
    
    this.retryQueue.setExhaustedCallback((item: RetryItem<LeadWithIndex>) => {
      this.failedCount++;
      this.processedCount++;
      const leadPhone = item.leadData.lead?.phone || '';
      this.onSendResultCallback?.({ success: false, phone: leadPhone, error: item.lastError, errorType: 'exhausted' });
      this.etaCalculator.recordProgress(this.successCount);
      this.updateStats();
      this.onProgressCallback?.(this.stats);
      this.asyncCheckpoint.error(`Lead ${item.leadIndex} esgotou tentativas`, {
        attempts: item.attempts,
        lastError: item.lastError
      });
    });
    
    this.retryQueue.setCanRetryCheck(() => {
      return true;
    });
  }

  private applyConfigForSafeMode(enabled: boolean): void {
    if (enabled) {
      const safeConfig = this.safeMode.getEffectiveConfig();
      const tierCappedRate = Math.min(safeConfig.maxRefillRate, this.config.maxRefillRate);
      
      this.tokenBucket.setRefillRate(Math.min(
        this.tokenBucket.getStats().refillRate,
        tierCappedRate
      ));
      this.tokenBucket.updateMaxRefillRate(tierCappedRate);
      
      if (safeConfig.rampUpDisabled) {
        this.burstProfile.forceAdaptive();
      }
      
      console.log(`\n🛡️ SafeMode aplicado:`);
      console.log(`   📉 Taxa máxima: ${tierCappedRate} msg/s`);
      console.log(`   🔄 Concorrência: ${safeConfig.maxConcurrentRequests}`);
      console.log(`   💥 Burst máx: ${safeConfig.burstMultiplierMax}x`);
    } else {
      this.tokenBucket.updateMaxRefillRate(this.config.maxRefillRate);
      console.log(`\n✅ SafeMode desativado - taxa máxima restaurada: ${this.config.maxRefillRate} msg/s`);
    }
  }

  private async executeRetry(item: RetryItem<LeadWithIndex>): Promise<{ success: boolean; error?: string; isRateLimitError?: boolean }> {
    if (!this.currentTemplate || !this.currentMetaToken) {
      return { success: false, error: 'Configuração ausente para retry' };
    }

    // For multi-WABA: resolve the token for the phone that originally sent this job
    const jobCtx = this.jobContextMap.get(item.leadData.index);
    const retryPhoneId = jobCtx?.phoneId || this.currentPhoneNumberId;
    let retryToken = this.currentMetaToken;
    if (this.config.wabaConfigs.length > 1) {
      const ownerWaba = this.config.wabaConfigs.find(w => w.phoneNumberIds.includes(retryPhoneId));
      if (ownerWaba) {
        retryToken = ownerWaba.accessToken;
      }
    }
    
    const sendFn = this.createSendFunction(
      retryPhoneId,
      item.leadData.lead,
      this.currentTemplate,
      retryToken,
      this.currentForcedLanguage,
      item.leadData.index
    );
    
    const result = await sendFn();
    this.totalRetries++;
    
    const leadPhone = item.leadData.lead?.phone || '';
    
    if (result.success) {
      this.successCount++;
      this.processedCount++;
      this.rttWindow.add(result.rttMs);
      this.errorClassification.recordSuccess();
      this.onSendResultCallback?.({ success: true, phone: leadPhone, isRetry: true });
      this.etaCalculator.recordProgress(this.successCount);
      this.updateStats();
      this.onProgressCallback?.(this.stats);
    } else {
      this.onSendResultCallback?.({ success: false, phone: leadPhone, error: result.error, isRetry: true });
    }
    
    return {
      success: result.success,
      error: result.error,
      isRateLimitError: result.isRateLimitError
    };
  }

  private onRequestComplete(result: SendResult, rttMs: number, leadIndex: number): void {
    const leadPhone = this.currentLeads[leadIndex]?.phone || '';
    const jobCtx = this.jobContextMap.get(leadIndex);
    const jobPhoneId = jobCtx?.phoneId || this.currentPhoneNumberId;
    const jobTemplateName = jobCtx?.templateName || this.currentTemplate?.name || 'unknown';

    if (result.success) {
      this.processedCount++;
      this.successCount++;
      this.consecutiveErrors = 0;
      
      this.humanBehavior.recordSent(jobPhoneId);

      const campaignIdForTracking = this.stats.campaignId;
      const ownerWabaForPhone = this.config.wabaConfigs.find(w => w.phoneNumberIds.includes(jobPhoneId));
      const wabaIdForTracking = ownerWabaForPhone?.wabaId || this.config.wabaConfigs[0]?.wabaId;
      const msgIdForTracking = result.messageId || `tmp-${Date.now()}-${leadIndex}`;
      this.deliveryMetrics.recordSent(jobTemplateName, jobPhoneId, msgIdForTracking, campaignIdForTracking, wabaIdForTracking);
      if (result.messageId && jobTemplateName) {
        deliveryMetricsTracker.recordSent(jobTemplateName, jobPhoneId, result.messageId, campaignIdForTracking, wabaIdForTracking);
      }

      if (this.decisionEngine) {
        this.decisionEngine.recordDeliveryForWaba(jobPhoneId, 'sent');
      }

      if (this.wabaScorer && wabaIdForTracking) {
        this.wabaScorer.recordResult(wabaIdForTracking, 'success', rttMs);
      }

      const pacingTest = this.pacingTestJobs.get(leadIndex);
      if (pacingTest) {
        this.templatePacingBackoff.recordTestSuccess(pacingTest.phoneId, pacingTest.templateName);
        console.log(`✅ [TemplatePacing] Teste de liberação bem-sucedido para ${pacingTest.phoneId}/${pacingTest.templateName}`);
        this.pacingTestJobs.delete(leadIndex);
      }
      
      const senderCount = (this.senderSentCounters.get(jobPhoneId) || 0) + 1;
      this.senderSentCounters.set(jobPhoneId, senderCount);
      
      if (this.useSenderPool) {
        incrementSender(jobPhoneId).catch(err => {
          logError('engine.incrementSender', { campaignId: this.stats.campaignId, phoneNumberId: jobPhoneId }, err);
        });
      }
      
      this.blockWindow.add(0);
      this.errorWindow.add(0);
      
      this.rttWindow.add(rttMs);
      this.adjustRateByRtt();
      
      this.burstProfile.onRecovery();
      this.errorClassification.recordSuccess();
      this.safeMode.recordResult(true, false);


      db.insert(messageDeliveries).values({
        campaignId: this.stats.campaignId,
        leadId: this.currentLeads[leadIndex]?.id || String(leadIndex),
        phoneNumber: leadPhone,
        messageId: result.messageId || null,
        status: 'sent',
        sentAt: new Date(),
      }).catch(err => {
        logError('engine.insertDelivery.sent', { campaignId: this.stats.campaignId, phone: leadPhone, leadIndex }, err);
      });

      const successTemplateName = jobCtx?.templateName;
      if (successTemplateName) {
        const currentScore = getTemplatePerformance(successTemplateName);
        updateTemplatePerformance(successTemplateName, currentScore + 0.02);
        recordTemplateSent(successTemplateName);
        if (result.messageId) {
          registerMessageTemplate(result.messageId, successTemplateName);
        }
      }

      this.onSendResultCallback?.({ success: true, phone: leadPhone });
      this.jobContextMap.delete(leadIndex);
    } else {
      const errorCode = this.extractErrorCode(result.error);
      const errorType = this.errorClassification.classify(
        errorCode,
        result.error || 'Unknown error',
        jobPhoneId,
        leadIndex
      );
      
      const errorMessage = result.error || 'Unknown error';
      
      if (this.decisionEngine) {
        this.decisionEngine.recordDeliveryForWaba(jobPhoneId, 'failed');
      }

      if (this.wabaScorer) {
        const ownerWaba = this.config.wabaConfigs.find(w => w.phoneNumberIds.includes(jobPhoneId));
        const wid = ownerWaba?.wabaId || this.config.wabaConfigs[0]?.wabaId;
        if (wid) {
          const isBlock = errorType === 'environment' || errorCode === 131026 || errorCode === 368 || errorCode === 131031;
          this.wabaScorer.recordResult(wid, isBlock ? 'block' : 'fail');
        }
      }

      db.insert(messageDeliveries).values({
        campaignId: this.stats.campaignId,
        leadId: this.currentLeads[leadIndex]?.id || String(leadIndex),
        phoneNumber: leadPhone,
        status: 'failed',
        errorMessage: errorMessage,
        sentAt: new Date(),
      }).catch(err => {
        logError('engine.insertDelivery.failed', { campaignId: this.stats.campaignId, phone: leadPhone, leadIndex }, err);
      });

      db.insert(campaignErrorLogs).values({
        campaignId: this.stats.campaignId,
        errorCode: String(errorCode || 'UNKNOWN'),
        errorMessage: errorMessage,
        phone: leadPhone,
        phoneNumberId: jobPhoneId,
      }).catch(err => {
        logError('engine.insertCampaignErrorLog', { campaignId: this.stats.campaignId, phone: leadPhone, phoneNumberId: jobPhoneId }, err);
      });

      const failedTemplateName = jobCtx?.templateName;
      if (failedTemplateName) {
        const currentScore = getTemplatePerformance(failedTemplateName);
        updateTemplatePerformance(failedTemplateName, currentScore - 0.1);
        if (errorType === 'environment' || errorCode === 131026 || errorCode === 368 || errorCode === 131031) {
          recordTemplateBlocked(failedTemplateName);
        }
      }

      if (errorType === 'environment') {
        this.processedCount++;
        this.metaBlockedCount++;
        this.consecutiveErrors++;
        this.blockWindow.add(1);
        this.errorWindow.add(0);
        this.deliveryMetrics.recordBlockEvent(jobPhoneId);
        this.asyncCheckpoint.warn(`Lead ${leadIndex} bloqueado pela Meta (ambiente)`, { error: result.error, type: errorType });
        this.onSendResultCallback?.({ success: false, phone: leadPhone, error: result.error, errorType: 'environment', isMetaBlocked: true });
      } else {
        const isRateLimitError = result.isRateLimitError || errorType === 'rate_limit';
        
        this.consecutiveErrors++;
        this.blockWindow.add(0);
        this.errorWindow.add(1);
        
        if (isRateLimitError && this.useSenderPool && (errorCode === 134912 || errorCode === 131048 || errorCode === 135000 || errorCode === 131056)) {
          this.asyncCheckpoint.warn(`[SenderPool] Fail-over ativado: erro ${errorCode} no sender ${jobPhoneId}`);
          console.log(`\n🔴 [SenderPool] Fail-over: erro ${errorCode} no sender ${jobPhoneId}`);
          markDead(jobPhoneId).catch(e => logError('engine.markDead', { campaignId: this.stats.campaignId, phoneNumberId: jobPhoneId, errorCode }, e));
          nextSender(jobPhoneId).then(next => {
            console.log(`🔄 [SenderPool] Fail-over: trocando para ${next.phoneNumberId} (${next.sentToday}/${next.dailyQuota})`);
            this.currentPhoneNumberId = next.phoneNumberId;
            this.asyncCheckpoint.info(`SenderPool: fail-over para ${next.phoneNumberId}`);
          }).catch(e => {
            logError('UltraStableEngine.senderPoolFailover', {}, e);
            this.asyncCheckpoint.error(`SenderPool: sem sender para fail-over: ${e.message}`);
          });
        }
        
        this.safeMode.recordResult(false, isRateLimitError);
        
        this.burstProfile.onStressDetected();
        
        const isTemplatePacing = errorCode === 130429 || errorCode === 131048 || errorCode === 135000;
        if (isTemplatePacing) {
          const pacingTest = this.pacingTestJobs.get(leadIndex);
          if (pacingTest) {
            this.templatePacingBackoff.recordTestFailure(pacingTest.phoneId, pacingTest.templateName);
            console.log(`❌ [TemplatePacing] Teste de liberação falhou para ${pacingTest.phoneId}/${pacingTest.templateName}`);
            this.pacingTestJobs.delete(leadIndex);
          } else {
            this.templatePacingBackoff.recordPacingError(jobPhoneId, jobTemplateName);
          }
          const backoffMs = this.templatePacingBackoff.getBackoffMs(jobPhoneId, jobTemplateName);
          const rateReduction = this.templatePacingBackoff.getRateReduction();
          const preRate = this.tokenBucket.getStats().refillRate;
          const newRate = Math.max(this.config.minRefillRate, preRate * rateReduction);
          this.tokenBucket.setRefillRate(newRate);
          this.tokenBucket.endBurstPhase();
          this.asyncCheckpoint.warn(`[TemplatePacing] Erro ${errorCode} detectado, rate ${preRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s, backoff ${Math.round(backoffMs / 1000)}s no sender ${jobPhoneId} template ${jobTemplateName}`);
          console.log(`\n⏱️ [TemplatePacing] Erro ${errorCode}: rate ${preRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s, backoff ${Math.round(backoffMs / 1000)}s para ${jobPhoneId}/${jobTemplateName}`);
        }

        const isPayloadError = errorType === 'payload' || (result.error?.includes('131008'));
        const isRetryableError = !isPayloadError && (isRateLimitError || isTemplatePacing || errorType === 'network' || (errorCode && errorCode >= 500));
        
        if (isRetryableError && this.currentLeads[leadIndex]) {
          const enqueued = this.retryQueue.enqueue(
            leadIndex,
            { lead: this.currentLeads[leadIndex], index: leadIndex },
            result.error || 'Unknown error',
            errorCode,
            isRateLimitError,
            0
          );
          
          if (enqueued) {
            this.asyncCheckpoint.warn(`Lead ${leadIndex} adicionado à fila de retry`, { error: result.error, type: errorType });
          } else {
            this.processedCount++;
            this.failedCount++;
            this.asyncCheckpoint.error(`Lead ${leadIndex} esgotou tentativas`, { error: result.error, type: errorType });
            this.onSendResultCallback?.({ success: false, phone: leadPhone, error: result.error, errorType: String(errorType) });
          }
        } else {
          this.processedCount++;
          this.failedCount++;
          if (isPayloadError) {
            this.asyncCheckpoint.error(`Lead ${leadIndex} erro de payload (definitivo, sem retry)`, { error: result.error, type: errorType });
          } else {
            this.asyncCheckpoint.error(`Lead ${leadIndex} falhou sem retry disponível`, { error: result.error, type: errorType });
          }
          this.onSendResultCallback?.({ success: false, phone: leadPhone, error: result.error, errorType: String(errorType) });
        }
      }
    }
    
    this.etaCalculator.recordProgress(this.successCount);
    
    this.saveCheckpointAsync(leadIndex);

    checkpointStore.save({
      campaignId: this.stats.campaignId,
      phoneNumberId: this.stats.phoneNumberId,
      lastProcessedIndex: leadIndex,
      successCount: this.successCount,
      failedCount: this.failedCount,
      blockedCount: this.metaBlockedCount,
      timestamp: Date.now(),
    });
    
    this.evaluateRisk();
    
    this.updateStats();
    this.onProgressCallback?.(this.stats);
  }

  private extractErrorCode(error?: string): number | undefined {
    if (!error) return undefined;
    
    const match = error.match(/(\d{5,6})/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private adjustRateByRtt(): void {
    if (!this.rttWindow.hasEnoughData()) return;
    
    const stats = this.rttWindow.getStats();
    if (stats.p95 < this.config.targetRttMs * 0.7 && stats.trend !== 'increasing') {
      this.tokenBucket.accelerate(10);
    }
  }

  private evaluateRisk(): void {
    if (this.processedCount < 20) return;
    if (this.blockWindow.getCount() < 20 && this.errorWindow.getCount() < 20) return;

    if (this.riskEngine.isInCooldown()) return;

    const rttStats = this.rttWindow.getStats();
    const riskParams = {
      blockRateWindow: this.blockWindow.getRate(),
      errorRateWindow: this.errorWindow.getRate(),
      consecutiveErrors: this.consecutiveErrors,
      rttAverage: rttStats.avg,
      currentSpeed: this.tokenBucket.getStats().refillRate,
    };

    const result = this.riskEngine.assess(riskParams);
    if (result.action !== 'KEEP') {
      this.applyRiskAction(result.action, result.details);
    }

    if (this.decisionEngine) {
      this.decisionEngine.evaluateRiskResult(result, this.currentPhoneNumberId);
    }
  }

  private shouldLogProgress(): boolean {
    return Date.now() - this.lastProgressLogTime >= this.progressLogIntervalMs;
  }

  private applyRiskAction(action: RiskAction, details: string): void {
    const currentRate = this.tokenBucket.getStats().refillRate;

    switch (action) {
      case 'REDUCE_20': {
        const newRate = Math.max(this.config.minRefillRate, currentRate * 0.8);
        this.tokenBucket.setRefillRate(newRate);
        this.asyncCheckpoint.info(`RiskEngine: REDUCE_20 aplicado (${currentRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s) → ${details}`);
        console.log(`\n⚠️ [RiskEngine] REDUCE_20: taxa reduzida ${currentRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s`);
        break;
      }
      case 'REDUCE_50': {
        const newRate = Math.max(this.config.minRefillRate, currentRate * 0.5);
        this.tokenBucket.setRefillRate(newRate);
        this.tokenBucket.endBurstPhase();
        this.asyncCheckpoint.warn(`RiskEngine: REDUCE_50 aplicado (${currentRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s) → ${details}`);
        console.log(`\n🔴 [RiskEngine] REDUCE_50: taxa reduzida ${currentRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s`);
        break;
      }
      case 'COOLDOWN': {
        const cooldownMs = 120_000;
        const newRate = Math.max(this.config.minRefillRate, currentRate * 0.3);
        this.tokenBucket.setRefillRate(newRate);
        this.tokenBucket.endBurstPhase();
        this.asyncCheckpoint.warn(`RiskEngine: COOLDOWN aplicado (${currentRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s, cooldown ${cooldownMs / 1000}s) → ${details}`);
        console.log(`\n🛑 [RiskEngine] COOLDOWN: taxa ${currentRate.toFixed(1)} → ${newRate.toFixed(1)} msg/s, cooldown ${cooldownMs / 1000}s`);
        if (this.riskCooldownTimer) clearTimeout(this.riskCooldownTimer);
        this.riskCooldownTimer = setTimeout(() => {
          const targetRate = Math.min(this.config.initialRefillRate, this.config.maxRefillRate);
          this.riskEngine.startGradualRecovery(currentRate, targetRate, 5, 30000);
          const startRate = Math.max(this.config.minRefillRate, targetRate * 0.3);
          this.tokenBucket.setRefillRate(startRate);
          this.asyncCheckpoint.info(`RiskEngine: cooldown expirado, recuperação gradual iniciada ${startRate.toFixed(1)} → ${targetRate.toFixed(1)} msg/s`);
          console.log(`\n🔄 [RiskEngine] Cooldown expirado, recuperação gradual: ${startRate.toFixed(1)} → ${targetRate.toFixed(1)} msg/s`);
          this.startRecoveryCheck();
          this.riskCooldownTimer = null;
        }, cooldownMs);
        break;
      }
      case 'PAUSE': {
        const blockRate = this.blockWindow.getRate();
        const threshold = this.config.blockRateAutoPauseThreshold;
        this.asyncCheckpoint.error(`RiskEngine: PAUSE aplicado — SafeMode ativado → ${details} (blockRate=${(blockRate * 100).toFixed(1)}% threshold=${(threshold * 100).toFixed(0)}%)`);
        console.log(`\n🚨 [RiskEngine] PAUSE: ativando SafeMode por risco crítico (blockRate=${(blockRate * 100).toFixed(1)}%)`);
        this.safeMode.activate('risk_engine_pause');
        if (blockRate >= threshold) {
          // SOFT MODE: never globally pause — log + SafeMode (rate-reduce) handles back-off.
          // WabaScorer soft-quarantines per-WABA; engine keeps sending continuously.
          console.log(`\n⚠️ [RiskEngine] BLOCK RATE HIGH (soft): blockRate=${(blockRate * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}% — SafeMode active, continuing.`);
          this.asyncCheckpoint.warn(`RiskEngine: SafeMode mantido por block rate alto (${(blockRate * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}%) — campanha NÃO pausada.`);
        }
        break;
      }
    }
  }

  private startPhoneWeightSync(): void {
    if (this.phoneWeightSyncTimer) clearInterval(this.phoneWeightSyncTimer);
    this.phoneWeightSyncTimer = setInterval(() => {
      if (!this.multiPhoneCoordinator) return;
      const reputations = this.phoneReputationScore.getAllReputations();
      for (const rep of reputations) {
        let weight: number;
        switch (rep.tier) {
          case 'HIGH_TRUST': weight = 1.0; break;
          case 'NORMAL': weight = 0.7; break;
          case 'REDUCE_LOAD': weight = 0.4; break;
          case 'DISABLE_TEMP': weight = 0.0; break;
          default: weight = 0.7;
        }
        this.multiPhoneCoordinator.setPhoneWeight(rep.phoneNumberId, weight);
      }
    }, 60_000);
  }

  private startRecoveryCheck(): void {
    if (this.recoveryCheckTimer) clearInterval(this.recoveryCheckTimer);
    this.recoveryCheckTimer = setInterval(() => {
      const nextRate = this.riskEngine.getNextRecoveryRate();
      if (nextRate !== null) {
        this.tokenBucket.setRefillRate(Math.max(this.config.minRefillRate, Math.min(nextRate, this.config.maxRefillRate)));
        this.asyncCheckpoint.info(`RiskEngine: recuperação gradual → ${nextRate.toFixed(1)} msg/s`);
        console.log(`\n📈 [RiskEngine] Recuperação gradual: taxa → ${nextRate.toFixed(1)} msg/s`);
      }
      if (!this.riskEngine.isRecovering()) {
        if (this.recoveryCheckTimer) {
          clearInterval(this.recoveryCheckTimer);
          this.recoveryCheckTimer = null;
        }
        this.asyncCheckpoint.info(`RiskEngine: recuperação gradual completa`);
        console.log(`\n✅ [RiskEngine] Recuperação gradual completa`);
      }
    }, 5000);
  }

  private createInitialStats(campaignId: string): UltraStableStats {
    return {
      campaignId,
      totalLeads: 0,
      processedLeads: 0,
      successfulSends: 0,
      failedSends: 0,
      metaBlockedSends: 0,
      preflightFailed: 0,
      startTime: 0,
      currentRate: 0,
      peakRate: 0,
      averageRttMs: 0,
      p95RttMs: 0,
      burstState: this.burstProfile.getState(),
      circuitBreakerTrips: 0,
      totalRetries: 0,
      phoneNumberId: '',
      displayPhoneNumber: '',
      tokenBucketRate: this.config.initialRefillRate,
      circuitState: 'CLOSED',
      inFlightRequests: 0,
      eta: this.etaCalculator.getEstimate(),
      retryQueue: this.retryQueue.getStats(),
      errorCounts: this.errorClassification.getCounts(),
      safeModeState: this.safeMode.getState()
    };
  }

  private sanitizeCpf(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length !== 11) return null;
    return digits;
  }

  private sanitizeName(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const cleaned = raw
      .replace(/['"]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  private sanitizeCustomMessage(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 1024) return trimmed.slice(0, 1024);
    return trimmed;
  }

  private resolveLeadTags(text: string, lead: Lead): string {
    return this.resolveLeadTagsWithMissing(text, lead).resolvedText;
  }

  private resolveLeadTagsWithMissing(text: string, lead: Lead): { resolvedText: string; missingTags: string[] } {
    const l = lead as any;
    const knownAliases: Record<string, () => string> = {
      cpf: () => l.doc || l.cpf || l.documento || '',
      nome: () => l.name || l.nome || l.Name || '',
      name: () => l.name || l.nome || l.Name || '',
      telefone: () => l.phone || l.telefone || '',
      phone: () => l.phone || l.telefone || '',
      email: () => l.email || '',
      produto: () => l.produto || l.product || '',
      product: () => l.produto || l.product || '',
      valor: () => l.valor || l.value || l.price || '',
      value: () => l.valor || l.value || l.price || '',
      codigo_rastreio: () => l.codigoRastreio || l.codigo_rastreio || l.tracking || '',
      codigoRastreio: () => l.codigoRastreio || l.codigo_rastreio || l.tracking || '',
      endereco: () => l.endereco || l.address || '',
      address: () => l.endereco || l.address || '',
      link: () => l.link || l.url || '',
      url: () => l.link || l.url || '',
    };
    const missingTags: string[] = [];
    const resolvedText = text.replace(/\{([^}]+)\}/gi, (_match, fieldName: string) => {
      const key = fieldName.trim().toLowerCase();
      if (knownAliases[key]) {
        const val = knownAliases[key]();
        if (!val) missingTags.push(fieldName.trim());
        return val;
      }
      if (l[fieldName] !== undefined && l[fieldName] !== null) return String(l[fieldName]);
      if (l[key] !== undefined && l[key] !== null) return String(l[key]);
      const camelCase = key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
      if (l[camelCase] !== undefined && l[camelCase] !== null) return String(l[camelCase]);
      missingTags.push(fieldName.trim());
      return '';
    });
    return { resolvedText, missingTags };
  }

  private getDynamicParamValue(paramNum: number, lead: Lead, totalBodyParams: number = 6): string | null {
    const customMsg = (lead as any)[`customMessage${paramNum}`];
    if (customMsg) {
      const resolved = this.resolveLeadTags(customMsg, lead);
      return this.sanitizeCustomMessage(resolved);
    }

    const leadFields = ['name', 'cpf', 'email', 'produto', 'valor', 'endereco', 'codigoRastreio', 'link'];
    const l = lead as any;
    const availableValues: string[] = [];
    for (const field of leadFields) {
      const val = l[field];
      if (val && typeof val === 'string' && val.trim()) {
        availableValues.push(val.trim());
      }
    }
    if (paramNum <= availableValues.length) {
      const val = availableValues[paramNum - 1];
      if (leadFields[paramNum - 1] === 'name') return this.sanitizeName(val);
      if (leadFields[paramNum - 1] === 'cpf') return this.sanitizeCpf(val);
      return val;
    }

    switch (paramNum) {
      case 1: {
        const nameRaw = l.name || l.nome || l.Name || '';
        return this.sanitizeName(nameRaw);
      }
      case 2: {
        const cpfRaw = l.doc || l.cpf || l.documento || '';
        return this.sanitizeCpf(cpfRaw);
      }
      case 3: {
        return l.email || l.produto || l.product || null;
      }
      case 4: {
        return l.valor || l.value || l.price || null;
      }
      case 5: {
        return l.endereco || l.address || null;
      }
      case 6: {
        return (lead as any).link || (lead as any).url || null;
      }
      default:
        return null;
    }
  }

  private resolveConfiguredParam(paramValue: string, lead: Lead): string {
    if (!paramValue) return '';
    return this.resolveParamWithNomeCpf(paramValue, lead);
  }

  private resolveParamWithNomeCpf(text: string, lead: Lead): string {
    if (!text) return text;
    const l = lead as any;
    return text
      .replace(/\{nome\}/gi, l.name || l.nome || l.Name || '')
      .replace(/\{cpf\}/gi, l.doc || l.cpf || l.documento || '');
  }

  private resolveTemplateParamConfig(template: WhatsAppTemplate, lead: Lead): void {
    const tplParamConfig = (lead as any)._templateParamConfig;
    if (!tplParamConfig) return;
    const paramMap = tplParamConfig[template.id]
      || tplParamConfig[(template as any).templateId]
      || tplParamConfig[template.name]
      || {};
    if (Object.keys(paramMap).length === 0) return;
    for (const [paramKey, paramValue] of Object.entries(paramMap)) {
      if (typeof paramValue !== 'string') continue;
      if (paramKey.startsWith('body_')) {
        const paramNum = paramKey.replace('body_', '');
        if (paramNum) (lead as any)[`customMessage${paramNum}`] = paramValue;
      } else if (paramKey.startsWith('header_')) {
        const paramNum = paramKey.replace('header_', '');
        if (paramNum) (lead as any)[`headerParam${paramNum}`] = paramValue;
      } else if (paramKey.startsWith('button_')) {
        const parts = paramKey.split('_');
        const btnIdx = parts[1];
        const paramNum = parts[2];
        if (btnIdx !== undefined && paramNum) (lead as any)[`buttonParam${btnIdx}_${paramNum}`] = paramValue;
      } else {
        const paramNum = paramKey.replace(/\D/g, '');
        if (paramNum) (lead as any)[`customMessage${paramNum}`] = paramValue;
      }
    }
  }

  private prepareTemplateParameters(template: WhatsAppTemplate, lead: Lead): {
    headerParameters: any[];
    bodyParameters: any[];
    buttonParameters: any[];
    abortReason: string | null;
  } {
    this.resolveTemplateParamConfig(template, lead);

    const headerParameters: any[] = [];
    const bodyParameters: any[] = [];
    const buttonParameters: any[] = [];
    
    if (template.components && Array.isArray(template.components)) {
      for (const component of template.components) {
        if (component.type === 'HEADER' && component.format === 'TEXT' && component.text) {
          const paramMatches = component.text.match(/\{\{\d+\}\}/g);
          if (paramMatches) {
            const paramNumbers = paramMatches.map((m: string) => parseInt(m.replace(/[{}]/g, '')));
            const uniqueParams = Array.from<number>(new Set(paramNumbers)).sort((a, b) => a - b);
            for (const paramNum of uniqueParams) {
              const configured = (lead as any)[`headerParam${paramNum}`];
              if (!configured && configured !== '') {
                return { headerParameters: [], bodyParameters: [], buttonParameters: [], abortReason: `Header param {{${paramNum}}} não configurado no wizard — configure o texto para este parâmetro antes de enviar` };
              }
              const resolved = this.resolveParamWithNomeCpf(String(configured), lead);
              if (!resolved || resolved.trim() === '') {
                return { headerParameters: [], bodyParameters: [], buttonParameters: [], abortReason: `Header param {{${paramNum}}} está vazio para lead ${lead.phone}` };
              }
              headerParameters.push({ type: 'text', text: resolved });
            }
          }
        }

        if (component.type === 'BODY' && component.text) {
          const paramMatches = component.text.match(/\{\{\d+\}\}/g);
          if (paramMatches) {
            const paramNumbers = paramMatches.map((match: string) => parseInt(match.replace(/[{}]/g, '')));
            const uniqueParams = Array.from<number>(new Set(paramNumbers)).sort((a, b) => a - b);
            
            for (const paramNum of uniqueParams) {
              const configuredRaw = (lead as any)[`customMessage${paramNum}`];
              const hasWizardConfig = configuredRaw !== undefined && configuredRaw !== null;
              if (hasWizardConfig) {
                const configuredText = String(configuredRaw);
                if (configuredText.trim() === '') {
                  return { headerParameters: [], bodyParameters: [], buttonParameters: [], abortReason: `Parâmetro {{${paramNum}}} configurado no wizard está vazio para lead ${lead.phone}` };
                }
                const resolvedText = this.resolveParamWithNomeCpf(configuredText, lead);
                const sanitized = this.sanitizeCustomMessage(resolvedText);
                if (!sanitized) {
                  return { headerParameters: [], bodyParameters: [], buttonParameters: [], abortReason: `Parâmetro {{${paramNum}}} resolveu para vazio para lead ${lead.phone}` };
                }
                bodyParameters.push({ type: 'text', text: sanitized });
              } else {
                return { headerParameters: [], bodyParameters: [], buttonParameters: [], abortReason: `Parâmetro {{${paramNum}}} não configurado no wizard — configure o texto para este parâmetro antes de enviar` };
              }
            }
          }
        }
        
        if (component.type === 'BUTTONS' && component.buttons) {
          for (let btnIdx = 0; btnIdx < component.buttons.length; btnIdx++) {
            const button = component.buttons[btnIdx];
            if (button.type === 'URL' && button.url) {
              const urlParams = button.url.match(/\{\{\d+\}\}/g);
              if (urlParams) {
                for (const param of urlParams) {
                  const paramNum = parseInt(param.replace(/[{}]/g, ''));
                  const configuredBtnParam = (lead as any)[`buttonParam${btnIdx}_${paramNum}`];
                  if (configuredBtnParam) {
                    const resolved = this.resolveConfiguredParam(configuredBtnParam, lead);
                    if (resolved) {
                      buttonParameters.push({ type: 'text', text: resolved.replace(/^https?:\/\//, '') });
                      continue;
                    }
                  }
                  return { headerParameters: [], bodyParameters: [], buttonParameters: [], abortReason: `Parâmetro de URL {{${paramNum}}} do botão não configurado no wizard — configure o texto para este parâmetro antes de enviar (use {cpf} para URL dinâmica)` };
                }
              }
            }
          }
        }
      }
    }
    
    return { headerParameters, bodyParameters, buttonParameters, abortReason: null };
  }

  private templateHasImageHeader(template: WhatsAppTemplate): boolean {
    if (!template.components) return false;
    return template.components.some((c: any) => c.type === 'HEADER' && c.format === 'IMAGE');
  }

  /**
   * Resolve audio URL → Meta media_id (cached per phoneNumberId+url).
   * Downloads the audio, converts to OGG/Opus if needed (via ffmpeg), uploads to Meta,
   * and returns a media_id ready to be sent as a voice note.
   * Concurrent calls for the same key share a single in-flight promise (no duplicate work).
   */
  private async getOrPrepareAudioMediaId(
    audioUrl: string,
    phoneNumberId: string,
    metaToken: string
  ): Promise<string> {
    const cacheKey = `${phoneNumberId}::${audioUrl}`;
    const cached = this.audioMediaIdCache.get(cacheKey);
    if (cached) return cached;

    const inflight = this.audioPrepareInflight.get(cacheKey);
    if (inflight) return inflight;

    const job = (async () => {
      const { buffer: rawBuffer, mimeType: rawMime, filename: srcFilename } = await fetchAudioBuffer(audioUrl);
      const detected = detectAudioFormat(rawBuffer);

      let finalBuffer: Buffer;
      let finalMime: string;
      let finalFilename: string;

      if (detected === 'ogg') {
        finalBuffer = rawBuffer;
        finalMime = 'audio/ogg';
        finalFilename = srcFilename.replace(/\.[^.]+$/, '') + '.ogg';
      } else {
        const ffmpegOk = await isFfmpegAvailable();
        if (!ffmpegOk) {
          throw new Error(`Áudio em formato ${detected} requer ffmpeg para converter para OGG/Opus, mas ffmpeg não está disponível.`);
        }
        const tmp = path.join(process.cwd(), 'uploads', `engine_audio_tmp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.audio`);
        finalBuffer = await convertBufferToOgg(rawBuffer, tmp);
        finalMime = 'audio/ogg';
        finalFilename = (srcFilename || 'audio').replace(/\.[^.]+$/, '') + '.ogg';
      }

      console.log(`[UltraStableEngine.audio] preparado para upload: phoneNumberId=${phoneNumberId} src=${srcFilename} rawMime=${rawMime} detected=${detected} bytes=${finalBuffer.length}`);
      const mediaId = await metaAPI.uploadMediaToMeta(phoneNumberId, finalBuffer, finalMime, finalFilename, metaToken);
      this.audioMediaIdCache.set(cacheKey, mediaId);
      console.log(`[UltraStableEngine.audio] mediaId obtido e cacheado: ${mediaId} (key=${cacheKey.substring(0, 80)}...)`);
      return mediaId;
    })();

    this.audioPrepareInflight.set(cacheKey, job);
    try {
      return await job;
    } finally {
      this.audioPrepareInflight.delete(cacheKey);
    }
  }

  private createSendFunction(
    phoneNumberId: string,
    lead: Lead,
    template: WhatsAppTemplate,
    metaToken: string,
    forcedLanguage?: string,
    leadIndex?: number
  ): () => Promise<SendResult> {
    return async (): Promise<SendResult> => {
      const formattedPhone = formatPhoneE164(lead.phone);
      const cleanPhone = formattedPhone.replace(/\D/g, '');
      
      if (cleanPhone.length < 12 || cleanPhone.length > 13) {
        return { success: false, rttMs: 0, error: `Número inválido: ${lead.phone}`, leadIndex };
      }
      
      const { headerParameters, bodyParameters, buttonParameters, abortReason } = this.prepareTemplateParameters(template, lead);
      
      if (abortReason) {
        return { success: false, rttMs: 0, error: `[PAYLOAD] ${abortReason}`, leadIndex };
      }

      for (const param of headerParameters) {
        if (!param.text || param.text.trim() === '') {
          return { success: false, rttMs: 0, error: `[131008] Parametro header vazio detectado pre-envio para lead ${lead.phone}`, leadIndex };
        }
      }
      for (const param of bodyParameters) {
        if (!param.text || param.text.trim() === '') {
          return { success: false, rttMs: 0, error: `[131008] Parametro body vazio detectado pre-envio para lead ${lead.phone}`, leadIndex };
        }
      }
      for (const param of buttonParameters) {
        if (!param.text || param.text.trim() === '') {
          return { success: false, rttMs: 0, error: `[131008] Parametro button vazio detectado pre-envio para lead ${lead.phone}`, leadIndex };
        }
      }

      const languageCode = forcedLanguage || template.language || 'pt_BR';

      const leadWithImage = lead as Lead & { packageImageUrl?: string; imageGenerationFailed?: boolean; campaignStaticImageUrl?: string };
      const packageImageUrl = leadWithImage.packageImageUrl;
      const staticImageCandidate = leadWithImage.campaignStaticImageUrl;
      let headerImageLink: string | undefined;
      const hasImageHeader = this.templateHasImageHeader(template);
      if (leadWithImage.imageGenerationFailed && hasImageHeader) {
        this.asyncCheckpoint.warn(`Lead ${leadIndex} (${lead.phone}): imagem não gerada, enviando sem header de imagem`);
      }

      const validateImageUrl = (candidate: string): string | undefined => {
        try {
          const parsed = new URL(candidate);
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            this.asyncCheckpoint.warn(`Lead ${leadIndex}: imagem URL não é HTTP/HTTPS, ignorando`);
            return undefined;
          }
          const blockedPatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1)/i;
          if (blockedPatterns.test(parsed.hostname)) {
            this.asyncCheckpoint.warn(`Lead ${leadIndex}: imagem URL aponta para rede interna, ignorando`);
            return undefined;
          }
          return candidate;
        } catch (e: any) {
          this.asyncCheckpoint.warn(`Lead ${leadIndex}: imagem URL inválida (parse falhou), ignorando — ${e.message}`);
          return undefined;
        }
      };

      if (hasImageHeader && staticImageCandidate) {
        headerImageLink = validateImageUrl(staticImageCandidate);
      }
      if (hasImageHeader && !headerImageLink && packageImageUrl) {
        headerImageLink = validateImageUrl(packageImageUrl);
      }

      if (hasImageHeader && !headerImageLink) {
        const headerComp = (template.components as any[])?.find((c: any) => c.type === 'HEADER' && c.format === 'IMAGE');
        const exampleHandle = headerComp?.example?.header_handle?.[0];
        if (exampleHandle && typeof exampleHandle === 'string' && exampleHandle.startsWith('http')) {
          headerImageLink = exampleHandle;
          if (leadIndex === 0) {
            console.log(`🖼️ [Fallback] Usando imagem de exemplo do template para header IMAGE: ${exampleHandle.substring(0, 80)}...`);
          }
        } else {
          return { success: false, rttMs: 0, error: `Template requer header IMAGE mas nenhuma URL de imagem disponível para lead ${lead.phone}`, leadIndex };
        }
      }
      
      const startTime = Date.now();
      
      try {
        let response;
        const headerTextParams = headerImageLink ? undefined : (headerParameters.length > 0 ? headerParameters : undefined);
        if (buttonParameters.length > 0) {
          response = await sendTemplateWithButtons(
            phoneNumberId,
            formattedPhone,
            template.name,
            languageCode,
            bodyParameters.length > 0 ? bodyParameters : undefined,
            buttonParameters,
            metaToken,
            headerImageLink,
            headerTextParams,
            this.stats.campaignId
          );
        } else {
          response = await sendTemplateMessage(
            phoneNumberId,
            formattedPhone,
            template.name,
            languageCode,
            bodyParameters.length > 0 ? bodyParameters : undefined,
            metaToken,
            headerImageLink,
            headerTextParams,
            this.stats.campaignId
          );
        }
        
        const rttMs = Date.now() - startTime;
        const messageId = response?.messages?.[0]?.id;

        const leadWithExtras = lead as Lead & {
          campaignAudioUrl?: string;
          campaignStaticImageUrl?: string;
          campaignExtraText?: string;
          campaignSequenceEnabled?: boolean;
        };

        if (messageId && (leadWithExtras.campaignAudioUrl || leadWithExtras.campaignExtraText)) {
          const sequence: Array<{ type: 'image' | 'audio' | 'text'; content: string }> = [];
          if (leadWithExtras.campaignAudioUrl) sequence.push({ type: 'audio', content: leadWithExtras.campaignAudioUrl });
          if (leadWithExtras.campaignExtraText && leadWithExtras.campaignExtraText.trim()) sequence.push({ type: 'text', content: leadWithExtras.campaignExtraText.trim() });

          for (let i = 0; i < sequence.length; i++) {
            const item = sequence[i];
            const delayMs = 500 + crypto.randomInt(0, 1001);
            await new Promise(resolve => setTimeout(resolve, delayMs));

            const trySend = async (): Promise<void> => {
              if (item.type === 'image') {
                await sendImageMessage(phoneNumberId, formattedPhone, item.content, undefined, metaToken);
              } else if (item.type === 'audio') {
                const mediaId = await this.getOrPrepareAudioMediaId(item.content, phoneNumberId, metaToken);
                await metaAPI.sendVoiceNoteMessage(phoneNumberId, formattedPhone, mediaId, metaToken);
              } else {
                await metaAPI.sendFreeFormMessage(phoneNumberId, formattedPhone, item.content, metaToken);
              }
            };

            try {
              await trySend();
            } catch (firstErr: any) {
              this.asyncCheckpoint.warn(`Lead ${leadIndex}: ${item.type} falhou (1ª tentativa): ${firstErr.message}. Tentando novamente em 800ms...`);
              try {
                await new Promise(resolve => setTimeout(resolve, 800));
                await trySend();
              } catch (secondErr: any) {
                logError(`UltraStableEngine.sequence.${item.type}`, { leadIndex, phone: formattedPhone, content: item.content.substring(0, 80) }, secondErr);
                this.asyncCheckpoint.warn(`Lead ${leadIndex}: ${item.type} falhou definitivamente: ${secondErr.message}`);
              }
            }
          }
        }

        return { success: true, rttMs, leadIndex, messageId };
        
      } catch (error: any) {
        const rttMs = Date.now() - startTime;
        const errorMsg = error?.message || 'Erro desconhecido';
        const errorResponse = error?.response?.data ? JSON.stringify(error.response.data).slice(0, 500) : '';
        logError('UltraStableEngine.processLead', { leadIndex, rttMs, response: errorResponse }, error);
        const isRateLimitError = errorMsg.includes('135000') || 
                                errorMsg.includes('rate limit') ||
                                errorMsg.includes('131048') ||
                                errorMsg.includes('134912');
        const isPayloadError = errorMsg.includes('131008');
        
        return {
          success: false,
          rttMs,
          error: errorMsg,
          isRateLimitError: isRateLimitError && !isPayloadError,
          leadIndex
        };
      }
    };
  }

  private updateStats(): void {
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    
    this.stats.successfulSends = this.successCount;
    this.stats.failedSends = this.failedCount;
    this.stats.metaBlockedSends = this.metaBlockedCount;
    this.stats.preflightFailed = this.preflightFailedCount;
    this.stats.processedLeads = this.processedCount;
    this.stats.currentRate = elapsed > 0 ? this.successCount / elapsed : 0;
    
    if (this.stats.currentRate > this.peakRate) {
      this.peakRate = this.stats.currentRate;
      this.stats.peakRate = this.peakRate;
    }
    
    const rttStats = this.rttWindow.getStats();
    this.stats.averageRttMs = rttStats.avg;
    this.stats.p95RttMs = rttStats.p95;
    
    this.stats.burstState = this.burstProfile.getState();
    
    const bucketStats = this.tokenBucket.getStats();
    this.stats.tokenBucketRate = bucketStats.refillRate;
    
    this.stats.circuitBreakerTrips = 0;
    this.stats.circuitState = 'CLOSED';
    
    this.stats.totalRetries = this.totalRetries;
    this.stats.inFlightRequests = this.pipeline.inFlightCount();
    this.stats.eta = this.etaCalculator.getEstimate();
    this.stats.retryQueue = this.retryQueue.getStats();
    this.stats.errorCounts = this.errorClassification.getCounts();
    this.stats.safeModeState = this.safeMode.getState();
    this.stats.detectedTier = this.detectedTier;
  }

  private saveCheckpointAsync(lastProcessedIndex: number): void {
    const bucketStats = this.tokenBucket.getStats();
    
    this.asyncCheckpoint.saveCheckpoint({
      campaignId: this.stats.campaignId,
      phoneNumberId: this.stats.phoneNumberId,
      lastProcessedIndex,
      successCount: this.successCount,
      failedCount: this.failedCount,
      currentIntervalMs: Math.floor(1000 / bucketStats.refillRate),
      tokenBucketState: {
        tokens: bucketStats.tokens,
        refillRate: bucketStats.refillRate
      }
    });
  }

  setCheckpointCallback(callback: (checkpoint: CheckpointData) => Promise<void>): void {
    this.externalCheckpointSave = callback;
    this.asyncCheckpoint.setOnCheckpointSave(callback);
  }

  setProgressCallback(callback: (stats: UltraStableStats) => void): void {
    this.onProgressCallback = callback;
  }

  setSendResultCallback(callback: (result: { success: boolean; phone: string; error?: string; errorType?: string; isMetaBlocked?: boolean; isRetry?: boolean }) => void): void {
    this.onSendResultCallback = callback;
  }

  setBlockRatePauseCallback(callback: (campaignId: string, reason: string, blockRate: number) => void): void {
    this.onBlockRatePauseCallback = callback;
  }

  private notifyBlockRatePause(reason: string, blockRate: number): void {
    if (this.onBlockRatePauseCallback) {
      try {
        this.onBlockRatePauseCallback(this.stats.campaignId, reason, blockRate);
      } catch (e: any) {
        logError('UltraStableEngine.notifyBlockRatePause', { campaignId: this.stats.campaignId }, e);
      }
    }
  }

  async processLeads(
    campaignId: string,
    leads: Lead[],
    phoneNumber: PhoneNumber,
    templates: WhatsAppTemplate[],
    metaToken: string,
    onProgress?: (stats: UltraStableStats) => void,
    startFromIndex: number = 0,
    forcedLanguage?: string
  ): Promise<UltraStableStats> {
    this.isRunning = true;
    this.startTime = Date.now();
    this.onProgressCallback = onProgress;
    this.startPhoneWeightSync();

    try {
      const wabaId = this.config.wabaConfigs?.[0]?.wabaId;
      if (wabaId) {
        const bmRow = await pool.query(
          `SELECT bm_id FROM wabas WHERE waba_id = $1 AND bm_id IS NOT NULL LIMIT 1`,
          [wabaId]
        );
        this.portfolioBmId = bmRow.rows[0]?.bm_id ?? null;
      }
    } catch (bmErr: any) {
      logError('UltraStable.resolveBmId', { campaignId }, bmErr);
    }

    registerActiveTracker(this.deliveryMetrics);
    this.didRegisterResponseRateTracker = !this.decisionEngine;
    if (this.didRegisterResponseRateTracker) {
      registerResponseRateTracker(campaignId, this.responseRateTracker);
    }

    const phoneIdsForDecision = this.allPhoneNumbers.length > 0
      ? this.allPhoneNumbers.map(pn => pn.id)
      : [phoneNumber.id];
    const primaryWabaConfig = this.config.wabaConfigs.find(w => w.phoneNumberIds.includes(phoneNumber.id))
      || this.config.wabaConfigs[0];
    const wabaIdForDecision = primaryWabaConfig?.wabaId || 'default';

    if (!this.decisionEngine) {
      const tokenBucketsMap = new Map<string, TokenBucket>();
      const phoneWabaMap = new Map<string, string>();
      for (const phoneId of phoneIdsForDecision) {
        tokenBucketsMap.set(phoneId, this.tokenBucket);
        const ownerWaba = this.config.wabaConfigs.find(w => w.phoneNumberIds.includes(phoneId));
        phoneWabaMap.set(phoneId, ownerWaba?.wabaId || wabaIdForDecision);
      }

      this.decisionEngine = new CampaignDecisionEngine(
        {
          campaignId,
          wabaId: wabaIdForDecision,
          phoneNumberIds: phoneIdsForDecision,
          phoneWabaMap,
          minRefillRate: this.config.minRefillRate,
        },
        this.deliveryMetrics,
        this.responseRateTracker,
        this.riskEngine,
        tokenBucketsMap
      );
      this.ownsDecisionEngine = true;

      if (this.phoneReputationScore) {
        this.decisionEngine.registerPhoneReputationScore(
          this.currentPhoneNumberId,
          this.phoneReputationScore
        );
      }

      this.decisionEngine.onPauseCampaign((cId, reason) => {
        // SOFT MODE: log only — never globally pause. SafeMode/scorer handle back-off.
        console.log(`[DECISION] Pause request ignored (soft mode): campaignId=${cId} reason="${reason}"`);
      });

      this.decisionEngine.onSlowDown((cId, phoneId, factor) => {
        console.log(`[DECISION] Slow down: campaignId=${cId} phoneId=${phoneId} factor=${factor}`);
      });

      this.decisionEngine.onDisableNumber((cId, phoneId, reason) => {
        // SOFT MODE: log only — phone weight is reduced via rebalance, never paused.
        console.log(`[DECISION] Disable request ignored (soft mode): campaignId=${cId} phoneId=${phoneId} reason="${reason}"`);
      });

      this.decisionEngine.onRebalance((cId, weights) => {
        const weightLog = Array.from(weights.entries()).map(([id, w]) => `${id}:${w.toFixed(2)}`).join(', ');
        console.log(`[DECISION] Rebalance triggered: campaignId=${cId} weights=[${weightLog}]`);
        const weightsArray = Array.from(weights.entries());
        for (const [phoneId, weight] of weightsArray) {
          if (this.multiPhoneCoordinator) {
            this.multiPhoneCoordinator.setPhoneWeight(phoneId, weight);
          }
        }
        const myWeight = weights.get(this.currentPhoneNumberId);
        if (myWeight !== undefined && myWeight <= 0.2) {
          // SOFT MODE: low weight reduces traffic via coordinator; never pause this engine.
          console.log(`[DECISION] Phone ${this.currentPhoneNumberId} weight=${myWeight} — soft-quarantine (no pause)`);
        }
      });
    }

    try {
      return await this._processLeadsInternal(campaignId, leads, phoneNumber, templates, metaToken, onProgress, startFromIndex, forcedLanguage);
    } catch (err: any) {
      logError('UltraStableEngine.processLeads', { campaignId }, err);

      this.stats.endTime = Date.now();
      this.updateStats();

      (this.stats as any).engineCrash = true;
      (this.stats as any).engineErrorMessage = err.message || 'Erro desconhecido no motor';

      this.onProgressCallback?.(this.stats);

      this.isRunning = false;
      return this.stats;
    } finally {
      this.cleanup();
      unregisterActiveTracker(this.deliveryMetrics);
      if (this.didRegisterResponseRateTracker) {
        unregisterResponseRateTracker(campaignId, this.responseRateTracker);
        this.didRegisterResponseRateTracker = false;
      }
    }
  }

  async processLeadsMultiPhone(
    campaignId: string,
    leads: Lead[],
    phoneNumbers: PhoneNumber[],
    templates: WhatsAppTemplate[],
    metaToken: string,
    onProgress?: (stats: UltraStableStats) => void,
    startFromIndex: number = 0,
    forcedLanguage?: string
  ): Promise<UltraStableStats> {
    this.allPhoneNumbers = phoneNumbers;
    this.useSenderPool = phoneNumbers.length > 1;
    this.senderSentCounters.clear();
    try {
      const dbSenders = await getAllSenders();
      for (const pn of phoneNumbers) {
        const dbSender = dbSenders.find(s => s.phoneNumberId === pn.id);
        this.senderSentCounters.set(pn.id, dbSender?.sentToday ?? 0);
      }
    } catch (err: any) {
      logError('UltraStableEngine.loadSenderCounters', { campaignId }, err);
      for (const pn of phoneNumbers) {
        this.senderSentCounters.set(pn.id, 0);
      }
    }

    return this.processLeads(
      campaignId,
      leads,
      phoneNumbers[0],
      templates,
      metaToken,
      onProgress,
      startFromIndex,
      forcedLanguage
    );
  }

  private async _processLeadsInternal(
    campaignId: string,
    leads: Lead[],
    phoneNumber: PhoneNumber,
    templates: WhatsAppTemplate[],
    metaToken: string,
    onProgress?: (stats: UltraStableStats) => void,
    startFromIndex: number = 0,
    forcedLanguage?: string
  ): Promise<UltraStableStats> {
    this.currentPhoneNumberId = phoneNumber.id;
    this.currentMetaToken = metaToken;
    this.currentTemplate = templates[0];
    this.currentForcedLanguage = forcedLanguage;
    this.currentLeads = leads;
    
    this.stats = this.createInitialStats(campaignId);
    this.stats.totalLeads = leads.length;
    this.stats.startTime = this.startTime;
    this.stats.phoneNumberId = phoneNumber.id;
    this.stats.displayPhoneNumber = phoneNumber.display_phone_number;
    
    this.tokenBucket.reset();
    this.rttWindow.clear();
    this.pipeline.reset();
    this.burstProfile.reset();
    this.burstProfile.start();
    this.etaCalculator.start(leads.length - startFromIndex);
    this.retryQueue.reset();
    this.safeMode.reset();
    this.errorClassification.reset();
    this.riskEngine.reset();
    this.blockWindow.reset();
    this.errorWindow.reset();
    this.consecutiveErrors = 0;
    this.humanBehavior.resetAll();
    this.templatePacingBackoff.reset();
    this.pacingTestJobs.clear();
    this.jobContextMap.clear();
    this.phoneOffsetApplied.clear();
    if (this.riskCooldownTimer) {
      clearTimeout(this.riskCooldownTimer);
      this.riskCooldownTimer = null;
    }
    if (this.recoveryCheckTimer) {
      clearInterval(this.recoveryCheckTimer);
      this.recoveryCheckTimer = null;
    }
    if (this.phoneWeightSyncTimer) {
      clearInterval(this.phoneWeightSyncTimer);
      this.phoneWeightSyncTimer = null;
    }
    
    this.peakRate = 0;
    this.totalRetries = 0;
    this.successCount = 0;
    this.failedCount = 0;
    this.metaBlockedCount = 0;
    this.preflightFailedCount = 0;
    this.processedCount = 0;
    this.lastProgressLogTime = 0;
    
    this.preflightValidators.clear();
    if (this.config.enablePreflightValidation && templates.length > 0) {
      const globalTplParamConfig: Record<string, Record<string, string>> = (leads[0] as any)?._templateParamConfig || {};
      for (let tIdx = 0; tIdx < templates.length; tIdx++) {
        const template = templates[tIdx];
        const templateInfo = {
          name: template.name,
          language: template.language,
          status: template.status,
          category: template.category || 'MARKETING',
          components: template.components || []
        };
        
        const dynamicMapping = buildDynamicParameterMapping(templateInfo);
        const wizardParamConfig: Record<string, string> =
          globalTplParamConfig[template.id] ||
          globalTplParamConfig[(template as any).templateId] ||
          globalTplParamConfig[template.name] ||
          {};
        
        const validator = new PreflightValidator({
          phoneNumberId: phoneNumber.id,
          template: templateInfo,
          parameterMapping: dynamicMapping,
          strictMode: false,
          wizardParamConfig
        });
        this.preflightValidators.set(tIdx, validator);
        const wizardParamCount = Object.keys(wizardParamConfig).length;
        console.log(`✅ PreflightValidator[${tIdx}] "${template.name}" inicializado (${dynamicMapping.size} params, ${wizardParamCount} wizard params configurados)`);
      }
      this.preflightValidator = this.preflightValidators.get(0) || null;
    }
    
    if (this.config.enableAutoTierDetection && metaToken) {
      try {
        this.tierDetection = new TierDetection({
          accessToken: metaToken,
          defaultTier: 'TIER_1K',
          applyAutomaticLimits: true
        });
        
        const tierStatus = await this.tierDetection.detectTier(phoneNumber.id);
        if (tierStatus?.messagingLimitTier) {
          this.detectedTier = tierStatus.messagingLimitTier;
          console.log(`\n📊 Tier detectado: ${this.detectedTier}`);
          console.log(`   ⚡ Velocidade: ${this.config.maxRefillRate} msg/s`);
          console.log(`   🔄 Concorrência: ${this.config.maxConcurrentRequests}`);
          console.log(`   📋 Skip-label ativo (sender_label: null)`);
        }
      } catch (error: any) {
        logError('UltraStableEngine.tierDetection', {}, error);
      }
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🛡️ MOTOR ULTRA-ESTÁVEL INICIADO`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📱 Número: ${phoneNumber.display_phone_number} (${phoneNumber.id})`);
    console.log(`📊 Total de leads: ${leads.length}`);
    console.log(`📝 Templates: ${templates.map(t => t.name).join(', ')}`);
    console.log(`🎯 RTT alvo: ${this.config.targetRttMs}ms (threshold: +${this.config.rttThresholdPercent}%)`);
    console.log(`⚡ Taxa inicial: ${this.config.initialRefillRate} msg/s`);
    console.log(`📉 Taxa máxima: ${this.config.maxRefillRate} msg/s`);
    console.log(`🔄 Concorrência: ${this.config.maxConcurrentRequests} requests`);
    console.log(`📍 Checkpoint: a cada ${this.config.checkpointEveryN} msgs`);
    console.log(`🛡️ SafeMode: ${this.config.safeMode.enabled ? 'ATIVADO' : 'Auto-ativável'}`);
    console.log(`✅ PreflightValidation: ${this.config.enablePreflightValidation ? 'ATIVO' : 'OFF'}`);
    console.log(`📍 Iniciando do índice: ${startFromIndex}`);
    console.log(`📦 Batch size: ${this.batchSize} leads`);
    console.log(`🛡️ RiskEngine: ATIVO (complementar ao SafeMode)`);
    const baseTypeStrategy = this.humanBehavior.getBaseTypeStrategy();
    const humanConfig = this.humanBehavior.getConfig();
    console.log(`🧠 HumanBehavior: ATIVO (base=${humanConfig.baseType}, rateMultiplier=${baseTypeStrategy.rateMultiplier}, delayMultiplier=${baseTypeStrategy.delayMultiplier})`);
    console.log(`   📊 Delays: Gaussiano ${humanConfig.baseDelayMeanMs}ms ± ${humanConfig.baseDelayStdDevMs}ms (${humanConfig.baseDelayMinMs}-${humanConfig.baseDelayMaxMs}ms)`);
    console.log(`   ⏸️ Pausas longas: ${humanConfig.longPauseMinMs/1000}-${humanConfig.longPauseMaxMs/1000}s a cada ${humanConfig.longPauseEveryMin}-${humanConfig.longPauseEveryMax} msgs`);
    console.log(`   🔄 Pausas ciclo: ${humanConfig.cyclePauseMinMs/1000}-${humanConfig.cyclePauseMaxMs/1000}s a cada ${humanConfig.cyclePauseEveryMin}-${humanConfig.cyclePauseEveryMax} msgs`);
    if (this.detectedTier) {
      console.log(`📊 Tier detectado: ${this.detectedTier}`);
    }
    console.log(`${'='.repeat(70)}\n`);

    const effectiveRate = this.humanBehavior.getEffectiveRate(this.config.initialRefillRate);
    if (effectiveRate !== this.config.initialRefillRate) {
      this.tokenBucket.setRefillRate(effectiveRate);
      console.log(`⚡ Taxa ajustada por baseType (${humanConfig.baseType}): ${this.config.initialRefillRate} → ${effectiveRate} msg/s`);
    }
    
    const phoneIdsForPlan = this.allPhoneNumbers.length > 0
      ? this.allPhoneNumbers.map(pn => pn.id)
      : [phoneNumber.id];
    const templateNames = templates.map(t => t.name);
    try {
      const senders = await getAllSenders();
      for (const phoneId of phoneIdsForPlan) {
        const sender = senders.find(s => s.phoneNumberId === phoneId);
        if (sender) {
          this.humanBehavior.initPhoneDailyCount(phoneId, sender.sentToday);
          console.log(`📊 [HumanBehavior] ${phoneId}: ${sender.sentToday} msgs enviadas hoje (DB)`);
        }
      }
    } catch (err: any) {
      logError('UltraStableEngine.initDailyCount', {}, err);
    }
    const plan = buildPlan(phoneIdsForPlan, templates.length, leads.length, this.humanBehavior);
    console.log(`\n📋 PLANO DE ENVIO (anti-spam humano):`);
    console.log(`   Total de jobs: ${plan.summary.totalJobs}`);
    console.log(`   Tempo estimado: ${(plan.summary.estimatedTimeMs / 1000).toFixed(0)}s`);
    console.log(`   Jobs por phone: ${JSON.stringify(plan.summary.jobsPerPhone)}`);
    console.log(`   Sender pool ativo: ${this.useSenderPool ? 'SIM (' + phoneIdsForPlan.length + ' senders)' : 'NÃO'}`);
    console.log(`   Template rotation: probabilística ponderada`);
    console.log(`   Delays: Gaussiano (comportamento humano)`);

    let currentIndex = startFromIndex;
    if (startFromIndex === 0) {
      checkpointStore.remove(campaignId, phoneNumber.id);
    } else {
      const resumeIndex = checkpointStore.getResumeIndex(campaignId, phoneNumber.id);
      if (resumeIndex > startFromIndex) {
        currentIndex = resumeIndex;
        console.log(`📍 Checkpoint encontrado: retomando do índice ${currentIndex} (era ${startFromIndex})`);
        this.asyncCheckpoint.info(`Retomando do checkpoint: índice ${currentIndex}`);
      }
    }
    let batchStart = currentIndex;
    const failedLeads: Array<{ lead: Lead; index: number; reason: string }> = [];
    
    this.microBatchSentCount = 0;
    this.microBatchNumber = 0;
    this.currentWabaIndex = 0;
    this.deliveryMetrics.reset();

    if (this.config.enableMicroBatching) {
      console.log(`\n📦 [MicroBatch] Ativo: ${this.config.microBatchSize} msgs/batch, pausa ${this.config.microBatchPauseMinMs/1000}-${this.config.microBatchPauseMaxMs/1000}s`);
      if (this.config.wabaConfigs.length > 1) {
        console.log(`   🔄 Multi-WABA: ${this.config.wabaConfigs.length} WABAs configuradas, alternando por batch`);
      }
    }
    
    let lastSenderSyncTime = 0;
    let lastPruneTime = 0;
    const SENDER_SYNC_INTERVAL_MS = 30000;
    const PRUNE_INTERVAL_MS = 60000;
    const activePhoneIds = new Set<string>();
    plan.jobs.forEach((j: { phoneId: string }) => activePhoneIds.add(j.phoneId));

    while (currentIndex < plan.jobs.length && this.isRunning) {
      if (this.isPaused) {
        await this.waitWhilePaused();
        if (!this.isRunning) break;
      }

      const now = Date.now();
      if (this.useSenderPool && now - lastSenderSyncTime > SENDER_SYNC_INTERVAL_MS) {
        try {
          const allSenders = await getAllSenders();
          allSenders.forEach((s: { phoneNumberId: string; sentToday: number }) => {
            this.senderSentCounters.set(s.phoneNumberId, s.sentToday);
          });
          lastSenderSyncTime = now;
        } catch (syncErr: any) {
          logError('UltraStableEngine.senderSync', { campaignId }, syncErr);
        }
      }

      if (now - lastPruneTime > PRUNE_INTERVAL_MS) {
        this.humanBehavior.pruneInactivePhones(activePhoneIds);
        this.templatePacingBackoff.pruneStale();
        lastPruneTime = now;
      }

      
      while (this.pipeline.canSubmit() && currentIndex < plan.jobs.length) {
        const job = plan.jobs[currentIndex];

        if (this.useSenderPool) {
          const senderCount = this.senderSentCounters.get(job.phoneId) ?? 0;
          if (shouldSwitchSender(senderCount)) {
            try {
              const next = await nextSender(job.phoneId);
              console.log(`\n🔄 [SenderPool] Rotação proativa: ${job.phoneId} (${senderCount} msgs) → ${next.phoneNumberId} (${next.sentToday} msgs)`);
              this.asyncCheckpoint.info(`SenderPool: rotação proativa ${job.phoneId} → ${next.phoneNumberId}`);
              job.phoneId = next.phoneNumberId;
              this.currentPhoneNumberId = next.phoneNumberId;
              this.senderSentCounters.set(next.phoneNumberId, next.sentToday);
            } catch (err: any) {
              logError('UltraStableEngine.proactiveRotation', { campaignId }, err);
              this.asyncCheckpoint.warn(`SenderPool: sem sender disponível: ${err.message}`);
            }
          }
        }

        if (!stealthScheduler.isWithinBusinessHours()) {
          const nextStart = stealthScheduler.getNextBusinessHoursStart();
          const waitMs = nextStart.getTime() - Date.now();
          if (waitMs > 0) {
            console.log(`🕐 Fora do horário comercial, aguardando até ${nextStart.toLocaleTimeString()} (${Math.round(waitMs / 60000)}min)`);
            await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 60000)));
            continue;
          }
        }

        if (bmQualityMonitor.isPhonePaused(job.phoneId)) {
          console.log(`⏸️ Número ${job.phoneId} pausado por qualidade, pulando lead ${job.leadIndex}`);
          currentIndex++;
          continue;
        }

        await this.tokenBucket.waitForToken();
        
        if (!this.safeMode.isActive()) {
          const windowed = this.deliveryMetrics.getWindowedDeliveryRate();
          const currentDeliveryRate = windowed.sent >= 10 ? windowed.deliveryRate : undefined;
          const rampUpRate = this.burstProfile.getRampUpRateMsgPerSec(currentDeliveryRate);
          const currentRate = this.tokenBucket.getStats().refillRate;
          if (Math.abs(rampUpRate - currentRate) > 0.02) {
            const safeRate = Math.min(rampUpRate, this.config.maxRefillRate);
            this.tokenBucket.setRefillRate(safeRate);
          }
        }

        if (!this.phoneOffsetApplied.has(job.phoneId)) {
          this.phoneOffsetApplied.add(job.phoneId);
          const phoneOffset = await this.humanBehavior.applyPhoneOffset(job.phoneId);
          if (phoneOffset > 100) {
            console.log(`📱 [HumanBehavior] Offset inicial de ${phoneOffset}ms para ${job.phoneId}`);
          }
        }

        await this.humanBehavior.applyMessageDelay(job.phoneId);

        if (crypto.randomInt(0, 100) < 15) {
          await this.humanBehavior.applyReadingSimulation();
        }
        if (crypto.randomInt(0, 100) < 8) {
          await this.humanBehavior.applyTypingSimulation();
        }

        const longPause = this.humanBehavior.checkAndApplyLongPause(job.phoneId);
        if (longPause.shouldPause) {
          console.log(`⏸️ [HumanBehavior] Pausa longa: ${(longPause.durationMs / 1000).toFixed(1)}s para ${job.phoneId}`);
          await new Promise(resolve => setTimeout(resolve, longPause.durationMs));
        }

        const cyclePause = this.humanBehavior.checkAndApplyCyclePause(job.phoneId);
        if (cyclePause.shouldPause) {
          console.log(`🔄 [HumanBehavior] Pausa de ciclo: ${(cyclePause.durationMs / 1000).toFixed(1)}s para ${job.phoneId}`);
          await new Promise(resolve => setTimeout(resolve, cyclePause.durationMs));
        }

        if (this.humanBehavior.isOverDailyLimit(job.phoneId)) {
          console.log(`🚫 [HumanBehavior] Limite diário atingido para ${job.phoneId}, pulando lead ${job.leadIndex}`);
          this.processedCount++;
          currentIndex++;
          continue;
        }

        const lead = leads[job.leadIndex];

        if (this.portfolioBmId) {
          try {
            const portfolioStatus = await portfolioControl.getPortfolioStatus(this.portfolioBmId);
            if (portfolioStatus.blocked) {
              this.asyncCheckpoint.warn(`[PortfolioControl] BM ${this.portfolioBmId} blocked at ${portfolioStatus.usagePercent.toFixed(0)}% — pausing campaign`);
              this.isPaused = true;
              await new Promise<void>(resolve => {
                this.pauseResolve = resolve;
                setTimeout(resolve, 60000);
              });
              this.isPaused = false;
              continue;
            } else if (portfolioStatus.slowdownPercent > 0) {
              const speedMultiplier = portfolioControl.getSpeedMultiplier(portfolioStatus);
              const baselineRate = this.config.initialRefillRate;
              const reducedRate = Math.max(this.config.minRefillRate, baselineRate * speedMultiplier);
              this.tokenBucket.setRefillRate(reducedRate);
            }
          } catch (portErr: any) {
            logError('UltraStable.portfolioControl', { bmId: this.portfolioBmId }, portErr);
          }
        }

        try {
          const capResult = await frequencyCap.checkRecipient(lead.phone);
          if (!capResult.allowed) {
            this.asyncCheckpoint.info(`Lead ${job.leadIndex} (${lead.phone}): ${capResult.reason}`);
            try {
              await pool.query(
                `INSERT INTO message_deliveries (campaign_id, lead_id, phone_number, status, error_message, sent_at)
                 VALUES ($1, $2, $3, 'skipped', $4, NOW())`,
                [this.stats.campaignId, lead.id || `lead-${job.leadIndex}`, lead.phone, `frequency_cap: ${capResult.reason}`]
              );
            } catch (insertErr: any) {
              logError('UltraStable.frequencyCapPersist', { phone: lead.phone }, insertErr);
            }
            this.processedCount++;
            currentIndex++;
            continue;
          }
        } catch (capErr: any) {
          logError('UltraStable.frequencyCapCheck', { phone: lead.phone }, capErr);
        }

        if (proactiveSenderRotation.shouldRotate(job.phoneId)) {
          try {
            const next = await nextSender(job.phoneId);
            this.asyncCheckpoint.info(`[ProactiveRotation] Rotating sender ${job.phoneId} → ${next.phoneNumberId}`);
            job.phoneId = next.phoneNumberId;
            this.currentPhoneNumberId = next.phoneNumberId;
          } catch (rotErr: any) {
            logError('UltraStable.senderRotationSwitch', { phoneId: job.phoneId }, rotErr);
          }
        }
        proactiveSenderRotation.recordSend(job.phoneId);

        // For multi-WABA campaigns: resolve the sending WABA for this phone first,
        // then build a WABA-compatible template pool to ensure correct isolation.
        let jobToken = metaToken;
        let ownerWabaForJob: WABAConfig | undefined;
        let effectiveTemplates = templates;
        let effectiveTemplateNames = templateNames;
        if (this.config.wabaConfigs.length > 1) {
          ownerWabaForJob = this.config.wabaConfigs.find(w => w.phoneNumberIds.includes(job.phoneId));
          if (ownerWabaForJob) {
            jobToken = ownerWabaForJob.accessToken;
            // Restrict template pool to those belonging to this phone's WABA.
            // Falls back to all templates if none carry a wabaId (backwards-compatible).
            if (ownerWabaForJob.wabaDbId) {
              const wabaCompatible = templates.filter(t => !t.wabaId || t.wabaId === ownerWabaForJob!.wabaDbId);
              if (wabaCompatible.length > 0) {
                effectiveTemplates = wabaCompatible;
                effectiveTemplateNames = wabaCompatible.map(t => t.name);
              } else {
                console.warn(`[TEMPLATE][Multi-WABA] No templates for phoneId=${job.phoneId} (wabaDbId=${ownerWabaForJob.wabaDbId}) — all templates belong to other WABAs; skipping lead ${job.leadIndex}`);
                this.processedCount++;
                currentIndex++;
                continue;
              }
            }
          } else {
            console.warn(`[SEND][Multi-WABA] phoneId=${job.phoneId} has no matching WABA config — using batch-level token and all templates`);
          }
        }

        const templateIndex = this.humanBehavior.selectTemplate(
          effectiveTemplates.length,
          job.phoneId,
          effectiveTemplateNames,
          this.rotationMode
        );
        const template = effectiveTemplates[templateIndex];

        // [SEND] structured log for each outbound send
        console.log(`[TEMPLATE] selected template='${template.name}' templateWabaId=${template.wabaId || 'unset'} phoneId=${job.phoneId} senderWabaDbId=${ownerWabaForJob?.wabaDbId || 'single-waba'} decision=used`);

        const templateCategory = (template as any).category || '';
        if (shouldBlockMarketingTemplate(lead.phone, templateCategory)) {
          console.log(`🚫 DDI +1: bloqueando MARKETING para ${lead.phone}`);
          this.processedCount++;
          currentIndex++;
          continue;
        }
        
        if (this.templatePacingBackoff.isBlocked(job.phoneId, template.name)) {
          const backoffRemaining = this.templatePacingBackoff.getBackoffMs(job.phoneId, template.name);
          if (backoffRemaining > 0) {
            console.log(`⏱️ [TemplatePacing] Template ${template.name} bloqueado para ${job.phoneId}, aguardando ${Math.round(backoffRemaining / 1000)}s`);
            const deferredJob = plan.jobs.splice(currentIndex, 1)[0];
            const reinsertAt = Math.min(currentIndex + 10, plan.jobs.length);
            plan.jobs.splice(reinsertAt, 0, deferredJob);
            await new Promise(resolve => setTimeout(resolve, Math.min(backoffRemaining, 3000)));
            continue;
          } else if (this.templatePacingBackoff.shouldTestRelease(job.phoneId, template.name)) {
            console.log(`🧪 [TemplatePacing] Testando liberação para ${job.phoneId}/${template.name}`);
            this.pacingTestJobs.set(job.leadIndex, { phoneId: job.phoneId, templateName: template.name });
          } else {
            const deferredJob = plan.jobs.splice(currentIndex, 1)[0];
            const reinsertAt = Math.min(currentIndex + 10, plan.jobs.length);
            plan.jobs.splice(reinsertAt, 0, deferredJob);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
        }

        // Resolve globalTemplateIndex for preflight validator lookup (validator is keyed by full-pool index)
        const globalTemplateIndex = templates.indexOf(template);
        if (this.config.enablePreflightValidation && this.preflightValidators.size > 0) {
          const activeValidator = this.preflightValidators.get(globalTemplateIndex >= 0 ? globalTemplateIndex : templateIndex) || this.preflightValidator;
          if (activeValidator) {
            const validation = activeValidator.validate(lead as any, job.leadIndex);
            if (!validation.valid) {
              this.preflightFailedCount++;
              this.processedCount++;
              this.asyncCheckpoint.warn(`Lead ${job.leadIndex} falhou preflight (template: ${template.name})`, {
                errors: validation.errors.map(e => e.message).join(', ')
              });
              currentIndex++;
              continue;
            }
          }
        }

        // [SEND] structured log for each outbound send
        console.log(`[SEND] campaignId=${this.stats.campaignId} phoneId=${job.phoneId} template=${template.name} wabaDbId=${ownerWabaForJob?.wabaDbId || this.config.wabaConfigs[0]?.wabaDbId || 'single-waba'} leadIndex=${job.leadIndex}`);

        const sendFn = this.createSendFunction(
          job.phoneId,
          lead,
          template,
          jobToken,
          forcedLanguage,
          job.leadIndex
        );
        
        this.jobContextMap.set(job.leadIndex, { phoneId: job.phoneId, templateName: template.name });
        this.pipeline.submit(sendFn, job.leadIndex);
        currentIndex++;
        this.microBatchSentCount++;

        if (this.config.enableMicroBatching && this.microBatchSentCount >= this.config.microBatchSize) {
          this.microBatchNumber++;
          const pauseRange = Math.max(1, Math.floor(this.config.microBatchPauseMaxMs - this.config.microBatchPauseMinMs));
          const pauseMs = this.config.microBatchPauseMinMs + crypto.randomInt(0, pauseRange);
          const remaining = plan.jobs.length - currentIndex;

          console.log(`\n📦 [MicroBatch] Batch #${this.microBatchNumber} completo (${this.microBatchSentCount} msgs)`);
          console.log(`   ⏸️ Pausa de ${(pauseMs / 1000).toFixed(0)}s antes do próximo batch`);
          console.log(`   📊 Restantes: ${remaining} msgs`);

          const windowed = this.deliveryMetrics.getWindowedDeliveryRate();
          if (windowed.sent > 10) {
            console.log(`   📈 Taxa entrega (janela): ${(windowed.deliveryRate * 100).toFixed(1)}%`);
          }

          await this.pipeline.drain();

          checkpointStore.save({
            campaignId,
            phoneNumberId: phoneNumber.id,
            lastProcessedIndex: currentIndex - 1,
            successCount: this.successCount,
            failedCount: this.failedCount,
            blockedCount: this.metaBlockedCount,
            timestamp: Date.now(),
          });

          if (this.config.wabaConfigs.length > 1) {
            if (this.wabaScorer) {
              const picked = this.wabaScorer.pickWabaIndex();
              if (picked >= 0) this.currentWabaIndex = picked;
              // Light global pressure: shrink refill rate when fleet is stressed.
              if (this.wabaScorer.shouldRebalance()) {
                const pressure = this.wabaScorer.getGlobalPressure();
                if (pressure < 1) {
                  const target = Math.max(this.config.minRefillRate, this.config.maxRefillRate * pressure);
                  this.tokenBucket.setRefillRate(target);
                }
              }
            } else {
              this.currentWabaIndex = (this.currentWabaIndex + 1) % this.config.wabaConfigs.length;
            }
            const nextWaba = this.config.wabaConfigs[this.currentWabaIndex];
            metaToken = nextWaba.accessToken;
            this.currentMetaToken = nextWaba.accessToken;

            if (nextWaba.phoneNumberIds.length > 0) {
              const validPhones = new Set(nextWaba.phoneNumberIds);
              for (let j = currentIndex; j < plan.jobs.length; j++) {
                if (!validPhones.has(plan.jobs[j].phoneId)) {
                  plan.jobs[j].phoneId = nextWaba.phoneNumberIds[j % nextWaba.phoneNumberIds.length];
                }
              }
            }

            console.log(`   🔄 [Multi-WABA] Alternando para WABA ${nextWaba.wabaId} (${nextWaba.phoneNumberIds.length} phones)`);
          }

          this.microBatchSentCount = 0;
          this.deliveryMetrics.pruneOldEntries();

          if (this.isRunning && remaining > 0) {
            await new Promise(resolve => setTimeout(resolve, pauseMs));
          }

          this.updateStats();
          this.onProgressCallback?.(this.stats);
          batchStart = currentIndex;
          break;
        }
      }
      
      if (!this.pipeline.canSubmit() && currentIndex < plan.jobs.length) {
        await this.pipeline.waitForAny();
      }
      
      if (currentIndex - batchStart >= this.batchSize) {
        checkpointStore.save({
          campaignId,
          phoneNumberId: phoneNumber.id,
          lastProcessedIndex: currentIndex - 1,
          successCount: this.successCount,
          failedCount: this.failedCount,
          blockedCount: this.metaBlockedCount,
          timestamp: Date.now(),
        });
        this.asyncCheckpoint.info(`Batch checkpoint salvo: índice ${currentIndex - 1}`);
        batchStart = currentIndex;
      }
      
      if (this.processedCount > 0 && this.shouldLogProgress()) {
        this.lastProgressLogTime = Date.now();
        const bucketStats = this.tokenBucket.getStats();
        const eta = this.etaCalculator.getEstimate();
        const errorCounts = this.errorClassification.getCounts();
        
        console.log(`\n📊 PROGRESSO: ${this.processedCount}/${leads.length}`);
        console.log(`   ✅ Sucessos: ${this.successCount}`);
        console.log(`   ❌ Falhas: ${this.failedCount}`);
        console.log(`   📈 Taxa: ${this.stats.currentRate.toFixed(2)} msg/s`);
        console.log(`   🎯 Taxa token bucket: ${bucketStats.refillRate.toFixed(1)} msg/s`);
        console.log(`   🔄 P95 RTT: ${this.stats.p95RttMs.toFixed(0)}ms`);
        console.log(`   📍 RampUp: ${this.stats.burstState.rampUpCurrentMsgPerMin?.toFixed(0) ?? '?'} msg/min → ${this.stats.burstState.rampUpTargetMsgPerMin?.toFixed(0) ?? '?'} msg/min`);
        console.log(`   🔌 Circuit: ${this.stats.circuitState}`);
        console.log(`   ✈️ Em voo: ${this.pipeline.inFlightCount()}`);
        console.log(`   🔄 RetryQueue: ${this.retryQueue.size()} pendentes`);
        console.log(`   🛡️ SafeMode: ${this.safeMode.isActive() ? 'ATIVO' : 'OFF'}`);
        console.log(`   ⏱️ ETA: ${eta.remainingFormatted} (${eta.confidenceLevel}% confiança)`);
        
        if (errorCounts.total > 0) {
          console.log(`   ⚠️ Erros: rateLimit=${errorCounts.rateLimitErrors}, payload=${errorCounts.payloadErrors}, network=${errorCounts.networkErrors}`);
        }

        const dashData = this.deliveryMetrics.getDashboardData();
        if (dashData.overall.totalSent > 10) {
          console.log(`   📬 Delivery: ${(dashData.overall.overallDeliveryRate * 100).toFixed(1)}% | Read: ${(dashData.overall.overallReadRate * 100).toFixed(1)}% | Fail: ${(dashData.overall.overallFailRate * 100).toFixed(1)}%`);
        }
        for (const tpl of dashData.templates) {
          if (tpl.sent > 5) {
            this.humanBehavior.updateTemplateQualityScore(tpl.name, tpl.deliveryRate);
          }
        }
      }
    }
    
    console.log(`\n⏳ Drenando pipeline principal...`);
    await this.pipeline.drain();
    
    console.log(`⏳ Drenando fila de retry...`);
    await this.retryQueue.drain();
    
    while (this.pipeline.inFlightCount() > 0 || !this.retryQueue.isEmpty()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.stats.endTime = Date.now();
    const duration = (this.stats.endTime - this.stats.startTime) / 1000;
    const finalRate = this.successCount / duration;
    const errorRate = this.stats.totalLeads > 0 
      ? ((this.failedCount + this.preflightFailedCount) / this.stats.totalLeads) * 100 
      : 0;
    
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🏁 CAMPANHA FINALIZADA - ULTRA-ESTÁVEL`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📊 Enviadas (API aceitou): ${this.successCount}/${this.stats.totalLeads}`);
    console.log(`🔒 Bloqueadas pela Meta (ambiente): ${this.metaBlockedCount}`);
    console.log(`❌ Erros reais: ${this.failedCount}`);
    console.log(`   🔴 Rate limit: ${this.errorClassification.getCounts().rateLimitErrors}`);
    console.log(`   📝 Payload: ${this.errorClassification.getCounts().payloadErrors}`);
    console.log(`   🌐 Network: ${this.errorClassification.getCounts().networkErrors}`);
    console.log(`   🔒 Ambiente: ${this.errorClassification.getCounts().environmentErrors}`);
    console.log(`📈 Taxa de erro real: ${errorRate.toFixed(3)}%`);
    console.log(`⏱️ Duração: ${duration.toFixed(1)}s`);
    console.log(`🚀 Taxa final: ${finalRate.toFixed(2)} msg/s`);
    console.log(`📈 Taxa pico: ${this.peakRate.toFixed(2)} msg/s`);
    console.log(`📦 Micro-batches: ${this.microBatchNumber}`);
    const finalDashData = this.deliveryMetrics.getDashboardData();
    console.log(`📬 Delivery rate: ${(finalDashData.overall.overallDeliveryRate * 100).toFixed(1)}% (${finalDashData.overall.totalDelivered}/${finalDashData.overall.totalSent})`);
    console.log(`📖 Read rate: ${(finalDashData.overall.overallReadRate * 100).toFixed(1)}%`);
    console.log(`🔄 Retries totais: ${this.totalRetries}`);
    console.log(`🔄 Recuperados via retry: ${this.retryQueue.getStats().totalRecovered}`);
    console.log(`🛡️ SafeMode ativações: ${this.safeMode.getState().activationCount}`);
    if (this.detectedTier) {
      console.log(`📊 Tier usado: ${this.detectedTier}`);
    }
    console.log(`${'='.repeat(70)}\n`);
    
    this.saveCheckpointAsync(leads.length - 1);
    await this.asyncCheckpoint.forceFlush();
    
    checkpointStore.remove(campaignId, phoneNumber.id);
    
    return this.stats;
  }

  setMultiPhoneCoordinator(coordinator: MultiPhoneEngineCoordinator): void {
    this.multiPhoneCoordinator = coordinator;
  }

  setDecisionEngine(engine: CampaignDecisionEngine): void {
    this.decisionEngine = engine;
  }

  pause(): void {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    this.pipeline.pause();
    this.asyncCheckpoint.info('Motor pausado pelo usuário');
    console.log(`\n⏸️ MOTOR PAUSADO pelo usuário`);
    this.updateStats();
    this.onProgressCallback?.(this.stats);
  }

  resume(): void {
    if (!this.isRunning || !this.isPaused) return;
    this.isPaused = false;
    this.pipeline.resume();
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    this.asyncCheckpoint.info('Motor retomado pelo usuário');
    console.log(`\n▶️ MOTOR RETOMADO pelo usuário`);
    this.updateStats();
    this.onProgressCallback?.(this.stats);
  }

  getPaused(): boolean {
    return this.isPaused;
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.isPaused) return;
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  stop(): void {
    this.isRunning = false;
    this.isPaused = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    if (this.riskCooldownTimer) {
      clearTimeout(this.riskCooldownTimer);
      this.riskCooldownTimer = null;
    }
    if (this.recoveryCheckTimer) {
      clearInterval(this.recoveryCheckTimer);
      this.recoveryCheckTimer = null;
    }
    if (this.phoneWeightSyncTimer) {
      clearInterval(this.phoneWeightSyncTimer);
      this.phoneWeightSyncTimer = null;
    }
    this.pipeline.pause();
    this.asyncCheckpoint.info('Motor parado pelo usuário');
    this.cleanup();
  }

  private cleanup(): void {
    this.jobContextMap.clear();
    this.pacingTestJobs.clear();
    this.phoneOffsetApplied.clear();
    this.senderSentCounters.clear();
    this.messageTemplateMap.clear();
    this.preflightValidators.clear();
    this.currentLeads = [];
    this.humanBehavior.resetAll();
    this.templatePacingBackoff.pruneStale();
    this.templatePacingBackoff.reset();
    if (this.tierDetection) {
      this.tierDetection.destroy();
      this.tierDetection = null;
    }
    if (this.riskCooldownTimer) {
      clearTimeout(this.riskCooldownTimer);
      this.riskCooldownTimer = null;
    }
    if (this.recoveryCheckTimer) {
      clearInterval(this.recoveryCheckTimer);
      this.recoveryCheckTimer = null;
    }
    if (this.phoneWeightSyncTimer) {
      clearInterval(this.phoneWeightSyncTimer);
      this.phoneWeightSyncTimer = null;
    }
    this.phoneReputationScore.destroy();
    this.deliveryMetrics.destroy();
    this.responseRateTracker.reset();
    if (this.decisionEngine && this.ownsDecisionEngine) {
      this.decisionEngine.destroy();
    }
    this.decisionEngine = null;
    this.ownsDecisionEngine = false;
  }

  getStats(): UltraStableStats {
    return { ...this.stats };
  }

  /**
   * Returns the current per-WABA distribution snapshot when this engine
   * is running in multi-WABA mode. Empty array when not configured.
   */
  getWabaDistribution(): WabaDistributionEntry[] {
    return this.wabaScorer ? this.wabaScorer.getDistribution() : [];
  }

  /** Aggregate global pressure (0.7–1.0) from the WabaScorer; 1.0 when no scorer. */
  getGlobalPressure(): number {
    return this.wabaScorer ? this.wabaScorer.getGlobalPressure() : 1;
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getCircuitState(): CircuitState {
    return 'CLOSED';
  }

  getLastCheckpoint(): CheckpointData | null {
    return this.asyncCheckpoint.getLastCheckpoint();
  }

  getEta(): EtaEstimate {
    return this.etaCalculator.getEstimate();
  }

  getErrorCounts(): ErrorCounts {
    return this.errorClassification.getCounts();
  }

  getSafeModeState(): SafeModeState {
    return this.safeMode.getState();
  }

  activateSafeMode(reason: string = 'manual'): void {
    this.safeMode.activate(reason);
  }

  getDetectedTier(): MessagingTier | undefined {
    return this.detectedTier;
  }

  getDeliveryMetrics(): DeliveryMetricsTracker {
    return this.deliveryMetrics;
  }

  getResponseRateTracker(): ResponseRateTracker {
    return this.responseRateTracker;
  }

  getPhoneReputationScore(): PhoneReputationScore {
    return this.phoneReputationScore;
  }

  getTokenBucket(): TokenBucket {
    return this.tokenBucket;
  }

  /**
   * Enforces a hard upper bound on the send rate (msgs/second) for warmup/UNKNOWN numbers.
   * Bypasses the normal minRefillRate floor so very low rates (e.g. 0.006 msg/s) are respected.
   * Used by the warmup subsystem to enforce uniform day distribution.
   */
  setMaxSendRate(ratePerSecond: number): void {
    const capped = Math.max(0.0001, ratePerSecond);
    this.config.maxRefillRate = capped;
    this.config.minRefillRate = capped;
    this.config.initialRefillRate = capped;
    // forceWarmupRate bypasses minRefillRate floor in TokenBucket
    this.tokenBucket.forceWarmupRate(capped);
    console.log(`[UltraStableEngine] setMaxSendRate (warmup): ${capped.toFixed(6)} msgs/s`);
  }

  recordWebhookDeliveryStatus(status: 'delivered' | 'read' | 'failed', templateName?: string, phoneNumberId?: string): void {
    this.deliveryMetrics.recordWebhookStatus(status, templateName, phoneNumberId);
  }
}

interface SendResult {
  success: boolean;
  rttMs: number;
  error?: string;
  isRateLimitError?: boolean;
  leadIndex?: number;
  messageId?: string;
}

// ============================================================================
// runPlan() — Execução standalone legada (skip-label, sem PatchName)
// NOTA: Esta função usa seleção de template por índice fixo (round-robin).
// Para envios com comportamento humano (anti-spam), use UltraStableEngine.processLeads().
// ============================================================================

export interface RunPlanParams {
  accessToken: string;
  phoneNumberIds: string[];
  templateNames: string[];
  contactList: string[];
  apiVersion?: string;
}

export interface RunPlanResult {
  totalSent: number;
  totalFailed: number;
  durationMs: number;
  errors: Array<{ contact: string; error: string }>;
}

export async function runPlan(params: RunPlanParams): Promise<RunPlanResult> {
  const { accessToken, phoneNumberIds, templateNames, contactList, apiVersion = 'v25.0' } = params;
  const MAX_RETRIES = 3;

  const plan = buildPlan(phoneNumberIds, templateNames.length, contactList.length);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 runPlan() — Skip-label (sender_label: null)`);
  console.log(`   Jobs: ${plan.summary.totalJobs}`);
  console.log(`   Tempo estimado: ${(plan.summary.estimatedTimeMs / 1000).toFixed(0)}s`);
  console.log(`${'='.repeat(60)}\n`);

  let totalSent = 0;
  let totalFailed = 0;
  const errors: Array<{ contact: string; error: string }> = [];
  const startTime = Date.now();

  for (const job of plan.jobs) {
    const contact = contactList[job.leadIndex];
    const templateName = templateNames[job.templateIndex];
    let sent = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `https://graph.facebook.com/${apiVersion}/${job.phoneId}/messages`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: contact,
            type: 'template',
            template: {
              name: templateName,
              language: { code: 'pt_BR' },
            },
          }),
        });

        if (response.ok) {
          totalSent++;
          sent = true;
          break;
        }

        if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
          const waitMs = Math.pow(2, attempt) * 100;
          console.log(`⏳ HTTP ${response.status} — retry ${attempt + 1}/${MAX_RETRIES} em ${waitMs}ms`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }

        const errorText = await response.text();
        totalFailed++;
        errors.push({ contact, error: `HTTP ${response.status}: ${errorText.substring(0, 200)}` });
        break;
      } catch (err: any) {
        if (attempt < MAX_RETRIES) {
          const waitMs = Math.pow(2, attempt) * 100;
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
        totalFailed++;
        errors.push({ contact, error: err.message });
      }
    }

    if (sent) {
      await new Promise(resolve => setTimeout(resolve, job.delayMs));
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🏁 runPlan() FINALIZADO`);
  console.log(`   Enviadas: ${totalSent}/${plan.summary.totalJobs}`);
  console.log(`   Falhas: ${totalFailed}`);
  console.log(`   Duração: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`${'='.repeat(60)}\n`);

  return { totalSent, totalFailed, durationMs, errors };
}
