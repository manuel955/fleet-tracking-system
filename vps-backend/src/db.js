import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

export async function runMigrations() {
  if (!pool) return;
  const migrationsDirectory = fileURLToPath(new URL('../db/', import.meta.url));
  const files = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  for (const name of files) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (applied.rowCount) continue;
    const sql = await readFile(new URL(`../db/${name}`, import.meta.url), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
  }
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
