-- 0023: analysis cost accounting (Phase 2D). SEPARATE from generation_costs: continuity analysis spend is its
-- own concern with its own gate, ceiling and history. Append-only; never invented (unknown stays unknown).

create table continuity_analysis_costs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects (id) on delete cascade,
  run_id           uuid not null,
  job_id           uuid not null,
  analyzer         text not null,
  model            text not null,
  -- estimated: computed before submission (worst-case ceiling + expected). actual: derived from authoritative
  -- provider usage. unknown: the provider exposed no usable usage metadata.
  kind             text not null check (kind in ('estimated', 'actual', 'unknown')),
  amount_usd       numeric(12, 6) check (amount_usd >= 0),
  expected_usd     numeric(12, 6) check (expected_usd >= 0),
  currency         text not null default 'USD' check (char_length(currency) = 3),
  usage            jsonb not null default '{}'::jsonb,   -- tokens per call, correction usage, estimate basis
  pricing_version  text not null default '',
  recorded_at      timestamptz not null default now(),

  foreign key (job_id, project_id) references continuity_analysis_jobs (id, project_id) on delete cascade,
  foreign key (run_id, project_id) references continuity_runs (id, project_id) on delete cascade,
  check (kind <> 'actual' or amount_usd is not null),
  check (kind <> 'unknown' or amount_usd is null)
);
create unique index continuity_analysis_costs_one_estimate on continuity_analysis_costs (job_id) where kind = 'estimated';
create unique index continuity_analysis_costs_one_final on continuity_analysis_costs (job_id) where kind in ('actual', 'unknown');
create index continuity_analysis_costs_project_idx on continuity_analysis_costs (project_id, recorded_at desc);

create or replace function guard_continuity_analysis_cost() returns trigger
language plpgsql as $$
begin
  raise exception 'continuity analysis cost % is append-only', old.id;
end;
$$;
create trigger continuity_analysis_costs_guard before update on continuity_analysis_costs
  for each row execute function guard_continuity_analysis_cost();

alter table continuity_analysis_costs enable row level security;
create policy continuity_analysis_costs_owner on continuity_analysis_costs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- The continuity worker records the FINAL cost of a job it executes (never the estimate: that is written at
-- submission by the user's own session) and may read amounts to enforce the daily ceiling.
grant insert on continuity_analysis_costs to prism_continuity_worker;
grant select (job_id, kind, amount_usd, recorded_at) on continuity_analysis_costs to prism_continuity_worker;
create policy continuity_analysis_costs_worker_insert on continuity_analysis_costs
  for insert to prism_continuity_worker
  with check (
    kind in ('actual', 'unknown')
    and exists (
      select 1 from continuity_analysis_jobs j
      where j.id = continuity_analysis_costs.job_id
        and j.run_id = continuity_analysis_costs.run_id
        and j.project_id = continuity_analysis_costs.project_id
    )
  );
create policy continuity_analysis_costs_worker_select on continuity_analysis_costs
  for select to prism_continuity_worker using (true);
