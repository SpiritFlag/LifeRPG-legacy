BEGIN;
SET LOCAL search_path = liferpg_v2;
ALTER TABLE attempts ADD COLUMN gm_api_ms bigint CHECK(gm_api_ms>=0);
ALTER TABLE requests ADD COLUMN finalized_at timestamptz;
ALTER TABLE requests ADD COLUMN total_ms bigint CHECK(total_ms>=0);
COMMIT;
