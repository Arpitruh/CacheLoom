/**
 * A small worker loop for CacheLoom's HTTP queue.
 *
 * The database lease is the authority. The AbortSignal tells a handler to stop
 * when it loses ownership, but it cannot undo an email or payment already sent.
 * Handlers should use their job ID as an idempotency key for external effects.
 */
export class CacheloomWorker {
  constructor({ client, queue, handler, concurrency = 2, leaseSeconds = 60,
    pollIntervalMs = 1000, retryDelaySeconds = 5, heartbeatIntervalMs,
    onError = error => console.error('[cacheloom-worker]', error),
    onEvent = () => {} } = {}) {
    if (!client || typeof client.claim !== 'function' || typeof client.extend !== 'function' ||
      typeof client.acknowledge !== 'function' || typeof client.fail !== 'function')
      throw new Error('A Cacheloom client with queue methods is required');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(queue ?? '')) throw new Error('Invalid queue');
    if (typeof handler !== 'function') throw new Error('A job handler is required');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 25)
      throw new Error('Concurrency must be between 1 and 25');
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600)
      throw new Error('Lease duration must be 5–3600 seconds');
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60000)
      throw new Error('Poll interval must be 100–60000 ms');
    if (!Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 0 || retryDelaySeconds > 2592000)
      throw new Error('Retry delay is out of range');
    const heartbeat = heartbeatIntervalMs ?? Math.floor(leaseSeconds * 1000 / 3);
    if (!Number.isSafeInteger(heartbeat) || heartbeat < 100 ||
      heartbeat >= leaseSeconds * 1000 / 2)
      throw new Error('Heartbeat must be shorter than half the lease');
    Object.assign(this, { client, queue, handler, concurrency, leaseSeconds,
      pollIntervalMs, retryDelaySeconds, heartbeat, onError, onEvent });
    this.running = false;
    this.inFlight = new Set();
    this.controllers = new Set();
    this.loop = null;
    this.sleepWake = null;
  }

  start() {
    if (this.running || this.loop) throw new Error('Worker already started');
    this.running = true;
    this.loop = this.#poll();
    return this;
  }

  async #sleep() {
    if (!this.running) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.sleepWake = null; resolve(); }, this.pollIntervalMs);
      this.sleepWake = () => { clearTimeout(timer); this.sleepWake = null; resolve(); };
    });
  }

  async #poll() {
    try {
      while (this.running) {
        const free = this.concurrency - this.inFlight.size;
        if (free > 0) {
          try {
            const batch = await this.client.claim(this.queue, {
              limit: free, leaseSeconds: this.leaseSeconds,
            });
            // Do not begin newly claimed work during shutdown. The lease will
            // expire, allowing a different worker to recover it.
            for (const job of batch) {
              if (!this.running) break;
              const work = this.#process(job);
              this.inFlight.add(work);
              void work.finally(() => this.inFlight.delete(work));
            }
          } catch (error) { this.onError(error); }
        }
        await this.#sleep();
      }
    } finally { this.loop = null; }
  }

  async #process(job) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let lostLease = false;
    let beatBusy = false;
    const heartbeat = async () => {
      if (beatBusy || lostLease || controller.signal.aborted) return;
      beatBusy = true;
      try {
        const until = await this.client.extend(job.id, job.lease_token, this.leaseSeconds);
        if (!until) {
          lostLease = true;
          controller.abort(new Error('Job lease lost'));
          this.onEvent({ type: 'lease-lost', jobId: job.id });
        }
      } catch (error) {
        // A transient network failure isn't proof that ownership was lost.
        // Stop side effects conservatively; don't blindly ACK or FAIL later.
        lostLease = true;
        controller.abort(error);
        this.onError(error);
      } finally { beatBusy = false; }
    };
    const timer = setInterval(() => { void heartbeat(); }, this.heartbeat);
    try {
      this.onEvent({ type: 'started', jobId: job.id });
      await this.handler(job.payload, { job, signal: controller.signal });
      if (lostLease || controller.signal.aborted) return;
      const accepted = await this.client.acknowledge(job.id, job.lease_token);
      this.onEvent({ type: accepted ? 'completed' : 'lease-lost', jobId: job.id });
    } catch (error) {
      if (lostLease || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Job handler failed';
      const retryable = error?.retryable !== false;
      try {
        const result = await this.client.fail(job.id, job.lease_token, message.slice(0, 500), {
          retryable, retryDelaySeconds: this.retryDelaySeconds,
        });
        this.onEvent({ type: result ? 'failed' : 'lease-lost', jobId: job.id });
      } catch (reportError) { this.onError(reportError); }
    } finally {
      clearInterval(timer);
      this.controllers.delete(controller);
    }
  }

  async stop({ timeoutMs = 30000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000)
      throw new Error('Invalid shutdown timeout');
    this.running = false;
    this.sleepWake?.();
    await this.loop;
    if (this.inFlight.size === 0) return { drained: true };
    const drained = Promise.allSettled([...this.inFlight]).then(() => true);
    if (timeoutMs === 0) {
      for (const controller of this.controllers) controller.abort(new Error('Worker shutting down'));
      return { drained: false };
    }
    let timer;
    const clean = await Promise.race([
      drained,
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (!clean) {
      // This is cooperative cancellation. A handler that ignores its signal
      // may remain alive; the database lease will eventually expire.
      for (const controller of this.controllers) controller.abort(new Error('Shutdown timeout'));
    }
    return { drained: clean };
  }
}
