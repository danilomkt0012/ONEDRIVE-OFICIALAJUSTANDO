import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

const listFile = getArg('list');
const phonesCount = parseInt(getArg('phones') || '4', 10);
const speed = parseInt(getArg('speed') || '30', 10);
const templateName = getArg('template');
const serverUrl = getArg('server') || 'http://localhost:5000';

if (!listFile) {
  console.error('❌ Uso: npx tsx scripts/launcher.ts --list <arquivo.csv> [--phones 4] [--speed 30] [--template nome]');
  console.error('');
  console.error('Opções:');
  console.error('  --list       Arquivo CSV com leads (obrigatório)');
  console.error('  --phones     Quantidade de senders a usar (padrão: 4)');
  console.error('  --speed      Msgs/segundo alvo (padrão: 30)');
  console.error('  --template   Nome do template WhatsApp');
  console.error('  --server     URL do servidor (padrão: http://localhost:5000)');
  process.exit(1);
}

function parseCSV(filePath: string): Array<{ phone: string; name: string; cpf?: string }> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    throw new Error('Arquivo CSV vazio');
  }

  const header = lines[0].toLowerCase();
  const hasHeader = header.includes('phone') || header.includes('telefone') || header.includes('nome') || header.includes('name');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const separator = lines[0].includes(';') ? ';' : ',';

  return dataLines.map(line => {
    const parts = line.split(separator).map(s => s.trim().replace(/^["']|["']$/g, ''));
    const phone = parts[0] || '';
    const name = parts[1] || 'Cliente';
    const cpf = parts[2] || undefined;
    return { phone, name, cpf };
  }).filter(l => l.phone.length >= 10);
}

async function main() {
  console.log('='.repeat(60));
  console.log('OVERDRIVE LAUNCHER');
  console.log('='.repeat(60));
  console.log(`Arquivo: ${listFile}`);
  console.log(`Senders: ${phonesCount}`);
  console.log(`Speed:   ${speed} msg/s`);
  console.log(`Server:  ${serverUrl}`);
  console.log('='.repeat(60));

  const filePath = path.resolve(listFile);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Arquivo não encontrado: ${filePath}`);
    process.exit(1);
  }

  const leads = parseCSV(filePath);
  console.log(`📋 ${leads.length} leads carregados do arquivo`);

  if (leads.length === 0) {
    console.error('❌ Nenhum lead válido encontrado no arquivo');
    process.exit(1);
  }

  const poolRes = await fetch(`${serverUrl}/api/sender-pool/available`);
  if (!poolRes.ok) {
    console.error('❌ Falha ao consultar sender pool:', await poolRes.text());
    process.exit(1);
  }
  const availableSenders = await poolRes.json() as any[];
  console.log(`📱 ${availableSenders.length} senders disponíveis no pool`);

  if (availableSenders.length === 0) {
    console.error('❌ Nenhum sender disponível. Rode: npm run seed:sender');
    process.exit(1);
  }

  if (availableSenders.length < phonesCount) {
    console.warn(`⚠️  Apenas ${availableSenders.length} senders disponíveis (pedido: ${phonesCount})`);
  }

  const phoneRes = await fetch(`${serverUrl}/api/phone-numbers`);
  if (!phoneRes.ok) {
    console.error('❌ Falha ao buscar phone numbers:', await phoneRes.text());
    process.exit(1);
  }
  const phoneNumbers = await phoneRes.json() as any[];
  const selectedPhones = phoneNumbers.slice(0, phonesCount);

  if (selectedPhones.length === 0) {
    console.error('❌ Nenhum número de telefone configurado na API');
    process.exit(1);
  }
  console.log(`📱 Usando ${selectedPhones.length} números para disparo`);

  let templatesRes: Response;
  let templates: any[];

  if (templateName) {
    templatesRes = await fetch(`${serverUrl}/api/templates`);
    templates = (await templatesRes.json()) as any[];
    templates = templates.filter((t: any) => t.name === templateName && t.status === 'APPROVED');
    if (templates.length === 0) {
      console.error(`❌ Template "${templateName}" não encontrado ou não aprovado`);
      process.exit(1);
    }
  } else {
    templatesRes = await fetch(`${serverUrl}/api/templates`);
    templates = (await templatesRes.json()) as any[];
    templates = templates.filter((t: any) => t.status === 'APPROVED');
    if (templates.length === 0) {
      console.error('❌ Nenhum template aprovado encontrado. Sincronize os templates primeiro.');
      process.exit(1);
    }
  }

  console.log(`📝 Template(s): ${templates.map((t: any) => t.name).join(', ')}`);

  const dispatchPayload = {
    leads: leads.map(l => ({ phone: l.phone, name: l.name, cpf: l.cpf })),
    phoneNumbers: selectedPhones,
    templates: templates.map((t: any) => t.name),
    speedMode: speed <= 10 ? 'SLOW' : speed <= 30 ? 'NORMAL' : 'FAST',
    modo: 'template',
  };

  console.log(`\n🚀 Disparando campanha com ${leads.length} leads...`);

  const dispatchRes = await fetch(`${serverUrl}/api/campaigns/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dispatchPayload),
  });

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    console.error(`❌ Falha ao iniciar campanha: ${errText}`);
    process.exit(1);
  }

  const result = await dispatchRes.json() as any;
  console.log('\n' + '='.repeat(60));
  console.log('✅ CAMPANHA INICIADA');
  console.log('='.repeat(60));
  console.log(`ID:     ${result.campaignId}`);
  console.log(`Leads:  ${leads.length}`);
  console.log(`Phones: ${selectedPhones.length}`);
  console.log(`Speed:  ${dispatchPayload.speedMode}`);
  console.log('');
  console.log(`Acompanhe em tempo real no dashboard ou via SSE:`);
  console.log(`  ${serverUrl}/api/campaigns/${result.campaignId}/metrics/stream`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('❌ Erro fatal:', err.message);
  process.exit(1);
});
