/**
 * ============================================================================
 * ORQUESTRADOR MULTI-NÚMERO
 * ============================================================================
 * 
 * Distribui leads entre múltiplos PhoneControllers.
 * Características:
 * - Distribuição dinâmica baseada em saúde/taxa
 * - Escala quase linear com número de telefones
 * - Balanceamento automático de carga
 * - Failover quando número fica indisponível
 * 
 * Estratégias de distribuição:
 * - ROUND_ROBIN: Rotação simples
 * - WEIGHTED: Por qualidade e taxa atual
 * - ADAPTIVE: Baseado em saúde e RTT
 */

import crypto from 'crypto';
import { PhoneController, PhoneControllerConfig, PhoneControllerStats, SendResult } from './PhoneController';
import { EtaCalculator, EtaEstimate } from './EtaCalculator';
import { proactiveSenderRotation } from './ProactiveSenderRotation';
import { logError } from '../../utils/logger';

export interface PhoneNumber {
  id: string;
  display_phone_number: string;
  quality_rating: string;
  verified_name?: string;
}

export type DistributionStrategy = 'round_robin' | 'weighted' | 'adaptive';

export interface OrchestratorConfig {
  strategy: DistributionStrategy;
  baseRefillRate: number;
  maxConcurrentPerPhone: number;
  targetRttMs: number;
  maxLeadsPerPhone: number;
  failoverEnabled: boolean;
}

export interface OrchestratorStats {
  totalPhones: number;
  activePhones: number;
  healthyPhones: number;
  totalSent: number;
  totalSuccess: number;
  totalFailed: number;
  overallRate: number;
  peakRate: number;
  eta: EtaEstimate;
  phoneStats: PhoneControllerStats[];
  strategy: DistributionStrategy;
}

interface PhoneWeight {
  phoneId: string;
  weight: number;
  cumulativeWeight: number;
}

export class MultiPhoneOrchestrator {
  private config: OrchestratorConfig;
  private controllers: Map<string, PhoneController> = new Map();
  private phoneWeights: PhoneWeight[] = [];
  private roundRobinIndex: number = 0;
  private etaCalculator: EtaCalculator;
  private totalLeads: number = 0;
  private startTime: number = 0;
  private peakRate: number = 0;
  private isActive: boolean = false;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = {
      strategy: config?.strategy ?? 'adaptive',
      baseRefillRate: config?.baseRefillRate ?? 0.5,
      maxConcurrentPerPhone: config?.maxConcurrentPerPhone ?? 3,
      targetRttMs: config?.targetRttMs ?? 300,
      maxLeadsPerPhone: config?.maxLeadsPerPhone ?? 100000,
      failoverEnabled: config?.failoverEnabled ?? true
    };
    
