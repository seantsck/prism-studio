-- 0055: Story Intelligence — the AI writing assistant (Phase 5B-S2). Additive: four tables, worker grants.
--
-- Prism PROPOSES writing; the creator decides what becomes canon. The canonical screenplay stays `episodes.script_text`
-- (everything downstream already reads it). This migration adds:
--   * script_revisions     IMMUTABLE history of an Episode's accepted script text (baseline, import, creator edit, AI
--                          revision, restore). Insert-only: the previous accepted text is always recoverable.
--   * writing_sessions     one writing conversation on an Episode, and its optional capped spend authorization (the
--                          creator allows up to $X for a few hours instead of confirming every small rewrite).
--   * writing_proposals    one row per Prism AI turn (a Story Revision Proposal or brainstorm). Frozen input (target
--                          range + text, instruction, frozen textual context, model, prompt version, estimate); the
--                          RESULT is written once by the Story worker; the creator only accepts / rejects / bookmarks.
--   * scene_story_changes  "Story changed after production breakdown": a Scene whose text an accepted revision changed.
--                          Only `reviewed_at` ever changes. Nothing downstream is deleted or rewritten automatically.
-- NOT applied to hosted DEV until the owner authorizes it (like 0051–0054).

-- ───────────────────────── script_revisions ─────────────────────────
create table script_revisions (
  id                  uuid primary key,
  project_id          uuid not null references projects (id) on delete cascade,
  episode_id          uuid not null references episodes (id) on delete cascade,
  number              integer not null check (number >= 1),
  origin              text not null check (origin in ('baseline', 'import', 'creator_edit', 'ai_revision', 'restore')),
  text                text not null check (length(text) <= 1500000),
  fingerprint         text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  parent_revision_id  uuid references script_revisions (id),
  writing_proposal_id uuid,
  alternative_index   integer check (alternative_index between 0 and 4),
  story_proposal_id   uuid references story_proposals (id),
  restored_from_id    uuid references script_revisions (id),
  changed_range       jsonb check (changed_range is null or jsonb_typeof(changed_range) = 'object'),
  changed_scene_ids   uuid[] not null default '{}',
  created_by          uuid,
  created_at          timestamptz not null default now(),
  unique (episode_id, number),
  check ((origin = 'ai_revision') = (writing_proposal_id is not null and alternative_index is not null)),
  check (origin <> 'import' or story_proposal_id is not null),
  check (origin <> 'restore' or restored_from_id is not null),
  check ((number = 1) = (parent_revision_id is null))
);
create index script_revisions_episode_idx on script_revisions (episode_id, number desc);
create index script_revisions_project_idx on script_revisions (project_id);

-- ───────────────────────── writing_sessions ─────────────────────────
create table writing_sessions (
  id                uuid primary key,
  project_id        uuid not null references projects (id) on delete cascade,
  episode_id        uuid not null references episodes (id) on delete cascade,
  title             text not null default '' check (length(title) <= 200),
  budget_usd        numeric(12, 6) not null default 0 check (budget_usd >= 0),
  reserved_usd      numeric(12, 6) not null default 0 check (reserved_usd >= 0),
  budget_expires_at timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  check (reserved_usd <= budget_usd)
);
create index writing_sessions_episode_idx on writing_sessions (episode_id, created_at desc);

