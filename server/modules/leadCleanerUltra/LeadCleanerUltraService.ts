import crypto from "crypto";
import type { Response } from "express";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { UniversalParser } from "./UniversalParser";
import { QueueEngine, type NormalizedLead } from "./QueueEngine";
import { StreamFileWriter } from "./StreamFileWriter";
import { ProgressEmitter, type ProgressData } from "./ProgressEmitter";
import { validateCpfBatch, testCpfApiConnection } from "./CpfValidator";
import { logError } from '../../utils/logger';

const BATCH_SIZE = 50;
const EMIT_EVERY = 50;
const OUTPUT_DIR = path.resolve("data");

interface ProcessEntry {
  progress: ProgressData;
  filePaths: string[];
  logPath: string | null;
  leadsPerFile: number;
}

function makeInitialProgress(): ProgressData {
  return {
    phase: "parsing",
    total: 0,
    processed: 0,
    valid: 0,
    invalid: 0,
    duplicates: 0,
    invalidFormat: 0,
    apiErrors: 0,
    cacheHits: 0,
    cpfInvalid: 0,
    currentConcurrency: 0,
    speedPerSecond: 0,
    etaSeconds: 0,
    csvReady: false,
    errorMessage: null,
  };
}

class LeadCleanerUltraService {
  private parser = new UniversalParser();
  private emitter = new ProgressEmitter();
  private processes: Map<string, ProcessEntry> = new Map();

  startProcess(buffer: Buffer, filename: string, leadsPerFile: number = 0): string {
    const processId = `lc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const entry: ProcessEntry = {
      progress: makeInitialProgress(),
      filePaths: [],
      logPath: null,
      leadsPerFile,
    };
    this.processes.set(processId, entry);

    this.runPipeline(processId, entry, buffer, filename).catch((err) => {
      console.error(`[LeadCleanerUltra] ${processId} fatal:`, err);
      entry.progress.phase = "error";
      entry.progress.errorMessage = err?.message || "Erro interno";
      this.emitter.emit(processId, "progress", entry.progress);
    });

    return processId;
  }

  startProcessFromFilePath(filePath: string, originalName: string, leadsPerFile: number = 0): string {
    const processId = `lc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const entry: ProcessEntry = {
      progress: makeInitialProgress(),
      filePaths: [],
      logPath: null,
      leadsPerFile,
    };
    this.processes.set(processId, entry);

    this.runPipelineFromFile(processId, entry, filePath, originalName).catch((err) => {
      console.error(`[LeadCleanerUltra] ${processId} fatal:`, err);
      entry.progress.phase = "error";
      entry.progress.errorMessage = err?.message || "Erro interno";
      this.emitter.emit(processId, "progress", entry.progress);
    });

    return processId;
  }

