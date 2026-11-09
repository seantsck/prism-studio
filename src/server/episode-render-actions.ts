"use server";

import { revalidatePath } from "next/cache";
import { buildRenderManifest, manifestFingerprint } from "@/domain/edit/render-manifest";
import { editStateFingerprint } from "@/domain/edit/revision";
import { renderFileName } from "@/render/filename";
import { buildRenderPlan, missingMedia, missingMediaMessage } from "@/render/plan";
import { deliveryProfile } from "@/render/profile";
import { RenderError } from "@/render/repository";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getEpisodeEditRepo } from "./episode-edits";
import { getEpisodeRenderRepo, kickInlineRenderWorker } from "./episode-renders";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 5B-V4 Render Episode. The request FREEZES what will be rendered: the edit at the revision the page showed, which
 * must be a SAVED revision (the render is of a named, recoverable state), its V3 render manifest (every source Asset id +
 * checksum) and the delivery profile. A final render fails CLOSED before any processing when an item has no picture
 * ("Episode contains N items with missing media: 3D."). The render itself runs on the durable render worker, never in
 * this request. No provider is involved and nothing is paid: a local render costs $0.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function requestEpisodeRender_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const edits = await getEpisodeEditRepo();
  const edit = await edits.get(data.project.id, str(form, "editId"));
  if (!edit) throw new UserFacingError("That edit no longer exists.");
  if (String(edit.revision) !== str(form, "expectedRevision")) {
    refresh(slug);
    throw new UserFacingError(
      "The edit changed since this page was loaded. Review the latest revision and render again.",
    );
  }
  const episode = data.episodes.find((e) => e.id === edit.episodeId);
  if (!episode) throw new UserFacingError("Episode not found.");
  // the render is of a SAVED revision: the exact state, recoverable later
  const state = editStateFingerprint(edit);
  const saved = [...(await edits.listRevisions(data.project.id, edit.id))]
    .reverse()
    .find((r) => r.fingerprint === state);
  if (!saved) throw new UserFacingError("Save this Edit revision before rendering it.");

  const manifest = buildRenderManifest(data, edit);
  const missing = missingMedia(manifest);
  if (missing.length) throw new UserFacingError(missingMediaMessage(missing));
  // the delivery profile; PRISM_STUDIO_RENDER_PRESET only trades x264 speed for size (tests / local demos), and it is
  // part of every segment's identity, so it never mixes with a profile rendered at another preset
  const profile = deliveryProfile(manifest.target, {
    preset: process.env.PRISM_STUDIO_RENDER_PRESET || undefined,
  });
  const plan = buildRenderPlan(manifest, profile);
  const renders = await getEpisodeRenderRepo();
  const render = await renders.create({
    projectId: data.project.id,
    episodeId: edit.episodeId,
    editId: edit.id,
    editRevision: edit.revision,
    savedRevisionId: saved.id,
    savedRevisionNumber: saved.number,
    manifest,
    manifestFingerprint: manifestFingerprint(manifest),
    stateFingerprint: state,
    profile,
    outputFilename: renderFileName(data.project.slug, episode),
    segmentsTotal: plan.pieces.length,
    userId: (await getRepo()).currentUserId(),
    now: new Date().toISOString(),
  });
  await kickInlineRenderWorker();
  refresh(slug);
  return { ok: true, message: `Render #${render.number} queued (Edit revision ${saved.number}).` };
}

export async function requestEpisodeRender(form: FormData): Promise<ActionResult> {
  return runAction(() => requestEpisodeRender_impl(form), { name: "requestEpisodeRender" });
}

/** Retry a FAILED render: the same render (no duplicate), its frozen manifest unchanged; valid segments are reused. */
export async function retryEpisodeRender(form: FormData): Promise<ActionResult> {
  return runAction(
    async () => {
      const slug = str(form, "projectSlug");
      const data = await requireProjectFresh(slug);
      try {
        const r = await (
          await getEpisodeRenderRepo()
        ).retry(data.project.id, str(form, "renderId"), new Date().toISOString());
        await kickInlineRenderWorker();
        refresh(slug);
        return { ok: true, message: `Render #${r.number} queued again.` };
      } catch (err) {
        if (err instanceof RenderError) throw new UserFacingError(err.message);
        throw err;
      }
    },
    { name: "retryEpisodeRender" },
  );
}
