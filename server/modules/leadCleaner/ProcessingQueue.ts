import type { NormalizedLead } from "./LeadNormalizer";

export interface QueueItem {
  index: number;
  lead: NormalizedLead;
}

/**
 * O(1) amortised dequeue using a head-pointer with periodic compaction.
 * Compaction only happens when the dead prefix is at least half the array,
 * so total compaction work is O(n) over the entire lifetime of the queue.
 * This avoids the O(n²) pitfall of calling Array.splice(0, k) in a tight loop.
 */
export class ProcessingQueue {
  private items: QueueItem[] = [];
  private head: number = 0;
  private _total = 0;
  private _processed = 0;

  enqueueAll(leads: NormalizedLead[]): void {
    for (let i = 0; i < leads.length; i++) {
      this.items.push({ index: this._total + i, lead: leads[i] });
    }
    this._total += leads.length;
  }

  dequeue(count: number): QueueItem[] {
    const available = this.items.length - this.head;
    const take = Math.min(count, available);
    if (take === 0) return [];

    const batch = this.items.slice(this.head, this.head + take);
    this.head += take;
    this._processed += take;

    if (this.head > 0 && this.head >= this.items.length >> 1) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }

    return batch;
  }

  get remaining(): number {
    return this.items.length - this.head;
  }

  get total(): number {
    return this._total;
  }

  get processed(): number {
    return this._processed;
  }

  isEmpty(): boolean {
    return this.head >= this.items.length;
  }
}
