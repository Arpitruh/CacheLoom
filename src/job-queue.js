import { randomUUID } from 'node:crypto';

/**
 * A durable queue with a small, explicit contract.
 *
 * The lease token is a fencing token: a worker that wakes up after its lease
 * expired cannot acknowledge a job that another worker has already claimed.
 * This is at-least-once processing; downstream side effects still need their
 * own idempotency keys.
 */
export class PostgresJobQueue {
  constructor({ pool, defaultLeaseSeconds = 60 } = {}) {
    if (!pool) throw new Error('A PostgreSQL pool is required for jobs');
    if (!Number.isInteger(defaultLeaseSeconds) || defaultLeaseSeconds < 5 || defaultLeaseSeconds > 3600)
      throw new Error('Invalid default lease duration');
    this.pool = pool;
    this.defaultLeaseSeconds = defaultLeaseSeconds;
  }

  async ready() {
    await this.pool.query('SELECT 1 FROM cacheloom_jobs LIMIT 1');
  }

  async enqueue({ project, queue, payload, idempotencyKey = null, priority = 0,
    maxAttempts = 3, delaySeconds = 0 }) {
    const id = randomUUID();
    const result = await this.pool.query(`
      INSERT INTO cacheloom_jobs
        (id,project,queue_name,payload,idempotency_key,priority,max_attempts,run_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,clock_timestamp()+($8::integer * interval '1 second'))
      ON CONFLICT (project,queue_name,idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id,status
    `, [id,project,queue,JSON.stringify(payload),idempotencyKey,priority,maxAttempts,delaySeconds]);
    if (result.rowCount) return { id: result.rows[0].id, status: 'pending', duplicate: false };
    const existing = await this.pool.query(
      'SELECT id,status,(payload=$4::jsonb) AS same_payload FROM cacheloom_jobs WHERE project=$1 AND queue_name=$2 AND idempotency_key=$3',
      [project,queue,idempotencyKey,JSON.stringify(payload)]);
    if (!existing.rows[0]) throw new Error('Failed to resolve concurrent idempotent enqueue');
    if (!existing.rows[0].same_payload) {
      const error = new Error('JOB_KEY_CONFLICT');
      error.status = 409;
      throw error;
    }
    return { id: existing.rows[0].id, status: existing.rows[0].status, duplicate: true };
  }

  async claim({ project, queue, limit = 1, leaseSeconds = this.defaultLeaseSeconds }) {
    // A worker can crash on its last permitted attempt. Retire these leases
    // instead of re-running them forever each time another worker polls.
    await this.pool.query(`
      UPDATE cacheloom_jobs SET status='dead',locked_until=NULL,lease_token=NULL,
        updated_at=clock_timestamp(),last_error=COALESCE(last_error,'Worker lease expired')
      WHERE project=$1 AND queue_name=$2 AND status='running'
        AND locked_until < clock_timestamp() AND attempts >= max_attempts
    `, [project,queue]);
    // SKIP LOCKED prevents two pollers claiming the same due job, without
    // serializing the entire queue behind one busy worker.
    const result = await this.pool.query(`
      WITH candidate AS (
        SELECT id FROM cacheloom_jobs
        WHERE project=$1 AND queue_name=$2
          AND ((status='pending' AND run_at <= clock_timestamp())
             OR (status='running' AND locked_until < clock_timestamp() AND attempts < max_attempts))
        ORDER BY priority DESC,run_at,created_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE cacheloom_jobs j SET
        status='running',attempts=j.attempts+1,
        lease_token=gen_random_uuid(),
        locked_until=clock_timestamp()+($4::integer * interval '1 second'),
        updated_at=clock_timestamp()
      FROM candidate WHERE j.id=candidate.id
      RETURNING j.id,j.queue_name AS queue,j.payload,j.priority,j.attempts,
        j.max_attempts,j.lease_token,j.locked_until,j.run_at
    `, [project,queue,limit,leaseSeconds]);
    return result.rows;
  }

  async acknowledge({ project, id, leaseToken }) {
    const result = await this.pool.query(`
      UPDATE cacheloom_jobs SET status='completed',lease_token=NULL,locked_until=NULL,
        completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND project=$2 AND status='running'
        AND lease_token=$3 AND locked_until > clock_timestamp()
      RETURNING id
    `, [id,project,leaseToken]);
    return result.rowCount === 1;
  }

  async extend({ project, id, leaseToken, leaseSeconds }) {
    const result = await this.pool.query(`
      UPDATE cacheloom_jobs SET
        locked_until=clock_timestamp()+($4::integer * interval '1 second'),
        updated_at=clock_timestamp()
      WHERE id=$1 AND project=$2 AND lease_token=$3 AND status='running'
        AND locked_until > clock_timestamp()
      RETURNING locked_until
    `, [id,project,leaseToken,leaseSeconds]);
    return result.rows[0]?.locked_until ?? null;
  }

