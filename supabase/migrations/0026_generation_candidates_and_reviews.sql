-- 0026: Phase 2E candidate sets and human generation reviews.
--
--   generation_candidate_sets      an intentional comparison experiment for ONE shot (shared package)
--   generation_candidate_members   one candidate per model; each owns its own attempt + job (no giant job)
--   generation_reviews             append-only HUMAN verdicts per attempt (good / shortlist / reject + reasons)
--   generation_candidate_events    append-only audit of the set (created, preferred, promoted, status)
--
-- Authority: these are USER-domain tables. Owner-only RLS; the generation and continuity workers get NO
-- grant on any of them, so a provider/worker can never write a human approval, a rejection reason or a winner.
-- Existing attempts are untouched: an attempt outside any set is simply "standalone".

create table generation_candidate_sets (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  shot_id              uuid not null references shots (id) on delete cascade,
  title                text not null default '',
  purpose              text not null default '',
  status               text not null default 'open' check (status in ('open', 'decided', 'archived')),
  -- the SAME production package every candidate was built from
  package_fingerprint  text not null check (char_length(package_fingerprint) > 0),
  estimated_total_usd  numeric(12, 4) check (estimated_total_usd >= 0),
  -- the SERVER ceiling that applied at creation (never a client value)
  ceiling_usd          numeric(12, 4) check (ceiling_usd >= 0),
  preferred_attempt_id uuid,
  preferred_by         uuid,
  preferred_at         timestamptz,
  promoted_attempt_id  uuid,
  promoted_by          uuid,
  promoted_at          timestamptz,
  -- frozen recommendation shown at creation (engine version, profile, scores) + what was chosen
  recommendation       jsonb,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (id, project_id),
  foreign key (preferred_attempt_id, project_id) references generation_attempts (id, project_id),
  foreign key (promoted_attempt_id, project_id) references generation_attempts (id, project_id),
  check (promoted_attempt_id is null or promoted_at is not null)
);
create index generation_candidate_sets_project_idx on generation_candidate_sets (project_id, created_at desc);
create index generation_candidate_sets_shot_idx on generation_candidate_sets (shot_id, created_at desc);

create table generation_candidate_members (
  id               uuid primary key default gen_random_uuid(),
  candidate_set_id uuid not null,
  project_id       uuid not null,
  label            text not null check (char_length(label) between 1 and 8),
  position         integer not null check (position >= 0),
  provider         text not null,
  model            text not null,
  -- null until the attempt exists (and forever when submission failed): a failed candidate never fails the set
  attempt_id       uuid,
  submit_state     text not null default 'planned' check (submit_state in ('planned', 'submitted', 'failed')),
  submit_error     text not null default '',
  input_mode       text check (input_mode in ('keyframes', 'references')),
  tier_id          text,
  native_audio     boolean not null default false,
  estimate_usd     numeric(12, 4) check (estimate_usd >= 0),
  -- what the candidate would receive / adapt, frozen at planning
  plan             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  foreign key (candidate_set_id, project_id)
    references generation_candidate_sets (id, project_id) on delete cascade,
  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  unique (candidate_set_id, position),
  unique (candidate_set_id, label),
  check (submit_state <> 'submitted' or attempt_id is not null)
);
create unique index generation_candidate_members_attempt_key
  on generation_candidate_members (attempt_id) where attempt_id is not null;
create index generation_candidate_members_set_idx on generation_candidate_members (candidate_set_id);

create table generation_reviews (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects (id) on delete cascade,
  attempt_id       uuid not null,
  candidate_set_id uuid,
  decision         text not null check (decision in ('approve', 'shortlist', 'reject', 'unreviewed')),
  positive_tags    text[] not null default '{}',
  negative_tags    text[] not null default '{}',
  notes            text not null default '' check (char_length(notes) <= 1000),
  reviewer         uuid,
  reviewed_at      timestamptz not null default now(),
  supersedes_id    uuid references generation_reviews (id),

  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  foreign key (candidate_set_id, project_id)
    references generation_candidate_sets (id, project_id) on delete set null (candidate_set_id),
  check (decision <> 'reject' or cardinality(negative_tags) >= 1),
  check (
    negative_tags <@ array[
      'character_identity', 'wardrobe', 'hair_makeup', 'location_set', 'props', 'composition', 'camera_motion',
      'body_motion', 'facial_expression', 'performance', 'lip_sync', 'dialogue_audio', 'visual_artifacts',
      'physics', 'lighting', 'duration', 'framing', 'style', 'prompt_adherence', 'other'
    ]::text[]
  ),
  check (
    positive_tags <@ array[
      'identity_good', 'wardrobe_good', 'motion_good', 'camera_good', 'performance_good', 'composition_good',
      'set_good', 'lighting_good', 'audio_good', 'overall_quality'
    ]::text[]
  )
);
create index generation_reviews_attempt_idx on generation_reviews (attempt_id, reviewed_at desc);
create index generation_reviews_project_idx on generation_reviews (project_id, reviewed_at desc);

