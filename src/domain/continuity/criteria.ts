import type { GenerationPackage } from "../generation-package";
import type { GenerationAdaptationPlan } from "../framing/adaptation";
import { fingerprint } from "../hash";
import type { ContinuityCriterion, ReferenceItem, ReferenceSet } from "./model";

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

  // ── semantic: characters ──
  for (const c of pkg.characters) {
    add({
      key: `identity:${c.characterId}`,
      category: "identity",
      severity: "critical",
      title: `${c.name} — identity`,
      sourceRef: `Character identity references (${c.identityReferenceAssetIds.length})`,
      expected: clean(c.physicalDescription) || `Matches ${c.name}'s identity references`,
      handler: "analyzer",
      capability: "image_identity",
    });
    if (c.look) {
      const ref = `Look "${c.look.name}"${c.look.locked ? " (locked)" : ""}`;
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

  // ── camera / staging (judged by people unless an analyzer declares video_temporal) ──
  const cam = pkg.camera;
  const camera = [cam.shotSize, cam.framing, cam.movement].map(clean).filter(Boolean).join(", ");
  if (camera) {
    add({
      key: "camera",
      category: "camera",
      severity: "minor",
      title: "Camera",
      sourceRef: "Shot camera setup",
      expected: camera,
      handler: "analyzer",
      capability: "composition",
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
  for (const group of ["forbiddenObjects", "forbiddenPeople", "forbiddenActions"] as const) {
    pkg.constraints[group].forEach((c, i) => {
      if (!clean(c)) return;
      add({
        key: `${group}:${i}`,
        category: group === "forbiddenObjects" ? "props" : "other",
        severity: "major",
        title: `Must not appear: ${clean(c)}`,
        sourceRef: "Shot constraints",
        expected: `Absent: ${clean(c)}`,
        handler: "manual",
        capability: group === "forbiddenObjects" ? "object_presence" : null,
      });
    });
  }

  return out.map((c, position) => ({ ...c, position }));
}

/** Fingerprint of what is expected: a changed Look/set/continuity note changes it (the run goes stale). */
export function criteriaFingerprint(criteria: ContinuityCriterion[]): string {
  return fingerprint(
    criteria.map((c) => [c.key, c.category, c.severity, c.expected, c.sourceRef, c.handler, c.capability]),
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

  for (const c of pkg.characters) {
    for (const id of c.identityReferenceAssetIds) asset("identity", `${c.name} identity`, id);
    for (const id of c.look?.referenceAssetIds ?? []) {
      asset("look", `${c.name} Look "${c.look?.name}"`, id);
    }
  }
  asset("storyboard", "Approved storyboard frame", pkg.references.approvedStoryboardFrame?.assetId);
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
