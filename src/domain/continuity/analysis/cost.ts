import type { AnalysisBudget, AnalysisMedia } from "./types";

/**
 * Analysis cost accounting vocabulary. Separate from generation cost: nothing here touches generation_costs.
 *
 * Pricing is VERSIONED SERVER CONFIGURATION (never scraped at runtime). Rates may change on a known date; the
 * rate used is chosen from the table by the date of the analysis, and the pricing version is recorded.
 */

export interface RateWindow {
  /** Inclusive ISO date (UTC) the rate starts applying. */
  from: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface ModelPricing {
  provider: string;
  model: string;
  /** Windows sorted ascending by `from`; the latest one with from <= date applies. */
  rates: RateWindow[];
  /** Image/video input is billed at the text input rate for this model. */
  mediaBilledAsText: boolean;
}

export interface PricingTable {
  version: string;
  source: string;
  checkedAt: string;
  models: ModelPricing[];
}

export function rateFor(p: ModelPricing, at: Date): RateWindow {
  const day = at.toISOString().slice(0, 10);
  const applicable = [...p.rates].sort((a, b) => a.from.localeCompare(b.from)).filter((r) => r.from <= day);
  return applicable.at(-1) ?? p.rates[0]!;
}

export interface TokenEstimate {
  inputTokens: number;
  /** What a typical answer costs (per-criterion allowance). */
  expectedOutputTokens: number;
  /** Hard ceiling configured on the request (max output tokens, which also bounds thinking). */
  maxOutputTokens: number;
}

export interface CostEstimateUsd {
  expectedUsd: number;
  /** Conservative ceiling used by the spend gate. */
  maxUsd: number;
  tokens: TokenEstimate;
  pricingVersion: string;
  basis: string;
}

/** Tokens for one image per Gemini's documented tiling (≤384 px both sides = 258; else 258 per tile). */
export function imageTokens(width: number | null, height: number | null): number {
  if (!width || !height) return 1548; // unknown size: assume a 960×540-class image, rounded up
  if (width <= 384 && height <= 384) return 258;
  const unit = Math.max(1, Math.floor(Math.min(width, height) / 1.5));
  return Math.ceil(width / unit) * Math.ceil(height / unit) * 258;
}

/** Rough but conservative text token estimate. */
export const textTokens = (chars: number) => Math.ceil(chars / 3);

export function estimateTokens(args: {
  media: Array<Pick<AnalysisMedia, "width" | "height" | "kind" | "durationMs">>;
  promptChars: number;
  criteria: number;
  maxOutputTokens: number;
  budget: AnalysisBudget;
}): TokenEstimate {
  let input = textTokens(args.promptChars) + 600; // system instruction + schema overhead
  for (const m of args.media) {
    if (m.kind === "video") {
      // ~300 tokens/second at default resolution, plus audio; conservative.
      input += Math.ceil(((m.durationMs ?? 5000) / 1000) * 300);
      continue;
    }
    // images are bounded before sending: estimate the bounded size
    const long = Math.max(m.width ?? 0, m.height ?? 0);
    const k = long > args.budget.maxImageDimension ? args.budget.maxImageDimension / long : 1;
    input += imageTokens(
      m.width ? Math.round(m.width * k) : null,
      m.height ? Math.round(m.height * k) : null,
    );
  }
  return {
    inputTokens: input,
    expectedOutputTokens: Math.min(args.maxOutputTokens, 220 * Math.max(1, args.criteria) + 120),
    maxOutputTokens: args.maxOutputTokens,
  };
}

export function priceTokens(
  t: { inputTokens: number; outputTokens: number },
  pricing: ModelPricing,
  at: Date,
): number {
  const r = rateFor(pricing, at);
  return (t.inputTokens * r.inputPerMillionUsd + t.outputTokens * r.outputPerMillionUsd) / 1_000_000;
}

export function estimateCost(
  tokens: TokenEstimate,
  pricing: ModelPricing,
  table: Pick<PricingTable, "version">,
  at: Date,
): CostEstimateUsd {
  const expected = priceTokens(
    { inputTokens: tokens.inputTokens, outputTokens: tokens.expectedOutputTokens },
    pricing,
    at,
  );
  const max = priceTokens(
    { inputTokens: tokens.inputTokens, outputTokens: tokens.maxOutputTokens },
    pricing,
    at,
  );
  const r = rateFor(pricing, at);
  return {
    expectedUsd: roundUsd(expected),
    maxUsd: roundUsd(max),
    tokens,
    pricingVersion: table.version,
    basis: `${tokens.inputTokens} input tokens × $${r.inputPerMillionUsd}/M + up to ${tokens.maxOutputTokens} output tokens × $${r.outputPerMillionUsd}/M (pricing ${table.version}; estimate, not a quote)`,
  };
}

export const roundUsd = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

export interface ActualCost {
  /** null = usage metadata missing: the cost is UNKNOWN and is never invented. */
  amountUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  pricingVersion: string;
}

/** Thinking tokens are billed at the output rate (documented), so they are added to output. */
export function actualCost(
  calls: Array<{ inputTokens: number | null; outputTokens: number | null; thoughtsTokens: number | null }>,
  pricing: ModelPricing,
  table: Pick<PricingTable, "version">,
  at: Date,
): ActualCost {
  if (
    calls.length === 0 ||
    calls.some((c) => c.inputTokens == null || (c.outputTokens == null && c.thoughtsTokens == null))
  ) {
    return {
      amountUsd: null,
      inputTokens: null,
      outputTokens: null,
      thoughtsTokens: null,
      pricingVersion: table.version,
    };
  }
  const input = calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0);
  const out = calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0);
  const thoughts = calls.reduce((n, c) => n + (c.thoughtsTokens ?? 0), 0);
  return {
    amountUsd: roundUsd(priceTokens({ inputTokens: input, outputTokens: out + thoughts }, pricing, at)),
    inputTokens: input,
    outputTokens: out,
    thoughtsTokens: thoughts,
    pricingVersion: table.version,
  };
}

