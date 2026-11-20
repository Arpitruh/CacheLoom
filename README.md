# CacheLoom

### Self-hosted caching and background job infrastructure, built with Node.js

**CacheLoom** is an open-source backend infrastructure project that explores how to build a reusable caching and job-processing platform from the ground up. It combines a lightweight HTTP API, isolated application keyspaces, TTL-based caching, persistent PostgreSQL storage, and a durable background job queue with a JavaScript SDK.

**Node.js 22 · PostgreSQL · REST API · Docker · GitHub Actions**

> **Project stage:** Experimental release candidate (`v1.0.0-rc.1`). Core features are implemented and covered by automated tests. This is an engineering project, not a production SLA or a Redis-protocol-compatible server.

## What it can do

| Capability | Implementation |
| --- | --- |
| **Key-value cache** | `GET`, `SET`, `DEL`, `EXPIRE`, `TTL`, `INCR` over JSON HTTP |
| **Cache behavior** | Expiring keys, conditional `NX`/`XX` writes, atomic counters, bounded key/value sizes |
| **Storage engines** | Fast in-process memory mode or durable PostgreSQL-backed mode |
| **Project isolation** | Separate keyspaces and queues authenticated with per-project API keys |
| **Access controls** | Constant-time API key digest comparison, key rotation and per-project request limits |
| **Background jobs** | Scheduled jobs, priorities, deduplication, leasing, retries and dead-letter handling |
| **Worker SDK** | Concurrent polling, lease renewal, graceful shutdown and abort signals |
| **Observability** | Health/readiness endpoints, queue metrics, read-only dashboard and replay audit |
| **Recovery & testing** | Integration tests, worker-recovery simulations, PostgreSQL restore drill and CI smoke tests |

## Architecture

```text
                  Applications / JavaScript clients
                               |
                         HTTPS / REST
                               |
                     +------------------+
                     |  CacheLoom API   |
                     |  Project auth    |
                     |  Rate limiting   |
                     +---------+--------+
                               |
                  +------------+------------+
                  |                         |
          In-memory store           PostgreSQL store
          (single process)          (durable, shared)
                                            |
                                   Durable job queue
                                            |
                                   CacheloomWorker SDK
                                            |
                                   Application handlers
```

The API is built on Node.js's native HTTP server. PostgreSQL mode uses the `pg` package for durable state, transactional counters and queue coordination. Workers claim jobs with database locking and time-bound leases; expired leases can be reclaimed by another worker.

## Quick start

Requires **Node.js 20+**.

```bash
git clone https://github.com/Arpitruh/CacheLoom.git
cd CacheLoom
npm install
```

Generate a local API secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the following environment variables in your terminal (replace the placeholder with your generated secret):

```bash
export HOST=127.0.0.1
export PORT=8080
export CACHELOOM_STORAGE=memory
export CACHELOOM_API_KEYS='{"demo":"YOUR_GENERATED_SECRET"}'
npm start
```

On Windows PowerShell, use `$env:VARIABLE_NAME = "value"` instead of `export`.

Check the API:

```bash
curl http://127.0.0.1:8080/health
```

Write a cached value (set `CACHELOOM_KEY` to the same secret):

```bash
curl -X POST http://127.0.0.1:8080/v1/kv \
  -H "content-type: application/json" \
  -H "authorization: Bearer $CACHELOOM_KEY" \
  -d '{"command":"SET","key":"welcome","value":{"message":"Hello from CacheLoom"},"ttlSeconds":60}'
```

## JavaScript SDK

```js
import { CacheloomClient } from './sdk/client.js';

const cache = new CacheloomClient({
  url: 'http://127.0.0.1:8080',
  apiKey: process.env.CACHELOOM_KEY,
});

await cache.set('profile:42', { name: 'Developer' }, { ttlSeconds: 120 });
console.log(await cache.get('profile:42'));
console.log(await cache.incr('page:views'));
```

## Persistent mode (PostgreSQL)

Use a local PostgreSQL instance or an external staging database. Set a valid `DATABASE_URL` for your database, then apply the included SQL migrations **before** starting the API:

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE'
export CACHELOOM_STORAGE=postgres
npm run migrate
npm start
```

Configure TLS as required by your PostgreSQL provider. PostgreSQL mode supports durable JSON values and job state across process restarts. Memory mode is intentionally ephemeral and does not provide the durable job queue.

### Background job processing

```js
const job = await cache.enqueue('tasks', { taskId: 42 }, {
  idempotencyKey: 'tasks:42',
  maxAttempts: 3,
  priority: 5,
});

const [claimed] = await cache.claim('tasks', { limit: 1, leaseSeconds: 60 });

if (claimed) {
  // Perform an idempotent operation, then acknowledge with the lease token.
  await handleTask(claimed.payload);
  await cache.acknowledge(claimed.id, claimed.lease_token);
}
```

The reusable `CacheloomWorker` in `sdk/worker.js` handles polling, concurrency, lease renewal and shutdown orchestration. Queue delivery is **at least once**, so application handlers must handle repeated attempts safely.

## Monitoring and developer tooling

- `/health` and `/ready` endpoints for service checks.
- `/dashboard` for read-only job counts and recent activity.
- Per-project rate limits and support for API key rotation.
- Operator-reviewed replay of failed jobs with an audit record.
- Dockerfile and example Docker Compose deployment configuration.
- GitHub Actions checks for unit tests, PostgreSQL integration, smoke tests and recovery exercises.

```bash
npm test
npm run test:postgres   # requires a configured disposable test database
```

## Engineering decisions

**Why build this?** To understand the internals of caching, concurrency, durable work queues and service reliability instead of treating infrastructure as a black box.

**Why two storage modes?** Memory mode is simple for local experimentation; PostgreSQL mode demonstrates transactions, shared state and restart recovery.

**Why leases and idempotency keys?** Multiple workers can compete for jobs, and workers may crash after doing work but before acknowledging it. Lease fencing and deduplication reduce coordination errors, while idempotent handlers address the remaining duplicate-execution risk.

## Current limitations

- **Not a Redis replacement at the protocol level:** no RESP, pub/sub, Lua scripting or BullMQ compatibility.
- PostgreSQL storage emphasizes durability rather than Redis-like in-memory throughput.
- Exactly-once job execution is not guaranteed.
- Production-grade load testing, monitoring and hosted failure-recovery validation remain future work.
- No verified public production deployment is advertised for this project.

## Roadmap

- [x] Core KV commands, TTL, atomic increments and JavaScript client
- [x] PostgreSQL persistence and project isolation
- [x] Durable jobs, lease fencing, retries and worker SDK
- [x] Queue dashboard, distributed rate limiting and recovery tests
- [ ] Broader performance and fault-injection benchmarks
- [ ] Operational alerts, retention automation and production hardening
- [ ] Explore protocol compatibility and additional storage adapters

---

**Built as a hands-on backend systems engineering project.** Contributions, feedback and architecture discussions are welcome.
