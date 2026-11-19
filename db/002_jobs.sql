-- PostgreSQL owns the delivery state. Redis isn't needed for this queue.
-- Workers can crash without losing a job; an expired lease makes it claimable again.
CREATE TABLE IF NOT EXISTS cacheloom_jobs (
  id UUID PRIMARY KEY,
  project TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  idempotency_key TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','dead','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  locked_until TIMESTAMPTZ,
  lease_token UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT cacheloom_jobs_lease_consistency CHECK (
    (status='running' AND lease_token IS NOT NULL AND locked_until IS NOT NULL)
    OR (status<>'running' AND lease_token IS NULL AND locked_until IS NULL)
  )
);
-- Keeping terminal jobs (and their unique keys) makes duplicate requests safe.
-- Operators can define a retention policy later, once archival is available.
CREATE UNIQUE INDEX IF NOT EXISTS cacheloom_jobs_idempotency
  ON cacheloom_jobs(project,queue_name,idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS cacheloom_jobs_pending
  ON cacheloom_jobs(project,queue_name,priority DESC,run_at,created_at)
  WHERE status='pending';
CREATE INDEX IF NOT EXISTS cacheloom_jobs_expired_leases
  ON cacheloom_jobs(locked_until) WHERE status='running';
CREATE INDEX IF NOT EXISTS cacheloom_jobs_project_recent
  ON cacheloom_jobs(project,created_at DESC);
