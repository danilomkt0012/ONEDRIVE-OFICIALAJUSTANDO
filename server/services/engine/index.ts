/**
 * ============================================================================
 * ENGINE EXPORTS - FASE 2
 * ============================================================================
 * 
 * Exporta todos os componentes do motor otimizado.
 * 
 * FASE 2 - Componentes adicionais:
 * - RequestPipeline: Overlap de requests (N concorrentes)
 * - BurstProfile: Perfil de burst agressivo em fases
 * - PhoneController: Controle independente por número
 * - MultiPhoneOrchestrator: Distribuição multi-número
 * - EtaCalculator: ETA real com confidence level
 */

// Componentes base
export { TokenBucket, type TokenBucketConfig } from './TokenBucket';
export { SlidingWindow, type SlidingWindowConfig, type RttStats } from './SlidingWindow';
export { FeedbackController, type FeedbackControllerConfig, type SendingPhase, type ControllerState } from './FeedbackController';
export { type CircuitState } from './CircuitBreaker';
export { AsyncCheckpoint, type CheckpointData, type LogEntry, getGlobalLogger } from './AsyncCheckpoint';

// Componentes FASE 2
export { RequestPipeline, type PipelineConfig, type PipelineStats, type PendingRequest } from './RequestPipeline';
export { BurstProfile, type BurstPhase, type BurstProfileConfig, type BurstState } from './BurstProfile';
export { EtaCalculator, type EtaEstimate, type EtaCalculatorConfig } from './EtaCalculator';
export { 
  PhoneController, 
  type PhoneControllerConfig, 
  type PhoneControllerStats,
  type SendResult 
} from './PhoneController';
export { 
  MultiPhoneOrchestrator, 
  type OrchestratorConfig, 
  type OrchestratorStats,
  type DistributionStrategy,
  type PhoneNumber 
} from './MultiPhoneOrchestrator';

// Motor principal V3 (Ultra-Estável - Foco em ZERO erros)
export { 
  UltraStableEngine, 
  type UltraStableEngineConfig, 
  type UltraStableStats,
  type WhatsAppTemplate
} from './UltraStableEngine';

// Componentes V3 (Ultra-Estável)
export { RetryQueue, type RetryQueueConfig, type RetryItem, type RetryQueueStats } from './RetryQueue';
export { SafeMode, type SafeModeConfig, type SafeModeState, type SafeModeStats, DEFAULT_SAFE_MODE_CONFIG, AGGRESSIVE_MODE_CONFIG } from './SafeMode';
export { ErrorClassification, type ErrorType, type ErrorCounts, type ErrorEvent, type ErrorClassificationStats } from './ErrorClassification';
export { TierDetection, type MessagingTier, type TierLimits, type PhoneNumberStatus, type TierDetectionConfig, getTierLimits, parseTierString } from './TierDetection';
export { PreflightValidator, type PreflightConfig, type TemplateInfo, type ValidationResult, type ValidationError, type ValidationWarning, type LeadData, validateE164 } from './PreflightValidator';
export { HumanBehavior, TemplatePacingBackoff, type HumanBehaviorConfig, type BaseType, type BaseTypeStrategy } from './HumanBehavior';

// DeliveryMetricsTracker (pacing & quality monitoring)
export { DeliveryMetricsTracker, deliveryMetricsTracker, fanOutWebhookStatus, registerActiveTracker, unregisterActiveTracker, registerResponseRateTracker, unregisterResponseRateTracker, fanOutDeliveredForResponseRate, fanOutReplyForResponseRate, registerPersistentCampaignTracker, unregisterPersistentCampaignTracker, getPersistentCampaignTracker, recordPersistentCampaignRead, getPersistentCampaignReadCount, getPersistentCampaignResponseStats, type DeliveryEventStatus, type DeliverySnapshot, type WindowedDeliveryRate, type QualityDashboardData } from './DeliveryMetricsTracker';

// Multi-Phone Coordinator V3 (FASE 6)
export { 
  MultiPhoneEngineCoordinator, 
  multiPhoneCoordinator,
  type PhoneNumberInfo,
  type LeadDistribution,
  type CoordinatorConfig
} from './MultiPhoneEngineCoordinator';

// Production hardening modules
export { FrequencyCap, frequencyCap, type FrequencyCapResult } from './FrequencyCap';
export { PortfolioControl, portfolioControl, type PortfolioStatus } from './PortfolioControl';
export { ProactiveSenderRotation, proactiveSenderRotation } from './ProactiveSenderRotation';

// Observability and decision modules (Task 3)
export { ResponseRateTracker, type ResponseRateSnapshot } from './ResponseRateTracker';
export { PhoneReputationScore, type PhoneReputation, type ReputationTier, type PhoneLifecycleState } from './PhoneReputationScore';
export { CampaignDecisionEngine, type DecisionAction, type DecisionEvent, type DecisionEngineConfig, type OnDecisionCallback, type OnPauseCampaignCallback, type OnSlowDownCallback, type OnDisableNumberCallback, type OnRebalanceCallback } from './CampaignDecisionEngine';
export { globalResponseRateTracker } from './globalResponseRateTracker';
