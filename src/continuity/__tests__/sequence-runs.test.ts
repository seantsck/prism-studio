import { describe, expect, it } from "vitest";
import { seed } from "@/domain/__tests__/helpers";
import {
  buildEpisodeCuts,
  SEQUENCE_RULES_VERSION,
  type TransitionRunTruth,
} from "@/domain/continuity/sequence";
import type { EpisodeEdit } from "@/domain/edit/model";
import { buildEpisodeEditView } from "@/domain/edit/view";
import { MediaQaError, type NewRun } from "@/data/media-qa-repository";
import { MemoryRepository } from "@/data/memory-repository";
import { TRANSITION_CUT_CHANGED_MESSAGE } from "@/data/transition-runs";
import { recordTransitionRun, TRANSITION_TRUTH_CHANGED_MESSAGE } from "../sequence-runs";

/**
 * Phase 3A.4C transition persistence, memory repository (the Postgres implementation is proven against a disposable
 * database by scripts/db-sequence-continuity.mts with the same contract). No provider, no media, no UI path: these
 * runs are created directly, as 3A.4D's analysis will.
 */

const NOW = "2026-10-29T12:00:00.000Z";
const USER = "11111111-2222-4333-8444-555555555555";
const media = { attempts: new Map(), bestPointers: [] };

async function setup() {
  const data = seed();
  const repo = new MemoryRepository([data]);
  const episode = data.episodes[0]!;
  const shots = data.shots.filter((s) => s.episodeId === episode.id).slice(0, 3);
  const edit = await repo.episodeEdits.create({
    projectId: data.project.id,
    episodeId: episode.id,
    editRate: { num: 24, den: 1 },
    items: shots.map((s) => ({
      shotId: s.id,
      visual: { kind: "none" as const, durationMs: 2000 },
      performance: [],
      performanceBasis: null,
    })),
    userId: USER,
    now: NOW,
  });
  const cutsOf = (e: EpisodeEdit) => buildEpisodeCuts({ data, view: buildEpisodeEditView(data, e, media) });
  const record = (e: EpisodeEdit, reviewed: TransitionRunTruth) =>
    recordTransitionRun({
      qa: repo.mediaQa,
      data,
      view: buildEpisodeEditView(data, e, media),
      reviewed,
      userId: USER,
      now: NOW,
    });
  return { data, repo, edit, cutsOf, record };
}

/** A Shot (attempt) run of the seed: the regression fixture next to which transition runs must stay invisible. */
function attemptRun(data: ReturnType<typeof seed>, attemptId: string): NewRun {
  const asset = data.assets[0]!;
  return {
    projectId: data.project.id,
    attemptId,
    subjectAssetId: asset.id,
    originalAssetId: null,
    analyzer: "deterministic",
    analyzerVersion: "1",
    analyzerKind: "deterministic",
    rulesVersion: "3a.1",
    analysisStatus: "complete",
    packageFingerprint: "pf",
    subjectFingerprint: "sf",
    criteriaFingerprint: "cf",
    referenceFingerprint: "rf",
    referenceSet: {},
    createdBy: null,
    now: NOW,
  };
}

