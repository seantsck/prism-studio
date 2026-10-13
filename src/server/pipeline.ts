import "server-only";
import { projectRun } from "@/continuity/service";
import type { QaStatus } from "@/domain/continuity/status";
import type { ProjectData } from "@/domain/schemas";
import { getMediaQaRepo } from "./media-qa";

/** Per-shot production pipeline, kept as separate facts: prep, generation, continuity QA, creative approval. */
export interface ShotPipeline {
  attempts: number;
  generated: boolean;
  approved: boolean;
  qaStatus: QaStatus;
  criticalFailures: number;
}

export interface PipelineSummary {
  shots: Map<string, ShotPipeline>;
  totals: {
    shots: number;
    generated: number;
    continuityReviewed: number;
    criticalFailures: number;
    creativeApproved: number;
  };
}

/** One narrow query (latest QA run per attempt) + the attempts already in `data`: never a per-shot loop. */
export async function loadPipeline(data: ProjectData): Promise<PipelineSummary> {
  const qa = await getMediaQaRepo();
  const runs = await qa.listLatestProjectRuns(data.project.id);
  const byAttempt = new Map(runs.map((r) => [r.run.attemptId, projectRun(r, null)] as const));

  const shots = new Map<string, ShotPipeline>();
  for (const shot of data.shots) {
    const attempts = data.attempts
      .filter((a) => a.shotId === shot.id)
      .sort((a, b) => b.attemptNumber - a.attemptNumber);
    const succeeded = attempts.filter((a) => a.status === "succeeded");
    // The attempt a person would be looking at: the approved one, else the newest completed one.
    const focus = attempts.find((a) => a.approved) ?? succeeded[0] ?? null;
    const run = focus ? (byAttempt.get(focus.id) ?? null) : null;
    shots.set(shot.id, {
      attempts: attempts.length,
      generated: succeeded.length > 0,
      approved: attempts.some((a) => a.approved),
      qaStatus: run ? run.status : "not_started",
      criticalFailures: run?.summary.criticalFailures ?? 0,
    });
  }
  const all = [...shots.values()];
  return {
    shots,
    totals: {
      shots: all.length,
      generated: all.filter((s) => s.generated).length,
      continuityReviewed: all.filter((s) => ["passed", "passed_with_warnings", "failed"].includes(s.qaStatus))
        .length,
      criticalFailures: all.reduce((n, s) => n + s.criticalFailures, 0),
      creativeApproved: all.filter((s) => s.approved).length,
    },
  };
}
