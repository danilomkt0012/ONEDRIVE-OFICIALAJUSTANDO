import * as XLSX from "xlsx";
import { logError } from '../../utils/logger';

export interface RawLead {
  phone: string;
  name: string;
  cpf: string;
}

const PHONE_DIGITS_REGEX = /\d{10,15}/;
const CPF_FORMATTED_REGEX = /^\d{3}[.\s]\d{3}[.\s]\d{3}[-.\s]\d{2}$/;

function detectDelimiter(line: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  for (const ch of line) {
    if (ch in counts) counts[ch]++;
  }
  let best = ",";
  let max = 0;
  for (const [delim, count] of Object.entries(counts)) {
    if (count > max) { max = count; best = delim; }
  }
  return best;
}

function cleanField(val: string): string {
  return val.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, "").trim();
}

function isHeaderRow(fields: string[]): boolean {
  const headerWords = [
    "telefone", "phone", "celular", "numero", "número", "whatsapp", "fone", "tel",
    "nome", "name", "cliente", "razao", "razão",
    "cpf", "cnpj", "documento", "doc",
    "email", "e-mail", "endereco", "endereço", "cidade", "estado", "cep",
    "produto", "valor", "codigo", "código", "rastreio", "pedido", "status",
  ];
  const joined = fields.map(f => f.toLowerCase().replace(/[^a-záéíóúàâêôãõçñ]/g, "")).join(" ");
  let matches = 0;
  for (const w of headerWords) {
    if (joined.includes(w)) matches++;
  }
  return matches >= 2;
}

function extractPhone(field: string): string | null {
  const stripped = field.replace(/[\s\-\(\)\.\+]/g, "");
  const digits = stripped.replace(/\D/g, "");

  if (digits.length >= 10 && digits.length <= 15) {
    return digits;
  }

  const match = field.replace(/[^\d+]/g, "").match(PHONE_DIGITS_REGEX);
  return match ? match[0] : null;
}

function isBrazilianMobilePattern(digits: string): boolean {
  if (digits.length !== 11) return false;
  const ddd = parseInt(digits.substring(0, 2), 10);
  if (ddd < 11 || ddd > 99) return false;
  return digits[2] === "9";
}

function looksLikePhone(field: string): boolean {
  const cleaned = field.replace(/[\s\-\(\)\.\+]/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return false;
  const nonDigitRatio = (field.length - digits.length) / field.length;
  if (field.length > 5 && nonDigitRatio > 0.5) return false;

  if (digits.length === 11 && /^\d{11}$/.test(field.trim())) {
    return isBrazilianMobilePattern(digits);
  }

  return true;
}

function looksLikeCPF(field: string): boolean {
  const trimmed = field.trim();
  if (CPF_FORMATTED_REGEX.test(trimmed)) return true;
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(trimmed)) return true;
  if (/^\d{3}\s\d{3}\s\d{3}\s\d{2}$/.test(trimmed)) return true;

  if (/^\d{11}$/.test(trimmed)) {
    return !isBrazilianMobilePattern(trimmed);
  }

  return false;
}

function extractCPF(field: string): string {
  const trimmed = field.trim();
  if (CPF_FORMATTED_REGEX.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 11) return digits;
  }
  if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 11) return digits;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && !/[a-zA-ZÀ-ÿ]/.test(trimmed)) {
    if (!isBrazilianMobilePattern(digits)) {
      return digits;
    }
  }
  return "";
}

function isNameField(field: string, phone: string | null, cpf: string): boolean {
  const trimmed = field.trim();
  if (trimmed.length <= 1) return false;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 10) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (phone && digits === phone) return false;
  if (cpf && digits === cpf) return false;
  if (/[a-zA-ZÀ-ÿ]/.test(trimmed)) return true;
  return false;
}

export function parseLine(fields: string[]): RawLead | null {
  let phone: string | null = null;
  let cpf = "";
  let name = "";
  const candidates: string[] = [];

  for (const raw of fields) {
    const field = cleanField(raw);
    if (!field) continue;

    if (!cpf && looksLikeCPF(field)) {
      const extracted = extractCPF(field);
      if (extracted) { cpf = extracted; continue; }
    }

    if (!phone && looksLikePhone(field)) {
      const extracted = extractPhone(field);
      if (extracted) { phone = extracted; continue; }
    }

    if (!cpf) {
      const extracted = extractCPF(field);
      if (extracted) { cpf = extracted; continue; }
    }

    candidates.push(field);
  }

  if (!phone) {
    for (let i = 0; i < candidates.length; i++) {
      if (looksLikePhone(candidates[i])) {
        const extracted = extractPhone(candidates[i]);
        if (extracted) {
          phone = extracted;
          candidates.splice(i, 1);
          break;
        }
      }
    }
  }

  if (!phone) return null;

  const nameParts: string[] = [];
  for (const c of candidates) {
    if (!cpf) {
      const extracted = extractCPF(c);
      if (extracted) { cpf = extracted; continue; }
    }
    if (isNameField(c, phone, cpf)) {
      nameParts.push(c.replace(/\s+/g, " ").trim().toUpperCase());
    }
  }
  name = nameParts.join(" ").replace(/\s+/g, " ").trim();

  return { phone, name, cpf };
}

