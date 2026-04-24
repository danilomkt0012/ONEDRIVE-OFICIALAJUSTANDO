/**
 * ============================================================================
 * CALCULADOR DE ETA REAL
 * ============================================================================
 * 
 * Calcula tempo estimado de conclusão baseado em:
 * - Taxa média real (não teórica)
 * - Variância observada
 * - Tendência de aceleração/desaceleração
 * 
 * Expõe:
 * - Tempo restante estimado
 * - Intervalo de confiança (min/max)
 * - Nível de confiança (0-100%)
 */

export interface EtaEstimate {
  remainingMs: number;
  remainingFormatted: string;
  completionTime: Date;
  confidenceLevel: number;
  minRemainingMs: number;
  maxRemainingMs: number;
  currentRate: number;
  avgRate: number;
  rateVariance: number;
  rateTrend: 'accelerating' | 'stable' | 'decelerating';
}

export interface EtaCalculatorConfig {
  windowSize: number;
  minSamplesForConfidence: number;
  confidenceMultiplier: number;
}

interface RateSample {
  rate: number;
  timestamp: number;
}

export class EtaCalculator {
  private config: EtaCalculatorConfig;
  private samples: RateSample[] = [];
  private startTime: number = 0;
  private totalProcessed: number = 0;
  private totalItems: number = 0;
  private isStarted: boolean = false;

  constructor(config?: Partial<EtaCalculatorConfig>) {
    this.config = {
      windowSize: config?.windowSize ?? 30,
      minSamplesForConfidence: config?.minSamplesForConfidence ?? 10,
      confidenceMultiplier: config?.confidenceMultiplier ?? 1.96
    };
  }

  /**
   * Inicia o calculador
   */
  start(totalItems: number): void {
    this.startTime = Date.now();
    this.totalItems = totalItems;
    this.totalProcessed = 0;
    this.samples = [];
    this.isStarted = true;
  }

  /**
   * Registra progresso
   */
  recordProgress(processed: number): void {
    if (!this.isStarted) return;

    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    
    if (elapsed > 0) {
      const rate = processed / elapsed;
      
      this.samples.push({ rate, timestamp: now });
      
      while (this.samples.length > this.config.windowSize) {
        this.samples.shift();
      }
    }
    
    this.totalProcessed = processed;
  }

  /**
   * Calcula taxa média
   */
  private calculateAvgRate(): number {
    if (this.samples.length === 0) return 0;
    
    const sum = this.samples.reduce((acc, s) => acc + s.rate, 0);
    return sum / this.samples.length;
  }

  /**
   * Calcula variância da taxa
   */
  private calculateVariance(): number {
    if (this.samples.length < 2) return 0;
    
    const avg = this.calculateAvgRate();
    const squaredDiffs = this.samples.map(s => Math.pow(s.rate - avg, 2));
    const variance = squaredDiffs.reduce((acc, d) => acc + d, 0) / this.samples.length;
    
    return variance;
  }

  /**
   * Calcula desvio padrão
   */
  private calculateStdDev(): number {
    return Math.sqrt(this.calculateVariance());
  }

  /**
   * Detecta tendência de taxa
   */
  private detectTrend(): 'accelerating' | 'stable' | 'decelerating' {
    if (this.samples.length < 5) return 'stable';
    
    const recentHalf = this.samples.slice(-Math.floor(this.samples.length / 2));
    const olderHalf = this.samples.slice(0, Math.floor(this.samples.length / 2));
    
    const recentAvg = recentHalf.reduce((a, s) => a + s.rate, 0) / recentHalf.length;
    const olderAvg = olderHalf.reduce((a, s) => a + s.rate, 0) / olderHalf.length;
    
    const change = (recentAvg - olderAvg) / Math.max(0.001, olderAvg);
    
    if (change > 0.05) return 'accelerating';
    if (change < -0.05) return 'decelerating';
    return 'stable';
  }

  /**
   * Calcula nível de confiança (0-100)
   */
  private calculateConfidence(): number {
    if (this.samples.length < this.config.minSamplesForConfidence) {
      return (this.samples.length / this.config.minSamplesForConfidence) * 50;
    }
    
    const variance = this.calculateVariance();
    const avg = this.calculateAvgRate();
    
    if (avg === 0) return 0;
    
    const cv = Math.sqrt(variance) / avg;
    
    let confidence = Math.max(0, 100 - (cv * 100));
    
    const samplesBonus = Math.min(20, (this.samples.length - this.config.minSamplesForConfidence) * 2);
    confidence = Math.min(100, confidence + samplesBonus);
    
    return Math.round(confidence);
  }

  /**
   * Formata milissegundos em string legível
   */
  private formatDuration(ms: number): string {
    if (ms < 0) return '--:--';
    
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Retorna estimativa completa
   */
  getEstimate(): EtaEstimate {
    const remaining = this.totalItems - this.totalProcessed;
    const avgRate = this.calculateAvgRate();
    const stdDev = this.calculateStdDev();
    const trend = this.detectTrend();
    const confidence = this.calculateConfidence();
    
    let adjustedRate = avgRate;
    if (trend === 'accelerating') {
      adjustedRate *= 1.05;
    } else if (trend === 'decelerating') {
      adjustedRate *= 0.95;
    }
    
    let remainingMs = adjustedRate > 0 ? (remaining / adjustedRate) * 1000 : Infinity;
    
    const marginMs = stdDev > 0 
      ? (this.config.confidenceMultiplier * stdDev / Math.sqrt(this.samples.length)) * remaining * 1000 / Math.max(0.001, avgRate * avgRate)
      : remainingMs * 0.2;
    
    const minRemainingMs = Math.max(0, remainingMs - marginMs);
    const maxRemainingMs = remainingMs + marginMs;
    
    const now = Date.now();
    const elapsed = (now - this.startTime) / 1000;
    const currentRate = elapsed > 0 ? this.totalProcessed / elapsed : 0;
    
    return {
      remainingMs: remainingMs === Infinity ? -1 : Math.round(remainingMs),
      remainingFormatted: remainingMs === Infinity ? 'Calculando...' : this.formatDuration(remainingMs),
      completionTime: remainingMs === Infinity ? new Date(0) : new Date(now + remainingMs),
      confidenceLevel: confidence,
      minRemainingMs: Math.round(minRemainingMs),
      maxRemainingMs: Math.round(maxRemainingMs),
      currentRate: Math.round(currentRate * 100) / 100,
      avgRate: Math.round(avgRate * 100) / 100,
      rateVariance: Math.round(this.calculateVariance() * 1000) / 1000,
      rateTrend: trend
    };
  }

  /**
   * Retorna progresso atual
   */
  getProgress(): { processed: number; total: number; percent: number } {
    return {
      processed: this.totalProcessed,
      total: this.totalItems,
      percent: this.totalItems > 0 
        ? Math.round((this.totalProcessed / this.totalItems) * 10000) / 100 
        : 0
    };
  }

  /**
   * Reseta calculador
   */
  reset(): void {
    this.samples = [];
    this.startTime = 0;
    this.totalProcessed = 0;
    this.totalItems = 0;
    this.isStarted = false;
  }

  /**
   * Atualiza total de items (para ajuste dinâmico)
   */
  updateTotal(newTotal: number): void {
    this.totalItems = newTotal;
  }
}
