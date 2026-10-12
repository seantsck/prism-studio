-- 0008: script -> scene -> shot traceability.
--   action_blocks       stable-ID action paragraphs (dialogue already has stable ids in dialogue_lines)
--   shot_script_sources explicit links from a shot to the script content it covers
--   dialogue_lines gets its source line range in the episode script

create table action_blocks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  episode_id  uuid not null references episodes (id) on delete cascade,
  scene_id    uuid not null references scenes (id) on delete cascade,
  text        text not null,
  "order"     integer not null default 0,
  start_line  integer,
  end_line    integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index action_blocks_scene_idx on action_blocks (scene_id, "order");
create index action_blocks_project_idx on action_blocks (project_id);
create trigger action_blocks_updated before update on action_blocks for each row execute function set_updated_at();

alter table dialogue_lines add column source_start_line integer;
alter table dialogue_lines add column source_end_line   integer;

create table shot_script_sources (
  shot_id           uuid not null references shots (id) on delete cascade,
  action_block_id   uuid references action_blocks (id) on delete cascade,
  dialogue_line_id  uuid references dialogue_lines (id) on delete cascade,
  position          integer not null default 0,
  check ((action_block_id is null) <> (dialogue_line_id is null))
);
create unique index shot_script_sources_action_uq on shot_script_sources (shot_id, action_block_id) where action_block_id is not null;
create unique index shot_script_sources_dialogue_uq on shot_script_sources (shot_id, dialogue_line_id) where dialogue_line_id is not null;
create index shot_script_sources_action_idx on shot_script_sources (action_block_id) where action_block_id is not null;
create index shot_script_sources_dialogue_idx on shot_script_sources (dialogue_line_id) where dialogue_line_id is not null;

-- RLS: same ownership model as 0003.
alter table action_blocks enable row level security;
create policy action_blocks_owner on action_blocks for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table shot_script_sources enable row level security;
create policy shot_script_sources_owner on shot_script_sources for all to authenticated
  using (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)))
  with check (exists (select 1 from shots s where s.id = shot_id and is_project_owner(s.project_id)));
