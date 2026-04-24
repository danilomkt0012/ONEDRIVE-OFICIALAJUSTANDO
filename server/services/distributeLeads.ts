import type { Lead, WhatsappTemplate, ApiConfiguration } from "@shared/schema";
import { getPhoneNumbers, type WhatsAppPhoneNumber } from "../meta/metaAPI";
import { logError } from '../utils/logger';

/**
 * Interface para distribuição de leads por número de telefone
 */
export interface LeadDistribution {
  phoneNumberId: string;
  displayPhoneNumber: string;
  leads: Lead[];
  messageCount: number;
}

/**
 * Interface para resultado da distribuição
 */
export interface DistributionResult {
  distributions: LeadDistribution[];
  totalLeads: number;
  totalPhones: number;
  averageLeadsPerPhone: number;
  maxMessagesPerPhone: number;
}

/**
 * Configurações para distribuição de leads
 */
export interface DistributionConfig {
  maxMessagesPerPhone: number;
  prioritizeActivePhones: boolean;
  excludeQualityBelow?: string; // 'GREEN', 'YELLOW', 'RED'
}

/**
 * Serviço para distribuir leads entre múltiplos números de WhatsApp
 */
export class LeadDistributionService {
  private readonly DEFAULT_MAX_MESSAGES = 2000; // Limite por número por campanha
  private readonly QUALITY_PRIORITY = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'];

  /**
   * Distribui uma lista de leads entre números de telefone disponíveis
   * @param leads - Lista de leads para distribuir
   * @param config - Configuração da API do WhatsApp
   * @param distributionConfig - Configurações de distribuição
   * @returns Resultado da distribuição
   */
  async distributeLeads(
    leads: Lead[],
    config: ApiConfiguration,
    distributionConfig?: Partial<DistributionConfig>
  ): Promise<DistributionResult> {
    const settings: DistributionConfig = {
      maxMessagesPerPhone: this.DEFAULT_MAX_MESSAGES,
      prioritizeActivePhones: true,
      ...distributionConfig
    };

    // Buscar números de telefone disponíveis
    const availablePhones = await this.getAvailablePhones(config, settings);
    
    if (availablePhones.length === 0) {
      throw new Error("Nenhum número de telefone disponível para envio");
    }

    // Calcular distribuição
    const distributions = this.calculateDistribution(leads, availablePhones, settings);
    
    // Gerar relatório
    const result: DistributionResult = {
      distributions,
      totalLeads: leads.length,
      totalPhones: availablePhones.length,
      averageLeadsPerPhone: Math.ceil(leads.length / availablePhones.length),
      maxMessagesPerPhone: settings.maxMessagesPerPhone
    };

    console.log(`Distribuição realizada: ${leads.length} leads entre ${availablePhones.length} números`);
    
    return result;
  }

  /**
   * Busca e filtra números de telefone disponíveis
   * @param config - Configuração da API
   * @param settings - Configurações de distribuição
   * @returns Lista de números filtrados
   */
  private async getAvailablePhones(
    config: ApiConfiguration,
    settings: DistributionConfig
  ): Promise<WhatsAppPhoneNumber[]> {
    try {
      let phones = await getPhoneNumbers(config.whatsappBusinessId, config.metaToken);
      
      // Filtrar por qualidade se especificado
      if (settings.excludeQualityBelow) {
        const minQualityIndex = this.QUALITY_PRIORITY.indexOf(settings.excludeQualityBelow);
        phones = phones.filter(phone => {
          const qualityIndex = this.QUALITY_PRIORITY.indexOf(phone.quality_rating);
          return qualityIndex !== -1 && qualityIndex <= minQualityIndex;
        });
      }

      // Priorizar números com melhor qualidade
      if (settings.prioritizeActivePhones) {
        phones.sort((a, b) => {
          const aIndex = this.QUALITY_PRIORITY.indexOf(a.quality_rating);
          const bIndex = this.QUALITY_PRIORITY.indexOf(b.quality_rating);
          return aIndex - bIndex;
        });
      }

      console.log(`Encontrados ${phones.length} números disponíveis para distribuição`);
      
      return phones;
    } catch (error) {
      logError("distributeLeads.getPhoneNumbers", {}, error);
      throw new Error("Falha ao obter números de telefone da API");
    }
  }

