-- 0050: named reusable setup templates and setup copy provenance (Phase 4D-I2).
--
--   shot_setup_templates  a NAMED, Project- and Location-scoped SNAPSHOT of reusable setup values: camera, lighting and/or
--                         blocking (prism.setup-template.v1). It holds the values themselves, never a pointer that is
--                         resolved later: a template saved "from Shot A" is A's values at that moment, and A and the
--                         template change independently afterwards. source_shot_id / source_shot_code are display-only.
--   shot_setup_copies     an APPEND-ONLY provenance record of every explicit copy into a Shot ("copied from template T
--                         revision N" or "copied from Shot 1A"): which parts, when, the reviewed plan token. It is history,
--                         not state: nothing reads it to render, capture, promote or package, and the copied values live
--                         only in the Shot's own rows (shot_camera_bookmarks, shot_light_rigs, shot_character_blocking).
--
-- Copies are never links: deleting a template or a source Shot only nulls the provenance pointer (ON DELETE SET NULL on
-- that column alone) and keeps the name / code snapshot, so a Shot's copied setup and its history both survive.
--
-- Security: owner-only RLS (is_project_owner), no SECURITY DEFINER. authenticated holds select/insert/update/delete on
-- templates and only select/insert on copies; service_role (Supabase default privileges) loses update/delete on copies
-- too, so provenance is append-only by privilege for every API role (rows leave only with their Shot or Project).
-- anon and both worker roles hold nothing on either table. Additive and forward-only: no existing table, column, grant or
-- policy changes, nothing is backfilled, 0001-0049 untouched. 3D stays optional: nothing here is required of a Shot.

-- ───────────────────────── shot_setup_templates ─────────────────────────

create table shot_setup_templates (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects (id) on delete cascade,
  -- world coordinates mean something only on ONE set: a template belongs to one Location's 3D set
  location_id         uuid not null,
  scene_document_id   uuid not null,
  schema_version      text not null check (schema_version = 'prism.setup-template.v1'),
  name                text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  description         text not null default '' check (char_length(description) <= 2000),
  revision            integer not null default 1 check (revision >= 1),
  -- the reusable VALUES (null = this part is not in the template); each part carries the set anchor it was saved at
  camera_json         jsonb,
  lighting_json       jsonb,
  blocking_json       jsonb,
  -- semantic identity of the values only: never the name, description, provenance or row identity
  content_fingerprint text not null check (char_length(content_fingerprint) = 64),
  -- display-only provenance of the last snapshot
  source_shot_id      uuid,
  source_shot_code    text check (source_shot_code is null or char_length(source_shot_code) <= 64),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (id, project_id),
  unique (project_id, location_id, name),
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id, location_id)
    references location_scene_documents (id, project_id, location_id) on delete cascade,
  foreign key (source_shot_id, project_id) references shots (id, project_id) on delete set null (source_shot_id),
  constraint shot_setup_templates_has_content
    check (camera_json is not null or lighting_json is not null or blocking_json is not null),
  constraint shot_setup_templates_camera_shape check (coalesce(camera_json is null or (
    jsonb_typeof(camera_json) = 'object'
    and jsonb_typeof(camera_json -> 'value') = 'object'
    and jsonb_typeof(camera_json -> 'sceneRevision') = 'number'), false)),
  constraint shot_setup_templates_lighting_shape check (coalesce(lighting_json is null or (
    jsonb_typeof(lighting_json) = 'object'
    and lighting_json #>> '{rig,schema}' = 'prism.shot-lighting.v1'
    and lighting_json #>> '{rig,base,mode}' in ('engine_default', 'replace')
    and case when jsonb_typeof(lighting_json #> '{rig,lights}') = 'array'
             then jsonb_array_length(lighting_json #> '{rig,lights}') <= 16 else false end
    and not (lighting_json -> 'rig' ? 'authoredIntent')), false)),
  constraint shot_setup_templates_blocking_shape check (coalesce(blocking_json is null or (
    case when jsonb_typeof(blocking_json) = 'array'
         then jsonb_array_length(blocking_json) between 1 and 32 else false end), false)),
  constraint shot_setup_templates_source_code check (source_shot_id is null or source_shot_code is not null)
);
create index shot_setup_templates_location_idx on shot_setup_templates (location_id);
create index shot_setup_templates_scene_idx on shot_setup_templates (scene_document_id);
create index shot_setup_templates_source_shot_idx on shot_setup_templates (source_shot_id);

create or replace function guard_shot_setup_template() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.location_id is distinct from old.location_id
     or new.scene_document_id is distinct from old.scene_document_id then
    raise exception 'a setup template cannot move between projects, locations or sets';
  end if;
  -- an application edit advances the revision by exactly one; the FK's own SET NULL of source_shot_id changes nothing else
  if new.revision <> old.revision + 1
     and not (new.revision = old.revision and old.source_shot_id is not null and new.source_shot_id is null
              and (to_jsonb(new) - 'source_shot_id' - 'updated_at') = (to_jsonb(old) - 'source_shot_id' - 'updated_at')) then
    raise exception 'a setup template revision must increase by exactly one';
  end if;
  return new;
end;
$$;
create trigger shot_setup_templates_guard before update on shot_setup_templates
  for each row execute function guard_shot_setup_template();
create trigger shot_setup_templates_set_updated_at before update on shot_setup_templates
  for each row execute function set_updated_at();

alter table shot_setup_templates enable row level security;
create policy shot_setup_templates_owner on shot_setup_templates for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

revoke all on shot_setup_templates from public, anon, authenticated;
grant select, insert, update, delete on shot_setup_templates to authenticated;

-- ───────────────────────── shot_setup_copies (append-only provenance) ─────────────────────────

create table shot_setup_copies (
  id                           uuid primary key default gen_random_uuid(),
  project_id                   uuid not null references projects (id) on delete cascade,
  shot_id                      uuid not null,
  -- historical identifiers of the set copied on (no FK: history, never a dependency)
  location_id                  uuid not null,
  scene_document_id            uuid not null,
  source_kind                  text not null check (source_kind in ('shot', 'template')),
  source_shot_id               uuid,
  source_shot_code             text check (source_shot_code is null or char_length(source_shot_code) <= 64),
  template_id                  uuid,
  template_name                text check (template_name is null or char_length(template_name) between 1 and 120),
  template_revision            integer check (template_revision is null or template_revision >= 1),
  template_content_fingerprint text check (template_content_fingerprint is null or char_length(template_content_fingerprint) = 64),
  components                   text[] not null check (
    cardinality(components) between 1 and 3 and components <@ array['camera', 'lighting', 'blocking']::text[]),
  plan_token                   text not null check (char_length(plan_token) = 64),
  copied_at                    timestamptz not null default now(),
  created_by                   uuid,

  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (source_shot_id, project_id) references shots (id, project_id) on delete set null (source_shot_id),
  foreign key (template_id, project_id) references shot_setup_templates (id, project_id) on delete set null (template_id),
  constraint shot_setup_copies_source check (
    (source_kind = 'shot' and source_shot_code is not null and template_name is null and template_revision is null
       and template_content_fingerprint is null and template_id is null)
    or (source_kind = 'template' and template_name is not null and template_revision is not null
       and template_content_fingerprint is not null and source_shot_id is null and source_shot_code is null))
);
create index shot_setup_copies_shot_idx on shot_setup_copies (project_id, shot_id, copied_at desc);
create index shot_setup_copies_template_idx on shot_setup_copies (template_id);
create index shot_setup_copies_source_shot_idx on shot_setup_copies (source_shot_id);

alter table shot_setup_copies enable row level security;
create policy shot_setup_copies_owner_read on shot_setup_copies for select to authenticated
  using (is_project_owner(project_id));
create policy shot_setup_copies_owner_insert on shot_setup_copies for insert to authenticated
  with check (is_project_owner(project_id));

-- revoked from authenticated too: default privileges would otherwise hand it update/delete on a new table
revoke all on shot_setup_copies from public, anon, authenticated;
grant select, insert on shot_setup_copies to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'prism_generation_worker') then
    revoke all on shot_setup_templates from prism_generation_worker;
    revoke all on shot_setup_copies from prism_generation_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'prism_continuity_worker') then
    revoke all on shot_setup_templates from prism_continuity_worker;
    revoke all on shot_setup_copies from prism_continuity_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete, truncate on shot_setup_copies from service_role;
  end if;
end;
$$;
