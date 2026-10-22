"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { LocationViewError } from "@/data/location-view-repository";
import { buildShotContext, type ShotContext } from "@/domain/context";
import { draftLocationView, type LocationViewSpecInput } from "@/domain/location-view";
import { productionFrameToViewStatus } from "@/domain/production-frame";
import type { Location, ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { discardUpload, hasFile, ingestUpload } from "./ingest-upload";
import { persistUploadedLocationView } from "./location-view-upload";
import { getLocationViewRepo } from "./location-views";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 2G.3 Location View actions. A Location View is one IMMUTABLE canonical viewpoint of a Location (image + view
 * spec); a Shot chooses the exact view it means through ONE selection pointer. None of these actions needs a 3D set, a
 * GPU or a provider, and none calls a generation model.
 *
 *   uploadLocationView                  a new private `location_ref` Asset + its view, stored together
 *   createLocationViewFromReference     one of the Location's existing reference images becomes a named view (reused)
 *   saveProductionFrameAsLocationView   the Shot's SELECTED, FRESH Production Frame becomes a view (its Asset reused)
 *   selectShotLocationView              the Shot uses a view of ITS OWN Location (compare-and-set)
 *   clearShotLocationView               the Shot uses no view (compare-and-set)
 *
 * The caller never names a path, bucket or Storage location; images are the project's own Asset records.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

/** A repository refusal is a user-correctable message; anything else is a real error. */
function asUserError(err: unknown): never {
  if (err instanceof LocationViewError) throw new UserFacingError(err.message);
  throw err;
}

/** The view spec as the forms submit it (`lv_` fields); zone / entrance are ids of the Location's own. */
function specFromForm(form: FormData): LocationViewSpecInput {
  const f = (k: string) => str(form, `lv_${k}`);
  return {
    name: f("name"),
    kind: f("kind"),
    zoneId: f("zoneId") || null,
    entranceId: f("entranceId") || null,
    viewpointDescription: f("viewpointDescription"),
    orientation: f("orientation"),
    cameraPosition: f("cameraPosition"),
    cameraHeight: f("cameraHeight"),
    cameraAngle: f("cameraAngle"),
    shotSize: f("shotSize"),
    framing: f("framing"),
    lens: f("lens"),
    geographyNotes: f("geographyNotes"),
    continuityNotes: f("continuityNotes"),
  };
}

async function loadLocation(
  form: FormData,
): Promise<{ data: ProjectData; location: Location; slug: string }> {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const location = data.locations.find((l) => l.id === str(form, "locationId"));
  if (!location) throw new UserFacingError("Location not found.");
  return { data, location, slug: data.project.slug };
}

async function loadShotContext(
  form: FormData,
): Promise<{ data: ProjectData; ctx: ShotContext; slug: string }> {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const shotId = str(form, "shotId");
  if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("Shot not found.");
  return { data, ctx: buildShotContext(data, shotId), slug: data.project.slug };
}

const createdMessage = (name: string, created: boolean) =>
  created
    ? `Location View "${name}" saved.`
    : `That view already exists as "${name}"; nothing was duplicated.`;

async function uploadLocationView_impl(form: FormData): Promise<ActionResult> {
  const { data, location, slug } = await loadLocation(form);
  const file = hasFile(form, "file");
  if (!file) throw new UserFacingError("Choose an image to upload.");
  const repo = await getRepo();
  // the shared upload pipeline: size limit, magic bytes, MIME, dimensions, checksum, private Storage
  const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
    allowed: ["image"],
    purpose: "location_ref",
    source: "upload",
    tags: ["location-view"],
  });
  try {
    const result = await persistUploadedLocationView(
      { repo: await getLocationViewRepo(), discard: discardUpload },
      location,
      asset,
      specFromForm(form),
      repo.currentUserId(),
    );
    refresh(slug);
    return { ok: true, message: createdMessage(result.view.name, result.created) };
  } catch (err) {
    return asUserError(err);
  }
}

