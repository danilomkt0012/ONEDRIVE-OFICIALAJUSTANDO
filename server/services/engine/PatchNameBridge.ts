/**
 * PatchNameBridge — REMOVIDO
 * 
 * O sistema de rotação de nomes (Patch-Name) foi removido porque a Meta
 * passou a agregar rate limits por número + BM, não mais por sender label.
 * 
 * Agora o sistema usa skip-label (sender_label: null), que é o comportamento
 * padrão da API — sem truques, sem risco de flag.
 * 
 * As funções abaixo são stubs para manter compatibilidade com código
 * que ainda referencia este módulo durante a transição.
 */

export async function ensureNameRotation(_phoneId: string, _token: string, _version: string = 'v25.0'): Promise<boolean> {
  return true;
}

export function incSent(_phoneId: string): void {
}

export function getSentCount(_phoneId: string): number {
  return 0;
}

export async function preflightPatch(_phoneIds: string[], _token: string, _version: string = 'v25.0'): Promise<Record<string, boolean>> {
  return {};
}
