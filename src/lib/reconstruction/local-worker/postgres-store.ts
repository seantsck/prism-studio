import type { Pool } from "pg";
import { PostgresPrevisData } from "@/data/previs-postgres";
import { rlsPreamble, UserRepository } from "@/data/postgres-repository";
import type { JobStatus } from "@/domain/reconstruction/job";
import type { Asset } from "@/domain/schemas";
import type { OutputSink } from "@/generation/sink";
import { LOCAL_PROVIDER_ID, type LocalJobRef, type LocalWorkerStore, type OwnerScope } from "./store";

/**
 * Supabase persistence for the SAME-HOST local worker (M2D.3B).
 *
 * Authority (same-host v1, documented in docs/local-reconstruction.md): the worker is an OPERATOR process beside the
 * Prism server and uses the server's own guarded database connection (SUPABASE_DB_URL, refused unless it targets
 * the Prism Studio project) and the worker Storage credential the existing worker sink already requires. It is never
 * shipped to another machine: a remote agent (M2D.3C) must use a paired, scoped protocol instead.
 *
 *   discovery     ONE narrow query on the privileged connection: id, project, owner and status of `local_capture`
 *                 jobs in the states the worker acts on. Nothing else runs with that privilege.
 *   owner scope   every read and write for a job runs as role `authenticated` with the job owner's claims (the same
 *                 preamble a signed-in request uses), so RLS still enforces project ownership on jobs, events,
 *                 Assets and reconstructions.
 *   storage       the private bucket through the worker sink; only an Asset row read under the owner's RLS, of this
 *                 project, under this project's path prefix, is ever read.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPostgresWorkerStore(opts: {
  pool: Pool;
  sink: OutputSink;
  /** when set, only this project's jobs are ever discovered or claimed */
  projectScope: string | null;
}): LocalWorkerStore {
  const { pool, sink } = opts;
  if (opts.projectScope !== null && !UUID.test(opts.projectScope))
    throw new Error("The local worker project scope must be a project id (uuid).");
  const discover = async (statuses: JobStatus[], limit: number): Promise<LocalJobRef[]> => {
    const r = await pool.query(
      `select id, project_id, created_by, status from reconstruction_jobs
        where provider = $1 and status = any($2::text[]) and ($3::uuid is null or project_id = $3::uuid)
        order by created_at, id limit $4`,
      [LOCAL_PROVIDER_ID, statuses, opts.projectScope, limit],
    );
    return r.rows.map((x) => ({
      id: String(x.id),
      projectId: String(x.project_id),
      ownerId: x.created_by ? String(x.created_by) : null,
      status: x.status as JobStatus,
    }));
  };
  return {
    persistence: "supabase",
    listQueued: (limit) => discover(["queued"], limit),
    listInFlight: () => discover(["submitting", "running", "ingesting"], 100),
    async scopeFor(ref): Promise<OwnerScope> {
      if (!ref.ownerId || !UUID.test(ref.ownerId))
        throw new Error("A local job without an owner cannot be run.");
      const claims = { sub: ref.ownerId };
      const preamble = rlsPreamble(claims);
      const previs = new PostgresPrevisData(pool, preamble);
      const users = new UserRepository(pool, claims);
      const readable = (a: Asset) =>
        a.projectId === ref.projectId &&
        a.storageProvider === sink.name &&
        !!a.objectPath &&
        a.objectPath.startsWith(`${ref.projectId}/`);
      return {
        repo: previs,
        findAsset: (id) => users.findAsset(id),
        readAssetBytes: async (a) => (readable(a) ? sink.get(a.objectPath!) : null),
        store: {
          putObject: (p, bytes, mime) => sink.put(p, bytes, mime),
          upsertAsset: (a) => users.upsert(ref.projectId, "assets", a),
          removeAsset: (id) => users.remove(ref.projectId, "assets", id),
          removeObject: async (a) => {
            if (a.objectPath) await sink.remove(a.objectPath);
          },
        },
        storage: { name: sink.name, bucket: sink.bucket },
        locationName: async (locationId) => {
          const c = await pool.connect();
          try {
            await c.query(preamble);
            const r = await c.query("select name from locations where id = $1 and project_id = $2", [
              locationId,
              ref.projectId,
            ]);
            return r.rows[0] ? String(r.rows[0].name) : null;
          } finally {
            await c.query("rollback").catch(() => undefined);
            c.release();
          }
        },
        userId: ref.ownerId,
      };
    },
  };
}
