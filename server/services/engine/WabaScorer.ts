/**
 * WabaScorer — per-campaign weighted multi-WABA distribution.
 *
 * Tracks the last N message results per WABA in a sliding window and produces
 * a normalized score in [0, 1]:
 *
 *   score = 0.7 * successRate + 0.2 * (1 - errorRate) + 0.1 * (1 - blockRate)
 *
 * Weight = max(MIN_WEIGHT, score) so a struggling WABA never fully pauses
 * (per spec: "score baixo → menos envios; nunca pausar completamente").
 *
 * Selection uses a stateful weighted round-robin (smooth weighted RR) so the
 * actual distribution converges to the weight ratios over time without
 * starving any WABA.
 */

export type WabaResultKind = 'success' | 'fail' | 'block';

export interface WabaDistributionEntry {
  wabaId: string;
  sent: number;       // sample size in current window
  success: number;
  failed: number;
  blocked: number;
  successRate: number;
  errorRate: number;
  blockRate: number;
  score: number;      // 0..1
  weight: number;     // 0..1, max(MIN_WEIGHT, score)
  totalSent: number;  // lifetime
  totalSuccess: number;
  totalFailed: number;
  totalBlocked: number;
  picked: number;     // how many times this WABA was selected by pickWabaIndex
}

interface WabaState {
  wabaId: string;
  window: WabaResultKind[];
  totalSent: number;
  totalSuccess: number;
  totalFailed: number;
  totalBlocked: number;
  picked: number;
  smoothedCurrent: number; // for smooth weighted RR
}

const MIN_WEIGHT = 0.1;

export class WabaScorer {
  private readonly windowSize: number;
  private readonly rebalanceEvery: number;
  private states: Map<string, WabaState> = new Map();
  private wabaOrder: string[] = [];
  private recordsSinceRebalance = 0;
  private cachedWeights: number[] | null = null;

  constructor(wabaIds: string[], opts: { windowSize?: number; rebalanceEvery?: number } = {}) {
    this.windowSize = Math.max(10, opts.windowSize ?? 50);
    this.rebalanceEvery = Math.max(1, opts.rebalanceEvery ?? 50);
    for (const id of wabaIds) {
      this.addWaba(id);
    }
  }

  addWaba(wabaId: string): void {
    if (this.states.has(wabaId)) return;
    this.states.set(wabaId, {
      wabaId,
      window: [],
      totalSent: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalBlocked: 0,
      picked: 0,
      smoothedCurrent: 0,
    });
    this.wabaOrder.push(wabaId);
    this.cachedWeights = null;
  }

  /** Records a send outcome for a WABA. */
  recordResult(wabaId: string, kind: WabaResultKind): void {
    let s = this.states.get(wabaId);
    if (!s) {
      this.addWaba(wabaId);
      s = this.states.get(wabaId)!;
    }
    s.window.push(kind);
    if (s.window.length > this.windowSize) s.window.shift();
    s.totalSent++;
    if (kind === 'success') s.totalSuccess++;
    else if (kind === 'fail') s.totalFailed++;
    else if (kind === 'block') s.totalBlocked++;

    this.recordsSinceRebalance++;
    if (this.recordsSinceRebalance >= this.rebalanceEvery) {
      // Force weight recompute on next pick.
      this.cachedWeights = null;
      this.recordsSinceRebalance = 0;
    }
  }

  /** True when the rebalance window has elapsed since the last pick recompute. */
  shouldRebalance(): boolean {
    return this.cachedWeights === null;
  }

  /** Returns score for a single WABA (uses sliding window stats). */
  scoreFor(wabaId: string): number {
    const s = this.states.get(wabaId);
    if (!s) return 1;
    const n = s.window.length;
    if (n < 5) return 1; // not enough samples → trust full weight
    let success = 0, failed = 0, blocked = 0;
    for (const r of s.window) {
      if (r === 'success') success++;
      else if (r === 'fail') failed++;
      else if (r === 'block') blocked++;
    }
    const successRate = success / n;
    const errorRate = failed / n;
    const blockRate = blocked / n;
    const raw = 0.7 * successRate + 0.2 * (1 - errorRate) + 0.1 * (1 - blockRate);
    return Math.max(0, Math.min(1, raw));
  }

  /** Returns weight for a single WABA = max(MIN_WEIGHT, score). */
  weightFor(wabaId: string): number {
    return Math.max(MIN_WEIGHT, this.scoreFor(wabaId));
  }

  /** Computes (and caches) all weights in declared order. */
  private getWeights(): number[] {
    if (this.cachedWeights) return this.cachedWeights;
    this.cachedWeights = this.wabaOrder.map(id => this.weightFor(id));
    return this.cachedWeights;
  }

  /**
   * Picks the next WABA index using smooth weighted round-robin.
   * Converges to the weight ratios while never starving any WABA.
   */
  pickWabaIndex(): number {
    if (this.wabaOrder.length === 0) return -1;
    if (this.wabaOrder.length === 1) {
      const s = this.states.get(this.wabaOrder[0])!;
      s.picked++;
      return 0;
    }
    const weights = this.getWeights();
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < this.wabaOrder.length; i++) {
      const s = this.states.get(this.wabaOrder[i])!;
      s.smoothedCurrent += weights[i];
      if (s.smoothedCurrent > bestVal) {
        bestVal = s.smoothedCurrent;
        bestIdx = i;
      }
    }
    const winner = this.states.get(this.wabaOrder[bestIdx])!;
    winner.smoothedCurrent -= total;
    winner.picked++;
    return bestIdx;
  }

  /** Snapshot of current per-WABA distribution (for API / UI). */
  getDistribution(): WabaDistributionEntry[] {
    return this.wabaOrder.map(id => {
      const s = this.states.get(id)!;
      const n = s.window.length;
      let success = 0, failed = 0, blocked = 0;
      for (const r of s.window) {
        if (r === 'success') success++;
        else if (r === 'fail') failed++;
        else if (r === 'block') blocked++;
      }
      const successRate = n > 0 ? success / n : 0;
      const errorRate = n > 0 ? failed / n : 0;
      const blockRate = n > 0 ? blocked / n : 0;
      const score = this.scoreFor(id);
      const weight = Math.max(MIN_WEIGHT, score);
      return {
        wabaId: id,
        sent: n,
        success,
        failed,
        blocked,
        successRate,
        errorRate,
        blockRate,
        score,
        weight,
        totalSent: s.totalSent,
        totalSuccess: s.totalSuccess,
        totalFailed: s.totalFailed,
        totalBlocked: s.totalBlocked,
        picked: s.picked,
      };
    });
  }
}