    this.etaCalculator = new EtaCalculator();
  }

  /**
   * Inicializa controllers para números de telefone
   */
  initialize(phoneNumbers: PhoneNumber[]): void {
    this.controllers.clear();
    
    const sortedPhones = [...phoneNumbers].sort((a, b) => {
      const priority: Record<string, number> = { 'GREEN': 3, 'YELLOW': 2, 'RED': 1 };
      return (priority[b.quality_rating] || 0) - (priority[a.quality_rating] || 0);
    });
    
    for (const phone of sortedPhones) {
      const controller = new PhoneController({
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.display_phone_number,
        qualityRating: phone.quality_rating,
        baseRefillRate: this.config.baseRefillRate,
        maxConcurrentRequests: this.config.maxConcurrentPerPhone,
        targetRttMs: this.config.targetRttMs,
        rttThresholdPercent: 20
      });
      
      this.controllers.set(phone.id, controller);
    }
    
    this.calculateWeightsSync();
    
    console.log(`\n🎯 Orquestrador inicializado com ${this.controllers.size} números`);
    console.log(`   📊 Estratégia: ${this.config.strategy}`);
    console.log(`   ⚡ Taxa base: ${this.config.baseRefillRate} msg/s por número`);
    console.log(`   🔄 Concorrência: ${this.config.maxConcurrentPerPhone} por número`);
  }

  /**
   * Calcula pesos para distribuição weighted/adaptive.
   * Agora consulta AdaptiveScoring (score 0-100) como base, com mínimo de 5%
   * para garantir que TODOS os números (inclusive novos) sempre recebam mensagens.
   */
  private async calculateWeights(): Promise<void> {
    this.phoneWeights = [];

    const ids = Array.from(this.controllers.keys());
    if (ids.length === 0) return;

    // Tenta usar o AdaptiveScoring (peso real baseado em performance)
    let scoreMap: Map<string, number> | null = null;
    try {
      const { getScoresMany, computeWeights } = await import('./AdaptiveScoring');
      const scores = await getScoresMany(ids);
      scoreMap = computeWeights(scores); // já normalizado e com mínimo de 5%
    } catch {
      scoreMap = null;
    }

    let cumulative = 0;
    const entries = Array.from(this.controllers.entries());
    for (const [phoneId, controller] of entries) {
      const stats = controller.getStats();
      let weight = 1.0;

      if (scoreMap && scoreMap.has(phoneId)) {
        // Score-based weight (já normalizado para somar 1)
        weight = Math.max(0.05, scoreMap.get(phoneId)!);
      } else {
        // Fallback legado por quality_rating
        switch (stats.qualityRating) {
          case 'GREEN': weight = 1.5; break;
          case 'YELLOW': weight = 1.0; break;
          case 'RED': weight = 0.5; break;
        }
      }

      // Bônus adaptativo (RTT)
      if (this.config.strategy === 'adaptive') {
        if (stats.avgRttMs > 0 && stats.avgRttMs < this.config.targetRttMs) weight *= 1.15;
        else if (stats.avgRttMs > this.config.targetRttMs * 1.5) weight *= 0.85;
      }

      // Garante peso mínimo de 5% — nunca zera um número
      const minFloor = scoreMap ? 0.05 : 0.1;
      if (weight < minFloor) weight = minFloor;

      cumulative += weight;
      this.phoneWeights.push({ phoneId, weight, cumulativeWeight: cumulative });
    }
  }

  /** Wrapper síncrono para compatibilidade com código legado que chama calculateWeights() sync */
  private calculateWeightsSync(): void {
    // Trigger async recompute em background, mas mantém último cálculo
    this.calculateWeights().catch(() => {});
  }

  /**
   * Inicia orquestrador para campanha
   */
  start(totalLeads: number): void {
    this.totalLeads = totalLeads;
    this.startTime = Date.now();
    this.peakRate = 0;
    this.isActive = true;
    
    const leadsPerPhone = Math.ceil(totalLeads / this.controllers.size);
    
    const controllers = Array.from(this.controllers.values());
    for (const controller of controllers) {
      controller.start(leadsPerPhone);
    }
    
    this.etaCalculator.start(totalLeads);
    
    console.log(`\n🚀 Orquestrador iniciado para ${totalLeads} leads`);
  }

  /**
   * Seleciona próximo número para envio
   */
  selectPhone(): PhoneController | null {
    if (this.controllers.size === 0) return null;
    
    const healthyControllers = Array.from(this.controllers.values())
      .filter(c => c.isHealthy() && c.canSubmit());
    
    if (healthyControllers.length === 0) {
      const anyAvailable = Array.from(this.controllers.values())
        .find(c => c.canSubmit());
      return anyAvailable || null;
    }
    
    let selected: PhoneController;
    switch (this.config.strategy) {
      case 'round_robin':
        selected = this.selectRoundRobin(healthyControllers);
        break;
      case 'weighted':
      case 'adaptive':
        selected = this.selectWeighted(healthyControllers);
        break;
      default:
        selected = healthyControllers[0];
    }

    const selectedId = selected.getPhoneNumberId();
    if (proactiveSenderRotation.shouldRotate(selectedId) && healthyControllers.length > 1) {
      const alternatives = healthyControllers.filter(c => c.getPhoneNumberId() !== selectedId);
      if (alternatives.length > 0) {
        const altIdx = crypto.randomInt(0, alternatives.length);
        const altSelected = alternatives[altIdx];
        proactiveSenderRotation.recordSend(altSelected.getPhoneNumberId());
        return altSelected;
      }
    }
    proactiveSenderRotation.recordSend(selectedId);

    return selected;
  }

  /**
   * Seleção round-robin
   */
  private selectRoundRobin(controllers: PhoneController[]): PhoneController {
    const controller = controllers[this.roundRobinIndex % controllers.length];
    this.roundRobinIndex++;
    return controller;
  }

  /**
   * Seleção por peso
   */
  private selectWeighted(controllers: PhoneController[]): PhoneController {
    const availableIds = new Set(controllers.map(c => c.getPhoneNumberId()));
    const availableWeights = this.phoneWeights.filter(w => availableIds.has(w.phoneId));
    
    if (availableWeights.length === 0) return controllers[0];
    
    const totalWeight = availableWeights.reduce((sum, w) => sum + w.weight, 0);
    const random = (crypto.randomInt(0, 1000000) / 1000000) * totalWeight;
    
    let cumulative = 0;
    for (const pw of availableWeights) {
      cumulative += pw.weight;
      if (random <= cumulative) {
        return this.controllers.get(pw.phoneId)!;
      }
    }
    
    return controllers[0];
  }

  /**
   * Retorna total de slots disponíveis
   */
  totalAvailableSlots(): number {
    let total = 0;
    const controllers = Array.from(this.controllers.values());
    for (const controller of controllers) {
      total += controller.availableSlots();
    }
    return total;
  }

  /**
   * Aguarda qualquer slot disponível
   */
  async waitForAnySlot(): Promise<PhoneController | null> {
    const promises: Promise<{ controller: PhoneController; waitTime: number }>[] = [];
    
    const controllers = Array.from(this.controllers.values());
    for (const controller of controllers) {
      if (controller.isHealthy()) {
        promises.push(
          controller.waitForSlot().then((waitTime: number) => ({ controller, waitTime }))
        );
      }
    }
    
    if (promises.length === 0) {
      const anyController = controllers[0];
      if (anyController) {
        await anyController.waitForSlot();
        return anyController;
      }
      return null;
    }
    
    const result = await Promise.race(promises);
    return result.controller;
  }

  /**
   * Atualiza pesos periodicamente
   */
  updateWeights(): void {
    if (this.config.strategy === 'adaptive') {
      this.calculateWeightsSync();
    }
  }

  /**
   * Registra progresso para ETA
   */
  recordProgress(totalSuccess: number): void {
    this.etaCalculator.recordProgress(totalSuccess);
    
    const elapsed = (Date.now() - this.startTime) / 1000;
    const currentRate = elapsed > 0 ? totalSuccess / elapsed : 0;
    
    if (currentRate > this.peakRate) {
      this.peakRate = currentRate;
    }
  }

  /**
   * Drena todos os controllers
   */
  async drainAll(): Promise<void> {
    const drainPromises = Array.from(this.controllers.values())
      .map(c =>
        c.drain().catch((err: Error) => {
          console.error('[MultiPhoneOrchestrator] drainAll: individual controller drain failed', {
            error: err.message,
            stack: err.stack,
          });
        })
      );

    await Promise.all(drainPromises);
  }

  /**
   * Para todos os controllers
   */
  stop(): void {
    this.isActive = false;
    
    const controllers = Array.from(this.controllers.values());
    for (const controller of controllers) {
      controller.stop();
    }
  }

  /**
   * Retorna estatísticas completas
   */
  getStats(): OrchestratorStats {
    const phoneStats: PhoneControllerStats[] = [];
    let totalSent = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let activePhones = 0;
    let healthyPhones = 0;
    
    const controllers = Array.from(this.controllers.values());
    for (const controller of controllers) {
      const stats = controller.getStats();
      phoneStats.push(stats);
      
      totalSent += stats.totalSent;
      totalSuccess += stats.successCount;
      totalFailed += stats.failedCount;
      
      if (controller.isRunning()) activePhones++;
      if (controller.isHealthy()) healthyPhones++;
    }
    
    const elapsed = (Date.now() - this.startTime) / 1000;
    const overallRate = elapsed > 0 ? totalSuccess / elapsed : 0;
    
    return {
      totalPhones: this.controllers.size,
      activePhones,
      healthyPhones,
      totalSent,
      totalSuccess,
      totalFailed,
      overallRate: Math.round(overallRate * 100) / 100,
      peakRate: Math.round(this.peakRate * 100) / 100,
      eta: this.etaCalculator.getEstimate(),
      phoneStats,
      strategy: this.config.strategy
    };
  }

  /**
   * Retorna controller por ID
   */
  getController(phoneId: string): PhoneController | undefined {
    return this.controllers.get(phoneId);
  }

  /**
   * Retorna todos os controllers
   */
  getAllControllers(): PhoneController[] {
    return Array.from(this.controllers.values());
  }

  /**
   * Verifica se está ativo
   */
  isRunning(): boolean {
    return this.isActive;
  }

  /**
   * Retorna número de telefones ativos
   */
  activePhoneCount(): number {
    return Array.from(this.controllers.values())
      .filter(c => c.isRunning() && c.isHealthy()).length;
  }
}
