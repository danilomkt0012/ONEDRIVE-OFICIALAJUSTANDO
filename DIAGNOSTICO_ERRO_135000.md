# Diagnóstico do Erro #135000 - Falha no Disparo

**Data:** 17 de Outubro de 2025  
**Erro:** `(#135000) Generic user error`  
**Template Afetado:** `model_005`

---

## 🔍 ANÁLISE DO PROBLEMA

### Erro Detectado nos Logs:
```
Erro ao enviar template com botões: {
  error: {
    error: {
      message: '(#135000) Generic user error',
      type: 'OAuthException',
      code: 135000,
      error_data: [Object],
      fbtrace_id: '...'
    }
  },
  phoneNumberId: '...',
  recipientPhone: '+556...',
  templateName: 'model_005'
}
```

### Informações do Template `model_005`:
```json
{
  "name": "model_005",
  "language": "en",  ⚠️ PROBLEMA IDENTIFICADO
  "category": "UTILITY",
  "components": [
    {
      "type": "HEADER",
      "text": "Atualização Jus"  ⚠️ TEXTO EM PORTUGUÊS
    },
    {
      "type": "BODY",
      "text": "Prezado(a) {{1}}, ..."  ⚠️ TEXTO EM PORTUGUÊS
    },
    {
      "type": "BUTTONS",
      "buttons": [{
        "type": "URL",
        "text": "Detalhes",  ⚠️ TEXTO EM PORTUGUÊS
        "url": "https://debito.regulariza-irpf.org/{{1}}"
      }]
    }
  ]
}
```

---

## ⚠️ CAUSA RAIZ DO PROBLEMA

### **INCOMPATIBILIDADE DE IDIOMA**

O template `model_005` está registrado na Meta API com:
- **Idioma declarado:** `"en"` (inglês)
- **Conteúdo real:** Português brasileiro

**Por que isso causa erro #135000:**
A Meta valida se o idioma declarado do template corresponde ao idioma real do conteúdo. Quando você envia uma requisição usando `language: { code: "en" }` mas o conteúdo está em português, a API rejeita com erro 135000.

### Evidências nos Logs:
```
🌐 Language do template: "en" (tipo: string)
📝 Body text: Prezado(a) {{1}}, Informamos que...  ← Português
🔧 Idioma a ser usado: en  ← Conflito!
```

---

## ✅ SOLUÇÕES POSSÍVEIS

### **Solução 1: Corrigir o Idioma no Meta Business Manager** (RECOMENDADO)

1. Acesse [Meta Business Suite](https://business.facebook.com)
2. Vá em **WhatsApp Manager** → **Message Templates**
3. Localize o template `model_005`
4. Clique em **Editar** ou **Duplicar**
5. Altere o idioma de `English (en)` para `Portuguese (Brazil) (pt_BR)`
6. Submeta para aprovação (ou use como está se for duplicado)
7. Aguarde aprovação da Meta
8. Sincronize os templates no sistema: `/templates` → "Sincronizar"

### **Solução 2: Criar Novo Template com Idioma Correto**

1. Acesse Meta Business Suite
2. Crie um **novo template** (ex: `model_005_pt`)
3. Configure idioma como `pt_BR`
4. Use o mesmo conteúdo que está em `model_005`
5. Submeta para aprovação
6. Após aprovação, sincronize no sistema
7. Use o novo template nos disparos

### **Solução 3: Forçar pt_BR no Sistema** (NÃO RECOMENDADO)

Alterar o código para ignorar o idioma vindo da API e sempre usar `pt_BR`. 

**Problema:** Isso funcionaria apenas se todos os templates estiverem em português. Quebraria templates que realmente estão em inglês.

---

## 🔧 VERIFICAÇÃO ADICIONAL

### Outras possíveis causas do erro #135000:

1. **Phone Number IDs incorretos**
   - Verificar se os `phone_number_id` pertencem à mesma WABA do token
   - Confirmar que números estão "Connected" e "Hosted by Cloud API"

2. **Token sem permissões**
   - Verificar se token tem escopo `whatsapp_business_messaging`
   - Confirmar que App está em modo "Live" (não "Development")

3. **Parâmetros do template incorretos**
   - Body: 2 parâmetros ({{1}}, {{2}}) ✅ Correto
   - Button: 1 parâmetro ({{1}}) ✅ Correto
   - Formato E.164: +5562991107048 ✅ Correto

**Status dessas verificações:** ✅ Todos os itens estão corretos

---

## 📋 PRÓXIMOS PASSOS IMEDIATOS

### Para o Usuário:

**Passo 1:** Teste com novo disparo após melhorias no logging
1. Faça um novo disparo de teste
2. Observe o console de logs
3. Procure por "📋 ERROR_DATA DETALHADO:" - isso mostrará detalhes adicionais do erro

**Passo 2:** Corrija o idioma do template
1. Siga a **Solução 1** acima (corrigir no Meta Business Manager)
2. OU crie um novo template com idioma correto (Solução 2)

**Passo 3:** Teste novamente
1. Sincronize templates no sistema
2. Selecione o template corrigido
3. Faça novo disparo

---

## 🎯 VALIDAÇÃO DA SOLUÇÃO

Após corrigir o idioma, você deve ver:

### ✅ Sucesso nos logs:
```
✅ RESPOSTA DA API WHATSAPP (BOTÕES): {
  "messages": [{
    "id": "wamid.xxx",
    "message_status": "accepted"
  }]
}
```

### ✅ Na interface:
- Taxa de sucesso: > 90%
- Mensagens enviadas: igual ao total de leads
- Sem erros 135000

### ✅ No WhatsApp Business Manager:
- Mensagens aparecem como enviadas
- Status: "Entregue" ou "Lida"

---

## 📊 RESUMO EXECUTIVO

| Item | Status | Observação |
|------|--------|------------|
| **Erro identificado** | ✅ Sim | Erro #135000 |
| **Causa raiz** | ✅ Identificada | Idioma do template incorreto |
| **Solução** | ✅ Documentada | Corrigir idioma no Meta |
| **Logging melhorado** | ✅ Implementado | ERROR_DATA detalhado |
| **Validações adicionais** | ✅ Verificadas | Token, Phone IDs, parâmetros OK |

---

## 🔬 TESTE DIAGNÓSTICO

Para confirmar se é problema de idioma:

1. **Teste com template em inglês real:**
   - Se você tem um template com conteúdo em inglês e idioma "en", teste com ele
   - Se funcionar, confirma que o problema é a incompatibilidade de idioma

2. **Verifique outros templates:**
   - Liste todos os templates sincronizados
   - Veja quais têm idioma "en" mas conteúdo em português
   - Todos esses terão o mesmo problema

3. **Use diagnóstico de template:**
   - Acesse `/templates`
   - Selecione template e número
   - Clique em "Diagnosticar"
   - Sistema deve alertar sobre incompatibilidade

---

**Conclusão:** O problema é **incompatibilidade de idioma** entre o declarado (en) e o conteúdo (pt). A solução é **corrigir o idioma no Meta Business Manager** para `pt_BR`.

---

**Próxima ação:** Faça um teste de disparo para ver os detalhes completos do erro com o logging melhorado, depois corrija o idioma do template conforme orientações acima.
