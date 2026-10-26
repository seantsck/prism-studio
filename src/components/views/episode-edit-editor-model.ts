import { formatSeconds } from "@/domain/duration";
import { eligibleClips, type EditMediaFacts } from "@/domain/edit/eligibility";
import {
  itemDurationMs,
  VISUAL_KIND_LABEL,
  type EpisodeEdit,
  type SourceAudio,
  type VisualKind,
} from "@/domain/edit/model";
import { proposeShotItem } from "@/domain/edit/proposal";
import { proposedItemKey } from "@/domain/edit/proposal-key";
import type { ItemView } from "@/domain/edit/view";
import type { ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import type { BadgeVM } from "./episode-edit-model";

/**
 * Phase 2I.1D: what the Episode Edit page's editing controls offer for each item, built from the project's records and
 * the 2I.1A eligibility rules. Choices are only offered, never applied: every control posts a REQUEST that the server
 * re-validates through the repository (with the revision the page showed). Best and approval are shown as facts, never
 * as requirements: any eligible succeeded Shot-output clip can be pinned deliberately.
 */

export interface SourceOptionVM {
  /** posted as `source`: video:<attempt>:<asset> | production_frame:<id> | storyboard_frame:<id> | none */
  value: string;
  kind: VisualKind;
  kindLabel: string;
  label: string;
  facts: string[];
  badges: BadgeVM[];
  previewUrl: string | null;
  previewType: "video" | "image" | null;
  pinned: boolean;
}

export interface TakeOptionVM {
  takeId: string;
  label: string;
  facts: string[];
  pinned: boolean;
}

export interface LineEditorVM {
  dialogueLineId: string;
  label: string;
  placed: boolean;
  takes: TakeOptionVM[];
}

export interface ItemEditorVM {
  itemId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  sources: SourceOptionVM[];
  /** video: the trim in seconds and the exact Asset's length */
  trim: { inS: string; outS: string; assetS: string | null } | null;
  /** stills / none: the hold in seconds */
  hold: { durationS: string } | null;
  /** the replacement the page reports, exactly as an explicit "Use replacement" would pin it */
  replacement: { attemptId: string; assetId: string; label: string } | null;
  lines: LineEditorVM[];
  clipAudio: { value: SourceAudio; available: boolean; note: string | null } | null;
}

export interface AddableShotVM {
  shotId: string;
  shotCode: string;
  title: string;
  proposed: string;
  duration: string;
  /** proposedItemKey: the server adds the Shot only if its proposal is unchanged */
  itemKey: string;
}

const secs = (ms: number) => (ms / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";

function sources(data: ProjectData, iv: ItemView, media: EditMediaFacts): SourceOptionVM[] {
  const shotId = iv.item.shotId;
  const v = iv.item.visual;
  const best = new Set(
    media.bestPointers.filter((b) => b.shotId === shotId && b.attemptId).map((b) => b.attemptId),
  );
  const out: SourceOptionVM[] = [];
  for (const clip of eligibleClips(data, shotId, media)) {
    const a = clip.attempt;
    for (const { asset, role } of clip.assets) {
      const badges: BadgeVM[] = [];
      if (a.approved) badges.push({ label: "Approved", tone: "pass" });
      if (best.has(a.id)) badges.push({ label: "Best", tone: "info" });
      if (media.attempts.get(a.id)?.deliveryAssetId === asset.id)
        badges.push({ label: "Delivery master", tone: "accent" });
      const pinned = v.kind === "video" && v.attemptId === a.id && v.assetId === asset.id;
      if (pinned) badges.push({ label: "Pinned", tone: "neutral" });
      out.push({
        value: `video:${a.id}:${asset.id}`,
        kind: "video",
        kindLabel: VISUAL_KIND_LABEL.video,
        label: `Generation #${a.attemptNumber} · ${a.provider} ${a.model}`,
        facts: [
          role === "primary_output"
            ? "primary output"
            : role === "variant_output"
              ? "variant output"
              : "delivery version",
          `${formatSeconds(asset.durationMs!)} clip`,
          `review: ${a.reviewStatus}`,
        ],
        badges,
        previewUrl: assetUrl(asset),
        previewType: "video",
        pinned,
      });
    }
  }
  const selectedPf = data.productionFrameSelections?.find((s) => s.shotId === shotId)?.productionFrameId;
  for (const f of (data.productionFrames ?? []).filter((x) => x.shotId === shotId)) {
    const pinned = v.kind === "production_frame" && v.productionFrameId === f.id;
    out.push({
      value: `production_frame:${f.id}`,
      kind: "production_frame",
      kindLabel: VISUAL_KIND_LABEL.production_frame,
      label: `Production Frame v${f.version}`,
      facts: [f.id === selectedPf ? "the Shot's selected frame" : "not the selected frame"],
      badges: pinned ? [{ label: "Pinned", tone: "neutral" }] : [],
      previewUrl: assetUrl(data.assets.find((x) => x.id === f.assetId)),
      previewType: "image",
      pinned,
    });
  }
  for (const f of data.frames.filter((x) => x.shotId === shotId)) {
    const pinned = v.kind === "storyboard_frame" && v.storyboardFrameId === f.id;
    out.push({
      value: `storyboard_frame:${f.id}`,
      kind: "storyboard_frame",
      kindLabel: VISUAL_KIND_LABEL.storyboard_frame,
      label: `Storyboard frame v${f.version}`,
      facts: [f.approved ? "approved" : "not approved"],
      badges: pinned ? [{ label: "Pinned", tone: "neutral" }] : [],
      previewUrl: assetUrl(f.assetId ? data.assets.find((x) => x.id === f.assetId) : undefined),
      previewType: "image",
      pinned,
    });
  }
  out.push({
    value: "none",
    kind: "none",
    kindLabel: VISUAL_KIND_LABEL.none,
    label: "No picture (an empty slot)",
    facts: [],
    badges: v.kind === "none" ? [{ label: "Pinned", tone: "neutral" }] : [],
    previewUrl: null,
    previewType: null,
    pinned: v.kind === "none",
  });
  return out;
}

function lines(data: ProjectData, iv: ItemView): LineEditorVM[] {
  const shot = data.shots.find((s) => s.id === iv.item.shotId);
  const lineIds = [
    ...new Set([...(shot?.audio.dialogueLineIds ?? []), ...iv.item.performance.map((p) => p.dialogueLineId)]),
  ];
  return lineIds.map((lineId) => {
    const line = data.dialogueLines.find((l) => l.id === lineId);
    const character = line?.characterId ? data.characters.find((c) => c.id === line.characterId) : null;
    const pinnedTakeId = iv.item.performance.find((p) => p.dialogueLineId === lineId)?.takeId ?? null;
    const takes = data.takes
      .filter((t) => t.dialogueLineId === lineId && (!t.archived || t.id === pinnedTakeId))
      .sort((a, b) => a.takeNumber - b.takeNumber)
      .map<TakeOptionVM>((t) => ({
        takeId: t.id,
        label: `Take ${t.takeNumber}`,
        facts: [
          formatSeconds(t.durationMs),
          t.sourceType.replace(/_/g, " "),
          ...(t.selected ? ["selected now"] : []),
          ...(t.archived ? ["archived"] : []),
          t.audioAssetId ? "audio file" : "no audio file (timed text)",
        ],
        pinned: t.id === pinnedTakeId,
      }));
    return {
      dialogueLineId: lineId,
      label: line
        ? `${character?.name ?? (line.speakerLabel || "Unknown speaker")}: “${line.originalText}”`
        : "(dialogue line missing)",
      placed: pinnedTakeId !== null,
      takes,
    };
  });
}

export function itemEditor(
  data: ProjectData,
  edit: EpisodeEdit,
  iv: ItemView,
  media: EditMediaFacts,
): ItemEditorVM {
  const v = iv.item.visual;
  const asset = v.kind === "video" ? data.assets.find((a) => a.id === v.assetId) : undefined;
  return {
    itemId: iv.item.id,
    canMoveUp: iv.index > 0,
    canMoveDown: iv.index < edit.items.length - 1,
    sources: sources(data, iv, media),
    trim:
      v.kind === "video"
        ? {
            inS: secs(v.sourceInMs),
            outS: secs(v.sourceOutMs),
            assetS: asset?.durationMs != null ? secs(asset.durationMs) : null,
          }
        : null,
    hold: v.kind === "video" ? null : { durationS: secs(itemDurationMs(v)) },
    replacement: iv.replacement
      ? (() => {
          const a = data.attempts.find((x) => x.id === iv.replacement!.visual.attemptId);
          const as = data.assets.find((x) => x.id === iv.replacement!.visual.assetId);
          return {
            attemptId: iv.replacement.visual.attemptId,
            assetId: iv.replacement.visual.assetId,
            label: `Generation #${a?.attemptNumber ?? "?"} · ${as?.name ?? "clip"} (${formatSeconds(iv.replacement.visual.sourceOutMs)})`,
          };
        })()
      : null,
    lines: lines(data, iv),
    clipAudio:
      v.kind === "video"
        ? {
            value: iv.item.sourceAudio,
            available: Boolean(asset?.channels),
            note: asset?.channels
              ? null
              : "No audio track is recorded for this clip: including it would play nothing.",
          }
        : null,
  };
}

/** Shots of the Episode not in the edit, each with what adding it would create (its proposal) and that proposal's key. */
export function addableShots(
  data: ProjectData,
  notInEditShotIds: string[],
  media: EditMediaFacts,
): AddableShotVM[] {
  return notInEditShotIds.map((shotId) => {
    const shot = data.shots.find((s) => s.id === shotId)!;
    const proposed = proposeShotItem(data, shotId, media);
    return {
      shotId,
      shotCode: shot.shotCode,
      title: shot.title,
      proposed: VISUAL_KIND_LABEL[proposed.visual.kind],
      duration: formatSeconds(itemDurationMs(proposed.visual)),
      itemKey: proposedItemKey(proposed),
    };
  });
}
