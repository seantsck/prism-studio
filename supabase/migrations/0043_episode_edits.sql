-- 0043: Phase 2I.1B EPISODE EDITS (the persisted editorial decision of an Episode: which picture, which trims, which
-- performance takes, in which order). See docs/timeline-performance-assembly.md.
--
--   episode_edits                  one edit of one Episode: its own stable id, a RATIONAL edit rate and a revision
--                                  counter (optimistic concurrency: every mutation compares and bumps it under a row
--                                  lock). "One edit per Episode" is a Phase 2I.1 rule, enforced by the REMOVABLE
--                                  `episode_edits_one_per_episode` (alternate cuts drop it; no key or API changes).
--   episode_edit_items             the edit's items in explicit order (dense `position`, unique per edit, DEFERRABLE so
--                                  a reorder is one transaction). Each item has its own id and names its picture by
--                                  kind (video = exact attempt + exact Asset + source in/out; production_frame /
--                                  storyboard_frame = a placeholder still of THIS Shot held for duration_ms; none =
--                                  an empty slot held for duration_ms). "One item per Shot" is the REMOVABLE
--                                  `episode_edit_items_one_per_shot` (intercutting drops it).
--   episode_edit_audio_placements  the performance under an item: references only (line + exact take), timed relative
--                                  to the item's start (`start_ms` is signed). No audio bytes, no copied take metadata;
--                                  no placement = explicit silence. Placements stay INSIDE their item in Phase 2I.1:
--                                  `episode_edit_audio_placements_start_inside_item` (start >= 0) and the end check in
--                                  `check_episode_edit_audio_placement` / `check_episode_edit_item_source` are the
--                                  rule J/L cuts later RELAX; the stored shape already represents them.
--
-- Invariants enforced HERE, not only in the application:
--   * nothing crosses a Project: every reference is a composite (id, project_id) key; an edit's Episode, an item's Shot
--     (the SAME Episode as its edit: (shot_id, episode_id, project_id)), a video item's attempt (the SAME Shot:
--     (attempt_id, shot_id, project_id)), a placeholder frame (the SAME Shot), a placement's take (the SAME line);
--   * exactly the columns of an item's kind are set (CHECK);
--   * a video item's attempt succeeded, is not a Production Frame candidate, and its Asset is a video with a known
--     probed duration that IS one of the attempt's playable pictures (a primary / variant output or a delivery
--     derivation of that attempt), with source_out_ms <= the Asset's duration (trigger);
--   * a placement's take is not archived when placed and plays inside the take; the placement plays inside its item,
--     also when the item is trimmed later (triggers on both tables);
--   * an edit only ever references immutable things: attempts' creative fields, Assets, frames, takes. The mutable
--     pointers (approval, Best, delivery master, selections) only drive REPORTED facts in the application.
--
-- Boundary with the application (src/data/episode-edit-*.ts): the repositories are the authority for the Shot-output
-- classification (`isShotOutputAttempt`: any purpose other than `production_frame`, including history with no or an
-- unknown purpose). The trigger here refuses exactly the literal `production_frame` purpose, which is a subset of what
-- the classifier refuses (defence in depth that can never contradict it); it does not re-implement the classifier.
-- Revision checks, op semantics, dense renumbering and the "explicit replacement" rule are repository logic run inside
-- one transaction under the edit's row lock.
--
-- Deletion: a Shot, attempt, Asset, frame or take referenced by an edit cannot be deleted directly (NO ACTION). Every
-- such key is DEFERRABLE INITIALLY DEFERRED (the 0005 / 0042 pattern) so a Project or Episode cascade, which removes the
-- edit and the referenced rows in the same statement, passes at commit, while a direct delete is still refused at
-- commit. Upstream changes never cascade INTO an edit (no `on delete cascade` / `set null` from a source), so editorial
-- history is never silently destroyed; removing the item first is the explicit way to free a Shot.
--
-- Authority: USER-domain tables, owner-only RLS (is_project_owner), one `for all` policy each. The generation and
-- continuity workers get NO grant: the edit is not a generation package or QA input. Forward-only; 0001-0042 untouched.

