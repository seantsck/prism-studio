import type { IgnoredFeature } from "@/domain/generation/compatibility";
import type { PromptPlan, PromptSectionKey } from "@/domain/generation/schemas";
import { RUNWAY_MAX_PROMPT_CHARS } from "./config";

/**
 * PromptPlan → Runway `promptText`. Deterministic and pure.
 *
 * Runway takes ONE free-text field of at most 1,000 characters. The plan is rendered as compact prose in
 * priority order (what happens, then where/how it is shot, then continuity...). Anything that does not fit is
 * reported as an OMISSION: the caller turns it into an acknowledged "ignored feature" so production intent is
 * never dropped silently.
 *
 * Not rendered, by design (each reported in `notes`): negative constraints (Runway has no such field; the
 * compatibility engine already requires acknowledgement), timing (carried by the `duration` parameter) and the
 * spoken dialogue text (Gen-4.5 neither speaks nor lip-syncs performed audio).
 */
const PRIORITY: PromptSectionKey[] = [
  "action",
  "subject",
  "performance",
  "composition",
  "provider_adaptation",
  "camera",
  "environment",
  "lighting",
  "wardrobe",
  "identity",
  "continuity",
  "hard_constraints",
];

const LABEL: Partial<Record<PromptSectionKey, string>> = {
  action: "Action",
  subject: "Subject",
  performance: "Performance",
  composition: "Composition",
  provider_adaptation: "Framing",
  camera: "Camera",
  environment: "Setting",
  lighting: "Lighting",
  wardrobe: "Wardrobe",
  identity: "Appearance",
  continuity: "Continuity",
  hard_constraints: "Must",
};

export interface PromptOmission {
  section: PromptSectionKey;
  label: string;
  omittedLines: number;
  totalLines: number;
}

export interface CompiledPrompt {
  text: string;
  omissions: PromptOmission[];
  notes: string[];
}

/** Dialogue text is not renderable for a model without audio conditioning: keep emotion/objective only. */
function performanceLines(lines: string[]): string[] {
  return lines.filter((l) => !/^[^:]{1,60}: ".*"$/.test(l) && !/^performed take|^no performed take/.test(l));
}

export interface PromptCompileOptions {
  /** Shown in notes (default "Gen-4.5"). */
  modelName?: string;
  /** The model has a separate negative-prompt field (Veo): constraints are sent there, not in the prose. */
  negativeSent?: boolean;
  /** Performed audio is supplied as a reference input. */
  audioReference?: boolean;
}

export function compileRunwayPrompt(
  plan: PromptPlan,
  limit = RUNWAY_MAX_PROMPT_CHARS,
  opts: PromptCompileOptions = {},
): CompiledPrompt {
  const modelName = opts.modelName ?? "Gen-4.5";
  const byKey = new Map(plan.sections.map((s) => [s.key, s] as const));
  const notes: string[] = [];
  const included = new Map<PromptSectionKey, string[]>();
  const omissions: PromptOmission[] = [];
  let used = 0;

  const addCost = (label: string, line: string, first: boolean) =>
    (first ? label.length + 2 : 0) + line.length + 2; // "Label: " + "line" + "; "/". "

  for (const key of PRIORITY) {
    const section = byKey.get(key);
    if (!section) continue;
    const lines = key === "performance" ? performanceLines(section.lines) : section.lines;
    if (key === "performance" && lines.length < section.lines.length) {
      notes.push(
        opts.audioReference
          ? `Spoken dialogue text is not sent; the performed audio is supplied as a reference input to ${modelName}.`
          : `Spoken dialogue text is not sent: ${modelName} has no audio/lip-sync input.`,
      );
    }
    const label = LABEL[key] ?? section.title;
    const kept: string[] = [];
    for (const line of lines) {
      const cost = addCost(label, line, kept.length === 0);
      if (used + cost <= limit) {
        kept.push(line);
        used += cost;
      } else if (used === 0 && kept.length === 0) {
        // The single highest-priority line alone exceeds the limit: cut it, and say so.
        const room = Math.max(0, limit - label.length - 6);
        kept.push(`${line.slice(0, room)}…`);
        used = limit;
      }
    }
    if (kept.length > 0) included.set(key, kept);
    if (kept.length < lines.length) {
      omissions.push({
        section: key,
        label,
        omittedLines: lines.length - kept.length,
        totalLines: lines.length,
      });
    }
  }
  if (byKey.has("timing"))
    notes.push("Timing is carried by the duration parameter, not repeated in the prompt.");
  if (byKey.has("negative_constraints")) {
    notes.push(
      opts.negativeSent
        ? "Negative constraints are sent in the model's negative prompt field."
        : "Negative constraints are not sent: Runway has no negative prompt field.",
    );
  }

  // Render in the plan's natural reading order, not priority order.
  const order = plan.sections.map((s) => s.key);
  const text = [...included.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([key, lines]) => `${LABEL[key] ?? key}: ${lines.join("; ")}.`)
    .join(" ")
    .slice(0, limit);
  return { text, omissions, notes };
}

