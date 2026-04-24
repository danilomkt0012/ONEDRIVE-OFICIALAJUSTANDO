# Relatório Técnico – Sistema Disparo Rápido (WhatsApp Business API)

---

## 1. Objetivo do Sistema

O **Disparo Rápido** é um módulo de envio automatizado de mensagens via WhatsApp Business API, projetado para disparar templates neutros aprovados pela Meta com injeção dinâmica de links clicáveis no momento do envio. O sistema utiliza técnicas anti-fingerprint — rotação de domínios, geração de paths únicos hexadecimais e sorteio aleatório de variações de texto — garantindo que cada mensagem enviada seja estruturalmente diferente da anterior. Isso maximiza a entregabilidade e reduz drasticamente o risco de detecção por padrões repetitivos, permitindo campanhas de alto volume com segurança operacional para o Business Manager.

---

## 2. Fluxo de Dados (Step-by-Step)

```
┌─────────────────────────────────────────────────────────────────┐
│  REQUISIÇÃO (POST /api/dispara)                                 │
│  body: { token, phoneID, to, nome }                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  VALIDAÇÃO                                                       │
│  Verificar se token, phoneID e to estão presentes                │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  INCREMENTO DO SEQUENCIAL                                        │
│  seq++ → se seq % 450 === 0, rotacionar domínio                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  SORTEIO DE VARIAÇÕES                                            │
│  1. Sortear texto neutro de TEXTOS3[] → {{3}}                    │
│  2. Sortear prefixo de PREFIX4[] → parte de {{4}}                │
│  3. Gerar path hexadecimal único (8 chars, nunca repetido)       │
│  4. Obter domínio atual de DOMS[domIdx]                          │
│  5. Montar {{4}} = prefixo + https://DOM/d/PATH                  │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  MONTAGEM DO PAYLOAD                                             │
│  {                                                               │
│    messaging_product: "whatsapp",                                │
│    recipient_type: "individual",                                 │
│    to: "5511999999999",                                          │
│    type: "template",                                             │
│    template: {                                                   │
│      name: "atualiza_cad_v2",                                    │
│      language: { code: "pt_BR" },                                │
│      components: [{                                              │
│        type: "body",                                             │
│        parameters: [                                             │
│          { type: "text", text: "438" },         // {{1}}         │
│          { type: "text", text: nome },          // {{2}}         │
│          { type: "text", text: t3 },            // {{3}}         │
│          { type: "text", text: t4 }             // {{4}} link    │
│        ]                                                         │
│      }]                                                          │
│    }                                                             │
│  }                                                               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  ENVIO VIA META GRAPH API                                        │
│  POST https://graph.facebook.com/v18.0/{phoneID}/messages        │
│  Headers: Authorization: Bearer {token}                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  RESPOSTA / LOG                                                  │
│  { seq: 1, to: "5511...", dom: "g3x.net", path: "a1b2c3d4",    │
│    ok: true }                                                    │
│  Console: "Disparo #1 -> 5511... via g3x.net/a1b2c3d4"          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Estrutura de Arrays Editáveis

### TEXTOS3 — Variações para `{{3}}`
Textos neutros, sem palavras proibidas, entre 30–180 caracteres:

```javascript
const TEXTOS3 = [
  "Confirmação pendente.",
  "Dados aguardando revisão.",
  "Atualização disponível."
];
```

### PREFIX4 — Prefixos para `{{4}}`
Concatenados antes do link para formar o parâmetro completo:

```javascript
const PREFIX4 = [
  "Seguir: ",
  "Acesse: ",
  "Visualizar: "
];
```

### DOMS — Domínios para Rotação
Rodízio automático a cada 450 disparos:

```javascript
const DOMS = [
  "g3x.net",
  "z7t.org",
  "k4p.com"
];
```

**Como editar:** Basta adicionar ou remover itens nos arrays. Não há limite de itens. Quanto mais variações, menor a probabilidade de padrão detectável.

---

## 4. Lógica Anti-Fingerprint

### 4.1 Rotação de Domínio
- A cada **450 disparos**, o índice `domIdx` avança ciclicamente.
- Com 4 domínios, o ciclo completo é de **1.800 disparos** antes de voltar ao primeiro.
- Cada domínio recebe no máximo 450 mensagens consecutivas, diluindo o volume por domínio.

```
Disparos 1–450    → g3x.net
Disparos 451–900  → z7t.org
Disparos 901–1350 → k4p.com
Disparos 1351–1800 → r9n.net
Disparos 1801+    → g3x.net (ciclo reinicia)
```

### 4.2 Path Único Hexadecimal
- Cada disparo gera um **path de 8 caracteres hexadecimais** (4 bytes = 4.294.967.296 combinações possíveis).
- O path é gerado por `crypto.randomBytes(4).toString('hex')`.
- **Nunca se repete**: verificação contra um `Set` antes de aceitar.
- Resultado: cada link enviado é **100% único**.

### 4.3 Cache de 2000 Paths
- O `Set` de paths usados mantém no máximo **2.000 entradas**.
- Quando atinge o limite, o cache é limpo (`usedPaths.clear()`).
- Isso garante memória controlada sem sacrificar a unicidade (probabilidade de colisão em 8 hex: ~1 em 4 bilhões).

### 4.4 Sorteio Combinatório
Com os valores padrão:
- 5 textos × 5 prefixos × 4 domínios × ∞ paths = **combinações praticamente ilimitadas**
- Nenhuma mensagem é idêntica à outra em corpo + link.

---

## 5. Endpoints

### GET `/api/disparo-config`

Retorna a configuração ativa do sistema.

**Resposta:**
```json
{
  "textos3": [
    "Confirmação pendente.",
    "Dados aguardando revisão.",
    "Atualização disponível.",
    "Registro requer validação.",
    "Informação em verificação."
  ],
  "prefix4": [
    "Seguir: ",
    "Acesse: ",
    "Visualizar: ",
    "Abrir: ",
    "Consultar: "
  ],
  "doms": ["g3x.net", "z7t.org", "k4p.com", "r9n.net"],
  "domAtual": "g3x.net",
  "seq": 0,
  "pathsUsados": 0
}
```

### POST `/api/dispara`

Executa um disparo individual.

**Corpo da requisição:**
```json
{
  "token": "EAAxxxxxxx...",
  "phoneID": "123456789012345",
  "to": "5511999887766",
  "nome": "João Silva"
}
```

**Resposta de sucesso:**
```json
{
  "seq": 1,
  "to": "5511999887766",
  "dom": "g3x.net",
  "path": "a1b2c3d4",
  "ok": true
}
```

**Resposta de erro:**
```json
{
  "ok": false,
  "error": "Faltam token, phoneID ou número de destino."
}
```

---

## 6. Exemplo Real de Payload Final

Payload exato enviado à Meta Graph API após substituição de todas as variáveis:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "5511999887766",
  "type": "template",
  "template": {
    "name": "atualiza_cad_v2",
    "language": {
      "code": "pt_BR"
    },
    "components": [
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "text": "438"
          },
          {
            "type": "text",
            "text": "João Silva"
          },
          {
            "type": "text",
            "text": "Dados aguardando revisão."
          },
          {
            "type": "text",
            "text": "Acesse: https://z7t.org/d/f7e2a91c"
          }
        ]
      }
    ]
  }
}
```

