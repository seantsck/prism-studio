import type { ShotContext } from "../context";
import type { GenerationPackage } from "../generation-package";
import { PRODUCTION_FRAME_SOURCE_LABEL, type ProductionFrameSource } from "../production-frame";
import type { Asset, GenerationAttempt } from "../schemas";
import { characterImages, type IgnoredFeature } from "./compatibility";

/**
 * Reference integrity of one Shot: do the canonical references exist, and did they actually reach the picture a video
 * is about to be made from?
 *
 * Why this exists. A video model given a first frame receives that frame and text, nothing else: on Runway Gen-4.5 and
 * Gen-4 Turbo the image-to-video request has no reference-image input at all, and every hosted model that has one
 * excludes it in first-frame mode. So in "Animate Production Frame" the Character's identity, the wardrobe Look and the
 * Location can reach the clip ONLY through the selected Production Frame. Whether that frame was itself made from the
 * canonical references is therefore the one reference question that matters before spend, and it is answerable from
 * records Prism already keeps: the frame's source attempt and that attempt's frozen `inputAssetIds`.
 *
 * Pure, and derived only from the Shot context, its frozen package and the project's immutable attempts: no new state.
 * It reports facts about inputs (lineage); it never claims to have looked at pixels.
 */

/** Where a reference image came from, so a generated reference is never presented as photographic ground truth. */
export type ReferenceOrigin = "uploaded" | "generated" | "derived" | "other";

export const REFERENCE_ORIGIN_LABEL: Record<ReferenceOrigin, string> = {
  uploaded: "uploaded original",
  generated: "generated reference",
  derived: "derived from another image",
  other: "other source",
};

export function referenceOrigin(asset: Pick<Asset, "source"> | null | undefined): ReferenceOrigin | null {
  if (!asset) return null;
  switch (asset.source) {
    case "upload":
    case "recording":
    case "import":
      return "uploaded";
    case "generated":
    case "provider_output":
      return "generated";
    case "derived":
    case "extracted":
      return "derived";
    default:
      return "other";
  }
}

export type ReferenceSlotKind = "identity" | "look" | "location_view" | "location";

/** One essential reference a Production Frame should be made from. */
export interface ReferenceSlot {
  /** Stable: `identity:<characterId>`, `look:<characterId>`, `location_view`, `location`. */
  id: string;
  kind: ReferenceSlotKind;
  /** Who or what it describes ("Yumeko", "Grand Celeste Lobby"). */
  subject: string;
  /** What it is, in the words the rest of the product uses ("Canonical Identity", "Episode 1 — Formal Black Look"). */
  label: string;
  /** `ready`: a stored image exists and is what Prism sends. `missing`: described in words only. */
  status: "ready" | "missing";
  /** The image Prism sends for this slot (the first stored one), or null. */
  assetId: string | null;
  origin: ReferenceOrigin | null;
  detail: string;
}

export type FrameLineageStatus =
  /** No Production Frame is selected. */
  | "none"
  /** Generated, and its generation (or the image it was edited from) consumed every ready essential reference. */
  | "verified"
  /** Generated WITHOUT one or more of the Shot's current essential references. */
  | "partial"
  /** Generated while the Shot had no reference image at all: every appearance came from words. */
  | "unreferenced"
  /** Not generated from references (uploaded, Storyboard, 3D Master Frame), or its attempt record is unavailable. */
  | "unverifiable";

export interface FrameLineage {
  status: FrameLineageStatus;
  frame: { frameId: string; version: number; assetId: string; source: ProductionFrameSource } | null;
  sourceAttemptId: string | null;
  /** Ready essential references the frame's generation consumed. */
  consumed: ReferenceSlot[];
  /** Ready essential references the frame was generated without. */
  missing: ReferenceSlot[];
  message: string;
}

export interface ShotReferenceIntegrity {
  slots: ReferenceSlot[];
  lineage: FrameLineage;
  /** Every essential slot is ready AND the selected frame's lineage is verified. */
  verified: boolean;
}

type AssetLike = Pick<Asset, "id" | "type" | "source" | "objectPath" | "checksum">;

const stored = (a: AssetLike | undefined): a is AssetLike =>
  Boolean(a && a.objectPath && a.checksum && (a.type === "image" || a.type === "reference"));

