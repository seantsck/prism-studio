import "server-only";
import { randomUUID } from "node:crypto";
import { REFERENCE_SET_VIEWS, referenceSetViewOf } from "@/domain/generation/reference-studio";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, IdentityRef, ProjectData } from "@/domain/schemas";
import { visualRoleOf } from "@/domain/visual-bible";
import { getGenerationRepo } from "./generation";
import { referenceStudioState } from "./reference-studio";
import { getRepo } from "./repo";

/**
 * Each reference view made in "4. Six views" was asked for as that view (front, 3/4, left profile …), so when one
 * finishes it goes straight into the reference set: the creator does not have to add it. A take made in the Reference
 * Studio is not added by itself (the creator uses it there, or rejects it). Only an EMPTY view slot is filled (a picture already in
 * a view is never replaced here, locked or not; a newer take is offered beside it instead), and a rejected or archived
 * take is never used. The front view also becomes the canonical identity when there is none yet;
 * a canonical the creator chose is kept.
 */

/** The reference set slot each view is kept in, and the picture it holds (undefined: empty). */
export function viewSlots(data: ProjectData, characterId: string) {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const out: Record<string, { ref: IdentityRef | undefined; asset: Asset | undefined }> = {};
  for (const v of REFERENCE_SET_VIEWS) {
    const ref = data.identityRefs.find(
      (r) =>
        r.characterId === characterId &&
        (v.slot === "additional"
          ? r.slot === "additional" && (r.metadata as { view?: unknown }).view === v.id
          : r.slot === v.slot && visualRoleOf(r) === null),
    );
    const asset = ref?.assetId ? assets.get(ref.assetId) : undefined;
    out[v.id] = { ref, asset: hasStoredImage(asset) ? asset : undefined };
  }
  return out;
}

const FINISHED = "succeeded";
/** The key every view made in "4. Six views" is submitted with (src/server/reference-view-actions.ts). */
export const VIEWS_KEY_PREFIX = "views-";

/** Fills every empty view slot whose view has a finished take. Returns the views filled. */
export async function autoAddMadeViews(data: ProjectData, characterId: string): Promise<string[]> {
  const pictures = await referenceStudioState(data, `character:${characterId}`);
  // only the views made from the Character page as views; a take made in the Reference Studio is the creator's to use
  const attempts = await (
    await getGenerationRepo({ startInlineWorker: false })
  ).listSubjectImageAttempts({ kind: "character", characterId });
  const fromViews = new Set(
    attempts.filter((v) => v.job?.idempotencyKey.startsWith(VIEWS_KEY_PREFIX)).map((v) => v.attempt.id),
  );
  const slots = viewSlots(data, characterId);
  const newest: Record<string, { assetId: string; attemptId: string; at: string }> = {};
  for (const t of pictures.takes) {
    const view = referenceSetViewOf(t.settings.intent);
    if (!view || !fromViews.has(t.attemptId) || t.status !== FINISHED || t.rejected || !t.asset) continue;
    if (newest[view] && newest[view]!.at >= t.createdAt) continue;
    newest[view] = { assetId: t.asset.id, attemptId: t.attemptId, at: t.createdAt };
  }
  const repo = await getRepo();
  const filled: string[] = [];
  const canonicalRef = data.identityRefs.find(
    (r) => r.characterId === characterId && visualRoleOf(r) === "canonical",
  );
  let hasCanonical = hasStoredImage(data.assets.find((a) => a.id === canonicalRef?.assetId));
  for (const v of REFERENCE_SET_VIEWS) {
    const take = newest[v.id];
    const slot = slots[v.id]!;
    if (!take || slot.asset) continue;
    await repo.upsert(data.project.id, "identityRefs", {
      id: slot.ref?.id ?? randomUUID(),
      characterId,
      slot: v.slot,
      assetId: take.assetId,
      label: v.label,
      metadata: {
        ...(v.slot === "additional" ? { view: v.id } : {}),
        source: "generated",
        attemptId: take.attemptId,
        addedBy: "auto",
      },
      locked: false,
    });
    filled.push(v.id);
    if (v.canonical && !hasCanonical) {
      const ref: IdentityRef = {
        id: canonicalRef?.id ?? randomUUID(),
        characterId,
        slot: "additional",
        assetId: take.assetId,
        label: "Canonical identity",
        metadata: { visualRole: "canonical", source: "visual_bible" },
        locked: false,
      };
      await repo.upsert(data.project.id, "identityRefs", ref);
      hasCanonical = true;
    }
  }
  return filled;
}