-- ───────────────────────── writing_proposals ─────────────────────────
create table writing_proposals (
  id                     uuid primary key,
  project_id             uuid not null references projects (id) on delete cascade,
  session_id             uuid not null references writing_sessions (id) on delete cascade,
  episode_id             uuid not null references episodes (id) on delete cascade,
  turn                   integer not null check (turn >= 1),
  parent_id              uuid references writing_proposals (id),
  parent_alternative     integer check (parent_alternative between 0 and 4),
  mode                   text not null check (mode in ('custom', 'rewrite', 'continue', 'dialogue', 'tone', 'condense',
                                                       'expand', 'brainstorm')),
  scope                  jsonb not null check (jsonb_typeof(scope) = 'object'
                                               and scope ->> 'kind' in ('selection', 'scene', 'episode')),
  instruction            text not null check (length(instruction) between 1 and 4000),
  alternatives_requested integer not null check (alternatives_requested between 1 and 10),
  base_fingerprint       text not null check (base_fingerprint ~ '^[0-9a-f]{64}$'),
  base_revision_id       uuid references script_revisions (id),
  target_text            text not null check (length(target_text) <= 400000),
  draft_text             text check (draft_text is null or length(draft_text) <= 400000),
  context                jsonb not null check (jsonb_typeof(context) = 'object'),
  provider               text not null check (length(provider) between 1 and 64),
  model                  text not null check (length(model) between 1 and 96),
  schema_version         text not null,
  prompt_version         text not null,
  estimate               jsonb not null check (jsonb_typeof(estimate) = 'object'),
  confirmed_usd          numeric(12, 6) check (confirmed_usd is null or confirmed_usd >= 0),
  spend_authorization    text not null check (spend_authorization in ('free', 'confirmed', 'session')),
  status                 text not null check (status in ('queued', 'running', 'ready', 'failed', 'accepted', 'rejected')),
  result                 jsonb,
  usage                  jsonb,
  actual_usd             numeric(12, 6),
  provider_calls         integer not null default 0 check (provider_calls between 0 and 10),
  error                  jsonb,
  attempts               integer not null default 0 check (attempts between 0 and 10),
  next_run_at            timestamptz not null default now(),
  lease_owner            text,
  lease_expires_at       timestamptz,
  accepted_alternative   integer check (accepted_alternative between 0 and 4),
  accepted_revision_id   uuid references script_revisions (id),
  saved_alternatives     integer[] not null default '{}',
  decided_at             timestamptz,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  completed_at           timestamptz,
  unique (session_id, turn),
  check (parent_alternative is null or parent_id is not null),
  check (status not in ('ready', 'accepted', 'rejected') or result is not null),
  check ((status = 'accepted') = (accepted_alternative is not null and accepted_revision_id is not null)),
  check (status not in ('accepted', 'rejected') or decided_at is not null),
  check (mode <> 'brainstorm' or status <> 'accepted'),
  check ((spend_authorization = 'free') = (confirmed_usd is null))
);
create index writing_proposals_session_idx on writing_proposals (session_id, turn);
create index writing_proposals_queue_idx on writing_proposals (next_run_at) where status = 'queued';

alter table script_revisions
  add constraint script_revisions_writing_proposal_fk foreign key (writing_proposal_id) references writing_proposals (id);

-- ───────────────────────── scene_story_changes ─────────────────────────
create table scene_story_changes (
  scene_id    uuid not null references scenes (id) on delete cascade,
  revision_id uuid not null references script_revisions (id) on delete cascade,
  project_id  uuid not null references projects (id) on delete cascade,
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz,
  primary key (scene_id, revision_id)
);
create index scene_story_changes_open_idx on scene_story_changes (project_id) where reviewed_at is null;

-- ───────────────────────── same-project references ─────────────────────────
create or replace function check_story_writing_refs() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'script_revisions' then
    if not exists (select 1 from episodes e where e.id = new.episode_id and e.project_id = new.project_id) then
      raise exception 'the revision''s Episode is not in this project';
    end if;
    if new.parent_revision_id is not null and not exists (
      select 1 from script_revisions r where r.id = new.parent_revision_id and r.episode_id = new.episode_id
    ) then
      raise exception 'the parent revision is not of this Episode';
    end if;
    if new.restored_from_id is not null and not exists (
      select 1 from script_revisions r where r.id = new.restored_from_id and r.episode_id = new.episode_id
    ) then
      raise exception 'the restored revision is not of this Episode';
    end if;
    if new.writing_proposal_id is not null and not exists (
      select 1 from writing_proposals p where p.id = new.writing_proposal_id and p.episode_id = new.episode_id
        and p.mode <> 'brainstorm' and p.status = 'ready' and new.alternative_index < jsonb_array_length(p.result -> 'alternatives')
    ) then
      raise exception 'an AI revision must come from a ready proposal of this Episode';
    end if;
    if new.story_proposal_id is not null and not exists (
      select 1 from story_proposals s where s.id = new.story_proposal_id and s.project_id = new.project_id
    ) then
      raise exception 'the Story proposal is not in this project';
    end if;
  elsif tg_table_name = 'writing_sessions' then
    if not exists (select 1 from episodes e where e.id = new.episode_id and e.project_id = new.project_id) then
      raise exception 'the session''s Episode is not in this project';
    end if;
  elsif tg_table_name = 'writing_proposals' then
    if not exists (
      select 1 from writing_sessions s where s.id = new.session_id and s.project_id = new.project_id
        and s.episode_id = new.episode_id
    ) then
      raise exception 'the writing session is not of this Episode';
    end if;
    if new.parent_id is not null and not exists (
      select 1 from writing_proposals p where p.id = new.parent_id and p.session_id = new.session_id
    ) then
      raise exception 'the revised proposal is not in this session';
    end if;
    if new.base_revision_id is not null and not exists (
      select 1 from script_revisions r where r.id = new.base_revision_id and r.episode_id = new.episode_id
    ) then
      raise exception 'the base revision is not of this Episode';
    end if;
  elsif tg_table_name = 'scene_story_changes' then
    if not exists (
      select 1 from scenes sc join script_revisions r on r.episode_id = sc.episode_id
       where sc.id = new.scene_id and r.id = new.revision_id and sc.project_id = new.project_id
    ) then
      raise exception 'the Scene and the revision must be of the same Episode of this project';
    end if;
  end if;
  return new;
