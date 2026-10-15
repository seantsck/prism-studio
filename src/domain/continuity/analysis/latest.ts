/**
 * Which analysis job speaks for an attempt RIGHT NOW (pure; no I/O).
 *
 * The launcher's status banner must reflect the LATEST job chronologically. An older failure (for example a
 * provider that was overloaded last week) must never be presented as the "last analysis" once a newer job
 * exists. History stays intact: every job is still listed in run history and still counts towards provider
 * health; this only decides what the single current-status banner says.
 */
export interface DatedJob {
  id: string;
  status: string;
  createdAt: string;
}

/** The chronologically latest job (ties keep the earlier entry of the input, which is newest-first). */
export function latestAnalysisJob<T extends DatedJob>(jobs: readonly T[]): T | null {
  let best: T | null = null;
  for (const j of jobs) if (!best || j.createdAt.localeCompare(best.createdAt) > 0) best = j;
  return best;
}

/** The job to show a "last analysis failed" banner for: only when the LATEST job is the failed one. */
export function currentFailedAnalysis<T extends DatedJob>(jobs: readonly T[]): T | null {
  const latest = latestAnalysisJob(jobs);
  return latest && latest.status === "failed" ? latest : null;
}
