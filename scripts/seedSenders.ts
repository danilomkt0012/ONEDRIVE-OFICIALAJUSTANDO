import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { senderUsage } from '../shared/schema';
import { eq } from 'drizzle-orm';

const PHONE_IDS = process.env.PHONE_IDS;
const DAILY_QUOTA = parseInt(process.env.DAILY_QUOTA || '2000', 10);

if (!PHONE_IDS) {
  console.error('❌ Defina PHONE_IDS no .env (separados por vírgula)');
  console.error('   Exemplo: PHONE_IDS=111111111111111,222222222222222,333333333333333,444444444444444');
  process.exit(1);
}

const ids = PHONE_IDS.split(',').map(s => s.trim()).filter(Boolean);

if (ids.length === 0) {
  console.error('❌ Nenhum phone_number_id válido encontrado em PHONE_IDS');
  process.exit(1);
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);

  console.log('='.repeat(50));
  console.log('SEED SENDER_USAGE');
  console.log(`IDs: ${ids.length}`);
  console.log(`Quota diária: ${DAILY_QUOTA}`);
  console.log('='.repeat(50));

  for (const id of ids) {
    const existing = await db.select().from(senderUsage).where(eq(senderUsage.phoneNumberId, id)).limit(1);

    if (existing.length > 0) {
      await db.update(senderUsage).set({ dailyQuota: DAILY_QUOTA, status: 'ok' }).where(eq(senderUsage.phoneNumberId, id));
      console.log(`🔄 Atualizado: ${id} (quota=${DAILY_QUOTA})`);
    } else {
      await db.insert(senderUsage).values({
        phoneNumberId: id,
        sentToday: 0,
        dailyQuota: DAILY_QUOTA,
        status: 'ok',
        lastSent: new Date(),
      });
      console.log(`✅ Inserido: ${id} (quota=${DAILY_QUOTA})`);
    }
  }

  console.log(`\n✅ ${ids.length} senders prontos na tabela sender_usage`);
  await pool.end();
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