end;
$$;
create trigger script_revisions_refs before insert on script_revisions
  for each row execute function check_story_writing_refs();
create trigger writing_sessions_refs before insert on writing_sessions
  for each row execute function check_story_writing_refs();
create trigger writing_proposals_refs before insert on writing_proposals
  for each row execute function check_story_writing_refs();
create trigger scene_story_changes_refs before insert on scene_story_changes
  for each row execute function check_story_writing_refs();

-- ───────────────────────── immutability ─────────────────────────
create or replace function guard_script_revision_update() returns trigger
language plpgsql as $$
begin
  raise exception 'a script revision is immutable (history is never rewritten)';
end;
$$;
create trigger script_revisions_immutable before update on script_revisions
  for each row execute function guard_script_revision_update();

create or replace function guard_writing_session_update() returns trigger
language plpgsql as $$
begin
  if (new.id, new.project_id, new.episode_id, new.created_by, new.created_at)
     is distinct from (old.id, old.project_id, old.episode_id, old.created_by, old.created_at) then
    raise exception 'a writing session''s identity is immutable';
  end if;
  if new.reserved_usd < old.reserved_usd then
    raise exception 'reserved writing spend never decreases';
  end if;
  return new;
end;
$$;
create trigger writing_sessions_update_guard before update on writing_sessions
  for each row execute function guard_writing_session_update();

create or replace function guard_writing_proposal_insert() returns trigger
language plpgsql as $$
begin
  if current_user <> 'prism_story_worker' and (
    new.status <> 'queued' or new.result is not null or new.usage is not null or new.actual_usd is not null
    or new.error is not null or new.attempts <> 0 or new.provider_calls <> 0 or new.lease_owner is not null
    or new.completed_at is not null or new.accepted_alternative is not null or new.accepted_revision_id is not null
    or new.decided_at is not null or cardinality(new.saved_alternatives) <> 0
  ) then
    raise exception 'a new writing proposal starts queued, without a result';
  end if;
  return new;
end;
$$;
create trigger writing_proposals_insert_guard before insert on writing_proposals
  for each row execute function guard_writing_proposal_insert();

create or replace function guard_writing_proposal_update() returns trigger
language plpgsql as $$
begin
  if (new.id, new.project_id, new.session_id, new.episode_id, new.turn, new.parent_id, new.parent_alternative,
      new.mode, new.scope, new.instruction, new.alternatives_requested, new.base_fingerprint, new.base_revision_id,
      new.target_text, new.draft_text, new.context, new.provider, new.model, new.schema_version, new.prompt_version,
      new.estimate, new.confirmed_usd, new.spend_authorization, new.created_by, new.created_at)
     is distinct from
     (old.id, old.project_id, old.session_id, old.episode_id, old.turn, old.parent_id, old.parent_alternative,
      old.mode, old.scope, old.instruction, old.alternatives_requested, old.base_fingerprint, old.base_revision_id,
      old.target_text, old.draft_text, old.context, old.provider, old.model, old.schema_version, old.prompt_version,
      old.estimate, old.confirmed_usd, old.spend_authorization, old.created_by, old.created_at) then
    raise exception 'a writing proposal''s input is immutable';
  end if;
  if old.result is not null and new.result is distinct from old.result then
    raise exception 'a writing proposal is immutable once written';
  end if;
  if old.status in ('ready', 'failed', 'accepted', 'rejected')
     and (new.usage, new.actual_usd, new.provider_calls, new.error, new.completed_at)
         is distinct from (old.usage, old.actual_usd, old.provider_calls, old.error, old.completed_at) then
    raise exception 'a writing proposal''s result is written once';
  end if;
  if old.status in ('accepted', 'rejected')
     and (new.status, new.accepted_alternative, new.accepted_revision_id, new.decided_at)
         is distinct from (old.status, old.accepted_alternative, old.accepted_revision_id, old.decided_at) then
    raise exception 'a decided writing proposal is final';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'queued' and new.status in ('running', 'failed'))
    or (old.status = 'running' and new.status in ('ready', 'failed', 'queued'))
    or (old.status = 'ready' and new.status in ('accepted', 'rejected'))
  ) then
    raise exception 'invalid writing proposal status change';
  end if;
  if new.saved_alternatives is distinct from old.saved_alternatives and old.status not in ('ready', 'accepted', 'rejected') then
    raise exception 'only a written proposal can be bookmarked';
  end if;
  if current_user = 'prism_story_worker' then
    if new.status in ('accepted', 'rejected')
       or (new.accepted_alternative, new.accepted_revision_id, new.decided_at, new.saved_alternatives)
          is distinct from (old.accepted_alternative, old.accepted_revision_id, old.decided_at, old.saved_alternatives) then
      raise exception 'the Story worker does not decide writing proposals';
    end if;
  elsif (new.result, new.usage, new.actual_usd, new.provider_calls, new.error, new.completed_at, new.attempts,
         new.next_run_at, new.lease_owner, new.lease_expires_at)
        is distinct from
        (old.result, old.usage, old.actual_usd, old.provider_calls, old.error, old.completed_at, old.attempts,
         old.next_run_at, old.lease_owner, old.lease_expires_at)
        or (new.status is distinct from old.status and new.status not in ('accepted', 'rejected')) then
    raise exception 'only the Story worker writes a writing proposal''s result';
  end if;
  return new;