  startProcessFromText(rawText: string, leadsPerFile: number = 0): string {
    const processId = `lc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const entry: ProcessEntry = {
      progress: makeInitialProgress(),
      filePaths: [],
      logPath: null,
      leadsPerFile,
    };
    this.processes.set(processId, entry);

    const buffer = Buffer.from(rawText, "utf-8");
    this.runPipeline(processId, entry, buffer, "texto_colado.txt").catch((err) => {
      console.error(`[LeadCleanerUltra] ${processId} fatal:`, err);
      entry.progress.phase = "error";
      entry.progress.errorMessage = err?.message || "Erro interno";
      this.emitter.emit(processId, "progress", entry.progress);
    });

    return processId;
  }

  getProgress(processId: string): ProgressData | null {
    return this.processes.get(processId)?.progress || null;
  }

  getFilePath(processId: string): string | null {
    const entry = this.processes.get(processId);
    return entry?.filePaths?.[0] || null;
  }

  getAllFilePaths(processId: string): string[] {
    return this.processes.get(processId)?.filePaths || [];
  }

  getLogPath(processId: string): string | null {
    return this.processes.get(processId)?.logPath || null;
  }

  addSSEClient(processId: string, res: Response): void {
    this.emitter.addClient(processId, res);
    const entry = this.processes.get(processId);
    if (entry) {
      if (entry.progress.phase === "complete") {
        this.emitter.emit(processId, "complete", entry.progress);
      } else {
        this.emitter.emit(processId, "progress", entry.progress);
      }
    }
  }

  private async runPipelineFromFile(
    processId: string,
    entry: ProcessEntry,
    filePath: string,
    filename: string
  ): Promise<void> {
    const p = entry.progress;
    let totalOriginal = 0;

    await new Promise(resolve => setTimeout(resolve, 300));

    p.phase = "parsing";
    this.emitter.emit(processId, "progress", p);

    const queue = new QueueEngine();

    let rawCount: number;
    try {
      rawCount = await this.parser.parseFileStream(filePath, filename, (lead) => {
        try {
          queue.enqueue(lead.phone, lead.name, lead.cpf);
        } catch (e: any) {
          logError("leadCleanerUltra.enqueue", { processId }, e);
        }
      });
      totalOriginal = rawCount;
    } catch (err: any) {
      p.phase = "error";
      p.errorMessage = `Erro ao ler arquivo: ${err?.message || "formato não suportado"}`;
      this.emitter.emit(processId, "progress", p);
      return;
    } finally {
      fsp.unlink(filePath).catch((unlinkErr) => {
        logError("leadCleanerUltra.deleteTempFile", { processId, filePath }, unlinkErr);
      });
    }

    if (rawCount === 0 && queue.validCount === 0) {
      p.phase = "error";
      p.errorMessage = "Nenhum lead encontrado. Verifique se o texto contém números de telefone válidos.";
      this.emitter.emit(processId, "progress", p);
      return;
    }

    p.invalidFormat = queue.invalidFormat;
    p.duplicates = queue.duplicates;
    p.total = queue.validCount;

    if (queue.validCount === 0) {
      p.phase = "error";
      p.errorMessage = `Texto lido com ${rawCount} linhas, mas nenhum telefone válido encontrado. ${queue.invalidFormat} com formato inválido, ${queue.duplicates} duplicados.`;
      this.emitter.emit(processId, "progress", p);
      return;
    }

    await this.runPipelineCore(processId, entry, queue, totalOriginal);
  }

  private async runPipeline(
    processId: string,
    entry: ProcessEntry,
    buffer: Buffer,
    filename: string
  ): Promise<void> {
    const p = entry.progress;

    await new Promise(resolve => setTimeout(resolve, 300));

    p.phase = "parsing";
    this.emitter.emit(processId, "progress", p);

    const queue = new QueueEngine();

    let rawCount: number;
    try {
      rawCount = this.parser.parseStreaming(buffer, filename, (lead) => {
        try {
          queue.enqueue(lead.phone, lead.name, lead.cpf);
        } catch (e: any) {
          logError("leadCleanerUltra.enqueue", { processId }, e);
        }
      });
    } catch (err: any) {
      p.phase = "error";
      p.errorMessage = `Erro ao ler arquivo: ${err?.message || "formato não suportado"}`;
      this.emitter.emit(processId, "progress", p);
      return;
    }

    if (rawCount === 0 && queue.validCount === 0) {
      p.phase = "error";
      p.errorMessage = "Nenhum lead encontrado. Verifique se o texto contém números de telefone válidos.";
      this.emitter.emit(processId, "progress", p);
      return;
    }

    p.invalidFormat = queue.invalidFormat;
    p.duplicates = queue.duplicates;
    p.total = queue.validCount;

    if (queue.validCount === 0) {
      p.phase = "error";
      p.errorMessage = `Texto lido com ${rawCount} linhas, mas nenhum telefone válido encontrado. ${queue.invalidFormat} com formato inválido, ${queue.duplicates} duplicados.`;
      this.emitter.emit(processId, "progress", p);
      return;
    }

    await this.runPipelineCore(processId, entry, queue, rawCount);
  }

  private async runPipelineCore(
    processId: string,
    entry: ProcessEntry,
    queue: QueueEngine,
    totalOriginal: number
  ): Promise<void> {
    const p = entry.progress;

    p.phase = "normalizing";
    this.emitter.emit(processId, "progress", p);

    console.log(`[LeadCleanerUltra] ${processId} - Parsed ${totalOriginal} lines -> ${queue.validCount} valid, ${queue.invalidFormat} invalid format, ${queue.duplicates} duplicates, leadsPerFile: ${entry.leadsPerFile || 'ilimitado'}`);

    const writer = new StreamFileWriter(processId, entry.leadsPerFile);
    await writer.init();

    const allLeads: NormalizedLead[] = [];

    while (!queue.isEmpty()) {
      const batch = queue.dequeue(BATCH_SIZE);
      for (const lead of batch) {
        allLeads.push(lead);
        p.valid++;
        p.processed++;
      }
    }

    p.total = allLeads.length;
    this.emitter.emit(processId, "progress", p);

    console.log(`[LeadCleanerUltra] ${processId} - Normalizacao concluida. Total de leads: ${allLeads.length}`);

    const leadsWithCpf = allLeads.filter(l => l.cpf && l.cpf.length === 11);
    const leadsWithoutCpf = allLeads.filter(l => !l.cpf || l.cpf.length !== 11);
    let cpfRemoved = 0;
    let cpfSkipped = false;

    if (leadsWithCpf.length > 0) {
      const cpfReachable = await testCpfApiConnection();

      if (!cpfReachable) {
        console.log(`[LeadCleanerUltra] ${processId} - MagmaDataHub API não acessível, pulando validação CPF`);
        cpfSkipped = true;
        for (const lead of leadsWithCpf) {
          writer.append(lead.phone, lead.name, lead.cpf);
        }
      } else {
        p.phase = "checking_cpf";
        p.processed = 0;
        p.total = leadsWithCpf.length;
        p.speedPerSecond = 0;
        p.etaSeconds = 0;
        this.emitter.emit(processId, "progress", p);

        console.log(`[LeadCleanerUltra] ${processId} - Validando ${leadsWithCpf.length} CPFs via MagmaDataHub`);

        const cpfStartTime = Date.now();
        let cpfLastEmit = 0;

        for (let i = 0; i < leadsWithCpf.length; i += BATCH_SIZE) {
          const batch = leadsWithCpf.slice(i, i + BATCH_SIZE);
          const cpfResults = await validateCpfBatch(batch, 10);

          for (const r of cpfResults) {
            if (r.valid === false) {
              p.cpfInvalid++;
              cpfRemoved++;
            } else {
              writer.append(r.lead.phone, r.lead.name, r.lead.cpf);
              if (r.valid === null) {
                p.apiErrors++;
              }
            }
          }

          p.processed += batch.length;

          const elapsed = (Date.now() - cpfStartTime) / 1000;
          p.speedPerSecond = elapsed > 0 ? Math.round(p.processed / elapsed) : 0;
          const remaining = leadsWithCpf.length - (i + batch.length);
          p.etaSeconds = p.speedPerSecond > 0 ? Math.round(remaining / p.speedPerSecond) : 0;

          if (p.processed - cpfLastEmit >= EMIT_EVERY) {
            this.emitter.emit(processId, "progress", p);
            cpfLastEmit = p.processed;
          }
        }
      }
    }

    for (const lead of leadsWithoutCpf) {
      writer.append(lead.phone, lead.name, lead.cpf);
    }

    await writer.finalizeAsync();
    entry.filePaths = writer.allPaths;

    const finalValidCount = writer.written;
    p.valid = finalValidCount;

    const logLines = [
      `===== LOG DE LIMPEZA DE LEADS =====`,
      `Data: ${new Date().toISOString()}`,
      ``,
      `Total original: ${totalOriginal}`,
      `Duplicatas removidas: ${p.duplicates}`,
      `Formato inválido: ${p.invalidFormat}`,
    ];

    if (cpfSkipped) {
      logLines.push(`Validação CPF: PULADA (MagmaDataHub não acessível)`);
    } else {
      logLines.push(`CPFs inválidos removidos: ${cpfRemoved}`);
    }

    logLines.push(
      `Erros de API: ${p.apiErrors}`,
      `Total final: ${finalValidCount}`,
      ``,
    );

    if (entry.leadsPerFile > 0 && writer.fileCount > 1) {
      logLines.push(`Leads por arquivo: ${entry.leadsPerFile}`);
      logLines.push(`Arquivos gerados: ${writer.fileCount}`);
      for (let i = 0; i < writer.fileCount; i++) {
        const count = await writer.getFileLeadCountAsync(i);
        const label = i === 0 ? "Principal" : "Sobra";
        logLines.push(`  Arquivo ${i + 1} (${label}): ${count} leads`);
      }
      logLines.push(``);
    }

    logLines.push(`===== FIM DO LOG =====`);

    const logContent = logLines.join("\n");

    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    const logPath = path.join(OUTPUT_DIR, `log_${processId}.txt`);
    await fsp.writeFile(logPath, logContent, "utf-8");
    entry.logPath = logPath;

    console.log(`[LeadCleanerUltra] ${processId} - Log gerado: ${logPath}. Arquivos: ${writer.fileCount}`);

    p.phase = "complete";
    p.csvReady = true;
    p.speedPerSecond = 0;
    p.etaSeconds = 0;
    (p as any).fileCount = writer.fileCount;
    (p as any).leadsPerFile = entry.leadsPerFile;
    this.emitter.emit(processId, "complete", p);

    queue.release();

    setTimeout(() => {
      this.emitter.removeProcess(processId);
    }, 60_000);
  }
}

export const leadCleanerUltraService = new LeadCleanerUltraService();
