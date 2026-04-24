import type { NormalizedLead } from "./QueueEngine";
import { logError } from '../../utils/logger';

const MAGMA_TOKEN = process.env.MAGMA_TOKEN || "";
const CPF_TIMEOUT_MS = 20000;

export interface CpfValidationResult {
  lead: NormalizedLead;
  valid: boolean | null;
  nome?: string;
  situacao?: string;
}

export async function testCpfApiConnection(): Promise<boolean> {
  const url = `https://magmadatahub.com/api.php?token=${MAGMA_TOKEN}&cpf=00000000000`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.status !== 0;
  } catch (err: any) {
    clearTimeout(timeout);
    console.log(`[CpfValidator] MagmaDataHub API não respondeu (${err?.name || 'erro'}). Pulando validação de CPF.`);
    return false;
  }
}

export async function validateCpfBatch(leads: NormalizedLead[], concurrency: number = 10): Promise<CpfValidationResult[]> {
  const results: CpfValidationResult[] = [];
  let i = 0;

  while (i < leads.length) {
    const chunkSize = Math.min(concurrency, leads.length - i);
    const chunk = leads.slice(i, i + chunkSize);

    const settled = await Promise.allSettled(
      chunk.map(lead => validateSingleCpf(lead))
    );

    for (let idx = 0; idx < settled.length; idx++) {
      const s = settled[idx];
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        results.push({ lead: chunk[idx], valid: null });
      }
    }

    i += chunkSize;
  }

  return results;
}

async function validateSingleCpf(lead: NormalizedLead): Promise<CpfValidationResult> {
  if (!lead.cpf || lead.cpf.length !== 11) {
    return { lead, valid: true };
  }

  const numericCPF = lead.cpf;
  const url = `https://magmadatahub.com/api.php?token=${MAGMA_TOKEN}&cpf=${numericCPF}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CPF_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[CpfValidator] MagmaDataHub HTTP ${response.status} para CPF ${lead.cpf.substring(0, 3)}***`);
      return { lead, valid: null };
    }

    let data: any;
    try {
      data = await response.json();
    } catch (e: any) {
      logError("cpfValidator.parseResponse", {}, e);
      const text = await response.text();
      console.log(`[CpfValidator] Resposta nao-JSON para CPF ${lead.cpf.substring(0, 3)}***: ${text.substring(0, 200)}`);
      return { lead, valid: null };
    }

    const hasNome = !!(data.nome || data.name || data.NomeCompleto || data.nomeCompleto);
    const hasSituacao = !!(data.situacao || data.situacaoCadastral || data.Situacao);
    console.log(`[CpfValidator] CPF ${lead.cpf.substring(0, 3)}***: hasNome=${hasNome}, hasSituacao=${hasSituacao}, status=${data.status}`);

    if (data.valid === false) {
      return { lead, valid: false };
    }

    if (data.status === false || data.status === "error" || data.status === "invalid" || data.status === 0) {
      return { lead, valid: false };
    }

    if (data.error === true || data.erro === true) {
      return { lead, valid: false };
    }

    const situacaoRaw = data.situacao || data.situacaoCadastral || data.Situacao || "";
    const situacao = situacaoRaw.toString().toLowerCase().trim();
    if (situacao && situacao !== "regular" && situacao !== "") {
      if (situacao === "cancelada" || situacao === "nula" || situacao === "suspensa" || situacao === "titular falecido") {
        return { lead, valid: false, situacao };
      }
    }

    if (data.error || data.erro) {
      const errorMsg = (data.error || data.erro || "").toString().toLowerCase();
      if (errorMsg.includes("invalido") || errorMsg.includes("invalid") || errorMsg.includes("nao encontrado") || errorMsg.includes("not found") || errorMsg.includes("cpf inválido")) {
        return { lead, valid: false };
      }
      return { lead, valid: null };
    }

    const nome = data.nome || data.name || data.NomeCompleto || data.nomeCompleto || null;
    if (nome) {
      return { lead, valid: true, nome };
    }

    return { lead, valid: true };
  } catch (err: any) {
    clearTimeout(timeout);
    console.log(`[CpfValidator] Erro ao consultar CPF ${lead.cpf.substring(0, 3)}***: ${err?.message || err?.name}`);
    return { lead, valid: null };
  }
}