create table generation_candidate_events (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null,
  candidate_set_id uuid not null,
  kind             text not null check (kind in ('created', 'preferred_set', 'preferred_cleared', 'promoted', 'status_changed')),
  payload          jsonb not null default '{}'::jsonb,
  actor            uuid,
  at               timestamptz not null default now(),

  foreign key (candidate_set_id, project_id)
    references generation_candidate_sets (id, project_id) on delete cascade
);
create index generation_candidate_events_set_idx on generation_candidate_events (candidate_set_id, at);

-- ───────────────────────── integrity ─────────────────────────

-- Append-only: reviews and set events are history, never edited. (Deletes happen only by cascade.)
create or replace function guard_generation_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are append-only (history is never rewritten)', tg_table_name;
end;
$$;
create trigger generation_reviews_guard before update on generation_reviews
  for each row execute function guard_generation_append_only();
create trigger generation_candidate_events_guard before update on generation_candidate_events
  for each row execute function guard_generation_append_only();

-- A set's identity and frozen intent never change; its winner/promotion must be one of ITS members, and a
-- promoted candidate must have produced an output.
create or replace function guard_candidate_set() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.shot_id is distinct from old.shot_id
     or new.package_fingerprint is distinct from old.package_fingerprint
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'candidate set % identity and frozen package are immutable', old.id;
  end if;
  if new.preferred_attempt_id is not null
     and new.preferred_attempt_id is distinct from old.preferred_attempt_id
     and not exists (
       select 1 from generation_candidate_members m
       where m.candidate_set_id = new.id and m.attempt_id = new.preferred_attempt_id
     ) then
    raise exception 'preferred attempt % is not a member of candidate set %', new.preferred_attempt_id, new.id;
  end if;
  if new.promoted_attempt_id is not null
     and new.promoted_attempt_id is distinct from old.promoted_attempt_id then
    if not exists (
      select 1 from generation_candidate_members m
      where m.candidate_set_id = new.id and m.attempt_id = new.promoted_attempt_id
    ) then
      raise exception 'promoted attempt % is not a member of candidate set %', new.promoted_attempt_id, new.id;
    end if;
    if not exists (
      select 1 from generation_attempts a
      where a.id = new.promoted_attempt_id and a.status = 'succeeded'
    ) then
      raise exception 'only a succeeded generation can be promoted';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger generation_candidate_sets_guard before update on generation_candidate_sets
  for each row execute function guard_candidate_set();

-- A member's planned identity is frozen; only its attempt link and submit outcome may be recorded (once).
create or replace function guard_candidate_member() returns trigger
language plpgsql as $$
begin
  if new.candidate_set_id is distinct from old.candidate_set_id
     or new.project_id is distinct from old.project_id
     or new.label is distinct from old.label
     or new.position is distinct from old.position
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.input_mode is distinct from old.input_mode
     or new.tier_id is distinct from old.tier_id
     or new.native_audio is distinct from old.native_audio
     or new.estimate_usd is distinct from old.estimate_usd
     or new.plan is distinct from old.plan then
    raise exception 'candidate member % is a frozen plan', old.id;
  end if;
  if old.attempt_id is not null and new.attempt_id is distinct from old.attempt_id then
    raise exception 'candidate member % already has an attempt', old.id;
  end if;
  return new;
end;
$$;
create trigger generation_candidate_members_guard before update on generation_candidate_members
  for each row execute function guard_candidate_member();

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table generation_candidate_sets enable row level security;
alter table generation_candidate_members enable row level security;
alter table generation_reviews enable row level security;
alter table generation_candidate_events enable row level security;

create policy generation_candidate_sets_owner on generation_candidate_sets for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy generation_candidate_members_owner on generation_candidate_members for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy generation_reviews_owner on generation_reviews for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy generation_candidate_events_owner on generation_candidate_events for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker. Human review and winner selection are
-- not worker authority; db:candidates asserts the workers cannot read or write any of these tables.
