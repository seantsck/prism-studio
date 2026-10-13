-- 0024: append-only audit trail of a continuity analysis job (status changes with their reason), the analyzer
-- counterpart of generation_job_events. Written by the submitting user (queued) and by the continuity worker.

create table continuity_analysis_events (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  job_id      uuid not null,
  run_id      uuid not null,
  at          timestamptz not null default now(),
  from_status text,
  to_status   text not null,
  note        text not null default '',

  foreign key (job_id, project_id) references continuity_analysis_jobs (id, project_id) on delete cascade
);
create index continuity_analysis_events_job_idx on continuity_analysis_events (job_id, at);

create or replace function guard_continuity_analysis_event() returns trigger
language plpgsql as $$
begin
  raise exception 'continuity analysis event % is append-only', old.id;
end;
$$;
create trigger continuity_analysis_events_guard before update on continuity_analysis_events
  for each row execute function guard_continuity_analysis_event();

alter table continuity_analysis_events enable row level security;
create policy continuity_analysis_events_owner on continuity_analysis_events for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

grant insert on continuity_analysis_events to prism_continuity_worker;
create policy continuity_analysis_events_worker_insert on continuity_analysis_events
  for insert to prism_continuity_worker
  with check (exists (
    select 1 from continuity_analysis_jobs j
    where j.id = continuity_analysis_events.job_id
      and j.run_id = continuity_analysis_events.run_id
      and j.project_id = continuity_analysis_events.project_id
  ));
