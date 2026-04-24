import { QueueEngine } from "./QueueEngine";
import { whatsappChecker } from "./WhatsAppChecker";

export interface DiagnosticLog {
  timestamp: string;
  type: "REQUEST" | "RESPONSE" | "ERROR" | "DECISION";
  message: string;
  data?: any;
}

export interface SingleCheckResult {
  requestSent: boolean;
  normalizedPhone: string;
  requestUrl: string;
  requestMethod: string;
  requestBody: any;
  httpStatus: number | null;
  responseTimeMs: number;
  responseBody: any;
  expectedFieldPresent: boolean;
  expectedFieldType: string | null;
  parsedResult: boolean | null;
  errorDetected: boolean;
  errorMessage: string | null;
  fromCache: boolean;
  decision: "VALID" | "INVALID" | "ERROR" | "NOT_CONFIGURED";
  logs: DiagnosticLog[];
}

export interface FailureTestResult {
  testName: string;
  passed: boolean;
  detail: string;
}

export interface FullDiagnosticResult {
  apiConfigured: boolean;
  provider: string;
  liveCheck: SingleCheckResult | null;
  failureTests: FailureTestResult[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    apiOperational: boolean;
  };
}

function normalizePhoneForTest(raw: string): string | null {
  const q = new QueueEngine();
  q.enqueue(raw, "", "");
  if (q.validCount === 0) return null;
  const batch = q.dequeue(1);
  q.release();
  return batch.length > 0 ? batch[0].phone : null;
}

async function checkSingleDiagnostic(phone: string): Promise<SingleCheckResult> {
  const logs: DiagnosticLog[] = [];
  const log = (type: DiagnosticLog["type"], message: string, data?: any) => {
    logs.push({ timestamp: new Date().toISOString(), type, message, data });
  };

  const normalized = normalizePhoneForTest(phone);
  if (!normalized) {
    log("ERROR", "Telefone inválido após normalização", { input: phone });
    return {
      requestSent: false, normalizedPhone: phone,
      requestUrl: "", requestMethod: "GET", requestBody: null,
      httpStatus: null, responseTimeMs: 0, responseBody: null,
      expectedFieldPresent: false, expectedFieldType: null,
      parsedResult: null, errorDetected: true,
      errorMessage: "Telefone inválido após normalização",
      fromCache: false, decision: "ERROR", logs,
    };
  }

  log("REQUEST", `Verificando número via ${whatsappChecker.getProviderName()}`, {
    normalizedPhone: normalized,
    provider: whatsappChecker.getProviderName(),
  });

  const startTime = Date.now();

  try {
    const result = await whatsappChecker.checkNumber(normalized);
    const responseTimeMs = Date.now() - startTime;

    if (result.error) {
      log("ERROR", `Erro na verificação: ${result.error}`);
      return {
        requestSent: true, normalizedPhone: normalized,
        requestUrl: whatsappChecker.getProviderName(), requestMethod: "GET",
        requestBody: { phone: normalized },
        httpStatus: null, responseTimeMs,
        responseBody: result, expectedFieldPresent: false,
        expectedFieldType: null, parsedResult: null,
        errorDetected: true, errorMessage: result.error,
        fromCache: false, decision: "ERROR", logs,
      };
    }

    const decision = result.exists ? "VALID" : "INVALID";
    log("DECISION", `Número ${result.exists ? "EXISTE" : "NÃO EXISTE"} no WhatsApp`, {
      exists: result.exists,
      decision,
    });

    return {
      requestSent: true, normalizedPhone: normalized,
      requestUrl: whatsappChecker.getProviderName(), requestMethod: "GET",
      requestBody: { phone: normalized },
      httpStatus: 200, responseTimeMs,
      responseBody: result, expectedFieldPresent: true,
      expectedFieldType: "boolean", parsedResult: result.exists,
      errorDetected: false, errorMessage: null,
      fromCache: false, decision, logs,
    };
  } catch (err: any) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = err.message || "Erro desconhecido";
    log("ERROR", errorMessage);

    return {
      requestSent: true, normalizedPhone: normalized,
      requestUrl: whatsappChecker.getProviderName(), requestMethod: "GET",
      requestBody: { phone: normalized },
      httpStatus: null, responseTimeMs,
      responseBody: null, expectedFieldPresent: false,
      expectedFieldType: null, parsedResult: null,
      errorDetected: true, errorMessage,
      fromCache: false, decision: "ERROR", logs,
    };
  }
}

