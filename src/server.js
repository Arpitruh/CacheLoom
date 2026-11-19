import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VolatileStore } from './store.js';

const MAX_BODY = 64 * 1024;
const MAX_VALUE = 32 * 1024;
const MAX_TTL = 30 * 24 * 60 * 60;
const MAX_KEY_LENGTH = 256;

function failure(res, code, error) { send(res, code, { error }); }
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function parseKeys(input) {
  if (!input) throw new Error('CACHELOOM_API_KEYS is required');
  const data = JSON.parse(input);
  if (!data || Array.isArray(data) || typeof data !== 'object' || !Object.keys(data).length) throw new Error('Invalid key map');
  const entries = Object.entries(data);
  for (const [project, key] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(project) || typeof key !== 'string' || key.length < 32) {
      throw new Error('Each project needs a valid ID and a secret of at least 32 characters');
    }
  }
  return entries.map(([project, secret]) => ({ project, digest: crypto.createHash('sha256').update(secret).digest() }));
}
function authenticate(header, keys) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (!token || token.length > 512) return null;
  const digest = crypto.createHash('sha256').update(token).digest();
  for (const item of keys) if (crypto.timingSafeEqual(digest, item.digest)) return item.project;
  return null;
}
function validKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH; }
function validTTL(n) { return Number.isSafeInteger(n) && n >= 1 && n <= MAX_TTL; }
function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let rejected = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { rejected = true; reject(Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 })); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}


function jobInputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function dispatchJobCommand(jobs, project, body) {
  const queue = body.queue;
  const id = body.id;
  const token = body.leaseToken;
  const validQueue = typeof queue === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(queue);
  const validId = typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  const validToken = typeof token === 'string' &&
    /^[0-9a-f-]{36}$/i.test(token);
  const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
  switch (body.command) {
    case 'ENQUEUE':
      if (!validQueue || !Object.hasOwn(body, 'payload') || body.payload === undefined ||
        Buffer.byteLength(JSON.stringify(body.payload)) > MAX_VALUE ||
        (body.idempotencyKey !== undefined &&
         (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length > 150 || !body.idempotencyKey.length)) ||
        !integer(body.priority ?? 0, -10000, 10000) ||
        !integer(body.maxAttempts ?? 3, 1, 100) ||
        !integer(body.delaySeconds ?? 0, 0, 2592000))
        throw jobInputError('INVALID_ENQUEUE');
      return jobs.enqueue({ project, queue, payload: body.payload, idempotencyKey: body.idempotencyKey,
        priority: body.priority, maxAttempts: body.maxAttempts, delaySeconds: body.delaySeconds });
    case 'CLAIM':
      if (!validQueue || !integer(body.limit ?? 1, 1, 25) ||
        !integer(body.leaseSeconds ?? 60, 5, 3600)) throw jobInputError('INVALID_CLAIM');
      return jobs.claim({ project, queue, limit: body.limit, leaseSeconds: body.leaseSeconds });
    case 'ACK':
      if (!validId || !validToken) throw jobInputError('INVALID_ACK');
      return jobs.acknowledge({ project, id, leaseToken: token });
    case 'FAIL':
      if (!validId || !validToken || typeof body.error !== 'string' || !body.error.length ||
        body.error.length > 500 || (body.retryable !== undefined && typeof body.retryable !== 'boolean') ||
        !integer(body.retryDelaySeconds ?? 5, 0, 2592000)) throw jobInputError('INVALID_FAIL');
      return jobs.fail({ project, id, leaseToken: token, error: body.error,
        retryable: body.retryable, retryDelaySeconds: body.retryDelaySeconds });
    case 'EXTEND':
      if (!validId || !validToken || !integer(body.leaseSeconds, 5, 3600))
        throw jobInputError('INVALID_EXTEND');
      return jobs.extend({ project, id, leaseToken: token, leaseSeconds: body.leaseSeconds });
    case 'METRICS':
      if (queue !== undefined && !validQueue) throw jobInputError('INVALID_QUEUE');
      return jobs.metrics({ project, queue: queue ?? null });
    case 'LIST':
      if (queue !== undefined && !validQueue) throw jobInputError('INVALID_QUEUE');
      if (body.status !== undefined &&
        !['pending', 'running', 'completed', 'dead', 'cancelled'].includes(body.status))
        throw jobInputError('INVALID_JOB_STATUS');
      if (!integer(body.limit ?? 25, 1, 100)) throw jobInputError('INVALID_LIST_LIMIT');
      return jobs.list({ project, queue: queue ?? null, status: body.status ?? null, limit: body.limit ?? 25 });
    case 'GET':
      if (!validId) throw jobInputError('INVALID_JOB_ID');
      return jobs.get({ project, id });
    case 'CANCEL':
      if (!validId) throw jobInputError('INVALID_JOB_ID');
      return jobs.cancel({ project, id });
    case 'REPLAY':
      if (!validId) throw jobInputError('INVALID_JOB_ID');
      return jobs.replay({ project, id });
    default: throw jobInputError('UNKNOWN_JOB_COMMAND');
  }
}

