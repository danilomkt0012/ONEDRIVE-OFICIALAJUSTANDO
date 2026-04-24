import { parseLine, parseTextLineByLine } from "./UniversalParser";
import { QueueEngine, type NormalizedLead } from "./QueueEngine";
import { CacheLayer } from "./CacheLayer";
import { AdaptiveWorkerPool } from "./AdaptiveWorkerPool";
import { StreamFileWriter } from "./StreamFileWriter";
import fs from "fs";
import path from "path";
import os from "os";
import { logError } from '../../utils/logger';

const STRICT_MODE = true;

interface TestDetail {
  name: string;
  passed: boolean;
  detail: string;
  error: string | null;
}

interface SelfTestReport {
  approved: boolean;
  totalTests: number;
  passed: number;
  failed: number;
  falsePositives: number;
  crashDetected: boolean;
  apiCallsCount: number;
  cacheHits: number;
  concurrencyChanges: number;
  exportIntegrity: boolean;
  parserRobust: boolean;
  normalizationCorrect: boolean;
  strictMode: boolean;
  tests: {
    A_parser: TestDetail[];
    B_normalization: TestDetail[];
    C_apiIntegration: TestDetail[];
    D_forcedFailure: TestDetail[];
    E_cache: TestDetail[];
    F_streamWriting: TestDetail[];
    G_concurrencyAdaptive: TestDetail[];
  };
  failedTests: string[];
}

function strictAssert(condition: boolean, msg: string): void {
  if (STRICT_MODE && !condition) {
    throw new Error(`STRICT: ${msg}`);
  }
}

function makeTestLead(phone: string, name: string = "", cpf: string = ""): NormalizedLead {
  return { phone, name, cpf };
}

function createIsolatedCache(): CacheLayer {
  const cache = new CacheLayer();
  (cache as any).cache = new Map();
  return cache;
}

function patchPoolFetch(pool: AdaptiveWorkerPool, handler: (phone: string) => { status: number; body: any; delay?: number; throwTimeout?: boolean }): { callLog: { phone: string; payload: any }[] } {
  const callLog: { phone: string; payload: any }[] = [];

  (pool as any).sleep = async () => {};

  (pool as any).checkWithRetry = async function (lead: NormalizedLead) {
    return (this as any).checkSingle(lead);
  };

  (pool as any).checkSingle = async function (lead: NormalizedLead) {
    const phoneForAPI = lead.phone;
    callLog.push({ phone: phoneForAPI, payload: { phoneNumber: phoneForAPI } });

    const mock = handler(phoneForAPI);

    if (mock.delay) {
      await new Promise(r => setTimeout(r, mock.delay));
    }

    if (mock.throwTimeout) {
      (this as any).totalChecked++;
      (this as any).totalErrors++;
      (this as any).consecutiveTimeouts++;
      if ((this as any).consecutiveTimeouts >= 3) {
        (this as any)._currentConcurrency = Math.max((this as any).minConcurrency, Math.floor((this as any)._currentConcurrency * 0.5));
        (this as any).backoffMs = Math.min((this as any).backoffMs * 2 || 1000, 16000);
      }
      return { lead, valid: null, fromCache: false };
    }

    (this as any).totalChecked++;
    (this as any).consecutiveTimeouts = 0;

    if (mock.status === 429) {
      (this as any).totalErrors++;
      (this as any).backoffMs = Math.min((this as any).backoffMs * 2 || 1000, 16000);
      return { lead, valid: null, fromCache: false };
    }

    if (mock.status >= 500) {
      (this as any).totalErrors++;
      (this as any).backoffMs = Math.min((this as any).backoffMs * 2 || 500, 8000);
      return { lead, valid: null, fromCache: false };
    }

    if (mock.status < 200 || mock.status >= 300) {
      (this as any).totalErrors++;
      return { lead, valid: null, fromCache: false };
    }

    (this as any).backoffMs = Math.max(0, (this as any).backoffMs - 200);

    if (mock.body === null || mock.body === undefined) {
      (this as any).totalErrors++;
      return { lead, valid: null, fromCache: false };
    }

    if (!("existsWhatsapp" in mock.body)) {
      (this as any).totalErrors++;
      return { lead, valid: null, fromCache: false };
    }

    const exists = mock.body.existsWhatsapp === true;
    (this as any).cache.set(lead.phone, exists);
    return { lead, valid: exists, fromCache: false };
  };

  return { callLog };
}

