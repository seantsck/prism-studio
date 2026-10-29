-- 0045: explicit full-video consent for temporal Shot QA (Phase 3A.3).
--
--   project_qa_policies.direct_video_allowed   The Project owner allows Prism to send the FULL selected delivery video
--                                              to the chosen semantic analyzer for temporal Shot QA (camera movement,
--                                              action beats, screen direction, eyelines, geography, forbidden actions).
--
-- This is broader than the bounded review frames / references that 3A.2's `external_media_allowed` covers, so it is
-- a SEPARATE, explicit permission. The default is false and every existing row gets false: no Project that enabled
-- automatic semantic QA in 3A.2 starts sending full videos because new application code was deployed.
--
-- No new table, no new grant (the column inherits the table's owner-only RLS; anon and both worker roles still have
-- no privilege on project_qa_policies). The continuity worker never reads it: the signed-in application freezes the
-- decision into the job's plan. Forward-only; 0001-0044 untouched.

alter table project_qa_policies
  add column direct_video_allowed boolean not null default false;
