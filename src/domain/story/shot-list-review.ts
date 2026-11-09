import { shotSchema, type ProjectData, type Scene, type Shot } from "@/domain/schemas";
import { emptyShot } from "@/domain/shot-defaults";
import { derivedId } from "./apply";
import {
  CAMERA_ANGLES,
  COVERAGE_LABEL,
  label,
  SHOT_SIZES,
  type PlannedShot,
  type ShotPlan,
  type ShotPlanningContext,
} from "./shot-list";

/**
 * Phase 5B-S4: the creator's review of a Shot List Proposal, and the DETERMINISTIC apply. Pure.
 *
 * The review is an ORDERED list of items (the order is the camera plan's order). An item points at a proposed Shot
 * (`key`) and carries the creator's choices: include / reject, edits, a split or duplicate variant, and what Apply does
 * with it — create a NEW Shot (default, never destructive) or REPLACE an existing Shot of the Scene in place (its id,
 * code, order, generations and frames are kept; only its planning fields change; needs explicit approval).
 */
export const SHOT_EDITABLE = [
  "title",
  "purpose",
  "beat",
  "framing",
  "emotionalIntention",
  "continuityNotes",
  "shotSize",
  "cameraAngle",
] as const;
export type ShotEditable = (typeof SHOT_EDITABLE)[number];

export type ShotDecision = { kind: "create" } | { kind: "replace"; shotId: string };

export interface ShotReviewItem {
  /** Stable within a proposal lineage: the plan key, or `key~n` for a split / duplicate. */
  id: string;
  key: string;
  selected: boolean;
  rejected: boolean;
  edits: Partial<Record<ShotEditable, string>>;
  /** A split part covers a subset of the Shot's dialogue. */
  dialogueKeys: string[] | null;
  variant: string | null;
  decision: ShotDecision;
}

export interface ShotListReview {
  version: 1;
  items: ShotReviewItem[];
  /** Explicit approval for every `replace` decision (destructive to the replaced Shots' planning fields). */
  confirmReplace: boolean;
}

export function defaultShotReview(plan: ShotPlan): ShotListReview {
  return {
    version: 1,
    items: [...plan.shots]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        id: s.key,
        key: s.key,
        selected: true,
        rejected: false,
        edits: {},
        dialogueKeys: null,
        variant: null,
        decision: { kind: "create" },
      })),
    confirmReplace: false,
  };
}

/** A newer version keeps the creator's choices for items whose Shot still exists; a regenerated Shot is fresh. */
export function carryShotReview(
  fresh: ShotPlan,
  previous: ShotListReview,
  regenerated: string | null,
): ShotListReview {
  const keys = new Set(fresh.shots.map((s) => s.key));
  const kept = previous.items
    .filter((i) => keys.has(i.key))
    .map((i) => (i.key === regenerated ? { ...i, edits: {}, dialogueKeys: null } : i));
  const missing = defaultShotReview(fresh).items.filter((i) => !kept.some((k) => k.key === i.key));
  return { version: 1, items: [...kept, ...missing], confirmReplace: false };
}

export const isIncluded = (i: ShotReviewItem) => i.selected && !i.rejected;

/** The Shot as the creator will apply it: the proposal plus the creator's edits and split. */
export function effectiveShot(plan: ShotPlan, item: ShotReviewItem): PlannedShot {
  const base = plan.shots.find((s) => s.key === item.key)!;
  const e = item.edits;
  return {
    ...base,
    title: e.title ?? base.title,
    purpose: e.purpose ?? base.purpose,
    beat: e.beat ?? base.beat,
    framing: e.framing ?? base.framing,
    emotionalIntention: e.emotionalIntention ?? base.emotionalIntention,
    continuityNotes: e.continuityNotes ?? base.continuityNotes,
    shotSize: (SHOT_SIZES as readonly string[]).includes(e.shotSize ?? "")
      ? (e.shotSize as PlannedShot["shotSize"])
      : base.shotSize,
    cameraAngle: (CAMERA_ANGLES as readonly string[]).includes(e.cameraAngle ?? "")
      ? (e.cameraAngle as PlannedShot["cameraAngle"])
      : base.cameraAngle,
    dialogueKeys: item.dialogueKeys ?? base.dialogueKeys,
  };
}

// ───────────────────────── review operations (deterministic) ─────────────────────────

export function moveItem(review: ShotListReview, id: string, dir: -1 | 1): ShotListReview {
  const items = [...review.items];
  const i = items.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= items.length) return review;
  [items[i], items[j]] = [items[j]!, items[i]!];
  return { ...review, items };
}

function nextId(review: ShotListReview, key: string) {
  let n = 2;
  while (review.items.some((x) => x.id === `${key}~${n}`)) n++;
  return `${key}~${n}`;
}

