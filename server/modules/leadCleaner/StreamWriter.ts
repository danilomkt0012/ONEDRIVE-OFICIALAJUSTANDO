import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { NormalizedLead } from "./LeadNormalizer";
import { logError } from '../../utils/logger';

const OUTPUT_DIR = path.resolve("data");

export class StreamWriter {
  private tempPath: string;
  private finalPath: string;
  private count = 0;
  private stream!: fs.WriteStream;

  constructor(processId: string) {
    const ts = Date.now();
    this.tempPath = path.join(OUTPUT_DIR, `temp_leads_${processId}.csv`);
    this.finalPath = path.join(OUTPUT_DIR, `leads_filtrados_${ts}.csv`);
  }

  async init(): Promise<void> {
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    this.stream = fs.createWriteStream(this.tempPath, { encoding: "utf-8", flags: "a" });
  }

  append(lead: NormalizedLead): void {
    const line = `+${lead.phone},${lead.name || ""},${lead.code || ""}\n`;
    try {
      this.stream.write(line);
      this.count++;
    } catch (err: any) {
      logError("StreamWriter.append", {}, err);
    }
  }

  async finalize(): Promise<string> {
    return new Promise((resolve) => {
      this.stream.end(async () => {
        try {
          await fsp.access(this.tempPath);
          await fsp.rename(this.tempPath, this.finalPath);
        } catch (err: any) {
          logError("StreamWriter.finalize", {}, err);
          try {
            await fsp.access(this.tempPath);
            this.finalPath = this.tempPath;
          } catch (_accessErr: any) {
            logError("StreamWriter.finalize.tempMissing", {}, _accessErr);
          }
        }
        resolve(this.finalPath);
      });
    });
  }

  async cleanup(): Promise<void> {
    try {
      this.stream.destroy();
      await fsp.unlink(this.tempPath);
    } catch (e: any) {
      logError("StreamWriter.cleanup", {}, e);
    }
  }

  get written(): number {
    return this.count;
  }

  get outputPath(): string {
    return this.finalPath;
  }
}
