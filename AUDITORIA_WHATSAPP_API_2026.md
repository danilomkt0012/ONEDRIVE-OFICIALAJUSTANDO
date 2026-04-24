# AUDITORIA COMPLETA — OVERDRIVE V3
## Análise de Conformidade com Meta WhatsApp Business API (Cloud API 2026)

**Data:** 01 de Abril de 2026
**Versão do Sistema:** Overdrive V3 (UltraStableEngine)
**API Meta:** Graph API v25.0 (Cloud API)

---

# STEP 1 — PESQUISA E CONTEXTO META 2025–2026

## Arquitetura Atual da Meta (Cloud API 2026)

### Hierarquia Oficial
```
Business Portfolio (antigo BM)
  └── WABA (WhatsApp Business Account)
       └── Phone Number (registrado via Cloud API)
            └── Messages (enviadas via Cloud API)
```

### Mudanças Críticas 2025–2026

1. **Cloud API como padrão único** — On-Premise API totalmente descontinuada. Toda comunicação passa pelos servidores da Meta.

2. **Limites baseados em Business Portfolio** — Desde outubro 2025, os limites de mensagens são calculados a nível de Business Portfolio, NÃO por número individual. Todos os números do mesmo Portfolio compartilham o limite.

3. **Tiers Oficiais Atuais:**
   - `TIER_250`: 250 msgs/24h (contas novas/não verificadas)
   - `TIER_1K`: 1.000 msgs/24h
   - `TIER_10K`: 10.000 msgs/24h
   - `TIER_100K`: 100.000 msgs/24h
   - `TIER_UNLIMITED`: Sem limite prático

4. **Throughput padrão:** 80 msg/s por número (até 1.000 msg/s no Unlimited)

5. **Sistema de Pacing da Meta:**
   - Meta aplica pacing interno na fila de entrega
   - Mensagens são aceitas (HTTP 200) mas entram em fila interna
   - Entrega real pode ser mais lenta que a aceitação
   - Erro 130429 = template pacing (backoff obrigatório)

6. **Quality Rating System:**
   - GREEN / YELLOW / RED por número
   - Baseado em: taxa de bloqueio, denúncias, opt-outs
   - YELLOW = warning, pode regredir tier
   - RED = pausa automática pela Meta, possível downgrade

7. **Modelo de Preço por Conversa:**
   - Utility, Marketing, Authentication, Service
   - Marketing tem custo mais alto e controle mais rigoroso
   - Utility tem entrega prioritária

8. **Anti-Spam Detection (Real-World):**
   - Análise de conteúdo (links repetidos, padrões)
   - Volume repentino de envios (spikes)
   - Alta taxa de "não entregue" / bloqueios
   - Múltiplos números no mesmo BM com padrões similares
   - Templates rejeitados repetidamente
   - Baixa taxa de resposta / engajamento

---

# STEP 2 — COMPREENSÃO TÉCNICA DA ARQUITETURA

## Fluxo Real de uma Mensagem

```
Backend Overdrive
    ↓ POST /v25.0/{phoneNumberId}/messages
Meta Cloud API (aceita ou rejeita HTTP)
    ↓ HTTP 200 = aceito na fila (NÃO = entregue)
Meta Internal Queue
    ↓ Risk Analysis (quality, spam, rate)
Meta Pacing Engine
    ↓ Controle de velocidade de entrega
Delivery to WhatsApp Client
    ↓ 
Webhook callback (sent → delivered → read → failed)
```

### Pontos de Controle da Meta

| Ponto | O que a Meta faz |
|-------|-----------------|
| **Aceitação** | Valida token, template, formato, tier |
| **Fila Interna** | Aplica pacing baseado em volume e qualidade |
| **Risk Analysis** | Detecta spam patterns, verifica quality rating |
| **Throttling** | Erro 135000/131048 quando excede capacidade |
| **Pacing** | Erro 130429 quando template está sendo paceado |
| **Quality** | Degrada tier se quality cai para RED |

---

# STEP 3 — ANÁLISE COMPLETA DO SISTEMA

## ✅ INTEGRAÇÃO COM API — NOTA: 8.0/10

### Pontos Fortes
- **Endpoints corretos:** Uso adequado de `POST /{phoneNumberId}/messages` para envio
- **Graph API v25.0:** Versão atualizada e correta
- **Bearer Token auth:** Implementação correta com interceptor axios
- **Error detection para OAuth (190):** Detecção específica de token expirado
- **Format E.164:** Normalização automática de números
- **Suporte multi-tipo:** Templates, texto livre, áudio, imagem, botões, listas

