# CacheLoom

**Build infrastructure you own.** A free, self-hostable foundation for a multi-project cache, session, and job platform.

> **Status: v0.2.0 / experimental.** PostgreSQL-backed durable keys are now available as an opt-in backend. CacheLoom is not Redis-protocol-compatible and cannot replace BullMQ yet. Do not move production authentication or notification queues until operational and failure-recovery testing is complete.

## Available today

- Dependency-free HTTP server and JavaScript SDK (Node.js >=20); optional PostgreSQL driver for durable storage
- Isolated application keyspaces using per-project bearer tokens
- JSON `GET`, `SET`, `DEL`, `EXPIRE`, `TTL`, `INCR`
- NX/XX conditionals and optional TTL on SET
- Constant-time API key digest comparisons
- Capacity limit with **no silent eviction**, payload/key/TTL bounds, cleanup sweeper
- PostgreSQL-backed durable JSON values, transactional counters and restart recovery\n- Automated unit tests, PostgreSQL integration tests and Dockerfile

## Local start

```bash
cp .env.example .env
# Load environment in your shell or export the variables manually:
set -a; source .env; set +a
npm start
```

On PowerShell set `$env:CACHELOOM_API_KEYS='{"demo":"<YOUR-32-CHAR-RANDOM-SECRET>"}'` then `npm start`.

Generate a local secret:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Verify:

```bash
curl http://127.0.0.1:8080/health
curl -X POST http://127.0.0.1:8080/v1/kv \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $YOUR_SECRET" \
  -d '{"command":"SET","key":"greeting","value":"Hello!","ttlSeconds":60}'
```

JavaScript SDK:

```js
import { CacheloomClient } from './sdk/client.js';
const cache = new CacheloomClient({ url: 'http://127.0.0.1:8080', apiKey: process.env.CACHELOOM_KEY });
await cache.set('hello', { message: 'world' }, { ttlSeconds: 60 });
console.log(await cache.get('hello'));
console.log(await cache.incr('visits'));
```

Run tests: `npm test`. GitHub Actions tests Node.js 20, 22 and 24 on each change.

## PostgreSQL mode (v0.2.0)

Use an existing PostgreSQL instance or a free local Docker PostgreSQL container:

```bash
docker run --name cacheloom-postgres \
  -e POSTGRES_PASSWORD=local-dev-password \
  -e POSTGRES_DB=cacheloom -p 5432:5432 -d postgres:16
npm install
export DATABASE_URL='postgresql://postgres:local-dev-password@localhost:5432/cacheloom'
npm run migrate
export CACHELOOM_STORAGE=postgres
export CACHELOOM_API_KEYS='{"demo":"replace-this-with-a-random-secret-at-least-32-characters"}'
npm start
```

Run migrations explicitly before startup, including when deploying with Docker. The API deliberately does not create tables on boot.

`CACHELOOM_STORAGE=memory` (the default) retains the original in-process cache. `postgres` stores the same JSON values in `cacheloom_kv`. TTL and conditional writes use PostgreSQL's clock. Counters use a database transaction and advisory lock to avoid lost updates across instances.

For an external database, configure its required TLS parameters and network access. Do not expose the API to the internet without HTTPS, rate limiting, and secret management. PostgreSQL durability depends on database availability, backups and provider limits.

Test with `npm test`. CI also runs `npm run test:postgres` against disposable PostgreSQL 16. The database backend is not a high-throughput in-memory Redis substitute.

## Security and architecture limits

- Bind to `127.0.0.1` by default. Public deployment requires TLS/reverse proxy, firewall, rate limits and secret management.
- `/health` is unauthenticated; all KV commands require bearer authentication.
- Memory mode loses all values on shutdown; PostgreSQL mode keeps committed key/value data. Neither mode provides a durable job queue yet.
- Memory mode is single-process. PostgreSQL mode can share state between API instances, but lacks production-grade admission control and load testing.
- No RESP, Redis scripting, transactions, clustering, pub/sub or BullMQ compatibility.
- No paid services required to develop and test. PostgreSQL mode uses the open-source `pg` driver and whichever database you configure.

## Roadmap

1. **M1 (current):** Core key-value operations, TTL, auth, JS SDK and tests.
2. **M2:** PostgreSQL-backed durable keyspace for sessions and distributed rate limits; key rotation and quotas.
3. **M3:** Persistent SQL job queue using `FOR UPDATE SKIP LOCKED`, leases, retries, scheduling and dead letters.
4. **M4:** Redis RESP2 subset and command compatibility tests. BullMQ parity is a separate milestone.
5. **M5:** Admin dashboard, metrics, audit logs, backup/restore, observability and load testing.

Existing production Auth/Notification services remain unchanged until CacheLoom passes security and failure-recovery testing.
