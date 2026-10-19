"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { PrevisError } from "@/data/previs-repository";
import {
  isProviderId,
  isTerminal,
  type JobActualCost,
  type JobCostEstimate,
  type ReconstructionJobRecord,
  type ReconstructionProviderId,
} from "@/domain/reconstruction/job";
import { parseCalibration, type SplatCalibration, type SplatFormat } from "@/domain/previs/splat";
import type { Asset } from "@/domain/schemas";
import { isBillable } from "@/lib/reconstruction/provider";
import {
  buildProviders,
  defaultProviderId,
  providerSummaries,
  readReconstructionConfig,
  type ProviderSummary,
} from "@/lib/reconstruction/registry";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPrevisRepo } from "./previs";
import {
  cancelJob,
  createJob,
  JobServiceError,
  refreshJob,
  retryJob,
  submitJob,
  type JobServiceDeps,
} from "./reconstruction-jobs";
import { getRepo, requireProjectFresh } from "./repo";
import { getUploadStorage, storageForAsset } from "./storage";

/**
 * Phase 2F M2D.2 server actions for reconstruction jobs. The browser sends REQUESTS (sources in order, provider,
 * model, explicit cost confirmation); every status is derived on the server. The browser polls `reconstructionJobs`
 * at a modest interval; that call advances active jobs from their providers (rate-limited per job), so a page
 * navigation or a closed tab never loses a job: the next poll resumes it from its stored operation id.
 */

export type ReconstructionResult<T> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const actorOf = (user: Awaited<ReturnType<typeof requireUser>>) =>
  user.kind === "supabase" ? user.id : null;

async function guarded<T>(body: () => Promise<ReconstructionResult<T>>): Promise<ReconstructionResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof JobServiceError) return { ok: false, error: err.message, code: err.code };
    if (err instanceof PrevisError) return { ok: false, error: err.message, code: err.code };
    if (err instanceof UserFacingError) return { ok: false, error: err.message };
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err;
    const ref = randomUUID().slice(0, 8);
    // never the error object itself: provider errors are already sanitised, but nothing else is trusted to be
    console.error(
      `[reconstruction-jobs ${ref}]`,
      err instanceof Error ? err.message.slice(0, 200) : "unknown error",
    );
    return { ok: false, error: `Something went wrong with the reconstruction job (ref ${ref}).` };
  }
}

let providersCache: ReturnType<typeof buildProviders> | null = null;
const providers = () => (providersCache ??= buildProviders());

async function context(slug: string) {
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const storage = await getUploadStorage();
  const repo = await getRepo();
  const previs = await getPrevisRepo();
  const deps: JobServiceDeps = {
    repo: previs,
    providers: providers(),
    config: readReconstructionConfig(),
    projectAssets: data.assets,
    projectId: data.project.id,
    locationName: (id) => data.locations.find((l) => l.id === id)?.name ?? null,
    readAssetBytes: async (asset) => {
      const s = await storageForAsset(asset);
      return s && asset.objectPath ? s.get(asset.objectPath) : null;
    },
    store: {
      putObject: async (path, bytes, mime) => void (await storage.put(path, bytes, mime)),
      upsertAsset: (a) => repo.upsert(data.project.id, "assets", a),
      removeAsset: (id) => repo.remove(data.project.id, "assets", id),
      removeObject: async (a) => {
        const s = await storageForAsset(a);
        if (s && a.objectPath) await s.remove(a.objectPath);
      },
    },
    storage: { name: storage.name, bucket: storage.bucket },
    userId: actorOf(user),
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
  };
  return { data, deps, previs };
}

// ───────────────────────── views (what the browser may see) ─────────────────────────

export interface JobResultView {
  reconstructionId: string;
  assetId: string;
  name: string;
  format: SplatFormat;
  gaussianCount: number | null;
  byteSize: number | null;
  checksum: string | null;
  calibration: SplatCalibration;
  sources: Array<{ assetId: string; name: string; checksum: string | null }>;
  createdAt: string;
}

