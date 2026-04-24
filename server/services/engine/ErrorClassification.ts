/**
 * ============================================================================
 * CLASSIFICAÇÃO DE ERROS (TELEMETRIA)
 * ============================================================================
 * 
 * Sistema de classificação e contagem de erros por tipo.
 * Usado para ajustar taxa e decidir SafeMode automático.
 * 
 * Tipos de erro:
 * - rateLimitErrors (135000, 131048)
 * - payloadErrors (parâmetros, template)
 * - networkErrors (timeout, connection)
 * - authErrors (token, permissão)
 * - unknownErrors
 */

export interface ErrorCounts {
  rateLimitErrors: number;
  payloadErrors: number;
  networkErrors: number;
  authErrors: number;
  environmentErrors: number;
  unknownErrors: number;
  total: number;
}

export interface ErrorEvent {
  timestamp: number;
  type: ErrorType;
  code?: number;
  message: string;
  phoneNumberId?: string;
  leadIndex?: number;
}

export type ErrorType = 'rate_limit' | 'payload' | 'network' | 'auth' | 'environment' | 'unknown';

export interface ErrorClassificationStats {
  counts: ErrorCounts;
  recentErrors: ErrorEvent[];
  errorRateByType: Record<ErrorType, number>;
  dominantErrorType: ErrorType | null;
  lastErrorAt: number;
  errorTrend: 'increasing' | 'stable' | 'decreasing';
}

const RATE_LIMIT_CODES = [
  135000,
  131048,
  131056,
  80007,
  134912
];

const PAYLOAD_CODES = [
  132000,
  132001,
  132005,
  132007,
  132012,
  132015,
  132016,
  132068,
  132069,
  133000,
  133004,
  133005,
  133006,
  133008,
  133009,
  133010
];

const AUTH_CODES = [
  190,
  200,
  10,
  4,
  100,
  102,
  104,
  230
];

const ENVIRONMENT_CODES = [
  131030,
  470,
];

const NETWORK_CODES = [
  1,
  2,
  17,
  131031
];

export class ErrorClassification {
  private counts: ErrorCounts;
  private recentErrors: ErrorEvent[] = [];
  private maxRecentErrors: number;
  private windowErrors: number[] = [];
  private windowSize: number = 20;
  private totalSent: number = 0;

  constructor(config?: { maxRecentErrors?: number; windowSize?: number }) {
    this.maxRecentErrors = config?.maxRecentErrors ?? 50;
    this.windowSize = config?.windowSize ?? 20;
    
    this.counts = {
      rateLimitErrors: 0,
      payloadErrors: 0,
      networkErrors: 0,
      authErrors: 0,
      environmentErrors: 0,
      unknownErrors: 0,
      total: 0
    };
  }

  classify(
    code: number | undefined,
    message: string,
    phoneNumberId?: string,
    leadIndex?: number
  ): ErrorType {
    const type = this.getErrorType(code, message);
    
    this.counts.total++;
    
    switch (type) {
      case 'rate_limit':
        this.counts.rateLimitErrors++;
        break;
      case 'payload':
        this.counts.payloadErrors++;
        break;
      case 'network':
        this.counts.networkErrors++;
        break;
      case 'auth':
        this.counts.authErrors++;
        break;
      case 'environment':
        this.counts.environmentErrors++;
        break;
      default:
        this.counts.unknownErrors++;
    }
    
    const event: ErrorEvent = {
      timestamp: Date.now(),
      type,
      code,
      message,
      phoneNumberId,
      leadIndex
    };
    
    this.recentErrors.push(event);
    while (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors.shift();
    }
    
    this.windowErrors.push(Date.now());
    while (this.windowErrors.length > this.windowSize) {
      this.windowErrors.shift();
    }
    
    return type;
  }

  /**
   * Determina tipo de erro pelo código
   */
  private getErrorType(code: number | undefined, message: string): ErrorType {
    if (code !== undefined) {
      if (ENVIRONMENT_CODES.includes(code)) return 'environment';
      if (RATE_LIMIT_CODES.includes(code)) return 'rate_limit';
      if (PAYLOAD_CODES.includes(code)) return 'payload';
      if (AUTH_CODES.includes(code)) return 'auth';
      if (NETWORK_CODES.includes(code)) return 'network';
    }
    
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('not in allowed list') || 
        lowerMessage.includes('recipient phone number not in allowed') ||
        lowerMessage.includes('test mode') ||
        lowerMessage.includes('sandbox')) {
      return 'environment';
    }
    
    if (lowerMessage.includes('rate') || lowerMessage.includes('limit') || lowerMessage.includes('throttl')) {
      return 'rate_limit';
    }
    
    if (lowerMessage.includes('timeout') || lowerMessage.includes('network') || 
        lowerMessage.includes('connection') || lowerMessage.includes('econnreset') ||
        lowerMessage.includes('socket')) {
      return 'network';
    }
    
    if (lowerMessage.includes('auth') || lowerMessage.includes('token') || 
        lowerMessage.includes('permission') || lowerMessage.includes('access')) {
      return 'auth';
    }
    
    if (lowerMessage.includes('parameter') || lowerMessage.includes('template') ||
        lowerMessage.includes('payload') || lowerMessage.includes('invalid')) {
      return 'payload';
    }
    
