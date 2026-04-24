import { parseLine, parseTextLineByLine } from "./UniversalParser";
import { QueueEngine } from "./QueueEngine";

interface TestCase {
  name: string;
  input: string;
  expectedPhone: string;
  expectedName: string;
  expectedCPF: string;
  shouldDiscard: boolean;
}

interface TestResult {
  name: string;
  passed: boolean;
  input: string;
  expected: string;
  got: string;
  error: string | null;
}

interface TestSuiteResult {
  totalTests: number;
  passed: number;
  failed: number;
  results: TestResult[];
}

interface FullTestResult {
  totalInput: number;
  totalValid: number;
  totalDiscarded: number;
  outputPreview: string[];
  errors: string[];
  testSuite: TestSuiteResult;
}

const TEST_CASES: TestCase[] = [
  {
    name: "TESTE 1 — Formato padrão",
    input: "5511999999999,Joao Silva,12345678901",
    expectedPhone: "5511999999999",
    expectedName: "JOAO SILVA",
    expectedCPF: "12345678901",
    shouldDiscard: false,
  },
  {
    name: "TESTE 2 — Com máscara",
    input: "(11) 99999-9999,Joao Silva,123.456.789-01",
    expectedPhone: "5511999999999",
    expectedName: "JOAO SILVA",
    expectedCPF: "12345678901",
    shouldDiscard: false,
  },
  {
    name: "TESTE 3 — Colunas extras",
    input: "id,email,telefone,nome,cpf,endereco\n1,test@test.com,11999999999,Joao Silva,12345678901,Rua X",
    expectedPhone: "5511999999999",
    expectedName: "JOAO SILVA",
    expectedCPF: "12345678901",
    shouldDiscard: false,
  },
  {
    name: "TESTE 4 — Só telefone",
    input: "11999999999",
    expectedPhone: "5511999999999",
    expectedName: "",
    expectedCPF: "",
    shouldDiscard: false,
  },
  {
    name: "TESTE 5 — Dados misturados",
    input: "Joao Silva 123.456.789-01 11 99999-9999",
    expectedPhone: "5511999999999",
    expectedName: "JOAO SILVA",
    expectedCPF: "12345678901",
    shouldDiscard: false,
  },
  {
    name: "TESTE 6 — Delimitador diferente",
    input: "11999999999;Joao Silva;12345678901",
    expectedPhone: "5511999999999",
    expectedName: "JOAO SILVA",
    expectedCPF: "12345678901",
    shouldDiscard: false,
  },
  {
    name: "TESTE 7 — Linha inválida",
    input: "abcdefg",
    expectedPhone: "",
    expectedName: "",
    expectedCPF: "",
    shouldDiscard: true,
  },
];

function runSingleTest(tc: TestCase): TestResult {
  try {
    const queue = new QueueEngine();
    const leads: { phone: string; name: string; cpf: string }[] = [];

    parseTextLineByLine(tc.input, (lead) => {
      const ok = queue.enqueue(lead.phone, lead.name, lead.cpf);
      if (ok) {
        while (!queue.isEmpty()) {
          const batch = queue.dequeue(100);
          for (const l of batch) {
            leads.push(l);
          }
        }
      }
    });

    if (tc.shouldDiscard) {
      if (leads.length === 0) {
        return { name: tc.name, passed: true, input: tc.input, expected: "DESCARTADO", got: "DESCARTADO", error: null };
      }
      const got = leads.map(l => `${l.phone},${l.name},${l.cpf}`).join(" | ");
      return { name: tc.name, passed: false, input: tc.input, expected: "DESCARTADO", got, error: "Deveria descartar mas gerou lead" };
    }

    if (leads.length === 0) {
      return { name: tc.name, passed: false, input: tc.input, expected: `${tc.expectedPhone},${tc.expectedName},${tc.expectedCPF}`, got: "NENHUM LEAD", error: "Nenhum lead extraído" };
    }

    const lead = leads[0];
    const expectedLine = `${tc.expectedPhone},${tc.expectedName},${tc.expectedCPF}`;
    const gotLine = `${lead.phone},${lead.name},${lead.cpf}`;

    const phoneOk = lead.phone === tc.expectedPhone;
    const nameOk = lead.name === tc.expectedName;
    const cpfOk = lead.cpf === tc.expectedCPF;
    const passed = phoneOk && nameOk && cpfOk;

    const errors: string[] = [];
    if (!phoneOk) errors.push(`telefone: esperado "${tc.expectedPhone}" got "${lead.phone}"`);
    if (!nameOk) errors.push(`nome: esperado "${tc.expectedName}" got "${lead.name}"`);
    if (!cpfOk) errors.push(`cpf: esperado "${tc.expectedCPF}" got "${lead.cpf}"`);

    return {
      name: tc.name,
      passed,
      input: tc.input.length > 80 ? tc.input.substring(0, 80) + "..." : tc.input,
      expected: expectedLine,
      got: gotLine,
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  } catch (err: any) {
    return {
      name: tc.name,
      passed: false,
      input: tc.input,
      expected: tc.shouldDiscard ? "DESCARTADO" : `${tc.expectedPhone},${tc.expectedName},${tc.expectedCPF}`,
      got: "ERRO",
      error: err?.message || "Erro desconhecido",
    };
  }
}

export function runLeadCleanerTests(): TestSuiteResult {
  const results: TestResult[] = [];
  for (const tc of TEST_CASES) {
    results.push(runSingleTest(tc));
  }
  return {
    totalTests: results.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    results,
  };
}

export function runFullTest(input?: string): FullTestResult {
  const testSuite = runLeadCleanerTests();

  const errors: string[] = [];
  const outputPreview: string[] = [];
  let totalInput = 0;
  let totalValid = 0;
  let totalDiscarded = 0;

  if (input && input.trim().length > 0) {
    const queue = new QueueEngine();
    const lines = input.split(/\r?\n/).filter(l => l.trim().length > 0);
    totalInput = lines.length;

    parseTextLineByLine(input, (lead) => {
      queue.enqueue(lead.phone, lead.name, lead.cpf);
    });

    totalValid = queue.validCount;
    totalDiscarded = totalInput - totalValid - queue.duplicates;

    while (!queue.isEmpty()) {
      const batch = queue.dequeue(100);
      for (const lead of batch) {
        outputPreview.push(`${lead.phone},${lead.name},${lead.cpf}`);
      }
    }

    if (queue.invalidFormat > 0) errors.push(`${queue.invalidFormat} leads com formato de telefone inválido`);
    if (queue.duplicates > 0) errors.push(`${queue.duplicates} duplicatas removidas`);

    queue.release();
  }

  for (const r of testSuite.results) {
    if (!r.passed && r.error) {
      errors.push(`[${r.name}] ${r.error}`);
    }
  }

  return {
    totalInput,
    totalValid,
    totalDiscarded,
    outputPreview: outputPreview.slice(0, 50),
    errors,
    testSuite,
  };
}
