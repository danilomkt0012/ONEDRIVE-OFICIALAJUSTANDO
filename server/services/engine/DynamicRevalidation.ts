/**
 * ============================================================================
 * REVALIDAÇÃO DINÂMICA DURANTE CAMPANHA
 * ============================================================================
 * 
 * Verifica periodicamente se as condições permanecem válidas:
 * - Token de acesso válido
 * - Template ainda aprovado
 * - PhoneNumberId CONNECTED
 * - Tier inalterado
 * 
 * Se algo mudar, aciona pausa ou finalização graciosa.
 */

import { logError } from '../../utils/logger';

export interface RevalidationConfig {
  intervalMs: number;
  accessToken: string;
  phoneNumberId: string;
  templateName: string;
  templateLanguage: string;
  expectedTier?: string;
  onInvalidToken?: () => void;
  onTemplateRevoked?: () => void;
  onPhoneDisconnected?: () => void;
  onTierChanged?: (oldTier: string, newTier: string) => void;
}

export interface RevalidationResult {
  valid: boolean;
  tokenValid: boolean;
  templateApproved: boolean;
  phoneConnected: boolean;
  tierUnchanged: boolean;
  errors: string[];
  warnings: string[];
  timestamp: number;
}

export interface RevalidationStats {
  totalChecks: number;
  failedChecks: number;
  lastCheckAt: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastResult: RevalidationResult | null;
  isRunning: boolean;
}

export class DynamicRevalidation {
  private config: RevalidationConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning: boolean = false;
  private stats: RevalidationStats;
  private lastKnownTier: string | null = null;
  private consecutiveFailures: number = 0;
  private maxConsecutiveFailures: number = 3;
  
  // Callbacks
  private onValidationFailureCallback?: (result: RevalidationResult) => void;
  private onValidationSuccessCallback?: (result: RevalidationResult) => void;

  constructor(config: RevalidationConfig) {
    this.config = config;
    this.lastKnownTier = config.expectedTier || null;
    
    this.stats = {
      totalChecks: 0,
      failedChecks: 0,
      lastCheckAt: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastResult: null,
      isRunning: false
    };
  }

  /**
   * Inicia revalidação periódica
   */
  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.stats.isRunning = true;
    
    console.log(`\n🔍 Revalidação dinâmica iniciada (intervalo: ${this.config.intervalMs / 1000}s)`);
    
    // Run first check immediately
    this.runCheck();
    