### Pontos de Atenção
- **Timeout de 20s no axios:** Pode ser curto para momentos de alta carga da Meta. Recomendado: 30s para envios, 10s para leituras.
- **Sem rate limiting a nível de HTTP client:** O rate limiting é feito no engine, mas o axios client em si não tem proteção contra burst de requests.

### Bugs/Riscos Identificados
1. **Token refresh ausente:** O sistema não implementa refresh automático de tokens de longa duração. Se o token expira durante uma campanha, ela falha.
2. **Sem validação de `messaging_product`:** O campo `messaging_product: 'whatsapp'` está hardcoded (correto), mas não há validação de resposta.
3. **Endpoint `/api/webhook-logs` sem scoping:** Retorna webhooks globais sem filtro por tenant/WABA, expondo dados de contas diferentes a qualquer usuário autenticado. **Risco de segurança significativo em ambiente multi-tenant.**

---

## ✅ FLUXO DE MENSAGENS — NOTA: 9/10

### Pontos Fortes
- **Queue system robusto:** RetryQueue com backoff exponencial (3s, 6s, 12s)
- **RequestPipeline:** Controle de concorrência (max 3 em V3)
- **TokenBucket:** Rate limiter baseado em token bucket com burst controlado
- **Checkpointing:** Estado salvo a cada 5 mensagens para resiliência
- **PreflightValidator:** Validação antes do envio (E.164, parâmetros do template)
- **Pacing não é burst:** Sistema usa micro-batches com pausas naturais

### Pontos de Atenção
- **Retry apenas 3 tentativas:** Para erros transientes (5xx, timeout), 3 retries pode ser insuficiente em momentos de instabilidade prolongada da Meta
- **Backoff fixo (3s, 6s, 12s):** Considerar backoff mais agressivo para 429 (30s, 60s, 120s)

---

## ✅ WEBHOOK HANDLING — NOTA: 9/10

### Pontos Fortes
- **Signature validation completa:** HMAC-SHA256 com `crypto.timingSafeEqual` (timing-attack safe)
- **Multi-secret support:** Suporta múltiplos WABA secrets
- **Persistent queue:** Webhooks salvos em `waba_hooks` antes de processar
- **Background worker:** Safety net para webhooks não processados
- **Status tracking completo:** sent → delivered → read → failed
- **Deduplicação:** Incremento atômico de contadores com transição de status
- **SSE real-time:** Feedback em tempo real para o dashboard
- **Opt-out automático:** Detecção por error codes (132001, 132015, 133010)

### Pontos de Atenção
- **Webhook replay:** O worker de background é uma boa safety net, mas não há dead-letter queue para webhooks que falham repetidamente
- **Falta error code 131047:** O código 131047 (CSW expired) deveria ser tratado no OptOutService como "não contatar novamente até próximo opt-in"

---

## ✅ ESCALABILIDADE — NOTA: 7.0/10

### Pontos Fortes
- **Multi-WABA:** Suporte completo a múltiplas contas
- **SenderPool com failover:** Rotação automática de números, detecção de número "morto"
- **TierDetection existe:** Código de detecção de tier via API presente e correto
- **MultiPhoneOrchestrator:** Distribuição inteligente (adaptive, round_robin, weighted)
- **PostgreSQL:** Migração completa de MemStorage para DB persistente

### PROBLEMA CRÍTICO — TierDetection Desabilitada
- **`enableAutoTierDetection: false`** no `UltraStableCampaignSender`: A detecção automática de tier está **desabilitada** no caminho principal de envio. O código existe mas não é utilizado.
- **`isNearDailyLimit()` retorna sempre `false`**: O método que deveria verificar se o limite diário está próximo é um stub — nunca bloqueia envios.
- **`getRemainingMessages()` retorna `Infinity`**: O método que deveria calcular mensagens restantes não funciona — retorna infinito sempre.
- **Impacto:** O sistema **não respeita os limites de tier da Meta** automaticamente. Isso é o maior gap de compliance do sistema.

### Pontos de Atenção Adicionais
- **Limite de portfolio compartilhado:** O sistema trata limites POR NÚMERO, mas desde 2025 o limite é POR BUSINESS PORTFOLIO. Se múltiplos números do mesmo portfolio enviam simultaneamente, o limite total pode ser atingido mais rápido do que o calculado.
- **Sem clustering:** O sistema roda em processo único Node.js. Para campanhas massivas (100K+), pode haver gargalo de CPU/memória.
- **Cache de tier em memória:** Se o processo reinicia, os caches de tier/status são perdidos.

---

## ✅ PROTEÇÃO ANTI-BLOQUEIO — NOTA: 9.5/10

