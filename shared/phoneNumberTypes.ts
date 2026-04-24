export interface PhoneNumberWithStatus {
  id: string;
  phoneNumberId: string;
  displayPhone: string;
  maskedPhone: string;
  verifiedName: string;
  qualityRating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  tier: 'TIER_250' | 'TIER_1K' | 'TIER_100K' | 'TIER_UNLIMITED';
  tierLimit: number;
  accountMode: 'CONNECTED' | 'FLAGGED' | 'RESTRICTED' | 'PENDING';
  status: 'AVAILABLE' | 'BUSY' | 'BLOCKED' | 'DEGRADED';
  canSend: boolean;
  estimatedDailyLimit: number;
  currentUsage?: number;
}

export interface PhoneSelectionConfig {
  selectedPhoneIds: string[];
  distributionStrategy: 'round_robin' | 'weighted' | 'adaptive';
  maxLeadsPerPhone: number;
  enableFailover: boolean;
}

export interface ThroughputEstimate {
  totalPhones: number;
  availablePhones: number;
  estimatedMsgPerSec: number;
  estimatedDailyCapacity: number;
  estimatedTimeToComplete: number;
  breakdown: {
    phoneId: string;
    displayPhone: string;
    contribution: number;
    limit: number;
  }[];
}

export type DistributionStrategy = 'round_robin' | 'weighted' | 'adaptive';

export const DISTRIBUTION_STRATEGIES: { value: DistributionStrategy; label: string; description: string }[] = [
  { 
    value: 'adaptive', 
    label: 'Adaptativo (Recomendado)', 
    description: 'Distribui baseado em saúde, RTT e taxa atual de cada número' 
  },
  { 
    value: 'weighted', 
    label: 'Por Qualidade', 
    description: 'Prioriza números com melhor quality rating (GREEN > YELLOW > RED)' 
  },
  { 
    value: 'round_robin', 
    label: 'Alternado', 
    description: 'Alterna entre os números de forma sequencial' 
  }
];
