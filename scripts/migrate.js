import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
try {
  const sql = await readFile(new URL('../db/001_kv.sql', import.meta.url), 'utf8');
  // Keeping schema setup separate makes database changes an explicit deployment step.
  await pool.query(sql);
  console.log('[cacheloom] PostgreSQL key/value schema is ready');
} finally {
  await pool.end();
}
