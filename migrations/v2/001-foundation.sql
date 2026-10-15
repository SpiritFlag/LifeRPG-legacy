BEGIN;
CREATE SCHEMA liferpg_v2;
SET LOCAL search_path = liferpg_v2;

CREATE TABLE oauth_grants (
  hash text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('login','code','access','refresh')),
  payload jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE auth_attempts (bucket timestamptz PRIMARY KEY, attempts integer NOT NULL);
CREATE TABLE games (
  owner_id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  privacy_epoch integer NOT NULL DEFAULT 0 CHECK(privacy_epoch>=0),
  initialized boolean NOT NULL DEFAULT false, xp bigint NOT NULL DEFAULT 0 CHECK(xp>=0 AND xp<=9007199254740991),
  auto_capture_paused boolean NOT NULL DEFAULT false,
  budget_limit bigint NOT NULL DEFAULT 100000 CHECK(budget_limit>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE events (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  fingerprint text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX event_fingerprint ON events(owner_id,fingerprint) WHERE fingerprint IS NOT NULL AND deleted_at IS NULL;
CREATE TABLE payloads (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id), kind text NOT NULL,
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,id)
);
CREATE TABLE payload_sources (
  owner_id text NOT NULL, payload_id uuid NOT NULL, event_id uuid NOT NULL,
  PRIMARY KEY(payload_id,event_id),
  FOREIGN KEY(owner_id,payload_id) REFERENCES payloads(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,event_id) REFERENCES events(owner_id,id)
);
CREATE INDEX source_event ON payload_sources(owner_id,event_id);
CREATE TABLE event_versions (
  owner_id text NOT NULL, event_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), payload_id uuid,
  PRIMARY KEY(event_id,version), FOREIGN KEY(owner_id,event_id) REFERENCES events(owner_id,id),
  FOREIGN KEY(owner_id,payload_id) REFERENCES payloads(owner_id,id) ON DELETE SET NULL (payload_id)
);
CREATE TABLE requests (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id), request_key text NOT NULL, input_hash text,
  kind text NOT NULL CHECK(kind IN ('observation','start','action','answer','appeal','revise','delete')),
  status text NOT NULL CHECK(status IN ('queued','running','needs_input','committed','no_change','blocked_budget','retryable_error','failed','deleted','invalidated')),
  input_payload uuid, result_payload uuid,
  event_ids uuid[] NOT NULL DEFAULT '{}', reference_id uuid, can_play boolean NOT NULL,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,request_key), UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,input_payload) REFERENCES payloads(owner_id,id) ON DELETE SET NULL (input_payload),
  FOREIGN KEY(owner_id,result_payload) REFERENCES payloads(owner_id,id) ON DELETE SET NULL (result_payload)
);
CREATE TABLE jobs (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id), request_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','cancelled','blocked','failed')),
  fencing integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0 AND attempts<=3),
  lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,request_id) REFERENCES requests(owner_id,id), UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX one_running_game ON jobs(owner_id) WHERE state='running';
CREATE INDEX job_queue ON jobs(state,available_at);
CREATE TABLE attempts (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id), job_id uuid NOT NULL, fencing integer NOT NULL,
  state text NOT NULL CHECK(state IN ('reserved','completed','unknown')), reserved_cost bigint NOT NULL CHECK(reserved_cost>=0),
  actual_cost bigint CHECK(actual_cost>=0), model text NOT NULL, input_tokens integer, output_tokens integer,
  context_manifest jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(job_id,fencing),
  FOREIGN KEY(owner_id,job_id) REFERENCES jobs(owner_id,id)
);
CREATE TABLE memories (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id),
  kind text NOT NULL CHECK(kind IN ('identity','episode','reflection','summary','world')),
  version integer NOT NULL DEFAULT 1, payload_id uuid,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,payload_id) REFERENCES payloads(owner_id,id) ON DELETE SET NULL (payload_id)
);
CREATE TABLE decisions (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id), request_id uuid NOT NULL UNIQUE,
  previous_id uuid, event_id uuid, event_version integer, xp_delta bigint NOT NULL,
  payload_id uuid, needs_reinterpretation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,request_id) REFERENCES requests(owner_id,id),
  FOREIGN KEY(owner_id,previous_id) REFERENCES decisions(owner_id,id),
  FOREIGN KEY(owner_id,event_id) REFERENCES events(owner_id,id),
  FOREIGN KEY(owner_id,payload_id) REFERENCES payloads(owner_id,id) ON DELETE SET NULL (payload_id)
);
CREATE TABLE reward_entitlements (
  owner_id text NOT NULL, event_id uuid NOT NULL, decision_id uuid NOT NULL,
  PRIMARY KEY(owner_id,event_id), FOREIGN KEY(owner_id,event_id) REFERENCES events(owner_id,id),
  FOREIGN KEY(owner_id,decision_id) REFERENCES decisions(owner_id,id)
);
CREATE TABLE questions (
  id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL UNIQUE,
  payload_id uuid,
  answered_by uuid, state text NOT NULL CHECK(state IN ('open','answered','expired')),
  FOREIGN KEY(owner_id,request_id) REFERENCES requests(owner_id,id),
  FOREIGN KEY(owner_id,answered_by) REFERENCES requests(owner_id,id),
  FOREIGN KEY(owner_id,payload_id) REFERENCES payloads(owner_id,id) ON DELETE SET NULL (payload_id)
);
CREATE TABLE deletions (
  request_id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id),
  privacy_epoch integer NOT NULL, event_ids uuid[] NOT NULL, payload_count integer NOT NULL,
  live_status text NOT NULL CHECK(live_status='live_purged'), backup_status text NOT NULL DEFAULT 'not_verified',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,request_id) REFERENCES requests(owner_id,id)
);
COMMIT;
