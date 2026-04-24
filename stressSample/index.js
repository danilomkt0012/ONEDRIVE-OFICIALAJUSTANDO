const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PROXY_KEYS = (process.env.PROXY_KEYS || '').split(',').filter(Boolean);
const AUTH_TOKENS = (process.env.AUTH_TOKENS || '').split(',').filter(Boolean);
const COOKIE_SEED = (process.env.COOKIE_SEED || '').split(',').filter(Boolean);

const LOG_FILE = path.join(__dirname, 'log.txt');
const TARGET_URL = 'http://127.0.0.1:3099/act';
const REACH_RATE_THRESHOLD = 900;

const pngBuf = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
  0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
  0x44, 0xAE, 0x42, 0x60, 0x82
]);

let requestCount = 0;
let retryRound = 0;
let currentTokenIdx = 0;

function jitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ts() {
  return new Date().toISOString();
}

function logToFile(msg) {
  fs.appendFileSync(LOG_FILE, msg + '\n');
}

function buildPayload() {
  const sep = Buffer.from([0x00]);
  const body = Buffer.from(JSON.stringify({ id: requestCount, alias: '{{1}}' }));
  return Buffer.concat([pngBuf, sep, body]);
}

function getProxy() {
  if (PROXY_KEYS.length === 0) return null;
  if (requestCount > 0 && requestCount % 9 === 0) {
    const idx = Math.floor(requestCount / 9) % PROXY_KEYS.length;
    return PROXY_KEYS[idx];
  }
  return null;
}

function getAuthToken() {
  return AUTH_TOKENS.length > 0 ? AUTH_TOKENS[currentTokenIdx % AUTH_TOKENS.length] : '';
}

function getCookie() {
  return COOKIE_SEED.length > 0 ? COOKIE_SEED[requestCount % COOKIE_SEED.length] : '';
}

async function sendRequest() {
  requestCount++;
  const start = Date.now();
  const proxy = getProxy();
  const token = getAuthToken();
  const cookie = getCookie();
  const payload = buildPayload();

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Authorization': `Bearer ${token}`,
    'Cookie': `seed=${cookie}`,
    'X-Request-Id': String(requestCount)
  };

  const config = {
    method: 'post',
    url: TARGET_URL,
    data: payload,
    headers,
    timeout: 5000,
    validateStatus: () => true
  };

  if (proxy) {
    config.proxy = {
      host: proxy.split(':')[0],
      port: parseInt(proxy.split(':')[1]) || 8080
    };
  }

  try {
    const res = await axios(config);
    const elapsed = Date.now() - start;

    if (res.status === 429 || res.status === 502) {
      retryRound++;
      if (retryRound % 3 === 0 && elapsed < REACH_RATE_THRESHOLD) {
        currentTokenIdx++;
      }
      const sleepMs = 500 + jitter(0, 500);
      const logLine = `${ts()} | status=${res.status} | elapsed=${elapsed}ms | sleep=${sleepMs}ms | req=#${requestCount}`;
      logToFile(logLine);
      await new Promise(r => setTimeout(r, sleepMs));
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    const logLine = `${ts()} | error=${err.code || err.message} | elapsed=${elapsed}ms | req=#${requestCount}`;
    logToFile(logLine);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/act') {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const statusPool = [200, 200, 200, 200, 429, 502];
      const code = statusPool[Math.floor(Math.random() * statusPool.length)];
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ts: ts(), status: code }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(3099, () => {
  console.log(ts());
  async function loop() {
    while (true) {
      await sendRequest();
      await new Promise(r => setTimeout(r, jitter(200, 300)));
      if (requestCount % 50 === 0) console.log(ts());
    }
  }
  loop();
});
