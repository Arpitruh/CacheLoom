# CacheLoom

### A small caching and job queue service built with Node.js

I started **CacheLoom** because I wanted to understand what happens behind the scenes when an app stores temporary data or hands work off to a background queue. Rather than only using an existing service, I built a small one to experiment with those ideas.

It began as a key-value cache and grew into a Node.js API with TTL support, PostgreSQL persistence, project-level API keys, a job queue and a JavaScript SDK. The goal is to make these building blocks reusable across different projects, while learning where the tricky parts are.

**Node.js 22 · PostgreSQL · REST API · Docker · GitHub Actions**

> **Status:** `v1.0.0-rc.1` — experimental. The main features work in automated tests, but there's still operational testing and hardening to do before I'd rely on it in production.

## What's built so far

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

I kept the HTTP layer simple by using Node's built-in server. In PostgreSQL mode, the `pg` package handles persistent values and queue operations. Jobs are claimed using database locks and leases, so another worker can pick them up if the first one stops responding.

## Run it locally

Requires **Node.js 20+**.

```bash
git clone https://github.com/Arpitruh/CacheLoom.git
cd CacheLoom
npm install
```

First, generate an API key for your local project:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the environment variables below, replacing the placeholder with that key:

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

## Keep data between restarts

Memory mode is handy for quick tests, but everything disappears when the process stops. If you want data and queued jobs to survive restarts, connect a local or staging PostgreSQL database and run the migrations **before** starting the API:

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

For longer-running work, `CacheloomWorker` in `sdk/worker.js` takes care of polling, concurrent handlers, lease renewal and graceful shutdown. A job can still run more than once after a failure, so handlers need to be idempotent.

## Debugging and testing

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

## A few things I learned while building it

**A cache is more than a map with an expiry time.** Once multiple apps use the same service, key isolation, limits, authentication and predictable failure behavior start to matter.

**Durability changes the trade-offs.** The in-memory store is straightforward and quick to work with. PostgreSQL makes restart recovery and shared state possible, but every operation now has database costs and contention to consider.

**Background jobs are the interesting part.** A worker can finish a task and crash before acknowledging it. Leases help other workers recover the job, but they can't undo a side effect. That's why I added deduplication, fenced acknowledgements and replay auditing—and why handlers still need their own idempotency checks.

## What it doesn't do (yet)

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

I'm keeping this project public as a record of what I've built and learned. If you spot a bug, an edge case I missed, or a cleaner approach, feel free to open an issue or PR.