describe("transition runs: frozen subject, per-transition numbering, history", () => {
  it("#1, #2 for the same cut; another cut starts at #1; history newest first; frozen sides", async () => {
    const { data, repo, edit, cutsOf, record } = await setup();
    const [ab, bc] = cutsOf(edit);
    const r1 = await record(edit, ab!.truth);
    const r2 = await record(edit, ab!.truth);
    const other = await record(edit, bc!.truth);
    expect([r1.run.runNumber, r2.run.runNumber, other.run.runNumber]).toEqual([1, 2, 1]);
    expect(r1.run).toMatchObject({
      subjectKind: "transition",
      attemptId: null,
      subjectAssetId: null,
      originalAssetId: null,
      rulesVersion: SEQUENCE_RULES_VERSION,
      subjectFingerprint: ab!.truth.subjectFingerprint,
      criteriaFingerprint: ab!.truth.criteriaFingerprint,
      referenceFingerprint: ab!.truth.referenceFingerprint,
      analysisStatus: "complete",
    });
    expect(r1.subject).toMatchObject({
      editId: edit.id,
      episodeId: edit.episodeId,
      editRevision: 0,
      transitionKey: ab!.transitionKey,
      runNumber: 1,
      leftItemId: edit.items[0]!.id,
      rightItemId: edit.items[1]!.id,
      leftShotId: edit.items[0]!.shotId,
      rightShotId: edit.items[1]!.shotId,
      crossesScene: ab!.crossesScene,
    });
    expect(r1.subject.leftSide).toMatchObject({
      version: "cut-side-snapshot-v1",
      side: "left",
      picture: { kind: "none" },
      subjectFingerprint: ab!.truth.leftSubjectFingerprint,
    });
    // the deterministic projection is frozen as findings (semantic criteria unchecked / n_a, never pass)
    expect(r1.findings.map((f) => f.finding.criterionKey)).toEqual(ab!.criteria.map((c) => c.key));
    expect(r1.findings.some((f) => f.finding.resultSource === "none" && f.finding.result === "pass")).toBe(
      false,
    );

    expect(
      (await repo.mediaQa.listTransitionRuns(data.project.id, ab!.transitionKey)).map((v) => v.run.runNumber),
    ).toEqual([2, 1]);
    expect(
      (await repo.mediaQa.listLatestEditTransitionRuns(data.project.id, edit.id)).map((v) => [
        v.subject.transitionKey,
        v.run.runNumber,
      ]),
    ).toEqual(
      [
        [ab!.transitionKey, 2],
        [bc!.transitionKey, 1],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    );
    expect((await repo.mediaQa.getTransitionRun(r1.run.id))?.subject.runNumber).toBe(1);
  });

  it("refuses a cut whose items are no longer adjacent, and a cut whose truth changed since it was reviewed", async () => {
    const { data, repo, edit, cutsOf, record } = await setup();
    const [ab] = cutsOf(edit);
    const [a, b, c] = edit.items;
    const reordered = await repo.episodeEdits.apply({
      editId: edit.id,
      projectId: data.project.id,
      expectedRevision: 0,
      ops: [{ op: "reorder", itemIds: [a!.id, c!.id, b!.id] }],
      userId: USER,
      now: NOW,
    });
    await expect(record(reordered, ab!.truth)).rejects.toMatchObject({ code: "conflict" });
    // the repository's own check, for a caller that bypasses the rebuild (stale view of the old order)
    await expect(record(edit, ab!.truth)).rejects.toThrow(TRANSITION_CUT_CHANGED_MESSAGE);
    expect(await repo.mediaQa.listTransitionRuns(data.project.id, ab!.transitionKey)).toEqual([]);

    const restored = await repo.episodeEdits.apply({
      editId: edit.id,
      projectId: data.project.id,
      expectedRevision: 1,
      ops: [{ op: "reorder", itemIds: [a!.id, b!.id, c!.id] }],
      userId: USER,
      now: NOW,
    });
    const reviewed = { ...cutsOf(restored)[0]!.truth, subjectFingerprint: "someone-else-reviewed-this" };
    await expect(record(restored, reviewed)).rejects.toThrow(TRANSITION_TRUTH_CHANGED_MESSAGE);
    await expect(record(restored, reviewed)).rejects.toBeInstanceOf(MediaQaError);
  });

  it("later edit changes never rewrite a recorded subject (its ids are history)", async () => {
    const { data, repo, edit, cutsOf, record } = await setup();
    const run = await record(edit, cutsOf(edit)[0]!.truth);
    const [a, b, c] = edit.items;
    await repo.episodeEdits.apply({
      editId: edit.id,
      projectId: data.project.id,
      expectedRevision: 0,
      ops: [
        { op: "reorder", itemIds: [c!.id, b!.id, a!.id] },
        { op: "remove", itemId: a!.id },
      ],
      userId: USER,
      now: NOW,
    });
    expect(await repo.mediaQa.getTransitionRun(run.run.id)).toEqual(run);
  });
});

describe("Shot-query isolation: transition runs never reach a Shot path", () => {
  it("attempt history, latest Shot runs, run numbers and getRun are exactly what they were", async () => {
    const { data, repo, edit, cutsOf, record } = await setup();
    const attempt = data.attempts[0]!;
    const qa = repo.mediaQa;
    const a1 = await qa.createRun(attemptRun(data, attempt.id), []);
    const before = {
      history: await qa.listAttemptRuns(attempt.id),
      latest: await qa.listLatestProjectRuns(data.project.id),
      jobs: await qa.listAttemptAnalysisJobs(attempt.id),
      active: await qa.listActiveProjectAnalysisJobs(data.project.id),
      pins: await qa.assetPins(data.assets[0]!.id),
    };
    const t1 = await record(edit, cutsOf(edit)[0]!.truth);
    await record(edit, cutsOf(edit)[0]!.truth);
    expect(await qa.listAttemptRuns(attempt.id)).toEqual(before.history);
    expect(await qa.listLatestProjectRuns(data.project.id)).toEqual(before.latest);
    expect(await qa.listAttemptAnalysisJobs(attempt.id)).toEqual(before.jobs);
    expect(await qa.listActiveProjectAnalysisJobs(data.project.id)).toEqual(before.active);
    expect(await qa.assetPins(data.assets[0]!.id)).toEqual(before.pins);
    expect(await qa.getRun(t1.run.id)).toBeNull();
    // the next Shot run number counts attempt runs only
    const a2 = await qa.createRun(attemptRun(data, attempt.id), []);
    expect([a1.run.runNumber, a2.run.runNumber]).toEqual([1, 2]);
    // and a Shot run id is never a transition run
    expect(await qa.getTransitionRun(a1.run.id)).toBeNull();
  });
});