export function createCacheloomServer({ keys, maxKeys = 10000, store = new VolatileStore({ maxKeys }), jobs = null }) {
  const authKeys = Array.isArray(keys) ? keys : parseKeys(keys);
  const interval = setInterval(() => {
    // A temporary database outage should never become an unhandled timer error.
    void Promise.resolve().then(() => store.sweep())
      .catch(() => console.error('[cacheloom] expiry cleanup failed'));
  }, 60000);
  interval.unref();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && ['/dashboard','/dashboard.css','/dashboard.js'].includes(req.url)) {
        const file = req.url === '/dashboard' ? 'dashboard.html' : req.url.slice(1);
        const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
          : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
        const data = await readFile(new URL('./' + file, import.meta.url));
        // Static UI only. The API stays authenticated and project-scoped.
        res.writeHead(200, {
          'content-type': type, 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
        res.end(data);
        return;
      }
      if (req.url === '/health' && req.method === 'GET') return send(res, 200, { status: 'up' });
      if (req.url === '/ready' && req.method === 'GET') {
        try {
          if (store.ping) await store.ping();
          if (jobs) await jobs.ready();
          return send(res, 200, { status: 'ready' });
        } catch {
          return failure(res, 503, 'STORAGE_UNAVAILABLE');
        }
      }
      if (!['/v1/kv', '/v1/jobs'].includes(req.url) || req.method !== 'POST')
        return failure(res, 404, 'NOT_FOUND');
      const project = authenticate(req.headers.authorization, authKeys);
      if (!project) return failure(res, 401, 'UNAUTHORIZED');
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return failure(res, 415, 'CONTENT_TYPE_REQUIRED');
      const body = await readJSON(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(res, 400, 'INVALID_REQUEST');
      if (req.url === '/v1/jobs') {
        if (!jobs) return failure(res, 503, 'JOB_QUEUE_NOT_CONFIGURED');
        const result = await dispatchJobCommand(jobs, project, body);
        return send(res, 200, { result });
      }
      if (!validKey(body.key)) return failure(res, 400, 'INVALID_KEY');
      // PostgreSQL TEXT cannot store a NUL byte, so encode the user key.
      const key = `${project}:${Buffer.from(body.key).toString('base64url')}`;
      let result;
      switch (body.command) {
        case 'GET': result = await store.get(key); break;
        case 'SET': {
          if (!Object.hasOwn(body, 'value') || body.value === undefined) return failure(res, 400, 'VALUE_REQUIRED');
          if (Buffer.byteLength(JSON.stringify(body.value)) > MAX_VALUE) return failure(res, 413, 'VALUE_TOO_LARGE');
          if (body.ttlSeconds !== undefined && !validTTL(body.ttlSeconds)) return failure(res, 400, 'INVALID_TTL');
          if (body.nx !== undefined && typeof body.nx !== 'boolean') return failure(res, 400, 'INVALID_NX');
          if (body.xx !== undefined && typeof body.xx !== 'boolean') return failure(res, 400, 'INVALID_XX');
          result = await store.set(key, body.value, { ttlSeconds: body.ttlSeconds, nx: body.nx, xx: body.xx });
          break;
        }
        case 'DEL': result = await store.del(key); break;
        case 'EXPIRE':
          if (!validTTL(body.ttlSeconds)) return failure(res, 400, 'INVALID_TTL');
          result = await store.expire(key, body.ttlSeconds); break;
        case 'TTL': result = await store.ttl(key); break;
        case 'INCR':
          if (body.by !== undefined && !Number.isSafeInteger(body.by)) return failure(res, 400, 'INVALID_INCREMENT');
          result = await store.incr(key, body.by ?? 1); break;
        default: return failure(res, 400, 'UNKNOWN_COMMAND');
      }
      send(res, 200, { result });
    } catch (error) {
      const status = error.status ||
        ({ STORE_CAPACITY_EXCEEDED: 507, VALUE_NOT_INTEGER: 409 }[error.message] ?? (error.code ? 503 : 400));
      if (status >= 500) console.error('[cacheloom] request could not be completed:', status);
      if (!res.headersSent && !res.destroyed) {
        failure(res, status, status === 400 ? 'INVALID_REQUEST'
          : status === 503 ? 'STORAGE_UNAVAILABLE' : error.message);
      }
    }
  });
  server.on('close', () => clearInterval(interval));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const backend = process.env.CACHELOOM_STORAGE ?? 'memory';
  if (!['memory', 'postgres'].includes(backend))
    throw new Error('CACHELOOM_STORAGE must be memory or postgres');
  const store = backend === 'postgres'
    ? (await import('./pg-store.js')).createPostgresStore({ connectionString: process.env.DATABASE_URL })
    : new VolatileStore({ maxKeys: Number(process.env.MAX_KEYS ?? 10000) });
  if (store.ping) await store.ping();
  // The queue is opt-in and only works with PostgreSQL. Memory-mode users
  // aren't presented with a queue that would silently drop work on restart.
  const jobs = backend === 'postgres'
    ? new (await import('./job-queue.js')).PostgresJobQueue({ pool: store.pool })
    : null;
  if (jobs) await jobs.ready();
  const server = createCacheloomServer({ keys: process.env.CACHELOOM_API_KEYS, store, jobs });
  server.listen(port, host, () => console.log(`[cacheloom] ${backend} backend listening on ${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => { void Promise.resolve(store.close?.()).then(() => process.exit(0)); });
  });
}
