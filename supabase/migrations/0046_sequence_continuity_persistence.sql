-- Phase 3A.4C: transition persistence and predecessor-bound cut intent (docs/sequence-continuity-supervisor.md).
--
--   continuity_runs / continuity_analysis_jobs   gain `subject_kind` ('attempt' | 'transition'). Every existing row is
--                                                'attempt' and keeps every other value. An attempt row keeps exactly
--                                                its 0021 shape (attempt + subject Asset required); a transition row
--                                                carries no Shot attempt or Asset. A job's kind equals its run's kind
--                                                (composite key). Both frozen guards are re-created with EVERY field
--                                                they froze before (0021 / 0022 / 0044) plus `subject_kind`.
--   continuity_transition_subjects               the frozen 1:1 subject of a TRANSITION run: the cut's address
--                                                (edit, left item, right item), its Shots, both frozen side snapshots,
--                                                the per-transition run number. The edit / Episode / item / Shot ids
--                                                are HISTORICAL identifiers, not cascading keys: deleting or changing
--                                                the live edit never deletes or rewrites a run's subject. Immutable.
--                                                Exactly one per transition run and none for an attempt run, at COMMIT.
--   episode_edit_items.incoming_cut_intent       a person's deliberate-discontinuity declaration for the cut INTO the
--                                                item, bound to the predecessor it names; validated JSON, and at
--                                                COMMIT it must name the item's actual predecessor (never on the
--                                                first item).
--
-- Nothing here creates a run, a job or an intent. No grant to anon or either worker role.

-- ───────────────────────── continuity_runs: subject kind ─────────────────────────

alter table continuity_runs
  add column subject_kind text not null default 'attempt'
    constraint continuity_runs_subject_kind_check check (subject_kind in ('attempt', 'transition'));
alter table continuity_runs
  alter column attempt_id drop not null,
  alter column subject_asset_id drop not null;
alter table continuity_runs
  add constraint continuity_runs_subject_shape check (
    (subject_kind = 'attempt' and attempt_id is not null and subject_asset_id is not null)
    or (subject_kind = 'transition' and attempt_id is null and subject_asset_id is null and original_asset_id is null)
  ),
  -- the target of the kind-aware keys below (a job / transition subject names the run AND its kind)
  add constraint continuity_runs_id_project_kind_key unique (id, project_id, subject_kind);

create index continuity_runs_project_kind_idx on continuity_runs (project_id, subject_kind, created_at desc);

create or replace function guard_continuity_run() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.subject_kind is distinct from old.subject_kind
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

-- ───────────────────────── continuity_analysis_jobs: subject kind ─────────────────────────

alter table continuity_analysis_jobs
  add column subject_kind text not null default 'attempt'
    constraint continuity_analysis_jobs_subject_kind_check check (subject_kind in ('attempt', 'transition'));
alter table continuity_analysis_jobs alter column attempt_id drop not null;
alter table continuity_analysis_jobs
  add constraint continuity_analysis_jobs_subject_shape check (
    (subject_kind = 'attempt' and attempt_id is not null) or (subject_kind = 'transition' and attempt_id is null)
  ),
  -- a job's kind IS its run's kind: an attempt job can never point at a transition run, nor the reverse
  add constraint continuity_analysis_jobs_run_kind_fkey foreign key (run_id, project_id, subject_kind)
    references continuity_runs (id, project_id, subject_kind) on delete cascade;

create or replace function guard_continuity_analysis_job() returns trigger
language plpgsql as $$
declare ok boolean;
begin
  -- identity and the frozen input never change
  if new.project_id is distinct from old.project_id
     or new.run_id is distinct from old.run_id
     or new.subject_kind is distinct from old.subject_kind
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

-- ───────────────────────── continuity_transition_subjects ─────────────────────────