/** Explicit, acknowledgeable statement of what the prompt limit cost the shot (empty when everything fit). */
export function omissionsAsIgnoredFeatures(omissions: PromptOmission[], limit: number): IgnoredFeature[] {
  if (omissions.length === 0) return [];
  const detail = omissions
    .map((o) => `${o.omittedLines} of ${o.totalLines} ${o.label.toLowerCase()} line(s)`)
    .join(", ");
  return [
    {
      id: "prompt.length",
      feature: "prompt",
      label: `Prompt content beyond Runway's ${limit}-character limit`,
      impact: `Not sent to the model: ${detail}. Shorten the shot's notes, or accept that this intent will not be in the prompt.`,
    },
  ];
}

// ───────────────────────── still images (Phase 2G.2) ─────────────────────────

/**
 * PromptPlan → Runway image `promptText`. The SAME plan as video; only the rendering differs.
 *
 * A still captures ONE moment: the opening pose and each character's expression/posture/gesture are kept, the
 * timed beats, the ending pose and the timing section are not (they describe motion over time). Spoken dialogue
 * and performed-take lines are never sent (an image model has no audio; nothing here claims audio conditioning).
 * Negative constraints are not sent (these models have no negative field); the compatibility engine already made
 * the user acknowledge that. The reference legend is reserved FIRST so a long prompt can never cut it off.
 */
const IMAGE_PRIORITY: PromptSectionKey[] = [
  "subject",
  "composition",
  "action",
  "identity",
  "wardrobe",
  "performance",
  "environment",
  "lighting",
  "camera",
  "provider_adaptation",
  "continuity",
  "hard_constraints",
];

/** Keeps the frame-defining action lines (opening pose, expressions...), drops motion-over-time lines. */
export function stillActionLines(lines: string[]): string[] {
  return lines
    .filter((l) => !/^\d+(\.\d+)?s: /.test(l) && !/^ends: /.test(l))
    .map((l) => l.replace(/^begins: /, "pose at the frame: "));
}

export function compileRunwayImagePrompt(
  plan: PromptPlan,
  limit: number,
  opts: { modelName: string; legend?: string },
): CompiledPrompt {
  const legend = opts.legend ?? "";
  const room = Math.max(0, limit - (legend ? legend.length + 1 : 0));
  const byKey = new Map(plan.sections.map((s) => [s.key, s] as const));
  const notes: string[] = [];
  const included = new Map<PromptSectionKey, string[]>();
  const omissions: PromptOmission[] = [];
  let used = 0;
  for (const key of IMAGE_PRIORITY) {
    const section = byKey.get(key);
    if (!section) continue;
    const lines =
      key === "performance"
        ? performanceLines(section.lines)
        : key === "action"
          ? stillActionLines(section.lines)
          : section.lines;
    const label = LABEL[key] ?? section.title;
    const kept: string[] = [];
    for (const line of lines) {
      const cost = (kept.length === 0 ? label.length + 2 : 0) + line.length + 2;
      if (used + cost <= room) {
        kept.push(line);
        used += cost;
      } else if (used === 0 && kept.length === 0) {
        const cut = Math.max(0, room - label.length - 6);
        kept.push(`${line.slice(0, cut)}…`);
        used = room;
      }
    }
    if (kept.length > 0) included.set(key, kept);
    if (kept.length < lines.length) {
      omissions.push({
        section: key,
        label,
        omittedLines: lines.length - kept.length,
        totalLines: lines.length,
      });
    }
  }
  if (byKey.has("timing") || byKey.has("action"))
    notes.push(
      "A still shows one moment: the opening pose is kept; timed beats and the ending pose are not sent.",
    );
  if (byKey.has("performance"))
    notes.push(
      `Spoken dialogue and performed audio are not sent: ${opts.modelName} generates a still image.`,
    );
  if (byKey.has("negative_constraints"))
    notes.push(`Negative constraints are not sent: ${opts.modelName} has no negative prompt field.`);

  const order = plan.sections.map((s) => s.key);
  const body = [...included.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([key, lines]) => `${LABEL[key] ?? key}: ${lines.join("; ")}.`)
    .join(" ")
    .slice(0, room);
  return { text: [body, legend].filter(Boolean).join(" "), omissions, notes };
}
