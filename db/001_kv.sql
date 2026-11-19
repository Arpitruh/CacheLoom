-- Each application gets its own namespaced key. The key is encoded by the API.
CREATE TABLE IF NOT EXISTS cacheloom_kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS cacheloom_kv_expiry_idx ON cacheloom_kv(expires_at)
  WHERE expires_at IS NOT NULL;
