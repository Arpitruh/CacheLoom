import { Pool } from 'pg';
import { PostgresStore } from '../src/pg-store.js';
import { PostgresJobQueue } from '../src/job-queue.js';
import assert from 'node:assert/strict';

const phase = process.argv[2];
if (!['seed', 'verify'].includes(phase)) throw new Error('Usage: node scripts/restore-fixture.js seed|verify');
if (process.env.CACHELOOM_RESTORE_TEST !== '1') {
  throw new Error('Restore fixtures are only enabled with CACHELOOM_RESTORE_TEST=1');
}
const url = phase === 'verify' ? process.env.RESTORE_DATABASE_URL : process.env.DATABASE_URL;
if (!url || !/\/cacheloom_(test|restore_test)(?:\?|$)/.test(url))
  throw new Error('Refusing to use a database without the cacheloom_test / cacheloom_restore_test name');

const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000 });
const store = new PostgresStore({ pool });
const jobs = new PostgresJobQueue({ pool });
const project = 'restore_smoke';
const key = project + ':backed-up-key';

try {
  if (phase === 'seed') {
    await store.set(key, { persisted: true, timestamp: 'fixture-v1' });
    const item = await jobs.enqueue({
      project, queue: 'notification', payload: { template: 'welcome', safe: true },
      idempotencyKey: 'restore-once', maxAttempts: 2,
    });
    assert.ok(item.id);
    await pool.query("INSERT INTO cacheloom_rate_limits(project,minute_bucket,requests) VALUES($1,-200,5) ON CONFLICT (project,minute_bucket) DO UPDATE SET requests=5", [project]);
    console.log('[restore-test] Test data written to the source database.');
  } else {
    assert.deepEqual(await store.get(key), { persisted: true, timestamp: 'fixture-v1' });
    const { rows } = await pool.query(
      'SELECT status,payload FROM cacheloom_jobs WHERE project=$1 AND idempotency_key=$2',
      [project, 'restore-once']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.deepEqual(rows[0].payload, { template: 'welcome', safe: true });
    const counter = await pool.query('SELECT requests FROM cacheloom_rate_limits WHERE project=$1 AND minute_bucket=-200', [project]);
    assert.equal(counter.rows[0]?.requests, 5);
    const [claimed] = await jobs.claim({ project, queue: 'notification' });
    assert.ok(claimed, 'restored jobs must still be claimable');
    assert.equal(await jobs.acknowledge({ project, id: claimed.id, leaseToken: claimed.lease_token }), true);
    console.log('[restore-test] KV, durable job, quota, and post-restore worker execution verified.');
  }
} finally {
  await pool.end();
}
