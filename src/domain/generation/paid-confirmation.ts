import { usd } from "./reference-studio";

/**
 * A paid Character / Location image starts only after the creator confirmed the dollar amount they were shown. The
 * estimate is an upper bound computed by the server; the confirmation must cover it. Pure, so the rule is the same in
 * the action, the tests and the price quote.
 *
 * Returns the sentence to show when the confirmation is missing or too small, or null when it covers the estimate.
 */
export function paidConfirmationRefusal(estimateUsd: number | null, confirmedRaw: string): string | null {
  if (estimateUsd == null || !Number.isFinite(estimateUsd))
    return "This model has no known price, so it cannot be started.";
  const confirmed = confirmedRaw.trim() === "" ? Number.NaN : Number(confirmedRaw);
  if (!Number.isFinite(confirmed))
    return `This image costs money: up to ${usd(estimateUsd)}. Open the Reference Studio to see the price and confirm it.`;
  if (confirmed + 1e-9 < estimateUsd)
    return `The price is now up to ${usd(estimateUsd)}. Confirm that amount to continue.`;
  return null;
}
