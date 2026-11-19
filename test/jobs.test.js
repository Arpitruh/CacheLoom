import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = process.env.RUN_PG_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const { Pool } = enabled ? await import('pg') : {};
const { PostgresJobQueue } = enabled ? await import('../src/job-queue.js') : {};
const { createCacheloomServer } = enabled ? await import('../src/server.js') : {};
const { CacheloomClient } = enabled ? await import('../sdk/client.js') : {};
const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 15 }) : null;
const jobs = pool ? new PostgresJobQueue({ pool }) : null;
const project = 'test_' + randomUUID().replaceAll('-', '').slice(0, 16);
const otherProject = project + '_other';

after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM cacheloom_jobs WHERE project=ANY($1::text[])', [[project,otherProject]]);
  await pool.end();
});

test('only one durable job exists for parallel idempotent requests', { skip: !enabled }, async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => jobs.enqueue({
    project, queue: 'welcome', payload: { email: 'test@example.invalid' }, idempotencyKey: 'event-1',
  })));
  assert.equal(new Set(results.map(row => row.id)).size, 1);
  assert.equal(results.filter(x => !x.duplicate).length, 1);
  assert.equal(results.filter(x => x.duplicate).length, 19);
});

test('reusing one idempotency key with different data is a conflict', { skip: !enabled }, async () => {
  const queue = 'conflict_' + randomUUID().slice(0, 8);
  await jobs.enqueue({ project, queue, payload: { order: 'first' }, idempotencyKey: 'same-key' });
  await assert.rejects(
    () => jobs.enqueue({ project, queue, payload: { order: 'different' }, idempotencyKey: 'same-key' }),
    /JOB_KEY_CONFLICT/,
  );
});

test('scheduling, priority and project isolation survive database-backed claims', { skip: !enabled }, async () => {
  const queue = 'scheduling_' + randomUUID().slice(0, 8);
  const slow = await jobs.enqueue({ project, queue, payload: { order: 1 }, delaySeconds: 120 });
  await jobs.enqueue({ project, queue, payload: { order: 2 }, priority: 1 });
  await jobs.enqueue({ project, queue, payload: { order: 3 }, priority: 10 });
  await jobs.enqueue({ project: otherProject, queue, payload: { order: 4 }, priority: 100 });
  const claimed = await jobs.claim({ project, queue, limit: 10 });
  assert.deepEqual(claimed.map(x => x.payload.order), [3,2]);
  assert.equal((await jobs.get({ project: otherProject, id: slow.id })), null);
  assert.equal((await jobs.claim({ project, queue, limit: 10 })).length, 0);
  await pool.query("UPDATE cacheloom_jobs SET run_at=clock_timestamp()-interval '1 second' WHERE id=$1", [slow.id]);
  assert.equal((await jobs.claim({ project,queue }))[0].id, slow.id);
});

test('two pollers never claim the same available job', { skip: !enabled }, async () => {
  const queue = 'claims_' + randomUUID().slice(0, 8);
  await jobs.enqueue({ project,queue,payload:{ x:1 } });
  const [first,second] = await Promise.all([
    jobs.claim({project,queue}), jobs.claim({project,queue}),
  ]);
  assert.equal(first.length + second.length, 1);
});