    return 'unknown';
  }

  /**
   * Registra sucesso (para cálculo de taxa)
   */
  recordSuccess(): void {
    this.totalSent++;
  }

  /**
   * Retorna contadores
   */
  getCounts(): ErrorCounts {
    return { ...this.counts };
  }

  /**
   * Retorna taxa de erro por tipo
   */
  getErrorRates(): Record<ErrorType, number> {
    const total = this.totalSent + this.counts.total;
    if (total === 0) {
      return {
        rate_limit: 0,
        payload: 0,
        network: 0,
        auth: 0,
        environment: 0,
        unknown: 0
      };
    }
    
    return {
      rate_limit: (this.counts.rateLimitErrors / total) * 100,
      payload: (this.counts.payloadErrors / total) * 100,
      network: (this.counts.networkErrors / total) * 100,
      auth: (this.counts.authErrors / total) * 100,
      environment: (this.counts.environmentErrors / total) * 100,
      unknown: (this.counts.unknownErrors / total) * 100
    };
  }

  /**
   * Retorna tipo de erro dominante
   */
  getDominantErrorType(): ErrorType | null {
    if (this.counts.total === 0) return null;
    
    const types: Array<{ type: ErrorType; count: number }> = [
      { type: 'rate_limit', count: this.counts.rateLimitErrors },
      { type: 'payload', count: this.counts.payloadErrors },
      { type: 'network', count: this.counts.networkErrors },
      { type: 'auth', count: this.counts.authErrors },
      { type: 'environment', count: this.counts.environmentErrors },
      { type: 'unknown', count: this.counts.unknownErrors }
    ];
    
    types.sort((a, b) => b.count - a.count);
    
    if (types[0].count === 0) return null;
    return types[0].type;
  }

  /**
   * Detecta tendência de erros
   */
  getErrorTrend(): 'increasing' | 'stable' | 'decreasing' {
    if (this.windowErrors.length < 5) return 'stable';
    
    const now = Date.now();
    const halfWindow = Math.floor(this.windowErrors.length / 2);
    
    const recentErrors = this.windowErrors.slice(-halfWindow);
    const olderErrors = this.windowErrors.slice(0, halfWindow);
    
    const recentRate = recentErrors.length / (now - recentErrors[0] + 1);
    const olderRate = olderErrors.length / (recentErrors[0] - olderErrors[0] + 1);
    
    const change = (recentRate - olderRate) / (olderRate + 0.001);
    
    if (change > 0.2) return 'increasing';
    if (change < -0.2) return 'decreasing';
    return 'stable';
  }

  /**
   * Verifica se deve ativar safe mode
   */
  shouldActivateSafeMode(threshold: number = 0.5): { activate: boolean; reason: string | null } {
    if (this.counts.rateLimitErrors > 0) {
      return { activate: true, reason: 'rate_limit_detected' };
    }
    
    const realErrors = this.counts.total - this.counts.environmentErrors;
    const total = this.totalSent + this.counts.total;
    if (total >= 100 && realErrors > 0) {
      const errorRate = (realErrors / total) * 100;
      if (errorRate > threshold) {
        return { activate: true, reason: `error_rate_${errorRate.toFixed(2)}%` };
      }
    }
    
    const realErrorCount = this.counts.total - this.counts.environmentErrors;
    if (this.getErrorTrend() === 'increasing' && realErrorCount >= 5) {
      return { activate: true, reason: 'error_trend_increasing' };
    }
    
    return { activate: false, reason: null };
  }

  /**
   * Retorna estatísticas completas
   */
  getStats(): ErrorClassificationStats {
    return {
      counts: this.getCounts(),
      recentErrors: [...this.recentErrors.slice(-10)],
      errorRateByType: this.getErrorRates(),
      dominantErrorType: this.getDominantErrorType(),
      lastErrorAt: this.recentErrors.length > 0 
        ? this.recentErrors[this.recentErrors.length - 1].timestamp 
        : 0,
      errorTrend: this.getErrorTrend()
    };
  }

  /**
   * Retorna erros recentes
   */
  getRecentErrors(count: number = 10): ErrorEvent[] {
    return [...this.recentErrors.slice(-count)];
  }

  /**
   * Reseta contadores
   */
  isEnvironmentError(code: number | undefined, message: string): boolean {
    return this.getErrorType(code, message) === 'environment';
  }

  getEnvironmentErrorCount(): number {
    return this.counts.environmentErrors;
  }

  getRealErrorCount(): number {
    return this.counts.total - this.counts.environmentErrors;
  }

  reset(): void {
    this.counts = {
      rateLimitErrors: 0,
      payloadErrors: 0,
      networkErrors: 0,
      authErrors: 0,
      environmentErrors: 0,
      unknownErrors: 0,
      total: 0
    };
    this.recentErrors = [];
    this.windowErrors = [];
    this.totalSent = 0;
  }

  /**
   * Verifica se há erros de rate limit
   */
  hasRateLimitErrors(): boolean {
    return this.counts.rateLimitErrors > 0;
  }

  /**
   * Retorna último erro
   */
  getLastError(): ErrorEvent | null {
    return this.recentErrors.length > 0 
      ? this.recentErrors[this.recentErrors.length - 1] 
      : null;
  }

  /**
   * Retorna taxa total de erro
   */
  getTotalErrorRate(): number {
    const total = this.totalSent + this.counts.total;
    if (total === 0) return 0;
    return (this.counts.total / total) * 100;
  }

  getRealErrorRate(): number {
    const total = this.totalSent + this.counts.total;
    if (total === 0) return 0;
    const realErrors = this.counts.total - this.counts.environmentErrors;
    return (realErrors / total) * 100;
  }
}