/** A variant of an item, right after it (same Shot, the creator edits it differently). */
export function duplicateItem(review: ShotListReview, id: string): ShotListReview {
  const i = review.items.findIndex((x) => x.id === id);
  if (i < 0) return review;
  const src = review.items[i]!;
  const copy: ShotReviewItem = {
    ...structuredClone(src),
    id: nextId(review, src.key),
    variant: "variant",
    decision: { kind: "create" },
  };
  const items = [...review.items];
  items.splice(i + 1, 0, copy);
  return { ...review, items };
}

/** Split a Shot covering several dialogue lines into two Shots, each covering half of them. */
export function splitItem(review: ShotListReview, id: string, plan: ShotPlan): ShotListReview {
  const i = review.items.findIndex((x) => x.id === id);
  if (i < 0) return review;
  const src = review.items[i]!;
  const lines = effectiveShot(plan, src).dialogueKeys;
  const half = Math.ceil(lines.length / 2);
  const title = effectiveShot(plan, src).title;
  const first: ShotReviewItem = {
    ...src,
    dialogueKeys: lines.length > 1 ? lines.slice(0, half) : lines,
    variant: "part 1",
    edits: { ...src.edits, title: `${title} (1/2)`.slice(0, 80) },
  };
  const second: ShotReviewItem = {
    ...structuredClone(src),
    id: nextId(review, src.key),
    dialogueKeys: lines.length > 1 ? lines.slice(half) : [],
    variant: "part 2",
    edits: { ...src.edits, title: `${title} (2/2)`.slice(0, 80) },
    decision: { kind: "create" },
  };
  const items = [...review.items];
  items.splice(i, 1, first, second);
  return { ...review, items };
}

// ───────────────────────── codes, matches, apply ─────────────────────────

const letter = (n: number) => `${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`;

/** The code each included item will have: a replaced Shot keeps its code; new Shots take the next free letters. */
export function previewCodes(review: ShotListReview, scene: Scene, existing: Shot[]): Map<string, string> {
  const used = new Set(existing.map((s) => s.shotCode));
  const out = new Map<string, string>();
  for (const it of review.items.filter(isIncluded))
    if (it.decision.kind === "replace") {
      const target = existing.find((s) => s.id === (it.decision as { shotId: string }).shotId);
      if (target) out.set(it.id, target.shotCode);
    }
  let n = 0;
  for (const it of review.items.filter(isIncluded)) {
    if (out.has(it.id)) continue;
    while (used.has(`${scene.sceneNumber}${letter(n)}`)) n++;
    const code = `${scene.sceneNumber}${letter(n)}`;
    used.add(code);
    out.set(it.id, code);
  }
  return out;
}

/** Existing Shots of the Scene a proposed Shot may correspond to (same position, or the same Characters + size). */
export function possibleMatches(
  plan: ShotPlan,
  item: ShotReviewItem,
  position: number,
  existing: Shot[],
  ctx: ShotPlanningContext,
) {
  const s = effectiveShot(plan, item);
  const ids = new Set(s.characterKeys.map((k) => ctx.characters.find((c) => c.key === k)?.id));
  return existing.filter(
    (e) =>
      e.order === position ||
      (e.characters.length > 0 &&
        e.characters.length === ids.size &&
        e.characters.every((c) => ids.has(c.characterId)) &&
        e.composition.shotSize.toLowerCase().replace(/[\s-]/g, "_") === s.shotSize),
  );
}

export interface ShotListApplyPlan {
  errors: string[];
  create: Shot[];
  update: Shot[];
  summary: { created: number; replaced: number; skipped: number };
}

const lines = (r: Array<{ startLine: number; endLine: number }>) =>
  r.map((x) => (x.startLine === x.endLine ? `${x.startLine}` : `${x.startLine}–${x.endLine}`)).join(", ");

/**
 * APPLY: Prism Shots for exactly the included items, in review order. Ids derive from (proposal, item), so applying is
 * deterministic; existing Shots are only changed through an explicit `replace` decision with `confirmReplace`.
 */