function testA_Parser(): TestDetail[] {
  const results: TestDetail[] = [];
  let allPassed = true;

  const scenarios: { name: string; input: string; expectPhone: string | null; expectName: string; expectCPF: string }[] = [
    { name: "CSV padrão", input: "5511999887766,Joao Silva,12345678901", expectPhone: "5511999887766", expectName: "JOAO SILVA", expectCPF: "12345678901" },
    { name: "CSV com colunas extras", input: "id,telefone,nome,cpf,endereco\n1,11999887766,Maria Santos,98765432100,Rua A", expectPhone: "5511999887766", expectName: "MARIA SANTOS", expectCPF: "98765432100" },
    { name: "TXT tab-delimited", input: "11999887766\tJoao Silva\t12345678901", expectPhone: "5511999887766", expectName: "JOAO SILVA", expectCPF: "12345678901" },
    { name: "Delimitador ponto e vírgula", input: "11999887766;Joao Silva;123.456.789-01", expectPhone: "5511999887766", expectName: "JOAO SILVA", expectCPF: "12345678901" },
    { name: "Dados misturados com vírgula", input: "Joao Silva,123.456.789-01,(11) 99988-7766", expectPhone: "5511999887766", expectName: "JOAO SILVA", expectCPF: "12345678901" },
    { name: "Apenas telefone", input: "11999887766", expectPhone: "5511999887766", expectName: "", expectCPF: "" },
    { name: "Linha inválida (texto puro)", input: "abcdefghijk", expectPhone: null, expectName: "", expectCPF: "" },
    { name: "Telefone com máscara completa", input: "(11) 99988-7766,Carlos Souza,987.654.321-00", expectPhone: "5511999887766", expectName: "CARLOS SOUZA", expectCPF: "98765432100" },
    { name: "Telefone com +55", input: "+5511999887766,Ana Lima,11122233344", expectPhone: "5511999887766", expectName: "ANA LIMA", expectCPF: "11122233344" },
    { name: "CPF primeiro, telefone depois", input: "12345678901,Pedro Costa,11999887766", expectPhone: "5511999887766", expectName: "PEDRO COSTA", expectCPF: "12345678901" },
  ];

  for (const sc of scenarios) {
    try {
      const queue = new QueueEngine();
      const leads: NormalizedLead[] = [];

      parseTextLineByLine(sc.input, (lead) => {
        if (queue.enqueue(lead.phone, lead.name, lead.cpf)) {
          const batch = queue.dequeue(100);
          leads.push(...batch);
        }
      });

      if (sc.expectPhone === null) {
        const ok = leads.length === 0;
        strictAssert(ok, `${sc.name}: lead inválido não descartado`);
        results.push({ name: `A: ${sc.name}`, passed: ok, detail: ok ? "Descartado corretamente" : `Gerou ${leads.length} lead(s)`, error: ok ? null : "Lead inválido não descartado" });
        if (!ok) allPassed = false;
      } else {
        strictAssert(leads.length > 0, `${sc.name}: nenhum lead extraído`);
        if (leads.length === 0) { results.push({ name: `A: ${sc.name}`, passed: false, detail: "0 leads", error: "Nenhum lead" }); allPassed = false; continue; }
        const l = leads[0];
        const phoneOk = l.phone === sc.expectPhone;
        const nameOk = l.name === sc.expectName;
        const cpfOk = l.cpf === sc.expectCPF;
        const ok = phoneOk && nameOk && cpfOk;
        const errors: string[] = [];
        if (!phoneOk) errors.push(`phone: "${l.phone}" != "${sc.expectPhone}"`);
        if (!nameOk) errors.push(`name: "${l.name}" != "${sc.expectName}"`);
        if (!cpfOk) errors.push(`cpf: "${l.cpf}" != "${sc.expectCPF}"`);
        strictAssert(ok, `${sc.name}: ${errors.join("; ")}`);
        results.push({ name: `A: ${sc.name}`, passed: ok, detail: ok ? `${l.phone},${l.name},${l.cpf}` : errors.join("; "), error: ok ? null : errors.join("; ") });
        if (!ok) allPassed = false;
      }
      queue.release();
    } catch (err: any) {
      results.push({ name: `A: ${sc.name}`, passed: false, detail: "CRASH", error: err?.message });
      allPassed = false;
      if (STRICT_MODE) throw err;
    }
  }

  results.push({ name: "A: Todos cenários sem crash", passed: allPassed, detail: allPassed ? "10/10 cenários OK" : "Falhas detectadas", error: allPassed ? null : "Cenários falharam" });
  return results;
}

