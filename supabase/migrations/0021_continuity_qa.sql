-- 0021: continuity QA (Phase 2C).
--
--   QA ADVISES, humans approve. A run freezes what was checked, against what, with which rules; later changes
--   to production truth make a run STALE (computed by the application) but never rewrite it.
--
--   continuity_runs       one analysis of one attempt's output (subject asset, references, rule/analyzer versions)
--   continuity_findings   one row per criterion in the run: expected value, system result, severity
--   continuity_overrides  explicit, append-only human decisions on a finding (the latest one wins)
--
-- Distinct from the legacy `continuity_checks` table (manual scores per shot), which is left untouched.

create table continuity_runs (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references projects (id) on delete cascade,
  attempt_id             uuid not null,
  run_number             integer not null check (run_number >= 1),
  -- the asset that was examined (delivery master, or the provider original) and the original beside it
  subject_asset_id       uuid not null,
  original_asset_id      uuid,
  analyzer               text not null,
  analyzer_version       text not null,
  analyzer_kind          text not null check (analyzer_kind in ('deterministic', 'mock', 'model', 'manual')),
  rules_version          text not null,
  analysis_status        text not null default 'queued'
    check (analysis_status in ('queued', 'running', 'complete', 'failed')),
  analysis_error         text not null default '',
  -- staleness inputs, frozen at creation
  package_fingerprint    text not null,
  subject_fingerprint    text not null,
  criteria_fingerprint   text not null,
  reference_fingerprint  text not null,
  reference_set          jsonb not null default '{}'::jsonb,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz,
  -- a person closed the review (the QA status "passed" / "failed" is only reached through this)
  finalized_at           timestamptz,
  finalized_by           uuid,
  finalize_note          text not null default '',

  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  foreign key (subject_asset_id, project_id) references assets (id, project_id),
  foreign key (original_asset_id, project_id) references assets (id, project_id),
  unique (attempt_id, run_number),
  unique (id, project_id)
);
create index continuity_runs_project_idx on continuity_runs (project_id, created_at desc);
create index continuity_runs_attempt_idx on continuity_runs (attempt_id, run_number desc);

create table continuity_findings (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects (id) on delete cascade,
  run_id         uuid not null,
  -- stable id of the criterion within the run ("wardrobe:<look id>", "duration", "aspect_ratio" ...)
  criterion_key  text not null,
  category       text not null check (category in (
    'identity', 'wardrobe', 'hair', 'makeup', 'jewelry', 'props', 'location_set', 'lighting', 'weather',
    'time_of_day', 'character_count', 'screen_direction', 'eyelines', 'geography', 'camera', 'composition',
    'action_continuity', 'duration', 'audio', 'lip_sync', 'other'
  )),
  severity       text not null check (severity in ('critical', 'major', 'minor')),
  title          text not null,
  -- where the expectation comes from in production truth ("Look: Formal Black", "Shot continuity")
  source_ref     text not null default '',
  expected       text not null default '',
  actual         text not null default '',
  result         text not null default 'unchecked'
    check (result in ('pass', 'warn', 'fail', 'n_a', 'unchecked')),
  result_source  text not null default 'deterministic'
    check (result_source in ('deterministic', 'analyzer', 'none')),
  confidence     numeric(4, 3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  notes          text not null default '',
  evidence       jsonb not null default '{}'::jsonb,   -- {frames: [...], timeRangeMs: [a, b]}
  position       integer not null default 0,
  created_at     timestamptz not null default now(),

  foreign key (run_id, project_id) references continuity_runs (id, project_id) on delete cascade,
  unique (run_id, criterion_key),
  unique (id, project_id)
);
create index continuity_findings_run_idx on continuity_findings (run_id, position);

create table continuity_overrides (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  run_id      uuid not null,
  finding_id  uuid not null,
  result      text not null check (result in ('pass', 'warn', 'fail', 'n_a', 'unchecked')),
  notes       text not null default '',
  created_by  uuid,
  created_at  timestamptz not null default now(),

  foreign key (finding_id, project_id) references continuity_findings (id, project_id) on delete cascade,
  foreign key (run_id, project_id) references continuity_runs (id, project_id) on delete cascade
);
create index continuity_overrides_finding_idx on continuity_overrides (finding_id, created_at desc);

-- A run's identity and inputs are history. Only execution (analysis_*) and the human close-out may change.
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
     or new.reference_set is distinct from old.reference_set then
    raise exception 'continuity run % is a frozen snapshot; only analysis status and review close-out may change', old.id;
  end if;
  return new;
end;
$$;
create trigger continuity_runs_guard before update on continuity_runs
  for each row execute function guard_continuity_run();

-- What a finding EXPECTED and what the system found are history; only the analyzer's result fields may be
-- written once while the run is still being analysed. Human decisions go to continuity_overrides.
create or replace function guard_continuity_finding() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.run_id is distinct from old.run_id
     or new.criterion_key is distinct from old.criterion_key
     or new.category is distinct from old.category
     or new.severity is distinct from old.severity
     or new.expected is distinct from old.expected
     or new.source_ref is distinct from old.source_ref then
    raise exception 'continuity finding % criteria are frozen', old.id;
  end if;
  if exists (
    select 1 from continuity_runs r where r.id = old.run_id and r.analysis_status = 'complete'
  ) and (
    new.result is distinct from old.result or new.actual is distinct from old.actual
    or new.result_source is distinct from old.result_source or new.confidence is distinct from old.confidence
  ) then
    raise exception 'continuity finding % belongs to a completed run; record an override instead', old.id;
  end if;
  return new;
end;
$$;
create trigger continuity_findings_guard before update on continuity_findings
  for each row execute function guard_continuity_finding();

create or replace function guard_continuity_override() returns trigger
language plpgsql as $$
begin
  raise exception 'continuity override % is append-only', old.id;
end;
$$;
create trigger continuity_overrides_guard before update on continuity_overrides
  for each row execute function guard_continuity_override();

alter table continuity_runs enable row level security;
create policy continuity_runs_owner on continuity_runs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
alter table continuity_findings enable row level security;
create policy continuity_findings_owner on continuity_findings for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
alter table continuity_overrides enable row level security;
create policy continuity_overrides_owner on continuity_overrides for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