create table continuity_transition_subjects (
  run_id         uuid primary key,
  project_id     uuid not null references projects (id) on delete cascade,
  -- constant: with the key below a subject can only belong to a TRANSITION run
  subject_kind   text not null default 'transition' check (subject_kind = 'transition'),
  -- HISTORICAL identifiers of the cut as it was when the run was created (validated then, never cascading)
  edit_id        uuid not null,
  episode_id     uuid not null,
  edit_revision  integer not null check (edit_revision >= 0),
  transition_key text not null check (transition_key ~ '^[0-9a-f]{64}$'),
  -- per (project, transition key); equals the run's run_number (checked at commit)
  run_number     integer not null check (run_number >= 1),
  left_item_id   uuid not null,
  right_item_id  uuid not null,
  left_shot_id   uuid not null,
  right_shot_id  uuid not null,
  left_side      jsonb not null check (jsonb_typeof(left_side) = 'object'),
  right_side     jsonb not null check (jsonb_typeof(right_side) = 'object'),
  crosses_scene  boolean not null,
  created_by     uuid,
  created_at     timestamptz not null default now(),

  check (left_item_id <> right_item_id),
  foreign key (run_id, project_id, subject_kind)
    references continuity_runs (id, project_id, subject_kind) on delete cascade,
  constraint continuity_transition_subjects_number_key unique (project_id, transition_key, run_number)
);
create index continuity_transition_subjects_edit_idx on continuity_transition_subjects (edit_id, created_at desc);

-- analytical history: never rewritten (it goes only with its run)
create or replace function guard_continuity_transition_subject() returns trigger
language plpgsql as $$
begin
  raise exception 'continuity transition subject % is frozen history', old.run_id;
end;
$$;
create trigger continuity_transition_subjects_guard before update on continuity_transition_subjects
  for each row execute function guard_continuity_transition_subject();

