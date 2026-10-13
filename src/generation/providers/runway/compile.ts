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

export function compileRunwayPrompt(plan: PromptPlan, limit = RUNWAY_MAX_PROMPT_CHARS): CompiledPrompt {
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
      notes.push("Spoken dialogue text is not sent: Gen-4.5 has no audio/lip-sync input.");
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
    notes.push("Negative constraints are not sent: Runway has no negative prompt field.");
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
