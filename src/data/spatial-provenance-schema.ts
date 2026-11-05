import type { Pool, PoolClient } from "pg";

/**
 * Migration-feature probe for 0049 (Phase 4C spatial provenance): `scene_master_frames.camera_fingerprint/camera_json/
 * base_environment_fingerprint` and the five `shot_production_frames.source_*_fingerprint` columns. The 4C code must
 * run against a database at 0048 (hosted, until 0049 is applied) as well as at 0049, and it must never name a 0049
 * column against 0048: in a transaction a failed statement aborts everything after it.
 *
 * One catalog query per pool until the columns exist, then never again for that pool (a migration is forward-only, so
 * a positive answer cannot become false while the process runs). A negative answer is NOT cached: once 0049 is applied
 * the next request starts persisting full provenance without a restart. pg_attribute is used instead of
 * information_schema so the answer does not depend on the caller's column privileges.
 */
const ready = new WeakSet<Pool>();

export const SPATIAL_PROVENANCE_PROBE = `select
  exists (select 1 from pg_attribute
           where attrelid = to_regclass('public.scene_master_frames')
             and attname = 'camera_fingerprint' and not attisdropped)
  and exists (select 1 from pg_attribute
           where attrelid = to_regclass('public.scene_master_frames')
             and attname = 'base_environment_fingerprint' and not attisdropped)
  and exists (select 1 from pg_attribute
           where attrelid = to_regclass('public.shot_production_frames')
             and attname = 'source_scene_fingerprint' and not attisdropped)
  and exists (select 1 from pg_attribute
           where attrelid = to_regclass('public.shot_production_frames')
             and attname = 'source_base_environment_fingerprint' and not attisdropped) as ok`;

export async function spatialProvenanceReady(pool: Pool, c: PoolClient): Promise<boolean> {
  if (ready.has(pool)) return true;
  const ok = Boolean((await c.query(SPATIAL_PROVENANCE_PROBE)).rows[0]?.ok);
  if (ok) ready.add(pool);
  return ok;
}
