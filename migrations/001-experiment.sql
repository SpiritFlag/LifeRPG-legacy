BEGIN;
CREATE TABLE IF NOT EXISTS life_events (
  id uuid PRIMARY KEY,
  occurred_on date NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('real', 'test')),
  summary text NOT NULL,
  evidence text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, occurred_on, event_key)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id uuid PRIMARY KEY,
  called_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  tool text NOT NULL,
  arguments jsonb NOT NULL,
  outcome text NOT NULL,
  event_id uuid REFERENCES life_events(id),
  result jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_completed ON tool_calls(completed_at DESC);
CREATE TABLE IF NOT EXISTS oauth_grants (
  hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('login', 'code', 'access', 'refresh')),
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_grants_expiry ON oauth_grants(expires_at);
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket timestamptz PRIMARY KEY,
  attempts integer NOT NULL
);
COMMIT;
