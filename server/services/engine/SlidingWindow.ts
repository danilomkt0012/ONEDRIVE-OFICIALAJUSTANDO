/**
 * ============================================================================
 * SLIDING WINDOW DE RTT
 * ============================================================================
 * 
 * Mantém histórico dos últimos N RTTs e calcula estatísticas em tempo real.
 * Usa decaimento exponencial para dar mais peso a amostras recentes.
 * 
 * Características:
 * - Janela configurável (padrão: 100 amostras)
 * - Cálculo eficiente de p50, p95, p99
 * - Detecção de tendência (crescente/decrescente)
 * - Média ponderada com decaimento exponencial
 */

export interface SlidingWindowConfig {
  windowSize: number;
  decayFactor: number;
}

export interface RttStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  trend: 'stable' | 'increasing' | 'decreasing';
  trendStrength: number;
}

export class SlidingWindow {
  private samples: number[] = [];
  private timestamps: number[] = [];
  private windowSize: number;
  private decayFactor: number;
  private lastTrendCheck: number = 0;
  private trendHistory: number[] = [];

  constructor(config: Partial<SlidingWindowConfig> = {}) {
    this.windowSize = config.windowSize ?? 100;
    this.decayFactor = config.decayFactor ?? 0.95;
  }

  /**
   * Adiciona nova amostra de RTT
   */
  add(rttMs: number): void {
    const now = Date.now();
    
    this.samples.push(rttMs);
    this.timestamps.push(now);
    
    while (this.samples.length > this.windowSize) {
      this.samples.shift();
      this.timestamps.shift();
    }
    
    if (this.samples.length >= 10) {
      const recentAvg = this.calculateRecentAverage(5);
      this.trendHistory.push(recentAvg);
      
      while (this.trendHistory.length > 20) {
        this.trendHistory.shift();
      }
    }
  }

  /**
   * Calcula média das últimas N amostras
   */
  private calculateRecentAverage(n: number): number {
    const recent = this.samples.slice(-n);
    if (recent.length === 0) return 0;
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  /**
   * Calcula percentil de forma eficiente
   */
  private calculatePercentile(percentile: number): number {
    if (this.samples.length === 0) return 0;
    
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.floor((percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  /**
   * Calcula média ponderada com decaimento exponencial
   */
  private calculateWeightedAverage(): number {
    if (this.samples.length === 0) return 0;
    
    let weightedSum = 0;
    let weightSum = 0;
    
    for (let i = 0; i < this.samples.length; i++) {
      const age = this.samples.length - 1 - i;
      const weight = Math.pow(this.decayFactor, age);
      weightedSum += this.samples[i] * weight;
      weightSum += weight;
    }
    
    return weightSum > 0 ? weightedSum / weightSum : 0;
  }

  /**
   * Detecta tendência do RTT
   */
  private detectTrend(): { trend: 'stable' | 'increasing' | 'decreasing'; strength: number } {
    if (this.trendHistory.length < 5) {
      return { trend: 'stable', strength: 0 };
    }
    
    const recent = this.trendHistory.slice(-5);
    const older = this.trendHistory.slice(-10, -5);
    
    if (older.length === 0) {
      return { trend: 'stable', strength: 0 };
    }
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    
    const change = (recentAvg - olderAvg) / olderAvg;
    
    if (Math.abs(change) < 0.05) {
      return { trend: 'stable', strength: Math.abs(change) };
    } else if (change > 0) {
      return { trend: 'increasing', strength: change };
    } else {
      return { trend: 'decreasing', strength: Math.abs(change) };
    }
  }

  /**
   * Retorna estatísticas completas
   */
  getStats(): RttStats {
    const { trend, strength } = this.detectTrend();
    
    return {
      count: this.samples.length,
      min: this.samples.length > 0 ? Math.min(...this.samples) : 0,
      max: this.samples.length > 0 ? Math.max(...this.samples) : 0,
      avg: this.calculateWeightedAverage(),
      p50: this.calculatePercentile(50),
      p95: this.calculatePercentile(95),
      p99: this.calculatePercentile(99),
      trend,
      trendStrength: strength
    };
  }

  /**
   * Verifica se há amostras suficientes para decisões
   */
  hasEnoughData(): boolean {
    return this.samples.length >= 10;
  }

  /**
   * Retorna amostras recentes para análise
   */
  getRecentSamples(n: number = 10): number[] {
    return this.samples.slice(-n);
  }

  /**
   * Limpa todas as amostras
   */
  clear(): void {
    this.samples = [];
    this.timestamps = [];
    this.trendHistory = [];
  }

  /**
   * Retorna tamanho atual da janela
   */
  size(): number {
    return this.samples.length;
  }
}
