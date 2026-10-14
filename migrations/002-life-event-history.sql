BEGIN;
-- Run once, after 001. Preserve existing IDs, facts, timestamps and OAuth data.
ALTER TABLE life_events
  ALTER COLUMN occurred_on DROP NOT NULL,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN occurred_start timestamptz,
  ADD COLUMN occurred_end timestamptz,
  ADD COLUMN time_precision text NOT NULL DEFAULT 'date',
  ADD COLUMN timezone text DEFAULT 'Asia/Seoul',
  ADD COLUMN reported_at timestamptz,
  ADD COLUMN facts jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN unknowns jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN updated_at timestamptz;
UPDATE life_events SET updated_at=recorded_at;
ALTER TABLE life_events ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE life_events ADD CONSTRAINT life_events_time_check CHECK (
  (time_precision='unknown' AND occurred_on IS NULL AND occurred_start IS NULL AND occurred_end IS NULL) OR
  (time_precision='date' AND occurred_on IS NOT NULL AND occurred_start IS NULL AND occurred_end IS NULL) OR
  (time_precision='exact' AND occurred_on IS NOT NULL AND occurred_start IS NOT NULL AND occurred_end IS NULL) OR
  (time_precision='range' AND occurred_on IS NOT NULL AND occurred_start IS NOT NULL AND occurred_end IS NOT NULL AND occurred_start <= occurred_end)
);
ALTER TABLE life_events ADD CONSTRAINT life_events_facts_check CHECK (jsonb_typeof(facts)='array' AND jsonb_typeof(unknowns)='array');

-- Also reserve past identities and unknown dates. The old UNIQUE stays intact.
CREATE TABLE life_event_aliases (
  kind text NOT NULL CHECK (kind IN ('real','test')),
  occurred_on date,
  event_key text NOT NULL,
  event_id uuid NOT NULL REFERENCES life_events(id),
  UNIQUE NULLS NOT DISTINCT (kind, occurred_on, event_key)
);
CREATE INDEX life_event_aliases_event ON life_event_aliases(event_id);
INSERT INTO life_event_aliases SELECT kind,occurred_on,event_key,id FROM life_events;

CREATE TABLE life_event_requests (
  request_key text PRIMARY KEY,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE life_event_revisions (
  event_id uuid NOT NULL REFERENCES life_events(id),
  version integer NOT NULL CHECK (version > 0),
  operation text NOT NULL CHECK (operation IN ('import','create','enrich','correct')),
  reason text NOT NULL,
  evidence text NOT NULL,
  reported_at timestamptz,
  report_time_source text NOT NULL CHECK (report_time_source IN ('message','unknown')),
  source_ref text,
  before_state jsonb,
  after_state jsonb NOT NULL,
  request_key text REFERENCES life_event_requests(request_key) DEFERRABLE INITIALLY DEFERRED,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(event_id,version),
  CHECK ((reported_at IS NULL AND report_time_source='unknown') OR (reported_at IS NOT NULL AND report_time_source='message'))
);
INSERT INTO life_event_revisions(event_id,version,operation,reason,evidence,report_time_source,after_state,recorded_at)
  SELECT id,version,'import','Legacy baseline; original message time is unknown',evidence,'unknown',to_jsonb(life_events),recorded_at FROM life_events;

CREATE FUNCTION protect_life_event_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Life event history is append-only';
END;
$$;
CREATE TRIGGER life_event_revisions_immutable BEFORE UPDATE OR DELETE ON life_event_revisions FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER life_event_aliases_immutable BEFORE UPDATE OR DELETE ON life_event_aliases FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
CREATE TRIGGER life_event_requests_immutable BEFORE UPDATE OR DELETE ON life_event_requests FOR EACH ROW EXECUTE FUNCTION protect_life_event_history();
COMMIT;
