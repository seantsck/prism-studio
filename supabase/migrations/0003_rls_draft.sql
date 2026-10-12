-- Prism Studio — migration 0003: row level security (DRAFT, ownership model only)
-- REVIEW ONLY. Not applied to any database.
--
-- Model: a project belongs to exactly one user (projects.user_id). Every child table carries
-- project_id, so access = "the caller owns the project". There is intentionally NO sharing,
-- team, role or billing logic yet; add explicit policies when collaboration is designed.
--
-- NOTE: service-role keys bypass RLS. Server code using the service role must enforce ownership itself.

create or replace function is_project_owner(p_project_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from projects where id = p_project_id and user_id = auth.uid()
  );
$$;

alter table projects enable row level security;
create policy projects_owner on projects
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

do $$
declare
  t text;
begin
  foreach t in array array[
    'project_bibles', 'assets', 'characters', 'character_identity_refs', 'character_looks', 'voice_profiles',
    'locations', 'props', 'episodes', 'scenes',
    'dialogue_lines', 'performance_directions', 'performance_takes', 'shots',
    'storyboard_frames', 'generation_attempts', 'continuity_checks'
  ] loop
    if to_regclass(t) is null then
      continue;
    end if;
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all to authenticated using (is_project_owner(project_id)) with check (is_project_owner(project_id))',
      t || '_owner', t
    );
  end loop;
end $$;

-- project_bibles is keyed by project_id (its primary key) so the generic policy applies as-is.

-- Join tables have no project_id; authorise through their parent row.
alter table scene_characters enable row level security;
create policy scene_characters_owner on scene_characters for all to authenticated
  using (exists (select 1 from scenes s where s.id = scene_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from scenes s where s.id = scene_id and is_project_owner(s.project_id)));

alter table scene_props enable row level security;
create policy scene_props_owner on scene_props for all to authenticated
  using (exists (select 1 from scenes s where s.id = scene_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from scenes s where s.id = scene_id and is_project_owner(s.project_id)));

alter table shot_characters enable row level security;
create policy shot_characters_owner on shot_characters for all to authenticated
  using (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)));

alter table shot_props enable row level security;
create policy shot_props_owner on shot_props for all to authenticated
  using (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)));

alter table shot_dialogue_lines enable row level security;
create policy shot_dialogue_lines_owner on shot_dialogue_lines for all to authenticated
  using (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)));

alter table shot_reference_assets enable row level security;
create policy shot_reference_assets_owner on shot_reference_assets for all to authenticated
  using (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)));

-- Storage: bucket "prism-assets", object path = "<project_id>/<asset_id>/<filename>".
-- Policies are created with the bucket (see docs/architecture.md); path-prefix ownership check:
--   (storage.foldername(name))[1]::uuid  ->  is_project_owner(...)
