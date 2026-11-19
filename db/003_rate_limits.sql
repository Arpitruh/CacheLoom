-- Each project gets one row per fixed UTC minute, shared by all API replicas.
-- The database is the authority so a restart cannot reset the request budget.
CREATE TABLE IF NOT EXISTS cacheloom_rate_limits (
  project TEXT NOT NULL,
  minute_bucket BIGINT NOT NULL,
  requests INTEGER NOT NULL CHECK (requests >= 0),
  PRIMARY KEY (project, minute_bucket)
);
CREATE INDEX IF NOT EXISTS cacheloom_rate_limits_minute_idx
  ON cacheloom_rate_limits(minute_bucket);
