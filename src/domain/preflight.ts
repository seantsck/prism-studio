import type { ShotContext } from "./context";
import { storyboardFreshness } from "./fingerprint";
import { validateLookLink } from "./looks";
import { productionFrameFreshness } from "./production-frame";

/**
 * Deterministic shot preflight. No AI: every rule is a pure function of ShotContext.
 * Rules are data (see PREFLIGHT_RULES) so that AI continuity checks can later be appended
 * as additional rule sources without changing the evaluator.
 */

export const PREFLIGHT_SECTIONS = [
  "story",
  "performance",
  "character",
  "set",
  "camera",
  "blocking",
  "continuity",
  "audio",
  "storyboard",
  /** Phase 2G.1: only judged when the Shot has a SELECTED Production Frame; never requires 3D */
  "production_frame",
  "generation",
] as const;
export type PreflightSection = (typeof PREFLIGHT_SECTIONS)[number];

export type PreflightStatus = "pass" | "fail" | "warn" | "na";

export interface RuleOutcome {
  status: PreflightStatus;
  /** Message override; otherwise the rule's pass/fail label is used. */
  detail?: string;
}

export interface PreflightRule {
  id: string;
  section: PreflightSection;
  /** "required" failures block generation; "recommended" failures only warn. */
  severity: "required" | "recommended";
  label: string;
  evaluate(ctx: ShotContext): RuleOutcome;
}

export interface PreflightItem {
  ruleId: string;
  section: PreflightSection;
  severity: "required" | "recommended";
  status: PreflightStatus;
  label: string;
  detail?: string;
}

export interface PreflightReport {
  shotId: string;
  shotCode: string;
  title: string;
  items: PreflightItem[];
  /** 0–100, share of applicable rules satisfied (recommended rules count half). */
  score: number;
  ready: boolean;
  blockers: PreflightItem[];
  warnings: PreflightItem[];
}

const filled = (s: string | null | undefined) => Boolean(s && s.trim().length > 0);
const pass = (detail?: string): RuleOutcome => ({ status: "pass", detail });
const fail = (detail?: string): RuleOutcome => ({ status: "fail", detail });
const warn = (detail?: string): RuleOutcome => ({ status: "warn", detail });
const na = (detail?: string): RuleOutcome => ({ status: "na", detail });
const check = (ok: boolean, detail?: string) => (ok ? pass() : fail(detail));
const hasDialogue = (c: ShotContext) => c.lines.length > 0;
const hasCharacters = (c: ShotContext) => c.characters.length > 0;

