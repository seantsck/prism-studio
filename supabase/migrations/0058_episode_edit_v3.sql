-- 0058: Phase 5B-V3 practical Episode editing ON the 2I.1 Episode Edit (0043 / 0046). Additive; no second timeline.
--
--   episode_edit_items.incoming_transition   the transition INTO an item: NULL = a straight cut (the default), or a
--                                            cross dissolve {kind, durationMs, fromItemId}, bound to the predecessor it
--                                            was chosen against (like the 0046 cut intent). Editorial metadata only:
--                                            no source is rendered into or changed.
--   episode_edits.titles                     the edit's title cards (opening / closing): text, duration, style. Not
--                                            Shots and not media, so they are part of the edit row, not items.
--   episode_edit_revisions                   SAVED revisions: an immutable snapshot of the edit's editorial state,
--                                            numbered 1, 2, … per edit. Insert-only for the owner; never updated;
--                                            removed only with its edit / Project. A restore writes the edit (a new
--                                            working revision) and a NEW saved revision; it never touches the old one.
--
-- Invariants enforced HERE, not only in the application (src/domain/edit/timeline.ts, src/data/episode-edit-ops.ts):
--   * a transition's shape; a dissolve lasts 100 … 2000 ms and at most half of the SHORTER of its two items, names the
--     item immediately before it, and the first item has none (checked at COMMIT, after the repository renumbers);
--   * title cards: an array of at most one opening and one closing card, real text, 0.5 … 20 s, a known style;
--   * a saved revision's snapshot is an object with items / titles arrays and a sha256 fingerprint; it cannot be
--     updated by anyone (trigger) and the owner has no update / delete policy.
--
-- Authority: USER-domain, owner-only RLS like 0043. The generation and continuity workers get NO grant.
-- Local / disposable only until the owner authorizes hosted DEV (like 0051–0057). Forward-only; 0001–0057 untouched.

-- ───────────────────────── episode_edit_items.incoming_transition ─────────────────────────

