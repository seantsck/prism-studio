-- 0014: generation outputs (ordered, role-tagged links from an attempt to Prism-owned Asset rows) and cost
-- records (estimated and actual, never fabricated).

create table generation_outputs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  attempt_id  uuid not null,
  asset_id    uuid not null,
  role        text not null check (role in ('primary', 'variant', 'preview', 'thumbnail', 'audio', 'metadata')),
  position    integer not null check (position >= 0),
  provenance  jsonb not null default '{}'::jsonb,   -- sanitized provider facts for THIS output
  created_at  timestamptz not null default now(),

  -- same-project guarantees for both parents. NO ACTION (not RESTRICT) so a project delete can cascade cleanly.
  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  foreign key (asset_id, project_id) references assets (id, project_id),
  unique (attempt_id, position),
  unique (attempt_id, asset_id)
);
-- Exactly one primary output per attempt, at most.
create unique index generation_outputs_one_primary on generation_outputs (attempt_id) where role = 'primary';
create index generation_outputs_asset_idx on generation_outputs (asset_id);
create index generation_outputs_project_idx on generation_outputs (project_id);

create table generation_costs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects (id) on delete cascade,
  attempt_id   uuid not null,
  job_id       uuid references generation_jobs (id) on delete set null,
  provider     text not null,
  model        text not null,
  -- estimated: computed before submission. actual: reported by the provider. unknown: provider reported nothing.
  kind         text not null check (kind in ('estimated', 'actual', 'unknown')),
  amount       numeric(12, 4) check (amount >= 0),
  currency     text not null default 'USD' check (char_length(currency) = 3),
  basis        text not null default '',
  units        numeric(14, 4) check (units >= 0),
  recorded_at  timestamptz not null default now(),

  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  check (kind <> 'actual' or amount is not null),
  check (kind <> 'unknown' or amount is null)
);
-- One estimate and one final (actual|unknown) record per attempt.
create unique index generation_costs_one_estimate on generation_costs (attempt_id) where kind = 'estimated';
create unique index generation_costs_one_final on generation_costs (attempt_id) where kind in ('actual', 'unknown');
create index generation_costs_project_idx on generation_costs (project_id, recorded_at desc);

-- Cost records are facts about what was attempted: append-only.
create or replace function guard_generation_cost() returns trigger
language plpgsql as $$
begin
  if new.attempt_id is distinct from old.attempt_id
     or new.kind is distinct from old.kind
     or new.amount is distinct from old.amount
     or new.currency is distinct from old.currency
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model then
    raise exception 'generation cost % is append-only', old.id;
  end if;
  return new;
end;
$$;
create trigger generation_costs_guard before update on generation_costs for each row execute function guard_generation_cost();

alter table generation_outputs enable row level security;
create policy generation_outputs_owner on generation_outputs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table generation_costs enable row level security;
create policy generation_costs_owner on generation_costs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
