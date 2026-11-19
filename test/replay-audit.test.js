import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const enabled = process.env.RUN_PG_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const { Pool } = enabled ? await import('pg') : {};
const { PostgresJobQueue } = enabled ? await import('../src/job-queue.js') : {};
const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3 }) : null;
const queue = pool ? new PostgresJobQueue({ pool }) : null;
const project = 'audit_' + randomUUID().replaceAll('-', '').slice(0, 16);
after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM cacheloom_job_audit WHERE project=$1', [project]);
  await pool.query('DELETE FROM cacheloom_jobs WHERE project=$1', [project]);
  await pool.end();
});
test('replay requires a reason, records it once and ignores another project', { skip: !enabled }, async () => {
  const name = 'audit';
  const created = await queue.enqueue({ project, queue:name, payload:{ safe:true }, maxAttempts:1 });
  const [claimed] = await queue.claim({ project,queue:name });
  await queue.fail({ project,id:created.id,leaseToken:claimed.lease_token,
    error:'simulated failure',retryable:false });
  await assert.rejects(() => queue.replay({ project,id:created.id }), /REPLAY_REQUIRES/);
  await assert.rejects(() => queue.replay({ project,id:created.id,reason:'Potential duplicate side effects',
    acknowledgeDuplicateRisk:false }), /REPLAY_REQUIRES/);
  assert.equal(await queue.replay({ project,id:created.id,
    reason:'Operator checked the downstream provider and approved replay',
    acknowledgeDuplicateRisk:true }), true);
  assert.equal(await queue.replay({ project,id:created.id,
    reason:'Trying twice should not work',acknowledgeDuplicateRisk:true }), false);
  const audits = await queue.replayAudit({ project });
  assert.equal(audits.length,1);
  assert.equal(audits[0].job_id,created.id);
  assert.match(audits[0].reason,/downstream provider/);
  assert.deepEqual(await queue.replayAudit({ project: project+'_other' }),[]);
});
