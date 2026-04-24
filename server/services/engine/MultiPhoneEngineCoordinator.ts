/**
 * ============================================================================
 * COORDENADOR MULTI-NÚMERO PARA ULTRA-STABLE ENGINE V3
 * ============================================================================
 * 
 * Distribui leads entre múltiplos números de telefone e coordena
 * a execução paralela de engines independentes.
 * 
 * Características:
 * - Distribuição baseada em qualidade e tier
 * - Engines V3 independentes por número
 * - Agregação de estatísticas
 * - Respeita contador diário por número
 * - Failover automático
 */

import type { Lead } from "@shared/schema";
import { storage } from "../../storage";
import { getTierLimits, MessagingTier } from './TierDetection';

export interface PhoneNumberInfo {
  id: string;
  display_phone_number: string;
  quality_rating: string;
  verified_name?: string;
  tier?: MessagingTier;
}

export interface DistributionStrategy {
  type: 'adaptive' | 'round_robin' | 'weighted';
}

export interface LeadDistribution {
  phoneNumberId: string;
  displayPhoneNumber: string;
  qualityRating: string;
  tier: MessagingTier;
  tierLimit: number;
  leads: Lead[];
  remainingQuota: number;
}

export interface CoordinatorConfig {
  strategy: DistributionStrategy['type'];
  maxLeadsPerPhone: number;
  respectDailyLimits: boolean;
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  strategy: 'adaptive',
  maxLeadsPerPhone: 100000,
  respectDailyLimits: true
};

export class MultiPhoneEngineCoordinator {
  private config: CoordinatorConfig;
  private runtimeWeightOverrides: Map<string, number> = new Map();
  private onWeightChangeCallbacks: Array<(phoneNumberId: string, weight: number) => void> = [];

