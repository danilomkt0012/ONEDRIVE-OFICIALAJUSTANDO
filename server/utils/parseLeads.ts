import { formatPhoneE164 } from '../services/engine/phoneUtils';

/**
 * Validates Brazilian CPF format and checksum
 */
function validateCpf(cpf: string): boolean {
  const cleanCpf = cpf.replace(/\D/g, '');
  
  if (cleanCpf.length !== 11) {
    return false;
  }
  
  if (cleanCpf === cleanCpf[0].repeat(11)) {
    return false;
  }
  
  let sum1 = 0;
  for (let i = 0; i < 9; i++) {
    sum1 += parseInt(cleanCpf[i]) * (10 - i);
  }
  
  const remainder1 = sum1 % 11;
  const digit1 = remainder1 < 2 ? 0 : 11 - remainder1;
  
  if (parseInt(cleanCpf[9]) !== digit1) {
    return false;
  }
  
  let sum2 = 0;
  for (let i = 0; i < 10; i++) {
    sum2 += parseInt(cleanCpf[i]) * (11 - i);
  }
  
  const remainder2 = sum2 % 11;
  const digit2 = remainder2 < 2 ? 0 : 11 - remainder2;
  
  if (parseInt(cleanCpf[10]) !== digit2) {
    return false;
  }
  
  return true;
}


interface ValidLead {
  numero: string;
  nome: string;
  cpf?: string;
  endereco?: string;
  produto?: string;
  valor?: string;
  codigoRastreio?: string;
}

interface ParseLeadsResult {
  validLeads: ValidLead[];
  errors: string[];
}

export type LeadFormat = 'legacy' | 'new' | 'cte' | 'cpf';

/**
 * Parse leads from text format
 * Legacy format: numero,nome,produto,valor,codigoRastreio
 * New format: telefone,nome,endereco,valor,codigoRastreio
 * CT-e format: numero,nome,cte
 * CPF format: telefone,nome,cpf
 * Returns valid leads and error messages
 */
export function parseLeads(leadsText: string, format: LeadFormat = 'legacy'): ParseLeadsResult {
  const validLeads: ValidLead[] = [];
  const errors: string[] = [];
  
  const lines = leadsText.trim().split('\n');
  
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();
    if (!line) {
      continue;
    }
    
    const parts = line.split(',').map(part => part.trim());
    
    if (format === 'legacy') {
      if (parts.length !== 5) {
        errors.push(`Linha ${lineNum + 1}: Formato inválido. Use: numero,nome,produto,valor,codigoRastreio`);
        continue;
      }
      
      const [numero, nome, produto, valor, codigoRastreio] = parts;
      
      if (!numero) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone é obrigatório`);
        continue;
      }
      
      const formattedPhone = formatPhoneE164(numero);
      if (formattedPhone.length < 10) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone inválido: ${numero}`);
        continue;
      }
      
      if (!nome) {
        errors.push(`Linha ${lineNum + 1}: Nome é obrigatório`);
        continue;
      }
      
      if (!produto) {
        errors.push(`Linha ${lineNum + 1}: Produto é obrigatório`);
        continue;
      }
      
      if (!valor) {
        errors.push(`Linha ${lineNum + 1}: Valor é obrigatório`);
        continue;
      }
      
      if (!codigoRastreio) {
        errors.push(`Linha ${lineNum + 1}: Código de rastreio é obrigatório`);
        continue;
      }
      
      validLeads.push({
        numero: formattedPhone,
        nome: nome,
        produto: produto,
        valor: valor,
        codigoRastreio: codigoRastreio
      });
    } else if (format === 'new') {
      if (parts.length < 5) {
        errors.push(`Linha ${lineNum + 1}: Formato inválido. Use: telefone,nome,endereco,valor,codigoRastreio`);
        continue;
      }
      
      const telefone = parts[0];
      const nome = parts[1];
      const codigoRastreio = parts[parts.length - 1];
      const valor = parts[parts.length - 2];
      const endereco = parts.slice(2, parts.length - 2).join(',').trim();
      
      if (!telefone) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone é obrigatório`);
        continue;
      }
      
      const formattedPhone = formatPhoneE164(telefone);
      if (formattedPhone.length < 10) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone inválido: ${telefone}`);
        continue;
      }
      
      if (!nome) {
        errors.push(`Linha ${lineNum + 1}: Nome é obrigatório`);
        continue;
      }
      
      if (!endereco) {
        errors.push(`Linha ${lineNum + 1}: Endereço é obrigatório`);
        continue;
      }
      
      if (!valor) {
        errors.push(`Linha ${lineNum + 1}: Valor é obrigatório`);
        continue;
      }
      
      const valorNum = parseFloat(valor);
      if (isNaN(valorNum) || valorNum < 0) {
        errors.push(`Linha ${lineNum + 1}: Valor inválido: ${valor}`);
        continue;
      }
      
      if (!codigoRastreio) {
        errors.push(`Linha ${lineNum + 1}: Código de rastreio é obrigatório`);
        continue;
      }
      
      validLeads.push({
        numero: formattedPhone,
        nome: nome,
        endereco: endereco,
        valor: valor,
        codigoRastreio: codigoRastreio
      });
    } else if (format === 'cte') {
      if (parts.length !== 3) {
        errors.push(`Linha ${lineNum + 1}: Formato inválido. Use: numero,nome,cte`);
        continue;
      }
      
      const [numero, nome, cte] = parts;
      
      if (!numero) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone é obrigatório`);
        continue;
      }
      
      const formattedPhone = formatPhoneE164(numero);
      if (formattedPhone.length < 10) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone inválido: ${numero}`);
        continue;
      }
      
      if (!nome) {
        errors.push(`Linha ${lineNum + 1}: Nome é obrigatório`);
        continue;
      }
      
      if (!cte) {
        errors.push(`Linha ${lineNum + 1}: CT-e é obrigatório`);
        continue;
      }
      
      validLeads.push({
        numero: formattedPhone,
        nome: nome,
        codigoRastreio: cte
      });
    } else if (format === 'cpf') {
      if (parts.length !== 3) {
        errors.push(`Linha ${lineNum + 1}: Formato inválido. Use: telefone,nome,cpf`);
        continue;
      }
      
      const [telefone, nome, cpf] = parts;
      
      if (!telefone) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone é obrigatório`);
        continue;
      }
      
      const formattedPhone = formatPhoneE164(telefone);
      if (formattedPhone.length < 10) {
        errors.push(`Linha ${lineNum + 1}: Número de telefone inválido: ${telefone}`);
        continue;
      }
      
      if (!nome) {
        errors.push(`Linha ${lineNum + 1}: Nome é obrigatório`);
        continue;
      }
      
      if (!cpf) {
        errors.push(`Linha ${lineNum + 1}: CPF é obrigatório`);
        continue;
      }
      
      const cleanCpf = cpf.replace(/\D/g, '');
      if (cleanCpf.length !== 11) {
        errors.push(`Linha ${lineNum + 1}: CPF deve ter exatamente 11 digitos: ${cpf}`);
        continue;
      }
      
      validLeads.push({
        numero: formattedPhone,
        nome: nome,
        cpf: cleanCpf
      });
    }
  }
  
  return { validLeads, errors };
}
