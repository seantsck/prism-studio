import type { CostEstimate, ModelCapabilities } from "./schemas";

/**
 * Estimated cost from a model's declared commercial capabilities. Pure and deterministic.
 * Unknown pricing yields amount: null: Prism shows "Unknown" and never invents a number.
 */
export function estimateCostFromCapabilities(
  caps: ModelCapabilities,
  input: { durationMs: number | null; outputs: number; megapixels?: number | null },
): CostEstimate {
  const c = caps.commercial;
  if (c.pricing === "unknown" || c.unitCost == null) {
    return { amount: null, currency: c.currency, basis: "pricing unknown", units: null };
  }
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  switch (c.pricing) {
    case "per_second": {
      if (input.durationMs == null)
        return { amount: null, currency: c.currency, basis: "duration unknown", units: null };
      const seconds = input.durationMs / 1000;
      return {
        amount: round(seconds * c.unitCost * Math.max(1, input.outputs)),
        currency: c.currency,
        basis: `${c.unitCost} ${c.currency} × ${seconds}s × ${Math.max(1, input.outputs)} output(s)`,
        units: seconds * Math.max(1, input.outputs),
      };
    }
    case "per_output":
      return {
        amount: round(c.unitCost * Math.max(1, input.outputs)),
        currency: c.currency,
        basis: `${c.unitCost} ${c.currency} × ${Math.max(1, input.outputs)} output(s)`,
        units: Math.max(1, input.outputs),
      };
    case "per_megapixel": {
      if (input.megapixels == null)
        return { amount: null, currency: c.currency, basis: "resolution unknown", units: null };
      return {
        amount: round(c.unitCost * input.megapixels * Math.max(1, input.outputs)),
        currency: c.currency,
        basis: `${c.unitCost} ${c.currency} × ${input.megapixels.toFixed(2)} MP`,
        units: input.megapixels * Math.max(1, input.outputs),
      };
    }
    case "flat":
      return { amount: round(c.unitCost), currency: c.currency, basis: "flat per request", units: 1 };
  }
}

export function formatCost(amount: number | null, currency: string): string {
  if (amount == null) return "Unknown";
  const symbol = currency === "USD" ? "$" : "";
  return `${symbol}${amount.toFixed(amount < 1 ? 3 : 2)}${symbol ? "" : ` ${currency}`}`;
}