end;
$$;
create trigger writing_proposals_update_guard before update on writing_proposals
  for each row execute function guard_writing_proposal_update();

create or replace function guard_scene_story_change_update() returns trigger
language plpgsql as $$
begin
  if (new.scene_id, new.revision_id, new.project_id, new.created_at)
     is distinct from (old.scene_id, old.revision_id, old.project_id, old.created_at)
     or old.reviewed_at is not null or new.reviewed_at is null then
    raise exception 'a story change is only marked reviewed, once';
  end if;
  return new;
end;
$$;
create trigger scene_story_changes_update_guard before update on scene_story_changes
  for each row execute function guard_scene_story_change_update();

-- ───────────────────────── RLS: owner only; no delete (history) ─────────────────────────
alter table script_revisions enable row level security;
create policy script_revisions_select on script_revisions for select to authenticated
  using (is_project_owner(project_id));
create policy script_revisions_insert on script_revisions for insert to authenticated
  with check (is_project_owner(project_id));

alter table writing_sessions enable row level security;
create policy writing_sessions_select on writing_sessions for select to authenticated
  using (is_project_owner(project_id));
create policy writing_sessions_insert on writing_sessions for insert to authenticated
  with check (is_project_owner(project_id));
create policy writing_sessions_update on writing_sessions for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table writing_proposals enable row level security;
create policy writing_proposals_select on writing_proposals for select to authenticated
  using (is_project_owner(project_id));
create policy writing_proposals_insert on writing_proposals for insert to authenticated
  with check (is_project_owner(project_id));
create policy writing_proposals_update on writing_proposals for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table scene_story_changes enable row level security;
create policy scene_story_changes_select on scene_story_changes for select to authenticated
  using (is_project_owner(project_id));
create policy scene_story_changes_insert on scene_story_changes for insert to authenticated
  with check (is_project_owner(project_id));
create policy scene_story_changes_update on scene_story_changes for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- ───────────────────────── the Story worker: writing proposals in flight, nothing else ─────────────────────────
-- Same rule as 0054: the worker reads only the frozen row it works on (target text + frozen textual context) and
-- writes only its result. No access to script_revisions, writing_sessions, scene_story_changes or project content.
grant select on writing_proposals to prism_story_worker;
grant update (status, result, usage, actual_usd, provider_calls, error, attempts, next_run_at, lease_owner,
              lease_expires_at, completed_at) on writing_proposals to prism_story_worker;
create policy writing_proposals_worker_select on writing_proposals for select to prism_story_worker
  using (status in ('queued', 'running') or (lease_owner is not null and lease_expires_at > now()));
create policy writing_proposals_worker_update on writing_proposals for update to prism_story_worker
  using (status in ('queued', 'running') or (lease_owner is not null and lease_expires_at > now())) with check (true);
-- NOTE: no grant on these tables to prism_generation_worker or prism_continuity_worker.