async function createFromReference_impl(form: FormData): Promise<ActionResult> {
  const { data, location, slug } = await loadLocation(form);
  const assetId = str(form, "assetId");
  // only one of THIS Location's own reference images; it stays in referenceAssetIds (broad source material)
  if (!location.referenceAssetIds.includes(assetId))
    throw new UserFacingError("That image is not one of this Location's references.");
  const asset = data.assets.find((a) => a.id === assetId) ?? null;
  if (!asset) throw new UserFacingError("That reference image is missing.");
  const repo = await getRepo();
  const drafted = draftLocationView({
    id: randomUUID(),
    now: new Date().toISOString(),
    userId: repo.currentUserId(),
    projectId: data.project.id,
    location,
    asset,
    source: "location_reference",
    spec: specFromForm(form),
  });
  if (!drafted.ok) throw new UserFacingError(drafted.message);
  try {
    const result = await (await getLocationViewRepo()).create({ draft: drafted.draft, newAsset: null });
    refresh(slug);
    return { ok: true, message: createdMessage(result.view.name, result.created) };
  } catch (err) {
    return asUserError(err);
  }
}

async function saveProductionFrameAsView_impl(form: FormData): Promise<ActionResult> {
  const { data, ctx, slug } = await loadShotContext(form);
  // only a SELECTED and FRESH Production Frame of a Shot with a Location may become canonical Location truth
  const status = productionFrameToViewStatus(ctx);
  if (!status.ok) throw new UserFacingError(status.reason);
  const frame = ctx.selectedProductionFrame!;
  const asset = ctx.assets.get(frame.assetId) ?? null;
  if (!asset) throw new UserFacingError("The Production Frame's image is missing.");
  const repo = await getRepo();
  const drafted = draftLocationView({
    id: randomUUID(),
    now: new Date().toISOString(),
    userId: repo.currentUserId(),
    projectId: data.project.id,
    location: ctx.location!,
    asset, // the SAME Asset: no bytes are copied
    source: "production_frame",
    sourceProductionFrameId: frame.id,
    spec: specFromForm(form),
  });
  if (!drafted.ok) throw new UserFacingError(drafted.message);
  try {
    const result = await (await getLocationViewRepo()).create({ draft: drafted.draft, newAsset: null });
    refresh(slug);
    return {
      ok: true,
      message: result.created
        ? `Production Frame v${frame.version} saved as Location View "${result.view.name}" of ${ctx.location!.name}.`
        : createdMessage(result.view.name, false),
    };
  } catch (err) {
    return asUserError(err);
  }
}

const expectedOf = (form: FormData) =>
  form.has("expectedSelectedId") ? str(form, "expectedSelectedId") || null : undefined;

async function selectShotLocationView_impl(form: FormData): Promise<ActionResult> {
  const { data, ctx, slug } = await loadShotContext(form);
  const repo = await getRepo();
  try {
    const selection = await (
      await getLocationViewRepo()
    ).selectForShot({
      projectId: data.project.id,
      shotId: ctx.shot.id,
      locationViewId: str(form, "locationViewId"),
      userId: repo.currentUserId(),
      now: new Date().toISOString(),
      expectedSelectedViewId: expectedOf(form),
    });
    refresh(slug);
    const name = ctx.locationViews.find((v) => v.id === selection.locationViewId)?.name;
    return { ok: true, message: name ? `This Shot now uses Location View "${name}".` : undefined };
  } catch (err) {
    return asUserError(err);
  }
}

async function clearShotLocationView_impl(form: FormData): Promise<ActionResult> {
  const { data, ctx, slug } = await loadShotContext(form);
  try {
    await (
      await getLocationViewRepo()
    ).clearForShot({
      projectId: data.project.id,
      shotId: ctx.shot.id,
      expectedSelectedViewId: expectedOf(form),
    });
    refresh(slug);
    return { ok: true, message: "This Shot uses no Location View." };
  } catch (err) {
    return asUserError(err);
  }
}

export async function uploadLocationView(form: FormData): Promise<ActionResult> {
  return runAction(() => uploadLocationView_impl(form), { name: "uploadLocationView" });
}
export async function createLocationViewFromReference(form: FormData): Promise<ActionResult> {
  return runAction(() => createFromReference_impl(form), { name: "createLocationViewFromReference" });
}
export async function saveProductionFrameAsLocationView(form: FormData): Promise<ActionResult> {
  return runAction(() => saveProductionFrameAsView_impl(form), { name: "saveProductionFrameAsLocationView" });
}
export async function selectShotLocationView(form: FormData): Promise<ActionResult> {
  return runAction(() => selectShotLocationView_impl(form), { name: "selectShotLocationView" });
}
export async function clearShotLocationView(form: FormData): Promise<ActionResult> {
  return runAction(() => clearShotLocationView_impl(form), { name: "clearShotLocationView" });
}