### Pontos Fortes (Excelente implementação)
- **HumanBehavior module:** Delays Gaussianos (não fixos), long pauses, cycle pauses, typing simulation
- **StealthScheduler:** Jitter, variação de batch, micro-delays, shuffle geográfico por DDD
- **RiskEngine:** Score 0-100 com ações graduais (REDUCE_20, REDUCE_50, COOLDOWN, PAUSE)
- **CircuitBreaker preventivo:** Monitora latência P95/P99, trips ANTES de erros reais
- **SafeMode:** Ativação automática com error rate > 0.5%
- **FailSafeMode:** Modo de sobrevivência para crises
- **Ramp-up gradual:** Para números novos, começa com batch pequeno e escala
- **Business hours gating:** Opção de enviar apenas em horário comercial
- **Opt-out automático:** Blacklist persistente com cache em memória
- **TemplatePacingBackoff:** Backoff específico por template/phone para erro 130429
- **BMQualityMonitor:** Polling de quality_score da Meta com alertas

### Este é o módulo mais forte do sistema. A combinação de HumanBehavior + CircuitBreaker + RiskEngine + StealthScheduler é excepcional.

---

## ✅ USO DE TEMPLATES — NOTA: 8.5/10

### Pontos Fortes
- **Rotação ponderada:** Template selection por peso probabilístico (não round-robin fixo)
- **Categorização:** Templates classificados como engagement/conversion/general
- **BaseType strategy:** Diferentes prioridades para cold/warm/hot
- **Variação de conteúdo:** Suporte a parâmetros dinâmicos por lead

### Pontos de Atenção
- **Sem variação de corpo:** Se todos os leads recebem o mesmo template com os mesmos parâmetros estáticos, a Meta pode detectar padrão repetitivo
- **Sem A/B testing nativo:** Falta mecanismo para testar performance de templates antes de envio massivo

---

## ✅ JANELA DE 24H (CSW) — NOTA: 9/10

### Pontos Fortes
- **CSWTracker dedicado:** Gerenciamento explícito da janela de 24h
- **Validação antes de envio:** Bot verifica `isCSWOpen()` antes de enviar free-form
- **Timeout job:** Monitora conversas inativas e executa ações automáticas
- **Expiração hardcoded:** 24h (correto com a política Meta)

### Pontos de Atenção
- **CSW check em respostas manuais:** O sistema corretamente bloqueia respostas manuais (texto, imagem, áudio) quando a janela CSW está expirada nas rotas `/api/conversations/:id/reply`, `send-image` e `send-audio`. Implementação adequada.

---

# STEP 4 — DETECÇÃO DE RISCOS (CRÍTICO)

## 🔴 RISCOS CRÍTICOS

### R0: TierDetection Desabilitada + Stubs Não-Funcionais
**Severidade: CRÍTICA**
A detecção automática de tier está **desabilitada** (`enableAutoTierDetection: false` em `UltraStableCampaignSender`). Além disso, os métodos `isNearDailyLimit()` e `getRemainingMessages()` são stubs que retornam `false` e `Infinity` respectivamente — nunca bloqueiam envios.

**Impacto:** O sistema NÃO respeita os limites de tier da Meta automaticamente. Um número em TIER_250 pode receber tentativas de envio de 10K mensagens, resultando em erros 135000 massivos e possível degradação de quality rating.
**Solução:** Habilitar `enableAutoTierDetection: true` e implementar lógica real para `isNearDailyLimit()` e `getRemainingMessages()` baseado nos contadores diários reais.

### R0.5: Endpoint `/api/webhook-logs` sem Controle de Acesso
**Severidade: ALTA (Segurança)**
O endpoint retorna logs de webhook de TODAS as WABAs globalmente, sem filtro por tenant ou WABA. Qualquer usuário autenticado pode ver dados de mensagens e contatos de outras contas.

**Impacto:** Exposição de dados pessoais (números de telefone, status de mensagem) entre tenants.
**Solução:** Filtrar webhook-logs por WABA do usuário autenticado ou restringir a admin-only.

## 🔴 RISCOS ALTOS

### R1: Limite de Portfolio vs Limite por Número
**Severidade: ALTA**
O sistema calcula limites por número individual, mas desde outubro 2025, a Meta calcula limites por Business Portfolio. Se 5 números do mesmo portfolio enviam 1K cada, o portfolio pode atingir seu limite de 10K antes do esperado.

**Impacto:** Throttling inesperado, possível degradação de quality rating.
**Solução:** Implementar um "PortfolioQuotaManager" que agrege o consumo de todos os números de um mesmo BM/Portfolio.

