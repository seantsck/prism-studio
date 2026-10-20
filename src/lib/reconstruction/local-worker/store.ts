import type { JobStatus } from "@/domain/reconstruction/job";
import type { Asset } from "@/domain/schemas";
import type { IngestDeps } from "@/server/reconstruction-jobs";
import type { PassStoreDeps } from "@/server/spatial-pass-store";

/**
 * The local worker's persistence boundary (M2D.3B). Two kinds of access, deliberately separate:
 *
 *   DISCOVERY  which `local_capture` jobs exist in a state the worker acts on: ids, project, owner and status only,
 *              never another provider's jobs and never any job content.
 *   OWNER SCOPE everything the worker does for ONE job (read and transition it, read its source Assets, write the
 *              result) runs with the job owner's authority: in Supabase mode as role `authenticated` with the
 *              owner's claims, so Postgres RLS still decides every row, exactly as for the owner's own requests.
 */

export const LOCAL_PROVIDER_ID = "local_capture";

export interface LocalJobRef {
  id: string;
  projectId: string;
  /** the job's creator (the project owner); null jobs are never claimed */
  ownerId: string | null;
  status: JobStatus;
}

export interface OwnerScope {
  repo: IngestDeps["repo"];
  findAsset(assetId: string): Promise<Asset | null>;
  /** the Asset's bytes from Prism's PRIVATE storage, server-side (never a URL) */
  readAssetBytes(asset: Asset): Promise<Uint8Array | null>;
  store: PassStoreDeps;
  storage: IngestDeps["storage"];
  locationName(locationId: string): Promise<string | null>;
  userId: string | null;
}

export interface LocalWorkerStore {
  readonly persistence: "memory" | "supabase";
  /** QUEUED local_capture jobs, oldest first (within the configured project scope, if any) */
  listQueued(limit: number): Promise<LocalJobRef[]>;
  /** local_capture jobs a worker was working on: submitting, running or ingesting */
  listInFlight(): Promise<LocalJobRef[]>;
  scopeFor(ref: LocalJobRef): Promise<OwnerScope>;
}
