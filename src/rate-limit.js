/**
 * An atomic, database-owned fixed-window limiter. It costs one write per
 * authorized request, so use it only when a global quota matters more than
 * throughput. PostgreSQL clock determines the current window for all replicas.
 */
export class PostgresRateLimiter {
  constructor({ pool, requestsPerMinute = 600 } = {}) {
    if (!pool) throw new Error('A PostgreSQL pool is required for rate limiting');
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 ||
      requestsPerMinute > 100000) throw new Error('Invalid distributed request budget');
    this.pool = pool;
    this.requestsPerMinute = requestsPerMinute;
  }

  async ready() { await this.pool.query('SELECT 1 FROM cacheloom_rate_limits LIMIT 1'); }

  async consume(project) {
    // The WHERE clause prevents a concurrent request from increasing an
    // already exhausted budget. ON CONFLICT serializes the per-project counter.
    const result = await this.pool.query(`
      WITH current_window AS (
        SELECT floor(extract(epoch FROM clock_timestamp()) / 60)::bigint AS bucket
      ), consumed AS (
        INSERT INTO cacheloom_rate_limits(project, minute_bucket, requests)
        SELECT $1, bucket, 1 FROM current_window
        ON CONFLICT (project, minute_bucket)
        DO UPDATE SET requests = cacheloom_rate_limits.requests + 1
          WHERE cacheloom_rate_limits.requests < $2
        RETURNING requests
      )
      SELECT requests FROM consumed
    `, [project, this.requestsPerMinute]);
    return result.rowCount === 1;
  }

  async prune({ keepMinutes = 10 } = {}) {
    if (!Number.isSafeInteger(keepMinutes) || keepMinutes < 2 || keepMinutes > 10080)
      throw new Error('Invalid rate-limit retention window');
    const result = await this.pool.query(`
      DELETE FROM cacheloom_rate_limits
      WHERE minute_bucket < floor(extract(epoch FROM clock_timestamp())/60)::bigint-$1
    `, [keepMinutes]);
    return result.rowCount;
  }
}
