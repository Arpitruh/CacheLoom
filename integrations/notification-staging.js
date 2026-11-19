/**
 * Staging-only bridge for Notification Service's existing outbox relay.
 *
 * Notification Service's PostgreSQL outbox remains the source of truth.
 * We map its deterministic outbox ID to a CacheLoom idempotency key, rather
 * than attempting to mimic BullMQ's internal job IDs or retry counters.
 * This module deliberately does not send messages or update notifications.
 */
export const NOTIFICATION_STAGING_QUEUE = 'notifications-standard-staging';

export function prepareNotificationJob(event, { now = Date.now() } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('A notification outbox event is required');
  }
  const { outboxId, notificationId, scheduledFor, priority = 0 } = event;
  if (typeof outboxId !== 'string' || !/^[0-9a-zA-Z_-]{1,150}$/.test(outboxId))
    throw new Error('Invalid notification outbox ID');
  if (typeof notificationId !== 'string' || !notificationId.trim() ||
      notificationId.length > 150) throw new Error('Invalid notification ID');
  if (!Number.isSafeInteger(priority) || priority < -10000 || priority > 10000)
    throw new Error('Invalid priority');
  const target = scheduledFor == null ? now : new Date(scheduledFor).getTime();
  if (!Number.isFinite(target)) throw new Error('Invalid scheduled date');
  const delaySeconds = Math.max(0, Math.ceil((target - now) / 1000));
  if (delaySeconds > 2592000) throw new Error('Scheduling exceeds CacheLoom 30-day limit');
  return {
    queue: NOTIFICATION_STAGING_QUEUE,
    payload: {
      notificationId,
      outboxId,
      // Do not copy recipients, rendered HTML, credentials, or template data.
      // The real worker must reload the canonical notification before delivery.
    },
    options: {
      idempotencyKey: outboxId,
      priority,
      delaySeconds,
      maxAttempts: 3,
    },
  };
}

export async function enqueueNotificationForStaging(client, event, options) {
  const mapped = prepareNotificationJob(event, options);
  return client.enqueue(mapped.queue, mapped.payload, mapped.options);
}

/**
 * Simulated delivery only: a caller supplies a probe that records an attempted
 * dispatch. The probe must never call a live SMTP/SMS provider in staging.
 */
export function createNotificationStagingHandler({ inspect, onSimulatedDelivery } = {}) {
  if (typeof inspect !== 'function' || typeof onSimulatedDelivery !== 'function')
    throw new Error('Staging handler requires inspect and onSimulatedDelivery callbacks');
  return async (payload, { job, signal }) => {
    if (!payload || typeof payload.notificationId !== 'string' ||
      typeof payload.outboxId !== 'string')
      throw new Error('Invalid staging notification payload');
    if (signal?.aborted) throw new Error('Staging handler aborted');
    const current = await inspect(payload.notificationId);
    if (!current) throw Object.assign(new Error('Notification missing'), { retryable: false });
    if (['sent', 'dead_letter', 'expired', 'cancelled', 'suppressed', 'unknown'].includes(current.status))
      return { skipped: true, status: current.status };
    if (!['pending', 'queued', 'retry_scheduled', 'failed'].includes(current.status))
      throw Object.assign(new Error('Notification is not safe to simulate'), { retryable: false });
    if (signal?.aborted) throw new Error('Staging handler aborted');
    await onSimulatedDelivery({
      notificationId: payload.notificationId,
      outboxId: payload.outboxId,
      jobId: job.id,
      attempt: job.attempts,
    });
    return { simulated: true };
  };
}