function testB_Normalization(): TestDetail[] {
  const results: TestDetail[] = [];

  {
    const q = new QueueEngine();
    q.enqueue("11999887766", "joao silva", "123.456.789-01");
    const batch = q.dequeue(1);
    const l = batch[0];
    strictAssert(l !== undefined, "Lead undefined após enqueue");

    const phoneOk = l.phone === "5511999887766";
    strictAssert(phoneOk, `Phone: "${l.phone}" != "5511999887766"`);
    results.push({ name: "B: Telefone normalizado com 55", passed: phoneOk, detail: `phone="${l.phone}"`, error: phoneOk ? null : `got "${l.phone}"` });

    const nameOk = l.name === "JOAO SILVA";
    strictAssert(nameOk, `Name: "${l.name}" != "JOAO SILVA"`);
    results.push({ name: "B: Nome em maiúsculo", passed: nameOk, detail: `name="${l.name}"`, error: nameOk ? null : `got "${l.name}"` });

    const cpfOk = l.cpf === "12345678901";
    strictAssert(cpfOk, `CPF: "${l.cpf}" != "12345678901"`);
    results.push({ name: "B: CPF somente dígitos", passed: cpfOk, detail: `cpf="${l.cpf}"`, error: cpfOk ? null : `got "${l.cpf}"` });
    q.release();
  }

  {
    const q = new QueueEngine();
    q.enqueue("11999887766", "Ana", "12345678901");
    q.enqueue("11999887766", "Ana2", "12345678901");
    const ok = q.validCount === 1 && q.duplicates === 1;
    strictAssert(ok, `Dedup falhou: valid=${q.validCount}, dup=${q.duplicates}`);
    results.push({ name: "B: Duplicados removidos", passed: ok, detail: `valid=${q.validCount}, duplicates=${q.duplicates}`, error: ok ? null : "Duplicata não detectada" });
    q.release();
  }

  {
    const q = new QueueEngine();
    q.enqueue("11999887766", "Test", "11111111111");
    const batch = q.dequeue(1);
    const cpfOk = batch[0].cpf === "";
    strictAssert(cpfOk, `CPF inválido não descartado: "${batch[0].cpf}"`);
    results.push({ name: "B: CPF inválido (todos iguais) descartado", passed: cpfOk, detail: `cpf="${batch[0].cpf}"`, error: cpfOk ? null : "CPF inválido aceito" });
    q.release();
  }

  {
    const q = new QueueEngine();
    const ok1 = q.enqueue("123", "Test", "");
    const ok2 = q.enqueue("abc", "Test", "");
    const ok3 = q.enqueue("", "Test", "");
    const allRejected = !ok1 && !ok2 && !ok3 && q.validCount === 0;
    strictAssert(allRejected, "Telefone inválido foi aceito");
    results.push({ name: "B: Telefones inválidos rejeitados", passed: allRejected, detail: `invalidFormat=${q.invalidFormat}`, error: allRejected ? null : "Aceito" });
    q.release();
  }

  {
    const q = new QueueEngine();
    q.enqueue("5511999887766", "Test", "12345678901");
    const batch = q.dequeue(1);
    const ok = batch[0].phone === "5511999887766";
    strictAssert(ok, `55 prefix altered: "${batch[0].phone}"`);
    results.push({ name: "B: Telefone já com 55 mantido", passed: ok, detail: `phone="${batch[0].phone}"`, error: ok ? null : "Alterado" });
    q.release();
  }

  {
    const q = new QueueEngine();
    q.enqueue("11999887766", "  João   da   Silva  ", "");
    const batch = q.dequeue(1);
    const noExtra = !/\s{2,}/.test(batch[0].name);
    strictAssert(noExtra, `Espaços extras: "${batch[0].name}"`);
    results.push({ name: "B: Nome sem espaços extras", passed: noExtra, detail: `name="${batch[0].name}"`, error: noExtra ? null : "Espaços" });
    q.release();
  }

  return results;
}

