-- 0040: Phase 2G.3 LOCATION VIEW continuity (GPU-optional persistent viewpoints of a Location).
--
--   location_views                   IMMUTABLE canonical views of a Location: one named viewpoint ("Doorway", "Window
--                                    side", "Reverse") = one private image Asset + a semantic view spec
--                                    (prism.location-view-spec.v1: zone, entrance, viewpoint, orientation, camera words,
--                                    notes; NO coordinates). A revised view is a NEW row; there is deliberately no
--                                    "current version" pointer, so changing a view never rewrites an older Shot.
--   shot_location_view_selections    ONE mutable pointer per Shot: which view of ITS Location the Shot uses. Changing it
--                                    moves only this row; no Shot, Location or view row is touched.
--
-- The view's Asset is REUSED, never copied: a promoted Production Frame / Storyboard / Location reference / 3D Master
-- Frame keeps its own Asset; an upload creates one 'location_ref' Asset (no new asset purpose). The Asset is a real
-- project-safe foreign key, so an image a view depends on cannot be deleted from under it. The source ids are NOT
-- foreign keys (as in 0039): the server verifies them, and a historical view stays interpretable if its source goes.
--
-- Invariants enforced HERE, not only in the browser or the server:
--   * a view belongs to a Location of its own Project (composite FK);
--   * a selection names a view of its own Project (composite FK carrying the view's Location) AND that Location is the
--     Shot's current Location (`shots.location_id`, the Shot's effective Location in Prism) — checked by a trigger;
--   * when a Shot's Location changes, a selection of a view of the OLD Location is removed in the same statement, so
--     an old-Location image can never be used silently;
--   * a view is never updated in place (trigger); deletes only happen through Project / Location cascades.
--
-- Authority: USER-domain tables, owner-only RLS (is_project_owner). Views have SELECT and INSERT policies only.
-- The generation and continuity workers get NO grant (they consume the frozen request/package, never these tables).
-- Forward-only; 0001-0039 untouched. No 3D, GPU or provider involved.

-- ───────────────────────── location views (immutable) ─────────────────────────

create table location_views (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references projects (id) on delete cascade,
  location_id                 uuid not null,
  schema_version              text not null check (schema_version = 'prism.location-view.v1'),
  name                        text not null check (char_length(btrim(name)) between 1 and 120),
  kind                        text not null
    check (kind in ('establishing', 'entrance', 'reverse', 'side', 'zone', 'detail', 'custom')),
  asset_id                    uuid not null,
  -- frozen from the Asset at creation (a trigger below checks them against the Asset)
  asset_checksum              text not null check (asset_checksum ~ '^[0-9a-f]{64}$'),
  width                       integer not null check (width > 0),
  height                      integer not null check (height > 0),
  source                      text not null
    check (source in ('upload', 'location_reference', 'production_frame', 'storyboard', 'previs_master')),
  source_production_frame_id  uuid,
  source_storyboard_frame_id  uuid,
  source_master_frame_id      uuid,
  -- prism.location-view-spec.v1, copied by value; its name and kind are the row's
  view_spec                   jsonb not null check (
    jsonb_typeof(view_spec) = 'object'
    and view_spec ->> 'schema' = 'prism.location-view-spec.v1'
  ),
  -- deterministic identity (Location, image checksum, view spec; no timestamps): the duplicate key
  view_fingerprint            text not null check (view_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by                  uuid,
  created_at                  timestamptz not null default now(),

  unique (id, project_id),
  -- the composite key a selection references: a selection carries its view's Location and Project
  unique (id, location_id, project_id),
  unique (location_id, view_fingerprint),
  check (view_spec ->> 'name' = name and view_spec ->> 'kind' = kind),
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (asset_id, project_id) references assets (id, project_id),
  -- each origin carries exactly its own source id
  check (
    (source in ('upload', 'location_reference')
       and source_production_frame_id is null and source_storyboard_frame_id is null and source_master_frame_id is null)
    or (source = 'production_frame'
       and source_production_frame_id is not null and source_storyboard_frame_id is null and source_master_frame_id is null)
    or (source = 'storyboard'
       and source_production_frame_id is null and source_storyboard_frame_id is not null and source_master_frame_id is null)
    or (source = 'previs_master'
       and source_production_frame_id is null and source_storyboard_frame_id is null and source_master_frame_id is not null)
  )
);
create index location_views_location_idx on location_views (location_id, created_at desc);
create index location_views_project_idx on location_views (project_id);
create index location_views_asset_idx on location_views (asset_id);

-- canonical artifacts, never rewritten: no update in place, by anyone (the table owner included)
create or replace function guard_location_view() returns trigger
language plpgsql as $$
begin
  raise exception 'a Location View is immutable';
end;
$$;
create trigger location_views_guard before update on location_views
  for each row execute function guard_location_view();

-- the frozen image facts must be the Asset's own: a real stored image of this project with this checksum and size
-- (any aspect ratio: a Location View is a reference image, never cropped to a production frame)
create or replace function check_location_view_asset() returns trigger
language plpgsql as $$
declare
  a assets%rowtype;
begin
  select * into a from assets where id = new.asset_id and project_id = new.project_id;
  if not found then
    raise exception 'the Location View image does not exist in this project';
  end if;
  if a.type <> 'image' then
    raise exception 'a Location View must be an image';
  end if;
  if a.object_path is null then
    raise exception 'the Location View image has no stored file';
  end if;
  if a.checksum is distinct from new.asset_checksum
     or a.width is distinct from new.width
     or a.height is distinct from new.height then
    raise exception 'the Location View facts do not match its image';
  end if;
  return new;
end;
$$;
create trigger location_views_asset_check before insert on location_views
  for each row execute function check_location_view_asset();

-- ───────────────────────── selection (one mutable pointer per Shot) ─────────────────────────

create table shot_location_view_selections (
  shot_id           uuid primary key,
  project_id        uuid not null references projects (id) on delete cascade,
  location_view_id  uuid not null,
  -- the chosen view's Location; the trigger below requires it to be the Shot's current Location
  location_id       uuid not null,
  selected_by       uuid,
  selected_at       timestamptz not null default now(),

  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  -- same Project AND the view's own Location: a selection can never name a view under a different Location id
  foreign key (location_view_id, location_id, project_id)
    references location_views (id, location_id, project_id) on delete cascade
);
create index shot_location_view_selections_view_idx on shot_location_view_selections (location_view_id);
create index shot_location_view_selections_project_idx on shot_location_view_selections (project_id);

-- a Shot may only select a view of the Location it is set in (cross-Location refused here, not only in the UI)
create or replace function check_shot_location_view_selection() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from shots s
    where s.id = new.shot_id and s.project_id = new.project_id and s.location_id = new.location_id
  ) then
    raise exception 'a Location View can only be selected for a Shot set in that Location';
  end if;
  return new;
end;
$$;
create trigger shot_location_view_selections_location_check
  before insert or update on shot_location_view_selections
  for each row execute function check_shot_location_view_selection();

-- a Shot that moves to another Location (or to none) loses a selection of a view of its previous Location, in the
-- same statement: the old Location's image can never be used silently. Runs only when the Location really changed.
create or replace function clear_shot_location_view_selection() returns trigger
language plpgsql as $$
begin
  delete from shot_location_view_selections
  where shot_id = new.id and location_id is distinct from new.location_id;
  return null;
end;
$$;
create trigger shots_location_view_selection_clear
  after update of location_id on shots
  for each row when (old.location_id is distinct from new.location_id)
  execute function clear_shot_location_view_selection();

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table location_views enable row level security;
alter table shot_location_view_selections enable row level security;

-- canonical views are readable and appendable by the project owner; deliberately no update or delete policy
create policy location_views_select on location_views for select to authenticated
  using (is_project_owner(project_id));
create policy location_views_insert on location_views for insert to authenticated
  with check (is_project_owner(project_id));
create policy shot_location_view_selections_owner on shot_location_view_selections for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:location-views asserts they have no privilege.
