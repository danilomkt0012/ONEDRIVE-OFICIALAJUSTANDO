const SSRF_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'metadata.google.internal',
  '169.254.169.254',
]);

const SSRF_PRIVATE_RANGES: Array<(octets: number[]) => boolean> = [
  (o) => o[0] === 10,
  (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31,
  (o) => o[0] === 192 && o[1] === 168,
  (o) => o[0] === 127,
  (o) => o[0] === 169 && o[1] === 254,
  (o) => o[0] === 0,
  (o) => o[0] === 100 && o[1] >= 64 && o[1] <= 127,
];

export function validateNoSSRF(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`URL inválida: ${urlStr.substring(0, 80)}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Apenas URLs HTTPS são permitidas');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  if (SSRF_BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Host bloqueado por segurança: ${hostname}`);
  }

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = [
      parseInt(ipv4Match[1], 10),
      parseInt(ipv4Match[2], 10),
      parseInt(ipv4Match[3], 10),
      parseInt(ipv4Match[4], 10),
    ];
    for (const check of SSRF_PRIVATE_RANGES) {
      if (check(octets)) {
        throw new Error(`Endereço IP privado/reservado bloqueado: ${hostname}`);
      }
    }
  }

  if (!ipv4Match && !hostname.includes('.')) {
    throw new Error(`Hostname sem domínio bloqueado: ${hostname}`);
  }
}

export async function fetchAudioBuffer(
  url: string,
  maxBytes: number = 16 * 1024 * 1024
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  validateNoSSRF(url);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    redirect: 'manual',
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw new Error('Redirecionamento sem Location header');
    const absoluteLocation = new URL(location, url).toString();
    validateNoSSRF(absoluteLocation);
    return fetchAudioBuffer(absoluteLocation, maxBytes);
  }

  if (!res.ok) {
    throw new Error(`Download falhou com status ${res.status} para URL: ${url.substring(0, 80)}`);
  }

  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  if (contentLength > maxBytes) {
    throw new Error(`Arquivo muito grande: ${contentLength} bytes (máximo ${maxBytes})`);
  }

  const arrayBuf = await res.arrayBuffer();
  if (arrayBuf.byteLength > maxBytes) {
    throw new Error(`Arquivo muito grande: ${arrayBuf.byteLength} bytes (máximo ${maxBytes})`);
  }

  const buffer = Buffer.from(arrayBuf);
  const contentType = res.headers.get('content-type') || 'audio/ogg';
  const urlPath = url.split('?')[0];
  const ext = urlPath.match(/\.([^./?#]+)(?:[?#]|$)/)?.[1]?.toLowerCase() || '';
  const filename = urlPath.split('/').pop() || `audio.${ext || 'ogg'}`;

  return { buffer, mimeType: contentType.split(';')[0].trim(), filename };
}