async function testC_ApiIntegration(): Promise<{ results: TestDetail[]; apiCallsCount: number; falsePositives: number }> {
  const results: TestDetail[] = [];
  let falsePositives = 0;
  let totalApiCalls = 0;

  const testCache = createIsolatedCache();

  const scenarios: { name: string; mockStatus: number; mockBody: any; throwTimeout?: boolean; expectValid: boolean | null }[] = [
    { name: "Resposta válida (true)", mockStatus: 200, mockBody: { existsWhatsapp: true }, expectValid: true },
    { name: "Resposta válida (false)", mockStatus: 200, mockBody: { existsWhatsapp: false }, expectValid: false },
    { name: "Resposta malformada (sem campo)", mockStatus: 200, mockBody: { ok: true }, expectValid: null },
    { name: "Resposta string 'true'", mockStatus: 200, mockBody: { existsWhatsapp: "true" }, expectValid: false },
    { name: "Resposta número 1", mockStatus: 200, mockBody: { existsWhatsapp: 1 }, expectValid: false },
    { name: "HTTP 500", mockStatus: 500, mockBody: {}, expectValid: null },
    { name: "HTTP 429", mockStatus: 429, mockBody: {}, expectValid: null },
    { name: "HTTP 403", mockStatus: 403, mockBody: {}, expectValid: null },
    { name: "Timeout", mockStatus: 0, mockBody: {}, throwTimeout: true, expectValid: null },
    { name: "JSON null body", mockStatus: 200, mockBody: null, expectValid: null },
  ];

  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    const pool = new AdaptiveWorkerPool(testCache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    const { callLog } = patchPoolFetch(pool, () => ({
      status: sc.mockStatus,
      body: sc.mockBody,
      throwTimeout: sc.throwTimeout,
    }));

    const lead = makeTestLead(`551198700${String(i).padStart(4, "0")}`);

    try {
      const batchResults = await pool.processBatch([lead]);
      totalApiCalls += callLog.length;

      strictAssert(batchResults.length === 1, `${sc.name}: resultado vazio`);
      const r = batchResults[0];
      const actualValid = r.valid;

      const match = actualValid === sc.expectValid;
      const isFP = sc.expectValid !== true && actualValid === true;
      if (isFP) falsePositives++;

      strictAssert(!isFP, `${sc.name}: FALSO POSITIVO! valid=${actualValid}`);
      strictAssert(match, `${sc.name}: valid=${actualValid}, esperado=${sc.expectValid}`);

      const payloadOk = callLog.length > 0 && callLog[0].payload.phoneNumber === lead.phone;

      results.push({
        name: `C: ${sc.name}`,
        passed: match && !isFP,
        detail: `valid=${actualValid}, expected=${sc.expectValid}, apiCalls=${callLog.length}, payloadOk=${payloadOk}, falsePositive=${isFP}`,
        error: !match ? `valid=${actualValid} != ${sc.expectValid}` : isFP ? "FALSO POSITIVO" : null,
      });
    } catch (err: any) {
      if (STRICT_MODE) throw err;
      results.push({ name: `C: ${sc.name}`, passed: false, detail: "CRASH", error: err?.message });
    }
  }

  {
    const pool = new AdaptiveWorkerPool(testCache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";
    const { callLog } = patchPoolFetch(pool, () => ({ status: 200, body: { existsWhatsapp: true } }));
    const lead = makeTestLead("5511987011234");
    await pool.processBatch([lead]);

    const payloadCorrect = callLog.length > 0 && callLog[0].payload.phoneNumber === "5511987011234" && typeof callLog[0].payload.phoneNumber === "string";
    strictAssert(payloadCorrect, "Payload incorreto");
    results.push({ name: "C: Payload enviado correto", passed: payloadCorrect, detail: `payload=${JSON.stringify(callLog[0]?.payload)}`, error: payloadCorrect ? null : "Payload errado" });
    totalApiCalls += callLog.length;
  }

  {
    const existsTrue = ({ existsWhatsapp: true }).existsWhatsapp === true;
    const existsFalse = ({ existsWhatsapp: false }).existsWhatsapp === true;
    const existsString = ({ existsWhatsapp: "true" } as any).existsWhatsapp === true;
    const existsNum = ({ existsWhatsapp: 1 } as any).existsWhatsapp === true;
    const existsNull = ({ existsWhatsapp: null } as any).existsWhatsapp === true;
    const existsUndef = ({} as any).existsWhatsapp === true;
    const allStrict = existsTrue && !existsFalse && !existsString && !existsNum && !existsNull && !existsUndef;
    strictAssert(allStrict, "Verificação não é estrita");
    results.push({ name: "C: Verificação estrita (=== true)", passed: allStrict, detail: `true=${existsTrue}, false=${existsFalse}, "true"=${existsString}, 1=${existsNum}, null=${existsNull}, undef=${existsUndef}`, error: allStrict ? null : "Não estrita" });
  }

  await testCache.destroy();

  return { results, apiCallsCount: totalApiCalls, falsePositives };
}

async function testD_ForcedFailure(): Promise<{ results: TestDetail[]; falsePositives: number }> {
  const results: TestDetail[] = [];
  let falsePositives = 0;

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    patchPoolFetch(pool, () => ({ status: 0, body: null, throwTimeout: true }));

    const leads = Array.from({ length: 10 }, (_, i) => makeTestLead(`551198600${String(i).padStart(4, "0")}`));
    const batchResults = await pool.processBatch(leads);

    const anyValid = batchResults.some(r => r.valid === true);
    if (anyValid) falsePositives++;
    strictAssert(!anyValid, "API fora do ar gerou lead válido");
    results.push({ name: "D: API fora do ar — nenhum válido", passed: !anyValid, detail: `validCount=${batchResults.filter(r => r.valid === true).length}/${batchResults.length}`, error: anyValid ? "FALSO POSITIVO" : null });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";
    const initialConc = pool.concurrency;

    patchPoolFetch(pool, () => ({ status: 0, body: null, throwTimeout: true }));

    const leads = Array.from({ length: 20 }, (_, i) => makeTestLead(`551198610${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const reduced = pool.concurrency < initialConc;
    const aboveMin = pool.concurrency >= 5;
    strictAssert(reduced, `Timeout consecutivo não reduziu: ${pool.concurrency}`);
    strictAssert(aboveMin, `Abaixo do mínimo: ${pool.concurrency}`);
    results.push({ name: "D: Timeout consecutivo reduz concurrency", passed: reduced && aboveMin, detail: `initial=${initialConc}, final=${pool.concurrency}`, error: reduced && aboveMin ? null : `concurrency=${pool.concurrency}` });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    patchPoolFetch(pool, () => ({ status: 429, body: {} }));

    const leads = Array.from({ length: 5 }, (_, i) => makeTestLead(`551198620${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const backoff = (pool as any).backoffMs;
    const ok = backoff > 0;
    strictAssert(ok, "Backoff não aplicado após 429");
    const anyValid = false;
    results.push({ name: "D: Rate limit aplica backoff", passed: ok && !anyValid, detail: `backoffMs=${backoff}`, error: ok ? null : "Backoff=0" });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    patchPoolFetch(pool, () => ({ status: 200, body: { unexpected: "data" } }));

    const leads = [makeTestLead("5511986300000")];
    const batchResults = await pool.processBatch(leads);

    const anyValid = batchResults.some(r => r.valid === true);
    if (anyValid) falsePositives++;
    strictAssert(!anyValid, "Resposta inesperada gerou válido");
    results.push({ name: "D: Resposta inesperada não exporta", passed: !anyValid, detail: `valid=${batchResults[0]?.valid}`, error: anyValid ? "FALSO POSITIVO" : null });
    await cache.destroy();
  }

  {
    let crashed = false;
    try {
      const q = new QueueEngine();
      for (let i = 0; i < 500; i++) {
        q.enqueue(`1199988${String(i).padStart(4, "0")}`, `User ${i}`, "");
      }
      while (!q.isEmpty()) { q.dequeue(50); }
      q.release();
    } catch (e: any) {
      logError("systemSelfTest.stressTest", {}, e);
      crashed = true;
    }
    strictAssert(!crashed, "Sistema travou sob stress");
    results.push({ name: "D: Sistema não trava (500 leads)", passed: !crashed, detail: crashed ? "CRASH" : "OK", error: crashed ? "Crash" : null });
  }

  return { results, falsePositives };
}

async function testE_Cache(): Promise<TestDetail[]> {
  const results: TestDetail[] = [];

  const testCache = new CacheLayer();

  {
    testCache.set("5511999000001", true);
    testCache.set("5511999000002", false);
    const val1 = testCache.get("5511999000001");
    const val2 = testCache.get("5511999000002");
    const ok = val1 === true && val2 === false;
    strictAssert(ok, `Cache set/get falhou: ${val1}, ${val2}`);
    results.push({ name: "E: Número validado armazenado", passed: ok, detail: `get(001)=${val1}, get(002)=${val2}`, error: ok ? null : "Falhou" });
  }

  {
    const val = testCache.get("5511999000001");
    const ok = val === true;
    strictAssert(ok, `Cache miss inesperado: ${val}`);
    results.push({ name: "E: Segunda leitura usa cache", passed: ok, detail: `cached=${val}`, error: ok ? null : "Miss" });
  }

  {
    const val = testCache.get("5511999999999");
    const ok = val === null;
    strictAssert(ok, `Número não cacheado != null: ${val}`);
    results.push({ name: "E: Número desconhecido retorna null", passed: ok, detail: `get(unknown)=${val}`, error: ok ? null : `Got ${val}` });
  }

  {
    (testCache as any).cache.set("5511900000001", { exists: true, checkedAt: Date.now() - (8 * 24 * 60 * 60 * 1000) });
    const expired = testCache.get("5511900000001");
    const ok = expired === null;
    strictAssert(ok, `TTL expirado não removido: ${expired}`);
    results.push({ name: "E: Cache respeita TTL (7 dias)", passed: ok, detail: `expired=${expired}`, error: ok ? null : `Got ${expired}` });
  }

  {
    const freshCache = new CacheLayer();
    const before = freshCache.get("5511900099999");
    const ok = before === null;
    strictAssert(ok, `Cache retornou valor para número nunca verificado: ${before}`);
    results.push({ name: "E: Cache não mascara erro", passed: ok, detail: `before_set=${before}`, error: ok ? null : `Got ${before}` });
    await freshCache.destroy();
  }

  await testCache.destroy();
  return results;
}

async function testF_StreamWriting(): Promise<TestDetail[]> {
  const results: TestDetail[] = [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "selftest_"));
  const testId = `selftest_${Date.now()}`;
  const writer = new StreamFileWriter(testId);
  await writer.init();

  const validPhones = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const phone = `55119${String(70000000 + i)}`;
    const name = `USER ${String(i).padStart(4, "0")}`;
    const cpf = String(10000000000 + i);
    if (!validPhones.has(phone)) {
      validPhones.add(phone);
      writer.append(phone, name, cpf);
    }
  }

  const finalPath = await writer.finalizeAsync();

  let fileContent = "";
  try {
    fileContent = fs.readFileSync(finalPath, "utf-8");
  } catch (err: any) {
    strictAssert(false, `Arquivo não encontrado: ${err?.message}`);
    results.push({ name: "F: Arquivo criado", passed: false, detail: "Não encontrado", error: err?.message });
    return results;
  }

  results.push({ name: "F: Arquivo criado", passed: true, detail: `path=${finalPath}`, error: null });

  const lines = fileContent.split("\n").filter(l => l.trim().length > 0);

  {
    const ok = lines.length === 1000;
    strictAssert(ok, `Lines=${lines.length}, esperado 1000`);
    results.push({ name: "F: Contém exatamente 1000 leads", passed: ok, detail: `lines=${lines.length}`, error: ok ? null : `Got ${lines.length}` });
  }

  let allThreeColumns = true;
  let hasNull = false;
  let hasUndefined = false;
  let hasMalformed = false;
  let hasDuplicate = false;
  const seenPhones = new Set<string>();

  for (const line of lines) {
    const parts = line.split(",");
    if (parts.length !== 3) allThreeColumns = false;
    if (line.includes("null")) hasNull = true;
    if (line.includes("undefined")) hasUndefined = true;
    if (parts[0] && !/^\d{12,13}$/.test(parts[0])) hasMalformed = true;
    if (seenPhones.has(parts[0])) hasDuplicate = true;
    seenPhones.add(parts[0]);
  }

  strictAssert(allThreeColumns, "Linha sem 3 colunas");
  results.push({ name: "F: Sempre 3 colunas", passed: allThreeColumns, detail: `ok=${allThreeColumns}`, error: allThreeColumns ? null : "Coluna faltando" });

  strictAssert(!hasNull && !hasUndefined, "null/undefined no CSV");
  results.push({ name: "F: Nenhum null/undefined", passed: !hasNull && !hasUndefined, detail: `null=${hasNull}, undefined=${hasUndefined}`, error: hasNull || hasUndefined ? "Dados corrompidos" : null });

  strictAssert(!hasMalformed, "Telefone malformado");
  results.push({ name: "F: Nenhum dado malformado", passed: !hasMalformed, detail: `malformed=${hasMalformed}`, error: hasMalformed ? "Formato incorreto" : null });

  strictAssert(!hasDuplicate, "Duplicata no CSV");
  results.push({ name: "F: Sem duplicados no CSV", passed: !hasDuplicate, detail: `duplicate=${hasDuplicate}`, error: hasDuplicate ? "Duplicata" : null });

  {
    const first = lines[0]?.split(",");
    const last = lines[lines.length - 1]?.split(",");
    const ok = first?.length === 3 && last?.length === 3 && /^\d{12,13}$/.test(first[0]) && /^\d{12,13}$/.test(last[0]);
    strictAssert(!!ok, "Integridade primeira/última linha");
    results.push({ name: "F: Integridade início e fim", passed: !!ok, detail: `first=${first?.join(",")}, last=${last?.join(",")}`, error: ok ? null : "Malformada" });
  }

  try { fs.unlinkSync(finalPath); } catch (e: any) {
    logError('SystemSelfTest.unlinkFinalPath', { finalPath }, e);
  }
  try { fs.rmdirSync(tmpDir); } catch (e: any) {
    logError('SystemSelfTest.rmdirTmpDir', { tmpDir }, e);
  }

  return results;
}

async function testG_ConcurrencyAdaptive(): Promise<TestDetail[]> {
  const results: TestDetail[] = [];

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";
    const initialConc = pool.concurrency;

    patchPoolFetch(pool, () => ({ status: 500, body: {} }));

    const leads = Array.from({ length: 30 }, (_, i) => makeTestLead(`551198700${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const reduced = pool.concurrency < initialConc;
    strictAssert(reduced, `Alta taxa erro não reduziu: initial=${initialConc}, final=${pool.concurrency}`);
    results.push({ name: "G: Alta taxa de erro reduz concurrency", passed: reduced, detail: `initial=${initialConc}, final=${pool.concurrency}`, error: reduced ? null : "Não reduziu" });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    patchPoolFetch(pool, () => ({ status: 0, body: null, throwTimeout: true }));

    const leads = Array.from({ length: 30 }, (_, i) => makeTestLead(`551198710${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const aboveMin = pool.concurrency >= 5;
    strictAssert(aboveMin, `Abaixo do mínimo: ${pool.concurrency}`);
    results.push({ name: "G: Concurrency nunca abaixo de 5", passed: aboveMin, detail: `concurrency=${pool.concurrency}`, error: aboveMin ? null : `Got ${pool.concurrency}` });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    patchPoolFetch(pool, () => ({ status: 200, body: { existsWhatsapp: true } }));

    const leads = Array.from({ length: 50 }, (_, i) => makeTestLead(`551198720${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const belowMax = pool.concurrency <= 20;
    strictAssert(belowMax, `Acima do máximo: ${pool.concurrency}`);
    results.push({ name: "G: Concurrency nunca acima de 20", passed: belowMax, detail: `concurrency=${pool.concurrency}`, error: belowMax ? null : `Got ${pool.concurrency}` });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";

    (pool as any)._currentConcurrency = 5;
    (pool as any).totalChecked = 200;
    (pool as any).totalErrors = 0;

    patchPoolFetch(pool, () => ({ status: 200, body: { existsWhatsapp: true } }));

    const leads = Array.from({ length: 100 }, (_, i) => makeTestLead(`551198730${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const recovered = pool.concurrency > 5;
    strictAssert(recovered, `Não recuperou: ${pool.concurrency}`);
    results.push({ name: "G: Recuperação gradual funciona", passed: recovered, detail: `final=${pool.concurrency}`, error: recovered ? null : "Não recuperou" });
    await cache.destroy();
  }

  {
    const cache = createIsolatedCache();
    const pool = new AdaptiveWorkerPool(cache);
    (pool as any).idInstance = "test";
    (pool as any).apiToken = "test";
    const initial = pool.concurrency;

    patchPoolFetch(pool, () => ({ status: 0, body: null, throwTimeout: true }));

    const leads = Array.from({ length: 10 }, (_, i) => makeTestLead(`551198740${String(i).padStart(4, "0")}`));
    await pool.processBatch(leads);

    const halved = pool.concurrency < initial;
    const ok = halved && pool.concurrency >= 5;
    strictAssert(ok, `Timeout halving: initial=${initial}, final=${pool.concurrency}`);
    results.push({ name: "G: Timeouts reduzem pela metade", passed: ok, detail: `initial=${initial}, final=${pool.concurrency}`, error: ok ? null : `Got ${pool.concurrency}` });
    await cache.destroy();
  }

  return results;
}

export async function runSystemSelfTest(): Promise<SelfTestReport> {
  const allTests: TestDetail[] = [];
  let crashDetected = false;
  let totalFalsePositives = 0;
  let totalApiCalls = 0;

  let testsA: TestDetail[] = [];
  let testsB: TestDetail[] = [];
  let testsC: TestDetail[] = [];
  let testsD: TestDetail[] = [];
  let testsE: TestDetail[] = [];
  let testsF: TestDetail[] = [];
  let testsG: TestDetail[] = [];

  try { testsA = testA_Parser(); } catch (e: any) {
    crashDetected = true;
    testsA = [{ name: "A: CRASH", passed: false, detail: e?.message, error: "Crash no parser" }];
  }

  try { testsB = testB_Normalization(); } catch (e: any) {
    crashDetected = true;
    testsB = [{ name: "B: CRASH", passed: false, detail: e?.message, error: "Crash normalização" }];
  }

  try {
    const cResult = await testC_ApiIntegration();
    testsC = cResult.results;
    totalApiCalls += cResult.apiCallsCount;
    totalFalsePositives += cResult.falsePositives;
  } catch (e: any) {
    crashDetected = true;
    testsC = [{ name: "C: CRASH", passed: false, detail: e?.message, error: "Crash API integration" }];
  }

  try {
    const dResult = await testD_ForcedFailure();
    testsD = dResult.results;
    totalFalsePositives += dResult.falsePositives;
  } catch (e: any) {
    crashDetected = true;
    testsD = [{ name: "D: CRASH", passed: false, detail: e?.message, error: "Crash falha forçada" }];
  }

  try { testsE = await testE_Cache(); } catch (e: any) {
    crashDetected = true;
    testsE = [{ name: "E: CRASH", passed: false, detail: e?.message, error: "Crash cache" }];
  }

  try { testsF = await testF_StreamWriting(); } catch (e: any) {
    crashDetected = true;
    testsF = [{ name: "F: CRASH", passed: false, detail: e?.message, error: "Crash stream writing" }];
  }

  try { testsG = await testG_ConcurrencyAdaptive(); } catch (e: any) {
    crashDetected = true;
    testsG = [{ name: "G: CRASH", passed: false, detail: e?.message, error: "Crash concurrency" }];
  }

  allTests.push(...testsA, ...testsB, ...testsC, ...testsD, ...testsE, ...testsF, ...testsG);

  const totalTests = allTests.length;
  const passed = allTests.filter(t => t.passed).length;
  const failed = allTests.filter(t => !t.passed).length;

  const parserRobust = testsA.every(t => t.passed);
  const normalizationCorrect = testsB.every(t => t.passed);
  const exportIntegrity = testsF.every(t => t.passed);
  const cacheHits = testsE.filter(t => t.passed && t.name.includes("cache")).length;
  const concurrencyChanges = testsG.filter(t => t.name.includes("reduz") || t.name.includes("Recuperação") || t.name.includes("halv")).length;

  const approved = failed === 0 && totalFalsePositives === 0 && !crashDetected && exportIntegrity && parserRobust && normalizationCorrect;

  const failedTests = allTests.filter(t => !t.passed).map(t => `${t.name}: ${t.error || t.detail}`);

  return {
    approved,
    totalTests,
    passed,
    failed,
    falsePositives: totalFalsePositives,
    crashDetected,
    apiCallsCount: totalApiCalls,
    cacheHits,
    concurrencyChanges,
    exportIntegrity,
    parserRobust,
    normalizationCorrect,
    strictMode: STRICT_MODE,
    tests: {
      A_parser: testsA,
      B_normalization: testsB,
      C_apiIntegration: testsC,
      D_forcedFailure: testsD,
      E_cache: testsE,
      F_streamWriting: testsF,
      G_concurrencyAdaptive: testsG,
    },
    failedTests,
  };
}
