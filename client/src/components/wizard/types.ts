import type { ImageTemplateField } from "@shared/schema";

export interface ProcessedLead {
  phone: string;
  name: string;
  cpf: string;
}

export interface WizardStepInfo {
  id: number;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  desc: string;
}

export interface StepValidationError {
  field: string;
  message: string;
}

export interface SelectedWaba {
  wabaId: string;
  label: string;
  phoneCount: number;
  source: "discovered" | "manual";
}

export interface DiscoveredWaba {
  wabaId: string;
  wabaName: string;
  phoneCount: number;
  status: string;
}

export interface WizardState {
  name: string;
  description: string;
  isTestMode: boolean;
  bmId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  discoveredWabas: DiscoveredWaba[];
  selectedWabas: SelectedWaba[];
  selectedNumbers: any[];
  selectedTemplates: string[];
  automationEnabled: boolean;
  automationFallback: string;
  botRules: Array<{ keyword: string; response: string; responseType: string; mediaUrl: string }>;
  leadListId: string;
  contactInputMode: "list" | "paste" | "file";
  pastedNumbers: string;
  processedLeads: { total: number; valid: ProcessedLead[]; duplicates: number; invalid: number; errors: string[] } | null;
  directLeads: ProcessedLead[];
  templateParams: Record<string, Record<string, string>>;
  rotationMode: "sequential" | "distributed";
  templatePreviewId: string | null;
  sendSpeed: string;
  burstMode: boolean;
  businessHoursOnly: boolean;
  businessHoursStart: number;
  businessHoursEnd: number;
  scheduledAt: string;
  conversionMessage: string;
  conversionLink: string;
  conversionDelayMs: number;
  usePackageImage: boolean;
  customImageTemplateId: string;
  imageTemplates: Array<{ id: string; name: string; baseImageUrl: string; width: number; height: number; fields?: ImageTemplateField[] }>;
  imagePreviewUrl: string | null;
  imagePreviewLoading: boolean;
  uploadingImage: boolean;
  editorFields: ImageTemplateField[];
  editorSelectedFieldId: string | null;
  editorDragging: { fieldId: string; offsetX: number; offsetY: number } | null;
  editorImgDims: { width: number; height: number };
  editorRenderedDims: { width: number; height: number };
  editorSaving: boolean;
  campaignAudioUrl: string;
  campaignAudioEnabled: boolean;
  discoverLoading: boolean;
  discoverError: string;
  webhookInstructionsOpen: boolean;
  webhookCopied: boolean;
  webhookTesting: boolean;
  webhookTestResult: { success: boolean; message?: string; error?: string } | null;
  creatingLeadList: boolean;
}

export const LEAD_VARIABLES = [
  { label: "Nome", value: "{nome}" },
  { label: "CPF", value: "{cpf}" },
];

export function formatToE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  const normalized = digits.startsWith("55") ? digits : `55${digits}`;
  if (normalized.length < 12 || normalized.length > 13) return null;
  return normalized;
}

export function processLeadLines(raw: string): { total: number; valid: ProcessedLead[]; duplicates: number; invalid: number; errors: string[] } {
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
  const total = lines.length;
  const validMap = new Map<string, ProcessedLead>();
  let invalid = 0;
  let duplicates = 0;
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(/[,;\t]+/).map(p => p.trim());
    const rawPhone = parts[0] || "";
    const formatted = formatToE164(rawPhone);
    if (!formatted) {
      invalid++;
      errors.push(`Linha ${i + 1}: número inválido "${rawPhone}"`);
      continue;
    }
    if (validMap.has(formatted)) {
      duplicates++;
      continue;
    }
    const leadName = parts[1] || "";
    const leadCpf = parts[2] ? parts[2].replace(/[.\-\s]/g, "") : "";
    validMap.set(formatted, { phone: formatted, name: leadName, cpf: leadCpf });
  }
  return { total, valid: Array.from(validMap.values()), duplicates, invalid, errors };
}

export function detectTemplateParams(components: any[]): Array<{ section: string; index: number; key: string }> {
  const seen = new Set<string>();
  const params: Array<{ section: string; index: number; key: string }> = [];
  if (!Array.isArray(components)) return params;
  for (const comp of components) {
    const type = comp.type?.toUpperCase();
    const text = comp.text || "";
    const matches = text.match(/\{\{\d+\}\}/g) || [];
    for (const match of matches) {
      const idx = parseInt(match.replace(/[{}]/g, ""));
      const key = `${type.toLowerCase()}_${idx}`;
      if (!seen.has(key)) {
        seen.add(key);
        params.push({ section: type, index: idx, key });
      }
    }
    if (type === "BUTTONS" && Array.isArray(comp.buttons)) {
      for (let bi = 0; bi < comp.buttons.length; bi++) {
        const btn = comp.buttons[bi];
        if (btn.type === "URL" && btn.url) {
          const btnMatches = btn.url.match(/\{\{\d+\}\}/g) || [];
          for (const m of btnMatches) {
            const idx = parseInt(m.replace(/[{}]/g, ""));
            const key = `button_${bi}_${idx}`;
            if (!seen.has(key)) {
              seen.add(key);
              params.push({ section: `BUTTON_${bi}`, index: idx, key });
            }
          }
        }
      }
    }
  }
  return params;
}

export function generateFieldId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function createDefaultImageField(type: "name" | "cpf"): ImageTemplateField {
  const labels: Record<string, string> = { name: "Nome", cpf: "CPF" };
  const defaults: Record<string, string> = {
    name: "MARIA OLIVEIRA SANTOS",
    cpf: "123.456.789-00",
  };
  return {
    id: generateFieldId(),
    label: labels[type],
    type,
    defaultText: defaults[type],
    x: type === "name" ? 100 : 100,
    y: type === "name" ? 120 : 170,
    fontSize: type === "name" ? 24 : 18,
    fontFamily: "sans-serif",
    fontWeight: type === "name" ? "bold" : "normal",
    fontStyle: "normal",
    color: "#FFFFFF",
    opacity: 100,
    letterSpacing: 0,
    lineHeight: 1.2,
    rotation: 0,
    textAlign: "left",
    maxWidth: 400,
    textTransform: type === "name" ? "uppercase" : "none",
    shadowEnabled: true,
    shadowColor: "#000000",
    shadowOffsetX: 1,
    shadowOffsetY: 1,
    shadowBlur: 3,
    strokeEnabled: false,
    strokeColor: "#000000",
    strokeWidth: 1,
  };
}

export function applyTextTransform(text: string, transform: string): string {
  switch (transform) {
    case "uppercase": return text.toUpperCase();
    case "lowercase": return text.toLowerCase();
    case "capitalize": return text.replace(/\b\w/g, (c) => c.toUpperCase());
    default: return text;
  }
}

export const fontFamilyMap: Record<string, string> = {
  "sans-serif": "Arial, Helvetica, sans-serif",
  "serif": "Georgia, 'Times New Roman', serif",
  "monospace": "'Courier New', Courier, monospace",
  "handwriting": "'Comic Sans MS', 'Segoe Script', cursive",
};
