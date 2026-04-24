export interface CampaignCheckpoint {
  campaignId: string;
  phoneNumberId: string;
  lastProcessedIndex: number;
  successCount: number;
  failedCount: number;
  blockedCount: number;
  timestamp: number;
}

class CheckpointStoreImpl {
  private checkpoints: Map<string, CampaignCheckpoint> = new Map();
  private static instance: CheckpointStoreImpl;

  static getInstance(): CheckpointStoreImpl {
    if (!CheckpointStoreImpl.instance) {
      CheckpointStoreImpl.instance = new CheckpointStoreImpl();
    }
    return CheckpointStoreImpl.instance;
  }

  private makeKey(campaignId: string, phoneNumberId: string): string {
    return `${campaignId}::${phoneNumberId}`;
  }

  save(checkpoint: CampaignCheckpoint): void {
    const key = this.makeKey(checkpoint.campaignId, checkpoint.phoneNumberId);
    this.checkpoints.set(key, { ...checkpoint, timestamp: Date.now() });
  }

  get(campaignId: string, phoneNumberId: string): CampaignCheckpoint | null {
    const key = this.makeKey(campaignId, phoneNumberId);
    return this.checkpoints.get(key) || null;
  }

  getResumeIndex(campaignId: string, phoneNumberId: string): number {
    const checkpoint = this.get(campaignId, phoneNumberId);
    if (!checkpoint) return 0;
    return checkpoint.lastProcessedIndex + 1;
  }

  remove(campaignId: string, phoneNumberId: string): void {
    const key = this.makeKey(campaignId, phoneNumberId);
    this.checkpoints.delete(key);
  }

  removeAll(campaignId: string): void {
    const keysToDelete: string[] = [];
    this.checkpoints.forEach((_, key) => {
      if (key.startsWith(campaignId + '::')) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.checkpoints.delete(key));
  }

  getAll(): CampaignCheckpoint[] {
    return Array.from(this.checkpoints.values());
  }

  reset(): void {
    this.checkpoints.clear();
  }
}

export const checkpointStore = CheckpointStoreImpl.getInstance();
