import axios, { AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
import { formatToE164Strict } from '../services/engine/phoneUtils';
import { logError } from '../utils/logger';
import { proxyPoolManager, maskProxyUrl, ProxyUnavailableError } from '../services/proxyPool/ProxyPoolManager';

export class MetaAPIError extends Error {
  public readonly statusCode: number | undefined;
  public readonly metaCode: number | undefined;

  constructor(message: string, statusCode?: number, metaCode?: number) {
    super(message);
    this.name = 'MetaAPIError';
    this.statusCode = statusCode;
    this.metaCode = metaCode;
  }
}

function isProxyConnectionError(err: any): boolean {
  const code = err?.code;
  const msg = (err?.message || "").toLowerCase();
  const httpStatus: number | undefined = err?.response?.status;
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EPROTO" ||
    msg.includes("proxy") ||
    msg.includes("tunnel") ||
    msg.includes("connect failed") ||
    httpStatus === 407
  );
}

const TRANSIENT_META_CODES = new Set([
  1,       // API Unknown – temporary service error
  2,       // API Service – temporary service error
  4,       // API Too Many Calls – rate limit (retry with back-off)
  130429,  // Rate limit hit (sends HTTP 429 or 400)
  130472,  // User message limit exceeded (temporary 400)
  131048,  // Business account rate limited (temporary 400)
  131056,  // Pair rate limit – specific phone pair (temporary 400)
]);
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (err instanceof ProxyUnavailableError) {
        throw err;
      }
      const httpStatus: number | undefined = err?.response?.status;
      const metaCode: number | undefined = err?.response?.data?.error?.code;
      const isTransient =
        (httpStatus !== undefined && TRANSIENT_HTTP_STATUSES.has(httpStatus)) ||
        (metaCode !== undefined && TRANSIENT_META_CODES.has(metaCode));

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logError('metaAPI.retryWithBackoff', { attempt, maxAttempts, delayMs: delay }, lastErr);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Interface para dados de template do WhatsApp Business API
 */
export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: any[];
}

/**
 * Interface para números de telefone do WhatsApp Business
 */
export interface WhatsAppPhoneNumber {
  id: string;
  display_phone_number: string;
  verified_name: string;
  quality_rating: string;
}

/**
 * Interface para resposta de envio de mensagem
 */
export interface MessageResponse {
  messaging_product: string;
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
  }>;
}

/**
 * Interface para parâmetros de template
 */
export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
  text?: string;
  currency?: {
    fallback_value: string;
    code: string;
    amount_1000: number;
  };
  date_time?: {
    fallback_value: string;
  };
  image?: {
    link: string;
  };
  document?: {
    link: string;
    filename?: string;
  };
  video?: {
    link: string;
  };
}

/**
 * Classe principal para interação com a API do WhatsApp Business da Meta
 */
export class MetaWhatsAppAPI {
  private axiosInstance: AxiosInstance;
  private apiVersion: string = process.env.META_API_VERSION || process.env.API_VERSION || 'v25.0';
  private baseUrl: string;

