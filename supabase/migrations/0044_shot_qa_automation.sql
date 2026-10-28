-- 0044: automatic Shot QA orchestration (Phase 3A.2).
--
--   project_qa_policies      ONE owner-controlled row per Project: whether SEMANTIC (model) QA may run automatically,
--                            with which analyzer, with standing consent to send the frozen media, and with Project
--                            spend ceilings. No row = semantic automation OFF (no existing Project opts in).
--                            Automatic DETERMINISTIC QA (metadata checks, no external call, no cost) needs no policy.
--   continuity_runs          gains `automation_key`: the stable identity of an AUTOMATIC run (null for every manual
--                            run and for every historical row). Unique when set, so two tabs / two requests reconciling
--                            the same production truth create ONE automatic run; people may still re-run manually.
--
-- Trust model (unchanged): the signed-in application applies the policy and freezes an authorised job; the continuity
-- worker executes the frozen job and never reads this mutable policy. Neither worker role gets any grant here.
-- Forward-only; 0001-0043 untouched.

-- ───────────────────────── automatic run identity ─────────────────────────

alter table continuity_runs
  add column automation_key text
    check (automation_key is null or char_length(automation_key) between 16 and 128);

create unique index continuity_runs_automation_key
  on continuity_runs (project_id, automation_key)
  where automation_key is not null;

-- The run guard (0021, extended by 0022) also freezes the automation identity.
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
     or new.model is distinct from old.model
     or new.automation_key is distinct from old.automation_key then
    raise exception 'continuity run % is a frozen snapshot; only analysis status and review close-out may change', old.id;
  end if;
  return new;
end;
$$;

-- ───────────────────────── Project QA policy ─────────────────────────

create table project_qa_policies (
  project_id             uuid primary key references projects (id) on delete cascade,
  semantic_mode          text not null default 'off' check (semantic_mode in ('off', 'suggest', 'automatic')),
  -- preferred / authorised analyzer id ("openai", "gemini", "mock-continuity"); optional for off / suggest
  analyzer               text check (analyzer is null or char_length(analyzer) between 1 and 64),
  -- standing consent to send the frozen references / output media named by each run's external-media manifest
  external_media_allowed boolean not null default false,
  max_cost_per_run_usd   numeric(12, 6) check (max_cost_per_run_usd is null or max_cost_per_run_usd >= 0),
  max_cost_per_day_usd   numeric(12, 6) check (max_cost_per_day_usd is null or max_cost_per_day_usd >= 0),
  -- optimistic concurrency: +1 on every successful update
  revision               integer not null default 1 check (revision >= 1),
  updated_by             uuid,
  updated_at             timestamptz not null default now(),
  -- automatic semantic QA is never implicit: an analyzer, consent and two finite ceilings, all explicit
  constraint project_qa_policies_automatic_is_explicit check (
    semantic_mode <> 'automatic'
    or (analyzer is not null and external_media_allowed
        and max_cost_per_run_usd is not null and max_cost_per_day_usd is not null)
  ),
  constraint project_qa_policies_run_within_day check (
    max_cost_per_run_usd is null or max_cost_per_day_usd is null or max_cost_per_run_usd <= max_cost_per_day_usd
  )
);

alter table project_qa_policies enable row level security;
create policy project_qa_policies_owner on project_qa_policies for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- Owner-only through RLS; no anonymous access and NO worker access (the app freezes policy into the job).
revoke all on project_qa_policies from anon;
revoke all on project_qa_policies from prism_generation_worker;
revoke all on project_qa_policies from prism_continuity_worker;
