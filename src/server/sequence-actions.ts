"use server";

import { revalidatePath } from "next/cache";
import { planSequenceLinkSync } from "@/domain/shot-sequence";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 2G.5 Shot Sequence Board. The board itself is a read-only projection; its ONE write is the explicit
 * continuity-link sync: after the filmmaker confirmed the exact preview, every Shot whose stored previous-Shot link
 * differs from the actual order gets `continuity.previousShotId` set to the Shot before it (null for the first Shot).
 *
 * - The server recomputes everything; the browser only sends the preview key it confirmed. A different key (the order,
 *   a stored link or a lock changed since the preview) is refused: an old tab never applies an outdated preview.
 * - Any change that would touch a locked Shot refuses the WHOLE sync.
 * - Only the differing Shots are written, in ONE repository write (`upsertMany`: one transaction in Postgres), through
 *   the normal Shot save path. Order, Scene, Characters, Looks, Location, Production Frame, Storyboard and generation
 *   state are untouched; whatever depends on the `continuity` part becomes stale through the existing freshness rules.
 * No provider, AI analysis, 3D set or GPU.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const now = () => new Date().toISOString();

async function syncLinks_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const episodeId = str(form, "episodeId");
  if (!data.episodes.some((e) => e.id === episodeId)) throw new UserFacingError("Episode not found.");
  const plan = planSequenceLinkSync(data, episodeId, str(form, "previewKey"));
  if (!plan.ok) throw new UserFacingError(plan.message);
  const at = now();
  await (
    await getRepo()
  ).upsertMany(
    data.project.id,
    "shots",
    plan.shots.map((s) => ({ ...s, updatedAt: at })),
  );
  revalidatePath(`/projects/${slug}`, "layout");
  const n = plan.changes.length;
  return {
    ok: true,
    message: `${n} continuity link${n === 1 ? "" : "s"} synced (${plan.changes.map((c) => c.shotCode).join(", ")}).`,
  };
}

export async function syncSequenceContinuityLinks(form: FormData): Promise<ActionResult> {
  return runAction(() => syncLinks_impl(form), { name: "syncSequenceContinuityLinks" });
}
