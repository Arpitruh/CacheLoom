import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
try {
  // The database schema is part of the application contract. Run each
  // idempotent migration in order, not from a request handler on startup.
  for (const file of ['001_kv.sql', '002_jobs.sql', '003_rate_limits.sql']) {
    const sql = await readFile(new URL('../db/' + file, import.meta.url), 'utf8');
    await pool.query(sql);
    console.log('[cacheloom] applied ' + file);
  }
} finally {
  await pool.end();
}
