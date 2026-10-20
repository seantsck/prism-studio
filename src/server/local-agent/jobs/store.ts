import type { Pool } from "pg";
import type { MemoryRepository } from "@/data/memory-repository";
import { PostgresPrevisData } from "@/data/previs-postgres";
import { rlsPreamble, UserRepository } from "@/data/postgres-repository";
import type { JobStatus } from "@/domain/reconstruction/job";
import type { Asset } from "@/domain/schemas";
import type { OutputSink } from "@/generation/sink";
import { REMOTE_AGENT_PROVIDER_ID } from "@/lib/reconstruction/remote-agent-capture";
import type { IngestDeps } from "../../reconstruction-jobs";
import type { PassStoreDeps } from "../../spatial-pass-store";

/**
 * Persistence for REMOTE Local Agent jobs (Phase 2F M2D.3C2), on the Prism SERVER. The workstation never touches any
 * of this: it only sends signed requests; the server decides with its own authority, split exactly like the same-host
 * worker's (M2D.3B):
 *
 *   DISCOVERY    which `local_agent_capture` jobs of ONE project are in a given state: id, project, owner, status and
 *                creation time only (one fixed, parameterised query on the server's own connection). Never another
 *                provider's jobs, never another project's, never job content.
 *   OWNER SCOPE  everything done for one job (read and transition it, read its frozen source Assets, write the result)
 *                runs with the PROJECT OWNER's authority: in Supabase mode as role `authenticated` with the owner's
 *                claims (rlsPreamble), so Postgres RLS still decides every row.
 *   STORAGE      private bytes through the server's dedicated agent-relay sink (PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY,
 *                server-only); only Assets of this project, under this project's path prefix, are ever read.
 */

export interface RemoteJobRef {
  id: string;
  projectId: string;
  ownerId: string | null;
  status: JobStatus;
  createdAt: string;
}

export interface RemoteJobScope {
  repo: IngestDeps["repo"];
  findAsset(assetId: string): Promise<Asset | null>;
  /** the Asset's bytes from Prism's PRIVATE storage, server-side (never a URL) */
  readAssetBytes(asset: Asset): Promise<Uint8Array | null>;
  store: PassStoreDeps;
  storage: IngestDeps["storage"];
  locationName(locationId: string): Promise<string | null>;
  userId: string | null;
}

export interface RemoteJobStore {
  readonly persistence: "memory" | "supabase";
  /** QUEUED remote jobs of this project, oldest first */
  listQueued(projectId: string, limit: number): Promise<RemoteJobRef[]>;
  /** remote jobs of this project being worked on: submitting, running or ingesting */
  listInFlight(projectId: string): Promise<RemoteJobRef[]>;
  /** the narrow facts of one remote job (for the result-upload gate, BEFORE the body is read); null if none */
  peek(jobId: string): Promise<{
    projectId: string;
    status: JobStatus;
    providerOperationId: string | null;
    providerOperation: Record<string, unknown> | null;
  } | null>;
  /** the job owner's scope for one project (RLS-bound in Supabase mode) */
  scope(projectId: string, ownerId: string): Promise<RemoteJobScope>;
}

