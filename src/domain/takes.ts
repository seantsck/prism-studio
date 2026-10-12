import type { PerformanceTake } from "./schemas";

/**
 * Select one canonical take for its dialogue line. Exactly one take per line
 * may be selected; selecting another deselects the previous one. Takes of other
 * lines are untouched. Mirrors the partial unique index in the SQL migration.
 */
export function selectTake(takes: readonly PerformanceTake[], takeId: string): PerformanceTake[] {
  const target = takes.find((t) => t.id === takeId);
  if (!target) throw new Error(`Take ${takeId} not found`);
  if (target.archived) throw new Error(`Take ${takeId} is archived; restore it before selecting`);
  return takes.map((t) =>
    t.dialogueLineId === target.dialogueLineId ? { ...t, selected: t.id === takeId } : t,
  );
}

export function deselectTake(takes: readonly PerformanceTake[], takeId: string): PerformanceTake[] {
  return takes.map((t) => (t.id === takeId ? { ...t, selected: false } : t));
}

export function nextTakeNumber(takes: readonly PerformanceTake[], lineId: string): number {
  return (
    takes.filter((t) => t.dialogueLineId === lineId).reduce((max, t) => Math.max(max, t.takeNumber), 0) + 1
  );
}

/** Returns line ids that violate the one-selected-take rule. */
export function findSelectionViolations(takes: readonly PerformanceTake[]): string[] {
  const counts = new Map<string, number>();
  for (const t of takes)
    if (t.selected) counts.set(t.dialogueLineId, (counts.get(t.dialogueLineId) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([lineId]) => lineId);
}