-- ───────────────────────── keys on existing tables (idempotent) ─────────────────────────

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'episodes_id_project_key') then
    alter table episodes add constraint episodes_id_project_key unique (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shots_id_episode_project_key') then
    alter table shots add constraint shots_id_episode_project_key unique (id, episode_id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'generation_attempts_id_shot_project_key') then
    alter table generation_attempts
      add constraint generation_attempts_id_shot_project_key unique (id, shot_id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'storyboard_frames_id_shot_project_key') then
    alter table storyboard_frames
      add constraint storyboard_frames_id_shot_project_key unique (id, shot_id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'performance_takes_id_line_project_key') then
    alter table performance_takes
      add constraint performance_takes_id_line_project_key unique (id, dialogue_line_id, project_id);
  end if;
end $$;

-- ───────────────────────── edits ─────────────────────────

create table episode_edits (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects (id) on delete cascade,
  episode_id     uuid not null,
  -- rational edit rate (frames per second = num / den); only the supported rates
  edit_rate_num  integer not null check (edit_rate_num > 0),
  edit_rate_den  integer not null check (edit_rate_den > 0),
  -- bumped by exactly one in every mutating transaction (compare-and-set under `for update`)
  revision       bigint not null default 0 check (revision >= 0),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Phase 2I.1 rule, REMOVABLE (alternate cuts): the Episode is an owning reference, never the edit's identity
  constraint episode_edits_one_per_episode unique (episode_id),
  unique (id, project_id),
  -- the composite key an item references: an item carries its edit's Episode and Project
  unique (id, episode_id, project_id),
  foreign key (episode_id, project_id) references episodes (id, project_id) on delete cascade,
  check ((edit_rate_num, edit_rate_den) in ((24, 1), (24000, 1001), (25, 1), (30000, 1001), (30, 1)))
);
create index episode_edits_project_idx on episode_edits (project_id);
create trigger episode_edits_updated before update on episode_edits
  for each row execute function set_updated_at();

-- ───────────────────────── items ─────────────────────────

create table episode_edit_items (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  edit_id              uuid not null,
  -- denormalised so "the Shot belongs to the edit's Episode" is a key, not a trigger
  episode_id           uuid not null,
  shot_id              uuid not null,
  -- dense 0..n-1 editorial order (the repository renumbers); unique per edit at commit
  position             integer not null check (position >= 0),
  visual_kind          text not null check (visual_kind in ('video', 'production_frame', 'storyboard_frame', 'none')),
  -- video: the exact clip the trims refer to (duration = source_out_ms - source_in_ms)
  attempt_id           uuid,
  asset_id             uuid,
  source_in_ms         integer check (source_in_ms >= 0),
  source_out_ms        integer check (source_out_ms > source_in_ms),
  -- placeholders: the still of THIS Shot
  production_frame_id  uuid,
  storyboard_frame_id  uuid,
  -- stills / none: how long the item holds
  duration_ms          integer check (duration_ms > 0),
  -- the Shot's performance / timing part fingerprints when the performance was placed (null = no basis)
  performance_basis    jsonb check (
    performance_basis is null or (
      jsonb_typeof(performance_basis) = 'object'
      and jsonb_typeof(performance_basis -> 'performance') = 'string'
      and jsonb_typeof(performance_basis -> 'timing') = 'string'
    )
  ),
  -- the clip's OWN audio track; muted by default (the performance takes are the dialogue truth)
  source_audio         text not null default 'muted' check (source_audio in ('muted', 'included')),
  placed_by            uuid,
  placed_at            timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint episode_edit_items_position_key unique (edit_id, position) deferrable initially deferred,
  -- Phase 2I.1 rule, REMOVABLE (intercutting): items are addressed by their own id, never by Shot
  constraint episode_edit_items_one_per_shot unique (edit_id, shot_id),
  unique (id, project_id),
  foreign key (edit_id, episode_id, project_id)
    references episode_edits (id, episode_id, project_id) on delete cascade,
  -- NO ACTION, deferred: a Shot in an edit cannot be deleted directly; a Project / Episode cascade still passes
  foreign key (shot_id, episode_id, project_id) references shots (id, episode_id, project_id)
    deferrable initially deferred,
  -- the attempt is of THIS Shot (and Project)
  foreign key (attempt_id, shot_id, project_id) references generation_attempts (id, shot_id, project_id)
    deferrable initially deferred,
  foreign key (asset_id, project_id) references assets (id, project_id) deferrable initially deferred,
  foreign key (production_frame_id, shot_id, project_id)
    references shot_production_frames (id, shot_id, project_id) deferrable initially deferred,
  foreign key (storyboard_frame_id, shot_id, project_id)
    references storyboard_frames (id, shot_id, project_id) deferrable initially deferred,
  -- exactly the columns of the kind: a mixed or ambiguous picture cannot be stored
  constraint episode_edit_items_kind_columns check (
    case visual_kind
      when 'video' then
        attempt_id is not null and asset_id is not null and source_in_ms is not null and source_out_ms is not null
        and production_frame_id is null and storyboard_frame_id is null and duration_ms is null
      when 'production_frame' then
        production_frame_id is not null and duration_ms is not null
        and attempt_id is null and asset_id is null and source_in_ms is null and source_out_ms is null
        and storyboard_frame_id is null
      when 'storyboard_frame' then
        storyboard_frame_id is not null and duration_ms is not null
        and attempt_id is null and asset_id is null and source_in_ms is null and source_out_ms is null
        and production_frame_id is null
      else
        duration_ms is not null
        and attempt_id is null and asset_id is null and source_in_ms is null and source_out_ms is null
        and production_frame_id is null and storyboard_frame_id is null
    end
  )
);
create index episode_edit_items_shot_idx on episode_edit_items (shot_id);
create index episode_edit_items_attempt_idx on episode_edit_items (attempt_id);
create index episode_edit_items_asset_idx on episode_edit_items (asset_id);
create index episode_edit_items_project_idx on episode_edit_items (project_id);
create trigger episode_edit_items_updated before update on episode_edit_items
  for each row execute function set_updated_at();

-- the picture an item names must be placeable, and its placements must still fit when its duration changes
create or replace function check_episode_edit_item_source() returns trigger
language plpgsql as $$
declare
  att generation_attempts%rowtype;
  a assets%rowtype;
  item_duration integer;
begin
  if new.visual_kind = 'video' then
    select * into att from generation_attempts where id = new.attempt_id and project_id = new.project_id;
    if not found then
      raise exception 'the edit item''s generation attempt does not exist in this project';
    end if;
    if att.shot_id <> new.shot_id then
      raise exception 'the edit item''s generation attempt belongs to another Shot';
    end if;
    if att.status <> 'succeeded' then
      raise exception 'only a completed generation can be placed in the edit';
    end if;
    -- the repository applies the full Shot-output classifier; this refuses exactly the non-output literal
    if att.request ->> 'purpose' = 'production_frame' then
      raise exception 'a Production Frame candidate is not a Shot clip and cannot be placed as video';
    end if;
    select * into a from assets where id = new.asset_id and project_id = new.project_id;
    if not found then
      raise exception 'the edit item''s clip does not exist in this project';
    end if;
    if a.type <> 'video' then
      raise exception 'the edit item''s clip is not a video';
    end if;
    if not exists (
      select 1 from generation_outputs o
       where o.attempt_id = att.id and o.asset_id = a.id and o.role in ('primary', 'variant')
    ) and not exists (
      select 1 from asset_derivations d
       where d.attempt_id = att.id and d.child_asset_id = a.id and d.slot = 'delivery'
    ) then
      raise exception 'the edit item''s clip is not an output or delivery version of its generation';
    end if;
    if a.duration_ms is null then
      raise exception 'the edit item''s clip has no known duration, so its trim cannot be checked';
    end if;
    if new.source_out_ms > a.duration_ms then
      raise exception 'the edit item''s trim lies outside the clip (% ms > % ms)', new.source_out_ms, a.duration_ms;
    end if;
    item_duration := new.source_out_ms - new.source_in_ms;
  else
    item_duration := new.duration_ms;
  end if;

  -- Phase 2I.1 rule, REMOVABLE with J/L cuts: placements stay inside the item, also after a trim
  if tg_op = 'UPDATE' and exists (
    select 1 from episode_edit_audio_placements p
     where p.item_id = new.id and p.start_ms + (p.take_out_ms - p.take_in_ms) > item_duration
  ) then
    raise exception 'the edit item would cut a placed performance: remove or move the performance first';
  end if;
  return new;
end;
$$;
create trigger episode_edit_items_source_check
  before insert or update of visual_kind, attempt_id, asset_id, source_in_ms, source_out_ms, production_frame_id,
    storyboard_frame_id, duration_ms, shot_id
  on episode_edit_items
  for each row execute function check_episode_edit_item_source();

-- ───────────────────────── audio placements ─────────────────────────

create table episode_edit_audio_placements (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  item_id           uuid not null,
  dialogue_line_id  uuid not null,
  take_id           uuid not null,
  -- signed, relative to the item's timeline start (a negative start is a J-cut, an end past the item an L-cut)
  start_ms          integer not null,
  take_in_ms        integer not null default 0 check (take_in_ms >= 0),
  take_out_ms       integer not null check (take_out_ms > take_in_ms),

  -- a line is placed at most once under an item (no placement = explicit silence)
  unique (item_id, dialogue_line_id),
  -- Phase 2I.1 rule, REMOVABLE with J/L cuts
  constraint episode_edit_audio_placements_start_inside_item check (start_ms >= 0),
  foreign key (item_id, project_id) references episode_edit_items (id, project_id) on delete cascade,
  -- the take is a take OF the line (and Project); takes are archived, never deleted
  foreign key (take_id, dialogue_line_id, project_id)
    references performance_takes (id, dialogue_line_id, project_id) deferrable initially deferred
);
create index episode_edit_audio_placements_take_idx on episode_edit_audio_placements (take_id);
create index episode_edit_audio_placements_project_idx on episode_edit_audio_placements (project_id);

create or replace function check_episode_edit_audio_placement() returns trigger
language plpgsql as $$
declare
  t performance_takes%rowtype;
  i episode_edit_items%rowtype;
  item_duration integer;
begin
  select * into t from performance_takes
   where id = new.take_id and dialogue_line_id = new.dialogue_line_id and project_id = new.project_id;
  if not found then
    raise exception 'the placed take is not a take of that line in this project';
  end if;
  -- archived takes stay referenced by existing placements; they cannot be newly placed
  if t.archived and (tg_op = 'INSERT' or new.take_id is distinct from old.take_id) then
    raise exception 'an archived take cannot be placed';
  end if;
  if new.take_out_ms > t.duration_ms then
    raise exception 'the placement plays beyond the end of its take (% ms > % ms)', new.take_out_ms, t.duration_ms;
  end if;
  select * into i from episode_edit_items where id = new.item_id and project_id = new.project_id;
  if not found then
    raise exception 'the placement''s edit item does not exist in this project';
  end if;
  item_duration := case when i.visual_kind = 'video' then i.source_out_ms - i.source_in_ms else i.duration_ms end;
  -- Phase 2I.1 rule, REMOVABLE with J/L cuts
  if new.start_ms + (new.take_out_ms - new.take_in_ms) > item_duration then
    raise exception 'the placement plays beyond the end of its edit item';
  end if;
  return new;
end;
$$;
create trigger episode_edit_audio_placements_check before insert or update on episode_edit_audio_placements
  for each row execute function check_episode_edit_audio_placement();

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table episode_edits enable row level security;
alter table episode_edit_items enable row level security;
alter table episode_edit_audio_placements enable row level security;

create policy episode_edits_owner on episode_edits for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy episode_edit_items_owner on episode_edit_items for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy episode_edit_audio_placements_owner on episode_edit_audio_placements for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:episode-edits asserts they have no
-- privilege.