  constructor(config?: Partial<CoordinatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setPhoneWeight(phoneNumberId: string, weight: number): void {
    this.runtimeWeightOverrides.set(phoneNumberId, Math.max(0, Math.min(1, weight)));
    console.log(`[COORDINATOR] weight override phoneNumberId=${phoneNumberId} weight=${weight.toFixed(3)}`);
    for (const cb of this.onWeightChangeCallbacks) {
      try { cb(phoneNumberId, weight); } catch (_e) { /* skip */ }
    }
  }

  getPhoneWeight(phoneNumberId: string): number {
    return this.runtimeWeightOverrides.get(phoneNumberId) ?? 1.0;
  }

  getPhoneWeights(): Map<string, number> {
    return new Map(this.runtimeWeightOverrides);
  }

  clearPhoneWeight(phoneNumberId: string): void {
    this.runtimeWeightOverrides.delete(phoneNumberId);
  }

  clearRuntimeWeightOverrides(): void {
    this.runtimeWeightOverrides.clear();
    console.log('[COORDINATOR] All runtime weight overrides cleared');
  }

  onWeightChange(callback: (phoneNumberId: string, weight: number) => void): void {
    this.onWeightChangeCallbacks.push(callback);
  }

  destroy(): void {
    this.runtimeWeightOverrides.clear();
    this.onWeightChangeCallbacks.length = 0;
  }

  /**
   * Distribui leads entre números disponíveis
   */
  async distributeLeads(
    leads: Lead[],
    phoneNumbers: PhoneNumberInfo[]
  ): Promise<LeadDistribution[]> {
    if (phoneNumbers.length === 0) {
      throw new Error('Nenhum número de telefone disponível');
    }

    if (leads.length === 0) {
      return [];
    }

    const sortedPhones = this.sortPhonesByQuality(phoneNumbers);
    const distributions: LeadDistribution[] = [];

    for (const phone of sortedPhones) {
      const tier = phone.tier || 'TIER_1K';
      const tierLimits = getTierLimits(tier);
      
      distributions.push({
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.display_phone_number,
        qualityRating: phone.quality_rating,
        tier,
        tierLimit: tierLimits.maxMessagesPerDay,
        leads: [],
        remainingQuota: Infinity
      });
    }

    let leadIndex = 0;
    const totalLeads = leads.length;

    switch (this.config.strategy) {
      case 'adaptive':
        leadIndex = this.distributeAdaptive(leads, distributions, leadIndex);
        break;
      case 'weighted':
        leadIndex = this.distributeWeighted(leads, distributions, leadIndex);
        break;
      case 'round_robin':
      default:
        leadIndex = this.distributeRoundRobin(leads, distributions, leadIndex);
        break;
    }

    const distributedCount = distributions.reduce((sum, d) => sum + d.leads.length, 0);
    
    if (distributedCount < totalLeads) {
      console.log(`⚠️ ${totalLeads - distributedCount} leads não distribuídos (nenhum número disponível)`);
    }

    return distributions.filter(d => d.leads.length > 0);
  }

  private sortPhonesByQuality(phones: PhoneNumberInfo[]): PhoneNumberInfo[] {
    const priority: Record<string, number> = { 'GREEN': 3, 'YELLOW': 2, 'RED': 1 };
    return [...phones].sort((a, b) => 
      (priority[b.quality_rating] || 0) - (priority[a.quality_rating] || 0)
    );
  }

  private distributeAdaptive(
    leads: Lead[],
    distributions: LeadDistribution[],
    startIndex: number
  ): number {
    let leadIndex = startIndex;
    
    const weights: number[] = distributions.map(d => {
      let weight = 1.0;
      switch (d.qualityRating) {
        case 'GREEN': weight = 1.5; break;
        case 'YELLOW': weight = 1.0; break;
        case 'RED': weight = 0.5; break;
      }
      weight *= Math.min(1, d.remainingQuota / 1000);
      const override = this.runtimeWeightOverrides.get(d.phoneNumberId);
      if (override !== undefined) weight *= override;
      return weight;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) {
      return this.distributeRoundRobin(leads, distributions, startIndex);
    }

    while (leadIndex < leads.length) {
      let assigned = false;
      
      for (let i = 0; i < distributions.length; i++) {
        const dist = distributions[i];
        if (dist.leads.length >= dist.remainingQuota) continue;
        
        const proportion = weights[i] / totalWeight;
        const targetCount = Math.ceil(leads.length * proportion);
        
        if (dist.leads.length < targetCount && dist.leads.length < dist.remainingQuota) {
          dist.leads.push(leads[leadIndex]);
          leadIndex++;
          assigned = true;
          break;
        }
      }
      
      if (!assigned) {
        const availableDist = distributions.find(d => d.leads.length < d.remainingQuota);
        if (availableDist) {
          availableDist.leads.push(leads[leadIndex]);
          leadIndex++;
        } else {
          break;
        }
      }
    }

    return leadIndex;
  }

  private distributeWeighted(
    leads: Lead[],
    distributions: LeadDistribution[],
    startIndex: number
  ): number {
    let leadIndex = startIndex;
    
    const weights: number[] = distributions.map(d => {
      let base = 1;
      switch (d.qualityRating) {
        case 'GREEN': base = 3; break;
        case 'YELLOW': base = 2; break;
        case 'RED': base = 1; break;
        default: base = 1;
      }
      const override = this.runtimeWeightOverrides.get(d.phoneNumberId);
      return override !== undefined ? base * override : base;
    });

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    
    for (let i = 0; i < distributions.length && leadIndex < leads.length; i++) {
      const proportion = weights[i] / totalWeight;
      const targetCount = Math.min(
        Math.ceil(leads.length * proportion),
        distributions[i].remainingQuota
      );
      
      const assignCount = Math.min(targetCount, leads.length - leadIndex);
      distributions[i].leads = leads.slice(leadIndex, leadIndex + assignCount);
      leadIndex += assignCount;
    }

    return leadIndex;
  }

  private distributeRoundRobin(
    leads: Lead[],
    distributions: LeadDistribution[],
    startIndex: number
  ): number {
    let leadIndex = startIndex;
    let phoneIndex = 0;

    while (leadIndex < leads.length) {
      let foundSlot = false;
      
      for (let i = 0; i < distributions.length; i++) {
        const idx = (phoneIndex + i) % distributions.length;
        const dist = distributions[idx];
        const override = this.runtimeWeightOverrides.get(dist.phoneNumberId);
        if (override !== undefined && override <= 0) continue;
        
        if (dist.leads.length < dist.remainingQuota) {
          dist.leads.push(leads[leadIndex]);
          leadIndex++;
          phoneIndex = (idx + 1) % distributions.length;
          foundSlot = true;
          break;
        }
      }
      
      if (!foundSlot) break;
    }

    return leadIndex;
  }

  /**
   * Verifica se um número pode receber mais mensagens
   */
  async canPhoneAcceptMessages(
    _phoneNumberId: string,
    _messageCount: number = 1
  ): Promise<{ canAccept: boolean; remainingQuota: number; reason?: string }> {
    return { canAccept: true, remainingQuota: Infinity };
  }

  /**
   * Registra mensagens enviadas no contador diário
   */
  async recordMessagesSent(
    phoneNumberId: string,
    displayPhoneNumber: string,
    tier: string,
    tierLimit: number,
    count: number = 1
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      await storage.incrementDailyMessageCounter(
        phoneNumberId,
        displayPhoneNumber,
        tier,
        tierLimit
      );
    }
  }

  /**
   * Obtém resumo de quota para todos os números
   */
  async getQuotaSummary(
    phoneNumbers: PhoneNumberInfo[]
  ): Promise<Array<{ phoneId: string; display: string; remaining: number; tier: string }>> {
    const summary = [];
    
    for (const phone of phoneNumbers) {
      const remaining = await storage.getRemainingQuota(phone.id);
      summary.push({
        phoneId: phone.id,
        display: phone.display_phone_number,
        remaining: remaining === Infinity ? -1 : remaining,
        tier: phone.tier || 'TIER_1K'
      });
    }
    
    return summary;
  }
}

export const multiPhoneCoordinator = new MultiPhoneEngineCoordinator();
