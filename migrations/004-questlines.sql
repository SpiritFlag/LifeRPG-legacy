BEGIN;
-- Additive migration after 003. Does not create any actual or synthetic story.
CREATE TABLE questlines (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL REFERENCES games(id),
  line_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  goal text NOT NULL,
  progress text NOT NULL,
  ending text NOT NULL,
  status text NOT NULL CHECK(status IN ('available','active','paused','completed','failed','abandoned')),
  version integer NOT NULL DEFAULT 1,
  UNIQUE(game_id,id),
  UNIQUE(game_id,line_key)
);
CREATE TABLE quest_nodes (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL,
  questline_id uuid NOT NULL,
  node_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('chapter','quest')),
  parent_id uuid,
  title text NOT NULL,
  description text NOT NULL,
  goal text NOT NULL,
  progress text NOT NULL,
  ending text NOT NULL,
  status text NOT NULL CHECK(status IN ('available','active','paused','completed','failed','abandoned')),
  version integer NOT NULL DEFAULT 1,
  CHECK(kind='quest' OR parent_id IS NULL),
  CHECK(parent_id IS DISTINCT FROM id),
  UNIQUE(game_id,id),
  UNIQUE(game_id,questline_id,id),
  UNIQUE(game_id,questline_id,node_key),
  FOREIGN KEY(game_id,questline_id) REFERENCES questlines(game_id,id),
  FOREIGN KEY(game_id,questline_id,parent_id) REFERENCES quest_nodes(game_id,questline_id,id)
);
CREATE TABLE quest_node_links (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL,
  questline_id uuid NOT NULL,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('prerequisite','branch')),
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  CHECK(from_id<>to_id),
  UNIQUE(game_id,from_id,to_id,kind),
  FOREIGN KEY(game_id,questline_id,from_id) REFERENCES quest_nodes(game_id,questline_id,id),
  FOREIGN KEY(game_id,questline_id,to_id) REFERENCES quest_nodes(game_id,questline_id,id)
);
CREATE TABLE questline_links (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL,
  from_id uuid NOT NULL,
  to_id uuid NOT NULL,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  CHECK(from_id<>to_id),
  UNIQUE(game_id,from_id,to_id),
  FOREIGN KEY(game_id,from_id) REFERENCES questlines(game_id,id),
  FOREIGN KEY(game_id,to_id) REFERENCES questlines(game_id,id)
);
CREATE TABLE event_quest_links (
  id uuid PRIMARY KEY,
  sequence bigserial NOT NULL UNIQUE,
  game_id uuid NOT NULL,
  questline_id uuid NOT NULL,
  node_id uuid,
  event_id uuid NOT NULL,
  event_version integer NOT NULL,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT(game_id,questline_id,node_id,event_id),
  FOREIGN KEY(game_id,questline_id) REFERENCES questlines(game_id,id),
  FOREIGN KEY(game_id,questline_id,node_id) REFERENCES quest_nodes(game_id,questline_id,id),
  FOREIGN KEY(event_id,event_version) REFERENCES life_event_revisions(event_id,version)
);
CREATE INDEX event_quest_links_event ON event_quest_links(event_id);
CREATE TABLE quest_change_entries (
  sequence bigserial PRIMARY KEY,
  game_id uuid NOT NULL,
  update_id uuid NOT NULL,
  ordinal integer NOT NULL,
  questline_id uuid NOT NULL,
  target_type text NOT NULL CHECK(target_type IN ('line','node','node_link','line_link','event_link')),
  target_id uuid NOT NULL,
  reason text NOT NULL,
  retained_children jsonb NOT NULL DEFAULT '[]',
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  before_state jsonb,
  after_state jsonb NOT NULL,
  UNIQUE(update_id,ordinal),
  FOREIGN KEY(game_id,questline_id) REFERENCES questlines(game_id,id),
  FOREIGN KEY(game_id,update_id) REFERENCES gm_updates(game_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX quest_change_entries_line ON quest_change_entries(game_id,questline_id,sequence);
CREATE TRIGGER quest_change_entries_immutable BEFORE UPDATE OR DELETE ON quest_change_entries FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
COMMIT;