-- The EditTransition shape of src/domain/edit/model.ts (immutable literal checks only, so a CHECK can use it).
create or replace function episode_edit_transition_valid(t jsonb) returns boolean
language sql immutable as $$
  select t is null or coalesce((
    jsonb_typeof(t) = 'object'
    and not exists (select 1 from jsonb_object_keys(t) k where k not in ('kind', 'durationMs', 'fromItemId'))
    and t ->> 'kind' = 'dissolve'
    and jsonb_typeof(t -> 'durationMs') = 'number'
    and (t ->> 'durationMs') ~ '^\d+$'
    and (t ->> 'durationMs')::integer between 100 and 2000
    and jsonb_typeof(t -> 'fromItemId') = 'string'
    and (t ->> 'fromItemId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), false)
$$;

alter table episode_edit_items
  add column incoming_transition jsonb
    constraint episode_edit_items_transition_valid check (episode_edit_transition_valid(incoming_transition));

-- At COMMIT: a dissolve names exactly the item before it, the first item has none, and it fits both neighbours.
create or replace function check_episode_edit_transitions() returns trigger
language plpgsql as $$
declare
  eid uuid;
  bad record;
begin
  if tg_op = 'DELETE' then
    eid := old.edit_id;
  else
    eid := new.edit_id;
  end if;
  select * into bad from (
    select cur.id,
           (prev.id is null or prev.id::text <> cur.incoming_transition ->> 'fromItemId') as stale,
           (cur.incoming_transition ->> 'durationMs')::integer as d,
           least(2000, floor(least(
             case when prev.visual_kind = 'video' then prev.source_out_ms - prev.source_in_ms else prev.duration_ms end,
             case when cur.visual_kind = 'video' then cur.source_out_ms - cur.source_in_ms else cur.duration_ms end
           ) / 2.0))::integer as max_ms
      from episode_edit_items cur
      left join episode_edit_items prev on prev.edit_id = cur.edit_id and prev.position = cur.position - 1
     where cur.edit_id = eid
       and cur.incoming_transition is not null
  ) x
   where x.stale or x.max_ms is null or x.d > x.max_ms
   limit 1;
  if found then
    if bad.stale then
      raise exception 'episode edit item %: its transition must name the item immediately before it', bad.id;
    end if;
    raise exception 'episode edit item %: a % ms dissolve is longer than its neighbours allow (% ms)',
      bad.id, bad.d, bad.max_ms;
  end if;
  return null;
end;
$$;
create constraint trigger episode_edit_items_transition_check
  after insert or update or delete on episode_edit_items deferrable initially deferred
  for each row execute function check_episode_edit_transitions();

-- ───────────────────────── episode_edits.titles ─────────────────────────

create or replace function episode_edit_titles_valid(t jsonb) returns boolean
language sql immutable as $$
  select coalesce((
    jsonb_typeof(t) = 'array'
    and jsonb_array_length(t) <= 2
    and not exists (
      select 1 from jsonb_array_elements(t) c
      where jsonb_typeof(c) <> 'object'
         or exists (
           select 1 from jsonb_object_keys(c) k
           where k not in ('id', 'placement', 'title', 'subtitle', 'durationMs', 'style')
         )
         or jsonb_typeof(c -> 'id') <> 'string'
         or (c ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or coalesce(c ->> 'placement', '') not in ('opening', 'closing')
         or jsonb_typeof(c -> 'title') <> 'string'
         or char_length(btrim(c ->> 'title')) not between 1 and 200
         or jsonb_typeof(c -> 'subtitle') <> 'string'
         or char_length(c ->> 'subtitle') > 200
         or jsonb_typeof(c -> 'durationMs') <> 'number'
         or (c ->> 'durationMs') !~ '^\d+$'
         or (c ->> 'durationMs')::integer not between 500 and 20000
         or coalesce(c ->> 'style', '') not in ('film', 'plain')
    )
    and (select count(distinct c ->> 'placement') from jsonb_array_elements(t) c) = jsonb_array_length(t)
  ), false)
$$;

alter table episode_edits
  add column titles jsonb not null default '[]'::jsonb
    constraint episode_edits_titles_valid check (episode_edit_titles_valid(titles));

-- ───────────────────────── episode_edit_revisions ─────────────────────────

create table episode_edit_revisions (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects (id) on delete cascade,
  edit_id         uuid not null,
  -- 1, 2, … per edit
  number          integer not null check (number >= 1),
  -- the edit's working revision counter when it was saved
  edit_revision   bigint not null check (edit_revision >= 0),
  label           text not null default '' check (char_length(label) <= 120),
  -- the editorial state, exactly as it was (src/domain/edit/revision.ts EditState)
  snapshot        jsonb not null check (
    jsonb_typeof(snapshot) = 'object'
    and jsonb_typeof(snapshot -> 'items') = 'array'
    and jsonb_typeof(snapshot -> 'titles') = 'array'
    and jsonb_typeof(snapshot -> 'editRate') = 'object'
  ),
  fingerprint     text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  restored_from   uuid references episode_edit_revisions (id),
  created_by      uuid,
  created_at      timestamptz not null default now(),

  unique (edit_id, number),
  foreign key (edit_id, project_id) references episode_edits (id, project_id) on delete cascade
);
create index episode_edit_revisions_project_idx on episode_edit_revisions (project_id);

-- immutable: a saved revision is history (its edit / Project going removes it by cascade; nothing edits it)
create or replace function refuse_episode_edit_revision_update() returns trigger
language plpgsql as $$
begin
  raise exception 'a saved edit revision is immutable';
end;
$$;
create trigger episode_edit_revisions_immutable before update on episode_edit_revisions
  for each row execute function refuse_episode_edit_revision_update();

alter table episode_edit_revisions enable row level security;
create policy episode_edit_revisions_owner_select on episode_edit_revisions for select to authenticated
  using (is_project_owner(project_id));
create policy episode_edit_revisions_owner_insert on episode_edit_revisions for insert to authenticated
  with check (is_project_owner(project_id));
grant select, insert on episode_edit_revisions to authenticated;

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:episode-edits asserts they have no
-- privilege.
