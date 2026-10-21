"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ProductionFrameError } from "@/data/production-frame-repository";
import { buildShotContext, type ShotContext } from "@/domain/context";
import { draftProductionFrame, type ProductionFrameSource } from "@/domain/production-frame";
import type { Asset, ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { discardUpload, hasFile, ingestUpload } from "./ingest-upload";
import { getPrevisRepo } from "./previs";
import { getProductionFrameRepo } from "./production-frames";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 2G.1 Production Frame actions. A Production Frame is the Shot's canonical approved still. These actions create
 * its IMMUTABLE history records (never editing one) and move the Shot's single selection pointer. None of them needs
 * a 3D set, a GPU or a provider, and none calls an image model: 2G.1 has no generation source.
 *
 *   promoteStoryboardFrame   the approved Storyboard Frame's EXISTING Asset becomes a new Production Frame (no copy)
 *   promoteMasterFrame       an optional 3D Master Frame's EXISTING Asset becomes one (only when one exists)
 *   uploadProductionFrame    a new private `production_frame` Asset + its frame, stored together
 *   selectProductionFrame    makes another existing frame canonical (history untouched; compare-and-set)
 *
 * The caller never names an Asset, path, bucket or Storage location: Assets come from the project's own records, and
 * every image is judged against THE SHOT's production aspect ratio (refused, never cropped).
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

async function loadShotContext(
  form: FormData,
): Promise<{ data: ProjectData; ctx: ShotContext; slug: string }> {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const shotId = str(form, "shotId");
  if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("Shot not found.");
  return { data, ctx: buildShotContext(data, shotId), slug: data.project.slug };
}

/** A repository refusal is a user-correctable message; anything else is a real error. */
function asUserError(err: unknown): never {
  if (err instanceof ProductionFrameError) throw new UserFacingError(err.message);
  throw err;
}

/**
 * Drafts, creates and selects a Production Frame for an EXISTING Asset (a promotion). The Asset must be one of this
 * project's own images with a stored file, a checksum and readable dimensions at the Shot's production aspect.
 */
async function promote(
  ctx: ShotContext,
  source: Exclude<ProductionFrameSource, "upload">,
  ids: { sourceStoryboardFrameId?: string; sourceMasterFrameId?: string },
  asset: Asset | null,
  slug: string,
): Promise<ActionResult> {
  const repo = await getRepo();
  if (!asset || asset.projectId !== ctx.project.id)
    throw new UserFacingError("That frame has no image in this project.");
  const drafted = draftProductionFrame(ctx, {
    id: randomUUID(),
    now: new Date().toISOString(),
    userId: repo.currentUserId(),
    source,
    ...ids,
    asset,
  });
  if (!drafted.ok) throw new UserFacingError(drafted.problem.message);
  try {
    const result = await (
      await getProductionFrameRepo()
    ).create({
      draft: drafted.draft,
      newAsset: null,
      select: true,
      userId: repo.currentUserId(),
      now: drafted.draft.createdAt,
    });
    refresh(slug);
    return {
      ok: true,
      message: result.created
        ? `Production Frame v${result.frame.version} is now canonical.`
        : `That frame already exists as Production Frame v${result.frame.version}; it is canonical again.`,
    };
  } catch (err) {
    return asUserError(err);
  }
}

async function promoteStoryboardFrame_impl(form: FormData): Promise<ActionResult> {
  const { ctx, slug } = await loadShotContext(form);
  const frame = ctx.approvedFrame;
  if (!frame)
    throw new UserFacingError("Approve a storyboard frame first, then use it as the Production Frame.");
  if (!frame.assetId) throw new UserFacingError("The approved storyboard frame has no image.");
  return promote(
    ctx,
    "storyboard",
    { sourceStoryboardFrameId: frame.id },
    ctx.assets.get(frame.assetId) ?? null,
    slug,
  );
}

async function promoteMasterFrame_impl(form: FormData): Promise<ActionResult> {
  const { ctx, data, slug } = await loadShotContext(form);
  const masterFrameId = str(form, "masterFrameId");
  const mf = masterFrameId ? await (await getPrevisRepo()).getMasterFrame(masterFrameId) : null;
  // the master frame must be THIS shot's, in THIS project (RLS already limits what the user can see)
  if (!mf || mf.projectId !== data.project.id || mf.shotId !== ctx.shot.id)
    throw new UserFacingError("That 3D Master Frame does not belong to this Shot.");
  return promote(
    ctx,
    "previs_master",
    { sourceMasterFrameId: mf.id },
    ctx.assets.get(mf.assetId) ?? null,
    slug,
  );
}

async function uploadProductionFrame_impl(form: FormData): Promise<ActionResult> {
  const { data, ctx, slug } = await loadShotContext(form);
  const file = hasFile(form, "file");
  if (!file) throw new UserFacingError("Choose an image to upload.");
  const repo = await getRepo();
  // the shared upload pipeline: size limit, magic bytes, MIME, dimensions, checksum, private Storage
  const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
    allowed: ["image"],
    purpose: "production_frame",
    source: "upload",
    tags: ["production-frame"],
  });
  const drafted = draftProductionFrame(ctx, {
    id: randomUUID(),
    now: new Date().toISOString(),
    userId: repo.currentUserId(),
    source: "upload",
    asset,
  });
  if (!drafted.ok) {
    // wrong shape / type: nothing was persisted; remove the object that was just stored
    await discardUpload(asset);
    throw new UserFacingError(drafted.problem.message);
  }
  try {
    const result = await (
      await getProductionFrameRepo()
    ).create({
      draft: drafted.draft,
      newAsset: asset,
      select: true,
      userId: repo.currentUserId(),
      now: drafted.draft.createdAt,
    });
    // an identical frame already existed: the new object was never referenced, so it is removed
    if (!result.created) await discardUpload(asset);
    refresh(slug);
    return {
      ok: true,
      message: result.created
        ? `Production Frame v${result.frame.version} is now canonical.`
        : `That image already exists as Production Frame v${result.frame.version}; it is canonical again.`,
    };
  } catch (err) {
    await discardUpload(asset);
    return asUserError(err);
  }
}

