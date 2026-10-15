BEGIN;
SET LOCAL search_path = liferpg_v2;
ALTER TABLE games ADD COLUMN world_tick bigint NOT NULL DEFAULT 0 CHECK(world_tick BETWEEN 0 AND 9007199254740991);
CREATE TABLE rpg_entities (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES games(owner_id),
  kind text NOT NULL CHECK(kind IN ('character','profession','skill','trait','title','achievement','item','equipment','holding','quest','npc','place','faction','relation','world_event')),
  version integer NOT NULL CHECK(version>0), public_payload uuid, private_payload uuid,
  retired boolean NOT NULL DEFAULT false, needs_reinterpretation boolean NOT NULL DEFAULT false,
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,public_payload) REFERENCES payloads(owner_id,id) ON DELETE SET NULL(public_payload),
  FOREIGN KEY(owner_id,private_payload) REFERENCES payloads(owner_id,id) ON DELETE SET NULL(private_payload)
);
CREATE UNIQUE INDEX one_rpg_character ON rpg_entities(owner_id) WHERE kind='character';
CREATE TABLE rpg_versions (
  owner_id text NOT NULL, entity_id uuid NOT NULL, version integer NOT NULL,
  public_payload uuid, private_payload uuid, PRIMARY KEY(entity_id,version),
  FOREIGN KEY(owner_id,entity_id) REFERENCES rpg_entities(owner_id,id),
  FOREIGN KEY(owner_id,public_payload) REFERENCES payloads(owner_id,id) ON DELETE SET NULL(public_payload),
  FOREIGN KEY(owner_id,private_payload) REFERENCES payloads(owner_id,id) ON DELETE SET NULL(private_payload)
);
CREATE TABLE rpg_reward_claims (
  owner_id text NOT NULL, source_id uuid NOT NULL, request_id uuid NOT NULL,
  PRIMARY KEY(owner_id,source_id),
  FOREIGN KEY(owner_id,source_id) REFERENCES rpg_entities(owner_id,id),
  FOREIGN KEY(owner_id,request_id) REFERENCES requests(owner_id,id)
);
COMMIT;
