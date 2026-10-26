import { formatDuration, formatSeconds } from "@/domain/duration";
import { editRateLabel, type EditRate } from "@/domain/edit/edit-rate";
import { VIDEO_SOURCE_VIOLATION_TEXT, type EditMediaFacts } from "@/domain/edit/eligibility";
import { VISUAL_KIND_LABEL, type EditItem, type EpisodeEdit, type VisualKind } from "@/domain/edit/model";
import {
  VISUAL_PROPOSAL_TEXT,
  type EditProposal,
  type ProposalNote,
  type VisualProposalReason,
} from "@/domain/edit/proposal";
import { proposalKey } from "@/domain/edit/proposal-key";
import {
  buildEpisodeEditView,
  editItemLineage,
  type EpisodeEditView,
  type ItemView,
  type LineageStep,
} from "@/domain/edit/view";
import { buildPlaybackPlan, type PlaybackPlan } from "@/domain/edit/playback";
import type { ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import { addableShots, itemEditor, type AddableShotVM, type ItemEditorVM } from "./episode-edit-editor-model";

/**
 * Display model of the Episode Edit page (Phase 2I.1C; the editing choices of 2I.1D are episode-edit-editor-model.ts). Built from the pure 2I.1A domain (proposal, edit
 * view, lineage) and the project's own records; it never writes, and it never follows Best, approval, a Production
 * Frame selection or a take selection: the persisted edit is the editorial truth and every upstream change is a badge.
 * Media is addressed only through the private `/api/assets/<id>` route (`assetUrl`), never a storage path.
 */

export type Tone = "neutral" | "pass" | "warn" | "fail" | "info" | "accent";
export interface BadgeVM {
  label: string;
  tone: Tone;
  title?: string;
}
export interface LinkVM {
  label: string;
  url: string | null;
}

export interface PictureVM {
  kind: VisualKind;
  /** "Generated clip", "Placeholder: Storyboard still", … (never a still called video) */
  kindLabel: string;
  placeholder: boolean;
  mediaUrl: string | null;
  mediaType: "video" | "image" | null;
  /** what exactly is shown: "Generation #3 · runway gen4", "Storyboard frame v1", "No picture yet" */
  source: string;
  details: string[];
}

export interface PlacementVM {
  dialogueLineId: string;
  speaker: string;
  text: string;
  take: string;
  /** "at 0.5s · take 0.0s–2.0s" (item-relative start, take in/out) */
  timing: string;
  audioUrl: string | null;
  badges: BadgeVM[];
}

export interface AudioVM {
  placements: PlacementVM[];
  /** no placement under the item: explicit silence */
  silence: boolean;
  notes: string[];
  clipAudio: string;
}

export interface RowVM {
  key: string;
  index: number;
  shotId: string;
  shotCode: string;
  shotTitle: string;
  scene: string;
  run: string;
  start: string;
  duration: string;
  startMs: number;
  durationMs: number;
  /** the Shot's planned duration, when it differs from the item */
  planned: string | null;
  picture: PictureVM;
  audio: AudioVM;
  badges: BadgeVM[];
  problems: string[];
  notes: string[];
  lineage: { picture: LinkVM[]; audio: LinkVM[][] };
  /** 2I.1D: the editing controls' choices (persisted edit only) */
  editor?: ItemEditorVM;
}

export interface RunVM {
  label: string;
  firstIndex: number;
  lastIndex: number;
  start: string;
  duration: string;
}

export interface SummaryVM {
  total: string;
  totalFrames: number;
  editRate: string;
  items: number;
  runs: number;
  scenes: number;
}

export interface ProposalPageVM {
  state: "proposal";
  key: string;
  summary: SummaryVM;
  runs: RunVM[];
  rows: RowVM[];
  editRateNote: string | null;
}

export interface EditPageVM {
  state: "edit";
  editId: string;
  revision: number;
  summary: SummaryVM;
  runs: RunVM[];
  rows: RowVM[];
  badges: BadgeVM[];
  /** every item whose source cannot be resolved, by Shot: shown, never omitted */
  problems: string[];
  /** 2I.1D: Shots of the Episode not in the edit, with what adding each would create */
  addable: AddableShotVM[];
  /** 2I.1E: the rough-sequence playback of exactly this saved edit */
  playback: PlaybackVM;
}

/** What the rough-sequence player needs: the pure plan plus display labels (no other facts). */
export interface PlaybackVM {
  plan: PlaybackPlan;
  items: Record<string, { shotCode: string; run: string; kindLabel: string; source: string }>;
  placements: Record<string, string>;
}

const PLACEHOLDER_KINDS: ReadonlySet<VisualKind> = new Set(["production_frame", "storyboard_frame", "none"]);

const ROLE_LABEL: Record<string, string> = {
  primary_output: "primary output",
  variant_output: "variant output",
  delivery_version: "delivery version",
};
const PURPOSE_LABEL: Record<string, string> = {
  shot_output: "Shot output",
  animate_production_frame: "animated from Production Frame",
  production_frame: "Production Frame candidate",
};
const PLACEHOLDER_VIOLATION: Record<string, string> = {
  frame_not_found: "The frame no longer exists.",
  frame_wrong_shot: "The frame belongs to another Shot.",
  shot_not_found: "The Shot no longer exists.",
};

const violationText = (v: string) =>
  VIDEO_SOURCE_VIOLATION_TEXT[v as keyof typeof VIDEO_SOURCE_VIOLATION_TEXT] ?? PLACEHOLDER_VIOLATION[v] ?? v;

function picture(data: ProjectData, item: EditItem, media: EditMediaFacts): PictureVM {
  const v = item.visual;
  const base = {
    kind: v.kind,
    kindLabel: VISUAL_KIND_LABEL[v.kind],
    placeholder: PLACEHOLDER_KINDS.has(v.kind),
  };
  if (v.kind === "video") {
    const attempt = data.attempts.find((a) => a.id === v.attemptId);
    const asset = data.assets.find((a) => a.id === v.assetId);
    const facts = media.attempts.get(v.attemptId);
    const role = facts?.outputs.find((o) => o.assetId === v.assetId)?.role;
    const master = facts?.deliveryAssetId ?? null;
    return {
      ...base,
      mediaUrl: assetUrl(asset),
      mediaType: asset ? "video" : null,
      source: attempt
        ? `Generation #${attempt.attemptNumber} · ${attempt.provider} ${attempt.model}`
        : "Generation missing",
      details: [
        `Asset: ${asset ? asset.name : "missing"}${role ? ` (${role} output)` : facts?.deliveryVersions.some((d) => d.assetId === v.assetId) ? " (delivery version)" : ""}`,
        `Trim ${formatSeconds(v.sourceInMs)}–${formatSeconds(v.sourceOutMs)}${asset?.durationMs != null ? ` of ${formatSeconds(asset.durationMs)}` : ""}`,
        master === v.assetId
          ? "Delivery master: this Asset"
          : master
            ? "Delivery master: another Asset of this generation"
            : "Delivery master: none selected",
      ],
    };
  }
  if (v.kind === "production_frame") {
    const frame = (data.productionFrames ?? []).find((f) => f.id === v.productionFrameId);
    const asset = frame ? data.assets.find((a) => a.id === frame.assetId) : undefined;
    return {
      ...base,
      mediaUrl: assetUrl(asset),
      mediaType: asset ? "image" : null,
      source: frame ? `Production Frame v${frame.version}` : "Production Frame missing",
      details: [`Held ${formatSeconds(v.durationMs)}`],
    };
  }
  if (v.kind === "storyboard_frame") {
    const frame = data.frames.find((f) => f.id === v.storyboardFrameId);
    const asset = frame?.assetId ? data.assets.find((a) => a.id === frame.assetId) : undefined;
    return {
      ...base,
      mediaUrl: assetUrl(asset),
      mediaType: asset ? "image" : null,
      source: frame
        ? `Storyboard frame v${frame.version}${frame.approved ? " (approved)" : ""}`
        : "Storyboard frame missing",
      details: [`Held ${formatSeconds(v.durationMs)}`],
    };
  }
  return {
    ...base,
    mediaUrl: null,
    mediaType: null,
    source: "No picture yet",
    details: [`Held ${formatSeconds(v.durationMs)}`],
  };
}

function speakerOf(data: ProjectData, dialogueLineId: string) {
  const line = data.dialogueLines.find((l) => l.id === dialogueLineId);
  const character = line?.characterId ? data.characters.find((c) => c.id === line.characterId) : null;
  return { line, speaker: character?.name ?? (line?.speakerLabel || "Unknown speaker") };
}

function audio(data: ProjectData, item: EditItem, view: ItemView | null): AudioVM {
  const placements = item.performance.map<PlacementVM>((p) => {
    const { line, speaker } = speakerOf(data, p.dialogueLineId);
    const take = data.takes.find((t) => t.id === p.takeId);
    const audioAsset = take?.audioAssetId ? data.assets.find((a) => a.id === take.audioAssetId) : undefined;
    const facts = view?.performance.placements.find((f) => f.dialogueLineId === p.dialogueLineId);
    const selectedNow = facts?.selectedTakeId ? data.takes.find((t) => t.id === facts.selectedTakeId) : null;
    const badges: BadgeVM[] = [];
    if (facts?.state === "take_superseded")
      badges.push({
        label: "Take superseded",
        tone: "warn",
        title: selectedNow
          ? `Take ${selectedNow.takeNumber} is selected now; this edit keeps its pinned take.`
          : undefined,
      });
    if (facts?.state === "take_archived") badges.push({ label: "Take archived", tone: "warn" });
    if (facts?.state === "line_removed") badges.push({ label: "Dialogue removed", tone: "warn" });
    if (facts?.state === "take_missing") badges.push({ label: "Take missing", tone: "fail" });
    return {
      dialogueLineId: p.dialogueLineId,
      speaker,
      text: line ? line.originalText : "(dialogue line missing)",
      take: take ? `Take ${take.takeNumber} · ${take.sourceType.replace(/_/g, " ")}` : "Take missing",
      timing: `at ${formatSeconds(p.startMs)} · take ${formatSeconds(p.takeInMs)}–${formatSeconds(p.takeOutMs)}`,
      audioUrl: assetUrl(audioAsset),
      badges,
    };
  });
  const notes: string[] = [];
  const unplaced = view?.performance.unplacedLineIds.length ?? 0;
  const missing = view?.performance.missingTakeLineIds.length ?? 0;
  if (unplaced)
    notes.push(`${unplaced} line${unplaced === 1 ? "" : "s"} with a selected take not placed here`);
  if (missing) notes.push(`${missing} line${missing === 1 ? "" : "s"} without a selected take`);
  return {
    placements,
    silence: placements.length === 0,
    notes,
    clipAudio: item.sourceAudio === "muted" ? "Clip audio muted" : "Clip audio included",
  };
}

function lineage(data: ProjectData, item: EditItem, media: EditMediaFacts): RowVM["lineage"] {
  const { picture: steps, audio: chains } = editItemLineage(data, item, media);
  const asset = (id: string | null) => (id ? data.assets.find((a) => a.id === id) : undefined);
  const label = (s: LineageStep): LinkVM => {
    switch (s.step) {
      case "shot":
        return { label: `Shot ${s.shotCode}`, url: null };
      case "attempt": {
        const attempt = data.attempts.find((a) => a.id === s.attemptId);
        return {
          label: `Generation #${s.attemptNumber} · ${attempt?.provider ?? "?"} ${s.model} · ${PURPOSE_LABEL[s.purpose] ?? s.purpose}`,
          url: null,
        };
      }
      case "asset": {
        const a = asset(s.assetId);
        return {
          label: `${a ? a.name : "Asset missing"} · ${s.role ? ROLE_LABEL[s.role] : "not a picture of this generation"}${s.isCurrentDeliveryMaster ? " · current delivery master" : ""}`,
          url: assetUrl(a),
        };
      }
      case "derived_from": {
        const a = asset(s.assetId);
        return {
          label: `derived from ${a ? a.name : "a missing Asset"} (delivery v${s.version})`,
          url: assetUrl(a),
        };
      }
      case "production_frame":
        return {
          label: s.version == null ? "Production Frame missing" : `Production Frame v${s.version}`,
          url: assetUrl(asset(s.assetId)),
        };
      case "storyboard_frame":
        return {
          label: s.version == null ? "Storyboard frame missing" : `Storyboard frame v${s.version}`,
          url: assetUrl(asset(s.assetId)),
        };
      default:
        return { label: "No picture", url: null };
    }
  };
  const pictureLinks = steps.map(label);
  // a missing Shot is said, never skipped
  if (steps[0]?.step !== "shot") pictureLinks.unshift({ label: "Shot missing", url: null });
  return {
    picture: pictureLinks,
    audio: chains.map((c) => {
      const { line, speaker } = speakerOf(data, c.dialogueLineId);
      const a = asset(c.audioAssetId);
      return [
        { label: line ? `Line · ${speaker}: “${line.originalText}”` : "Dialogue line missing", url: null },
        {
          label:
            c.takeNumber == null
              ? "Take missing"
              : `Take ${c.takeNumber} · ${(c.sourceType ?? "").replace(/_/g, " ")}`,
          url: null,
        },
        a
          ? { label: `Audio · ${a.name}`, url: assetUrl(a) }
          : { label: "No audio file (timed text only)", url: null },
      ];
    }),
  };
}

function runsOf(data: ProjectData, view: EpisodeEditView): RunVM[] {
  const count = new Map<string, number>();
  for (const r of view.sceneRuns) count.set(r.sceneId, (count.get(r.sceneId) ?? 0) + 1);
  return view.sceneRuns.map((r) => {
    const scene = data.scenes.find((s) => s.id === r.sceneId);
    const n = count.get(r.sceneId) ?? 1;
    return {
      label: `${scene ? `Scene ${scene.sceneNumber}` : "Scene missing"}${n > 1 ? ` · run ${r.occurrence} of ${n}` : ""}`,
      firstIndex: r.firstIndex,
      lastIndex: r.lastIndex,
      start: formatDuration(r.startMs),
      duration: formatSeconds(r.endMs - r.startMs),
    };
  });
}

function summaryOf(view: EpisodeEditView, rate: EditRate): SummaryVM {
  return {
    total: formatDuration(view.totalMs),
    totalFrames: view.totalFrames,
    editRate: editRateLabel(rate),
    items: view.items.length,
    runs: view.sceneRuns.length,
    scenes: new Set(view.sceneRuns.map((r) => r.sceneId)).size,
  };
}

function row(
  data: ProjectData,
  view: EpisodeEditView,
  runs: RunVM[],
  iv: ItemView,
  media: EditMediaFacts,
  key: string,
): Omit<RowVM, "badges" | "problems" | "notes"> {
  const shot = data.shots.find((s) => s.id === iv.item.shotId);
  const scene = shot ? data.scenes.find((s) => s.id === shot.sceneId) : undefined;
  const run = runs.find((r) => iv.index >= r.firstIndex && iv.index <= r.lastIndex);
  return {
    key,
    index: iv.index,
    shotId: iv.item.shotId,
    shotCode: shot?.shotCode ?? "(missing Shot)",
    shotTitle: shot?.title ?? "",
    scene: scene ? `Scene ${scene.sceneNumber}` : "Scene missing",
    run: run?.label ?? "",
    start: formatDuration(iv.timing.startMs),
    duration: formatSeconds(iv.timing.durationMs),
    startMs: iv.timing.startMs,
    durationMs: iv.timing.durationMs,
    planned: shot && iv.duration.deltaMs !== 0 ? formatSeconds(iv.duration.plannedMs) : null,
    picture: picture(data, iv.item, media),
    audio: audio(data, iv.item, view.items[iv.index] ?? null),
    lineage: lineage(data, iv.item, media),
  };
}

const NOTE_TEXT = (data: ProjectData, n: ProposalNote): string => {
  const line = (id: string) => {
    const { line: l, speaker } = speakerOf(data, id);
    return l ? `${speaker}: “${l.originalText}”` : "a missing line";
  };
  const attempt = (id: string) => {
    const a = data.attempts.find((x) => x.id === id);
    return a ? `generation #${a.attemptNumber}` : "a generation";
  };
  switch (n.code) {
    case "best_not_followed":
      return `Best (${attempt(n.attemptId)}) is not followed: Best is a review hint, only approval is proposed.`;
    case "approved_clip_unusable":
      return `The approved clip (${attempt(n.attemptId)}) has no usable video of known duration, so a placeholder is proposed.`;
    case "clip_shorter_than_planned":
      return `The clip is ${formatSeconds(n.shortByMs)} shorter than planned; it is not stretched or padded.`;
    case "planned_duration_unset":
      return `The Shot has no planned duration; the placeholder holds ${formatSeconds(n.fallbackMs)}.`;
    case "missing_take":
      return `No selected take for ${line(n.dialogueLineId)}: silence there.`;
    case "take_clipped_to_item":
      return `The take for ${line(n.dialogueLineId)} is cut at the end of the item.`;
    case "take_outside_item":
      return `The take for ${line(n.dialogueLineId)} would start after the item ends; not placed.`;
  }
};

/** The proposal state: what Prism would create, NOT an edit (nothing persisted). */
export function proposalPage(
  data: ProjectData,
  proposal: EditProposal,
  media: EditMediaFacts,
): ProposalPageVM {
  const pseudo: EpisodeEdit = {
    id: "proposal",
    projectId: data.project.id,
    episodeId: proposal.episodeId,
    editRate: proposal.editRate,
    revision: 0,
    items: proposal.items.map((p, i) => ({
      id: `proposed-${i}`,
      shotId: p.shotId,
      visual: p.visual,
      sourceAudio: p.sourceAudio,
      performance: p.performance,
      performanceBasis: p.performanceBasis,
    })),
  };
  const view = buildEpisodeEditView(data, pseudo, media);
  const runs = runsOf(data, view);
  return {
    state: "proposal",
    key: proposalKey(proposal),
    summary: summaryOf(view, proposal.editRate),
    runs,
    editRateNote: proposal.editRateExact
      ? null
      : `The project frame rate (${data.bible.defaultFrameRate} fps) is not a supported edit rate; 24 fps is proposed.`,
    rows: view.items.map((iv) => {
      const p = proposal.items[iv.index]!;
      return {
        ...row(data, view, runs, iv, media, `proposed-${p.shotId}`),
        badges: [
          { label: VISUAL_KIND_LABEL[p.visual.kind], tone: p.visual.kind === "video" ? "pass" : "neutral" },
        ],
        problems: [],
        notes: [
          VISUAL_PROPOSAL_TEXT[p.visualReason as VisualProposalReason],
          ...p.notes.map((n) => NOTE_TEXT(data, n)),
        ],
      };
    }),
  };
}

function itemBadges(iv: ItemView): { badges: BadgeVM[]; problems: string[] } {
  const badges: BadgeVM[] = [
    {
      label: "Pinned",
      tone: "neutral",
      title: "The edit keeps this source until an explicit editorial change.",
    },
  ];
  const problems: string[] = [];
  const f = iv.visual;
  if (!iv.inEpisode) {
    badges.push({ label: "Not in this Episode", tone: "fail" });
    problems.push("The Shot is not part of this Episode.");
  }
  if (!f.usable) {
    badges.push({ label: "Source unavailable", tone: "fail" });
    problems.push(...f.violations.map(violationText));
  }
  if (f.kind === "video") {
    if (f.approved) badges.push({ label: "Approved", tone: "pass" });
    if (f.approvedElsewhereAttemptId) badges.push({ label: "Approved elsewhere", tone: "warn" });
    if (f.isBest) badges.push({ label: "Best", tone: "info" });
    if (f.bestElsewhereAttemptIds.length) badges.push({ label: "Best elsewhere", tone: "neutral" });
    if (f.newerDeliveryMasterAssetId) badges.push({ label: "Newer delivery master", tone: "warn" });
    if (f.productionFrameChanged) badges.push({ label: "Production Frame changed", tone: "warn" });
    if (f.freshness.status === "stale")
      badges.push({ label: "Stale", tone: "warn", title: f.freshness.messages.join(" ") });
  } else {
    if (f.selectionChanged) badges.push({ label: "Production Frame changed", tone: "warn" });
    if (f.freshness && f.freshness.status === "stale")
      badges.push({ label: "Stale", tone: "warn", title: f.freshness.messages.join(" ") });
  }
  if (iv.replacement)
    badges.push({
      label: iv.replacement.reason === "clip_available" ? "Clip available" : "Replacement available",
      tone: "accent",
      title:
        iv.replacement.reason === "approval_moved"
          ? "The Shot's approved clip is another generation."
          : iv.replacement.reason === "delivery_master_changed"
            ? "The generation's selected delivery master is another Asset."
            : "The Shot now has an approved clip.",
    });
  if (iv.performance.performanceChanged) badges.push({ label: "Dialogue changed", tone: "warn" });
  if (iv.performance.plannedTimingChanged) badges.push({ label: "Planned timing changed", tone: "warn" });
  if (iv.performance.placements.some((p) => p.state === "take_missing"))
    problems.push("A placed take no longer exists.");
  return { badges, problems };
}

/** The persisted edit: authoritative editorial intent; upstream changes only as facts. */
export function editPage(data: ProjectData, edit: EpisodeEdit, media: EditMediaFacts): EditPageVM {
  const view = buildEpisodeEditView(data, edit, media);
  const runs = runsOf(data, view);
  const rows = view.items.map<RowVM>((iv) => {
    const { badges, problems } = itemBadges(iv);
    return {
      ...row(data, view, runs, iv, media, iv.item.id),
      badges,
      problems,
      notes: [],
      editor: itemEditor(data, edit, iv, media),
    };
  });
  const badges: BadgeVM[] = [];
  if (view.orderDiffersFromSequence) badges.push({ label: "Order differs from Sequence", tone: "warn" });
  if (view.notInEditShotIds.length)
    badges.push({
      label: `${view.notInEditShotIds.length} Shot${view.notInEditShotIds.length === 1 ? "" : "s"} not in edit`,
      tone: "neutral",
    });
  return {
    state: "edit",
    editId: edit.id,
    revision: edit.revision,
    summary: summaryOf(view, edit.editRate),
    runs,
    rows,
    badges,
    problems: rows.flatMap((r) => r.problems.map((p) => `${r.shotCode}: ${p}`)),
    addable: addableShots(data, view.notInEditShotIds, media),
    playback: playbackOf(data, edit, rows),
  };
}

/**
 * The playback plan of the SAVED edit: its own order, pinned pictures, trims, holds, placements and clip-audio policy,
 * media through the private asset route. Items the read view already reports as "Source unavailable" play their
 * interval as unavailable. Nothing current (Best, approval, master, selections) is consulted.
 */
function playbackOf(data: ProjectData, edit: EpisodeEdit, rows: RowVM[]): PlaybackVM {
  const byItem = new Map(rows.map((r) => [r.key, r]));
  const plan = buildPlaybackPlan(
    edit,
    {
      pictureUrl: (item) => byItem.get(item.id)?.picture.mediaUrl ?? null,
      takeUrl: (takeId) => {
        const take = data.takes.find((t) => t.id === takeId);
        return assetUrl(take?.audioAssetId ? data.assets.find((a) => a.id === take.audioAssetId) : undefined);
      },
    },
    new Set(rows.filter((r) => r.badges.some((b) => b.label === "Source unavailable")).map((r) => r.key)),
  );
  const items: PlaybackVM["items"] = {};
  for (const r of rows)
    items[r.key] = {
      shotCode: r.shotCode,
      run: r.run || r.scene,
      kindLabel: r.picture.kindLabel,
      source: r.picture.source,
    };
  const placements: PlaybackVM["placements"] = {};
  for (const r of rows)
    for (const pl of r.audio.placements)
      placements[`${r.key}:${pl.dialogueLineId}`] = `${pl.speaker}: “${pl.text}”`;
  return { plan, items, placements };
}