export function parseBufferLineByLine(buffer: Buffer, onLead: (lead: RawLead) => void): number {
  const CHUNK_SIZE = 64 * 1024;
  let pending = '';
  let delimiter: string | null = null;
  let skippedHeader = false;
  let count = 0;

  function processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (delimiter === null) {
      delimiter = detectDelimiter(trimmed);
    }

    const fields = trimmed.split(delimiter!);

    if (!skippedHeader) {
      skippedHeader = true;
      if (isHeaderRow(fields)) return;
    }

    try {
      const lead = parseLine(fields);
      if (lead) { onLead(lead); count++; return; }
      const fallbackFields = trimmed.match(/\S+/g);
      if (fallbackFields && fallbackFields.length > 0) {
        const fallbackLead = parseLine(fallbackFields);
        if (fallbackLead) { onLead(fallbackLead); count++; }
      }
    } catch (err: any) {
      logError("universalParser.parseLine", {}, err);
    }
  }

  let offset = 0;
  while (offset < buffer.length) {
    const end = Math.min(offset + CHUNK_SIZE, buffer.length);
    const chunk = buffer.toString('utf-8', offset, end);
    const combined = pending + chunk;
    const parts = combined.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      processLine(line);
    }
    offset = end;
  }
  if (pending) {
    processLine(pending);
  }

  return count;
}

export function parseTextLineByLine(text: string, onLead: (lead: RawLead) => void): number {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return 0;

  const firstNonEmpty = lines.find(l => l.trim().length > 0) || "";
  const delimiter = detectDelimiter(firstNonEmpty);

  let count = 0;
  let skippedHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const fields = trimmed.split(delimiter);

    if (!skippedHeader) {
      skippedHeader = true;
      if (isHeaderRow(fields)) continue;
    }

    try {
      const lead = parseLine(fields);
      if (lead) {
        onLead(lead);
        count++;
        continue;
      }

      const fallbackFields = trimmed.match(/\S+/g);
      if (fallbackFields && fallbackFields.length > 0) {
        const fallbackLead = parseLine(fallbackFields);
        if (fallbackLead) { onLead(fallbackLead); count++; }
      }
    } catch (err: any) {
      logError("universalParser.parseLine", {}, err);
    }
  }
  return count;
}

export function parseXLSXLineByLine(buffer: Buffer, onLead: (lead: RawLead) => void): number {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return 0;
  const sheet = workbook.Sheets[sheetName];
  const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  let count = 0;
  let skippedHeader = false;

  for (const row of rows) {
    const fields = row.map((cell: any) => String(cell ?? ""));

    if (!skippedHeader) {
      skippedHeader = true;
      if (isHeaderRow(fields)) continue;
    }

    try {
      const lead = parseLine(fields);
      if (lead) { onLead(lead); count++; }
    } catch (err: any) {
      logError("universalParser.parseLine", {}, err);
    }
  }
  return count;
}

export class UniversalParser {
  parseStreaming(buffer: Buffer, filename: string, onLead: (lead: RawLead) => void): number {
    const ext = filename.toLowerCase().split(".").pop() || "";

    if (ext === "xlsx" || ext === "xls") {
      return parseXLSXLineByLine(buffer, onLead);
    }

    return parseBufferLineByLine(buffer, onLead);
  }

  async parseFileStream(
    filePath: string,
    filename: string,
    onLead: (lead: RawLead) => void
  ): Promise<number> {
    const ext = filename.toLowerCase().split(".").pop() || "";

    if (ext === "xlsx" || ext === "xls") {
      // XLSX/XLS requires a full buffer read because the format is binary and
      // xlsx-js does not support true streaming. We enforce a 50 MB hard limit
      // to prevent OOM for large spreadsheets. Users with larger files should
      // export to CSV/TXT before uploading.
      const { stat, readFile } = await import("fs/promises");
      const { size } = await stat(filePath);
      const MAX_XLSX_BYTES = 50 * 1024 * 1024; // 50 MB
      if (size > MAX_XLSX_BYTES) {
        throw new Error(
          `Arquivo XLSX/XLS muito grande (${(size / 1024 / 1024).toFixed(1)} MB). ` +
          `Limite: 50 MB. Exporte para CSV/TXT para arquivos maiores.`
        );
      }
      const buffer = await readFile(filePath);
      return parseXLSXLineByLine(buffer, onLead);
    }

    const { createReadStream } = await import("fs");
    const { createInterface } = await import("readline");

    return new Promise<number>((resolve, reject) => {
      const stream = createReadStream(filePath, { encoding: "utf-8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      let delimiter: string | null = null;
      let skippedHeader = false;
      let count = 0;

      rl.on("line", (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) return;

        if (delimiter === null) {
          delimiter = detectDelimiter(trimmed);
        }

        const fields = trimmed.split(delimiter!);

        if (!skippedHeader) {
          skippedHeader = true;
          if (isHeaderRow(fields)) return;
        }

        try {
          const lead = parseLine(fields);
          if (lead) { onLead(lead); count++; return; }
          const fallbackFields = trimmed.match(/\S+/g);
          if (fallbackFields && fallbackFields.length > 0) {
            const fb = parseLine(fallbackFields);
            if (fb) { onLead(fb); count++; }
          }
        } catch (err: any) {
          logError("universalParser.parseLine", {}, err);
        }
      });

      rl.on("close", () => resolve(count));
      rl.on("error", reject);
      stream.on("error", reject);
    });
  }
}
