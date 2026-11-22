/**
 * What Prism Studio charges a creator for a paid step: its own cost times PRICE_MULTIPLIER (owner decision,
 * 2026-11-22: three times the cost), in whole cents, shown as the exact price before anything runs. The cost used is
 * Prism's pre-spend upper bound for that exact request, so the price shown is never below three times what the
 * provider can bill for it. Free steps stay free.
 */
export const PRICE_MULTIPLIER = 3;

/** The creator's price for a step that costs Prism `costUsd` (null: unknown; 0: free). */
export function userPrice(costUsd: number | null | undefined): number | null {
  if (costUsd == null || !Number.isFinite(costUsd)) return null;
  if (costUsd <= 0) return 0;
  // whole cents, rounded up, and never less than one cent for something that costs money
  return Math.max(1, Math.ceil(costUsd * PRICE_MULTIPLIER * 100 - 1e-9)) / 100;
}

/** "$0.21", "Free", or "unknown": always whole cents, because it is a price, not a cost. */
export function priceText(costUsd: number | null | undefined): string {
  const p = userPrice(costUsd);
  if (p == null) return "unknown";
  if (p === 0) return "Free";
  return `$${p.toFixed(2)}`;
}

/**
 * Whether the owner's own cost is shown beside the price (a review deployment, where the owner is the only user).
 * Creators on a public deployment see only their price.
 */
export function showsOwnerCost(): boolean {
  return process.env.NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT === "staging";
}
