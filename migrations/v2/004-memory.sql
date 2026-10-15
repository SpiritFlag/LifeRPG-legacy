BEGIN;
SET LOCAL search_path=liferpg_v2;
ALTER TABLE memories ADD COLUMN claim_type text NOT NULL DEFAULT 'interpretation'
  CHECK(claim_type IN ('interpretation','canon','npc_claim','mixed'));
ALTER TABLE memories ADD COLUMN importance integer NOT NULL DEFAULT 1 CHECK(importance BETWEEN 0 AND 3);
ALTER TABLE memories ADD COLUMN unresolved boolean NOT NULL DEFAULT false;
ALTER TABLE memories ADD COLUMN previous_identity uuid;
ALTER TABLE memories ADD CONSTRAINT previous_identity_owner FOREIGN KEY(owner_id,previous_identity) REFERENCES memories(owner_id,id);
CREATE TABLE memory_sources (
  owner_id text NOT NULL, memory_id uuid NOT NULL, source_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('context','summary')),
  PRIMARY KEY(memory_id,source_id),
  FOREIGN KEY(owner_id,memory_id) REFERENCES memories(owner_id,id),
  FOREIGN KEY(owner_id,source_id) REFERENCES memories(owner_id,id)
);
CREATE INDEX memory_selection ON memories(owner_id,active,kind,importance,created_at DESC);
CREATE INDEX memory_source_lookup ON memory_sources(owner_id,source_id);
COMMIT;