/** The essential reference slots of a Shot, in the order Prism sends them (identity, Look per Character; then place). */
export function referenceSlots(ctx: ShotContext, pkg: GenerationPackage): ReferenceSlot[] {
  const asset = (id: string | null | undefined) => (id ? ctx.assets.get(id) : undefined);
  const firstStored = (ids: Array<string | null | undefined>) => ids.find((id) => stored(asset(id))) ?? null;
  const slots: ReferenceSlot[] = [];

  for (const c of pkg.characters) {
    const images = characterImages(pkg, c);
    const lock = c.continuityLock
      ? pkg.references.characterContinuity?.find((l) => l.lockId === c.continuityLock?.lockId)
      : undefined;
    const canonical = lock ? null : (c.canonicalIdentityAssetId ?? null);
    const canonicalStored = stored(asset(canonical));
    const identityId = canonicalStored ? canonical : firstStored(images.identity.map((i) => i.assetId));
    const placeholders = images.identity.length + (canonical && !canonicalStored ? 1 : 0);
    slots.push({
      id: `identity:${c.characterId}`,
      kind: "identity",
      subject: c.name,
      label: lock
        ? `Continuity Lock "${lock.name}" identity`
        : canonicalStored
          ? "Canonical Identity"
          : identityId
            ? "Identity reference (no Canonical Identity is designated)"
            : "Identity",
      status: identityId ? "ready" : "missing",
      assetId: identityId,
      origin: referenceOrigin(asset(identityId)),
      detail: identityId
        ? lock
          ? "Frozen by the selected Continuity Lock."
          : canonicalStored
            ? "The designated Canonical Identity leads every image request for this Character."
            : "An identity image is sent, but none is designated as the Canonical Identity."
        : placeholders > 0
          ? `${placeholders} identity ${placeholders === 1 ? "entry has" : "entries have"} no stored image: ${c.name} is described in words only.`
          : `${c.name} has no identity image: described in words only.`,
    });

    const lookName = lock ? lock.facts.look?.name : c.look?.name;
    const lookId = firstStored(images.look.map((i) => i.assetId));
    slots.push({
      id: `look:${c.characterId}`,
      kind: "look",
      subject: c.name,
      label: lookName ? `${lookName} Look` : "Look",
      status: lookId ? "ready" : "missing",
      assetId: lookId,
      origin: referenceOrigin(asset(lookId)),
      detail: lookId
        ? "The Look's first reference image is sent with the identity."
        : lookName
          ? `The ${lookName} Look has no stored reference image: the wardrobe is described in words only.`
          : `${c.name} has no Look assigned for this Shot.`,
    });
  }

  if (pkg.set) {
    const view = pkg.references.locationView;
    const viewStored = stored(asset(view?.assetId));
    slots.push({
      id: "location_view",
      kind: "location_view",
      subject: pkg.set.name,
      label: view ? `Location View "${view.name}"` : "Location View",
      status: viewStored ? "ready" : "missing",
      assetId: viewStored ? view!.assetId : null,
      origin: referenceOrigin(asset(viewStored ? view!.assetId : null)),
      detail: viewStored
        ? "The Shot's selected canonical view of the Location."
        : view
          ? `The selected Location View "${view.name}" has no stored image.`
          : `No Location View is selected for this Shot: the viewpoint of ${pkg.set.name} is described in words only.`,
    });
    // the Location's own canonical image is supporting material, not essential: reported when designated
    const canonical = (pkg.set.visualReferences ?? []).find((r) => r.kind === "canonical");
    if (canonical && stored(asset(canonical.assetId)) && canonical.assetId !== view?.assetId)
      slots.push({
        id: "location",
        kind: "location",
        subject: pkg.set.name,
        label: "Location canonical image",
        status: "ready",
        assetId: canonical.assetId,
        origin: referenceOrigin(asset(canonical.assetId)),
        detail: "Sent after the Location View when the model's reference limit allows.",
      });
  }
  return slots;
}

/** Slots whose image is essential to a Production Frame (the Location's own canonical image is supporting). */
const essential = (s: ReferenceSlot) => s.kind !== "location";

type LineageAttempt = Pick<GenerationAttempt, "id" | "inputAssetIds" | "outputAssetId">;

/**
 * Every Asset the frame's generation consumed, following edits back through the images they were made from (an edit of
 * a generated still inherits what that still was generated from). Bounded; cycles are impossible in immutable history
 * but are guarded anyway.
 */
export function consumedAssetIds(sourceAttemptId: string, attempts: readonly LineageAttempt[]): Set<string> {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const byOutput = new Map(attempts.flatMap((a) => (a.outputAssetId ? [[a.outputAssetId, a] as const] : [])));
  const consumed = new Set<string>();
  const seen = new Set<string>();
  let frontier = [sourceAttemptId];
  for (let depth = 0; depth < 12 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      const attempt = byId.get(id);
      if (!attempt) continue;
      for (const assetId of attempt.inputAssetIds) {
        consumed.add(assetId);
        const parent = byOutput.get(assetId);
        if (parent && !seen.has(parent.id)) next.push(parent.id);
      }
    }
    frontier = next;
  }
  return consumed;
}

