import * as XLSX from "xlsx";
import { logError } from '../../utils/logger';

export interface RawLead {
  phone: string;
  name: string;
  code: string;
  raw: string;
}

export class LeadParser {
  parse(buffer: Buffer, filename: string): RawLead[] {
    const ext = filename.toLowerCase().split(".").pop();
    if (ext === "xlsx" || ext === "xls") {
      return this.parseExcel(buffer);
    }
    return this.parseText(buffer);
  }

  private parseExcel(buffer: Buffer): RawLead[] {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    const leads: RawLead[] = [];
    for (const row of rows) {
      if (!row || row.length === 0) continue;
      const values = row.map((v: any) => String(v).trim());
      const phone = values[0] || "";
      if (!phone || phone.length < 8) continue;
      leads.push({
        phone,
        name: values[1] || "",
        code: values[2] || "",
        raw: values.join(","),
      });
    }
    return leads;
  }

  private parseText(buffer: Buffer): RawLead[] {
    const text = buffer.toString("utf-8");
    const delimiter = this.detectDelimiter(text);
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

    const leads: RawLead[] = [];

    for (const line of lines) {
      try {
        if (delimiter) {
          const parts = line.split(delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ""));
          const phone = parts[0] || "";
          if (phone.length >= 8) {
            leads.push({ phone, name: parts[1] || "", code: parts[2] || "", raw: line });
            continue;
          }
        }

        const phoneMatch = line.match(/\+?\d{10,15}/g);
        if (phoneMatch) {
          for (const p of phoneMatch) {
            leads.push({ phone: p, name: "", code: "", raw: line });
          }
        }
      } catch (e: any) {
        logError("leadParser.parseLine", {}, e);
        continue;
      }
    }
    return leads;
  }

  private detectDelimiter(text: string): string | null {
    const firstLines = text.split(/\r?\n/).slice(0, 10).join("\n");
    const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
    for (const char of Object.keys(counts)) {
      counts[char] = (firstLines.match(new RegExp(`\\${char}`, "g")) || []).length;
    }
    let best: string | null = null;
    let max = 0;
    for (const [char, count] of Object.entries(counts)) {
      if (count > max) {
        max = count;
        best = char;
      }
    }
    return max > 0 ? best : null;
  }
}
