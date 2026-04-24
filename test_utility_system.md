# Guia Rápido de Teste - Templates UTILITY

## ✅ CHECKLIST DE TESTES

### 1. Configuração Inicial
- [ ] Acessar `/config`
- [ ] Inserir `Meta Token` (da Meta Business Suite)
- [ ] Inserir `WhatsApp Business ID`
- [ ] Clicar em "Validar Configuração"
- [ ] Verificar mensagem de sucesso

### 2. Sincronizar Templates
- [ ] Acessar `/templates`
- [ ] Clicar em "Sincronizar Templates"
- [ ] Verificar que templates UTILITY aparecem
- [ ] Confirmar badge de categoria (UTILITY = verde, MARKETING = azul)
- [ ] Verificar status APPROVED

### 3. Preparar Leads de Teste

#### Formato CPF (Recomendado para UTILITY):
```
5511999999999,João da Silva,123.456.789-09
5521888888888,Maria Santos,987.654.321-00
5531777777777,Pedro Costa,456.789.123-45
```

#### Formato CT-e (Também suportado):
```
5511999999999,João da Silva,BR12345678901234567890123456789012345
5521888888888,Maria Santos,BR09876543210987654321098765432109876
```

### 4. Realizar Disparo de Teste

#### 4.1 Validar Leads
- [ ] Acessar `/dispatch`
- [ ] Selecionar formato: **CPF** ou **CT-e**
- [ ] Colar 3-5 leads de teste
- [ ] Clicar em "Validar Leads"
- [ ] Confirmar que todos os leads são válidos
- [ ] Verificar CPF correto e telefone formatado

#### 4.2 Selecionar Números
- [ ] Ver lista de números disponíveis
- [ ] Selecionar apenas números com qualidade GREEN ou YELLOW
- [ ] Verificar quantidade de números selecionados
- [ ] Observar estimativa de capacidade

#### 4.3 Selecionar Template UTILITY
- [ ] Visualizar templates disponíveis
- [ ] **IMPORTANTE:** Selecionar apenas templates com badge UTILITY
- [ ] Clicar em "Diagnosticar Template" (opcional mas recomendado)
- [ ] Verificar que não há problemas críticos

#### 4.4 Configurar Batching
- [ ] Ajustar taxa: **30 msg/s por número** (recomendado)
- [ ] Verificar capacidade total calculada
- [ ] Conferir tempo estimado

#### 4.5 Iniciar Disparo
- [ ] Revisar todas as configurações
- [ ] Clicar em "Iniciar Disparo"
- [ ] Observar console de logs em tempo real
- [ ] Acompanhar barra de progresso
- [ ] Aguardar conclusão

### 5. Verificar Resultados

#### No Sistema:
- [ ] Taxa de sucesso > 90%
- [ ] Mensagens enviadas = Total de leads
- [ ] Falhas = 0 ou mínimas
- [ ] Tempo de execução dentro do estimado

#### No WhatsApp Business Manager:
- [ ] Abrir Meta Business Suite
- [ ] Ir em WhatsApp > Mensagens
- [ ] Verificar que mensagens foram enviadas
- [ ] Status: "Entregue" ou "Lida"

---

## 🔍 DIAGNÓSTICO DE PROBLEMAS COMUNS

### Problema: "Valid API configuration required"
**Causa:** Token ou Business ID não configurado  
**Solução:**
1. Ir em `/config`
2. Inserir credenciais corretas
3. Validar configuração

### Problema: Templates vazios
**Causa:** API não configurada ou sem templates aprovados  
**Solução:**
1. Configurar API primeiro
2. Criar templates no Meta Business Manager
3. Aguardar aprovação da Meta
4. Sincronizar no sistema

### Problema: "Template MARKETING detectado - Limitações de entrega"
**Causa:** Template selecionado é MARKETING, não UTILITY  
**Solução:**
1. Usar apenas templates UTILITY para novos leads
2. Templates MARKETING só funcionam se o cliente iniciou conversa nas últimas 24h

### Problema: Taxa de sucesso baixa (<70%)
**Causas possíveis:**
- Números de telefone incorretos
- Números sem WhatsApp
- Template com parâmetros errados
- Rate limit atingido

**Solução:**
1. Validar formato de telefone (+5511999999999)
2. Usar apenas números reais com WhatsApp
3. Conferir mapeamento de parâmetros
4. Reduzir batching rate para 20 msg/s

### Problema: Erro 135000
**Causa:** Problema de configuração  
**Solução:**
1. Verificar se phone_number_id pertence à mesma WABA do token
2. Confirmar que número está "Connected" e "Hosted by Cloud API"
3. Validar parâmetros do template
4. Verificar se token tem escopo whatsapp_business_messaging
5. Confirmar que App está em modo Live

---

## 📊 MÉTRICAS ESPERADAS (Sistema Saudável)

| Métrica | Valor Esperado |
|---------|---------------|
| Taxa de validação de leads | > 95% |
| Taxa de sucesso de envio | > 90% |
| Velocidade com 1 número | ~10 msg/s |
| Velocidade com 5 números | ~50 msg/s |
| Tempo de disparo (1000 leads, 5 números) | ~20 segundos |
| Erros de API (135000, 190) | 0% |
| Timeout de requisições | 0% |

---

## ✅ TESTE PASSOU SE:

1. ✅ Configuração da API validada com sucesso
2. ✅ Templates sincronizados (pelo menos 1 UTILITY)
3. ✅ Leads validados corretamente (CPF válido, telefone formatado)
4. ✅ Disparo iniciado sem erros
5. ✅ Taxa de sucesso > 90%
6. ✅ Mensagens visíveis no WhatsApp Business Manager
7. ✅ Console de logs sem erros críticos
8. ✅ Progresso monitorado em tempo real

---

## 🎯 TESTE DE CARGA (Opcional)

Para testar performance do sistema:

```
Cenário 1: Pequeno (100 leads, 1 número)
- Tempo esperado: ~10 segundos
- Taxa esperada: ~10 msg/s

Cenário 2: Médio (500 leads, 3 números)
- Tempo esperado: ~15 segundos  
- Taxa esperada: ~30 msg/s

Cenário 3: Grande (1000 leads, 5 números)
- Tempo esperado: ~20 segundos
- Taxa esperada: ~50 msg/s

Cenário 4: Muito Grande (5000 leads, 10 números)
- Tempo esperado: ~50 segundos
- Taxa esperada: ~100 msg/s
```

**Observação:** Respeitar limites da API do WhatsApp Business (1000 mensagens/dia por número em fase inicial).

---

**Última atualização:** 17/10/2025  
**Versão:** 1.0.0