  constructor(accessToken?: string) {
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken && { 'Authorization': `Bearer ${accessToken}` })
      }
    });

    // Interceptor para adicionar token e proxy rotativos automaticamente
    this.axiosInstance.interceptors.request.use((config) => {
      const token = accessToken || process.env.WHATSAPP_ACCESS_TOKEN;
      if (token && !config.headers.Authorization) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      if (!config.httpsAgent && proxyPoolManager.size > 0) {
        const proxyResult = proxyPoolManager.buildAgentForRotation();
        if (!proxyResult) {
          throw new ProxyUnavailableError(
            "Nenhum proxy ativo disponível no pool para chamada à Graph API. Verifique o status dos proxies."
          );
        }
        config.httpsAgent = proxyResult.agent;
        config.__proxyUrl = proxyResult.proxyUrl;
        console.info(`[MetaAPI] Usando proxy ${maskProxyUrl(proxyResult.proxyUrl)} para chamada Graph API`);
      }
      return config;
    });

    // Interceptor de resposta: marcar proxy como inativo e retry imediato com outro proxy
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      async (err: any) => {
        const proxyUrl: string | undefined = err.config?.__proxyUrl;
        const alreadyRetried: boolean = err.config?.__proxyRetried === true;
        if (proxyUrl && isProxyConnectionError(err)) {
          proxyPoolManager.markProxyFailed(proxyUrl, err.message || "Erro de conexão via proxy");
          if (!alreadyRetried && proxyPoolManager.size > 0) {
            const fallback = proxyPoolManager.buildAgentForRotation();
            if (fallback) {
              const retryConfig = { ...err.config } as typeof err.config;
              retryConfig.httpsAgent = fallback.agent;
              retryConfig.__proxyUrl = fallback.proxyUrl;
              retryConfig.__proxyRetried = true;
              console.info(`[MetaAPI] Retry com proxy alternativo ${maskProxyUrl(fallback.proxyUrl)} após falha de proxy`);
              return this.axiosInstance.request(retryConfig);
            }
          }
        }
        return Promise.reject(err);
      }
    );
  }

  /**
   * Busca todos os templates aprovados para uma conta de negócios
   * @param token - Token de acesso
   * @param businessId - ID da conta de negócios do WhatsApp
   * @returns Lista de templates
   */
  async getTemplates(token: string, businessId: string): Promise<WhatsAppTemplate[]> {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      
      const response: AxiosResponse = await this.axiosInstance.get(
        `/${businessId}/message_templates`,
        { 
          headers,
          params: {
            fields: 'id,name,language,category,status,components',
            limit: 1000
          }
        }
      );

      return response.data.data || [];
    } catch (error: any) {
      const errorData = error.response?.data || {};
      const errorMessage = errorData.error?.message || error.message;
      
      logError('metaAPI.fetchTemplates', { httpStatus: error.response?.status, errorCode: errorData.error?.code }, error);
      
      // Detectar erro de OAuth especificamente
      if (errorData.error?.code === 190 || errorMessage.includes('OAuth access token')) {
        throw new Error('OAUTH_ERROR: Token de acesso do WhatsApp Business API expirado ou inválido. Configure um novo token na página de Configurações.');
      }
      
      throw new Error(`Falha ao buscar templates: ${errorMessage}`);
    }
  }

  /**
   * Busca todos os números de telefone conectados à conta
   * @param businessId - ID da conta de negócios do WhatsApp  
   * @param token - Token de acesso (opcional, usa env se não fornecido)
   * @returns Lista de números de telefone
   */
  async getPhoneNumbers(businessId: string, token?: string): Promise<WhatsAppPhoneNumber[]> {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[MetaAPI] getPhoneNumbers businessId=${businessId}`);
      }
      
      const response: AxiosResponse = await this.axiosInstance.get(
        `/${businessId}/phone_numbers`,
        { 
          headers,
          params: {
            fields: 'id,display_phone_number,verified_name,quality_rating'
          }
        }
      );

      return response.data.data || [];
    } catch (error: any) {
      const errorData = error.response?.data || {};
      const errorMessage = errorData.error?.message || error.message;
      
      logError('metaAPI.fetchPhoneNumbers', { httpStatus: error.response?.status, errorCode: errorData.error?.code }, error);
      
      // Detectar erro de OAuth especificamente
      if (errorData.error?.code === 190 || errorMessage.includes('OAuth access token')) {
        throw new Error('OAUTH_ERROR: Token de acesso do WhatsApp Business API expirado ou inválido. Configure um novo token na página de Configurações.');
      }

      const enriched: any = new Error(`Falha ao buscar números: ${errorMessage}`);
      enriched.errorCode = errorData.error?.code;
      enriched.httpStatus = error.response?.status;
      throw enriched;
    }
  }

  /**
   * Validar componentes do template para evitar erro 135000
   * @param template - Template da API do WhatsApp
   * @param parameters - Parâmetros fornecidos
   * @returns true se válido
   */
  private validateTemplateComponents(template: any, parameters?: TemplateParameter[]): boolean {
    if (!template.components) {
      return !parameters || parameters.length === 0;
    }

    const bodyComponent = template.components.find((c: any) => c.type === 'BODY');
    if (!bodyComponent) {
      return !parameters || parameters.length === 0;
    }

    const expectedParams = bodyComponent.text?.match(/{{\d+}}/g)?.length || 0;
    const providedParams = parameters ? parameters.length : 0;

    return expectedParams === providedParams;
  }

  /**
   * Envia uma mensagem usando template do WhatsApp Business
   * @param phoneNumberId - ID do número de telefone remetente
   * @param recipientPhone - Número do destinatário (formato: 5511999999999 ou +5511999999999)
   * @param templateName - Nome do template aprovado
   * @param languageCode - Código do idioma (ex: pt_BR)
   * @param parameters - Parâmetros do template (opcional)
   * @param token - Token de acesso (opcional, usa env se não fornecido)
   * @returns Resposta da API com ID da mensagem
   */
  async sendTemplateMessage(
    phoneNumberId: string,
    recipientPhone: string,
    templateName: string,
    languageCode: string = 'pt_BR',
    parameters?: TemplateParameter[],
    token?: string,
    headerImageLink?: string,
    headerTextParameters?: TemplateParameter[],
    campaignId?: string
  ): Promise<MessageResponse> {
    try {
      const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
      if (!authToken) {
        throw new Error('Token de acesso é obrigatório para enviar mensagens');
      }

      if (!phoneNumberId || phoneNumberId.trim() === '') {
        throw new Error('Phone Number ID é obrigatório');
      }

      const formattedPhone = formatToE164Strict(recipientPhone);
      if (!formattedPhone.match(/^\+\d{1,15}$/)) {
        throw new Error(`Número inválido: ${recipientPhone}. Use formato E.164: +5511999999999`);
      }

      const headers = { Authorization: `Bearer ${authToken}` };
      
      const templateData: any = {
        name: templateName,
        language: {
          code: languageCode
        }
      };

      const components: any[] = [];
      if (headerImageLink) {
        components.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: headerImageLink } }]
        });
      } else if (headerTextParameters && headerTextParameters.length > 0) {
        components.push({ type: 'header', parameters: headerTextParameters });
      }
      if (parameters && parameters.length > 0) {
        components.push({ type: 'body', parameters });
      }
      if (components.length > 0) {
        templateData.components = components;
      }

      // PAYLOAD FINAL CONFORME ESPECIFICAÇÃO
      const messageData = {
        messaging_product: 'whatsapp', // OBRIGATÓRIO
        to: formattedPhone, // E.164 com '+'
        type: 'template',
        template: templateData
      };

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SEND] sendTemplateMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} template=${templateName} lang=${languageCode}`);
      }

      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendTemplateMessage(${templateName}→${recipientPhone})`
      );

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SEND] response: HTTP ${response.status} template=${templateName}`);
      }

      const messageId = response.data?.messages?.[0]?.id;
      const messageStatus = response.data?.messages?.[0]?.message_status;
      const waId = response.data?.contacts?.[0]?.wa_id;

      if (!messageId) {
        const bodyError = response.data?.error?.message || response.data?.error?.error_user_msg;
        const bodyCode = response.data?.error?.code;
        if (bodyError) {
          throw new Error(`API retornou erro no body: (#${bodyCode || '?'}) ${bodyError}`);
        }
        throw new Error(`API retornou resposta sem message ID. Status HTTP: ${response.status}. Body: ${JSON.stringify(response.data).slice(0, 300)}`);
      }

      return response.data;
    } catch (error: any) {
      const errorData = error.response?.data;
      const errStatus = error.response?.status || 'N/A';
      const campaignTag = campaignId ? ` campaign=${campaignId}` : '';
      logError('metaAPI.sendTemplate', { phone: recipientPhone, campaignId, httpStatus: errStatus, template: templateName }, error);
      console.error(`[SEND] FAILED sendTemplateMessage:${campaignTag} details:`, JSON.stringify({
        error: errorData?.error?.message || error.message,
        code: errorData?.error?.code,
        subcode: errorData?.error?.error_subcode,
        phoneNumberId,
        recipientPhone,
        templateName,
        campaignId: campaignId || undefined,
        httpStatus: errStatus,
        fullError: errorData ? JSON.stringify(errorData).slice(0, 800) : error.message
      }));
      
      if (errorData?.error?.error_data) {
        console.error('[SEND] ERROR_DATA:', JSON.stringify(errorData.error.error_data));
      }
      
      // TRATAMENTO ESPECÍFICO DE ERROS CONFORME CHECKLIST
      if (errorData?.error?.code === 135000) {
        const suggestions = [
          '• Verifique se o phone_number_id pertence à mesma WABA do token',
          '• Confirme que o número está "Connected" e "Hosted by Cloud API"',
          '• Valide se os parâmetros do template estão exatos (nem mais, nem menos)',
          '• Verifique se o token tem escopo whatsapp_business_messaging',
          '• Confirme se o App está em modo Live (não Development)'
        ];
        throw new Error(`(#135000) Erro de configuração. Verifique:\n${suggestions.join('\n')}`);
      }
      
      // Erro de token expirado/inválido
      if (errorData?.error?.code === 190) {
        throw new Error('Token expirado ou inválido. Configure um novo token válido.');
      }
      
      // Erro de permissões
      if (errorData?.error?.code === 200) {
        throw new Error('Permissões insuficientes. Verifique se o token tem escopo whatsapp_business_messaging.');
      }
      
      throw new Error(`Falha ao enviar mensagem: ${errorData?.error?.message || error.message}`);
    }
  }

  /**
   * Envia uma mensagem de template com botões
   * @param phoneNumberId - ID do número de telefone remetente
   * @param recipientPhone - Número do destinatário (formato: 5511999999999 ou +5511999999999)
   * @param templateName - Nome do template com botões
   * @param languageCode - Código do idioma
   * @param bodyParameters - Parâmetros para o corpo da mensagem
   * @param buttonParameters - Parâmetros para os botões (URLs dinâmicas)
   * @param token - Token de acesso (opcional)
   * @returns Resposta da API
   */
  async sendTemplateWithButtons(
    phoneNumberId: string,
    recipientPhone: string,
    templateName: string,
    languageCode: string = 'pt_BR',
    bodyParameters?: TemplateParameter[],
    buttonParameters?: TemplateParameter[],
    token?: string,
    headerImageLink?: string,
    headerTextParameters?: TemplateParameter[],
    campaignId?: string
  ): Promise<MessageResponse> {
    try {
      const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
      if (!authToken) {
        throw new Error('Token de acesso é obrigatório para enviar mensagens');
      }

      if (!phoneNumberId || phoneNumberId.trim() === '') {
        throw new Error('Phone Number ID é obrigatório');
      }

      const formattedPhone = formatToE164Strict(recipientPhone);
      if (!formattedPhone.match(/^\+\d{1,15}$/)) {
        throw new Error(`Número inválido: ${recipientPhone}. Use formato E.164: +5511999999999`);
      }

      const headers = { Authorization: `Bearer ${authToken}` };
      
      const components: any[] = [];

      if (headerImageLink) {
        components.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: headerImageLink } }]
        });
      } else if (headerTextParameters && headerTextParameters.length > 0) {
        components.push({ type: 'header', parameters: headerTextParameters });
      }
      
      // Adiciona parâmetros do corpo se fornecidos
      if (bodyParameters && bodyParameters.length > 0) {
        components.push({
          type: 'body',
          parameters: bodyParameters
        });
      }

      if (buttonParameters && buttonParameters.length > 0) {
        for (let i = 0; i < buttonParameters.length; i++) {
          const param = buttonParameters[i];
          const cleanText = param.text ? param.text.replace(/^https?:\/\//, '') : param.text;
          components.push({
            type: 'button',
            sub_type: 'url',
            index: i,
            parameters: [{ ...param, text: cleanText }]
          });
        }
      }

      // Construir template data para botões - CORREÇÃO CRÍTICA  
      const templateData: any = {
        name: templateName,
        language: {
          code: languageCode
        }
      };

      // Adicionar componentes apenas se existem
      if (components.length > 0) {
        templateData.components = components;
      }

      // PAYLOAD FINAL CONFORME ESPECIFICAÇÃO
      const messageData = {
        messaging_product: 'whatsapp', // OBRIGATÓRIO
        to: formattedPhone, // E.164 com '+'
        type: 'template',
        template: templateData
      };

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SEND] sendTemplateWithButtons: to=${recipientPhone} phoneNumberId=${phoneNumberId} template=${templateName} lang=${languageCode}`);
      }

      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendTemplateWithButtons(${templateName}→${recipientPhone})`
      );

      if (process.env.NODE_ENV !== 'production') {
        console.log(`[SEND] response: HTTP ${response.status} template=${templateName} (buttons)`);
      }

      const messageId = response.data?.messages?.[0]?.id;
      const messageStatus = response.data?.messages?.[0]?.message_status;
      const waId = response.data?.contacts?.[0]?.wa_id;

      if (!messageId) {
        const bodyError = response.data?.error?.message || response.data?.error?.error_user_msg;
        const bodyCode = response.data?.error?.code;
        if (bodyError) {
          throw new Error(`API retornou erro no body: (#${bodyCode || '?'}) ${bodyError}`);
        }
        throw new Error(`API retornou resposta sem message ID. Status HTTP: ${response.status}. Body: ${JSON.stringify(response.data).slice(0, 300)}`);
      }

      return response.data;
    } catch (error: any) {
      const errorData = error.response?.data;
      logError('metaAPI.sendTemplateWithButtons', {
        phoneNumberId,
        recipientPhone,
        templateName,
        campaignId: campaignId || undefined,
        httpStatus: error.response?.status,
        metaCode: errorData?.error?.code,
        errorData: errorData?.error?.error_data ? JSON.stringify(errorData.error.error_data).slice(0, 500) : undefined,
      }, error);
      
      // TRATAMENTO ESPECÍFICO DE ERROS CONFORME CHECKLIST
      if (errorData?.error?.code === 135000) {
        // Tentar buscar mais contexto do erro verificando o status do phone number
        let detailedError = '#135000 Generic User Error';
        
        try {
          const token = error.config?.headers?.Authorization?.replace('Bearer ', '');
          if (token && phoneNumberId) {
            const status = await this.getPhoneNumberStatus(phoneNumberId, token);
            
            if (status.account_mode === 'RESTRICTED') {
              detailedError = `#135000 - Phone number BLOQUEADO (RESTRICTED). Limite diário atingido.\n` +
                            `📊 Tier: ${status.messaging_limit_tier}\n` +
                            `⏰ Aguarde 24h ou delete/re-adicione o número no Meta Business Manager`;
            } else if (status.quality_rating === 'RED') {
              detailedError = `#135000 - Quality Rating RED. Número com qualidade muito baixa.\n` +
                            `🔴 Status: ${status.account_mode}\n` +
                            `📊 Tier: ${status.messaging_limit_tier}\n` +
                            `⚠️ Melhore a qualidade das mensagens para continuar enviando`;
            } else {
              detailedError = `#135000 - Erro de configuração do template.\n` +
                            `📊 Tier: ${status.messaging_limit_tier} | Quality: ${status.quality_rating} | Status: ${status.account_mode}\n` +
                            `✅ Phone status OK - verifique template e parâmetros`;
            }
          }
        } catch (statusError) {
          logError('metaAPI.sendTemplateWithButtons.fetchStatus135000', { phoneNumberId, templateName, recipientPhone }, statusError);
        }
        
        const suggestions = [
          '• Verifique se o phone_number_id pertence à mesma WABA do token',
          '• Confirme que o número está "Connected" e "Hosted by Cloud API"',
          '• Valide se os parâmetros do template estão exatos (body + buttons)',
          '• Verifique se o token tem escopo whatsapp_business_messaging',
          '• Confirme se o App está em modo Live (não Development)',
          '• DELETE e RE-ADICIONE o phone number no Meta Business Manager (solução mais efetiva)'
        ];
        throw new Error(`${detailedError}\n\n💡 Soluções:\n${suggestions.join('\n')}`);
      }
      
      // Erro de token expirado/inválido
      if (errorData?.error?.code === 190) {
        throw new Error('Token expirado ou inválido. Configure um novo token válido.');
      }
      
      // Erro de permissões
      if (errorData?.error?.code === 200) {
        throw new Error('Permissões insuficientes. Verifique se o token tem escopo whatsapp_business_messaging.');
      }
      
      throw new Error(`Falha ao enviar template com botões: ${errorData?.error?.message || error.message}`);
    }
  }

  async sendFreeFormMessage(
    phoneNumberId: string,
    recipientPhone: string,
    text: string,
    token?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) {
      throw new Error('Token de acesso é obrigatório para enviar mensagens');
    }

    if (!phoneNumberId || phoneNumberId.trim() === '') {
      throw new Error('Phone Number ID é obrigatório');
    }

    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };

    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'text',
      text: { body: text },
    };

    try {
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendFreeFormMessage(${recipientPhone})`
      );

      const messageId = response.data?.messages?.[0]?.id;
      if (!messageId) {
        throw new Error(`API retornou resposta sem message ID. Body: ${JSON.stringify(response.data).slice(0, 300)}`);
      }
      return response.data;
    } catch (err: any) {
      const metaError = err?.response?.data?.error;
      const httpStatus = err?.response?.status || 'N/A';
      if (metaError) {
        logError('metaAPI.sendFreeFormMessage', { phoneNumberId, recipientPhone, metaCode: metaError.code, httpStatus }, err);
        console.error(`[SEND] FAILED sendFreeFormMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} httpStatus=${httpStatus} code=${metaError.code} subcode=${metaError.error_subcode || 'N/A'} message=${metaError.message}`);
        throw new Error(`Meta API erro ${metaError.code}: ${metaError.message}`);
      }
      console.error(`[SEND] FAILED sendFreeFormMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} error=${err.message}`);
      throw err;
    }
  }

  async sendAudioMessage(
    phoneNumberId: string,
    recipientPhone: string,
    audioUrl: string,
    token?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    if (!audioUrl || !audioUrl.trim()) throw new Error('URL do áudio é obrigatória');

    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'audio',
      audio: { link: audioUrl },
    };
    try {
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendAudioMessage(${recipientPhone})`
      );
      const messageId = response.data?.messages?.[0]?.id;
      if (!messageId) throw new Error(`API retornou resposta sem message ID`);
      return response.data;
    } catch (err: any) {
      const httpStatus = err?.response?.status;
      const metaError = err?.response?.data?.error;
      if (metaError) {
        logError('metaAPI.sendAudioMessage', { phoneNumberId, recipientPhone, httpStatus, metaCode: metaError.code }, err);
        console.error(`[SEND] FAILED sendAudioMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} httpStatus=${httpStatus} code=${metaError.code} message=${metaError.message}`);
        throw new MetaAPIError(`Meta API erro ${metaError.code}: ${metaError.message}`, httpStatus, metaError.code);
      }
      console.error(`[SEND] FAILED sendAudioMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} error=${err.message}`);
      throw err;
    }
  }

  async uploadMediaToMeta(
    phoneNumberId: string,
    fileBuffer: Buffer,
    mimeType: string,
    filename: string,
    token?: string
  ): Promise<string> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório para upload de mídia');

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', fileBuffer, { filename, contentType: mimeType });

    try {
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/media`, form, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            ...form.getHeaders(),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        }),
        `uploadMediaToMeta(${phoneNumberId})`
      );
      const mediaId: string = response.data?.id;
      if (!mediaId) throw new Error('API retornou resposta sem media ID');
      return mediaId;
    } catch (err: any) {
      const httpStatus = err?.response?.status;
      const metaError = err?.response?.data?.error;
      if (metaError) {
        logError('metaAPI.uploadMediaToMeta', { phoneNumberId, filename, mimeType, httpStatus, metaCode: metaError.code }, err);
        throw new MetaAPIError(`Meta API erro ${metaError.code}: ${metaError.message}`, httpStatus, metaError.code);
      }
      const responseBody = err?.response?.data ? JSON.stringify(err.response.data) : 'N/A';
      const responseHeaders = err?.response?.headers ? JSON.stringify(err.response.headers) : 'N/A';
      console.error(`[SEND] FAILED uploadMediaToMeta: phoneNumberId=${phoneNumberId} filename=${filename} httpStatus=${httpStatus ?? 'N/A'} body=${responseBody} headers=${responseHeaders} error=${err?.message} stack=${err?.stack}`);
      logError('metaAPI.uploadMediaToMeta.generic', { phoneNumberId, filename, mimeType, httpStatus: String(httpStatus ?? 'N/A'), responseBody }, err);
      throw err;
    }
  }

  async sendVoiceNoteMessage(
    phoneNumberId: string,
    recipientPhone: string,
    mediaId: string,
    token?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    if (!mediaId || !mediaId.trim()) throw new Error('media_id é obrigatório para nota de voz');

    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'audio',
      audio: { id: mediaId, voice: true },
    };
    try {
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendVoiceNoteMessage(${recipientPhone})`
      );
      const messageId = response.data?.messages?.[0]?.id;
      if (!messageId) throw new Error(`API retornou resposta sem message ID`);
      return response.data;
    } catch (err: any) {
      const httpStatus = err?.response?.status;
      const metaError = err?.response?.data?.error;
      if (metaError) {
        logError('metaAPI.sendVoiceNoteMessage', { phoneNumberId, recipientPhone, httpStatus, metaCode: metaError.code }, err);
        throw new MetaAPIError(`Meta API erro ${metaError.code}: ${metaError.message}`, httpStatus, metaError.code);
      }
      const responseBody = err?.response?.data ? JSON.stringify(err.response.data) : 'N/A';
      const responseHeaders = err?.response?.headers ? JSON.stringify(err.response.headers) : 'N/A';
      console.error(`[SEND] FAILED sendVoiceNoteMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} httpStatus=${httpStatus ?? 'N/A'} body=${responseBody} headers=${responseHeaders} error=${err?.message} stack=${err?.stack}`);
      logError('metaAPI.sendVoiceNoteMessage.generic', { phoneNumberId, recipientPhone, httpStatus: String(httpStatus ?? 'N/A'), responseBody }, err);
      throw err;
    }
  }

  async sendImageMessageById(
    phoneNumberId: string,
    recipientPhone: string,
    mediaId: string,
    caption?: string,
    token?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    if (!mediaId || !mediaId.trim()) throw new Error('media_id da imagem é obrigatório');

    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const imagePayload: any = { id: mediaId };
    if (caption) imagePayload.caption = caption;
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'image',
      image: imagePayload,
    };
    try {
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendImageMessageById(${recipientPhone})`
      );
      const messageId = response.data?.messages?.[0]?.id;
      if (!messageId) throw new Error(`API retornou resposta sem message ID`);
      return response.data;
    } catch (err: any) {
      const metaError = err?.response?.data?.error;
      const httpStatus = err?.response?.status || 'N/A';
      if (metaError) {
        logError('metaAPI.sendImageMessageById', { phoneNumberId, recipientPhone, metaCode: metaError.code, httpStatus }, err);
        console.error(`[SEND] FAILED sendImageMessageById: to=${recipientPhone} phoneNumberId=${phoneNumberId} httpStatus=${httpStatus} code=${metaError.code} message=${metaError.message}`);
        throw new Error(`Meta API erro ${metaError.code}: ${metaError.message}`);
      }
      const responseBody = err?.response?.data ? JSON.stringify(err.response.data) : 'N/A';
      const responseHeaders = err?.response?.headers ? JSON.stringify(err.response.headers) : 'N/A';
      console.error(`[SEND] FAILED sendImageMessageById: to=${recipientPhone} phoneNumberId=${phoneNumberId} httpStatus=${httpStatus} body=${responseBody} headers=${responseHeaders} error=${err?.message} stack=${err?.stack}`);
      logError('metaAPI.sendImageMessageById.generic', { phoneNumberId, recipientPhone, httpStatus: String(httpStatus), responseBody }, err);
      throw err;
    }
  }

  async sendImageMessage(
    phoneNumberId: string,
    recipientPhone: string,
    imageUrl: string,
    caption?: string,
    token?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    if (!imageUrl || !imageUrl.trim()) throw new Error('URL da imagem é obrigatória');

    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const imagePayload: any = { link: imageUrl };
    if (caption) imagePayload.caption = caption;
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'image',
      image: imagePayload,
    };
    try {
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
        `sendImageMessage(${recipientPhone})`
      );
      const messageId = response.data?.messages?.[0]?.id;
      if (!messageId) throw new Error(`API retornou resposta sem message ID`);
      return response.data;
    } catch (err: any) {
      const metaError = err?.response?.data?.error;
      const httpStatus = err?.response?.status || 'N/A';
      if (metaError) {
        logError('metaAPI.sendImageMessage', { phoneNumberId, recipientPhone, metaCode: metaError.code, httpStatus }, err);
        console.error(`[SEND] FAILED sendImageMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} httpStatus=${httpStatus} code=${metaError.code} message=${metaError.message}`);
        throw new Error(`Meta API erro ${metaError.code}: ${metaError.message}`);
      }
      console.error(`[SEND] FAILED sendImageMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId} error=${err.message}`);
      throw err;
    }
  }

  async sendInteractiveButtons(
    phoneNumberId: string,
    recipientPhone: string,
    bodyText: string,
    buttons: Array<{ id: string; title: string }>,
    headerText?: string,
    footerText?: string,
    token?: string,
    headerImageUrl?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const interactive: any = {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: b.title.substring(0, 20) },
        })),
      },
    };
    if (headerImageUrl) {
      interactive.header = { type: 'image', image: { link: headerImageUrl } };
    } else if (headerText) {
      interactive.header = { type: 'text', text: headerText };
    }
    if (footerText) interactive.footer = { text: footerText };
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'interactive',
      interactive,
    };
    const response: AxiosResponse = await withRetry(
      () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
      `sendInteractiveButtons(${recipientPhone})`
    );
    const messageId = response.data?.messages?.[0]?.id;
    if (!messageId) throw new Error(`API retornou resposta sem message ID`);
    return response.data;
  }

  async sendDocumentMessage(
    phoneNumberId: string,
    recipientPhone: string,
    documentUrl: string,
    filename?: string,
    token?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const docPayload: any = { link: documentUrl };
    if (filename) docPayload.filename = filename;
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'document',
      document: docPayload,
    };
    console.log(`[SEND] sendDocumentMessage: to=${recipientPhone} phoneNumberId=${phoneNumberId}`);
    const response: AxiosResponse = await withRetry(
      () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
      `sendDocumentMessage(${recipientPhone})`
    );
    const messageId = response.data?.messages?.[0]?.id;
    if (!messageId) throw new Error(`API retornou resposta sem message ID`);
    console.log(`[SEND] document accepted: messageId=${messageId} to=${recipientPhone}`);
    return response.data;
  }

  async sendInteractiveList(
    phoneNumberId: string,
    recipientPhone: string,
    bodyText: string,
    buttonTitle: string,
    sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
    headerText?: string,
    footerText?: string,
    token?: string,
    headerImageUrl?: string
  ): Promise<MessageResponse> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) throw new Error('Token de acesso é obrigatório');
    const formattedPhone = formatToE164Strict(recipientPhone);
    const headers = { Authorization: `Bearer ${authToken}` };
    const interactive: any = {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonTitle.substring(0, 20), sections },
    };
    if (headerImageUrl) {
      interactive.header = { type: 'image', image: { link: headerImageUrl } };
    } else if (headerText) {
      interactive.header = { type: 'text', text: headerText };
    }
    if (footerText) interactive.footer = { text: footerText };
    const messageData = {
      messaging_product: 'whatsapp',
      to: formattedPhone,
      type: 'interactive',
      interactive,
    };
    console.log(`[SEND] sendInteractiveList: to=${recipientPhone} phoneNumberId=${phoneNumberId} sections=${sections.length}`);
    const response: AxiosResponse = await withRetry(
      () => this.axiosInstance.post(`/${phoneNumberId}/messages`, messageData, { headers }),
      `sendInteractiveList(${recipientPhone})`
    );
    const messageId = response.data?.messages?.[0]?.id;
    if (!messageId) throw new Error(`API retornou resposta sem message ID`);
    console.log(`[SEND] interactive list accepted: messageId=${messageId} to=${recipientPhone}`);
    return response.data;
  }

  async getQualityScore(phoneNumberId: string, token?: string): Promise<{
    qualityScore: any;
    status: string;
    messagingLimitTier: string;
  }> {
    const authToken = token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!authToken) {
      throw new Error('Token de acesso é obrigatório');
    }

    const headers = { Authorization: `Bearer ${authToken}` };

    const response: AxiosResponse = await this.axiosInstance.get(
      `/${phoneNumberId}`,
      {
        headers,
        params: {
          fields: 'quality_score,status,messaging_limit_tier',
        },
      }
    );

    return {
      qualityScore: response.data.quality_score,
      status: response.data.status || 'UNKNOWN',
      messagingLimitTier: response.data.messaging_limit_tier || 'TIER_1K',
    };
  }

  async getMessageStatus(messageId: string, token?: string): Promise<any> {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      
      const response: AxiosResponse = await this.axiosInstance.get(
        `/${messageId}`,
        { headers }
      );

      return response.data;
    } catch (error: any) {
      logError('metaAPI.checkPhoneStatus', { httpStatus: error.response?.status }, error);
      throw new Error(`Falha ao verificar status: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Valida se as credenciais da API estão funcionando
   * @param token - Token de acesso
   * @param businessId - ID da conta de negócios
   * @returns true se válidas, false caso contrário
   */
  async discoverWabaFromBM(bmId: string, token: string): Promise<{ wabaId: string; wabaName: string; phoneNumbers: WhatsAppPhoneNumber[] } | null> {
    try {
      console.log(`🔍 [WABA Auto] Tentando descobrir WABA dentro do BM ${bmId}...`);
      const headers = { Authorization: `Bearer ${token}` };

      const wabaRes: AxiosResponse = await this.axiosInstance.get(
        `/${bmId}/owned_whatsapp_business_accounts`,
        { headers, params: { fields: 'id,name,currency,timezone_id' } }
      );

      const wabas = wabaRes.data?.data || [];
      if (wabas.length === 0) {
        console.log(`❌ [WABA Auto] Nenhuma WABA encontrada no BM ${bmId}`);
        return null;
      }

      console.log(`✅ [WABA Auto] Encontradas ${wabas.length} WABAs no BM ${bmId}`);

      for (const waba of wabas) {
        try {
          const phones = await this.getPhoneNumbers(waba.id, token);
          if (phones.length > 0) {
            console.log(`✅ [WABA Auto] WABA ${waba.id} (${waba.name}) tem ${phones.length} números`);
            return { wabaId: waba.id, wabaName: waba.name, phoneNumbers: phones };
          }
        } catch (wabaErr: any) {
          console.log(`⚠️ [WABA Auto] WABA ${waba.id} sem acesso a phone_numbers, pulando...`, {
            error: wabaErr?.response?.data?.error?.message || wabaErr?.message,
          });
        }
      }

      const firstWaba = wabas[0];
      console.log(`⚠️ [WABA Auto] Nenhuma WABA com números acessíveis, usando primeira: ${firstWaba.id}`);
      return { wabaId: firstWaba.id, wabaName: firstWaba.name, phoneNumbers: [] };
    } catch (error: any) {
      console.log(`❌ [WABA Auto] Falha ao buscar WABAs do BM: ${error.response?.data?.error?.message || error.message}`);
      throw new MetaAPIError(
        error.response?.data?.error?.message || error.message,
        error.response?.status,
        error.response?.data?.error?.code
      );
    }
  }

  async discoverAllWabasFromBM(bmId: string, token: string): Promise<Array<{ wabaId: string; wabaName: string; phoneCount: number; status: string }>> {
    try {
      console.log(`🔍 [WABA Discovery] Buscando todas as WABAs do BM ${bmId}...`);
      const headers = { Authorization: `Bearer ${token}` };

      const wabaRes: AxiosResponse = await this.axiosInstance.get(
        `/${bmId}/owned_whatsapp_business_accounts`,
        { headers, params: { fields: 'id,name,currency,timezone_id' } }
      );

      const wabas = wabaRes.data?.data || [];
      if (wabas.length === 0) {
        console.log(`❌ [WABA Discovery] Nenhuma WABA encontrada no BM ${bmId}`);
        return [];
      }

      console.log(`✅ [WABA Discovery] Encontradas ${wabas.length} WABAs no BM ${bmId}`);

      const results: Array<{ wabaId: string; wabaName: string; phoneCount: number; status: string }> = [];

      for (const waba of wabas) {
        try {
          const phones = await this.getPhoneNumbers(waba.id, token);
          results.push({
            wabaId: waba.id,
            wabaName: waba.name || `WABA ${waba.id}`,
            phoneCount: phones.length,
            status: phones.length > 0 ? "active" : "no_phones",
          });
          console.log(`✅ [WABA Discovery] WABA ${waba.id} (${waba.name}) → ${phones.length} números`);
        } catch (wabaErr: any) {
          results.push({
            wabaId: waba.id,
            wabaName: waba.name || `WABA ${waba.id}`,
            phoneCount: 0,
            status: "error",
          });
          console.log(`⚠️ [WABA Discovery] WABA ${waba.id} sem acesso: ${wabaErr?.response?.data?.error?.message || wabaErr?.message}`);
        }
      }

      return results;
    } catch (error: any) {
      console.log(`❌ [WABA Discovery] Falha: ${error.response?.data?.error?.message || error.message}`);
      throw new MetaAPIError(
        error.response?.data?.error?.message || error.message,
        error.response?.status,
        error.response?.data?.error?.code
      );
    }
  }

  async subscribeWabaToApp(wabaId: string, token: string): Promise<{ success: boolean; response?: any; error?: string }> {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const response: AxiosResponse = await withRetry(
        () => this.axiosInstance.post(`/${wabaId}/subscribed_apps`, {}, { headers }),
        `subscribeWabaToApp(${wabaId})`,
        3,
        2000
      );
      return { success: true, response: response.data };
    } catch (err: any) {
      const metaError = err?.response?.data?.error;
      const httpStatus = err?.response?.status;
      logError('metaAPI.subscribeWabaToApp', { wabaId, httpStatus, metaCode: metaError?.code }, err);
      return {
        success: false,
        error: metaError?.message || err.message,
      };
    }
  }

  async validateCredentials(token: string, businessId: string): Promise<boolean> {
    try {
      await this.getPhoneNumbers(businessId, token);
      return true;
    } catch (error) {
      logError('metaAPI.validateCredentials', {}, error);
      return false;
    }
  }

  /**
   * Busca informações detalhadas de uma conta de negócios
   * @param businessId - ID da conta de negócios
   * @param token - Token de acesso (opcional)
   * @returns Informações da conta
   */
  async getBusinessAccountInfo(businessId: string, token?: string): Promise<any> {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      
      const response: AxiosResponse = await this.axiosInstance.get(
        `/${businessId}`,
        { 
          headers,
          params: {
            fields: 'id,name,timezone_id,message_template_namespace'
          }
        }
      );

      return response.data;
    } catch (error: any) {
      logError('metaAPI.fetchAccountInfo', { httpStatus: error.response?.status }, error);
      throw new Error(`Falha ao buscar informações: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Busca status detalhado de um phone number (tier, quality, account_mode)
   * CRÍTICO para evitar erro #135000
   * @param phoneNumberId - ID do número de telefone
   * @param token - Token de acesso
   * @returns Status completo do número
   */
  async getPhoneNumberStatus(phoneNumberId: string, token: string): Promise<{
    id: string;
    display_phone_number: string;
    verified_name: string;
    quality_rating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
    messaging_limit_tier: 'TIER_250' | 'TIER_1K' | 'TIER_100K' | 'TIER_UNLIMITED';
    account_mode: 'CONNECTED' | 'FLAGGED' | 'RESTRICTED' | 'PENDING';
  }> {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      
      console.log(`🔍 Buscando status detalhado do phone ${phoneNumberId}...`);
      
      const response: AxiosResponse = await this.axiosInstance.get(
        `/${phoneNumberId}`,
        { 
          headers,
          params: {
            fields: 'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,account_mode'
          }
        }
      );

      const data = response.data;
      
      console.log(`✅ Status do phone ${phoneNumberId}:`, {
        quality: data.quality_rating,
        tier: data.messaging_limit_tier,
        mode: data.account_mode
      });

      return {
        id: data.id,
        display_phone_number: data.display_phone_number,
        verified_name: data.verified_name,
        quality_rating: data.quality_rating || 'UNKNOWN',
        messaging_limit_tier: data.messaging_limit_tier || 'TIER_250',
        account_mode: data.account_mode || 'CONNECTED'
      };
    } catch (error: any) {
      logError('metaAPI.fetchPhoneNumberStatus', { httpStatus: error.response?.status }, error);
      throw new Error(`Falha ao buscar status: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Verifica se um phone number pode enviar mensagens
   * @param phoneNumberId - ID do número
   * @param token - Token de acesso
   * @returns true se pode enviar, false se bloqueado
   */
  async canSendMessages(phoneNumberId: string, token: string): Promise<{
    canSend: boolean;
    reason?: string;
    status: any;
  }> {
    try {
      const status = await this.getPhoneNumberStatus(phoneNumberId, token);
      
      if (status.account_mode === 'RESTRICTED') {
        return {
          canSend: false,
          reason: `Phone number RESTRICTED - limite diário atingido. Aguarde 24h ou aumente o tier.`,
          status
        };
      }
      
      if (status.account_mode === 'FLAGGED') {
        return {
          canSend: true,
          reason: `⚠️ ATENÇÃO: Phone number FLAGGED - quality baixa há 7+ dias. Risco de downgrade de tier.`,
          status
        };
      }
      
      if (status.quality_rating === 'RED') {
        return {
          canSend: true,
          reason: `⚠️ ATENÇÃO: Quality Rating RED - mensagens podem falhar. Melhore a qualidade urgentemente.`,
          status
        };
      }
      
      return {
        canSend: true,
        status
      };
    } catch (error: any) {
      logError('metaAPI.checkCanSend', {}, error);
      throw error;
    }
  }
}

// Instância padrão da API usando variáveis de ambiente
export const metaAPI = new MetaWhatsAppAPI();

/**
 * Funções utilitárias exportadas para uso direto
 */

/**
 * Busca templates aprovados para uma conta de negócios
 * @param businessId - ID da conta de negócios do WhatsApp
 * @param token - Token de acesso
 * @returns Lista de templates
 */
export async function getTemplates(businessId: string, token: string): Promise<WhatsAppTemplate[]> {
  return metaAPI.getTemplates(businessId, token);
}

/**
 * Busca números de telefone conectados
 * @param businessId - ID da conta de negócios
 * @param token - Token de acesso
 * @returns Lista de números
 */
export async function getPhoneNumbers(businessId: string, token: string): Promise<WhatsAppPhoneNumber[]> {
  return metaAPI.getPhoneNumbers(businessId, token);
}

/**
 * Envia mensagem usando template
 * @param phoneNumberId - ID do número remetente
 * @param recipientPhone - Número do destinatário
 * @param templateName - Nome do template
 * @param languageCode - Código do idioma (padrão: pt_BR)
 * @param parameters - Parâmetros do template
 * @param token - Token de acesso
 * @returns Resposta da API
 */
export async function sendTemplateMessage(
  phoneNumberId: string,
  recipientPhone: string,
  templateName: string,
  languageCode: string = 'pt_BR',
  parameters?: TemplateParameter[],
  token?: string,
  headerImageLink?: string,
  headerTextParameters?: TemplateParameter[],
  campaignId?: string
): Promise<MessageResponse> {
  return metaAPI.sendTemplateMessage(phoneNumberId, recipientPhone, templateName, languageCode, parameters, token, headerImageLink, headerTextParameters, campaignId);
}

/**
 * Envia template com botões
 * @param phoneNumberId - ID do número remetente
 * @param recipientPhone - Número do destinatário
 * @param templateName - Nome do template
 * @param languageCode - Código do idioma
 * @param bodyParameters - Parâmetros do corpo
 * @param buttonParameters - Parâmetros dos botões
 * @param token - Token de acesso
 * @returns Resposta da API
 */
export async function sendTemplateWithButtons(
  phoneNumberId: string,
  recipientPhone: string,
  templateName: string,
  languageCode: string = 'pt_BR',
  bodyParameters?: TemplateParameter[],
  buttonParameters?: TemplateParameter[],
  token?: string,
  headerImageLink?: string,
  headerTextParameters?: TemplateParameter[],
  campaignId?: string
): Promise<MessageResponse> {
  return metaAPI.sendTemplateWithButtons(phoneNumberId, recipientPhone, templateName, languageCode, bodyParameters, buttonParameters, token, headerImageLink, headerTextParameters, campaignId);
}

/**
 * Valida credenciais da API
 * @param businessId - ID da conta de negócios
 * @param token - Token de acesso
 * @returns true se válidas
 */
export async function validateCredentials(businessId: string, token: string): Promise<boolean> {
  return metaAPI.validateCredentials(businessId, token);
}

export async function getPhoneNumberStatus(phoneNumberId: string, token: string) {
  return metaAPI.getPhoneNumberStatus(phoneNumberId, token);
}

export async function sendAudioMessage(phoneNumberId: string, recipientPhone: string, audioUrl: string, token?: string) {
  return metaAPI.sendAudioMessage(phoneNumberId, recipientPhone, audioUrl, token);
}

export async function sendImageMessage(phoneNumberId: string, recipientPhone: string, imageUrl: string, caption?: string, token?: string) {
  return metaAPI.sendImageMessage(phoneNumberId, recipientPhone, imageUrl, caption, token);
}

export async function sendInteractiveButtons(phoneNumberId: string, recipientPhone: string, bodyText: string, buttons: Array<{id: string; title: string}>, headerText?: string, footerText?: string, token?: string) {
  return metaAPI.sendInteractiveButtons(phoneNumberId, recipientPhone, bodyText, buttons, headerText, footerText, token);
}

export async function sendInteractiveList(phoneNumberId: string, recipientPhone: string, bodyText: string, buttonTitle: string, sections: any[], headerText?: string, footerText?: string, token?: string) {
  return metaAPI.sendInteractiveList(phoneNumberId, recipientPhone, bodyText, buttonTitle, sections, headerText, footerText, token);
}

/**
 * Validates a Meta access token before starting a campaign.
 * Throws an error if the token is invalid, expired, or missing required scopes.
 * Logs [ALERT_TOKEN_EXPIRING] if the token expires within 7 days.
 */
export async function validateMetaConfig(accessToken: string, appId?: string): Promise<void> {
  if (!accessToken || !accessToken.trim()) {
    throw new Error('[validateMetaConfig] Token de acesso não configurado.');
  }

  const apiVersion = process.env.META_API_VERSION || process.env.API_VERSION || 'v25.0';
  const url = `https://graph.facebook.com/${apiVersion}/debug_token`;
  const inputToken = accessToken;
  const clientToken = appId
    ? `${appId}|${process.env.META_APP_SECRET || ''}`
    : accessToken;

  try {
    let httpsAgent: ReturnType<typeof proxyPoolManager.buildAgentForRotation> = null;
    if (proxyPoolManager.size > 0) {
      httpsAgent = proxyPoolManager.buildAgentForRotation();
      if (!httpsAgent) {
        throw new ProxyUnavailableError(
          "Nenhum proxy ativo disponível no pool para validateMetaConfig. Verifique o status dos proxies."
        );
      }
      console.info(`[validateMetaConfig] Usando proxy ${maskProxyUrl(httpsAgent.proxyUrl)} para chamada Graph API`);
    }
    let response;
    try {
      response = await axios.get(url, {
        params: {
          input_token: inputToken,
          access_token: clientToken,
        },
        timeout: 10000,
        ...(httpsAgent ? { httpsAgent: httpsAgent.agent } : {}),
      });
    } catch (reqErr: any) {
      if (httpsAgent && isProxyConnectionError(reqErr)) {
        proxyPoolManager.markProxyFailed(httpsAgent.proxyUrl, reqErr.message || "Erro de conexão");
      }
      throw reqErr;
    }

    const data = response.data?.data;

    if (!data) {
      throw new Error('[validateMetaConfig] Resposta inesperada da Graph API (sem campo data).');
    }

    if (!data.is_valid) {
      const reason = data.error?.message || 'Token inválido ou expirado';
      throw new Error(`[validateMetaConfig] Token inválido: ${reason}`);
    }

    const scopes: string[] = data.scopes || [];
    if (!scopes.includes('whatsapp_business_messaging')) {
      throw new Error(`[validateMetaConfig] Token sem escopo whatsapp_business_messaging. Escopos presentes: ${scopes.join(', ')}`);
    }

    if (data.expires_at && data.expires_at > 0) {
      const expiresAt = data.expires_at * 1000;
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      if (expiresAt < Date.now() + sevenDaysMs) {
        const expiresDate = new Date(expiresAt).toISOString();
        console.warn(`[ALERT_TOKEN_EXPIRING]`, { expiresAt: expiresDate, daysLeft: Math.floor((expiresAt - Date.now()) / 86400000) });
      }
    }
  } catch (err: any) {
    if (err instanceof ProxyUnavailableError || err.message.startsWith('[validateMetaConfig]') || err.message.startsWith('[ALERT_TOKEN_EXPIRING]')) {
      throw err;
    }
    const httpStatus = err.response?.status;
    const metaMsg = err.response?.data?.error?.message || err.message;
    throw new Error(`[validateMetaConfig] Falha ao verificar token (HTTP ${httpStatus || 'N/A'}): ${metaMsg}`);
  }
}

/**
 * Subscribes a WABA to the Meta App so that inbound webhook messages are delivered.
 * Calls POST /{wabaId}/subscribed_apps on the Graph API.
 * Retries up to 3 times with exponential back-off on transient errors.
 */
export async function subscribeWabaToApp(wabaId: string, accessToken: string): Promise<Record<string, unknown>> {
  if (!wabaId || !wabaId.trim()) {
    throw new Error('[subscribeWabaToApp] wabaId não pode ser vazio');
  }
  if (!accessToken || !accessToken.trim()) {
    throw new Error('[subscribeWabaToApp] accessToken não pode ser vazio');
  }

  const apiVersion = process.env.META_API_VERSION || process.env.API_VERSION || 'v25.0';
  const url = `https://graph.facebook.com/${apiVersion}/${wabaId}/subscribed_apps`;

  const attempt = async () => {
    let proxyOpts: ReturnType<typeof proxyPoolManager.buildAgentForRotation> = null;
    if (proxyPoolManager.size > 0) {
      proxyOpts = proxyPoolManager.buildAgentForRotation();
      if (!proxyOpts) {
        throw new ProxyUnavailableError(
          "Nenhum proxy ativo disponível no pool para subscribeWabaToApp. Verifique o status dos proxies."
        );
      }
      console.info(`[subscribeWabaToApp] Usando proxy ${maskProxyUrl(proxyOpts.proxyUrl)} para chamada Graph API`);
    }
    try {
      const response = await axios.post(
        url,
        {},
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000,
          ...(proxyOpts ? { httpsAgent: proxyOpts.agent } : {}),
        }
      );
      return response.data;
    } catch (reqErr: any) {
      if (proxyOpts && isProxyConnectionError(reqErr)) {
        proxyPoolManager.markProxyFailed(proxyOpts.proxyUrl, reqErr.message || "Erro de conexão");
      }
      throw reqErr;
    }
  };

  let lastErr: unknown;
  for (let i = 1; i <= 3; i++) {
    try {
      const data = await attempt();
      console.log(`[WABA_SUBSCRIBED_SUCCESS]`, { wabaId, attempt: i, response: JSON.stringify(data).slice(0, 300) });
      return data;
    } catch (err: any) {
      lastErr = err;
      if (err instanceof ProxyUnavailableError) {
        break;
      }
      const httpStatus: number | undefined = err?.response?.status;
      const metaCode: number | undefined = err?.response?.data?.error?.code;
      const isTransient =
        (httpStatus !== undefined && TRANSIENT_HTTP_STATUSES.has(httpStatus)) ||
        (metaCode !== undefined && TRANSIENT_META_CODES.has(metaCode));

      if (!isTransient || i === 3) {
        break;
      }
      const delayMs = 1000 * Math.pow(2, i - 1);
      logError('subscribeWabaToApp.retry', { wabaId, attempt: i, delayMs }, err);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  if (lastErr instanceof ProxyUnavailableError) {
    throw lastErr;
  }

  const httpStatus = (lastErr as any)?.response?.status;
  const metaMsg = (lastErr as any)?.response?.data?.error?.message || (lastErr as Error)?.message;
  console.error(`[WABA_SUBSCRIBE_FAILED]`, { wabaId, httpStatus, metaMsg });
  throw new Error(`[subscribeWabaToApp] Falha ao inscrever WABA ${wabaId} (HTTP ${httpStatus || 'N/A'}): ${metaMsg}`);
}