  async fail({ project, id, leaseToken, error, retryable = true, retryDelaySeconds = 5 }) {
    const result = await this.pool.query(`
      UPDATE cacheloom_jobs SET
        status=CASE WHEN $4::boolean AND attempts < max_attempts THEN 'pending' ELSE 'dead' END,
        run_at=CASE WHEN $4::boolean AND attempts < max_attempts
          THEN clock_timestamp()+($5::integer * interval '1 second') ELSE run_at END,
        lease_token=NULL,locked_until=NULL,last_error=$6,updated_at=clock_timestamp()
      WHERE id=$1 AND project=$2 AND status='running'
        AND lease_token=$3 AND locked_until > clock_timestamp()
      RETURNING status,attempts,max_attempts
    `, [id,project,leaseToken,retryable,retryDelaySeconds,error.slice(0,500)]);
    return result.rows[0] ?? null;
  }

  async get({ project, id }) {
    const { rows } = await this.pool.query(`
      SELECT id,queue_name AS queue,status,priority,attempts,max_attempts,
        run_at,locked_until,last_error,created_at,completed_at
      FROM cacheloom_jobs WHERE project=$1 AND id=$2
    `, [project,id]);
    return rows[0] ?? null;
  }

  async cancel({ project, id }) {
    const result = await this.pool.query(`
      UPDATE cacheloom_jobs SET status='cancelled',updated_at=clock_timestamp()
      WHERE project=$1 AND id=$2 AND status='pending' RETURNING id
    `, [project,id]);
    return result.rowCount === 1;
  }

  async replay({ project, id, reason, acknowledgeDuplicateRisk = false }) {
    // Dead jobs are ambiguous: the worker might have completed the side
    // effect before its lease expired. Require an explicit operator decision.
    if (typeof reason !== 'string' || reason.trim().length < 10 ||
      reason.trim().length > 300 || acknowledgeDuplicateRisk !== true) {
      const error = new Error('REPLAY_REQUIRES_REASON_AND_RISK_ACKNOWLEDGEMENT');
      error.status = 400;
      throw error;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE cacheloom_jobs SET status='pending',attempts=0,
          last_error=NULL,run_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE project=$1 AND id=$2 AND status='dead' RETURNING id
      `, [project,id]);
      if (result.rowCount) {
        // The status change and its audit row commit together. An exception
        // cannot leave behind a replay with no explanation.
        await client.query(`
          INSERT INTO cacheloom_job_audit(project,job_id,action,reason)
          VALUES($1,$2,'replay',$3)
        `, [project,id,reason.trim()]);
      }
      await client.query('COMMIT');
      return result.rowCount === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async replayAudit({ project, limit = 25 }) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('INVALID_AUDIT_LIMIT');
    }
    const result = await this.pool.query(`
      SELECT job_id,action,reason,occurred_at
      FROM cacheloom_job_audit
      WHERE project=$1 ORDER BY occurred_at DESC,id DESC LIMIT $2
    `, [project,limit]);
    return result.rows;
  }
  async metrics({ project, queue = null }) {
    // Returning aggregates rather than payloads makes monitoring safe for
    // application operators who shouldn't have access to email contents.
    const result = await this.pool.query(`
      SELECT queue_name, status, count(*)::integer AS count,
        min(created_at) AS oldest_created_at,
        count(*) FILTER (WHERE status='pending' AND run_at <= clock_timestamp())::integer AS due,
        count(*) FILTER (WHERE status='running' AND locked_until < clock_timestamp())::integer AS expired_leases
      FROM cacheloom_jobs
      WHERE project=$1 AND ($2::text IS NULL OR queue_name=$2)
      GROUP BY queue_name,status
      ORDER BY queue_name,status
    `, [project, queue]);
    return result.rows;
  }

  async list({ project, queue = null, status = null, limit = 25 }) {
    // Paginated recent jobs aid troubleshooting. Never include payload or
    // idempotency keys in responses used by a read-only dashboard.
    const result = await this.pool.query(`
      SELECT id,queue_name AS queue,status,priority,attempts,max_attempts,
        run_at,locked_until,last_error,created_at,completed_at
      FROM cacheloom_jobs
      WHERE project=$1 AND ($2::text IS NULL OR queue_name=$2)
        AND ($3::text IS NULL OR status=$3)
      ORDER BY created_at DESC,id DESC
      LIMIT $4
    `, [project,queue,status,limit]);
    return result.rows;
  }

  async prune({ project, olderThanDays = 30, limit = 500, dryRun = true }) {
    if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
      typeof dryRun !== 'boolean') throw new Error('INVALID_RETENTION_SETTINGS');
    // We deliberately retain dead jobs for operator investigation. Completed
    // and cancelled jobs can be removed, but their idempotency keys then become
    // reusable, which is why this is opt-in rather than automatic housekeeping.
    if (dryRun) {
      const result = await this.pool.query(`
        SELECT count(*)::integer AS eligible FROM cacheloom_jobs
        WHERE project=$1 AND status IN ('completed','cancelled')
          AND updated_at < clock_timestamp()-($2::integer * interval '1 day')
      `, [project,olderThanDays]);
      return { dryRun: true, eligible: result.rows[0].eligible, deleted: 0 };
    }
    const result = await this.pool.query(`
      WITH victims AS (
        SELECT id FROM cacheloom_jobs
        WHERE project=$1 AND status IN ('completed','cancelled')
          AND updated_at < clock_timestamp()-($2::integer * interval '1 day')
        ORDER BY updated_at,id
        LIMIT $3 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM cacheloom_jobs j USING victims v WHERE j.id=v.id
      RETURNING j.id
    `, [project,olderThanDays,limit]);
    return { dryRun: false, deleted: result.rowCount };
  }

}
