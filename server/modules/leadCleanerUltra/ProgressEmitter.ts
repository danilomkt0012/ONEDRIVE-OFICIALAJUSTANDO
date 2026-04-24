import type { Response } from "express";
import { logError } from '../../utils/logger';

export interface ProgressData {
  phase: "parsing" | "normalizing" | "checking_whatsapp" | "checking_cpf" | "complete" | "error";
  total: number;
  processed: number;
  valid: number;
  invalid: number;
  duplicates: number;
  invalidFormat: number;
  apiErrors: number;
  cacheHits: number;
  cpfInvalid: number;
  currentConcurrency: number;
  speedPerSecond: number;
  etaSeconds: number;
  csvReady: boolean;
  errorMessage: string | null;
  poolDuplicates?: number;
}

export class ProgressEmitter {
  private clients: Map<string, Set<Response>> = new Map();

  emit(processId: string, eventName: string, data: ProgressData): void {
    const set = this.clients.get(processId);
    if (!set || set.size === 0) return;

    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch (e: any) {
        logError("progressEmitter.broadcastProgress", {}, e);
        set.delete(res);
      }
    }
  }

  addClient(processId: string, res: Response): void {
    if (!this.clients.has(processId)) {
      this.clients.set(processId, new Set());
    }
    this.clients.get(processId)!.add(res);

    res.on("close", () => {
      this.clients.get(processId)?.delete(res);
    });
  }

  removeProcess(processId: string): void {
    const set = this.clients.get(processId);
    if (set) {
      for (const res of set) {
        try { res.end(); } catch (e: any) {
          logError('ProgressEmitter.resEnd', {}, e);
        }
      }
      this.clients.delete(processId);
    }
  }
}
