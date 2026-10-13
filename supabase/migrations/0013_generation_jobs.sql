-- 0013: operational generation state. A job is MUTABLE execution state; the attempt it belongs to is the
-- immutable creative record (0012). One attempt normally has one job; the schema allows several
-- (e.g. re-executing the same frozen attempt after a provider outage) but never more than one ACTIVE job.

create table generation_jobs (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects (id) on delete cascade,
  attempt_id            uuid not null,
  provider              text not null,
  model                 text not null,
  status                text not null default 'queued'
    check (status in (
      'queued', 'submitting', 'submitted', 'processing', 'ingesting',
      'succeeded', 'failed', 'cancel_requested', 'cancelled'
    )),
  provider_job_id       text,
  provider_status       text not null default '',
  idempotency_key       text not null check (char_length(idempotency_key) >= 8),
  queue_priority        integer not null default 0,
  attempt_count         integer not null default 0 check (attempt_count >= 0),
  max_attempts          integer not null default 3 check (max_attempts > 0),
  poll_count            integer not null default 0 check (poll_count >= 0),
  next_run_at           timestamptz not null default now(),
  submitted_at          timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  failed_at             timestamptz,
  cancelled_at          timestamptz,
  cancel_requested_at   timestamptz,
  cancel_outcome        text check (cancel_outcome in ('local_only', 'confirmed', 'not_supported', 'failed')),
  lease_owner           text,
  lease_token           text,
  lease_expires_at      timestamptz,
  heartbeat_at          timestamptz,
  last_polled_at        timestamptz,
  last_error_code       text,
  last_error_category   text check (last_error_category in (
    'transient', 'rate_limit', 'provider_unavailable', 'timeout', 'invalid_request',
    'content_rejected', 'auth', 'quota', 'permanent'
  )),
  last_error_message    text not null default '',  -- SANITIZED. Never a payload, URL or credential.
  estimated_cost        numeric(12, 4) check (estimated_cost >= 0),
  actual_cost           numeric(12, 4) check (actual_cost >= 0),
  currency              text not null default 'USD' check (char_length(currency) = 3),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- same-project guarantee: the attempt must belong to the job's project
  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  unique (project_id, idempotency_key),
  check ((lease_owner is null) = (lease_token is null)),
  check (status <> 'succeeded' or completed_at is not null),
  check (status <> 'failed' or failed_at is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and cancel_outcome is not null))
);

-- At most one active job per attempt (double-click / duplicate-worker protection at the data layer).
create unique index generation_jobs_one_active_per_attempt on generation_jobs (attempt_id)
  where status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested');
-- Claim query: due work ordered by priority then due time.
create index generation_jobs_claim_idx on generation_jobs (next_run_at, queue_priority desc)
  where status in ('queued', 'submitting', 'submitted', 'processing', 'ingesting', 'cancel_requested');
create index generation_jobs_project_status_idx on generation_jobs (project_id, status, created_at desc);
create index generation_jobs_attempt_idx on generation_jobs (attempt_id);

create trigger generation_jobs_updated before update on generation_jobs for each row execute function set_updated_at();

-- Defence in depth for the application state machine (src/domain/generation/job-state.ts):
-- only legal status transitions, and identity columns never change.
create or replace function guard_generation_job() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.attempt_id is distinct from old.attempt_id
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'generation job % identity columns are immutable', old.id;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'queued' and new.status in ('submitting', 'cancelled', 'cancel_requested', 'failed'))
      or (old.status = 'submitting' and new.status in
          ('submitted', 'processing', 'ingesting', 'queued', 'failed', 'cancel_requested', 'cancelled'))
      or (old.status = 'submitted' and new.status in ('processing', 'ingesting', 'failed', 'cancel_requested'))
      or (old.status = 'processing' and new.status in ('ingesting', 'failed', 'cancel_requested'))
      or (old.status = 'ingesting' and new.status in ('succeeded', 'failed', 'cancel_requested'))
      or (old.status = 'cancel_requested' and new.status in ('cancelled', 'failed'))
    ) then
      raise exception 'illegal generation job transition: % -> %', old.status, new.status
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger generation_jobs_guard before update on generation_jobs for each row execute function guard_generation_job();

-- Job event log: why a job is in the state it is in, in order. Append-only.
create table generation_job_events (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  job_id      uuid not null references generation_jobs (id) on delete cascade,
  attempt_id  uuid not null,
  at          timestamptz not null default now(),
  from_status text,
  to_status   text not null,
  note        text not null default '',
  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade
);
create index generation_job_events_job_idx on generation_job_events (job_id, at);

-- RLS: ownership through the project, same model as every other table.
alter table generation_jobs enable row level security;
create policy generation_jobs_owner on generation_jobs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table generation_job_events enable row level security;
create policy generation_job_events_owner on generation_job_events for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
