/**
 * Durable provider-overload backoff (Phase 2D hardening).
 *
 * A confirmed 429/503 proves the provider processed nothing, so it is safe to try again — but never in a rapid
 * in-process loop. The worker persists `next_run_at` on the job and lets go of it; a later claim sends ONE new
 * request. The schedule is deterministic exponential backoff with a small deterministic jitter (so two jobs do
 * not retry in lock-step, and tests are reproducible).
 */
export const OVERLOAD_BACKOFF_SECONDS = [15, 45, 120, 300, 600] as const;
const MAX_DELAY_MS = 15 * 60_000;
const JITTER = 0.1;

/** Provider-requested waits above this are not honoured blindly (a job must not sleep for hours). */
export const MAX_RETRY_AFTER_MS = MAX_DELAY_MS;

function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * Delay before the next request after the `ordinal`-th (1-based) confirmed overload of this job.
 * Honours a provider `Retry-After` when it is longer than the schedule (capped).
 */
export function overloadBackoffMs(ordinal: number, seed: string, retryAfterMs?: number | null): number {
  const idx = Math.min(Math.max(1, Math.floor(ordinal)), OVERLOAD_BACKOFF_SECONDS.length) - 1;
  const base = OVERLOAD_BACKOFF_SECONDS[idx]! * 1000;
  const jitter = 1 + (hash01(`${seed}:${ordinal}`) * 2 - 1) * JITTER;
  const scheduled = Math.round(base * jitter);
  const requested = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : 0;
  return Math.min(MAX_DELAY_MS, Math.max(scheduled, requested));
}

export const DEFAULT_MAX_TRANSPORT_CALLS = 6;
export const DEFAULT_MAX_CORRECTIONS = 1;
