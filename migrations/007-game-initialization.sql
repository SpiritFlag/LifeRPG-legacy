BEGIN;
-- Drafts contain authored input only. No live game exists until finalization commits.
CREATE TABLE game_initializations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('real','test')),
  status text NOT NULL CHECK (status IN ('preparing','completed','cancelled')),
  revision integer NOT NULL CHECK (revision > 0),
  character jsonb NOT NULL,
  starting_location text NOT NULL,
  game_id uuid UNIQUE REFERENCES games(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='completed') = (game_id IS NOT NULL))
);
CREATE UNIQUE INDEX game_initializations_open ON game_initializations(owner_id) WHERE status='preparing';
CREATE TABLE initialization_requests (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  owner_id text NOT NULL,
  initialization_id uuid NOT NULL REFERENCES game_initializations(id),
  request_key text NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_id,request_key)
);
CREATE TRIGGER initialization_requests_immutable BEFORE UPDATE OR DELETE ON initialization_requests FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TABLE character_births (
  game_id uuid PRIMARY KEY REFERENCES games(id),
  initialization_id uuid NOT NULL UNIQUE REFERENCES game_initializations(id),
  update_id uuid NOT NULL,
  character jsonb NOT NULL,
  starting_location_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(game_id,update_id) REFERENCES gm_updates(game_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(game_id,starting_location_id) REFERENCES world_entities(game_id,id)
);
CREATE TABLE character_profiles (
  game_id uuid PRIMARY KEY REFERENCES games(id),
  profile jsonb NOT NULL
);
CREATE TABLE character_profile_changes (
  sequence bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id),
  update_id uuid NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(game_id,update_id) REFERENCES gm_updates(game_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER character_births_immutable BEFORE UPDATE OR DELETE ON character_births FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER character_profile_changes_immutable BEFORE UPDATE OR DELETE ON character_profile_changes FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
COMMIT;
