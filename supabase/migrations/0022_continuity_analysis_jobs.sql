-- 0022: durable continuity analysis (Phase 2D): execution jobs + a dedicated least-privilege worker role.
--
--   continuity_runs            IMMUTABLE analytical history (0021). Gains the frozen analysis plan, the external
--                              media manifest and the prompt/rubric/model identity (set at creation, then frozen).
--   continuity_analysis_jobs   MUTABLE execution state: queue, lease, retries, provider interaction state.
--                              The frozen input snapshot lives here and never changes after submission.
--
-- Trust model:   browser/user → authenticated server action → frozen run + authorised job → CONTINUITY WORKER.
-- `prism_continuity_worker` is a DIFFERENT role from `prism_generation_worker`: neither can see the other's
-- tables. It cannot touch creative content, generation, overrides, bibles, scripts or approvals; it reads only the
-- frozen job + the assets that job names, and writes execution state and normalized findings.
-- Created NOLOGIN with no password (credentials are provisioned out of band: `npm run continuity:db:provision`).

alter table continuity_runs
  add column analysis_plan      jsonb,
  add column external_manifest  jsonb,
  add column prompt_version     text,
  add column rubric_version     text,
  add column model              text;

create or replace function guard_continuity_run() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.attempt_id is distinct from old.attempt_id
     or new.run_number is distinct from old.run_number
     or new.subject_asset_id is distinct from old.subject_asset_id
     or new.original_asset_id is distinct from old.original_asset_id
     or new.analyzer is distinct from old.analyzer
     or new.analyzer_version is distinct from old.analyzer_version
     or new.analyzer_kind is distinct from old.analyzer_kind
     or new.rules_version is distinct from old.rules_version
     or new.package_fingerprint is distinct from old.package_fingerprint
     or new.subject_fingerprint is distinct from old.subject_fingerprint
     or new.criteria_fingerprint is distinct from old.criteria_fingerprint
     or new.reference_fingerprint is distinct from old.reference_fingerprint
     or new.reference_set is distinct from old.reference_set
     or new.analysis_plan is distinct from old.analysis_plan
     or new.external_manifest is distinct from old.external_manifest
     or new.prompt_version is distinct from old.prompt_version
     or new.rubric_version is distinct from old.rubric_version
     or new.model is distinct from old.model then
    raise exception 'continuity run % is a frozen snapshot; only analysis status and review close-out may change', old.id;
  end if;
  return new;
end;
$$;

