BEGIN;
SET LOCAL search_path = liferpg_v2;
ALTER TABLE attempts ADD COLUMN provider text NOT NULL DEFAULT 'mock' CHECK(provider IN ('mock','openai'));
ALTER TABLE attempts ADD COLUMN usage_details jsonb;
ALTER TABLE attempts ADD COLUMN price_card jsonb;
ALTER TABLE attempts ADD COLUMN settled_at timestamptz;
CREATE TABLE gm_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  lifetime_limit bigint NOT NULL DEFAULT 0 CHECK(lifetime_limit>=0),
  daily_limit bigint NOT NULL DEFAULT 0 CHECK(daily_limit>=0),
  monthly_limit bigint NOT NULL DEFAULT 0 CHECK(monthly_limit>=0)
);
INSERT INTO gm_budget(id) VALUES(true);
CREATE INDEX attempts_provider_created ON attempts(provider,created_at);
COMMIT;
