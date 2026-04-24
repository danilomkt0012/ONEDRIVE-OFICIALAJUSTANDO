import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { logError } from '../../utils/logger';

const OUTPUT_DIR = path.resolve("data");

function csvEscape(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function getDateStr(): string {
  const date = new Date();
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

export class StreamFileWriter {
  private processId: string;
  private leadsPerFile: number;
  private currentFileIndex = 0;
  private currentCount = 0;
  private totalCount = 0;
  private filePaths: string[] = [];
  private ts: number;
  private writeStream: fs.WriteStream | null = null;
  private streamError: Error | null = null;
  private initialized = false;

  constructor(processId: string, leadsPerFile: number = 0) {
    this.processId = processId;
    this.leadsPerFile = leadsPerFile > 0 ? leadsPerFile : 0;
    this.ts = Date.now();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    this.createNewFile();
    this.initialized = true;
  }

  private createNewFile(): void {
    if (this.writeStream) {
      this.writeStream.end();
    }
    this.currentFileIndex++;
    this.currentCount = 0;
    const filePath = path.join(OUTPUT_DIR, `lc_${this.processId}_p${this.currentFileIndex}.csv`);
    this.filePaths.push(filePath);
    this.writeStream = fs.createWriteStream(filePath, { encoding: "utf-8", flags: "a" });
    this.writeStream.on('error', (err) => {
      this.streamError = err;
      logError("StreamFileWriter.streamError", { processId: this.processId, filePath }, err);
    });
  }

  private get currentPath(): string {
    return this.filePaths[this.filePaths.length - 1];
  }

  append(phone: string, name: string, cpf: string): void {
    if (this.leadsPerFile > 0 && this.currentCount >= this.leadsPerFile) {
      this.createNewFile();
    }

    const safeName = (name || "").toUpperCase().trim();
    const safeCpf = (cpf || "").trim();
    const safePhone = (phone || "").trim();

    const line = `${csvEscape(safePhone)},${csvEscape(safeName)},${csvEscape(safeCpf)}\n`;

    try {
      if (this.writeStream && !this.streamError) {
        this.writeStream.write(line);
      } else {
        if (!this.writeStream) {
          this.writeStream = fs.createWriteStream(this.currentPath, { encoding: "utf-8", flags: "a" });
          this.writeStream.on('error', (err) => {
            this.streamError = err;
            logError("StreamFileWriter.streamError", { processId: this.processId }, err);
          });
          this.streamError = null;
        }
        this.writeStream.write(line);
      }
      this.currentCount++;
      this.totalCount++;
    } catch (err: any) {
      logError("StreamFileWriter.append", { processId: this.processId }, err);
    }
  }

  async finalizeAsync(): Promise<string> {
    if (this.writeStream) {
      await new Promise<void>((resolve) => {
        this.writeStream!.end(() => resolve());
      });
      this.writeStream = null;
    }

    const dateStr = getDateStr();
    const newPaths: string[] = [];

    for (let i = 0; i < this.filePaths.length; i++) {
      const fp = this.filePaths[i];
      const count = await this.getFileLeadCountAsync(i);
      let newName: string;

      if (this.leadsPerFile > 0 && this.filePaths.length > 1) {
        if (i === 0) {
          newName = `Leads_Validados_${count}un_${dateStr}.csv`;
        } else {
          newName = `Leads_Restantes_${count}un_${dateStr}.csv`;
        }
      } else {
        newName = `Leads_Validados_${count}un_${dateStr}.csv`;
      }

      const newPath = path.join(OUTPUT_DIR, newName);
      try {
        await fsp.rename(fp, newPath);
        newPaths.push(newPath);
      } catch (e: any) {
        newPaths.push(fp);
        logError("StreamFileWriter.rename", { processId: this.processId, from: fp, to: newPath }, e);
      }
    }

    this.filePaths = newPaths;
    return this.filePaths[0] || "";
  }

  async cleanupAsync(): Promise<void> {
    if (this.writeStream) {
      await new Promise<void>((resolve) => {
        this.writeStream!.end(() => resolve());
      });
      this.writeStream = null;
    }
    for (const fp of this.filePaths) {
      try {
        await fsp.access(fp);
        await fsp.unlink(fp);
      } catch (e: any) {
        if (e.code !== 'ENOENT') {
          logError("StreamFileWriter.cleanupAsync", { processId: this.processId, filePath: fp }, e);
        }
      }
    }
  }


  get written(): number { return this.totalCount; }
  get outputPath(): string { return this.filePaths[0] || ""; }
  get allPaths(): string[] { return [...this.filePaths]; }
  get fileCount(): number { return this.filePaths.length; }

  async getFileLeadCountAsync(index: number): Promise<number> {
    const fp = this.filePaths[index];
    if (!fp) return 0;
    try {
      const content = await fsp.readFile(fp, "utf-8");
      return content.split("\n").filter(l => l.trim()).length;
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        logError("StreamFileWriter.getFileLeadCountAsync", { processId: this.processId, index }, e);
      }
      return 0;
    }
  }

}
