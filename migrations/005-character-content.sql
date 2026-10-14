BEGIN;
-- Additive after 004. No definitions, possessions or actual character are created.
CREATE TABLE game_definitions (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL REFERENCES games(id),
  definition_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('profession','skill','trait','equipment','item','title','achievement')),
  current_version integer NOT NULL DEFAULT 1 CHECK(current_version>0),
  UNIQUE(game_id,id),UNIQUE(game_id,id,kind),UNIQUE(game_id,definition_key)
);
CREATE TABLE game_definition_versions (
  game_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  name text NOT NULL,description text NOT NULL,
  settings jsonb NOT NULL,
  stat_modifiers jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(game_id,definition_id,version),
  FOREIGN KEY(game_id,definition_id) REFERENCES game_definitions(game_id,id)
);
ALTER TABLE game_definitions ADD CONSTRAINT game_definition_current_version FOREIGN KEY(game_id,id,current_version)
  REFERENCES game_definition_versions(game_id,definition_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE character_features (
  id uuid PRIMARY KEY,sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL REFERENCES characters(game_id),
  acquisition_key text NOT NULL,acquisition_hash text NOT NULL,
  definition_id uuid NOT NULL,definition_version integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('profession','skill','trait','title','achievement')),
  status text NOT NULL CHECK(status IN ('active','lost','ended')),
  mastery bigint NOT NULL CHECK(mastery BETWEEN 0 AND 9007199254740991),
  grade text NOT NULL,state jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz,
  UNIQUE(game_id,id),UNIQUE(game_id,acquisition_key),
  FOREIGN KEY(game_id,definition_id,kind) REFERENCES game_definitions(game_id,id,kind),
  FOREIGN KEY(game_id,definition_id,definition_version) REFERENCES game_definition_versions(game_id,definition_id,version)
);
CREATE UNIQUE INDEX character_current_profession ON character_features(game_id) WHERE kind='profession' AND status='active';
CREATE UNIQUE INDEX character_active_feature ON character_features(game_id,definition_id) WHERE status='active';
CREATE TABLE inventory_entries (
  id uuid PRIMARY KEY,sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL REFERENCES characters(game_id),
  acquisition_key text NOT NULL,acquisition_hash text NOT NULL,
  definition_id uuid NOT NULL,definition_version integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('equipment','item')),
  mode text NOT NULL CHECK(mode IN ('individual','stack')),
  quantity bigint NOT NULL CHECK(quantity BETWEEN 0 AND 9007199254740991),
  status text NOT NULL CHECK(status IN ('owned','lost')),
  slot text,grade text NOT NULL,state jsonb NOT NULL,
  durability bigint CHECK(durability BETWEEN 0 AND 9007199254740991),
  max_durability bigint CHECK(max_durability BETWEEN 0 AND 9007199254740991),
  version integer NOT NULL DEFAULT 1,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(mode<>'individual' OR quantity<=1),
  CHECK(kind<>'equipment' OR mode='individual'),
  CHECK((status='lost' AND quantity=0 AND slot IS NULL) OR (status='owned' AND quantity>0)),
  CHECK(slot IS NULL OR (kind='equipment' AND mode='individual' AND quantity=1 AND status='owned')),
  CHECK(durability IS NULL OR max_durability IS NULL OR durability<=max_durability),
  UNIQUE(game_id,id),UNIQUE(game_id,acquisition_key),
  FOREIGN KEY(game_id,definition_id,kind) REFERENCES game_definitions(game_id,id,kind),
  FOREIGN KEY(game_id,definition_id,definition_version) REFERENCES game_definition_versions(game_id,definition_id,version)
);
CREATE UNIQUE INDEX inventory_equipped_slot ON inventory_entries(game_id,slot) WHERE slot IS NOT NULL;
CREATE TABLE content_change_entries (
  sequence bigserial PRIMARY KEY,
  game_id uuid NOT NULL,
  update_id uuid NOT NULL,ordinal integer NOT NULL,
  target_type text NOT NULL CHECK(target_type IN ('definition','feature','inventory')),
  target_id uuid NOT NULL,reason text NOT NULL,
  before_state jsonb,after_state jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(update_id,ordinal),
  FOREIGN KEY(game_id,update_id) REFERENCES gm_updates(game_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX content_change_target ON content_change_entries(game_id,target_id,sequence);
CREATE TRIGGER game_definition_versions_immutable BEFORE UPDATE OR DELETE ON game_definition_versions FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER content_change_entries_immutable BEFORE UPDATE OR DELETE ON content_change_entries FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
COMMIT;