  /**
   * Calcula a distribuição otimizada de leads
   * @param leads - Lista de leads
   * @param phones - Números de telefone disponíveis
   * @param settings - Configurações de distribuição
   * @returns Lista de distribuições
   */
  private calculateDistribution(
    leads: Lead[],
    phones: WhatsAppPhoneNumber[],
    settings: DistributionConfig
  ): LeadDistribution[] {
    const distributions: LeadDistribution[] = [];
    const totalLeads = leads.length;
    const totalPhones = phones.length;
    
    // Calcular leads por telefone considerando o limite máximo
    const maxTotalMessages = totalPhones * settings.maxMessagesPerPhone;
    
    if (totalLeads > maxTotalMessages) {
      console.warn(
        `Atenção: ${totalLeads} leads excedem a capacidade máxima de ${maxTotalMessages} mensagens. ` +
        `Apenas os primeiros ${maxTotalMessages} leads serão processados.`
      );
    }

    // Limitar leads ao máximo processável
    const processableLeads = leads.slice(0, maxTotalMessages);
    
    // Distribuir leads de forma balanceada
    let leadIndex = 0;
    for (let phoneIndex = 0; phoneIndex < totalPhones; phoneIndex++) {
      const phone = phones[phoneIndex];
      const phoneLeads: Lead[] = [];
      
      // Calcular quantos leads este telefone deve receber
      const remainingPhones = totalPhones - phoneIndex;
      const remainingLeads = processableLeads.length - leadIndex;
      const leadsForThisPhone = Math.min(
        Math.ceil(remainingLeads / remainingPhones),
        settings.maxMessagesPerPhone
      );
      
      // Atribuir leads a este telefone
      for (let i = 0; i < leadsForThisPhone && leadIndex < processableLeads.length; i++) {
        phoneLeads.push(processableLeads[leadIndex]);
        leadIndex++;
      }
      
      // Criar distribuição para este telefone
      const distribution: LeadDistribution = {
        phoneNumberId: phone.id,
        displayPhoneNumber: phone.display_phone_number,
        leads: phoneLeads,
        messageCount: phoneLeads.length
      };
      
      distributions.push(distribution);
      
      console.log(
        `Número ${phone.display_phone_number} (${phone.quality_rating}): ${phoneLeads.length} leads`
      );
    }

    return distributions;
  }

  /**
   * Valida se a distribuição é viável
   * @param totalLeads - Total de leads
   * @param availablePhones - Números disponíveis
   * @param maxMessagesPerPhone - Limite por telefone
   * @returns Validação e sugestões
   */
  validateDistribution(
    totalLeads: number,
    availablePhones: number,
    maxMessagesPerPhone: number = this.DEFAULT_MAX_MESSAGES
  ): {
    isViable: boolean;
    maxCapacity: number;
    recommendedPhones: number;
    warnings: string[];
  } {
    const maxCapacity = availablePhones * maxMessagesPerPhone;
    const recommendedPhones = Math.ceil(totalLeads / maxMessagesPerPhone);
    const warnings: string[] = [];

    if (totalLeads > maxCapacity) {
      warnings.push(
        `${totalLeads} leads excedem a capacidade de ${maxCapacity} mensagens com ${availablePhones} números`
      );
    }

    if (availablePhones < recommendedPhones) {
      warnings.push(
        `Recomendado ter pelo menos ${recommendedPhones} números para otimizar o envio`
      );
    }

    const leadsPerPhone = Math.ceil(totalLeads / availablePhones);
    if (leadsPerPhone > maxMessagesPerPhone * 0.8) {
      warnings.push(
        `Cada número enviará aproximadamente ${leadsPerPhone} mensagens (próximo ao limite de ${maxMessagesPerPhone})`
      );
    }

    return {
      isViable: totalLeads <= maxCapacity,
      maxCapacity,
      recommendedPhones,
      warnings
    };
  }

  /**
   * Gera relatório detalhado da distribuição
   * @param result - Resultado da distribuição
   * @returns Relatório formatado
   */
  generateDistributionReport(result: DistributionResult): string {
    const lines: string[] = [];
    
    lines.push("=== RELATÓRIO DE DISTRIBUIÇÃO DE LEADS ===");
    lines.push(`Total de leads: ${result.totalLeads}`);
    lines.push(`Números utilizados: ${result.totalPhones}`);
    lines.push(`Média por número: ${result.averageLeadsPerPhone} leads`);
    lines.push(`Limite por número: ${result.maxMessagesPerPhone} mensagens`);
    lines.push("");
    
    lines.push("Distribuição por número:");
    result.distributions.forEach((dist, index) => {
      const percentage = ((dist.messageCount / result.totalLeads) * 100).toFixed(1);
      lines.push(
        `${index + 1}. ${dist.displayPhoneNumber}: ${dist.messageCount} leads (${percentage}%)`
      );
    });
    
    lines.push("");
    lines.push("Status: Distribuição concluída com sucesso");
    
    return lines.join("\n");
  }
}

/**
 * Instância padrão do serviço de distribuição
 */
export const leadDistributionService = new LeadDistributionService();

/**
 * Função utilitária para distribuir leads rapidamente
 * @param leads - Lista de leads
 * @param config - Configuração da API
 * @param maxMessagesPerPhone - Limite opcional por telefone
 * @returns Resultado da distribuição
 */
export async function distributeLeadsForCampaign(
  leads: Lead[],
  config: ApiConfiguration,
  maxMessagesPerPhone: number = 2000
): Promise<DistributionResult> {
  return leadDistributionService.distributeLeads(leads, config, {
    maxMessagesPerPhone,
    prioritizeActivePhones: true,
    excludeQualityBelow: 'RED' // Excluir apenas números com qualidade RED
  });
}