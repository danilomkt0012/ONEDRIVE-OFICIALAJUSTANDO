export class SlidingWindowMetrics {
  private buffer: number[] = [];
  private size: number;

  constructor(size: number = 200) {
    this.size = size;
  }

  add(event: 0 | 1): void {
    if (this.buffer.length >= this.size) {
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  getRate(): number {
    if (this.buffer.length === 0) return 0;
    const sum = this.buffer.reduce((a, b) => a + b, 0);
    return sum / this.buffer.length;
  }

  getCount(): number {
    return this.buffer.length;
  }

  getBlockCount(): number {
    return this.buffer.reduce((a, b) => a + b, 0);
  }

  reset(): void {
    this.buffer = [];
  }
}
