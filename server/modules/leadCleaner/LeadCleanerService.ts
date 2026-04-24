import crypto from "crypto";
import { LeadParser } from "./LeadParser";
import { LeadNormalizer, type NormalizedLead } from "./LeadNormalizer";
import { ProcessingQueue } from "./ProcessingQueue";
import { WorkerPool } from "./WorkerPool";
import { CacheStore } from "./CacheStore";
import { StreamWriter } from "./StreamWriter";
import type { Response } from "express";
import { logError } from '../../utils/logger';

const BATCH_SIZE = 50;
const PROGRESS_INTERVAL = 50;

export interface ProcessProgress {
  phase: "parsing" | "normalizing" | "checking_whatsapp" | "complete" | "error";
  total: number;
  processed: number;
  valid: number;
  invalid: number;
  duplicates: number;
  invalidFormat: number;
  apiErrors: number;
  cacheHits: number;
  speed: number;
  eta: number;
  concurrency: number;
  csvReady: boolean;
  errorMessage: string | null;
  currentNumber: string;
}

interface ProcessEntry {
  progress: ProcessProgress;
  filePath: string | null;
  startTime: number;
}

const processes = new Map<string, ProcessEntry>();
const sseClients = new Map<string, Set<Response>>();
const globalCache = new CacheStore();

function genId(): string {
  return `lc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function emitSSE(processId: string, event: string, data: any): void {
  const clients = sseClients.get(processId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(payload);
    } catch (e: any) {
      logError("leadCleaner.broadcastProgress", {}, e);
      clients.delete(res);
    }
  });
}

export class LeadCleanerService {
  private parser = new LeadParser();
  private normalizer = new LeadNormalizer();

  startProcess(buffer: Buffer, filename: string): string {
    const processId = genId();

    const entry: ProcessEntry = {
      progress: {
        phase: "parsing",
        total: 0,
        processed: 0,
        valid: 0,
        invalid: 0,
        duplicates: 0,
        invalidFormat: 0,
        apiErrors: 0,
        cacheHits: 0,
        speed: 0,
        eta: 0,
        concurrency: 10,
        csvReady: false,
        errorMessage: null,
        currentNumber: "",
      },
      filePath: null,
      startTime: Date.now(),
    };

    processes.set(processId, entry);
    setTimeout(() => {
      const e = processes.get(processId);
      if (e?.filePath) {
        try { require("fs").unlinkSync(e.filePath); } catch (unlinkErr: any) {
          logError("leadCleaner.cleanupTempFile", {}, unlinkErr);
        }
      }
      processes.delete(processId);
    }, 60 * 60 * 1000);

    this.runPipeline(processId, buffer, filename, entry).catch((err) => {
      entry.progress.phase = "error";
      entry.progress.errorMessage = err?.message || "Erro desconhecido";
      emitSSE(processId, "progress", entry.progress);
    });

    return processId;
  }

  private async runPipeline(processId: string, buffer: Buffer, filename: string, entry: ProcessEntry) {
    await globalCache.init();
    const p = entry.progress;

    p.phase = "parsing";
    emitSSE(processId, "progress", p);

    let rawLeads;
    try {
      rawLeads = this.parser.parse(buffer, filename);
    } catch (err: any) {
      p.phase = "error";
      p.errorMessage = err?.message || "Erro ao ler arquivo";
      emitSSE(processId, "progress", p);
      return;
    }

    if (rawLeads.length === 0) {
      p.phase = "error";
      p.errorMessage = "Nenhum lead encontrado no arquivo";
      emitSSE(processId, "progress", p);
      return;
    }

    p.total = rawLeads.length;
    p.phase = "normalizing";
    emitSSE(processId, "progress", p);

    const normResult = this.normalizer.normalize(rawLeads);
    p.invalidFormat = normResult.stats.invalidRemoved;
    p.duplicates = normResult.stats.duplicatesRemoved;

    const normalizedLeads = normResult.leads;
    p.total = normalizedLeads.length;
    emitSSE(processId, "progress", p);

    const pool = new WorkerPool(globalCache, 10);
    const queue = new ProcessingQueue();
    const writer = new StreamWriter(processId);
    await writer.init();

    queue.enqueueAll(normalizedLeads);

    if (!pool.isConfigured()) {
      console.log(`[LeadCleaner] ${processId} - Green API not configured, skipping WhatsApp check, exporting all ${normalizedLeads.length} normalized leads`);
      for (const lead of normalizedLeads) {
        writer.append(lead);
        p.valid++;
      }
      p.processed = normalizedLeads.length;
    } else {
      p.phase = "checking_whatsapp";
      emitSSE(processId, "progress", p);

      const startCheck = Date.now();
      let lastEmit = 0;

      while (!queue.isEmpty()) {
        const batch = queue.dequeue(BATCH_SIZE);
        const leads = batch.map((b) => b.lead);

        try {
          const results = await pool.processBatch(leads);

          for (const r of results) {
            if (r.valid === true) {
              writer.append(r.lead);
              p.valid++;
            } else if (r.valid === false) {
              p.invalid++;
            } else {
              p.apiErrors++;
            }
            if (r.fromCache) p.cacheHits++;
          }
        } catch (err: any) {
          logError("leadcleaner", {}, err);
          p.apiErrors += leads.length;
        }

        p.processed = queue.processed;
        p.currentNumber = leads[leads.length - 1]?.phone || "";
        p.concurrency = pool.stats.concurrency;

        const elapsed = (Date.now() - startCheck) / 1000;
        p.speed = elapsed > 0 ? Math.round(p.processed / elapsed) : 0;
        p.eta = p.speed > 0 ? Math.round(queue.remaining / p.speed) : 0;

        if (p.processed - lastEmit >= PROGRESS_INTERVAL || queue.isEmpty()) {
          emitSSE(processId, "progress", p);
          lastEmit = p.processed;
        }
      }

      await globalCache.flushAsync();
      console.log(`[LeadCleaner] ${processId} - WhatsApp check done. Valid: ${p.valid}, Invalid: ${p.invalid}, Errors: ${p.apiErrors}, Cache hits: ${p.cacheHits}`);
    }

    const finalPath = await writer.finalize();
    entry.filePath = finalPath;

    p.phase = "complete";
    p.csvReady = true;
    p.processed = p.total;

    console.log(`[LeadCleaner] ${processId} complete - Raw: ${rawLeads.length}, Normalized: ${normalizedLeads.length}, Final written: ${writer.written}`);

    emitSSE(processId, "progress", p);
    emitSSE(processId, "complete", p);
  }

  getProgress(processId: string): ProcessProgress | null {
    return processes.get(processId)?.progress || null;
  }

  getFilePath(processId: string): string | null {
    const entry = processes.get(processId);
    if (!entry || !entry.progress.csvReady) return null;
    return entry.filePath;
  }

  addSSEClient(processId: string, res: Response): void {
    if (!sseClients.has(processId)) {
      sseClients.set(processId, new Set());
    }
    sseClients.get(processId)!.add(res);

    res.on("close", () => {
      const clients = sseClients.get(processId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) sseClients.delete(processId);
      }
    });

    const entry = processes.get(processId);
    if (entry) {
      const payload = `event: progress\ndata: ${JSON.stringify(entry.progress)}\n\n`;
      try { res.write(payload); } catch (e: any) {
        logError('LeadCleanerService.sseInitialWrite', {}, e);
      }
    }
  }
}

export const leadCleanerService = new LeadCleanerService();
