-- 0041: Phase 2G.4 CHARACTER CONTINUITY LOCKS (immutable approved appearance truth for one Character).
--
--   character_continuity_locks            IMMUTABLE approved snapshot of one Character in one exact Look (or in an
--                                         intentional no-Look state): the appearance facts copied BY VALUE
--                                         (prism.character-continuity-facts.v1: name, physical description, continuity
--                                         rules, Look identity + wardrobe / shoes / jewelry / hair / makeup / grooming /
--                                         body notes / accessories) and a deterministic fingerprint. A revised
--                                         appearance is a NEW Lock; there is deliberately no "current Lock" of a
--                                         Character, so a later Lock never rewrites an older Shot.
--   character_continuity_lock_assets      the Lock's exact reference images (identity slot images, then Look images), in
--                                         frozen order, each with the Asset's checksum and size at creation. IMMUTABLE.
--                                         Existing Assets are REUSED: a Lock never copies image bytes.
--   shot_character_continuity_selections  ONE mutable pointer per Shot Character assignment: which Lock that assignment
--                                         relies on. Changing it moves only this row.
--
-- The editable source libraries stay what they are: `characters`, `character_identity_refs` and `character_looks` are
-- NOT changed by this migration and stay editable. A Shot WITHOUT a selected Lock keeps reading them exactly as before.
--
-- Invariants enforced HERE, not only in the browser or the server:
--   * a Lock belongs to a Character of its own Project (composite FK); its source Look (if any) is a Look of that same
--     Character and Project when the Lock is created (trigger; the id is historical afterwards, like 0039/0040 sources);
--   * the facts snapshot names the Lock's own Character and source Look (CHECKs);
--   * a Lock image is a stored image of the same Project whose checksum and size are the Lock's frozen facts (trigger);
--   * a Lock's membership is complete at commit and can never grow later (deferred constraint triggers compare the
--     member count with the Lock's frozen reference_count); Locks and members are never updated in place (triggers);
--   * a selection names a Lock of the SAME Character (composite FK) as an EXISTING assignment of that Character to the
--     Shot (FK to shot_characters, cascading: removing the Character from the Shot removes the selection), and the
--     Lock's source Look IS the assignment's current Look, null = null included (trigger);
--   * when an assignment's Look changes, a selection of a Lock made for another Look is removed in the same statement,
--     so an old wardrobe can never be used silently;
--   * deletes only happen through Project / Character / Shot cascades (no delete policy on Locks or their members).
--
-- Authority: USER-domain tables, owner-only RLS (is_project_owner). Locks and members have SELECT and INSERT policies
-- only. The generation and continuity workers get NO grant (they consume the frozen request/package, never these
-- tables). Forward-only; 0001-0040 untouched. No 3D, GPU or provider involved.

-- ───────────────────────── Locks (immutable) ─────────────────────────