### R2: Ausência de Refresh de Token
**Severidade: ALTA**
Tokens de acesso da Meta expiram. Não há mecanismo automático de refresh. Uma campanha de longa duração pode falhar no meio.

**Impacto:** Campanha interrompida, perda de leads processados.
**Solução:** Implementar token refresh usando System User tokens (que não expiram) ou implementar refresh automático via Graph API.

### R3: Cold Base Daily Limit (500/número)
**Severidade: MÉDIA-ALTA**
O default `coldBaseDailyLimitPerNumber: 500` é razoável, mas se o número está em TIER_250, enviar 500 em um dia pode triggerar YELLOW quality.

**Impacto:** Degradação de quality rating, possível downgrade de tier.
**Solução:** O daily limit para cold base deve respeitar o tier atual do número. TIER_250 = max 200 cold/dia. TIER_1K = max 500 cold/dia.

## 🟡 RISCOS MÉDIOS

### R4: Retries com Backoff Curto para Rate Limit
**Severidade: MÉDIA**
O retry backoff para erro 429 começa em 15s e escala até 30s (com multiplicador exponencial). Embora não seja fixo, os valores máximos ainda ficam abaixo do recomendado pela Meta (30-60s mínimo). Recomendado: aumentar para 30s → 60s → 120s.

### R5: Sem Controle de Conteúdo Duplicado
**Severidade: MÉDIA**
Se um template tem apenas parâmetros estáticos (sem nome, sem dado dinâmico), todas as mensagens são idênticas. Meta pode classificar como spam pattern.

### R6: Warm-up Schedule Pode Ser Muito Agressivo
**Severidade: MÉDIA**
O sistema de aquecimento existe, mas os defaults não são claros. Um ramp-up muito rápido em número novo pode triggar quality warning.

## 🟢 RISCOS BAIXOS

### R7: Cache de Opt-Out em Memória
Se o processo reinicia, o cache é recarregado do DB (lazy load). Há um pequeno window onde mensagens podem ser enviadas para números opted-out durante o reload.

### R8: Webhook Processing Order
Webhooks podem chegar fora de ordem (delivered antes de sent). O sistema trata isso com deduplicação, mas não valida a ordem de transição de status.

---

# STEP 5 — PLANO DE OTIMIZAÇÃO

## 🔹 Motor de Mensagens

### 5.1 Portfolio-Level Quota Manager
```
Criar: server/services/engine/PortfolioQuotaManager.ts
- Agregar consumo diário de todos os números do mesmo BM
- Calcular quota restante a nível de portfolio
- Injetar no SenderPool para respeitar limite global
```

### 5.2 Retry Backoff Melhorado
```
429 → 30s, 60s, 120s (ao invés de 15s fixo)
5xx → 5s, 15s, 30s
130429 (pacing) → 60s, 120s, 300s
Adicionar jitter de ±20% em cada delay
```

### 5.3 Token Lifecycle Management
```
- Usar System User tokens (permanentes) quando possível
- Implementar health check de token a cada 1h
- Alertar proativamente se token está próximo de expirar
```

## 🔹 Estratégia de Envio Inteligente

### 5.4 Progressive Volume Increase (Aprimorado)
```
Dia 1: 50 msgs → Dia 2: 100 → Dia 3: 200 → Dia 4: 500 → Dia 5: 1000
Monitorar quality rating entre cada dia
Se quality cai para YELLOW → resetar para 50% do dia anterior
```

### 5.5 Segmentação Inteligente
```
- Enviar primeiro para leads "warm" (já interagiram)
- Depois leads "recent" (cadastrados recentemente)
- Por último leads "cold" (sem interação prévia)
- Monitorar engagement por segmento
```

### 5.6 Content Variation Engine
```
- Rotacionar variações de texto dentro dos parâmetros do template
- Variar links (domínios diferentes, UTMs)
- Personalizar saudações baseado em horário/região
```

## 🔹 Otimização de Qualidade

### 5.7 Engagement Score por Lead
```
- Rastrear: abriu (read) vs não abriu, respondeu vs não respondeu
- Criar score de engajamento por lead
- Priorizar envio para leads com alto engagement
- Remover automaticamente leads com 3+ envios sem read
```

### 5.8 Template Performance Dashboard
```
- Métricas por template: delivery rate, read rate, reply rate, block rate
- Auto-desativar templates com block rate > 2%
- Sugerir variações de templates com baixo engagement
```

## 🔹 Maximização de Entrega