// ───────────────────────── spend gate ─────────────────────────

export interface AnalysisSpendPolicy {
  enabled: boolean;
  maxUsdPerRun: number | null;
  maxUsdPerDay: number | null;
}

export interface SpendBlocker {
  code: string;
  message: string;
}

/** Why a PAID analysis may not be submitted/executed. Empty = within limits. Independent of generation spend. */
export function analysisSpendBlockers(args: {
  policy: AnalysisSpendPolicy;
  maxEstimateUsd: number | null;
  spentLast24hUsd: number;
}): SpendBlocker[] {
  const { policy } = args;
  const out: SpendBlocker[] = [];
  if (!policy.enabled) {
    out.push({
      code: "analysis_spend.disabled",
      message: "Paid continuity analysis is switched off on this server (PRISM_STUDIO_ALLOW_PAID_ANALYSIS).",
    });
    return out;
  }
  if (policy.maxUsdPerRun == null) {
    out.push({
      code: "analysis_spend.no_limit",
      message: "No per-run analysis spend limit is configured (PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN).",
    });
    return out;
  }
  if (args.maxEstimateUsd == null) {
    out.push({
      code: "analysis_spend.unknown_cost",
      message: "The analysis cost cannot be estimated, so it cannot be checked against the limit.",
    });
  } else {
    if (args.maxEstimateUsd > policy.maxUsdPerRun) {
      out.push({
        code: "analysis_spend.over_run_limit",
        message: `Estimated worst-case cost $${args.maxEstimateUsd.toFixed(4)} exceeds the per-run analysis limit of $${policy.maxUsdPerRun.toFixed(4)}.`,
      });
    }
    if (policy.maxUsdPerDay != null && args.spentLast24hUsd + args.maxEstimateUsd > policy.maxUsdPerDay) {
      out.push({
        code: "analysis_spend.over_day_limit",
        message: `This would take analysis spend over the daily limit of $${policy.maxUsdPerDay.toFixed(2)} ($${args.spentLast24hUsd.toFixed(4)} already used in the last 24 h).`,
      });
    }
  }
  return out;
}
