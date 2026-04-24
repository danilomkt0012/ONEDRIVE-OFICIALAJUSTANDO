import type { RawLead } from "./LeadParser";
import { logError } from '../../utils/logger';

export interface NormalizedLead {
  phone: string;
  name: string;
  code: string;
}

export interface NormalizeResult {
  leads: NormalizedLead[];
  stats: {
    totalRaw: number;
    afterNormalize: number;
    duplicatesRemoved: number;
    invalidRemoved: number;
  };
}

export class LeadNormalizer {
  normalize(rawLeads: RawLead[]): NormalizeResult {
    const totalRaw = rawLeads.length;
    const normalized: NormalizedLead[] = [];
    let invalidRemoved = 0;

    for (const lead of rawLeads) {
      try {
        const phone = this.normalizePhone(lead.phone);
        if (!phone) {
          invalidRemoved++;
          continue;
        }
        normalized.push({
          phone,
          name: lead.name.trim(),
          code: (lead.code || "").trim(),
        });
      } catch (e: any) {
        logError("leadNormalizer.normalizeLead", {}, e);
        invalidRemoved++;
      }
    }

    const seen = new Set<string>();
    const deduped: NormalizedLead[] = [];
    for (const lead of normalized) {
      if (!seen.has(lead.phone)) {
        seen.add(lead.phone);
        deduped.push(lead);
      }
    }

    return {
      leads: deduped,
      stats: {
        totalRaw,
        afterNormalize: deduped.length,
        duplicatesRemoved: normalized.length - deduped.length,
        invalidRemoved,
      },
    };
  }

  private normalizePhone(raw: string): string | null {
    let digits = raw.replace(/\D/g, "");
    if (digits.startsWith("0")) {
      digits = digits.substring(1);
    }
    if (digits.length === 10 || digits.length === 11) {
      digits = "55" + digits;
    }
    if (digits.length < 12 || digits.length > 13) {
      return null;
    }
    if (!digits.startsWith("55")) {
      return null;
    }
    return digits;
  }
}
