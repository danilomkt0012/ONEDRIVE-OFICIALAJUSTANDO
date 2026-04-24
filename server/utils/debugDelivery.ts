/**
 * Utilitários para debugging de entrega de mensagens WhatsApp
 */

import { sendTemplateMessage } from "../meta/metaAPI";

export interface DeliveryTestResult {
  success: boolean;
  messageId?: string;
  error?: string;
  apiResponse?: any;
}

/**
 * Testa o envio de uma mensagem simples para verificar se está chegando
 */
export async function testMessageDelivery(
  phoneNumberId: string,
  recipientPhone: string,
  templateName: string,
  metaToken: string
): Promise<DeliveryTestResult> {
  try {
    console.log(`🧪 TESTE DE ENTREGA:`);
    console.log(`   📱 De: ${phoneNumberId}`);
    console.log(`   📞 Para: ${recipientPhone}`);
    console.log(`   📝 Template: ${templateName}`);
    
    const response = await sendTemplateMessage(
      phoneNumberId,
      recipientPhone,
      templateName,
      'pt_BR',
      undefined,
      metaToken
    );
    
    console.log(`✅ TESTE ENVIADO COM SUCESSO:`);
    console.log(`   🆔 Message ID: ${response.messages?.[0]?.id}`);
    console.log(`   📊 Resposta completa:`, JSON.stringify(response, null, 2));
    
    return {
      success: true,
      messageId: response.messages?.[0]?.id,
      apiResponse: response
    };
    
  } catch (error: any) {
    console.log(`❌ TESTE FALHOU:`);
    console.log(`   🚨 Erro: ${error.message}`);
    console.log(`   📊 Detalhes:`, error);
    
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Verifica se o formato do número está correto
 */
export function validatePhoneFormat(phone: string): { valid: boolean; formatted?: string; error?: string } {
  // Remover caracteres não numéricos
  const cleanPhone = phone.replace(/\D/g, '');
  
  // Verificar se tem 13 dígitos (55 + 11 dígitos do número brasileiro)
  if (cleanPhone.length !== 13) {
    return {
      valid: false,
      error: `Número deve ter 13 dígitos (55 + DDD + número), encontrado: ${cleanPhone.length} dígitos`
    };
  }
  
  // Verificar se começa com 55 (código do Brasil)
  if (!cleanPhone.startsWith('55')) {
    return {
      valid: false,
      error: `Número deve começar com 55 (código do Brasil), encontrado: ${cleanPhone.substring(0, 2)}`
    };
  }
  
  return {
    valid: true,
    formatted: cleanPhone
  };
}