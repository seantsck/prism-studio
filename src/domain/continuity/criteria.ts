import type { GenerationPackage } from "../generation-package";
import type { GenerationAdaptationPlan } from "../framing/adaptation";
import { characterImages } from "../generation/compatibility";
import { isAnimationAttempt } from "../generation/schemas";
import { fingerprint } from "../hash";
import type { ContinuityCriterion, ReferenceItem, ReferenceSet } from "./model";

/**
 * Phase 3A.1: the canonical visual truth an attempt was GENERATED FROM, read by value from its frozen package. A Shot
 * fidelity criterion judges the output against exactly this, never against whatever is selected today: a later
 * selection makes the QA stale (see `buildReferenceSet`), it never rewrites what the attempt was asked to do.
 */
export interface FrozenShotTruth {
  productionFrame: { frameId: string; assetId: string; version: number; checksum: string | null } | null;
  locationView: {
    viewId: string;
    name: string;
    assetId: string;
    checksum: string | null;
    /** The viewpoint in words, from the frozen viewSpec (may be empty). */
    viewpoint: string;
  } | null;
  /** Animate Production Frame (2H): the Production Frame was the exact first frame supplied to the video model. */
  animation: boolean;
}

export const NO_FROZEN_TRUTH: FrozenShotTruth = {
  productionFrame: null,
  locationView: null,
  animation: false,
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/** Reads the frozen truth from an attempt. Older packages (before v3 / v4) simply have none: nothing is invented. */
export function frozenShotTruth(attempt: {
  packageSnapshot: unknown;
  request?: Record<string, unknown> | null;
}): FrozenShotTruth {
  const snap = (attempt.packageSnapshot ?? null) as {
    references?: { productionFrame?: Record<string, unknown>; locationView?: Record<string, unknown> };
    assets?: Record<string, { checksum?: unknown }>;
  } | null;
  const pf = snap?.references?.productionFrame;
  const pfAsset = str(pf?.assetId);
  const pfId = str(pf?.frameId);
  const lv = snap?.references?.locationView;
  const lvAsset = str(lv?.assetId);
  const lvId = str(lv?.viewId);
  const spec = (lv?.viewSpec ?? {}) as Record<string, unknown>;
  const viewpoint = [spec.viewpointDescription, spec.orientation, spec.geographyNotes]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .join("; ");
  return {
    productionFrame:
      pf && pfAsset && pfId
        ? {
            frameId: pfId,
            assetId: pfAsset,
            version: typeof pf.version === "number" ? pf.version : 0,
            checksum: str(snap?.assets?.[pfAsset]?.checksum),
          }
        : null,
    locationView:
      lv && lvAsset && lvId
        ? {
            viewId: lvId,
            name: str(lv.name) ?? "Location View",
            assetId: lvAsset,
            checksum: str(lv.assetChecksum) ?? str(snap?.assets?.[lvAsset]?.checksum),
            viewpoint,
          }
        : null,
    animation: isAnimationAttempt({ request: attempt.request ?? null }),
  };
}

/**
 * Criteria are derived ONLY from production truth (the GenerationPackage built from the shot, its Looks, its
 * location, its continuity notes, its protected-composition notes). An analyzer is never asked to infer what
 * "correct" is: each criterion carries the expected value and where it came from.
 */
export interface CriteriaContext {
  pkg: GenerationPackage;
  /** The attempt's frozen adaptation plan (null for attempts created before Phase 2C). */
  adaptation: GenerationAdaptationPlan | null;
  /** Manual protected-composition notes for the shot (production intent about the final frame). */
  protectedComposition: string[];
  /** Optional explicit production delivery size from the project bible. */
  deliverySize: { width: number; height: number } | null;
  /** Phase 3A.1: what the attempt was generated from (absent: no Shot fidelity criteria, as before 3A.1). */
  frozen?: FrozenShotTruth;
}

const clean = (s: string | null | undefined) => (s ?? "").trim();

const secs = (ms: number) => `${Number((ms / 1000).toFixed(3))}s`;

/** Deterministic, ordered list of everything this shot's output should be checked against. */
export function buildCriteria(ctx: CriteriaContext): ContinuityCriterion[] {
  const { pkg } = ctx;
  const out: Omit<ContinuityCriterion, "position">[] = [];
  const add = (c: Omit<ContinuityCriterion, "position">) => out.push(c);

  // ── deterministic: technical facts of the delivered media ──
  add({
    key: "output",
    category: "other",
    severity: "critical",
    title: "Output file present",
    sourceRef: "Generation output",
    expected: "A readable picture file",
    handler: "deterministic",
    capability: null,
  });
  if (pkg.timing.durationMs > 0) {
    add({
      key: "duration",
      category: "duration",
      severity: "major",
      title: "Duration",
      sourceRef: `Shot timing (${pkg.timing.source})`,
      expected: secs(pkg.timing.durationMs),
      handler: "deterministic",
      capability: null,
    });
  }
  if (pkg.style.aspectRatio) {
    add({
      key: "aspect_ratio",
      category: "composition",
      severity: "major",
      title: "Aspect ratio",
      sourceRef: "Production format",
      expected: pkg.style.aspectRatio,
      handler: "deterministic",
      capability: null,
    });
  }
  add({
    key: "resolution",
    category: "composition",
    severity: "minor",
    title: "Resolution",
    sourceRef: "Production format",
    expected: ctx.deliverySize ? `${ctx.deliverySize.width}×${ctx.deliverySize.height}` : "not specified",
    handler: "deterministic",
    capability: null,
  });
  add({
    key: "fps",
    category: "other",
    severity: "minor",
    title: "Frame rate",
    sourceRef: "Shot generation settings",
    expected: pkg.generation.fps ? `${pkg.generation.fps} fps` : "not specified",
    handler: "deterministic",
    capability: null,
  });
  add({
    key: "container",
    category: "other",
    severity: "minor",
    title: "Container / codec",
    sourceRef: "Delivery requirements",
    expected: "A browser-playable container (MP4/WebM) with a standard video codec",
    handler: "deterministic",
    capability: null,
  });
  const performedAudio = pkg.performance.some((p) => p.selectedTake?.audioAssetId);
  add({
    key: "audio_stream",
    category: "audio",
    severity: "minor",
    title: "Audio stream",
    sourceRef: performedAudio ? "Selected performance takes" : "Shot audio",
    expected: performedAudio ? "Audio stream present (performed dialogue)" : "No audio required",
    handler: "deterministic",
    capability: null,
  });
  if (ctx.adaptation?.conform.required) {
    add({
      key: "delivery_master",
      category: "composition",
      severity: "major",
      title: "Conformed delivery master",
      sourceRef: "Generation adaptation plan",
      expected: "Delivery master conformed to the production frame",
      handler: "deterministic",
      capability: null,
    });
  }

  // ── Shot fidelity (3A.1): the canonical stills this attempt was generated FROM, by value from its frozen package ──
  const frozen = ctx.frozen ?? NO_FROZEN_TRUTH;
  if (frozen.productionFrame) {
    const v = frozen.productionFrame.version;
    add(
      frozen.animation
        ? {
            key: "production_frame",
            category: "composition",
            severity: "critical",
            title: `Opening image — Production Frame v${v}`,
            sourceRef: `Production Frame v${v} (the exact first frame of this attempt, frozen in its package)`,
            expected: `The opening image preserves Production Frame v${v}: same characters, wardrobe, set, framing and composition; motion begins from it`,
            handler: "analyzer",
            capability: "composition",
            referenceRoles: ["production_frame"],
          }
        : {
            key: "production_frame",
            category: "composition",
            severity: "major",
            title: `Production Frame v${v} fidelity`,
            sourceRef: `Production Frame v${v} (frozen in this attempt's package)`,
            expected: `Preserves the canonical visual intent of Production Frame v${v}: characters, wardrobe, set, framing and composition`,
            handler: "analyzer",
            capability: "composition",
            referenceRoles: ["production_frame"],
          },
    );
  }
  if (frozen.locationView) {
    const lv = frozen.locationView;
    add({
      key: "location_view",
      category: "location_set",
      severity: pkg.set?.locked ? "critical" : "major",
      title: `Location View — ${lv.name}`,
      sourceRef: `Location View "${lv.name}" (frozen in this attempt's package)`,
      expected: `Recognisably the place and viewpoint of Location View "${lv.name}"${lv.viewpoint ? ` (${lv.viewpoint})` : ""}; the environment is not reinvented`,
      handler: "analyzer",
      capability: "scene_match",
      referenceRoles: ["location_view"],
    });
  }

  // ── semantic: characters ──
  // Phase 2G.4: a locked assignment's entry IS its Character Continuity Lock's frozen appearance (the package is built
  // from it), so these criteria judge against the Lock; the source names it so a reviewer knows which basis applies.
  for (const c of pkg.characters) {
    const lock = c.continuityLock ? ` · Character Continuity Lock "${c.continuityLock.name}"` : "";
    add({
      key: `identity:${c.characterId}`,
      category: "identity",
      severity: "critical",
      title: `${c.name} — identity`,
      sourceRef: `Character identity references (${c.identityReferenceAssetIds.length})${lock}`,
      expected: clean(c.physicalDescription) || `Matches ${c.name}'s identity references`,
      handler: "analyzer",
      capability: "image_identity",
    });
    if (c.look) {
      const ref = `Look "${c.look.name}"${c.look.locked ? " (locked)" : ""}${lock}`;
      add({
        key: `wardrobe:${c.characterId}`,
        category: "wardrobe",
        severity: c.look.locked ? "critical" : "major",
        title: `${c.name} — wardrobe`,
        sourceRef: ref,
        expected: clean(c.look.wardrobe) || c.look.name,
        handler: "analyzer",
        capability: "wardrobe",
      });
      for (const [field, category, label] of [
        ["hair", "hair", "hair"],
        ["makeup", "makeup", "makeup"],
        ["jewelry", "jewelry", "jewelry"],
      ] as const) {
        const v = clean(c.look[field]);
        if (!v) continue;
        add({
          key: `${field}:${c.characterId}`,
          category,
          severity: "minor",
          title: `${c.name} — ${label}`,
          sourceRef: ref,
          expected: v,
          handler: "analyzer",
          capability: "wardrobe",
        });
      }
    }
  }
  if (pkg.continuity.characterCount != null) {
    add({
      key: "character_count",
      category: "character_count",
      severity: "major",
      title: "Visible character count",
      sourceRef: "Shot continuity",
      expected: String(pkg.continuity.characterCount),
      handler: "analyzer",
      capability: "character_count",
    });
  }

  // ── semantic: set, props, light ──
  if (pkg.set) {
    add({
      key: "location_set",
      category: "location_set",
      severity: pkg.set.locked ? "critical" : "major",
      title: `Set — ${pkg.set.name}`,
      sourceRef: `Location${pkg.set.locked ? " (locked)" : ""}`,
      expected: clean(pkg.set.description) || pkg.set.name,
      handler: "analyzer",
      capability: "scene_match",
    });
  }
  for (const p of pkg.props) {
    add({
      key: `prop:${p.id}`,
      category: "props",
      severity: "minor",
      title: `Prop — ${p.name}`,
      sourceRef: "Shot props",
      expected: clean(p.description) || p.name,
      handler: "analyzer",
      capability: "object_presence",
    });
  }
  const lightingExpected = [pkg.lighting.mood, pkg.lighting.keyDirection, pkg.lighting.colorTemperature]
    .map(clean)
    .filter(Boolean)
    .join("; ");
  if (lightingExpected) {
    add({
      key: "lighting",
      category: "lighting",
      severity: "minor",
      title: "Lighting",
      sourceRef: "Shot lighting",
      expected: lightingExpected,
      handler: "analyzer",
      capability: "lighting",
    });
  }
  if (clean(pkg.continuity.weather)) {
    add({
      key: "weather",
      category: "weather",
      severity: "minor",
      title: "Weather",
      sourceRef: "Shot continuity",
      expected: clean(pkg.continuity.weather),
      handler: "analyzer",
      capability: "scene_match",
    });
  }
  if (clean(pkg.continuity.timeOfDay)) {
    add({
      key: "time_of_day",
      category: "time_of_day",
      severity: "minor",
      title: "Time of day",
      sourceRef: "Shot continuity",
      expected: clean(pkg.continuity.timeOfDay),
      handler: "analyzer",
      capability: "lighting",
    });
  }

  // ── camera (3A.1): stills can judge shot size / framing; only temporal analysis can judge movement ──
  // (2c.1 runs froze one combined `camera` criterion judged from stills; they stay readable exactly as recorded.)
  const cam = pkg.camera;
  const framing = [cam.shotSize, cam.framing].map(clean).filter(Boolean).join(", ");
  if (framing) {
    add({
      key: "camera_framing",
      category: "camera",
      severity: "minor",
      title: "Camera framing",
      sourceRef: "Shot camera setup",
      expected: framing,
      handler: "analyzer",
      capability: "composition",
    });
  }
  if (clean(cam.movement)) {
    add({
      key: "camera_movement",
      category: "camera",
      severity: "minor",
      title: "Camera movement",
      sourceRef: "Shot camera setup",
      expected: clean(cam.movement),
      handler: "analyzer",
      capability: "video_temporal",
    });
  }
  const staging: Array<[string, "screen_direction" | "eyelines" | "geography", string, string]> = [
    ["screen_direction", "screen_direction", "Screen direction", pkg.blocking.screenDirection],
    ["eyelines", "eyelines", "Eyelines", pkg.blocking.eyelines],
    ["geography", "geography", "Geography", pkg.continuity.geography],
  ];
  for (const [key, category, title, value] of staging) {
    if (!clean(value)) continue;
    add({
      key,
      category,
      severity: "major",
      title,
      sourceRef: key === "geography" ? "Shot continuity" : "Shot blocking",
      expected: clean(value),
      handler: "analyzer",
      capability: "video_temporal",
    });
  }
  if (pkg.timing.beats.length > 0) {
    add({
      key: "action_continuity",
      category: "action_continuity",
      severity: "major",
      title: "Action beats",
      sourceRef: "Shot action beats",
      expected: pkg.timing.beats.map((b) => `${secs(b.atMs)} ${b.description}`).join("; "),
      handler: "analyzer",
      capability: "video_temporal",
    });
  }
  if (performedAudio) {
    add({
      key: "lip_sync",
      category: "lip_sync",
      severity: "minor",
      title: "Lip sync",
      sourceRef: "Selected performance takes",
      expected: "Mouth movement matches the performed dialogue",
      handler: "analyzer",
      capability: "lip_sync",
    });
  }

  // ── composition: the framing the production designed, including what must survive a crop ──
  ctx.protectedComposition
    .map(clean)
    .filter(Boolean)
    .forEach((note, i) => {
      add({
        key: `protected:${i}`,
        category: "composition",
        severity: "major",
        title: `Protected composition ${i + 1}`,
        sourceRef: "Shot protected composition notes",
        expected: note,
        handler: "manual",
        capability: "composition",
      });
    });

  // ── hard constraints the filmmaker wrote down ──
  pkg.constraints.hard.forEach((c, i) => {
    if (!clean(c)) return;
    add({
      key: `constraint:${i}`,
      category: "other",
      severity: "major",
      title: `Constraint ${i + 1}`,
      sourceRef: "Shot hard constraints",
      expected: clean(c),
      handler: "manual",
      capability: null,
    });
  });
  // 3A.1: an object's absence is an object-presence question an image analyzer can answer; an action needs temporal
  // analysis (unchecked until that is enabled); a forbidden PERSON has no reference to judge against: a person decides.
  const constraintRouting = {
    forbiddenObjects: { category: "props", handler: "analyzer", capability: "object_presence" },
    forbiddenPeople: { category: "other", handler: "manual", capability: null },
    forbiddenActions: { category: "action_continuity", handler: "analyzer", capability: "video_temporal" },
  } as const;
  for (const group of ["forbiddenObjects", "forbiddenPeople", "forbiddenActions"] as const) {
    pkg.constraints[group].forEach((c, i) => {
      if (!clean(c)) return;
      add({
        key: `${group}:${i}`,
        severity: "major",
        title: `Must not appear: ${clean(c)}`,
        sourceRef: "Shot constraints",
        expected: `Absent: ${clean(c)}`,
        ...constraintRouting[group],
      });
    });
  }

  return out.map((c, position) => ({ ...c, position }));
}

/** Fingerprint of what is expected: a changed Look/set/continuity note changes it (the run goes stale). */
export function criteriaFingerprint(criteria: ContinuityCriterion[]): string {
  return fingerprint(
    criteria.map((c) =>
      // routing joins only when set, so a criterion without it keeps its 2c.1 fingerprint contribution
      c.referenceRoles
        ? [c.key, c.category, c.severity, c.expected, c.sourceRef, c.handler, c.capability, c.referenceRoles]
        : [c.key, c.category, c.severity, c.expected, c.sourceRef, c.handler, c.capability],
    ),
  );
}

export interface ReferenceExtras {
  /** Output asset of the previous shot's approved attempt, when there is one. */
  previousShotOutput: { assetId: string; checksum: string | null; label: string } | null;
  /** Next shot's approved storyboard frame, for lead-out continuity. */
  nextShotStoryboard: { assetId: string; checksum: string | null; label: string } | null;
}

/** The exact references a QA run is judged against. Frozen on the run, never recomputed in place. */
export function buildReferenceSet(
  pkg: GenerationPackage,
  adaptation: GenerationAdaptationPlan | null,
  extras: ReferenceExtras = { previousShotOutput: null, nextShotStoryboard: null },
  frozen: FrozenShotTruth = NO_FROZEN_TRUTH,
): ReferenceSet {
  const items: ReferenceItem[] = [];
  const seen = new Set<string>();
  const asset = (role: string, label: string, assetId: string | null | undefined) => {
    if (!assetId) return;
    const key = `${role}:${assetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ role, label, assetId, checksum: pkg.assets[assetId]?.checksum ?? null, text: null });
  };

  // identity / Look images: a locked assignment's come from its frozen Continuity Lock (never today's library)
  for (const c of pkg.characters) {
    const images = characterImages(pkg, c);
    for (const i of images.identity) asset("identity", i.label, i.assetId);
    for (const i of images.look) asset("look", i.label, i.assetId);
  }
  // Phase 2H: the canonical still the Shot's video must hold to (the selected Production Frame, when one exists) and the
  // Shot's canonical Location View, each as its own role so a reviewer never mistakes either for a Storyboard sketch
  // 3A.1: when the attempt was generated from a Production Frame / Location View, THAT frozen image is the reference
  // (exact checksum from the attempt's package), never today's selection; otherwise the current one, as before
  const pf = pkg.references.productionFrame;
  const fpf = frozen.productionFrame;
  if (fpf) {
    seen.add(`production_frame:${fpf.assetId}`);
    items.push({
      role: "production_frame",
      label: `Production Frame v${fpf.version}${frozen.animation ? " (exact first frame)" : ""}`,
      assetId: fpf.assetId,
      checksum: fpf.checksum,
      text: null,
    });
  } else if (pf) asset("production_frame", `Production Frame v${pf.version}`, pf.assetId);
  asset("storyboard", "Approved storyboard frame", pkg.references.approvedStoryboardFrame?.assetId);
  const view = pkg.references.locationView;
  const fview = frozen.locationView;
  if (fview) {
    seen.add(`location_view:${fview.assetId}`);
    items.push({
      role: "location_view",
      label: `Location View "${fview.name}"`,
      assetId: fview.assetId,
      checksum: fview.checksum,
      text: null,
    });
  } else if (view) asset("location_view", `Location View "${view.name}"`, view.assetId);
  for (const id of pkg.set?.referenceAssetIds ?? [])
    asset("location", `${pkg.set?.name ?? "Set"} reference`, id);
  asset("lighting", "Lighting reference", pkg.lighting.referenceAssetId);
  for (const id of pkg.references.referenceAssetIds) asset("reference", "Shot reference", id);
  if (extras.previousShotOutput) {
    items.push({
      role: "previous_shot",
      label: extras.previousShotOutput.label,
      assetId: extras.previousShotOutput.assetId,
      checksum: extras.previousShotOutput.checksum,
      text: null,
    });
  }
  if (extras.nextShotStoryboard) {
    items.push({
      role: "next_shot",
      label: extras.nextShotStoryboard.label,
      assetId: extras.nextShotStoryboard.assetId,
      checksum: extras.nextShotStoryboard.checksum,
      text: null,
    });
  }
  for (const p of pkg.performance) {
    if (p.selectedTake?.audioAssetId) {
      asset(
        "performance",
        `${p.speaker} performance take ${p.selectedTake.takeNumber}`,
        p.selectedTake.audioAssetId,
      );
    }
  }
  const constraints = [...pkg.constraints.hard, ...pkg.constraints.guardrails].map(clean).filter(Boolean);
  if (constraints.length > 0) {
    items.push({
      role: "constraint",
      label: "Production constraints",
      assetId: null,
      checksum: null,
      text: constraints.join("\n"),
    });
  }
  // 3A.1: the Shot moved on from the frozen truth this attempt was made from. Present only while it differs, so the
  // reference fingerprint changes (the QA goes stale) the moment another frame / view is selected.
  const moved: string[] = [];
  if (fpf && pf?.frameId !== fpf.frameId)
    moved.push(
      pf
        ? `The Shot now selects Production Frame v${pf.version}; this output was generated from v${fpf.version}.`
        : `The Shot no longer selects a Production Frame; this output was generated from v${fpf.version}.`,
    );
  if (fview && view?.viewId !== fview.viewId)
    moved.push(
      view
        ? `The Shot now selects Location View "${view.name}"; this output was generated from "${fview.name}".`
        : `The Shot no longer selects a Location View; this output was generated from "${fview.name}".`,
    );
  if (moved.length > 0) {
    items.push({
      role: "selection_change",
      label: "Canonical selection changed since generation",
      assetId: null,
      checksum: null,
      text: moved.join("\n"),
    });
  }
  if (adaptation && adaptation.status !== "native") {
    items.push({
      role: "framing",
      label: "Delivery framing",
      assetId: null,
      checksum: null,
      text: `plan ${adaptation.fingerprint.slice(0, 12)}: ${adaptation.framing.strategy}${adaptation.framing.productionLabel ? ` → ${adaptation.framing.productionLabel}` : ""}`,
    });
  }
  return {
    items,
    fingerprint: fingerprint(items.map((i) => [i.role, i.assetId, i.checksum, i.text])),
  };
}
