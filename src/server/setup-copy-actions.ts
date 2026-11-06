"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { PrevisError } from "@/data/previs-repository";
import { authoredLightingIntent } from "@/domain/previs/lighting";
import {
  availableSetup,
  parseSetupComponents,
  planIsNoop,
  planSetupCopy,
  SAME_LOCATION_ONLY,
  SETUP_COMPONENTS,
  SETUP_SHOT_GONE,
  SetupCopyRefusal,
  type SetupComponent,
  type SetupCopyPlan,
} from "@/domain/previs/setup-copy";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPrevisRepo } from "./previs";
import { requireProjectFresh } from "./repo";

/**
 * Phase 4D "Copy setup from…". Two actions: a read-only preview that shows exactly what would be copied and what it
 * would replace, and the copy itself, which must carry the preview's token. Both resolve BOTH Shots from the caller's
 * own Project (`requireProjectFresh`, RLS-bound in Supabase mode), so a Shot id from another Project, a deleted Shot
 * and a Shot the caller cannot read all get the same answer, and nothing about another owner's Shot is revealed.
 */
export type SetupCopyResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

export interface SetupCopyPreview {
  plan: SetupCopyPlan | null;
  /** what the source Shot has on this set, whichever parts were asked for */
  available: Record<SetupComponent, boolean>;
  sourceShotCode: string;
  /** character names for the plan's blocking lines */
  characters: Record<string, string>;
  /** applying would change nothing on the destination */
  noop: boolean;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function guarded<T>(body: () => Promise<SetupCopyResult<T>>): Promise<SetupCopyResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof PrevisError)
      return { ok: false, error: err.message, conflict: err.code === "conflict" };
    if (err instanceof UserFacingError || err instanceof SetupCopyRefusal)
      return { ok: false, error: err.message };
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err; // redirect / notFound / auth keep propagating
    const ref = randomUUID().slice(0, 8);
    console.error(`[setup-copy ${ref}]`, err instanceof Error ? err.message : "unknown error");
    return { ok: false, error: `Something went wrong copying the setup (ref ${ref}).` };
  }
}

function componentsOf(form: FormData): SetupComponent[] | null {
  const raw = str(form, "components");
  if (raw === "") return null;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new UserFacingError("The setup parts are not valid.");
  }
  if (!Array.isArray(list)) throw new UserFacingError("The setup parts are not valid.");
  return parseSetupComponents(list);
}

/** Resolves both Shots, their shared Location and its current set, and both Shots' stored setup rows. */
async function resolve(form: FormData) {
  const slug = str(form, "projectSlug");
  const destinationId = str(form, "shotId");
  const sourceId = str(form, "sourceShotId");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const destination = data.shots.find((s) => s.id === destinationId);
  const source = data.shots.find((s) => s.id === sourceId);
  if (!destination || !source) throw new UserFacingError(SETUP_SHOT_GONE);
  if (source.id === destination.id) throw new UserFacingError("A Shot's setup cannot be copied onto itself.");
  const locationId = destination.spatial.locationId;
  if (!locationId)
    throw new UserFacingError("Choose this Shot's Location in Shot Prep before copying a setup into it.");
  if (source.spatial.locationId !== locationId) throw new UserFacingError(SAME_LOCATION_ONLY);
  const previs = await getPrevisRepo();
  const scene = await previs.getSceneForLocation(locationId);
  if (!scene || scene.projectId !== data.project.id)
    throw new UserFacingError("Save the 3D set before copying a setup.");
  const rowsOf = async (shotId: string) => ({
    camera: await previs.getBookmarkForShot(shotId),
    lighting: await previs.getLightingRigForShot(shotId),
    blocking: await previs.listShotBlocking(shotId),
  });
  return {
    slug,
    user,
    data,
    destination,
    source,
    previs,
    set: { locationId, sceneDocumentId: scene.id },
    rows: { source: await rowsOf(source.id), destination: await rowsOf(destination.id) },
  };
}

/** Read-only: what "Copy setup from <source>" would copy into this Shot. Writes nothing. */
export async function previewShotSetupCopy(form: FormData): Promise<SetupCopyResult<SetupCopyPreview>> {
  return guarded(async () => {
    const asked = componentsOf(form);
    const r = await resolve(form);
    const available = availableSetup(r.rows.source, r.set);
    const components = asked ?? SETUP_COMPONENTS.filter((c) => available[c]);
    const plan =
      components.length === 0
        ? null
        : planSetupCopy({
            sourceShotId: r.source.id,
            destinationShotId: r.destination.id,
            set: r.set,
            source: r.rows.source,
            destination: r.rows.destination,
            components,
          });
    const characters: Record<string, string> = {};
    for (const c of r.data.characters) characters[c.id] = c.name;
    return {
      ok: true,
      plan,
      available,
      sourceShotCode: r.source.shotCode,
      characters,
      noop: plan ? planIsNoop(plan) : true,
    };
  });
}

/**
 * The explicit copy. The destination receives its own normal rows (camera, lighting, blocking), written in one
 * transaction from the plan recomputed under lock; a token other than the reviewed one refuses and writes nothing.
 * Lighting keeps the DESTINATION's authored lighting text: only the lights and base mode are copied.
 */
export async function copyShotSetup(
  form: FormData,
): Promise<SetupCopyResult<{ plan: SetupCopyPlan; copied: SetupComponent[] }>> {
  return guarded(async () => {
    const components = componentsOf(form);
    const token = str(form, "token");
    if (!components || components.length === 0)
      throw new UserFacingError("Choose at least one part to copy.");
    if (!/^[0-9a-f]{64}$/.test(token)) throw new UserFacingError("Review the copy before confirming it.");
    const r = await resolve(form);
    const result = await r.previs.copyShotSetup({
      projectId: r.data.project.id,
      sourceShotId: r.source.id,
      destinationShotId: r.destination.id,
      locationId: r.set.locationId,
      sceneDocumentId: r.set.sceneDocumentId,
      components,
      expectedToken: token,
      destinationIntent: authoredLightingIntent(r.destination),
      userId: r.user.kind === "supabase" ? r.user.id : null,
      now: new Date().toISOString(),
    });
    revalidatePath(`/projects/${r.slug}`, "layout");
    return { ok: true, plan: result.plan, copied: result.plan.components };
  });
}
