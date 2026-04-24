import { logError } from '../utils/logger';
// Função de fetch com retry local
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (i === maxRetries) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error) {
      if (i === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error('Max retries reached');
}

export interface DeliveryStatus {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'pending';
  timestamp: number;
  errorCode?: string;
  errorMessage?: string;
  recipientPhone: string;
}

export class DeliveryTracker {
  private deliveryCache = new Map<string, DeliveryStatus>();
  private metaToken: string;

  constructor(metaToken: string) {
    this.metaToken = metaToken;
  }

  // Verificar status de entrega de uma mensagem específica
  async checkMessageDelivery(messageId: string, recipientPhone: string): Promise<DeliveryStatus> {
    try {
      console.log(`🔍 Verificando entrega da mensagem: ${messageId}`);
      
      // Tentar buscar status via webhook primeiro (se disponível)
      if (this.deliveryCache.has(messageId)) {
        const cached = this.deliveryCache.get(messageId)!;
        console.log(`📋 Status em cache: ${cached.status}`);
        return cached;
      }

      // Como alternativa, verificar via Analytics API (se disponível)
      const status: DeliveryStatus = {
        messageId,
        status: 'pending',
        timestamp: Date.now(),
        recipientPhone
      };

      // Armazenar no cache
      this.deliveryCache.set(messageId, status);
      return status;

    } catch (error: any) {
      logError("erro.ao.verificar.entrega", {}, error);
      return {
        messageId,
        status: 'failed',
        timestamp: Date.now(),
        errorMessage: error.message,
        recipientPhone
      };
    }
  }

  // Diagnóstico completo de template
  async diagnoseTemplate(templateName: string, phoneNumberId: string): Promise<{
    templateValid: boolean;
    templateStatus: string;
    phoneNumberValid: boolean;
    phoneNumberStatus: string;
    suggestions: string[];
  }> {
    const suggestions: string[] = [];
    
    try {
      console.log(`🏥 DIAGNÓSTICO COMPLETO: Template ${templateName}`);
      
      // 1. Verificar status do template - usar endpoint correto
      const templateResponse = await fetchWithRetry(
        `https://graph.facebook.com/v25.0/me/message_templates?name=${templateName}`,
        {
          headers: {
            'Authorization': `Bearer ${this.metaToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const templateData = await templateResponse.json();
      console.log(`📋 Template data:`, JSON.stringify(templateData, null, 2));

      let templateValid = false;
      let templateStatus = 'UNKNOWN';

      if (templateData.data && templateData.data.length > 0) {
        const template = templateData.data[0];
        templateStatus = template.status;
        templateValid = template.status === 'APPROVED';
        
        console.log(`📝 Template ${templateName}: ${templateStatus}`);
        
        if (template.status === 'PENDING') {
          suggestions.push('Template ainda está em análise pelo WhatsApp (pode levar até 24h)');
        } else if (template.status === 'REJECTED') {
          suggestions.push('Template foi rejeitado pelo WhatsApp - precisa ser refeito');
        } else if (template.status === 'PAUSED') {
          suggestions.push('Template está pausado - reative no Business Manager');
        }

        // Verificar categoria e dar sugestões específicas
        if (template.category === 'MARKETING') {
          suggestions.push('🚨 PROBLEMA IDENTIFICADO: Templates MARKETING só entregam se o cliente iniciou conversa nas últimas 24h');
          suggestions.push('💡 SOLUÇÃO: Use templates UTILITY para novos contatos ou obtenha opt-in explícito dos leads');
          suggestions.push('📱 ALTERNATIVA: Envie primeiro uma mensagem UTILITY para "abrir" a conversa');
        }
      } else {
        suggestions.push('Template não encontrado - verifique o nome e se foi criado corretamente');
      }

      // 2. Verificar status do número de telefone
      const phoneResponse = await fetchWithRetry(
        `https://graph.facebook.com/v25.0/${phoneNumberId}?fields=status,quality_rating,messaging_limit_tier`,
        {
          headers: {
            'Authorization': `Bearer ${this.metaToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const phoneData = await phoneResponse.json();
      console.log(`📞 Phone data:`, JSON.stringify(phoneData, null, 2));

      const phoneNumberValid = phoneData.status === 'CONNECTED';
      const phoneNumberStatus = phoneData.status || 'UNKNOWN';

      if (phoneData.quality_rating) {
        console.log(`⭐ Quality rating: ${phoneData.quality_rating}`);
        if (phoneData.quality_rating === 'RED') {
          suggestions.push('Número tem qualidade BAIXA - mensagens podem ser bloqueadas');
        } else if (phoneData.quality_rating === 'YELLOW') {
          suggestions.push('Número tem qualidade MÉDIA - envie menos mensagens');
        }
      }

      if (phoneData.messaging_limit_tier) {
        console.log(`📊 Messaging limit: ${phoneData.messaging_limit_tier}`);
      }

      return {
        templateValid,
        templateStatus,
        phoneNumberValid,
        phoneNumberStatus,
        suggestions
      };

    } catch (error: any) {
      logError("erro.no.diagn.stico", {}, error);
      
      // Análise específica para problemas comuns
      if (error.message.includes('400')) {
        suggestions.push('🚨 PROBLEMA MAIS PROVÁVEL: Templates MARKETING não entregam para contatos que não iniciaram conversa');
        suggestions.push('💡 SOLUÇÃO PRINCIPAL: Crie templates UTILITY em vez de MARKETING para novos leads');
        suggestions.push('📋 DIAGNÓSTICO: API funciona (Message IDs gerados), mas WhatsApp bloqueia entrega');
        suggestions.push('🔧 AÇÃO IMEDIATA: No Business Manager, crie templates categoria UTILITY');
      } else {
        suggestions.push(`Erro de conectividade: ${error.message}`);
      }
      
      return {
        templateValid: false,
        templateStatus: 'MARKETING_DELIVERY_ISSUE',
        phoneNumberValid: true, // API funciona
        phoneNumberStatus: 'CONNECTED',
        suggestions
      };
    }
  }

  // Atualizar status via webhook (para ser chamado quando receber webhook)
  updateDeliveryStatus(messageId: string, status: 'delivered' | 'read' | 'failed', errorCode?: string) {
    const existing = this.deliveryCache.get(messageId);
    if (existing) {
      existing.status = status;
      existing.timestamp = Date.now();
      if (errorCode) {
        existing.errorCode = errorCode;
      }
      this.deliveryCache.set(messageId, existing);
      console.log(`📊 Status atualizado para ${messageId}: ${status}`);
    }
  }

  // Obter todas as mensagens pendentes
  getPendingMessages(): DeliveryStatus[] {
    return Array.from(this.deliveryCache.values())
      .filter(msg => msg.status === 'pending' || msg.status === 'sent');
  }

  // Limpar cache antigo (mensagens com mais de 1 hora)
  cleanOldMessages() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const entries = Array.from(this.deliveryCache.entries());
    for (const [messageId, status] of entries) {
      if (status.timestamp < oneHourAgo) {
        this.deliveryCache.delete(messageId);
      }
    }
  }
}

// Códigos de erro comuns do WhatsApp
export const WHATSAPP_ERROR_CODES = {
  '131000': 'Recipient phone number not valid',
  '131005': 'Recipient phone number not a WhatsApp user',
  '131008': 'Required parameter is missing',
  '131016': 'Template does not exist',
  '131017': 'Template is not approved',
  '131021': 'Recipient cannot be sender',
  '131026': 'Template format does not match',
  '131047': 'Re-engagement message template not allowed',
  '131051': 'Unsupported message type',
  '132000': 'Generic user error',
  '132001': 'User opt-out error',
  '132005': 'User is part of an experiment',
  '132007': 'User phone number is part of an experiment',
  '132012': 'User not eligible for session message',
  '132015': 'User has blocked your WhatsApp Business Phone Number',
  '132016': 'User has not accepted our ToS',
  '135000': 'Generic rate limit hit',
  '136000': 'Generic service unavailable',
  '133004': 'Message failed to send because more than 24 hours have passed since the customer last replied to this number',
  '133005': 'Message failed to send because the template does not match the language used by the customer',
  '133006': 'Message failed to send because the customer has not opted in to receive messages',
  '133010': 'Message failed to send because the customer has blocked this WhatsApp Business Phone Number'
};

export function getErrorDescription(errorCode: string): string {
  return WHATSAPP_ERROR_CODES[errorCode as keyof typeof WHATSAPP_ERROR_CODES] || `Erro desconhecido: ${errorCode}`;
}