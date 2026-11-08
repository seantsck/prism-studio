"use server";

import { revalidatePath } from "next/cache";
import {
  LOCATION_VISUAL_ROLES,
  locationBibleOf,
  normalizeLocationLabel,
  type LocationVisualBible,
  type LocationVisualRole,
} from "@/domain/location-visual-bible";
import type { Location, ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import { getRepo, requireProjectFresh } from "./repo";
import { subjectImageAssetIds } from "./subject-image-sources";

/**
 * Phase 5B-I5: the explicit Location Visual Bible designations. Each is a POINTER to an existing immutable Asset of
 * THIS Location (one of its references, its Location Views or its own generated images); nothing is copied and
 * nothing is replaced unless the creator says so. Generation never calls these. A locked Location is frozen.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function loadLocation(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const location = data.locations.find((l) => l.id === str(form, "locationId"));
  if (!location) throw new UserFacingError("That location no longer exists.");
  if (location.locked)
    throw new UserFacingError("That location is locked. Unlock it before changing its Visual Bible.");
  return { slug, data, location };
}

/** The chosen image: an Asset id, or a finished generated image of this Location (its primary output). */
async function resolveSource(data: ProjectData, location: Location, form: FormData): Promise<string> {
  let assetId = str(form, "assetId");
  const attemptId = str(form, "attemptId");
  if (!assetId && attemptId) {
    const view = await (await getGenerationRepo()).getSubjectImageAttempt(attemptId);
    if (!view || view.attempt.locationId !== location.id || view.attempt.projectId !== data.project.id)
      throw new UserFacingError("That generated image no longer exists.");
    if (view.attempt.status !== "succeeded") throw new UserFacingError("Only a finished image can be used.");
    assetId = (view.outputs.find((o) => o.output.role === "primary") ?? view.outputs[0])?.asset.id ?? "";
  }
  if (!assetId) throw new UserFacingError("Choose an image.");
  const own = await subjectImageAssetIds(data, { kind: "location", locationId: location.id });
  for (const v of data.locationViews ?? []) if (v.locationId === location.id) own.add(v.assetId);
  const asset = data.assets.find((a) => a.id === assetId && a.projectId === data.project.id);
  if (!own.has(assetId) || !asset || asset.type !== "image")
    throw new UserFacingError("That image does not belong to this location.");
  return assetId;
}

async function save(data: ProjectData, location: Location, visualBible: LocationVisualBible, slug: string) {
  await (await getRepo()).upsert(data.project.id, "locations", { ...location, visualBible });
  refresh(slug);
}

async function setCanonical_impl(form: FormData) {
  const { slug, data, location } = await loadLocation(form);
  const assetId = await resolveSource(data, location, form);
  const bible = locationBibleOf(location);
  if (bible.canonicalAssetId === assetId) return;
  if (bible.canonicalAssetId && str(form, "confirmReplace") !== "1")
    throw new UserFacingError(
      `${location.name} already has a canonical appearance. Confirm to replace it (the old image stays in the library).`,
    );
  await save(data, location, { ...bible, canonicalAssetId: assetId }, slug);
}

export async function setCanonicalLocation(form: FormData): Promise<ActionResult> {
  return runAction(() => setCanonical_impl(form), { name: "setCanonicalLocation" });
}

async function designate_impl(form: FormData) {
  const { slug, data, location } = await loadLocation(form);
  const role = str(form, "role") as LocationVisualRole;
  if (!(LOCATION_VISUAL_ROLES as readonly string[]).includes(role))
    throw new UserFacingError("Choose establishing view, background plate or variant.");
  const label = normalizeLocationLabel(str(form, "label"));
  if (role === "variant" && !label)
    throw new UserFacingError("Name the variant (for example: night, golden hour, crowded).");
  const assetId = await resolveSource(data, location, form);
  const bible = locationBibleOf(location);
  const same = bible.entries.find((e) => e.assetId === assetId && e.role === role);
  if (same?.label === label) return;
  const entries = same
    ? bible.entries.map((e) => (e === same ? { ...e, label } : e))
    : [...bible.entries, { assetId, role, label }];
  await save(data, location, { ...bible, entries }, slug);
}

export async function addLocationDesignation(form: FormData): Promise<ActionResult> {
  return runAction(() => designate_impl(form), { name: "addLocationDesignation" });
}

/** Removes ONE designation (the pointer only); the image stays in the library under the normal deletion rules. */
async function clear_impl(form: FormData) {
  const { slug, data, location } = await loadLocation(form);
  const role = str(form, "role");
  const assetId = str(form, "assetId");
  const bible = locationBibleOf(location);
  if (role === "canonical") {
    if (!bible.canonicalAssetId || bible.canonicalAssetId !== assetId)
      throw new UserFacingError("That designation no longer exists.");
    await save(data, location, { ...bible, canonicalAssetId: null }, slug);
    return;
  }
  const entries = bible.entries.filter((e) => !(e.assetId === assetId && e.role === role));
  if (entries.length === bible.entries.length)
    throw new UserFacingError("That designation no longer exists.");
  await save(data, location, { ...bible, entries }, slug);
}

export async function clearLocationDesignation(form: FormData): Promise<ActionResult> {
  return runAction(() => clear_impl(form), { name: "clearLocationDesignation" });
}