export function planShotListApply(args: {
  proposalId: string;
  proposalVersion: number;
  plan: ShotPlan;
  review: ShotListReview;
  context: ShotPlanningContext;
  data: ProjectData;
  scene: Scene;
  now: string;
}): ShotListApplyPlan {
  const { plan, review, context: ctx, data, scene, now } = args;
  const errors: string[] = [];
  const existing = data.shots.filter((s) => s.sceneId === scene.id).sort((a, b) => a.order - b.order);
  const included = review.items.filter(isIncluded);
  if (!included.length) errors.push("Select at least one Shot to apply.");
  const replaced = included.filter((i) => i.decision.kind === "replace");
  if (replaced.length && !review.confirmReplace)
    errors.push("Replacing existing Shots overwrites their planning fields: confirm the replacement first.");
  const targets = replaced.map((i) => (i.decision as { shotId: string }).shotId);
  if (new Set(targets).size !== targets.length)
    errors.push("Two proposed Shots replace the same existing Shot.");
  for (const id of targets)
    if (!existing.some((s) => s.id === id))
      errors.push("A Shot chosen for replacement is not in this Scene.");
  const codes = previewCodes(review, scene, existing);
  const charId = new Map(ctx.characters.map((c) => [c.key, c.id]));
  const locId = new Map(ctx.locations.map((l) => [l.key, l.id]));
  const lineId = new Map(ctx.dialogue.map((d) => [d.key, d.id]));
  const actionId = new Map(ctx.actions.map((a) => [a.key, a.id]));
  const nextOrder = existing.reduce((m, s) => Math.max(m, s.order), -1) + 1;
  const create: Shot[] = [];
  const update: Shot[] = [];
  let appended = 0;
  for (const item of included) {
    const s = effectiveShot(plan, item);
    const dialogueIds = s.dialogueKeys.map((k) => lineId.get(k)).filter((x): x is string => Boolean(x));
    const actionIds = s.actionKeys.map((k) => actionId.get(k)).filter((x): x is string => Boolean(x));
    const characterIds = s.characterKeys.map((k) => charId.get(k)).filter((x): x is string => Boolean(x));
    const notes = [
      `${COVERAGE_LABEL[s.coverage]} · ${label(s.shotSize)} · ${label(s.cameraAngle)}`,
      s.emotionalIntention.trim() ? `Emotional intention: ${s.emotionalIntention}` : "",
      s.continuityNotes.trim() ? `Continuity: ${s.continuityNotes}` : "",
      `Source: lines ${lines(s.sources)} (Shot List v${args.proposalVersion})`,
    ]
      .filter(Boolean)
      .join("\n");
    const planned = (base: Shot): Shot =>
      shotSchema.parse({
        ...base,
        title: s.title.trim() || base.title,
        storyBeat: s.beat,
        dramaticPurpose: s.purpose,
        composition: {
          ...base.composition,
          framing: s.framing,
          shotSize: label(s.shotSize),
          cameraAngle: label(s.cameraAngle),
          aspectRatio: base.composition.aspectRatio || data.bible.aspectRatio,
          notes,
        },
        spatial: {
          ...base.spatial,
          locationId: s.locationKey ? (locId.get(s.locationKey) ?? scene.locationId) : scene.locationId,
        },
        // keep a Character's existing Look / performance notes when the replaced Shot already had them
        characters: characterIds.map(
          (cid) =>
            base.characters.find((c) => c.characterId === cid) ?? {
              characterId: cid,
              lookId: null,
              performanceNotes: "",
              expression: "",
              posture: "",
              gestures: "",
              physicalInteractions: "",
            },
        ),
        continuity: { ...base.continuity, characterCount: characterIds.length },
        audio: { ...base.audio, dialogueLineIds: dialogueIds },
        scriptSources: { actionBlockIds: actionIds, dialogueLineIds: dialogueIds },
        updatedAt: now,
      });
    if (item.decision.kind === "replace") {
      const target = existing.find((x) => x.id === (item.decision as { shotId: string }).shotId);
      if (target) update.push(planned(target));
      continue;
    }
    const base = emptyShot({
      id: derivedId(args.proposalId, `shot:${item.id}`),
      projectId: data.project.id,
      episodeId: scene.episodeId,
      sceneId: scene.id,
      shotCode: codes.get(item.id)!,
      title: s.title.trim().slice(0, 80) || "Untitled shot",
      order: nextOrder + appended++,
    });
    create.push(
      planned({
        ...base,
        composition: { ...base.composition, aspectRatio: data.bible.aspectRatio },
        createdAt: now,
      }),
    );
  }
  return {
    errors,
    create,
    update,
    summary: {
      created: create.length,
      replaced: update.length,
      skipped: review.items.length - included.length,
    },
  };
}

/** The review to show / apply: the saved one, else the parent's carried forward, else the default. */
export function reviewOfShotList(
  rec: { plan: ShotPlan | null; review: ShotListReview | null; scope: { kind: string; key?: string } },
  parent: { review: ShotListReview | null } | null,
): ShotListReview | null {
  if (!rec.plan) return null;
  if (rec.review) return rec.review;
  // only a one-Shot regeneration keeps the creator's choices: a full re-plan may reuse keys for different Shots
  if (parent?.review && rec.scope.kind === "shot")
    return carryShotReview(rec.plan, parent.review, rec.scope.key ?? null);
  return defaultShotReview(rec.plan);
}
