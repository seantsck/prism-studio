-- 0069: cover art for a project. A cover is a generated IMAGE whose subject is the project itself (no Shot, Character
-- or Location), made on the existing pipeline (attempt -> job -> worker -> provider -> ingest -> outputs, costs).
--
--   * generation_attempts.project_cover marks such an attempt. A row is a cover XOR it has exactly one subject; every
--     existing row (project_cover = false) keeps exactly one subject, as 0051 requires.
--   * A cover is an image, never approved (the 0051 checks already say so for every attempt without a Shot).
--   * Covers are numbered per project (partial unique index beside the per-subject ones).
--   * project_cover is immutable like the rest of the attempt's creative request (the append-only history guard).
--
-- Additive: no row is rewritten, no policy or grant changes (RLS is project-owner on project_id; the worker role has
-- select on the whole table and never reads the subject). The app writes project_cover only on a cover attempt, so
-- code that ships before this migration keeps working (making a cover then says it needs this update).

alter table generation_attempts add column if not exists project_cover boolean not null default false;

alter table generation_attempts drop constraint if exists generation_attempts_one_subject;
alter table generation_attempts
  add constraint generation_attempts_one_subject
    check (
      (not project_cover and num_nonnulls(shot_id, character_id, location_id) = 1)
      or (project_cover and num_nonnulls(shot_id, character_id, location_id) = 0)
    );

create unique index if not exists attempts_cover_number on generation_attempts (project_id, attempt_number)
  where project_cover;

-- the 0051 guard, plus project_cover (everything else is identical)
create or replace function guard_attempt_history() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.shot_id is distinct from old.shot_id
     or new.character_id is distinct from old.character_id
     or new.location_id is distinct from old.location_id
     or new.project_cover is distinct from old.project_cover
     or new.attempt_number is distinct from old.attempt_number
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.modality is distinct from old.modality
     or new.request_modality is distinct from old.request_modality
     or new.prompt is distinct from old.prompt
     or new.negative_prompt is distinct from old.negative_prompt
     or new.package_snapshot is distinct from old.package_snapshot
     or new.package_fingerprint is distinct from old.package_fingerprint
     or new.prompt_plan is distinct from old.prompt_plan
     or new.request is distinct from old.request
     or new.compatibility is distinct from old.compatibility
     or new.acknowledged_ignored is distinct from old.acknowledged_ignored
     or new.adaptation_plan is distinct from old.adaptation_plan
     or new.model_settings is distinct from old.model_settings
     or new.input_asset_ids is distinct from old.input_asset_ids then
    raise exception 'generation attempt % is append-only; only execution and review fields may change', old.id;
  end if;
  return new;
end;
$$;
