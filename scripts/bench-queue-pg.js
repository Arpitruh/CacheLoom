import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PostgresJobQueue } from '../src/job-queue.js';

// This benchmark only runs against an explicitly named disposable test DB.
// A bounded run is far more useful than accidentally stressing a free production tier.
if (process.env.CACHELOOM_BENCH_TEST !== '1' || !process.env.DATABASE_URL ||
    !/\/cacheloom_test(?:\?|$)/.test(process.env.DATABASE_URL)) {
  throw new Error('A disposable cacheloom_test database and CACHELOOM_BENCH_TEST=1 are required');
}
const count = Number(process.env.BENCH_JOBS ?? 100);
if (!Number.isSafeInteger(count) || count < 1 || count > 500)
  throw new Error('BENCH_JOBS must be between 1 and 500');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const queue = new PostgresJobQueue({ pool });
const project = 'bench_' + randomUUID().replaceAll('-', '').slice(0, 16);
const queueName = 'throughput';
const samples = [];
let elapsed;
try {
  const began = performance.now();
  for (let i = 0; i < count; i++) {
    await queue.enqueue({ project,queue:queueName,payload:{ benchmark:true, index:i } });
  }
  const ids = new Set();
  let processed = 0;
  while (processed < count) {
    const before = performance.now();
    const batch = await queue.claim({ project, queue: queueName, limit: Math.min(25, count - processed) });
    assert.ok(batch.length, 'A committed job was not claimable');
    for (const item of batch) {
      assert.equal(ids.has(item.id),false,'Duplicate job claim');
      ids.add(item.id);
      assert.equal(await queue.acknowledge({
        project, id:item.id, leaseToken:item.lease_token,
      }),true,'Job acknowledgement failed');
      processed++;
    }
    samples.push(performance.now() - before);
  }
  elapsed = performance.now() - began;
  assert.equal(processed,count);
  const { rows } = await pool.query(
    "SELECT count(*)::integer AS total FROM cacheloom_jobs WHERE project=$1 AND status='completed'",
    [project]);
  assert.equal(rows[0].total,count);
  samples.sort((a,b)=>a-b);
  const pct = p => Number(samples[Math.ceil(p*samples.length)-1].toFixed(2));
  console.log(JSON.stringify({
    jobCount:count, totalMs:Number(elapsed.toFixed(1)),
    jobsPerSecond:Number((count/(elapsed/1000)).toFixed(1)),
    claimBatchP50Ms:pct(.5),claimBatchP95Ms:pct(.95),
    note:'CI environment only; no production throughput guarantee',
  }));
} finally {
  await pool.query('DELETE FROM cacheloom_jobs WHERE project=$1',[project]);
  await pool.end();
}
