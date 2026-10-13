-- 0012: generation attempts become the immutable CREATIVE record; review is separated from execution.
--
--   Before: generation_attempts.status mixed execution ('queued','running','succeeded','failed') with review
--           ('rejected','approved'). A successful generation is not an approved shot, and a rejected one did
--           execute, so these are two independent state machines.
--   After:  status        EXECUTION outcome mirrored from the job (queued|running|succeeded|failed|cancelled)
--           review_status REVIEW outcome (unreviewed|approved|rejected) + structured rejection_categories
--           the frozen creative request (prompt_plan, request, compatibility, acknowledged_ignored) is immutable.
-- Operational state lives in generation_jobs (0013). Outputs and costs: 0014.

alter table generation_attempts add column review_status text not null default 'unreviewed'
  check (review_status in ('unreviewed', 'approved', 'rejected'));
alter table generation_attempts add column rejection_categories text[] not null default '{}';
alter table generation_attempts add column reviewed_at timestamptz;
alter table generation_attempts add column request_modality text
  check (request_modality in (
    'text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'video_to_video',
    'audio_to_video', 'lip_sync', 'voice', 'upscale'
  ));
alter table generation_attempts add column prompt_plan jsonb;
alter table generation_attempts add column request jsonb;
alter table generation_attempts add column compatibility jsonb;
alter table generation_attempts add column acknowledged_ignored text[] not null default '{}';
alter table generation_attempts add column created_by uuid references auth.users (id) on delete set null;

-- Backfill review state from the legacy combined status / approved flag.
update generation_attempts set review_status = 'approved', reviewed_at = created_at where approved or status = 'approved';
update generation_attempts set review_status = 'rejected', reviewed_at = created_at where status = 'rejected' and not approved;
update generation_attempts set status = 'succeeded' where status in ('approved', 'rejected');
update generation_attempts set approved = true where review_status = 'approved';

-- Replace the single-column status check with the execution-only vocabulary.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'generation_attempts'::regclass
      and con.contype = 'c'
      and att.attname = 'status'
      and array_length(con.conkey, 1) = 1
  loop
    execute format('alter table generation_attempts drop constraint %I', c.conname);
  end loop;
end $$;

alter table generation_attempts add constraint generation_attempts_status_check
  check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'));

alter table generation_attempts add constraint generation_attempts_approved_matches_review
  check (approved = (review_status = 'approved'));

-- Composite keys so child rows (jobs, outputs, costs) can be tied to a parent IN THE SAME PROJECT by a
-- plain foreign key: a job/output can never point at another project's attempt or asset.
alter table generation_attempts add constraint generation_attempts_id_project_key unique (id, project_id);
alter table assets add constraint assets_id_project_key unique (id, project_id);

-- History guard: the creative request is append-only. Only execution results (status, output, cost, duration)
-- and review fields may change after insert.
create or replace function guard_attempt_history() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.shot_id is distinct from old.shot_id
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
     or new.model_settings is distinct from old.model_settings
     or new.input_asset_ids is distinct from old.input_asset_ids then
    raise exception 'generation attempt % is append-only; only execution and review fields may change', old.id;
  end if;
  return new;
end;
$$;

create index attempts_project_review_idx on generation_attempts (project_id, review_status, created_at desc);
