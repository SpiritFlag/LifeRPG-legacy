BEGIN;
-- Existing stories stay one-time; no live tasks or rewards are created.
ALTER TABLE questlines
  ADD COLUMN real_task text NOT NULL DEFAULT '' CHECK(length(real_task)<=500),
  ADD COLUMN recurrence text DEFAULT NULL CHECK(recurrence IS NULL OR (length(btrim(recurrence)) BETWEEN 1 AND 500)),
  ADD CONSTRAINT questline_repeat_task CHECK(recurrence IS NULL OR length(btrim(real_task))>0);
ALTER TABLE quest_nodes
  ADD COLUMN real_task text NOT NULL DEFAULT '' CHECK(length(real_task)<=500),
  ADD COLUMN recurrence text DEFAULT NULL CHECK(recurrence IS NULL OR (length(btrim(recurrence)) BETWEEN 1 AND 500)),
  ADD CONSTRAINT quest_node_repeat_task CHECK(recurrence IS NULL OR length(btrim(real_task))>0);
COMMIT;
