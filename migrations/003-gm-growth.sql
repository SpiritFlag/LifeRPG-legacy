BEGIN;
-- Additive, run once after 002. No game/character is created by migration.
CREATE TABLE games (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('real','test')),
  revision integer NOT NULL CHECK (revision > 0),
  rules_version text NOT NULL CHECK (rules_version='growth-v1'),
  initialized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE characters (
  game_id uuid PRIMARY KEY REFERENCES games(id),
  label text NOT NULL,
  xp_total bigint NOT NULL CHECK (xp_total BETWEEN 0 AND 9007199254740991),
  str bigint NOT NULL CHECK (str BETWEEN 0 AND 9007199254740991),
  dex bigint NOT NULL CHECK (dex BETWEEN 0 AND 9007199254740991),
  vit bigint NOT NULL CHECK (vit BETWEEN 0 AND 9007199254740991),
  int bigint NOT NULL CHECK (int BETWEEN 0 AND 9007199254740991),
  cha bigint NOT NULL CHECK (cha BETWEEN 0 AND 9007199254740991),
  luk bigint NOT NULL CHECK (luk BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE gm_updates (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id),
  request_key text NOT NULL,
  input_hash text NOT NULL,
  reason text NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(game_id,request_key),
  UNIQUE(game_id,id)
);
CREATE TABLE gm_adjudications (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL REFERENCES games(id),
  update_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('event','event_group')),
  subject_key text NOT NULL,
  subject_event_id uuid REFERENCES life_events(id),
  aspect_key text NOT NULL,
  basis_hash text NOT NULL,
  effect_hash text NOT NULL,
  previous_id uuid,
  correction_of uuid,
  reason text NOT NULL,
  xp_delta bigint NOT NULL CHECK (xp_delta BETWEEN -9007199254740991 AND 9007199254740991),
  stats_delta jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((subject_type='event' AND subject_event_id IS NOT NULL AND subject_key=subject_event_id::text) OR (subject_type='event_group' AND subject_event_id IS NULL)),
  UNIQUE(game_id,id),
  UNIQUE NULLS NOT DISTINCT(game_id,subject_type,subject_key,aspect_key,basis_hash,correction_of),
  FOREIGN KEY(game_id,update_id) REFERENCES gm_updates(game_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(game_id,previous_id) REFERENCES gm_adjudications(game_id,id),
  FOREIGN KEY(game_id,correction_of) REFERENCES gm_adjudications(game_id,id)
);
CREATE UNIQUE INDEX gm_adjudications_root ON gm_adjudications(game_id,subject_type,subject_key,aspect_key) WHERE previous_id IS NULL;
CREATE UNIQUE INDEX gm_adjudications_successor ON gm_adjudications(game_id,previous_id) WHERE previous_id IS NOT NULL;
CREATE INDEX gm_adjudications_topic ON gm_adjudications(game_id,subject_type,subject_key,aspect_key,sequence DESC);
CREATE TABLE gm_adjudication_sources (
  adjudication_id uuid NOT NULL REFERENCES gm_adjudications(id),
  event_id uuid NOT NULL,
  event_version integer NOT NULL,
  PRIMARY KEY(adjudication_id,event_id),
  FOREIGN KEY(event_id,event_version) REFERENCES life_event_revisions(event_id,version)
);
CREATE INDEX gm_adjudication_sources_event ON gm_adjudication_sources(event_id);
CREATE TABLE gm_change_entries (
  game_id uuid NOT NULL REFERENCES games(id),
  update_id uuid NOT NULL,
  ordinal integer NOT NULL,
  adjudication_id uuid REFERENCES gm_adjudications(id),
  before_state jsonb,
  after_state jsonb NOT NULL,
  xp_delta bigint NOT NULL,
  stats_delta jsonb NOT NULL,
  level_delta integer NOT NULL,
  PRIMARY KEY(update_id,ordinal),
  FOREIGN KEY(game_id,update_id) REFERENCES gm_updates(game_id,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(game_id,adjudication_id) REFERENCES gm_adjudications(game_id,id)
);
CREATE TRIGGER gm_updates_immutable BEFORE UPDATE OR DELETE ON gm_updates FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER gm_adjudications_immutable BEFORE UPDATE OR DELETE ON gm_adjudications FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER gm_adjudication_sources_immutable BEFORE UPDATE OR DELETE ON gm_adjudication_sources FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER gm_change_entries_immutable BEFORE UPDATE OR DELETE ON gm_change_entries FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();

-- Phase 1 writers participate in version invalidation without changing their API.
CREATE FUNCTION advance_game_event_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    UPDATE games SET revision=revision+1,updated_at=clock_timestamp() WHERE kind=NEW.kind;
  ELSIF NEW.version<>OLD.version THEN
    UPDATE games SET revision=revision+1,updated_at=clock_timestamp() WHERE kind=NEW.kind OR kind=OLD.kind;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER life_events_game_revision AFTER INSERT OR UPDATE ON life_events FOR EACH ROW EXECUTE FUNCTION advance_game_event_revision();
COMMIT;