test('a lost lease cannot acknowledge or fail a job claimed by another worker', { skip: !enabled }, async () => {
  const queue = 'fencing_' + randomUUID().slice(0, 8);
  const enqueued = await jobs.enqueue({project,queue,payload:{}});
  const first = (await jobs.claim({project,queue,leaseSeconds:5}))[0];
  await pool.query("UPDATE cacheloom_jobs SET locked_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
  const second = (await jobs.claim({project,queue,leaseSeconds:5}))[0];
  assert.notEqual(first.lease_token, second.lease_token);
  assert.equal(await jobs.acknowledge({project,id:enqueued.id,leaseToken:first.lease_token}), false);
  assert.equal(await jobs.fail({project,id:enqueued.id,leaseToken:first.lease_token,error:'late'}), null);
  assert.equal(await jobs.acknowledge({project,id:enqueued.id,leaseToken:second.lease_token}), true);
  assert.equal((await jobs.get({project,id:enqueued.id})).status, 'completed');
});

test('transient failures retry, exhausted jobs die, and manual replay works', { skip: !enabled }, async () => {
  const queue = 'retry_' + randomUUID().slice(0, 8);
  const enqueued = await jobs.enqueue({project,queue,payload:{},maxAttempts:2});
  const first = (await jobs.claim({project,queue}))[0];
  const res = await jobs.fail({project,id:first.id,leaseToken:first.lease_token,error:'temporary',retryDelaySeconds:0});
  assert.equal(res.status,'pending');
  const second = (await jobs.claim({project,queue}))[0];
  const dead = await jobs.fail({project,id:second.id,leaseToken:second.lease_token,error:'permanent',retryable:true});
  assert.equal(dead.status,'dead');
  assert.equal(await jobs.replay({project,id:enqueued.id}),true);
  const third = (await jobs.claim({project,queue}))[0];
  assert.equal(third.attempts,1);
  assert.equal(await jobs.fail({project,id:third.id,leaseToken:third.lease_token,error:'do not retry',retryable:false}).then(x=>x.status),'dead');
});

test('an expired final attempt becomes dead without being sent again', { skip: !enabled }, async () => {
  const queue='crash_' + randomUUID().slice(0, 8);
  const item=await jobs.enqueue({project,queue,payload:{},maxAttempts:1});
  await jobs.claim({project,queue,leaseSeconds:5});
  await pool.query("UPDATE cacheloom_jobs SET locked_until=clock_timestamp()-interval '1 second' WHERE id=$1",[item.id]);
  assert.equal((await jobs.claim({project,queue})).length,0);
  assert.equal((await jobs.get({project,id:item.id})).status,'dead');
});

test('authenticated HTTP clients can enqueue, claim and acknowledge their own jobs', { skip: !enabled }, async () => {
  const a='integration-secret-alpha-12345678901234567890';
  const b='integration-secret-bravo-12345678901234567890';
  const server=createCacheloomServer({keys:JSON.stringify({[project]:a,[otherProject]:b}),jobs});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const url='http://127.0.0.1:'+server.address().port;
    const alpha=new CacheloomClient({url,apiKey:a});
    const bravo=new CacheloomClient({url,apiKey:b});
    const queue='http_'+randomUUID().slice(0,8);
    const item=await alpha.enqueue(queue,{message:'hello'});
    assert.equal(await bravo.getJob(item.id),null);
    const claim=(await alpha.claim(queue))[0];
    assert.equal(claim.id,item.id);
    assert.equal(await alpha.acknowledge(item.id,claim.lease_token),true);
    assert.equal((await alpha.getJob(item.id)).status,'completed');
    assert.equal((await fetch(url+'/ready')).status,200);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('metrics and recent jobs stay inside the authenticated project', { skip: !enabled }, async () => {
  const queue = 'metrics_' + randomUUID().slice(0, 8);
  const first = await jobs.enqueue({ project, queue, payload: { secret: 'not for dashboard' } });
  await jobs.enqueue({ project: otherProject, queue, payload: { secret: 'another tenant' } });
  const rows = await jobs.metrics({ project, queue });
  assert.equal(rows.find(r => r.status === 'pending')?.count, 1);
  assert.equal(rows.find(r => r.status === 'pending')?.due, 1);
  const recent = await jobs.list({ project, queue, limit: 10 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, first.id);
  assert.equal(Object.hasOwn(recent[0], 'payload'), false);
  const secret = 'metrics-test-client-secret-with-32-characters';
  const server = createCacheloomServer({ keys: JSON.stringify({ [project]: secret }), jobs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new CacheloomClient({ url: 'http://127.0.0.1:' + server.address().port, apiKey: secret });
    assert.equal((await client.queueMetrics(queue)).find(x => x.status === 'pending')?.count, 1);
    assert.equal((await client.listJobs({ queue }))[0].id, first.id);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