async function selectProductionFrame_impl(form: FormData): Promise<ActionResult> {
  const { data, ctx, slug } = await loadShotContext(form);
  const frameId = str(form, "productionFrameId");
  // what the browser saw as canonical ("" = nothing); a mismatch is a conflict, never a silent overwrite
  const expected = form.has("expectedSelectedId") ? str(form, "expectedSelectedId") || null : undefined;
  const repo = await getRepo();
  try {
    const selection = await (
      await getProductionFrameRepo()
    ).select({
      projectId: data.project.id,
      shotId: ctx.shot.id,
      productionFrameId: frameId,
      userId: repo.currentUserId(),
      now: new Date().toISOString(),
      expectedSelectedFrameId: expected,
    });
    refresh(slug);
    const v = ctx.productionFrames.find((f) => f.id === selection.productionFrameId)?.version;
    return { ok: true, message: v ? `Production Frame v${v} is now canonical.` : undefined };
  } catch (err) {
    return asUserError(err);
  }
}

export async function promoteStoryboardFrame(form: FormData): Promise<ActionResult> {
  return runAction(() => promoteStoryboardFrame_impl(form), { name: "promoteStoryboardFrame" });
}
export async function promoteMasterFrame(form: FormData): Promise<ActionResult> {
  return runAction(() => promoteMasterFrame_impl(form), { name: "promoteMasterFrame" });
}
export async function uploadProductionFrame(form: FormData): Promise<ActionResult> {
  return runAction(() => uploadProductionFrame_impl(form), { name: "uploadProductionFrame" });
}
export async function selectProductionFrame(form: FormData): Promise<ActionResult> {
  return runAction(() => selectProductionFrame_impl(form), { name: "selectProductionFrame" });
}