export const PREFLIGHT_RULES: PreflightRule[] = [
  // Story
  {
    id: "story.beat",
    section: "story",
    severity: "required",
    label: "Story beat defined",
    evaluate: (c) => check(filled(c.shot.storyBeat), "Story beat is empty"),
  },
  {
    id: "story.purpose",
    section: "story",
    severity: "recommended",
    label: "Dramatic purpose defined",
    evaluate: (c) => (filled(c.shot.dramaticPurpose) ? pass() : warn("No dramatic purpose")),
  },
  {
    id: "story.duration",
    section: "story",
    severity: "required",
    label: "Duration defined",
    evaluate: (c) =>
      c.duration.durationMs > 0
        ? pass(c.duration.source === "performance" ? "Derived from selected performance" : undefined)
        : fail("No target duration"),
  },
  // Performance
  {
    id: "performance.takes",
    section: "performance",
    severity: "required",
    label: "Selected take for every dialogue line",
    evaluate: (c) => {
      if (!hasDialogue(c)) return na("No dialogue required");
      const missing = c.lines.filter((l) => !l.selectedTake);
      return missing.length === 0 ? pass() : fail(`${missing.length} line(s) have no selected take`);
    },
  },
  {
    id: "performance.locked_text",
    section: "performance",
    severity: "recommended",
    label: "Dialogue text locked",
    evaluate: (c) => {
      if (!hasDialogue(c)) return na("No dialogue required");
      return c.lines.every((l) => l.line.locked) ? pass() : warn("Some dialogue is not locked");
    },
  },
  {
    id: "performance.direction",
    section: "performance",
    severity: "recommended",
    label: "Performance direction written",
    evaluate: (c) => {
      if (!hasDialogue(c)) return na();
      return c.lines.every((l) => l.direction && filled(l.direction.emotion))
        ? pass()
        : warn("Missing direction");
    },
  },
  // Character
  {
    id: "character.assigned",
    section: "character",
    severity: "required",
    label: "Characters assigned",
    evaluate: (c) => {
      if (hasCharacters(c)) return pass();
      // An explicit character count of 0 means an intentionally empty frame (e.g. establishing shot).
      return c.shot.continuity.characterCount === 0
        ? na("No characters (explicit)")
        : fail("No characters assigned");
    },
  },
  {
    id: "character.look_assigned",
    section: "character",
    severity: "required",
    label: "Every character has a Look",
    evaluate: (c) => {
      if (!hasCharacters(c)) return na();
      const bad = c.characters.filter((x) => !x.look);
      return bad.length === 0
        ? pass()
        : fail(`No Look for ${bad.map((x) => x.character?.name ?? "?").join(", ")}`);
    },
  },
  {
    id: "character.look_valid",
    section: "character",
    severity: "required",
    label: "Looks match their characters",
    evaluate: (c) => {
      if (!hasCharacters(c)) return na();
      const looks = c.characters.flatMap((x) => (x.look ? [x.look] : []));
      for (const x of c.characters) {
        const err = validateLookLink(x.assignment, looks, c.shot.episodeId);
        if (err) return fail(err.message);
      }
      return pass();
    },
  },
  {
    id: "character.look_locked",
    section: "character",
    severity: "required",
    label: "Looks locked",
    evaluate: (c) => {
      const withLooks = c.characters.filter((x) => x.look);
      if (withLooks.length === 0) return na();
      // a selected Character Continuity Lock IS a locked appearance (Phase 2G.4)
      const open = withLooks.filter((x) => !x.look?.locked && !x.continuityLock);
      return open.length === 0 ? pass() : fail(`Unlocked: ${open.map((x) => x.look?.name).join(", ")}`);
    },
  },
  {
    id: "character.identity",
    section: "character",
    severity: "recommended",
    label: "Identity references available",
    evaluate: (c) => {
      if (!hasCharacters(c)) return na();
      // the AUTHORITATIVE identity images: a selected Continuity Lock's frozen ones, else the live library's
      const bad = c.characters.filter((x) => x.appearance.identityReferenceAssetIds.length === 0);
      return bad.length === 0
        ? pass()
        : warn(`No identity images for ${bad.map((x) => x.character?.name).join(", ")}`);
    },
  },
  // Character Continuity Lock (Phase 2G.4). Not applicable until one is selected: no Lock is never a blocker. A stored
  // selection that does not match its assignment's Character / Look (or whose Character is no longer assigned) is a
  // data-integrity problem: generation is blocked rather than silently using another appearance.
  {
    id: "character.continuity_lock",
    section: "character",
    severity: "required",
    label: "Selected Character Continuity Locks match their assignments",
    evaluate: (c) => {
      const issues = [
        ...c.characters.flatMap((x) => (x.continuityLockIssue ? [x.continuityLockIssue] : [])),
        ...(c.continuityLockOrphans ?? []),
      ];
      if (issues.length > 0) return fail(issues[0]!.message);
      const locked = c.characters.filter((x) => x.continuityLock);
      return locked.length > 0
        ? pass(locked.map((x) => `${x.appearance.name}: ${x.continuityLock!.name}`).join(" · "))
        : na("No Character Continuity Lock selected");
    },
  },
  // Set
  {
    id: "set.location",
    section: "set",
    severity: "required",
    label: "Location assigned",
    evaluate: (c) => check(Boolean(c.location), "No location"),
  },
  {
    id: "set.locked",
    section: "set",
    severity: "required",
    label: "Location locked",
    evaluate: (c) => (!c.location ? na() : check(c.location.locked, `"${c.location.name}" is not locked`)),
  },
  {
    id: "set.zone",
    section: "set",
    severity: "recommended",
    label: "Set zone specified",
    evaluate: (c) => (filled(c.shot.spatial.setZone) ? pass() : warn("No set zone")),
  },
  // Camera
  {
    id: "camera.core",
    section: "camera",
    severity: "required",
    label: "Camera specified (framing, size, movement)",
    evaluate: (c) => {
      const m = c.shot.composition;
      const missing = [
        ["framing", m.framing],
        ["shot size", m.shotSize],
        ["movement", m.movement],
      ].filter(([, v]) => !filled(v));
      return missing.length === 0 ? pass() : fail(`Missing ${missing.map(([k]) => k).join(", ")}`);
    },
  },
  {
    id: "camera.lens",
    section: "camera",
    severity: "recommended",
    label: "Lens specified",
    evaluate: (c) => (filled(c.shot.composition.lens) ? pass() : warn("No lens")),
  },
  // Blocking
  {
    id: "blocking.specified",
    section: "blocking",
    severity: "required",
    label: "Blocking specified",
    evaluate: (c) => {
      if (!hasCharacters(c)) return na();
      const s = c.shot.spatial;
      return filled(s.subjectBlocking) || s.marks.length > 0 ? pass() : fail("No blocking");
    },
  },
  {
    id: "blocking.eyelines",
    section: "blocking",
    severity: "recommended",
    label: "Eyelines / screen direction specified",
    evaluate: (c) => {
      if (!hasCharacters(c)) return na();
      const s = c.shot.spatial;
      return filled(s.eyelines) && filled(s.screenDirection)
        ? pass()
        : warn("Eyelines or screen direction missing");
    },
  },
  // Continuity
  {
    id: "continuity.previous",
    section: "continuity",
    severity: "required",
    label: "Previous shot linked",
    evaluate: (c) => {
      if (c.isFirstInEpisode) return na("First shot of the episode");
      return check(Boolean(c.previousShot), "No previous shot linked");
    },
  },
  {
    id: "continuity.weather",
    section: "continuity",
    severity: "required",
    label: "Weather specified",
    evaluate: (c) => check(filled(c.shot.continuity.weather), "Weather not specified"),
  },
  {
    id: "continuity.time_of_day",
    section: "continuity",
    severity: "required",
    label: "Time of day specified",
    evaluate: (c) =>
      check(filled(c.shot.continuity.timeOfDay) || filled(c.scene.timeOfDay), "Time of day not specified"),
  },
  {
    id: "continuity.character_count",
    section: "continuity",
    severity: "required",
    label: "Named character count declared and consistent",
    evaluate: (c) => {
      const declared = c.shot.continuity.characterCount;
      if (declared == null) return fail("Character count not declared");
      return declared === c.characters.length
        ? pass()
        : fail(`Declared ${declared} but ${c.characters.length} assigned`);
    },
  },
  {
    id: "continuity.vehicle",
    section: "continuity",
    severity: "required",
    label: "Vehicle orientation specified",
    evaluate: (c) => {
      if (!c.shot.continuity.vehicleInPlay) return na("No vehicle in shot");
      return check(filled(c.shot.continuity.vehicleOrientation), "Vehicle orientation / door side missing");
    },
  },
  {
    id: "continuity.wardrobe",
    section: "continuity",
    severity: "recommended",
    label: "Wardrobe continuity noted",
    evaluate: (c) => {
      if (!hasCharacters(c)) return na();
      return c.characters.every((x) => x.look?.locked) || filled(c.shot.continuity.wardrobe)
        ? pass("Covered by locked Look")
        : warn("No wardrobe continuity");
    },
  },
  // Audio
  {
    id: "audio.ambience",
    section: "audio",
    severity: "recommended",
    label: "Ambience / sound intent noted",
    evaluate: (c) =>
      filled(c.shot.audio.ambience) || filled(c.shot.audio.silenceRequirements)
        ? pass()
        : warn("No ambience noted"),
  },
  // Storyboard
  {
    id: "storyboard.frame",
    section: "storyboard",
    severity: "required",
    label: "Storyboard frame present",
    evaluate: (c) => check(c.frames.length > 0, "Storyboard frame missing"),
  },
  {
    id: "storyboard.approved",
    section: "storyboard",
    severity: "required",
    label: "Storyboard approved",
    evaluate: (c) => {
      if (c.frames.length === 0) return na("No frame to approve");
      return check(Boolean(c.approvedFrame) && c.shot.approval.storyboardApproved, "Storyboard not approved");
    },
  },
  {
    id: "storyboard.fresh",
    section: "storyboard",
    severity: "recommended",
    label: "Approved storyboard matches the current shot",
    evaluate: (c) => {
      if (!c.approvedFrame) return na("No approved frame");
      const f = storyboardFreshness(c, c.approvedFrame);
      if (f.status === "stale") return warn(f.messages.join(" "));
      if (f.status === "unknown") return warn(f.messages.join(" "));
      return f.timingChange ? warn(f.messages.join(" ")) : pass();
    },
  },
  // Location View (Phase 2G.3). Optional: no selection is never a blocker. A stored selection that does not resolve to a
  // view of the Shot's CURRENT Location is a data-integrity problem: generation is blocked rather than sending it.
  {
    id: "set.location_view",
    section: "set",
    severity: "required",
    label: "Selected Location View belongs to the Shot's Location",
    evaluate: (c) => {
      if (c.locationViewIssue) return fail(c.locationViewIssue.message);
      return c.selectedLocationView ? pass() : na("No Location View selected");
    },
  },
  // Production Frame (Phase 2G.1). Not applicable until one is selected: existing Shots keep the storyboard path.
  {
    id: "production_frame.fresh",
    section: "production_frame",
    severity: "required",
    label: "Selected Production Frame matches the current shot",
    evaluate: (c) => {
      const f = c.selectedProductionFrame;
      if (!f) return na("No Production Frame selected");
      const fr = productionFrameFreshness(c, f);
      if (fr.status !== "stale") return pass();
      const why = fr.messages.join(" ");
      // an EXPLICIT start frame wins the start-frame precedence, so the stale selection is not what gets generated
      if (c.shot.generation.startFrameAssetId)
        return warn(`${why} An explicit start frame is set, so it is used instead.`);
      // image-to-video starts FROM this image: a stale one blocks. Other modalities only warn.
      return c.shot.generation.modality === "image_to_video"
        ? fail(`${why} Select or create a current Production Frame, or set an explicit start frame.`)
        : warn(why);
    },
  },
  {
    id: "approval.performance",
    section: "performance",
    severity: "required",
    label: "Performance approved",
    evaluate: (c) => {
      if (!hasDialogue(c)) return na("No dialogue required");
      return check(c.shot.approval.performanceApproved, "Performance not approved");
    },
  },
  {
    id: "approval.continuity",
    section: "continuity",
    severity: "required",
    label: "Continuity approved",
    evaluate: (c) => check(c.shot.approval.continuityApproved, "Continuity not approved"),
  },
  // Generation
  {
    id: "generation.model",
    section: "generation",
    severity: "recommended",
    label: "Generation model chosen",
    evaluate: (c) =>
      filled(c.shot.generation.provider) && filled(c.shot.generation.model)
        ? pass()
        : warn("No approved generation model"),
  },
  {
    id: "generation.guardrails",
    section: "generation",
    severity: "recommended",
    label: "Project guardrails defined",
    evaluate: (c) => (c.bible.guardrails.length > 0 ? pass() : warn("Bible has no generator guardrails")),
  },
];

