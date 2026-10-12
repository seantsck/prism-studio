import type { Shot } from "./schemas";

export class ReorderError extends Error {}

/**
 * Reorder shots inside a single scene. `targetIndex` is an absolute position within the scene.
 * Order rules:
 *  - Shots may only move within their own scene.
 *  - A locked shot is pinned to its slot and cannot be moved; the remaining shots are permuted
 *    among the unlocked slots, so other shots never jump across a locked one.
 * Returns the full scene list with contiguous `order` values (starting at the scene's min order).
 */
export function reorderShotsInScene(
  sceneShots: readonly Shot[],
  movedId: string,
  targetIndex: number,
): Shot[] {
  const sorted = [...sceneShots].sort((a, b) => a.order - b.order);
  const moved = sorted.find((s) => s.id === movedId);
  if (!moved) throw new ReorderError(`Shot ${movedId} is not in this scene`);
  if (new Set(sorted.map((s) => s.sceneId)).size > 1) throw new ReorderError("Shots span multiple scenes");
  if (moved.status === "locked")
    throw new ReorderError(`Shot ${moved.shotCode} is locked and cannot be moved`);

  const slots = sorted.map((s, i) => ({ s, i })).filter(({ s }) => s.status !== "locked");
  const movable = slots.map(({ s }) => s);
  const from = movable.findIndex((s) => s.id === movedId);
  // `targetIndex` is an absolute position in the scene; land on the first unlocked slot at or after it.
  const clamped = Math.max(0, Math.min(sorted.length - 1, targetIndex));
  const found = slots.findIndex(({ i }) => i >= clamped);
  const to = found === -1 ? movable.length - 1 : found;
  const [item] = movable.splice(from, 1);
  movable.splice(to, 0, item);

  const result = [...sorted];
  slots.forEach(({ i }, k) => (result[i] = movable[k]));
  const base = sorted[0]?.order ?? 0;
  return result.map((s, i) => ({ ...s, order: base + i }));
}

/** Resequence orders to be contiguous without changing relative order. */
export function normalizeOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order).map((item, i) => ({ ...item, order: i }));
}