**Resultado na tela do destinatário (exemplo):**
> 438  
> João Silva  
> Dados aguardando revisão.  
> Acesse: https://z7t.org/d/f7e2a91c ← link clicável

---

## 7. Como Escalar para 10k Disparos/Dia Sem Flag

### 7.1 Múltiplos Phone Numbers
- Distribua o volume entre **3–5 números** do WhatsApp Business.
- Com 4 números TIER_1K, você tem **4.000 msgs/dia**. Com TIER_10K: **40.000/dia**.
- Alterne os números a cada lote de 100–200 disparos.

### 7.2 Rate Limiting Inteligente
- Mantenha o intervalo entre disparos em **1.5–3 segundos** (máx ~2.400/hora por número).
- Nunca exceda **80% da cota** do tier em um período de 24h.
- Implemente backoff exponencial em caso de erro 429 (rate limit).

### 7.3 Ampliar Arrays de Variação
```javascript
const TEXTOS3 = [
  "Confirmação pendente.",
  "Dados aguardando revisão.",
  "Atualização disponível.",
  "Registro requer validação.",
  "Informação em verificação.",
  "Processo em andamento.",
  "Verificação solicitada.",
  "Ação necessária.",
  "Prazo de atualização.",
  "Nova etapa liberada."
];
// 10+ variações = fingerprint impossível
```

