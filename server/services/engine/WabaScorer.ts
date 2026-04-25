/**
 * WabaScorer — per-campaign weighted multi-WABA distribution.
 *
 * score = 0.6 * successRate + 0.25 * (1 - blockRate) + 0.15 * latencyFactor
 *   latencyFactor = clamp(1 - avgLatencyMs / LATENCY_TARGET_MS, 0, 1)
 *
 * Soft quarantine: blockRate > BLOCK_QUARANTINE → weight clamped to QUARANTINE_WEIGHT.
 * Otherwise weight = max(MIN_WEIGHT, score). WABA is NEVER fully disabled.
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
  latencies: number[]; // rolling latency window (ms)
  totalSent: number;
  totalSuccess: number;
  totalFailed: number;
  totalBlocked: number;
  picked: number;
  smoothedCurrent: number; // for smooth weighted RR
}

const MIN_WEIGHT = 0.02;
const QUARANTINE_WEIGHT = 0.02;
const BLOCK_QUARANTINE = 0.15;       // blockRate above this → soft quarantine
const LATENCY_TARGET_MS = 2000;      // ≤ this → factor 1.0; ≥ 2x → factor 0

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
      latencies: [],
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

  /** Records a send outcome for a WABA. Optional latencyMs feeds latencyFactor. */
  recordResult(wabaId: string, kind: WabaResultKind, latencyMs?: number): void {
    let s = this.states.get(wabaId);
    if (!s) {
      this.addWaba(wabaId);
      s = this.states.get(wabaId)!;
    }
    s.window.push(kind);
    if (s.window.length > this.windowSize) s.window.shift();
    if (typeof latencyMs === 'number' && latencyMs >= 0 && isFinite(latencyMs)) {
      s.latencies.push(latencyMs);
      if (s.latencies.length > this.windowSize) s.latencies.shift();
    }
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

  /** Returns rolling average latency for a WABA (0 if no samples). */
  private avgLatencyFor(s: WabaState): number {
    const n = s.latencies.length;
    if (n === 0) return 0;
    let sum = 0;
    for (const v of s.latencies) sum += v;
    return sum / n;
  }

  /** Inverse-normalized latency factor in [0,1]. Higher = faster. */
  private latencyFactorFor(s: WabaState): number {
    const avg = this.avgLatencyFor(s);
    if (avg <= 0) return 1; // no data → trust full
    const f = 1 - (avg / LATENCY_TARGET_MS);
    return f < 0 ? 0 : f > 1 ? 1 : f;
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
    let success = 0, blocked = 0;
    for (const r of s.window) {
      if (r === 'success') success++;
      else if (r === 'block') blocked++;
    }
    const successRate = success / n;
    const blockRate = blocked / n;
    const latencyFactor = this.latencyFactorFor(s);
    const raw = 0.6 * successRate + 0.25 * (1 - blockRate) + 0.15 * latencyFactor;
    return raw < 0 ? 0 : raw > 1 ? 1 : raw;
  }

  /** Returns weight for a single WABA. Soft quarantine when blockRate is high. */
  weightFor(wabaId: string): number {
    const s = this.states.get(wabaId);
    if (s && s.window.length >= 5) {
      let blocked = 0;
      for (const r of s.window) if (r === 'block') blocked++;
      const blockRate = blocked / s.window.length;
      if (blockRate > BLOCK_QUARANTINE) return QUARANTINE_WEIGHT;
    }
    return Math.max(MIN_WEIGHT, this.scoreFor(wabaId));
  }

  /**
   * Global pressure ∈ [0.7, 1.0]: aggregate hint for the engine to slightly
   * reduce send rate when block rate or latency are elevated. Returns 1.0
   * when fleet is healthy.
   */
  getGlobalPressure(): number {
    const ids = this.wabaOrder;
    if (ids.length === 0) return 1;
    let blocked = 0, total = 0, latSum = 0, latCount = 0;
    for (const id of ids) {
      const s = this.states.get(id)!;
      total += s.window.length;
      for (const r of s.window) if (r === 'block') blocked++;
      if (s.latencies.length > 0) {
        latSum += this.avgLatencyFor(s);
        latCount++;
      }
    }
    if (total < 5) return 1;
    const blockRate = blocked / total;
    const avgLat = latCount > 0 ? latSum / latCount : 0;
    const blockPenalty = Math.min(0.2, blockRate * 1.0);            // up to -0.20
    const latPenalty = Math.min(0.1, Math.max(0, (avgLat - LATENCY_TARGET_MS) / LATENCY_TARGET_MS) * 0.1); // up to -0.10
    const p = 1 - blockPenalty - latPenalty;
    return p < 0.7 ? 0.7 : p > 1 ? 1 : p;
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
      const weight = this.weightFor(id);
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
