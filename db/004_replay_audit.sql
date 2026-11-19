-- Replaying a dead job may repeat an external side effect. Keep an immutable,
-- project-scoped record of the operator's stated reason for each successful replay.
CREATE TABLE IF NOT EXISTS cacheloom_job_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project TEXT NOT NULL,
  job_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('replay')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 300),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cacheloom_job_audit_project_time
  ON cacheloom_job_audit(project,occurred_at DESC);