-- At COMMIT: a transition run has exactly one subject with its own run number; an attempt run has none (the key above
-- already makes an attempt run's subject impossible). Deferred, so a run and its subject are written in one unit.
create or replace function check_continuity_run_subject() returns trigger
language plpgsql as $$
declare
  rid uuid;
  run continuity_runs%rowtype;
  n integer;
  numbered integer;
begin
  if tg_table_name = 'continuity_runs' then
    rid := new.id;
  elsif tg_op = 'DELETE' then
    rid := old.run_id;
  else
    rid := new.run_id;
  end if;
  select * into run from continuity_runs where id = rid;
  if not found then
    return null; -- the run is gone (its subject went with it)
  end if;
  select count(*), count(*) filter (where s.run_number = run.run_number)
    into n, numbered
    from continuity_transition_subjects s where s.run_id = rid;
  if run.subject_kind = 'transition' and (n <> 1 or numbered <> 1) then
    raise exception 'transition continuity run % must have exactly one transition subject with its run number', rid;
  end if;
  if run.subject_kind = 'attempt' and n <> 0 then
    raise exception 'attempt continuity run % cannot have a transition subject', rid;
  end if;
  return null;
end;
$$;
create constraint trigger continuity_runs_subject_check
  after insert on continuity_runs deferrable initially deferred
  for each row execute function check_continuity_run_subject();
create constraint trigger continuity_transition_subjects_run_check
  after insert or delete on continuity_transition_subjects deferrable initially deferred
  for each row execute function check_continuity_run_subject();

alter table continuity_transition_subjects enable row level security;
-- explicit grants (0045 onwards): the signed-in owner reads and records history; nobody updates or deletes directly
revoke all on continuity_transition_subjects from public, anon, authenticated;
revoke all on continuity_transition_subjects from prism_generation_worker, prism_continuity_worker;
grant select, insert on continuity_transition_subjects to authenticated;
create policy continuity_transition_subjects_owner_select on continuity_transition_subjects
  for select to authenticated using (is_project_owner(project_id));
create policy continuity_transition_subjects_owner_insert on continuity_transition_subjects
  for insert to authenticated with check (is_project_owner(project_id));

-- ───────────────────────── episode_edit_items.incoming_cut_intent ─────────────────────────

-- The CutIntent shape of src/domain/continuity/cut-intent.ts. Immutable (literal checks only), so a CHECK can use it.
-- Never NULL for a non-null value (a CHECK passes on NULL): a missing key is false, not unknown.
create or replace function episode_cut_intent_valid(i jsonb) returns boolean
language sql immutable as $$
  select i is null or coalesce((
    jsonb_typeof(i) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(i) k
      where k not in ('fromItemId', 'kinds', 'scope', 'note', 'declaredBy', 'declaredAt')
    )
    and jsonb_typeof(i -> 'fromItemId') = 'string'
    and (i ->> 'fromItemId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(i -> 'kinds') = 'array'
    and jsonb_array_length(i -> 'kinds') between 1 and 10
    and not exists (
      select 1 from jsonb_array_elements(i -> 'kinds') e
      where jsonb_typeof(e) <> 'string' or e #>> '{}' not in (
        'jump_cut', 'montage', 'match_cut', 'time_jump', 'location_jump', 'dream_flashback', 'axis_break',
        'lighting_transition', 'wardrobe_progression', 'other'
      )
    )
    and (select count(distinct e) from jsonb_array_elements(i -> 'kinds') e) = jsonb_array_length(i -> 'kinds')
    and jsonb_typeof(i -> 'scope') = 'array'
    and not exists (
      select 1 from jsonb_array_elements(i -> 'scope') e
      where jsonb_typeof(e) <> 'string' or e #>> '{}' not in (
        'identity', 'wardrobe', 'hair', 'makeup', 'jewelry', 'props', 'location_set', 'lighting', 'weather',
        'time_of_day', 'character_count', 'screen_direction', 'eyelines', 'geography', 'camera', 'composition',
        'action_continuity', 'duration', 'audio', 'lip_sync', 'other'
      )
    )
    and (select count(distinct e) from jsonb_array_elements(i -> 'scope') e) = jsonb_array_length(i -> 'scope')
    and jsonb_typeof(i -> 'note') = 'string'
    and char_length(btrim(i ->> 'note')) between 1 and 2000
    and (
      jsonb_typeof(i -> 'declaredBy') = 'null'
      or (
        jsonb_typeof(i -> 'declaredBy') = 'string'
        and (i ->> 'declaredBy') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    )
    and jsonb_typeof(i -> 'declaredAt') = 'string'
    and (i ->> 'declaredAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
  ), false)
$$;

alter table episode_edit_items
  add column incoming_cut_intent jsonb
    constraint episode_edit_items_cut_intent_valid check (episode_cut_intent_valid(incoming_cut_intent));

-- At COMMIT (the repository renumbers positions inside the unit): an item's intent names exactly the item before it,
-- and the first item has none. The repository clears an intent whose predecessor changed in the same unit.
create or replace function check_episode_edit_cut_intents() returns trigger
language plpgsql as $$
declare
  eid uuid;
  bad uuid;
begin
  if tg_op = 'DELETE' then
    eid := old.edit_id;
  else
    eid := new.edit_id;
  end if;
  select cur.id into bad
    from episode_edit_items cur
    left join episode_edit_items prev on prev.edit_id = cur.edit_id and prev.position = cur.position - 1
   where cur.edit_id = eid
     and cur.incoming_cut_intent is not null
     and (prev.id is null or prev.id::text <> cur.incoming_cut_intent ->> 'fromItemId')
   limit 1;
  if bad is not null then
    raise exception 'episode edit item %: its cut intent must name the item immediately before it', bad;
  end if;
  return null;
end;
$$;
create constraint trigger episode_edit_items_cut_intent_check
  after insert or update or delete on episode_edit_items deferrable initially deferred
  for each row execute function check_episode_edit_cut_intents();
