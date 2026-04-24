# OVERDRIVE V3 - MOTOR ULTRA-ESTÁVEL ATIVADO

**Data:** 05/02/2026  
**Status:** ✅ ATIVO COMO PADRÃO GLOBAL

---

## RESUMO TÉCNICO

### Motor Ativo por Padrão

| Item | Valor |
|------|-------|
| **Motor padrão** | UltraStableEngine (V3) |
| **Classe wrapper** | UltraStableCampaignSender |
| **Motor anterior (V2)** | REMOVIDO do fluxo ativo |
| **Arquivo de inicialização** | `server/routes.ts` |

---

## ONDE OCORRE A INICIALIZAÇÃO

```
routes.ts
├── createUltraStableEngine()          → Linha 1701
│   └── new UltraStableCampaignSender()
├── executeParallelCampaign()          → Linha 1745
│   └── Usa createUltraStableEngine()
├── executeUltraStableCampaignWithResume() → Linha 1865
│   └── Usa createUltraStableEngine()
└── cleanupUltraStableEngine()         → Linha 1729
```

---

## CARACTERÍSTICAS ATIVAS

| Feature | Status | Descrição |
|---------|--------|-----------|
| RetryQueue não-bloqueante | ✅ ATIVO | Leads com falha vão para fila separada |
| SafeMode automático | ✅ ATIVO | Ativa em errorRate > 0.5% |
| CircuitBreaker preventivo | ✅ ATIVO | Age antes do erro (p99 > 350ms) |
| TierDetection via Meta API | ✅ ATIVO | Detecta tier no início da campanha |
| PreflightValidator | ✅ ATIVO | Valida E.164, template, parâmetros |
| ErrorClassification | ✅ ATIVO | Separa rateLimitErrors, networkErrors, etc |
| Checkpoint a cada 5 msgs | ✅ ATIVO | Mais seguro que V2 (era 10) |
| Finalização garantida | ✅ ATIVO | pipeline.drain() + retryQueue.drain() |

---

## CENÁRIOS EM QUE O V2 PODE SER USADO

| Cenário | V2 é usado? |
|---------|-------------|
| Campanhas normais via API | ❌ NÃO - V3 é usado |
| Resume de campanhas | ❌ NÃO - V3 é usado |
| Importação manual de código | ⚠️ POSSÍVEL - mas não recomendado |

**Resumo:** O V2 (OptimizedEngineV2) permanece no código para compatibilidade, mas **nenhum fluxo ativo** o utiliza. Todas as campanhas iniciadas via interface ou API usam automaticamente o V3.

---

## LOGS DE CONFIRMAÇÃO

Quando uma campanha inicia, os seguintes logs são exibidos:

```
🛡️ OVERDRIVE V3: Iniciando campanha {campaignId}
   ⚡ Motor: UltraStableEngine (V3)
   🔄 RetryQueue: não-bloqueante
   🛡️ SafeMode: automático
   ⚡ CircuitBreaker: preventivo
   📊 TierDetection: ativo
```

---

## FLUXO DE CAMPANHA V3

```
┌──────────────────────────────────────────────────────────────┐
│ 1. POST /api/campaigns/:id/start                             │
└──────────────────────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. executeCampaign() → executeParallelCampaign()             │
└──────────────────────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. createUltraStableEngine(campaignId)                       │
│    └── new UltraStableCampaignSender()                       │
│        └── new UltraStableEngine({                           │
│              enablePreflightValidation: true,                │
│              enableAutoTierDetection: true,                  │
│              checkpointEveryN: 5,                            │
│              ...                                             │
│            })                                                │
└──────────────────────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. engine.startCampaign(leads, phones, templates, token)     │
│    └── UltraStableEngine.processLeads()                      │
│        ├── TierDetection.detectTier()                        │
│        ├── PreflightValidator.validate()                     │
│        ├── TokenBucket + CircuitBreaker                      │
│        ├── RetryQueue (não-bloqueante)                       │
│        └── SafeMode (automático)                             │
└──────────────────────────────────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. FINALIZAÇÃO GARANTIDA                                     │
│    ├── pipeline.drain()                                      │
│    ├── retryQueue.drain()                                    │
│    └── forceFlush() checkpoint                               │
└──────────────────────────────────────────────────────────────┘
```

---

## ARQUIVOS MODIFICADOS

| Arquivo | Mudança |
|---------|---------|
| `server/routes.ts` | Import UltraStableCampaignSender, novas funções createUltraStableEngine, executeParallelCampaign (V3) |
| `server/services/sendCampaign.ts` | Header atualizado para OVERDRIVE V3 |

---

## CONCLUSÃO

✅ **OVERDRIVE V3 está ATIVO como motor padrão global**

- Todas as campanhas usam UltraStableEngine
- V2 não é mais utilizado em nenhum fluxo ativo
- SafeMode, CircuitBreaker, TierDetection, PreflightValidator estão todos habilitados
- Finalização aguarda pipeline.drain() + retryQueue.drain()

---

*Relatório gerado em 05/02/2026*