const IN_FLIGHT: JobStatus[] = ["submitting", "running", "ingesting"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Memory mode (demo, tests, memory E2E): the server's own in-memory repository and the local-disk sink. */
export function memoryRemoteJobStore(repo: MemoryRepository, sink: OutputSink): RemoteJobStore {
  const discover = (projectId: string, statuses: JobStatus[]) =>
    repo.previs.discoverReconstructionJobs({ provider: REMOTE_AGENT_PROVIDER_ID, projectId, statuses });
  return {
    persistence: "memory",
    listQueued: async (projectId, limit) => discover(projectId, ["queued"]).slice(0, limit),
    listInFlight: async (projectId) => discover(projectId, IN_FLIGHT),
    peek: async (jobId) => {
      const j = await repo.previs.getReconstructionJob(jobId);
      return j && j.provider === REMOTE_AGENT_PROVIDER_ID
        ? {
            projectId: j.projectId,
            status: j.status,
            providerOperationId: j.providerOperationId,
            providerOperation: j.providerOperation,
          }
        : null;
    },
    scope: async (projectId, ownerId) => {
      const readable = (a: Asset) =>
        a.projectId === projectId &&
        a.storageProvider === sink.name &&
        !!a.objectPath &&
        a.objectPath.startsWith(`${projectId}/`);
      return {
        repo: repo.previs,
        findAsset: (id) => repo.findAsset(id),
        readAssetBytes: async (a) => (readable(a) ? sink.get(a.objectPath!) : null),
        store: {
          putObject: (p, bytes, mime) => sink.put(p, bytes, mime),
          upsertAsset: (a) => repo.upsert(projectId, "assets", a),
          removeAsset: (id) => repo.remove(projectId, "assets", id),
          removeObject: async (a) => {
            if (a.objectPath) await sink.remove(a.objectPath);
          },
        },
        storage: { name: sink.name, bucket: sink.bucket },
        locationName: async (locationId) => repo.locationName(projectId, locationId),
        userId: ownerId,
      };
    },
  };
}

/** Supabase mode: discovery on the server's guarded connection; everything else under the owner's RLS context. */
export function postgresRemoteJobStore(pool: Pool, sink: OutputSink): RemoteJobStore {
  const discover = async (
    projectId: string,
    statuses: JobStatus[],
    limit: number,
  ): Promise<RemoteJobRef[]> => {
    if (!UUID.test(projectId)) return [];
    const r = await pool.query(
      `select id, project_id, created_by, status, created_at from reconstruction_jobs
        where provider = $1 and project_id = $2::uuid and status = any($3::text[])
        order by created_at, id limit $4`,
      [REMOTE_AGENT_PROVIDER_ID, projectId, statuses, limit],
    );
    return r.rows.map((x) => ({
      id: String(x.id),
      projectId: String(x.project_id),
      ownerId: x.created_by ? String(x.created_by) : null,
      status: x.status as JobStatus,
      createdAt: x.created_at instanceof Date ? x.created_at.toISOString() : String(x.created_at),
    }));
  };
  return {
    persistence: "supabase",
    listQueued: (projectId, limit) => discover(projectId, ["queued"], limit),
    listInFlight: (projectId) => discover(projectId, IN_FLIGHT, 100),
    peek: async (jobId) => {
      if (!UUID.test(jobId)) return null;
      const r = await pool.query(
        `select project_id, status, provider_operation_id, provider_operation_json from reconstruction_jobs
          where id = $1::uuid and provider = $2`,
        [jobId, REMOTE_AGENT_PROVIDER_ID],
      );
      const x = r.rows[0];
      return x
        ? {
            projectId: String(x.project_id),
            status: x.status as JobStatus,
            providerOperationId: x.provider_operation_id ? String(x.provider_operation_id) : null,
            providerOperation: (x.provider_operation_json as Record<string, unknown> | null) ?? null,
          }
        : null;
    },
    async scope(projectId, ownerId) {
      if (!UUID.test(ownerId) || !UUID.test(projectId))
        throw new Error("A remote job needs a project owner (uuid) and a project id (uuid).");
      const claims = { sub: ownerId };
      const preamble = rlsPreamble(claims);
      const previs = new PostgresPrevisData(pool, preamble);
      const users = new UserRepository(pool, claims);
      const readable = (a: Asset) =>
        a.projectId === projectId &&
        a.storageProvider === sink.name &&
        !!a.objectPath &&
        a.objectPath.startsWith(`${projectId}/`);
      return {
        repo: previs,
        findAsset: (id) => users.findAsset(id),
        readAssetBytes: async (a) => (readable(a) ? sink.get(a.objectPath!) : null),
        store: {
          putObject: (p, bytes, mime) => sink.put(p, bytes, mime),
          upsertAsset: (a) => users.upsert(projectId, "assets", a),
          removeAsset: (id) => users.remove(projectId, "assets", id),
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
              projectId,
            ]);
            return r.rows[0] ? String(r.rows[0].name) : null;
          } finally {
            await c.query("rollback").catch(() => undefined);
            c.release();
          }
        },
        userId: ownerId,
      };
    },
  };
}
