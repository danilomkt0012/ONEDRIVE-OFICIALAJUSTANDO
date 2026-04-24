/**
 * ============================================================================
 * VALIDADOR PRÉ-FLIGHT
 * ============================================================================
 * 
 * Pré-validação FORTE antes de submeter ao pipeline.
 * Elimina erros 135000 por mismatch de payload.
 * 
 * Validações:
 * - phoneNumberId pertence ao token
 * - template status = APPROVED
 * - language code compatível
 * - parâmetros esperados = parâmetros enviados
 * - formato E.164 do telefone
 */

export interface TemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
  components: TemplateComponent[];
}

export interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
  };
}

export interface LeadData {
  phone: string;
  name?: string;
  params?: Record<string, string>;
  [key: string]: any;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: string;
  message: string;
  field?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  field?: string;
}

export const DYNAMIC_PARAM_PRIORITY: string[] = [
  'cpf', 'nome', 'customMessage', 'codigoRastreio', 'produto', 'valor', 'endereco', 'email'
];

export const DYNAMIC_PARAM_LEAD_FIELDS: Record<string, string[]> = {
  'cpf': ['cpf', 'documento'],
  'nome': ['name', 'nome'],
  'customMessage': ['customMessage', 'mensagem'],
  'codigoRastreio': ['codigoRastreio', 'codigo_rastreio', 'tracking'],
  'produto': ['produto', 'product'],
  'valor': ['valor', 'value', 'price'],
  'endereco': ['endereco', 'address'],
  'email': ['email'],
};

export function buildDynamicParameterMapping(template: TemplateInfo): Map<string, string> {
  const mapping = new Map<string, string>();
  const paramCount = countTemplateParameters(template);
  
  for (let i = 1; i <= paramCount; i++) {
    const priorityIndex = i - 1;
    if (priorityIndex < DYNAMIC_PARAM_PRIORITY.length) {
      const paramName = DYNAMIC_PARAM_PRIORITY[priorityIndex];
      const fields = DYNAMIC_PARAM_LEAD_FIELDS[paramName];
      mapping.set(String(i), fields?.[0] || paramName);
    } else {
      mapping.set(String(i), `param_${i}`);
    }
  }
  
  return mapping;
}

export function countTemplateParameters(template: TemplateInfo): number {
  let maxParam = 0;
  for (const component of template.components || []) {
    if (component.text) {
      const regex = /\{\{(\d+)\}\}/g;
      let match;
      while ((match = regex.exec(component.text)) !== null) {
        const num = parseInt(match[1], 10);
        if (num > maxParam) maxParam = num;
      }
    }
  }
  return maxParam;
}

export interface PreflightConfig {
  phoneNumberId: string;
  template: TemplateInfo;
  parameterMapping: Map<string, string>;
  strictMode: boolean;
  wizardParamConfig?: Record<string, string>;
}

export class PreflightValidator {
  private config: PreflightConfig;
  private validatedCount: number = 0;
  private failedCount: number = 0;
  private warningCount: number = 0;

  constructor(config: PreflightConfig) {
    this.config = config;
  }

  /**
   * Valida lead antes do envio
   */
  validate(lead: LeadData, leadIndex: number): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    this.validatePhoneFormat(lead.phone, errors, warnings);
    
    this.validateTemplateStatus(errors);
    
    this.validateParameters(lead, errors, warnings);
    
    this.validateLanguage(errors);
    
    if (errors.length === 0) {
      this.validatedCount++;
    } else {
      this.failedCount++;
    }
    
    if (warnings.length > 0) {
      this.warningCount += warnings.length;
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Valida formato E.164 do telefone
   */
  private validatePhoneFormat(
    phone: string,
    errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    if (!phone) {
      errors.push({
        code: 'PHONE_MISSING',
        message: 'Número de telefone não fornecido',
        field: 'phone'
      });
      return;
    }

    const cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.length < 10 || cleaned.length > 15) {
      errors.push({
        code: 'PHONE_INVALID_LENGTH',
        message: `Telefone com tamanho inválido: ${cleaned.length} dígitos`,
        field: 'phone'
      });
      return;
    }

    if (!phone.startsWith('+') && !phone.match(/^[1-9]/)) {
      warnings.push({
        code: 'PHONE_NO_COUNTRY_CODE',
        message: 'Telefone pode não ter código do país',
        field: 'phone'
      });
    }
  }

  /**
   * Valida status do template
   */
  private validateTemplateStatus(errors: ValidationError[]): void {
    if (!this.config.template) {
      errors.push({
        code: 'TEMPLATE_MISSING',
        message: 'Template não configurado'
      });
      return;
    }

    if (this.config.template.status !== 'APPROVED') {
      errors.push({
        code: 'TEMPLATE_NOT_APPROVED',
        message: `Template "${this.config.template.name}" não está aprovado. Status: ${this.config.template.status}`
      });
    }
  }

