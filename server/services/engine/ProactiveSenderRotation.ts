import crypto from 'crypto';
import { logWarn } from '../../utils/logger';

interface ProactiveSenderRotationConfig {
  minMessagesBeforeRotation: number;
  maxMessagesBeforeRotation: number;
}

const DEFAULT_CONFIG: ProactiveSenderRotationConfig = {
  minMessagesBeforeRotation: 80,
  maxMessagesBeforeRotation: 150,
};

export class ProactiveSenderRotation {
  private config: ProactiveSenderRotationConfig;
  private senderCounters: Map<string, number> = new Map();
  private senderThresholds: Map<string, number> = new Map();

  constructor(config?: Partial<ProactiveSenderRotationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private generateThreshold(): number {
    const range = this.config.maxMessagesBeforeRotation - this.config.minMessagesBeforeRotation;
    const randomValue = crypto.randomInt(0, range + 1);
    return this.config.minMessagesBeforeRotation + randomValue;
  }

  recordSend(senderId: string): void {
    const count = (this.senderCounters.get(senderId) || 0) + 1;
    this.senderCounters.set(senderId, count);

    if (!this.senderThresholds.has(senderId)) {
      this.senderThresholds.set(senderId, this.generateThreshold());
    }
  }

  shouldRotate(senderId: string): boolean {
    const count = this.senderCounters.get(senderId) || 0;
    const threshold = this.senderThresholds.get(senderId) || this.generateThreshold();

    if (count >= threshold) {
      logWarn('ProactiveSenderRotation', { senderId, count, threshold }, 'Proactive rotation triggered');
      this.senderCounters.set(senderId, 0);
      this.senderThresholds.set(senderId, this.generateThreshold());
      return true;
    }
    return false;
  }

  resetSender(senderId: string): void {
    this.senderCounters.delete(senderId);
    this.senderThresholds.delete(senderId);
  }

  resetAll(): void {
    this.senderCounters.clear();
    this.senderThresholds.clear();
  }

  getStats(): { senders: number; counters: Record<string, number> } {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.senderCounters) {
      counters[k] = v;
    }
    return { senders: this.senderCounters.size, counters };
  }
}

export const proactiveSenderRotation = new ProactiveSenderRotation();
