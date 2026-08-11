import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = config.databaseUrl
  ? new Pool({ connectionString: config.databaseUrl, max: 10 })
  : null;

export async function databaseHealth() {
  if (!pool) return { configured: false, reachable: false };
  const result = await pool.query('SELECT 1 AS ok');
  return { configured: true, reachable: result.rows[0]?.ok === 1 };
}

export async function closeDatabase() {
  await pool?.end();
}