### 5.9 Alinhamento com Pacing da Meta
```
- Monitorar gap entre "accepted" e "delivered" via webhooks
- Se gap > 30%, reduzir velocidade de envio em 40%
- Objetivo: manter accepted ≈ delivered (sem acumular na fila da Meta)
```

### 5.10 Smart Scheduling
```
- Analisar horários de pico de read rate por DDD/região
- Agendar envios nos horários de maior engajamento
- Evitar envios entre 22h-7h (baixo read rate, alto block rate)
```

---

# STEP 6 — VEREDITO FINAL

## 📊 Pontuação do Sistema

| Componente | Nota | Comentário |
|-----------|------|-----------|
| Integração API | 8.0/10 | Sólida, falta token refresh e scoping de webhook-logs |
| Fluxo de Mensagens | 9.0/10 | Pipeline robusto com checkpoint |
| Webhook Handling | 9.0/10 | Completo com signature validation |
| Escalabilidade | 7.0/10 | TierDetection desabilitada, stubs não-funcionais |
| Anti-Bloqueio | 9.5/10 | **Excelente** — melhor componente do sistema |
| Templates | 8.5/10 | Rotação ponderada, falta variação de conteúdo |
| Janela 24h (CSW) | 9.0/10 | Bem implementado, bloqueio de CSW em respostas manuais correto |
| Opt-Out | 8.5/10 | Funcional, falta alguns error codes |
| Bot/Automação | 8.5/10 | Completo com flow visual |
| Dashboard/Observability | 8.0/10 | SSE real-time, mas endpoint webhook-logs sem controle de acesso |
| Segurança | 7.5/10 | Signature OK, mas falta scoping multi-tenant em endpoints |

## NOTA GERAL: 8.2/10

## Pronto para Produção: SIM, COM CONDIÇÕES ⚠️

O sistema está **pronto para produção em escala média** (até ~50K msgs/dia) **SOMENTE SE** os fixes críticos abaixo forem aplicados. Sem eles, há risco real de exceder limites da Meta (TierDetection desabilitada) e exposição de dados entre tenants.

## 4 Principais Riscos

1. **TierDetection desabilitada** — `enableAutoTierDetection: false` + stubs (`isNearDailyLimit` → false, `getRemainingMessages` → Infinity). O sistema NÃO aplica limites de tier automaticamente.
2. **Portfolio-level quota** não sendo rastreado (pode causar throttling inesperado)
3. **Token expiration** sem refresh automático (pode interromper campanhas)
4. **Endpoint `/api/webhook-logs` sem scoping** — expõe dados de todas as WABAs a qualquer usuário autenticado

## 6 Fixes Imediatos (Prioridade)

| # | Fix | Esforço | Impacto |
|---|-----|---------|---------|
| 1 | **HABILITAR TierDetection** e implementar `isNearDailyLimit`/`getRemainingMessages` reais | Alto | **CRÍTICO** |
| 2 | Implementar PortfolioQuotaManager | Médio | Alto |
| 3 | Scope `/api/webhook-logs` por WABA/tenant | Baixo | Alto (segurança) |
| 4 | Aumentar retry backoff para 429 (30s+) | Baixo | Alto |
| 5 | Ajustar cold daily limit por tier real | Baixo | Médio |
| 6 | Health check periódico de token | Baixo | Alto |

## 5 Melhorias Avançadas

| # | Melhoria | Esforço | Impacto |
|---|---------|---------|---------|
| 1 | Engagement Score por lead | Alto | Alto |
| 2 | Content Variation Engine | Médio | Alto |
| 3 | Smart Scheduling por região/DDD | Médio | Médio |
| 4 | A/B Testing de templates | Médio | Médio |
| 5 | Portfolio dashboard consolidado | Médio | Médio |

---

## CONCLUSÃO

O **Overdrive V3** é um sistema **impressionantemente bem arquitetado** para envio de WhatsApp em escala. A combinação de UltraStableEngine + HumanBehavior + RiskEngine + CircuitBreaker + StealthScheduler + SafeMode + FailSafeMode cria uma stack de proteção de **7 camadas** que é rara em sistemas similares.

Os pontos fortes principais são:
- **Engenharia defensiva excepcional** (circuit breaker preventivo, safe mode, fail-safe)
- **Simulação de comportamento humano** sofisticada (Gaussiana, não linear)
- **Webhook handling completo** com signature validation e persistent queue
- **Multi-WABA com failover** automático

Os pontos de melhoria são majoritariamente de **refinamento** (portfolio quota, token refresh, content variation), não de **arquitetura fundamental**. A base é sólida e bem estruturada.

**Veredicto: Sistema pronto para produção com ajustes pontuais. Arquitetura sólida e Meta-compliant.**
