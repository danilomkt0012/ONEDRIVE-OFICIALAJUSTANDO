import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@shared/schema';

if (!process.env.DATABASE_URL) {
  console.error('[DB] ERRO FATAL: DATABASE_URL não está configurada. Configure esta variável no painel Secrets antes de iniciar o servidor.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 25,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[DB] Idle pool client error — connection will be discarded:', err.message);
});

export const db = drizzle(pool, { schema });
export { pool };
