import { performance } from 'node:perf_hooks';
import { CacheloomClient } from '../sdk/client.js';

// Keep benchmarks local. A production queue can easily be overwhelmed by
// a careless load test, especially on a free PostgreSQL compute allowance.
const url = process.env.CACHELOOM_BENCH_URL ?? 'http://127.0.0.1:8080';
const address = new URL(url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname))
  throw new Error('Benchmarks are intentionally restricted to localhost');
if (!process.env.CACHELOOM_KEY) throw new Error('Set CACHELOOM_KEY');
const total = Number(process.env.CACHELOOM_BENCH_REQUESTS ?? 100);
const concurrency = Number(process.env.CACHELOOM_BENCH_CONCURRENCY ?? 5);
if (!Number.isSafeInteger(total) || total < 1 || total > 5000 ||
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20)
  throw new Error('Benchmark limits exceeded');

const client = new CacheloomClient({ url, apiKey: process.env.CACHELOOM_KEY });
const queue = 'bench_' + Date.now();
let next = 0, failures = 0;
const latencies = [];
const started = performance.now();
async function runner() {
  while (next < total) {
    const i = next++;
    const now = performance.now();
    try {
      // Use delayed jobs so this measures enqueue load without also starting
      // expensive external handlers. Clean up test jobs after checking results.
      await client.enqueue(queue, { bench: i }, { delaySeconds: 2592000 });
    } catch {
      failures++;
    } finally {
      latencies.push(performance.now() - now);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, runner));
latencies.sort((a,b) => a-b);
const percentile = q => Number(latencies[Math.min(latencies.length - 1, Math.ceil(q * latencies.length) - 1)].toFixed(1));
console.log(JSON.stringify({
  requests: total, concurrency, failures,
  requestsPerSecond: Number((total / ((performance.now() - started) / 1000)).toFixed(1)),
  p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
  queue,
}, null, 2));
console.log('Benchmark jobs remain scheduled. Cancel or clean them from your disposable test database.');