export interface JobView {
  id: string;
  attempt: number;
  previousJobId: string | null;
  status: ReconstructionJobRecord["status"];
  progress: number | null;
  provider: ReconstructionProviderId;
  providerLabel: string;
  /** false: this server's registry no longer has the provider (history only; never polled or substituted) */
  providerKnown: boolean;
  model: string | null;
  costEstimate: JobCostEstimate | null;
  actualCost: JobActualCost | null;
  sources: Array<{ ordinal: number; assetId: string; name: string }>;
  description: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  result: JobResultView | null;
}

export interface ReconstructionPanelState {
  enabled: boolean;
  providers: ProviderSummary[];
  /** pre-selected provider: a free, local, ready one, or null (a paid provider is never pre-selected) */
  defaultProvider: ReconstructionProviderId | null;
  paid: { enabled: boolean; maxUsd: number | null };
  pollIntervalMs: number;
  jobs: JobView[];
}

async function views(
  jobs: ReconstructionJobRecord[],
  assets: Asset[],
  previs: Awaited<ReturnType<typeof getPrevisRepo>>,
): Promise<JobView[]> {
  const label = new Map(providerSummaries(providers()).map((p) => [p.provider, p.label]));
  const name = (id: string) => assets.find((a) => a.id === id)?.name ?? "(removed image)";
  const out: JobView[] = [];
  for (const j of jobs) {
    let result: JobResultView | null = null;
    if (j.resultReconstructionId) {
      const r = await previs.getReconstruction(j.resultReconstructionId);
      const a = r ? assets.find((x) => x.id === r.resultAssetId) : undefined;
      if (r && a)
        result = {
          reconstructionId: r.id,
          assetId: a.id,
          name: a.name,
          format: r.resultFormat,
          gaussianCount: r.gaussianCount,
          byteSize: a.byteSize ?? null,
          checksum: a.checksum ?? null,
          calibration: parseCalibration(r.calibration),
          sources: r.sources.map((s) => ({
            assetId: s.assetId,
            name: name(s.assetId),
            checksum: s.checksum,
          })),
          createdAt: r.createdAt,
        };
    }
    out.push({
      id: j.id,
      attempt: j.attempt,
      previousJobId: j.previousJobId,
      status: j.status,
      progress: j.progress,
      provider: j.provider,
      providerLabel: label.get(j.provider) ?? j.provider,
      providerKnown: label.has(j.provider),
      model: j.model,
      costEstimate: j.costEstimate,
      actualCost: j.actualCost,
      sources: j.sources.map((s) => ({ ordinal: s.ordinal, assetId: s.assetId, name: name(s.assetId) })),
      description:
        typeof j.providerOperation?.description === "string"
          ? (j.providerOperation.description as string)
          : null,
      errorCode: j.errorCode,
      errorMessage: j.errorMessage,
      createdAt: j.createdAt,
      completedAt: j.completedAt,
      result,
    });
  }
  return out;
}

// ───────────────────────── actions ─────────────────────────

/**
 * The panel's state for one Location. Active jobs are advanced from their providers first (each at most once per
 * poll interval), so polling this IS how jobs make progress and resume after navigation.
 */
export async function reconstructionJobs(
  form: FormData,
): Promise<ReconstructionResult<{ state: ReconstructionPanelState }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const locationId = str(form, "locationId");
    const { data, deps, previs } = await context(slug);
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");
    let jobs = await previs.listReconstructionJobs(locationId);
    let advanced = false;
    for (const j of jobs.filter((x) => !isTerminal(x.status)).slice(0, 5)) {
      const before = j.revision;
      const after = await refreshJob(deps, j.id);
      advanced ||= after.revision !== before;
    }
    if (advanced) {
      jobs = await previs.listReconstructionJobs(locationId);
      // a newly ingested result is a new Asset in the project
      const fresh = await requireProjectFresh(slug);
      deps.projectAssets = fresh.assets;
      revalidatePath(`/projects/${slug}`, "layout");
    }
    const summaries = providerSummaries(deps.providers);
    return {
      ok: true,
      state: {
        enabled: deps.config.jobsEnabled,
        providers: summaries,
        defaultProvider: defaultProviderId(summaries),
        paid: deps.config.paid,
        pollIntervalMs: deps.config.pollIntervalMs,
        jobs: await views(jobs, deps.projectAssets, previs),
      },
    };
  });
}

