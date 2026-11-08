-- 0051: Phase 5B-I1 generation subjects (image pipeline).
--
-- A generation attempt has always belonged to a Shot. The image-first workflow also generates images FOR a Character
-- (portraits, identity and Look references) and FOR a Location (concepts, establishing views, alternate angles).
-- Those reuse the whole existing pipeline (attempt -> job -> worker -> provider -> ingest -> outputs, costs, reviews);
-- only the attempt's subject changes.
--
--   * generation_attempts.shot_id becomes nullable; character_id / location_id are added. EXACTLY ONE subject is set
--     on every row (check). Every existing row keeps its shot and is unchanged.
--   * Subjects stay in their project: composite foreign keys (subject id, project_id), as elsewhere.
--   * A Character / Location attempt is an IMAGE generation, and it is never the Shot's approved output
--     (approval stays a Shot concept; "use as reference" is an explicit, separate act).
--   * Attempts are numbered per subject (partial unique indexes beside the existing unique (shot_id, attempt_number)).
--   * The subject is immutable like the rest of the attempt's creative request (append-only history guard).
--
-- Additive for Shot attempts: no row is rewritten, no policy or grant changes (RLS is project-owner on project_id; the
-- worker role already reads every attempt column it is granted), no SECURITY DEFINER.
-- Compatibility: application code from before 0051 assumes shot_id is set. Do not CREATE a Character/Location attempt
-- in a database that older code still reads (see docs/phase-5b-image-pipeline.md).

alter table generation_attempts alter column shot_id drop not null;

alter table generation_attempts
  add column character_id uuid,
  add column location_id uuid;

alter table generation_attempts
  add constraint generation_attempts_character_fk
    foreign key (character_id, project_id) references characters (id, project_id) on delete cascade,
  add constraint generation_attempts_location_fk
    foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  add constraint generation_attempts_one_subject
    check (num_nonnulls(shot_id, character_id, location_id) = 1),
  add constraint generation_attempts_subject_is_image
    check (shot_id is not null or modality = 'image'),
  add constraint generation_attempts_subject_never_approved
    check (shot_id is not null or approved = false);

create unique index attempts_character_number on generation_attempts (character_id, attempt_number)
  where character_id is not null;
create unique index attempts_location_number on generation_attempts (location_id, attempt_number)
  where location_id is not null;

-- the 0019 guard, plus the two new subject columns (everything else is identical)
create or replace function guard_attempt_history() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.shot_id is distinct from old.shot_id
     or new.character_id is distinct from old.character_id
     or new.location_id is distinct from old.location_id
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

-- 0051 shared-database compatibility gate: a generated Character / Location image is deletable when nothing in the
-- project references it (the app's asset-usage guard decides that). Its OWN attempt is provenance, not a use: the
-- attempt row is kept (output_asset_id is set null by its existing key) and only the subject attempt's output link is
-- dropped, atomically with the Asset delete. Shot attempt outputs are NEVER released here, so their key still refuses
-- the delete exactly as before. SECURITY DEFINER because the project owner has no delete grant on generation_outputs.
create or replace function release_subject_image_outputs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from generation_outputs o
   using generation_attempts a
   where o.asset_id = old.id
     and o.project_id = old.project_id
     and a.id = o.attempt_id
     and a.project_id = o.project_id
     and a.shot_id is null;
  return old;
end;
$$;
revoke all on function release_subject_image_outputs() from public;

create trigger assets_release_subject_image_outputs
  before delete on assets
  for each row execute function release_subject_image_outputs();