const list = (xs: string[]) =>
  xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

const slotName = (s: ReferenceSlot) => `${s.subject} — ${s.label}`;

export function frameLineage(
  ctx: ShotContext,
  slots: readonly ReferenceSlot[],
  attempts: readonly LineageAttempt[],
): FrameLineage {
  const selected = ctx.selectedProductionFrame;
  if (!selected)
    return {
      status: "none",
      frame: null,
      sourceAttemptId: null,
      consumed: [],
      missing: [],
      message: "No Production Frame is selected.",
    };
  const frame = {
    frameId: selected.id,
    version: selected.version,
    assetId: selected.assetId,
    source: selected.source,
  };
  const ready = slots.filter((s) => essential(s) && s.status === "ready");
  const attemptId = selected.source === "generation_output" ? selected.sourceGenerationAttemptId : null;
  if (!attemptId || !attempts.some((a) => a.id === attemptId)) {
    const how =
      selected.source === "generation_output"
        ? "Its generation record is not available"
        : `${PRODUCTION_FRAME_SOURCE_LABEL[selected.source]}, not generated from this Shot's references`;
    return {
      status: "unverifiable",
      frame,
      sourceAttemptId: attemptId,
      consumed: [],
      missing: [],
      message: `Production Frame v${selected.version}: ${how}. Prism cannot verify from its records that it shows the canonical identity, Look and Location; check it by eye.`,
    };
  }
  const consumedIds = consumedAssetIds(attemptId, attempts);
  const consumed = ready.filter((s) => consumedIds.has(s.assetId!));
  const missing = ready.filter((s) => !consumedIds.has(s.assetId!));
  if (ready.length === 0)
    return {
      status: "unreferenced",
      frame,
      sourceAttemptId: attemptId,
      consumed,
      missing,
      message: `Production Frame v${selected.version} was generated while this Shot had no reference image: every appearance in it comes from words only.`,
    };
  if (missing.length > 0)
    return {
      status: "partial",
      frame,
      sourceAttemptId: attemptId,
      consumed,
      missing,
      message: `Production Frame v${selected.version} was generated without ${list(missing.map(slotName))}. Generate a new Production Frame from the current references, or accept this frame as it is.`,
    };
  return {
    status: "verified",
    frame,
    sourceAttemptId: attemptId,
    consumed,
    missing,
    message: `Production Frame v${selected.version} was generated from ${list(consumed.map(slotName))}.`,
  };
}

export function shotReferenceIntegrity(
  ctx: ShotContext,
  pkg: GenerationPackage,
  attempts: readonly LineageAttempt[],
): ShotReferenceIntegrity {
  const slots = referenceSlots(ctx, pkg);
  const lineage = frameLineage(ctx, slots, attempts);
  return {
    slots,
    lineage,
    verified: lineage.status === "verified" && slots.filter(essential).every((s) => s.status === "ready"),
  };
}

/** Stable acknowledgement ids (recorded on the attempt as `acknowledgedIgnored`). */
export const ACK_FRAME_LINEAGE = "references.frame_lineage";
export const ACK_REFERENCE_MISSING = "references.essential_missing";

/**
 * What an animation of the selected frame cannot fix, as explicit acknowledgements. The video model receives only the
 * frame, so a reference the frame was made without (or that does not exist) cannot be added by animating it. Uploaded
 * and promoted frames are not listed: their lineage is simply not Prism's to know (shown, not gated).
 */
export function referenceIntegrityAcknowledgements(integrity: ShotReferenceIntegrity): IgnoredFeature[] {
  const out: IgnoredFeature[] = [];
  const { lineage, slots } = integrity;
  if (lineage.status === "none") return out;
  if (lineage.status === "partial")
    out.push({
      id: ACK_FRAME_LINEAGE,
      feature: "references",
      label: `Production Frame v${lineage.frame!.version} was generated without ${list(lineage.missing.map(slotName))}`,
      impact:
        "The video model receives only this frame, so animating it cannot add the missing reference. The clip will show whatever the frame shows. Generate a new Production Frame from the current references to fix it.",
    });
  const absent = slots.filter((s) => essential(s) && s.status === "missing");
  // an uploaded or promoted frame is the filmmaker's own picture: a missing reference image says nothing about it
  if (absent.length > 0 && (lineage.status === "unreferenced" || lineage.status === "partial"))
    out.push({
      id: ACK_REFERENCE_MISSING,
      feature: "references",
      label: `No stored reference image for ${list(absent.map(slotName))}`,
      impact:
        "The Production Frame's appearance for these came from words only, and nothing ties it to the rest of the film. Add the reference images and generate a new Production Frame, or accept this frame as the reference.",
    });
  return out;
}