    // Schedule periodic checks
    this.timer = setInterval(() => {
      this.runCheck();
    }, this.config.intervalMs);
  }

  /**
   * Para revalidação
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    this.isRunning = false;
    this.stats.isRunning = false;
    
    console.log(`\n🔍 Revalidação dinâmica parada`);
  }

  /**
   * Registra callback para falha de validação
   */
  onValidationFailure(callback: (result: RevalidationResult) => void): void {
    this.onValidationFailureCallback = callback;
  }

  /**
   * Registra callback para sucesso de validação
   */
  onValidationSuccess(callback: (result: RevalidationResult) => void): void {
    this.onValidationSuccessCallback = callback;
  }

  /**
   * Executa verificação completa
   */
  async runCheck(): Promise<RevalidationResult> {
    this.stats.totalChecks++;
    this.stats.lastCheckAt = Date.now();
    
    const result: RevalidationResult = {
      valid: true,
      tokenValid: true,
      templateApproved: true,
      phoneConnected: true,
      tierUnchanged: true,
      errors: [],
      warnings: [],
      timestamp: Date.now()
    };
    
    try {
      // Check token validity
      const tokenResult = await this.checkToken();
      result.tokenValid = tokenResult.valid;
      if (!tokenResult.valid) {
        result.errors.push(`Token inválido: ${tokenResult.error}`);
        result.valid = false;
      }
      
      // Check template status (only if token is valid)
      if (result.tokenValid) {
        const templateResult = await this.checkTemplate();
        result.templateApproved = templateResult.approved;
        if (!templateResult.approved) {
          result.errors.push(`Template não aprovado: status=${templateResult.status}`);
          result.valid = false;
        }
      }
      
      // Check phone number status (only if token is valid)
      if (result.tokenValid) {
        const phoneResult = await this.checkPhoneNumber();
        result.phoneConnected = phoneResult.connected;
        if (!phoneResult.connected) {
          result.errors.push(`Número desconectado: ${phoneResult.error}`);
          result.valid = false;
        }
        
        // Check tier change
        if (phoneResult.tier && this.lastKnownTier) {
          if (phoneResult.tier !== this.lastKnownTier) {
            result.tierUnchanged = false;
            result.warnings.push(`Tier alterado: ${this.lastKnownTier} → ${phoneResult.tier}`);
            
            // Notify tier change
            this.config.onTierChanged?.(this.lastKnownTier, phoneResult.tier);
            this.lastKnownTier = phoneResult.tier;
          }
        } else if (phoneResult.tier) {
          this.lastKnownTier = phoneResult.tier;
        }
      }
      
    } catch (error: any) {
      result.valid = false;
      result.errors.push(`Erro na verificação: ${error.message}`);
    }
    
    // Update stats
    this.stats.lastResult = result;
    
    if (result.valid) {
      this.stats.lastSuccessAt = Date.now();
      this.consecutiveFailures = 0;
      this.onValidationSuccessCallback?.(result);
    } else {
      this.stats.failedChecks++;
      this.stats.lastFailureAt = Date.now();
      this.consecutiveFailures++;
      
      console.log(`\n❌ Revalidação FALHOU:`);
      result.errors.forEach(e => console.log(`   - ${e}`));
      
      // Trigger specific callbacks
      if (!result.tokenValid) {
        this.config.onInvalidToken?.();
      }
      if (!result.templateApproved) {
        this.config.onTemplateRevoked?.();
      }
      if (!result.phoneConnected) {
        this.config.onPhoneDisconnected?.();
      }
      
      this.onValidationFailureCallback?.(result);
      
      // Stop after max consecutive failures
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        console.log(`\n⛔ Revalidação: ${this.maxConsecutiveFailures} falhas consecutivas - parando verificação`);
        this.stop();
      }
    }
    
    return result;
  }

  /**
   * Verifica validade do token
   */
  private async checkToken(): Promise<{ valid: boolean; error?: string }> {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v25.0/debug_token?input_token=${this.config.accessToken}&access_token=${this.config.accessToken}`,
        { method: 'GET' }
      );
      
      if (!response.ok) {
        return { valid: false, error: `HTTP ${response.status}` };
      }
      
      const data = await response.json() as any;
      
      if (data.data?.is_valid === false) {
        return { valid: false, error: data.data?.error?.message || 'Token expirado' };
      }
      
      // Check expiration
      if (data.data?.expires_at) {
        const expiresAt = data.data.expires_at * 1000;
        const now = Date.now();
        const oneHour = 3600000;
        
        if (expiresAt < now) {
          return { valid: false, error: 'Token expirado' };
        }
        
        if (expiresAt - now < oneHour) {
          console.log(`\n⚠️ Token expira em menos de 1 hora`);
        }
      }
      
      return { valid: true };
      
    } catch (error: any) {
      // Network errors should not invalidate token
      logError('DynamicRevalidation.checkToken', {}, error);
      return { valid: true }; // Assume valid on network error
    }
  }

  /**
   * Verifica status do template
   */
  private async checkTemplate(): Promise<{ approved: boolean; status?: string }> {
    try {
      // Get WABA ID first (simplified - in production would cache this)
      const wabaResponse = await fetch(
        `https://graph.facebook.com/v25.0/${this.config.phoneNumberId}?fields=whatsapp_business_account`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      if (!wabaResponse.ok) {
        // Can't verify - assume OK
        return { approved: true };
      }
      
      const wabaData = await wabaResponse.json() as any;
      const wabaId = wabaData.whatsapp_business_account?.id;
      
      if (!wabaId) {
        return { approved: true }; // Can't verify
      }
      
      // Get template status
      const templateResponse = await fetch(
        `https://graph.facebook.com/v25.0/${wabaId}/message_templates?name=${encodeURIComponent(this.config.templateName)}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      if (!templateResponse.ok) {
        return { approved: true }; // Can't verify
      }
      
      const templateData = await templateResponse.json() as any;
      const templates = templateData.data || [];
      
      // Find template with matching language
      const template = templates.find((t: any) => 
        t.name === this.config.templateName && 
        t.language === this.config.templateLanguage
      );
      
      if (!template) {
        return { approved: false, status: 'NOT_FOUND' };
      }
      
      if (template.status !== 'APPROVED') {
        return { approved: false, status: template.status };
      }
      
      return { approved: true, status: 'APPROVED' };
      
    } catch (error: any) {
      logError('DynamicRevalidation.checkTemplate', {}, error);
      return { approved: true }; // Assume valid on network error
    }
  }

  /**
   * Verifica status do número de telefone
   */
  private async checkPhoneNumber(): Promise<{ connected: boolean; tier?: string; error?: string }> {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v25.0/${this.config.phoneNumberId}?fields=quality_rating,messaging_limit_tier,verified_name,status`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      if (!response.ok) {
        if (response.status === 400 || response.status === 403) {
          return { connected: false, error: `Número inacessível (HTTP ${response.status})` };
        }
        return { connected: true }; // Network error - assume connected
      }
      
      const data = await response.json() as any;
      
      // Check if phone is in a bad state
      if (data.quality_rating === 'RED') {
        console.log(`\n⚠️ Número com quality_rating RED`);
      }
      
      // Extract tier
      const tier = data.messaging_limit_tier;
      
      return { connected: true, tier };
      
    } catch (error: any) {
      logError('DynamicRevalidation.checkPhoneNumber', {}, error);
      return { connected: true }; // Assume connected on network error
    }
  }

  /**
   * Força uma verificação imediata
   */
  async forceCheck(): Promise<RevalidationResult> {
    return this.runCheck();
  }

  /**
   * Retorna estatísticas
   */
  getStats(): RevalidationStats {
    return { ...this.stats };
  }

  /**
   * Verifica se está rodando
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Atualiza token (para refresh)
   */
  updateToken(newToken: string): void {
    this.config.accessToken = newToken;
    this.consecutiveFailures = 0;
  }
}