/** "Generate Reconstruction": an explicit, cost-acknowledged request. Creates the job, then submits it once. */
export async function generateReconstruction(
  form: FormData,
): Promise<ReconstructionResult<{ job: JobView }>> {
  return guarded(async () => {
    const slug = str(form, "projectSlug");
    const locationId = str(form, "locationId");
    const provider = str(form, "provider");
    if (!isProviderId(provider)) throw new UserFacingError("Choose a reconstruction provider.");
    let sourceAssetIds: string[];
    let providerOptions: Record<string, unknown>;
    try {
      sourceAssetIds = JSON.parse(str(form, "sourceAssetIds") || "[]") as string[];
      providerOptions = JSON.parse(str(form, "providerOptions") || "{}") as Record<string, unknown>;
    } catch {
      throw new UserFacingError("The reconstruction request is not valid.");
    }
    if (!Array.isArray(sourceAssetIds) || sourceAssetIds.some((x) => typeof x !== "string"))
      throw new UserFacingError("The reference image list is not valid.");
    const { data, deps, previs } = await context(slug);
    if (!data.locations.some((l) => l.id === locationId))
      throw new UserFacingError("That location is not in this project.");
    const p = deps.providers.get(provider);
    if (!p) throw new UserFacingError("That reconstruction provider is not available.");
    // a paid (or unknown-cost) provider is only ever called after the user explicitly acknowledged the charges
    if (isBillable(p.capabilities()) && str(form, "acknowledgeCost") !== "1")
      throw new UserFacingError("Confirm that provider charges may apply before generating.");
    const job = await createJob(deps, {
      locationId,
      sourceAssetIds,
      provider,
      model: str(form, "model") || null,
      options: { displayName: str(form, "displayName").slice(0, 64) || null, provider: providerOptions },
    });
    const submitted = await submitJob(deps, job.id);
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true, job: (await views([submitted], deps.projectAssets, previs))[0]! };
  });
}

export async function cancelReconstructionJob(
  form: FormData,
): Promise<ReconstructionResult<{ job: JobView }>> {
  return guarded(async () => {
    const { deps, previs } = await context(str(form, "projectSlug"));
    const job = await cancelJob(deps, str(form, "jobId"));
    return { ok: true, job: (await views([job], deps.projectAssets, previs))[0]! };
  });
}

/** A retry is a NEW attempt (never automatic). A billable retry needs the same explicit cost acknowledgement. */
export async function retryReconstructionJob(
  form: FormData,
): Promise<ReconstructionResult<{ job: JobView }>> {
  return guarded(async () => {
    const { deps, previs } = await context(str(form, "projectSlug"));
    const prior = await previs.getReconstructionJob(str(form, "jobId"));
    if (!prior || prior.projectId !== deps.projectId) throw new UserFacingError("That job no longer exists.");
    const priorProvider = deps.providers.get(prior.provider);
    if ((!priorProvider || isBillable(priorProvider.capabilities())) && str(form, "acknowledgeCost") !== "1")
      throw new UserFacingError("Confirm that provider charges may apply before retrying.");
    const job = await retryJob(deps, prior.id);
    revalidatePath(`/projects/${str(form, "projectSlug")}`, "layout");
    return { ok: true, job: (await views([job], deps.projectAssets, previs))[0]! };
  });
}
