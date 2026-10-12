-- 0009: freshness / stale-asset signals.
--   storyboard_frames.approved_fingerprint  fingerprint of the shot's visual inputs when the frame was approved
--   generation_attempts.package_fingerprint fingerprint of the package the attempt was built from (immutable)

alter table storyboard_frames add column approved_fingerprint text;
alter table storyboard_frames add column approved_at timestamptz;

alter table generation_attempts add column package_fingerprint text not null default '';

create or replace function guard_attempt_history() returns trigger
language plpgsql as $$
begin
  if new.prompt is distinct from old.prompt
     or new.negative_prompt is distinct from old.negative_prompt
     or new.package_snapshot is distinct from old.package_snapshot
     or new.package_fingerprint is distinct from old.package_fingerprint
     or new.model_settings is distinct from old.model_settings
     or new.input_asset_ids is distinct from old.input_asset_ids
     or new.shot_id is distinct from old.shot_id
     or new.attempt_number is distinct from old.attempt_number then
    raise exception 'generation attempt % is append-only; only review fields may change', old.id;
  end if;
  return new;
end;
$$;
