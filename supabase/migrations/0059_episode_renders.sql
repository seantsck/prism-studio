-- 0059: Phase 5B-V4 FINAL EPISODE RENDERS (segmented render of one frozen Episode Edit revision → an immutable MP4).
--
--   episode_renders          one durable render job per request, numbered 1, 2, … per Episode. It FREEZES what it
--                            renders at request time: the edit, its working revision and the saved revision it equals,
--                            the V3 render manifest (every source Asset id + checksum), the delivery profile and the
--                            output file name. Lifecycle: queued → rendering_segments → assembling → verifying →
--                            completed; → failed (retry: failed → queued, the SAME render); queued → cancelled.
--                            Completed / cancelled renders are history: nothing changes them. Never deleted by a newer
--                            render; they go only with their Episode / Project.
--   render_segment_cache     the deterministic segment cache: (project, cache key) → private objects + checksums, so a
--                            retried / repeated render reuses verified segments instead of re-rendering them.
--   assets.purpose           + 'episode_render' (the final MP4: a NEW immutable private Asset per completed render).
--
-- Invariants enforced HERE, not only in the application (src/render/*):
--   * the frozen columns never change after insert (trigger), whoever updates;
--   * only the allowed state transitions; a completed render has its output Asset and metadata; terminal = immutable;
--   * the OWNER may only request (insert queued), retry (failed → queued) and cancel (queued → cancelled);
--   * the RENDER WORKER role (`prism_render_worker`, nologin; a login role is provisioned per environment) may claim and
--     advance ACTIVE renders, read the Assets of a project with an active render, insert the output Asset (purpose
--     'episode_render') and use the segment cache. Nothing else: no Story, generation, edit or continuity table.
--
-- Media bytes never live in Postgres (only object paths in the private bucket). LOCAL / disposable only until the owner
-- authorizes hosted DEV. Forward-only; 0001–0058 untouched.

-- ───────────────────────── assets: the final render purpose ─────────────────────────

alter table assets drop constraint assets_purpose_check;
alter table assets add constraint assets_purpose_check check (purpose in (
  'identity_ref', 'look_ref', 'location_ref', 'prop_ref', 'storyboard', 'performance_audio',
  'reference_audio', 'generation_input', 'generation_output', 'video_reference', 'document',
  'waveform', 'model_3d', 'other', 'spatial_control', 'spatial_reconstruction', 'production_frame',
  'episode_render'
));

-- ───────────────────────── episode_renders ─────────────────────────

create table episode_renders (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references projects (id) on delete cascade,
  episode_id             uuid not null,
  -- the edit rendered: a frozen reference (the render is history even if the edit is later removed)
  edit_id                uuid not null,
  number                 integer not null check (number >= 1),
  edit_revision          bigint not null check (edit_revision >= 0),
  saved_revision_id      uuid,
  saved_revision_number  integer check (saved_revision_number is null or saved_revision_number >= 1),
  manifest               jsonb not null check (jsonb_typeof(manifest) = 'object' and jsonb_typeof(manifest -> 'segments') = 'array'),
  manifest_fingerprint   text not null check (manifest_fingerprint ~ '^[0-9a-f]{64}$'),
  state_fingerprint      text not null check (state_fingerprint ~ '^[0-9a-f]{64}$'),
  profile                jsonb not null check (jsonb_typeof(profile) = 'object'),
  profile_id             text not null check (char_length(profile_id) between 1 and 64),
  output_filename        text not null check (output_filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,139}$'),
  status                 text not null default 'queued' check (status in (
                           'queued', 'rendering_segments', 'assembling', 'verifying', 'completed', 'failed', 'cancelled')),
  segments_total         integer not null check (segments_total >= 0),
  segments_done          integer not null default 0 check (segments_done >= 0 and segments_done <= segments_total),
  attempt_count          integer not null default 1 check (attempt_count between 1 and 100),
  lease_owner            text,
  lease_token            uuid,
  lease_expires_at       timestamptz,
  heartbeat_at           timestamptz,
  output_asset_id        uuid,
  output                 jsonb check (output is null or jsonb_typeof(output) = 'object'),
  error_code             text check (error_code is null or char_length(error_code) <= 64),
  error_message          text check (error_message is null or char_length(error_message) <= 1000),
  created_by             uuid,
  created_at             timestamptz not null default now(),
  started_at             timestamptz,
  completed_at           timestamptz,
  failed_at              timestamptz,

  unique (episode_id, number),
  unique (id, project_id),
  foreign key (episode_id, project_id) references episodes (id, project_id) on delete cascade,
  foreign key (output_asset_id, project_id) references assets (id, project_id) deferrable initially deferred,
  constraint episode_renders_completed_has_output check (
    status <> 'completed' or (output_asset_id is not null and output is not null and completed_at is not null)
  )
);
create index episode_renders_project_idx on episode_renders (project_id);
create index episode_renders_active_idx on episode_renders (created_at)
  where status in ('queued', 'rendering_segments', 'assembling', 'verifying');

create or replace function guard_episode_render() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'queued' or new.segments_done <> 0 or new.output_asset_id is not null or new.output is not null
       or new.lease_token is not null or new.attempt_count <> 1 then
      raise exception 'a render is requested as queued, with no progress, lease or output';
    end if;
    return new;
  end if;
  -- frozen inputs: never change
  if (new.project_id, new.episode_id, new.edit_id, new.number, new.edit_revision, new.saved_revision_id,
      new.saved_revision_number, new.manifest, new.manifest_fingerprint, new.state_fingerprint, new.profile,
      new.profile_id, new.output_filename, new.created_by, new.created_at, new.segments_total)
     is distinct from
     (old.project_id, old.episode_id, old.edit_id, old.number, old.edit_revision, old.saved_revision_id,
      old.saved_revision_number, old.manifest, old.manifest_fingerprint, old.state_fingerprint, old.profile,
      old.profile_id, old.output_filename, old.created_by, old.created_at, old.segments_total) then
    raise exception 'a render''s frozen inputs cannot change';
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'a % render is history and cannot change', old.status;
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'queued' and new.status in ('rendering_segments', 'cancelled'))
    or (old.status = 'rendering_segments' and new.status in ('assembling', 'failed'))
    or (old.status = 'assembling' and new.status in ('verifying', 'failed'))
    or (old.status = 'verifying' and new.status in ('completed', 'failed'))
    or (old.status = 'failed' and new.status = 'queued')
    -- a worker that reclaims an expired lease restarts from the (cached) segments
    or (old.status in ('assembling', 'verifying') and new.status = 'rendering_segments')
  ) then
    raise exception 'a render cannot go from % to %', old.status, new.status;
  end if;
  -- the owner only retries a failed render or cancels a queued one; execution columns are the worker's
  if current_user = 'authenticated' then
    if not ((old.status = 'failed' and new.status = 'queued') or (old.status = 'queued' and new.status = 'cancelled')) then
      raise exception 'only the render worker advances a render';
    end if;
    if new.output_asset_id is distinct from old.output_asset_id or new.output is distinct from old.output then
      raise exception 'only the render worker records an output';
    end if;
  elsif old.status = 'failed' and new.status = 'queued' then
    raise exception 'only the owner retries a render';
  end if;
  return new;
end;
$$;
create trigger episode_renders_guard before insert or update on episode_renders
  for each row execute function guard_episode_render();

alter table episode_renders enable row level security;
create policy episode_renders_owner_select on episode_renders for select to authenticated
  using (is_project_owner(project_id));
create policy episode_renders_owner_insert on episode_renders for insert to authenticated
  with check (is_project_owner(project_id));
create policy episode_renders_owner_update on episode_renders for update to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
grant select, insert, update on episode_renders to authenticated;

-- ───────────────────────── render_segment_cache ─────────────────────────

create table render_segment_cache (
  project_id       uuid not null references projects (id) on delete cascade,
  cache_key        text not null check (cache_key ~ '^[0-9a-f]{64}$'),
  video_path       text not null check (split_part(video_path, '/', 1) = project_id::text),
  video_checksum   text not null check (video_checksum ~ '^[0-9a-f]{64}$'),
  audio_path       text check (audio_path is null or split_part(audio_path, '/', 1) = project_id::text),
  audio_checksum   text check (audio_checksum is null or audio_checksum ~ '^[0-9a-f]{64}$'),
  frames           integer not null check (frames > 0),
  samples          integer not null check (samples >= 0),
  created_at       timestamptz not null default now(),
  primary key (project_id, cache_key)
);
alter table render_segment_cache enable row level security;
create policy render_segment_cache_owner_select on render_segment_cache for select to authenticated
  using (is_project_owner(project_id));
grant select on render_segment_cache to authenticated;

-- ───────────────────────── the render worker role ─────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'prism_render_worker') then
    create role prism_render_worker nologin noinherit;
  end if;
end $$;
alter role prism_render_worker set statement_timeout = '60s';
alter role prism_render_worker set idle_in_transaction_session_timeout = '120s';
alter role prism_render_worker set search_path = public, pg_temp;

revoke all on all tables in schema public from prism_render_worker;
revoke all on all sequences in schema public from prism_render_worker;
revoke create on schema public from prism_render_worker;
grant usage on schema public to prism_render_worker;

-- renders: claim / lease / progress / outcome of ACTIVE renders only. No insert, no delete.
grant select on episode_renders to prism_render_worker;
grant update (
  status, segments_done, lease_owner, lease_token, lease_expires_at, heartbeat_at, output_asset_id, output,
  error_code, error_message, started_at, completed_at, failed_at
) on episode_renders to prism_render_worker;
-- the worker reads renders (Postgres also checks an UPDATE's new row against the SELECT policy, so a render the worker
-- just completed / failed must stay readable to it); it can WRITE only active ones, and terminal ones are immutable
create policy episode_renders_worker_select on episode_renders for select to prism_render_worker
  using (true);
create policy episode_renders_worker_update on episode_renders for update to prism_render_worker
  using (status in ('queued', 'rendering_segments', 'assembling', 'verifying'))
  with check (true);

-- the segment cache of a project with an active render
grant select, insert, delete on render_segment_cache to prism_render_worker;
create policy render_segment_cache_worker on render_segment_cache for all to prism_render_worker
  using (exists (
    select 1 from episode_renders r
     where r.project_id = render_segment_cache.project_id
       and r.status in ('queued', 'rendering_segments', 'assembling', 'verifying')))
  with check (exists (
    select 1 from episode_renders r
     where r.project_id = render_segment_cache.project_id
       and r.status in ('queued', 'rendering_segments', 'assembling', 'verifying')));

-- assets: read the media facts of a project with an active render; insert ONLY the final render Asset
grant select (id, project_id, type, purpose, storage_provider, bucket, object_path, mime, checksum, channels, duration_ms)
  on assets to prism_render_worker;
grant insert on assets to prism_render_worker;
create policy assets_render_worker_select on assets for select to prism_render_worker
  using (exists (
    select 1 from episode_renders r
     where r.project_id = assets.project_id
       and r.status in ('queued', 'rendering_segments', 'assembling', 'verifying')));
create policy assets_render_worker_insert on assets for insert to prism_render_worker
  with check (
    purpose = 'episode_render' and type = 'video'
    and exists (
      select 1 from episode_renders r
       where r.project_id = assets.project_id and r.status = 'verifying'));

-- NOTE: no grant on any Story, generation, edit or continuity table; db:renders asserts it.
