import { Pool } from 'pg';

/**
 * Persistent key/value operations. PostgreSQL decides whether a key has expired,
 * so separate API instances don't disagree about a local timer.
 */
export class PostgresStore {
  constructor({ pool, ownsPool = false }) {
    if (!pool) throw new Error('A PostgreSQL pool is required');
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  async ping() { await this.pool.query('SELECT 1'); }

  async get(key) {
    const { rows } = await this.pool.query(
      'SELECT value FROM cacheloom_kv WHERE key=$1 AND (expires_at IS NULL OR expires_at > clock_timestamp())', [key]);
    return rows[0]?.value ?? null;
  }

  async set(key, value, { ttlSeconds, nx = false, xx = false } = {}) {
    if (nx && xx) throw new Error('nx and xx cannot be combined');
    const params = [key, JSON.stringify(value), ttlSeconds ?? null];
    const expires = "CASE WHEN $3::integer IS NULL THEN NULL ELSE clock_timestamp() + ($3::integer * interval '1 second') END";
    let sql;
    if (xx) {
      sql = "UPDATE cacheloom_kv SET value=$2::jsonb, expires_at=" + expires +
        " WHERE key=$1 AND (expires_at IS NULL OR expires_at > clock_timestamp()) RETURNING key";
    } else {
      sql = "INSERT INTO cacheloom_kv(key,value,expires_at) VALUES($1,$2::jsonb," + expires + ")" +
        " ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at" +
        (nx ? " WHERE cacheloom_kv.expires_at IS NOT NULL AND cacheloom_kv.expires_at <= clock_timestamp()" : "") +
        " RETURNING key";
    }
    const result = await this.pool.query(sql, params);
    return result.rowCount === 1;
  }

  async del(key) {
    const result = await this.pool.query(
      'DELETE FROM cacheloom_kv WHERE key=$1 AND (expires_at IS NULL OR expires_at > clock_timestamp())', [key]);
    return result.rowCount === 1;
  }

  async expire(key, seconds) {
    const result = await this.pool.query(
      "UPDATE cacheloom_kv SET expires_at=clock_timestamp()+($2::integer * interval '1 second')" +
      ' WHERE key=$1 AND (expires_at IS NULL OR expires_at > clock_timestamp())', [key, seconds]);
    return result.rowCount === 1;
  }

  async ttl(key) {
    const { rows } = await this.pool.query(
      'SELECT CASE WHEN expires_at IS NOT NULL AND expires_at <= clock_timestamp() THEN -2' +
      ' WHEN expires_at IS NULL THEN -1' +
      ' ELSE CEIL(EXTRACT(EPOCH FROM (expires_at - clock_timestamp())))::integer END AS seconds' +
      ' FROM cacheloom_kv WHERE key=$1', [key]);
    return rows[0]?.seconds ?? -2;
  }

  async incr(key, by = 1) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // An absent key cannot be row-locked. This transaction lock also protects
      // the first INCR from racing another worker's initial INSERT.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
      const { rows } = await client.query(
        'SELECT value,(expires_at IS NULL OR expires_at > clock_timestamp()) AS live' +
        ' FROM cacheloom_kv WHERE key=$1 FOR UPDATE', [key]);
      const live = Boolean(rows[0]?.live);
      const old = live ? rows[0].value : 0;
      if (!Number.isSafeInteger(old) || !Number.isSafeInteger(by) || !Number.isSafeInteger(old + by))
        throw new Error('VALUE_NOT_INTEGER');
      const next = old + by;
      if (rows.length) {
        await client.query(
          'UPDATE cacheloom_kv SET value=$2::jsonb,' +
          ' expires_at=CASE WHEN $3::boolean THEN expires_at ELSE NULL END WHERE key=$1',
          [key, JSON.stringify(next), live]);
      } else {
        await client.query('INSERT INTO cacheloom_kv(key,value) VALUES($1,$2::jsonb)', [key, JSON.stringify(next)]);
      }
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async sweep() {
    const result = await this.pool.query('DELETE FROM cacheloom_kv WHERE expires_at <= clock_timestamp()');
    return result.rowCount;
  }

  async close() { if (this.ownsPool) await this.pool.end(); }
}

export function createPostgresStore({ connectionString, maxConnections = 5 } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required in postgres mode');
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 20)
    throw new Error('Invalid PostgreSQL pool size');
  const pool = new Pool({
    connectionString, max: maxConnections, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 15000,
  });
  return new PostgresStore({ pool, ownsPool: true });
}
