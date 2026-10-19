-- 0037: Phase 2F M2D.2 free-first correction: provider identity from the APPLICATION registry, cost provenance,
-- and room for local-capture inputs. 0036 is applied and is not edited (migration policy: fix forward).
--
--   reconstruction_jobs.provider        no longer a closed list. 0036 named three ids (one, 'meshy', had no adapter),
--                                       so every new provider (e.g. the M2D.3 'local_capture') would have needed a
--                                       migration. The database now only guarantees a bounded, safe identifier;
--                                       the server-side provider registry decides which ids are known, enabled,
--                                       local or hosted, free or paid. Rows naming a provider the registry no longer
--                                       has stay valid history and remain readable.
--   location_spatial_reconstructions.provider
--                                       the same identifier rule for generated provenance (it had none).
--   reconstruction_jobs.source_assets_json
--                                       1..300 ordered inputs (was 1..8). The 8-image limit was World Labs', not
--                                       Prism's: each provider declares its own maximum and the server enforces it.
--                                       A local capture (M2D.3) needs tens to hundreds of photos, or one video.
--   reconstruction_jobs.cost_estimate_json
--                                       the cost Prism showed and checked BEFORE submitting (cost class, provider
--                                       units, USD range when the provider publishes the conversion, the pricing
--                                       source and the date it was checked). Frozen at creation like the request.
--                                       NULL = no estimate was recorded (every job created before 0037).
--   reconstruction_jobs.cost_actual_json
--                                       what the provider REPORTED it charged, when it reports it. NULL = not
--                                       reported. Never derived or invented by Prism.
--
-- Authority unchanged: owner-only RLS, no worker grant. Forward-only; 0019-0036 untouched.

alter table reconstruction_jobs drop constraint reconstruction_jobs_provider_check;
alter table reconstruction_jobs add constraint reconstruction_jobs_provider_check
  check (provider ~ '^[a-z][a-z0-9_]{0,63}$');

alter table location_spatial_reconstructions add constraint location_spatial_reconstructions_provider_check
  check (provider is null or provider ~ '^[a-z][a-z0-9_]{0,63}$');

alter table reconstruction_jobs drop constraint reconstruction_jobs_source_assets_json_check;
alter table reconstruction_jobs add constraint reconstruction_jobs_source_assets_json_check
  check (jsonb_typeof(source_assets_json) = 'array' and jsonb_array_length(source_assets_json) between 1 and 300);

alter table reconstruction_jobs
  add column cost_estimate_json jsonb check (cost_estimate_json is null or
                                             (jsonb_typeof(cost_estimate_json) = 'object'
                                              and octet_length(cost_estimate_json::text) <= 2048)),
  add column cost_actual_json   jsonb check (cost_actual_json is null or
                                             (jsonb_typeof(cost_actual_json) = 'object'
                                              and octet_length(cost_actual_json::text) <= 2048));

-- 0036's guard, plus: the cost estimate is part of the frozen request.
create or replace function guard_reconstruction_job() returns trigger
language plpgsql as $$
declare allowed text[];
begin
  if old.status in ('succeeded', 'failed', 'cancelled') then
    raise exception 'a finished reconstruction job is immutable history';
  end if;
  if new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.location_id is distinct from old.location_id or new.schema_version is distinct from old.schema_version
     or new.job_fingerprint is distinct from old.job_fingerprint or new.attempt is distinct from old.attempt
     or new.previous_job_id is distinct from old.previous_job_id or new.provider is distinct from old.provider
     or new.provider_capability is distinct from old.provider_capability
     or new.provider_model is distinct from old.provider_model
     or new.requested_result_kind is distinct from old.requested_result_kind
     or new.source_assets_json is distinct from old.source_assets_json
     or new.options_json is distinct from old.options_json
     or new.cost_estimate_json is distinct from old.cost_estimate_json
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'a reconstruction job''s request is frozen at creation';
  end if;
  if old.provider_operation_id is not null and new.provider_operation_id is distinct from old.provider_operation_id then
    raise exception 'a provider operation id is never replaced (retry creates a new attempt)';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'reconstruction job revision must advance by exactly one';
  end if;
  allowed := case old.status
    when 'draft' then array['queued', 'cancelled']
    when 'queued' then array['submitting', 'failed', 'cancelled']
    when 'submitting' then array['running', 'failed']
    when 'running' then array['running', 'ingesting', 'failed', 'cancelled']
    when 'ingesting' then array['succeeded', 'failed']
    else array[]::text[]
  end;
  if new.status <> old.status and not (new.status = any (allowed)) then
    raise exception 'reconstruction job transition % -> % is not allowed', old.status, new.status;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
