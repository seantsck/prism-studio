-- 0019: Phase 2C framing adaptation.
--
--   * generation_attempts.adaptation_plan  the frozen GenerationAdaptationPlan: how production framing/duration
--     were adapted to the provider (NULL for attempts created before Phase 2C: never back-filled, never guessed).
--     Immutable like the rest of the creative request.
--   * project_bibles                       optional explicit production format (delivery size, codec, audio
--     rate). Aspect ratio stays the canonical statement of the format; all four are NULL until someone sets them.
--
-- Additive and backward compatible: older application code ignores the new columns.

alter table generation_attempts add column adaptation_plan jsonb;

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
     or new.adaptation_plan is distinct from old.adaptation_plan
     or new.model_settings is distinct from old.model_settings
     or new.input_asset_ids is distinct from old.input_asset_ids then
    raise exception 'generation attempt % is append-only; only execution and review fields may change', old.id;
  end if;
  return new;
end;
$$;

alter table project_bibles
  add column delivery_width     integer check (delivery_width is null or delivery_width between 2 and 16384),
  add column delivery_height    integer check (delivery_height is null or delivery_height between 2 and 16384),
  add column target_codec       text,
  add column audio_sample_rate  integer check (audio_sample_rate is null or audio_sample_rate between 8000 and 192000),
  add constraint project_bibles_delivery_size_pair
    check ((delivery_width is null) = (delivery_height is null));
