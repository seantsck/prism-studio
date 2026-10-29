import type { CutTransition, TransitionAddress } from "@/domain/continuity/sequence";

/**
 * Phase 3A.4B: the cut's DOM anchor and the Episode Edit's minimal incoming-cut marker, shared by the Episode Edit
 * display model and the Continuity Supervisor so a marker always links to exactly the Supervisor row of its cut.
 * Derived from the 3A.4A cut projection only (never recomputed here). No semantic run exists yet, so a marker is never
 * "green": it is a fail tone for a current source-integrity failure, a warn tone for deterministic warnings, else
 * neutral.
 */

/** The Supervisor's client-local cut filters (each row carries its own flags). */
export const CUT_FILTERS = [
  ["all", "All"],
  ["critical", "Critical"],
  ["warnings", "Warnings"],
  ["unchecked", "Unchecked"],
  ["scene", "Scene boundaries"],
  ["media_blocked", "Media blocked"],
] as const;
export type CutFilter = (typeof CUT_FILTERS)[number][0];

/** DOM-safe and deterministic: the edit's item ids are uuids. */
export const cutAnchor = (a: Pick<TransitionAddress, "leftItemId" | "rightItemId">): string =>
  `cut-${a.leftItemId}-${a.rightItemId}`;

export interface CutMarkerVM {
  anchor: string;
  tone: "fail" | "warn" | "neutral";
  /** current deterministic FAIL + WARN findings */
  issues: number;
  /** accessible text: what the link is and what it would show */
  label: string;
}

export function cutMarker(cut: CutTransition): CutMarkerVM {
  const fails = cut.findings.filter((f) => f.result === "fail").length;
  const warns = cut.findings.filter((f) => f.result === "warn").length;
  const a = cut.left.shotCode ?? "missing Shot";
  const b = cut.right.shotCode ?? "missing Shot";
  const what = [
    fails ? `${fails} source failure${fails === 1 ? "" : "s"}` : "",
    warns ? `${warns} deterministic warning${warns === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    anchor: cutAnchor(cut.address),
    tone: fails ? "fail" : warns ? "warn" : "neutral",
    issues: fails + warns,
    label: `Cut ${a} → ${b}: ${what || "no deterministic issue"}. Review this cut in the Continuity Supervisor.`,
  };
}
