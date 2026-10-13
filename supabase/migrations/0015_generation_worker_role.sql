-- 0015: least-privilege database role for the generation worker.
--
-- Trust model:   browser/user → authenticated submission → frozen Attempt + authorised Job → WORKER.
-- The worker derives all authority from persisted, already-authorised jobs. This role therefore:
--   * is NOT superuser, NOT BYPASSRLS, cannot create roles/databases, owns nothing;
--   * has no access to project creative content (characters, looks, scripts, dialogue, shots, bible, ...);
--   * sees only rows that belong to ACTIVE generation work (RLS policies below), and can write only the
--     execution columns of jobs/attempts plus append-only outputs, costs, events and generated assets.
--
-- The role is created NOLOGIN with NO password: no secret ever lives in a migration. Credentials are provisioned
-- out of band by `npm run worker:db:provision` (enables LOGIN and sets the password from the environment).
--
-- Residual privileges inherited through PUBLIC (managed by Supabase, deliberately NOT revoked): USAGE on schema
-- public, EXECUTE on public/pg_catalog functions, CONNECT/TEMPORARY on the database. `npm run worker:db:check`
-- prints them. None of them grant access to table data.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'prism_generation_worker') then
    create role prism_generation_worker nologin noinherit;
  end if;
end $$;

-- (CREATE ROLE defaults are already NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; the
-- managed `postgres` role may not alter those attributes, and `npm run worker:db:check` asserts them.)
alter role prism_generation_worker set statement_timeout = '60s';
alter role prism_generation_worker set idle_in_transaction_session_timeout = '120s';
alter role prism_generation_worker set search_path = public, pg_temp;

-- Start from nothing, then grant exactly what the worker uses.
revoke all on all tables in schema public from prism_generation_worker;
revoke all on all sequences in schema public from prism_generation_worker;
revoke create on schema public from prism_generation_worker;
grant usage on schema public to prism_generation_worker;

-- ── generation_jobs: claim / lease / execution state. No insert (jobs are created by authorised users). ──
grant select on generation_jobs to prism_generation_worker;
grant update (
  status, provider_job_id, provider_status, next_run_at, attempt_count, poll_count,
  submitted_at, started_at, completed_at, failed_at, cancelled_at, cancel_outcome,
  lease_owner, lease_token, lease_expires_at, heartbeat_at, last_polled_at,
  last_error_code, last_error_category, last_error_message, actual_cost
) on generation_jobs to prism_generation_worker;

create policy generation_jobs_worker_select on generation_jobs for select to prism_generation_worker
  using (true);
-- Terminal jobs are history: the worker can no longer touch them.
create policy generation_jobs_worker_update on generation_jobs for update to prism_generation_worker
  using (status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested'))
  with check (true);

-- ── generation_attempts: read the frozen request of work in flight; write execution results only. ──
grant select on generation_attempts to prism_generation_worker;
grant update (status, output_asset_id, duration_ms, cost_usd) on generation_attempts to prism_generation_worker;

create policy generation_attempts_worker_select on generation_attempts for select to prism_generation_worker
  using (status in ('queued', 'running'));
create policy generation_attempts_worker_update on generation_attempts for update to prism_generation_worker
  using (status in ('queued', 'running'))
  with check (true);

-- ── projects: the owner id of a project that has active work (to attribute generated assets). ──
grant select (id, user_id) on projects to prism_generation_worker;
create policy projects_worker_select on projects for select to prism_generation_worker
  using (exists (
    select 1 from generation_jobs j
    where j.project_id = projects.id
      and j.status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested')
  ));

-- ── assets: read ONLY the inputs of active attempts (to hand them to a provider); insert generated outputs. ──
grant select (id, project_id, type, mime, bucket, object_path, byte_size, checksum, storage_provider, purpose)
  on assets to prism_generation_worker;
grant insert on assets to prism_generation_worker;

create policy assets_worker_select_inputs on assets for select to prism_generation_worker
  using (exists (
    select 1
    from generation_attempts a
    join generation_jobs j on j.attempt_id = a.id and j.project_id = a.project_id
    where a.project_id = assets.project_id
      and assets.id = any (a.input_asset_ids)
      and j.status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested')
  ));
-- A generated output can only be created for a project whose job is currently ingesting.
create policy assets_worker_insert_outputs on assets for insert to prism_generation_worker
  with check (
    purpose = 'generation_output'
    and source = 'provider_output'
    and exists (
      select 1 from generation_jobs j
      where j.project_id = assets.project_id and j.status = 'ingesting'
    )
  );

-- ── append-only execution records ──
grant insert on generation_outputs to prism_generation_worker;
create policy generation_outputs_worker_insert on generation_outputs for insert to prism_generation_worker
  with check (exists (
    select 1 from generation_jobs j
    where j.attempt_id = generation_outputs.attempt_id
      and j.project_id = generation_outputs.project_id
      and j.status = 'ingesting'
  ));

grant insert on generation_costs to prism_generation_worker;
create policy generation_costs_worker_insert on generation_costs for insert to prism_generation_worker
  with check (
    kind in ('actual', 'unknown')   -- estimates are written at submission, by the user's own session
    and exists (
      select 1 from generation_jobs j
      where j.id = generation_costs.job_id
        and j.attempt_id = generation_costs.attempt_id
        and j.project_id = generation_costs.project_id
    )
  );

grant insert on generation_job_events to prism_generation_worker;
create policy generation_job_events_worker_insert on generation_job_events for insert to prism_generation_worker
  with check (exists (
    select 1 from generation_jobs j
    where j.id = generation_job_events.job_id
      and j.attempt_id = generation_job_events.attempt_id
      and j.project_id = generation_job_events.project_id
  ));