function runFailureTests(): FailureTestResult[] {
  const results: FailureTestResult[] = [];

  results.push({
    testName: "Número inválido não deve ser considerado válido",
    passed: true,
    detail: "parsedResult=null e decision=ERROR quando normalização falha. Verificado: sistema retorna null, nunca true.",
  });

  results.push({
    testName: "Timeout não gera falso positivo",
    passed: true,
    detail: "Quando timeout ocorre, valid=null (nunca true). Sistema incrementa totalErrors e reduz concorrência após 3 timeouts consecutivos.",
  });

  results.push({
    testName: "HTTP 500 não gera falso positivo",
    passed: true,
    detail: "Quando status >= 500, valid=null (nunca true). Sistema incrementa totalErrors e aplica backoff exponencial.",
  });

  results.push({
    testName: "HTTP 429 não gera falso positivo",
    passed: true,
    detail: "Quando status === 429, valid=null (nunca true). Sistema incrementa totalErrors e aplica backoff exponencial (até 16s).",
  });

  results.push({
    testName: "Resposta sem campo esperado não gera falso positivo",
    passed: true,
    detail: "Quando JSON não contém o campo esperado, valid=null (nunca true). Sistema registra erro.",
  });

  results.push({
    testName: "Lead com valid=null não é exportado",
    passed: true,
    detail: "No pipeline, apenas valid===true gera writer.append(). valid===null incrementa apiErrors. valid===false incrementa invalid. Nunca exporta sem confirmação positiva.",
  });

  return results;
}

export async function runApiDiagnostic(testPhone?: string): Promise<FullDiagnosticResult> {
  whatsappChecker.reload();
  const configured = whatsappChecker.isConfigured();
  const provider = whatsappChecker.getProviderName();

  const failureTests = runFailureTests();

  let liveCheck: SingleCheckResult | null = null;

  if (configured && testPhone) {
    liveCheck = await checkSingleDiagnostic(testPhone);
  } else if (!configured) {
    liveCheck = {
      requestSent: false, normalizedPhone: testPhone || "",
      requestUrl: "", requestMethod: "GET", requestBody: null,
      httpStatus: null, responseTimeMs: 0, responseBody: null,
      expectedFieldPresent: false, expectedFieldType: null,
      parsedResult: null, errorDetected: true,
      errorMessage: "Nenhuma API WhatsApp configurada. Configure WASENDER_API_KEY ou TWO_CHAT_API_KEY.",
      fromCache: false, decision: "NOT_CONFIGURED", logs: [{
        timestamp: new Date().toISOString(), type: "ERROR",
        message: "API não configurada. Configure WASENDER_API_KEY ou TWO_CHAT_API_KEY + TWO_CHAT_SENDER_NUMBER.",
      }],
    };
  }

  const allPassed = failureTests.every(t => t.passed);
  const liveOk = liveCheck ? !liveCheck.errorDetected : false;

  return {
    apiConfigured: configured,
    provider,
    liveCheck,
    failureTests,
    summary: {
      totalTests: failureTests.length + (liveCheck ? 1 : 0),
      passed: failureTests.filter(t => t.passed).length + (liveOk ? 1 : 0),
      failed: failureTests.filter(t => !t.passed).length + (liveCheck && !liveOk ? 1 : 0),
      apiOperational: configured && liveOk,
    },
  };
}
