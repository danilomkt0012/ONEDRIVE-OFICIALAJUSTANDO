// Analisador específico para problemas de entrega do WhatsApp Business

export interface DeliveryAnalysis {
  issue: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  solution: string;
  actionItems: string[];
}

export class DeliveryAnalyzer {
  
  // Analisar por que mensagens não chegam mesmo com Message IDs gerados
  static analyzeDeliveryIssue(messageData: {
    messageId: string;
    templateCategory: string;
    recipientPhone: string;
    apiResponse: any;
  }): DeliveryAnalysis[] {
    const issues: DeliveryAnalysis[] = [];

    // Problema #1: Templates MARKETING
    if (messageData.templateCategory === 'MARKETING') {
      issues.push({
        issue: 'MARKETING_TEMPLATE_RESTRICTION',
        severity: 'critical',
        description: 'Templates MARKETING só entregam para clientes que iniciaram conversa nas últimas 24h. API aceita a mensagem mas WhatsApp bloqueia a entrega.',
        solution: 'Usar templates UTILITY para novos contatos',
        actionItems: [
          'Criar templates categoria UTILITY no Business Manager',
          'Substituir templates MARKETING por UTILITY nas campanhas',
          'Para leads existentes: enviar UTILITY primeiro para "abrir" conversa'
        ]
      });
    }

    // Problema #2: Números de teste
    if (messageData.recipientPhone.startsWith('556')) {
      issues.push({
        issue: 'TEST_PHONE_NUMBERS',
        severity: 'warning',
        description: 'Números de teste podem não ser usuários reais do WhatsApp ou estar em modo sandbox.',
        solution: 'Testar com números reais de WhatsApp',
        actionItems: [
          'Verificar se os números são usuários ativos do WhatsApp',
          'Testar com seu próprio número primeiro',
          'Confirmar se está em modo produção (não sandbox)'
        ]
      });
    }

    // Problema #3: Business Manager em modo restrito
    if (messageData.apiResponse?.messages?.[0]?.message_status === 'accepted') {
      issues.push({
        issue: 'API_ACCEPTS_BUT_NO_DELIVERY',
        severity: 'critical',
        description: 'API aceita mensagens mas não entrega. Isso é característico de templates MARKETING para contatos frios.',
        solution: 'Implementar estratégia de opt-in ou usar UTILITY',
        actionItems: [
          'Verificar qualidade do número no Business Manager',
          'Implementar sistema de opt-in dos leads',
          'Migrar para templates UTILITY para cold leads'
        ]
      });
    }

    return issues;
  }

  // Gerar sugestões práticas baseadas na análise
  static generateActionPlan(issues: DeliveryAnalysis[]): {
    immediate: string[];
    shortTerm: string[];
    longTerm: string[];
  } {
    const immediate: string[] = [];
    const shortTerm: string[] = [];
    const longTerm: string[] = [];

    for (const issue of issues) {
      if (issue.severity === 'critical') {
        immediate.push(...issue.actionItems.slice(0, 1));
        shortTerm.push(...issue.actionItems.slice(1));
      } else {
        longTerm.push(...issue.actionItems);
      }
    }

    return { immediate, shortTerm, longTerm };
  }

  // Verificar se número é usuário real do WhatsApp
  static analyzePhoneNumber(phone: string): {
    isLikelyReal: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];
    let isLikelyReal = true;

    // Padrões de números de teste comuns
    const testPatterns = [
      /^556\d{10}$/, // Números começando com 556
      /^1\d{10}$/, // Números US genéricos
      /^(\d)\1{9,}$/, // Números repetitivos
    ];

    for (const pattern of testPatterns) {
      if (pattern.test(phone)) {
        isLikelyReal = false;
        warnings.push('Número parece ser de teste - pode não ser usuário real do WhatsApp');
        break;
      }
    }

    // Verificar formato brasileiro
    if (phone.startsWith('55') && phone.length === 13) {
      const ddd = phone.substring(2, 4);
      const validDDDs = ['11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28', '31', '32', '33', '34', '35', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69', '71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
      
      if (!validDDDs.includes(ddd)) {
        warnings.push('DDD inválido para número brasileiro');
        isLikelyReal = false;
      }
    }

    return { isLikelyReal, warnings };
  }
}

// Constantes úteis para análise
export const DELIVERY_INSIGHTS = {
  MARKETING_TEMPLATE_ISSUE: {
    title: 'Templates MARKETING Bloqueados',
    description: 'WhatsApp bloqueia templates MARKETING para contatos que não iniciaram conversa',
    quickFix: 'Criar templates UTILITY no Business Manager'
  },
  
  COLD_LEAD_STRATEGY: {
    title: 'Estratégia para Leads Frios',
    description: 'Leads novos precisam de abordagem específica',
    quickFix: 'Usar templates UTILITY ou implementar opt-in'
  },
  
  PHONE_VALIDATION: {
    title: 'Validação de Números',
    description: 'Números de teste não recebem mensagens',
    quickFix: 'Testar com números reais de WhatsApp'
  }
};