create table character_continuity_locks (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects (id) on delete cascade,
  character_id     uuid not null,
  -- historical id of the Look the facts were copied from (null = intentionally no Look). Not a foreign key: the
  -- insert trigger verifies it; the Lock stays interpretable from its own snapshot if the Look later goes.
  source_look_id   uuid,
  schema_version   text not null check (schema_version = 'prism.character-continuity-lock.v1'),
  name             text not null check (char_length(btrim(name)) between 1 and 120),
  facts_snapshot   jsonb not null check (
    jsonb_typeof(facts_snapshot) = 'object'
    and facts_snapshot ->> 'schema' = 'prism.character-continuity-facts.v1'
  ),
  -- how many reference images the Lock froze; its member rows must number exactly this (deferred check below)
  reference_count  integer not null check (reference_count between 0 and 64),
  -- deterministic identity (Character, source Look, facts, ordered role/slot + image checksum; no timestamps)
  lock_fingerprint text not null check (lock_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by       uuid,
  created_at       timestamptz not null default now(),

  unique (id, project_id),
  -- the composite key a selection references: a selection carries its Lock's Character and Project
  unique (id, character_id, project_id),
  -- exact same appearance basis for the same Character = the same Lock
  unique (character_id, lock_fingerprint),
  foreign key (character_id, project_id) references characters (id, project_id) on delete cascade,
  -- the snapshot is about THIS Character and THIS source Look (null = no Look, recorded intentionally)
  check (facts_snapshot ->> 'characterId' = character_id::text),
  check ((facts_snapshot ->> 'sourceLookId') is not distinct from source_look_id::text),
  check ((jsonb_typeof(facts_snapshot -> 'look') = 'object') = (source_look_id is not null))
);
create index character_continuity_locks_character_idx
  on character_continuity_locks (character_id, source_look_id, created_at desc);
create index character_continuity_locks_project_idx on character_continuity_locks (project_id);

-- approved appearance truth, never rewritten: no update in place, by anyone (the table owner included)
create or replace function guard_character_continuity_lock() returns trigger
language plpgsql as $$
begin
  raise exception 'a Character Continuity Lock is immutable';
end;
$$;
create trigger character_continuity_locks_guard before update on character_continuity_locks
  for each row execute function guard_character_continuity_lock();

-- the source Look, when there is one, is a Look of the Lock's own Character and Project at creation
create or replace function check_character_continuity_lock_look() returns trigger
language plpgsql as $$
begin
  if new.source_look_id is not null and not exists (
    select 1 from character_looks l
    where l.id = new.source_look_id and l.project_id = new.project_id and l.character_id = new.character_id
  ) then
    raise exception 'the Lock''s Look is not a Look of this Character in this project';
  end if;
  return new;
end;
$$;
create trigger character_continuity_locks_look_check before insert on character_continuity_locks
  for each row execute function check_character_continuity_lock_look();

-- ───────────────────────── Lock reference images (immutable membership) ─────────────────────────

create table character_continuity_lock_assets (
  lock_id         uuid not null,
  project_id      uuid not null,
  -- frozen order: identity images in slot order, then Look images in the Look's order
  position        integer not null check (position between 0 and 63),
  asset_id        uuid not null,
  role            text not null check (role in ('identity', 'look')),
  identity_slot   text check (identity_slot in ('front', 'three_quarter', 'profile', 'full_body', 'additional')),
  label           text not null default '' check (char_length(label) <= 200),
  -- frozen from the Asset at creation (a trigger below checks them against the Asset)
  asset_checksum  text not null check (asset_checksum ~ '^[0-9a-f]{64}$'),
  width           integer not null check (width > 0),
  height          integer not null check (height > 0),

  primary key (lock_id, position),
  -- an image is frozen once per Lock (identity outranks Look for the same Asset)
  unique (lock_id, asset_id),
  -- identity images carry their slot; Look images carry none
  check ((role = 'identity') = (identity_slot is not null)),
  foreign key (lock_id, project_id) references character_continuity_locks (id, project_id) on delete cascade,
  -- a real project-safe reference: an image a Lock depends on cannot be deleted from under it
  foreign key (asset_id, project_id) references assets (id, project_id)
);
create index character_continuity_lock_assets_asset_idx on character_continuity_lock_assets (asset_id);
create index character_continuity_lock_assets_project_idx on character_continuity_lock_assets (project_id);

create or replace function guard_character_continuity_lock_asset() returns trigger
language plpgsql as $$
begin
  raise exception 'a Character Continuity Lock''s reference images are immutable';
end;
$$;
create trigger character_continuity_lock_assets_guard before update on character_continuity_lock_assets
  for each row execute function guard_character_continuity_lock_asset();

-- the frozen image facts must be the Asset's own: a real stored image of this project with this checksum and size
create or replace function check_character_continuity_lock_asset() returns trigger
language plpgsql as $$
declare
  a assets%rowtype;
begin
  select * into a from assets where id = new.asset_id and project_id = new.project_id;
  if not found then
    raise exception 'the Lock image does not exist in this project';
  end if;
  if a.type <> 'image' then
    raise exception 'a Lock reference must be an image';
  end if;
  if a.object_path is null then
    raise exception 'the Lock image has no stored file';
  end if;
  if a.checksum is distinct from new.asset_checksum
     or a.width is distinct from new.width
     or a.height is distinct from new.height then
    raise exception 'the Lock image facts do not match its image';
  end if;
  return new;
end;
$$;
create trigger character_continuity_lock_assets_asset_check before insert on character_continuity_lock_assets
  for each row execute function check_character_continuity_lock_asset();

-- membership is complete when the creating transaction commits and can never grow afterwards: the member rows of a
-- Lock must number exactly its frozen reference_count (checked at commit, after the Lock and its members are written)
create or replace function check_character_continuity_lock_membership() returns trigger
language plpgsql as $$
declare
  target uuid;
  expected integer;
  actual integer;
begin
  if tg_table_name = 'character_continuity_locks' then
    target := new.id;
  else
    target := new.lock_id;
  end if;
  select reference_count into expected from character_continuity_locks where id = target;
  if not found then
    return null; -- removed in the same transaction (cascade)
  end if;
  select count(*) into actual from character_continuity_lock_assets where lock_id = target;
  if actual <> expected then
    raise exception 'a Character Continuity Lock''s reference images are frozen at creation (% expected, % found)',
      expected, actual;
  end if;
  return null;
end;
$$;
create constraint trigger character_continuity_locks_membership
  after insert on character_continuity_locks deferrable initially deferred
  for each row execute function check_character_continuity_lock_membership();
create constraint trigger character_continuity_lock_assets_membership
  after insert on character_continuity_lock_assets deferrable initially deferred
  for each row execute function check_character_continuity_lock_membership();

-- ───────────────────────── selection (one mutable pointer per Shot Character assignment) ─────────────────────────

create table shot_character_continuity_selections (
  shot_id             uuid not null,
  character_id        uuid not null,
  project_id          uuid not null references projects (id) on delete cascade,
  continuity_lock_id  uuid not null,
  selected_by         uuid,
  selected_at         timestamptz not null default now(),

  primary key (shot_id, character_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  -- the Character must be assigned to the Shot; removing it from the Shot removes the selection
  foreign key (shot_id, character_id) references shot_characters (shot_id, character_id) on delete cascade,
  -- same Project AND the Lock's own Character: a selection can never name another Character's Lock
  foreign key (continuity_lock_id, character_id, project_id)
    references character_continuity_locks (id, character_id, project_id) on delete cascade
);
create index shot_character_continuity_selections_lock_idx
  on shot_character_continuity_selections (continuity_lock_id);
create index shot_character_continuity_selections_project_idx
  on shot_character_continuity_selections (project_id, shot_id);

-- the selected Lock is the exact appearance contract of the assignment: its source Look IS the assignment's Look
create or replace function check_shot_character_continuity_selection() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1
      from shot_characters sc
      join character_continuity_locks l on l.id = new.continuity_lock_id
     where sc.shot_id = new.shot_id
       and sc.character_id = new.character_id
       and l.character_id = new.character_id
       and l.source_look_id is not distinct from sc.look_id
  ) then
    raise exception 'a Character Continuity Lock can only be selected for a Shot assignment of the same Character and Look';
  end if;
  return new;
end;
$$;
create trigger shot_character_continuity_selections_check
  before insert or update on shot_character_continuity_selections
  for each row execute function check_shot_character_continuity_selection();

-- an assignment whose Look changes loses a selection of a Lock made for another Look, in the same statement (only that
-- Character's selection on that Shot; runs only when the Look really changed)
create or replace function clear_shot_character_continuity_selection() returns trigger
language plpgsql as $$
begin
  delete from shot_character_continuity_selections s
   using character_continuity_locks l
   where s.shot_id = new.shot_id
     and s.character_id = new.character_id
     and l.id = s.continuity_lock_id
     and l.source_look_id is distinct from new.look_id;
  return null;
end;
$$;
create trigger shot_characters_continuity_selection_clear
  after update of look_id on shot_characters
  for each row when (old.look_id is distinct from new.look_id)
  execute function clear_shot_character_continuity_selection();

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table character_continuity_locks enable row level security;
alter table character_continuity_lock_assets enable row level security;
alter table shot_character_continuity_selections enable row level security;

-- Locks and their images are readable and appendable by the project owner; deliberately no update or delete policy
create policy character_continuity_locks_select on character_continuity_locks for select to authenticated
  using (is_project_owner(project_id));
create policy character_continuity_locks_insert on character_continuity_locks for insert to authenticated
  with check (is_project_owner(project_id));
create policy character_continuity_lock_assets_select on character_continuity_lock_assets for select to authenticated
  using (is_project_owner(project_id));
create policy character_continuity_lock_assets_insert on character_continuity_lock_assets for insert to authenticated
  with check (is_project_owner(project_id));
create policy shot_character_continuity_selections_owner on shot_character_continuity_selections
  for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:character-continuity asserts they have no
-- privilege.