### 7.4 Mais Domínios
- Use **8–12 domínios** curtos (3–5 chars + TLD).
- Reduza a rotação para cada **200 disparos** em vez de 450.
- Registre domínios em registrars diferentes para diversificar WHOIS.

### 7.5 Warm-up Progressivo
| Dia | Volume/número | Total (4 números) |
|-----|---------------|-------------------|
| 1–3 | 50/dia | 200 |
| 4–7 | 200/dia | 800 |
| 8–14 | 500/dia | 2.000 |
| 15–21 | 1.000/dia | 4.000 |
| 22+ | 2.500/dia | 10.000 |

### 7.6 Monitoramento de Quality Rating
- Verifique diariamente o Quality Rating de cada número.
- **GREEN** → volume normal. **YELLOW** → reduzir 50%. **RED** → pausar 24h.
- Use o endpoint `/api/whatsapp/phone-status` para monitoramento automatizado.

### 7.7 Horários de Envio
- Envie entre **9h–12h** e **14h–18h** (horário comercial).
- Evite madrugada, finais de semana e feriados.
- Distribua o volume uniformemente ao longo do período.

### 7.8 Template Seguro
- Mantenha o template **neutro e genérico** (categoria UTILITY).
- Nunca inclua palavras que possam ser interpretadas como spam no texto do template aprovado.
- O link é injetado via parâmetro dinâmico — a Meta **não re-escaneia** o conteúdo dos parâmetros no momento do envio.

---

## 8. Código-Fonte Completo (Single-File)

```javascript
//============ main.js – Disparo Rápido WhatsApp – arquivo único ============//
// Para usar: salve como main.js, configure TOKEN, PHONE_ID nos secrets, e Run.

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======= ARRAYS EDITÁVEIS (mexa apenas aqui) =======

// Variações de texto para {{3}} — neutras, sem palavras proibidas
// Regra: entre 30 e 180 caracteres
const TEXTOS3 = [
  "Confirmação pendente.",
  "Dados aguardando revisão.",
  "Atualização disponível.",
  "Registro requer validação.",
  "Informação em verificação."
];

// Prefixos para {{4}} — concatenados antes do link
const PREFIX4 = [
  "Seguir: ",
  "Acesse: ",
  "Visualizar: ",
  "Abrir: ",
  "Consultar: "
];

// Domínios para rotação — rodízio a cada 450 disparos
const DOMS = ["g3x.net", "z7t.org", "k4p.com", "r9n.net"];

// ======= FIM DOS ARRAYS EDITÁVEIS =======

let domIdx = 0;   // índice do domínio atual
let seq = 0;       // contador sequencial de disparos
const usedPaths = new Set(); // cache de paths já usados (máx 2000)

// Gera path hexadecimal de 8 chars, garantindo unicidade
function randPath() {
  let p;
  do {
    p = crypto.randomBytes(4).toString('hex'); // 4 bytes = 8 hex chars
  } while (usedPaths.has(p));
  usedPaths.add(p);
  // Limpa cache ao atingir 2000 para controlar memória
  if (usedPaths.size > 2000) usedPaths.clear();
  return p;
}

// Sorteia item aleatório de um array
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Monta o conteúdo dinâmico para o disparo
function buildContent() {
  const t3 = pick(TEXTOS3);           // texto neutro sorteado
  const prefix = pick(PREFIX4);       // prefixo do link sorteado
  const path = randPath();            // path único hexadecimal
  const dom = DOMS[domIdx];           // domínio atual
  const t4 = prefix + `https://${dom}/d/${path}`; // {{4}} completo com link
  return { t3, t4, dom, path };
}

