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

export async function withTransaction(callback) {
  if (!pool) throw new Error('Database is not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