export function runPreflight(
  ctx: ShotContext,
  rules: readonly PreflightRule[] = PREFLIGHT_RULES,
): PreflightReport {
  const items = rules.map<PreflightItem>((rule) => {
    const outcome = rule.evaluate(ctx);
    // A failing recommended rule is a warning, never a blocker.
    const status: PreflightStatus =
      outcome.status === "fail" && rule.severity === "recommended" ? "warn" : outcome.status;
    return {
      ruleId: rule.id,
      section: rule.section,
      severity: rule.severity,
      status,
      label: rule.label,
      detail: outcome.detail,
    };
  });

  const applicable = items.filter((i) => i.status !== "na");
  const weight = (i: PreflightItem) => (i.severity === "required" ? 1 : 0.5);
  const total = applicable.reduce((s, i) => s + weight(i), 0);
  const earned = applicable.filter((i) => i.status === "pass").reduce((s, i) => s + weight(i), 0);
  const blockers = items.filter((i) => i.status === "fail");

  return {
    shotId: ctx.shot.id,
    shotCode: ctx.shot.shotCode,
    title: ctx.shot.title,
    items,
    score: total === 0 ? 100 : Math.round((earned / total) * 100),
    ready: blockers.length === 0,
    blockers,
    warnings: items.filter((i) => i.status === "warn"),
  };
}

export function itemsBySection(report: PreflightReport, section: PreflightSection): PreflightItem[] {
  return report.items.filter((i) => i.section === section);
}

export const STATUS_GLYPH: Record<PreflightStatus, string> = { pass: "✓", fail: "✕", warn: "⚠", na: "—" };