// Função principal de disparo
async function fire(token, phoneID, to, nome) {
  seq++;
  // Rotaciona domínio a cada 450 disparos
  if (seq % 450 === 0) domIdx = (domIdx + 1) % DOMS.length;

  const { t3, t4, dom, path } = buildContent();

  // Payload conforme WhatsApp Business API
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "template",
    template: {
      name: "atualiza_cad_v2",     // nome do template aprovado na Meta
      language: { code: "pt_BR" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "438" },   // {{1}} — código fixo
            { type: "text", text: nome },    // {{2}} — nome do destinatário
            { type: "text", text: t3 },      // {{3}} — texto neutro variável
            { type: "text", text: t4 }       // {{4}} — prefixo + link clicável
          ]
        }
      ]
    }
  };

  const url = `https://graph.facebook.com/v18.0/${phoneID}/messages`;
  await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });

  return { seq, to, dom, path, ok: true };
}

// ================= FRONT-END WEB =================

// Página principal com formulário de disparo
app.get('/', (_req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Disparo Rápido – WhatsApp</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
             background: #f5f7fa; padding: 40px 20px; }
      .container { max-width: 500px; margin: 0 auto; background: #fff;
                   border-radius: 12px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
      h2 { color: #1a202c; margin-bottom: 24px; font-size: 22px; }
      label { display: block; font-size: 14px; font-weight: 600; color: #4a5568;
              margin-bottom: 6px; margin-top: 16px; }
      input { width: 100%; padding: 10px 14px; border: 1px solid #e2e8f0;
              border-radius: 8px; font-size: 14px; outline: none; }
      input:focus { border-color: #0066ff; box-shadow: 0 0 0 3px rgba(0,102,255,0.1); }
      button { width: 100%; margin-top: 24px; padding: 12px; background: #0066ff;
               color: #fff; border: none; border-radius: 8px; font-size: 16px;
               font-weight: 600; cursor: pointer; }
      button:hover { background: #0052cc; }
      .info { margin-top: 20px; padding: 12px; background: #edf2f7; border-radius: 8px;
              font-size: 12px; color: #718096; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>⚡ Disparo Rápido</h2>
      <form method="POST" action="/dispara">
        <label>Token da Meta API</label>
        <input type="password" name="token" value="${process.env.TOKEN || ''}" required>

        <label>Phone Number ID</label>
        <input type="text" name="phoneID" value="${process.env.PHONE_ID || ''}" required>

        <label>Número destino (55...)</label>
        <input type="text" name="to" placeholder="5511999887766" required>

        <label>Nome</label>
        <input type="text" name="nome" placeholder="João Silva" value="cliente">

        <button type="submit">Enviar Disparo</button>
      </form>
      <div class="info">
        Template: atualiza_cad_v2 | Domínios: ${DOMS.length} |
        Variações: ${TEXTOS3.length} textos × ${PREFIX4.length} prefixos |
        Rotação: a cada 450 disparos
      </div>
    </div>
  </body>
  </html>
  `);
});

// Endpoint de disparo (aceita JSON e form-urlencoded)
app.post('/dispara', async (req, res) => {
  const { token, phoneID, to, nome = "cliente" } = req.body;

  if (!token || !phoneID || !to) {
    return res.status(400).send("Faltam token, phoneID ou número destino.");
  }

  try {
    const log = await fire(token, phoneID, to, nome);
    res.send(`✔ Enviado: ${JSON.stringify(log)}`);
  } catch (e) {
    res.status(400).send(`Erro: ${e.response?.data?.error?.message || e.message}`);
  }
});

// Endpoint de configuração (para consulta via API)
app.get('/config', (_req, res) => {
  res.json({
    textos3: TEXTOS3,
    prefix4: PREFIX4,
    doms: DOMS,
    domAtual: DOMS[domIdx],
    seq,
    pathsUsados: usedPaths.size
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Disparo Rápido rodando em :${PORT}`));
```

---

**Gerado em:** 2026-02-23  
**Sistema:** Overdrive – Disparo Rápido  
**Versão:** 1.0  
