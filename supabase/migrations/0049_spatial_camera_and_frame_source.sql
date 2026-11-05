-- 0049: Master Frame camera provenance and Production Frame spatial source provenance (Phase 4C).
--
--   scene_master_frames      + camera_fingerprint, camera_json: the canonical camera the render really used
--                            (prism.render-camera.v1), derived by the server from the Shot's bookmark at capture.
--                            null/null = camera provenance was NOT frozen at capture (every earlier frame): UNKNOWN.
--                            + base_environment_fingerprint: the identity of the engine base environment (skybox +
--                            engine commit, prism.base-environment.v1) the render used, rig or no rig. It is
--                            pixel-affecting and NOT covered by scene_fingerprint; lighting_fingerprint stays the
--                            Shot Lighting Rig. null = not frozen (every earlier frame).
--   shot_production_frames   + source_scene_fingerprint, source_camera_fingerprint, source_blocking_fingerprint,
--                            source_lighting_fingerprint, source_base_environment_fingerprint: the exact spatial
--                            provenance of the source Master Frame, frozen at promotion. source_scene_fingerprint is
--                            the marker: null = not frozen (every earlier frame, and every non-3D frame).
--                            Promotion-time stale / unknown status is workflow state and is deliberately NOT stored.
--
-- Nothing is backfilled: no camera or source truth is invented for an existing row. All new columns are nullable, so
-- code that predates this migration (inserting with explicit column lists and reading with select *) keeps working.
--
-- Immutability: 0048's guard_scene_master_frame_provenance is deny-by-default (to_jsonb(new) minus three named mutable
-- columns), so the new Master Frame columns are immutable without any change here. guard_shot_production_frame
-- already refuses every UPDATE of a Production Frame.
--
-- source_master_frame_id stays WITHOUT a foreign key (0039): a Production Frame is history and outlives its source
-- render; the five fingerprints are its durable lineage. The new BEFORE INSERT trigger proves, at insert time only,
-- that frozen provenance is the source Master Frame's own record. It never derives anything from current state.
--
-- Security: SECURITY INVOKER (the default); no SECURITY DEFINER. No new table, grant or policy. Forward-only;
-- 0001-0048 untouched.

-- ───────────────────────── Master Frame camera provenance ─────────────────────────

alter table scene_master_frames add column camera_fingerprint text;
alter table scene_master_frames add column camera_json jsonb;
-- coalesce: a CHECK passes on NULL, and a missing JSON key reads as NULL
alter table scene_master_frames add constraint scene_master_frames_camera_check check (
  (camera_fingerprint is null and camera_json is null)
  or coalesce(camera_fingerprint ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(camera_json) = 'object'
      and camera_json ->> 'schema' = 'prism.render-camera.v1'
      and camera_json ->> 'cameraFingerprint' = camera_fingerprint
      and jsonb_typeof(camera_json -> 'camera') = 'object'
      and jsonb_typeof(camera_json #> '{camera,position}') = 'object'
      and jsonb_typeof(camera_json #> '{camera,quaternion}') = 'object'
      and jsonb_typeof(camera_json #> '{camera,focalLengthMm}') = 'number', false)
);
alter table scene_master_frames add column base_environment_fingerprint text;
alter table scene_master_frames add constraint scene_master_frames_base_environment_check check (
  base_environment_fingerprint is null or base_environment_fingerprint ~ '^[0-9a-f]{64}$'
);

-- ───────────────────────── Production Frame spatial source provenance ─────────────────────────

alter table shot_production_frames add column source_scene_fingerprint text;
alter table shot_production_frames add column source_camera_fingerprint text;
alter table shot_production_frames add column source_blocking_fingerprint text;
alter table shot_production_frames add column source_lighting_fingerprint text;
alter table shot_production_frames add column source_base_environment_fingerprint text;
alter table shot_production_frames add constraint shot_production_frames_spatial_source_check check (
  (source_scene_fingerprint is null and source_camera_fingerprint is null
     and source_blocking_fingerprint is null and source_lighting_fingerprint is null
     and source_base_environment_fingerprint is null)
  or coalesce(source = 'previs_master'
      and source_master_frame_id is not null
      and source_scene_fingerprint ~ '^[0-9a-f]{64}$'
      and (source_camera_fingerprint is null or source_camera_fingerprint ~ '^[0-9a-f]{64}$')
      and (source_blocking_fingerprint is null or source_blocking_fingerprint ~ '^[0-9a-f]{64}$')
      and (source_lighting_fingerprint is null or source_lighting_fingerprint ~ '^[0-9a-f]{64}$')
      and (source_base_environment_fingerprint is null
           or source_base_environment_fingerprint ~ '^[0-9a-f]{64}$'), false)
);

-- frozen source provenance must be EXACTLY the source Master Frame's own record, which must exist at insert
create or replace function check_shot_production_frame_spatial_source() returns trigger
language plpgsql as $$
declare
  mf scene_master_frames%rowtype;
begin
  if new.source_scene_fingerprint is null then
    -- not frozen: the historical / non-3D path, unchanged (the CHECK above keeps the other four null too)
    return new;
  end if;
  select * into mf from scene_master_frames where id = new.source_master_frame_id;
  if not found then
    raise exception 'the source Master Frame of this Production Frame does not exist';
  end if;
  if mf.project_id is distinct from new.project_id
     or mf.shot_id is distinct from new.shot_id
     or mf.asset_id is distinct from new.asset_id then
    raise exception 'the source Master Frame belongs to another project, shot or image';
  end if;
  if mf.scene_fingerprint is distinct from new.source_scene_fingerprint
     or mf.camera_fingerprint is distinct from new.source_camera_fingerprint
     or mf.blocking_fingerprint is distinct from new.source_blocking_fingerprint
     or mf.lighting_fingerprint is distinct from new.source_lighting_fingerprint
     or mf.base_environment_fingerprint is distinct from new.source_base_environment_fingerprint then
    raise exception 'the Production Frame source provenance does not match its source Master Frame';
  end if;
  return new;
end;
$$;
create trigger shot_production_frames_spatial_source_check before insert on shot_production_frames
  for each row execute function check_shot_production_frame_spatial_source();