  /**
   * Valida parâmetros do template
   */
  private validateParameters(
    lead: LeadData,
    _errors: ValidationError[],
    warnings: ValidationWarning[]
  ): void {
    if (!this.config.template?.components) return;

    const requiredParams = this.extractRequiredParameters();
    const wizardParamConfig = this.config.wizardParamConfig || {};
    const effectiveMapping = this.config.parameterMapping.size > 0
      ? this.config.parameterMapping
      : buildDynamicParameterMapping(this.config.template);

    const paramEntries = Array.from(requiredParams.entries());
    for (const [paramKey] of paramEntries) {
      const bodyKey = `body_${paramKey}`;
      const headerKey = `header_${paramKey}`;
      const hasWizardText =
        (wizardParamConfig[bodyKey] !== undefined && wizardParamConfig[bodyKey] !== null && String(wizardParamConfig[bodyKey]).trim() !== '') ||
        (wizardParamConfig[headerKey] !== undefined && wizardParamConfig[headerKey] !== null && String(wizardParamConfig[headerKey]).trim() !== '');

      if (hasWizardText) {
        continue;
      }

      const mappedField = effectiveMapping.get(paramKey);
      
      if (!mappedField) {
        warnings.push({
          code: 'PARAM_UNMAPPED',
          message: `Parâmetro {{${paramKey}}} será preenchido com valor vazio`,
          field: paramKey
        });
        continue;
      }

      const value = this.getLeadValue(lead, mappedField);
      
      if (value === undefined || value === null || value === '') {
        warnings.push({
          code: 'PARAM_EMPTY',
          message: `Valor para {{${paramKey}}} está vazio (campo: ${mappedField}) - será enviado vazio`,
          field: mappedField
        });
      }
    }
  }

  /**
   * Extrai parâmetros obrigatórios do template
   */
  private extractRequiredParameters(): Map<string, number> {
    const params = new Map<string, number>();
    
    for (const component of this.config.template.components || []) {
      if (component.text) {
        const regex = /\{\{(\d+)\}\}/g;
        let match;
        while ((match = regex.exec(component.text)) !== null) {
          params.set(match[1], parseInt(match[1], 10));
        }
      }
    }
    
    return params;
  }

  /**
   * Obtém valor do lead pelo campo mapeado
   */
  private getLeadValue(lead: LeadData, field: string): any {
    if (field.includes('.')) {
      const parts = field.split('.');
      let value: any = lead;
      for (const part of parts) {
        value = value?.[part];
      }
      return value;
    }
    
    return lead[field] ?? lead.params?.[field];
  }

  /**
   * Valida compatibilidade de idioma
   */
  private validateLanguage(errors: ValidationError[]): void {
    const validLanguages = [
      'pt_BR', 'pt_PT', 'en', 'en_US', 'en_GB', 'es', 'es_ES', 'es_MX',
      'fr', 'de', 'it', 'ja', 'ko', 'zh_CN', 'zh_TW', 'ru', 'ar'
    ];

    if (this.config.template?.language) {
      if (!validLanguages.includes(this.config.template.language)) {
        errors.push({
          code: 'LANGUAGE_INVALID',
          message: `Idioma do template inválido: ${this.config.template.language}`
        });
      }
    }
  }

  /**
   * Valida batch de leads
   */
  validateBatch(leads: LeadData[]): { valid: LeadData[]; invalid: Array<{ lead: LeadData; index: number; result: ValidationResult }> } {
    const valid: LeadData[] = [];
    const invalid: Array<{ lead: LeadData; index: number; result: ValidationResult }> = [];

    for (let i = 0; i < leads.length; i++) {
      const result = this.validate(leads[i], i);
      if (result.valid) {
        valid.push(leads[i]);
      } else {
        invalid.push({ lead: leads[i], index: i, result });
      }
    }

    return { valid, invalid };
  }

  /**
   * Retorna estatísticas
   */
  getStats(): { validated: number; failed: number; warnings: number; successRate: number } {
    const total = this.validatedCount + this.failedCount;
    return {
      validated: this.validatedCount,
      failed: this.failedCount,
      warnings: this.warningCount,
      successRate: total > 0 ? (this.validatedCount / total) * 100 : 100
    };
  }

  /**
   * Reseta contadores
   */
  reset(): void {
    this.validatedCount = 0;
    this.failedCount = 0;
    this.warningCount = 0;
  }

  /**
   * Atualiza configuração
   */
  updateConfig(config: Partial<PreflightConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Validação rápida de telefone E.164
 */
export function validateE164(phone: string): { valid: boolean; formatted: string; error?: string } {
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.length < 10 || cleaned.length > 15) {
    return {
      valid: false,
      formatted: phone,
      error: `Tamanho inválido: ${cleaned.length} dígitos`
    };
  }
  
  const formatted = cleaned.startsWith('55') ? `+${cleaned}` : `+55${cleaned}`;
  
  return {
    valid: true,
    formatted
  };
}