create table continuity_analysis_jobs (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  run_id               uuid not null,
  attempt_id           uuid not null,
  analyzer             text not null,
  model                text not null,
  status               text not null default 'queued'
    check (status in ('queued', 'claimed', 'processing', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
  -- the frozen ContinuityAnalysisInput: ids, checksums, criteria, plan. No URLs, no bytes, no credentials.
  input_snapshot       jsonb not null,
  -- every asset the analysis may read (what the worker's RLS policy keys on)
  input_asset_ids      uuid[] not null default '{}',
  idempotency_key      text not null check (char_length(idempotency_key) >= 8),
  next_run_at          timestamptz not null default now(),
  attempt_count        integer not null default 0 check (attempt_count >= 0),
  max_attempts         integer not null default 3 check (max_attempts > 0),
  lease_owner          text,
  lease_token          text,
  lease_expires_at     timestamptz,
  heartbeat_at         timestamptz,
  -- did the PAID request leave the process? 'sending' with no result = outcome unknown: never blindly re-sent.
  provider_state       text not null default 'not_sent' check (provider_state in ('not_sent', 'sending', 'responded')),
  provider_ref         text,
  batches_total        integer not null default 0 check (batches_total >= 0),
  batches_done         integer not null default 0 check (batches_done >= 0),
  correction_count     integer not null default 0 check (correction_count >= 0),
  estimated_cost_usd   numeric(12, 6) check (estimated_cost_usd >= 0),
  actual_cost_usd      numeric(12, 6) check (actual_cost_usd >= 0),
  -- provider-side files (Files API) uploaded for this job: {ref, state: uploaded|deleted|cleanup_failed}
  provider_files       jsonb not null default '[]'::jsonb,
  last_error_code      text,
  last_error_category  text,
  last_error_message   text not null default '',
  cancel_requested_at  timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz,
  failed_at            timestamptz,
  cancelled_at         timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  foreign key (run_id, project_id) references continuity_runs (id, project_id) on delete cascade,
  unique (project_id, idempotency_key),
  unique (id, project_id),
  check (status <> 'succeeded' or completed_at is not null),
  check (status <> 'failed' or failed_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create unique index continuity_analysis_jobs_one_active_per_run
  on continuity_analysis_jobs (run_id) where status in ('queued', 'claimed', 'processing', 'cancel_requested');
create index continuity_analysis_jobs_claim_idx
  on continuity_analysis_jobs (next_run_at) where status in ('queued', 'claimed', 'processing', 'cancel_requested');
create index continuity_analysis_jobs_project_idx on continuity_analysis_jobs (project_id, created_at desc);
create index continuity_analysis_jobs_attempt_idx on continuity_analysis_jobs (attempt_id, created_at desc);

create or replace function guard_continuity_analysis_job() returns trigger
language plpgsql as $$
declare ok boolean;
begin
  -- identity and the frozen input never change
  if new.project_id is distinct from old.project_id
     or new.run_id is distinct from old.run_id
     or new.attempt_id is distinct from old.attempt_id
     or new.analyzer is distinct from old.analyzer
     or new.model is distinct from old.model
     or new.input_snapshot is distinct from old.input_snapshot
     or new.input_asset_ids is distinct from old.input_asset_ids
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_by is distinct from old.created_by then
    raise exception 'continuity analysis job % identity and input snapshot are frozen', old.id;
  end if;
  if new.status is distinct from old.status then
    ok := case old.status
      when 'queued' then new.status in ('claimed', 'cancelled', 'failed')
      when 'claimed' then new.status in ('processing', 'queued', 'failed', 'cancel_requested', 'cancelled')
      when 'processing' then new.status in ('succeeded', 'failed', 'queued', 'cancel_requested')
      when 'cancel_requested' then new.status in ('cancelled', 'failed', 'succeeded')
      else false
    end;
    if not ok then
      raise exception 'illegal continuity analysis job transition: % -> %', old.status, new.status;
    end if;
  elsif old.status in ('succeeded', 'failed', 'cancelled') then
    raise exception 'continuity analysis job % is terminal', old.id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger continuity_analysis_jobs_guard before update on continuity_analysis_jobs
  for each row execute function guard_continuity_analysis_job();

alter table continuity_analysis_jobs enable row level security;
-- Owners may read their jobs and create/cancel through the application; execution columns are the worker's.
create policy continuity_analysis_jobs_owner on continuity_analysis_jobs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- ───────────────────────── the continuity worker role ─────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'prism_continuity_worker') then
    create role prism_continuity_worker nologin noinherit;
  end if;
end $$;
alter role prism_continuity_worker set statement_timeout = '60s';
alter role prism_continuity_worker set idle_in_transaction_session_timeout = '120s';
alter role prism_continuity_worker set search_path = public, pg_temp;

revoke all on all tables in schema public from prism_continuity_worker;
revoke all on all sequences in schema public from prism_continuity_worker;
revoke create on schema public from prism_continuity_worker;
grant usage on schema public to prism_continuity_worker;

-- jobs: claim / lease / execution state. No insert (created by authorised users), no delete.
grant select on continuity_analysis_jobs to prism_continuity_worker;
grant update (
  status, next_run_at, attempt_count, lease_owner, lease_token, lease_expires_at, heartbeat_at,
  provider_state, provider_ref, batches_total, batches_done, correction_count, actual_cost_usd,
  provider_files, last_error_code, last_error_category, last_error_message,
  started_at, completed_at, failed_at, cancelled_at
) on continuity_analysis_jobs to prism_continuity_worker;
create policy continuity_analysis_jobs_worker_select on continuity_analysis_jobs
  for select to prism_continuity_worker using (true);
-- terminal jobs are history
create policy continuity_analysis_jobs_worker_update on continuity_analysis_jobs
  for update to prism_continuity_worker
  using (status in ('queued', 'claimed', 'processing', 'cancel_requested'))
  with check (true);

-- runs: read only what execution needs; write ONLY the analysis lifecycle columns.
grant select (id, project_id, attempt_id, analysis_status, subject_asset_id, original_asset_id)
  on continuity_runs to prism_continuity_worker;
grant update (analysis_status, analysis_error, completed_at) on continuity_runs to prism_continuity_worker;
create policy continuity_runs_worker_select on continuity_runs for select to prism_continuity_worker
  using (exists (
    select 1 from continuity_analysis_jobs j
    where j.run_id = continuity_runs.id
      and j.status in ('queued', 'claimed', 'processing', 'cancel_requested')
  ));
create policy continuity_runs_worker_update on continuity_runs for update to prism_continuity_worker
  using (exists (
    select 1 from continuity_analysis_jobs j
    where j.run_id = continuity_runs.id
      and j.status in ('queued', 'claimed', 'processing', 'cancel_requested')
  ) and analysis_status in ('queued', 'running'))
  with check (true);

-- findings: the analyzer's result fields of a run that is still being analysed. Criteria are frozen by trigger.
grant select (id, project_id, run_id, criterion_key, result) on continuity_findings to prism_continuity_worker;
grant update (result, actual, confidence, notes, evidence, result_source) on continuity_findings
  to prism_continuity_worker;
create policy continuity_findings_worker_select on continuity_findings for select to prism_continuity_worker
  using (exists (
    select 1 from continuity_analysis_jobs j
    where j.run_id = continuity_findings.run_id
      and j.status in ('queued', 'claimed', 'processing', 'cancel_requested')
  ));
create policy continuity_findings_worker_update on continuity_findings for update to prism_continuity_worker
  using (exists (
    select 1 from continuity_analysis_jobs j join continuity_runs r on r.id = j.run_id
    where j.run_id = continuity_findings.run_id
      and j.status in ('queued', 'claimed', 'processing', 'cancel_requested')
      and r.analysis_status in ('queued', 'running')
  ))
  with check (true);

-- assets: ONLY the assets named by an active job (to fetch their bytes from private Storage). Read-only.
grant select (id, project_id, type, mime, bucket, object_path, byte_size, checksum, storage_provider, width, height, duration_ms)
  on assets to prism_continuity_worker;
create policy assets_continuity_worker_select on assets for select to prism_continuity_worker
  using (exists (
    select 1 from continuity_analysis_jobs j
    where j.project_id = assets.project_id
      and assets.id = any (j.input_asset_ids)
      and j.status in ('queued', 'claimed', 'processing', 'cancel_requested')
  ));
