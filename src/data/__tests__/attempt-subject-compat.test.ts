import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { findAssetUsage, indexAssetUsage } from "@/domain/asset-usage";
import { prepareSubjectImage } from "@/generation/subject-submission";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";

/**
 * MIGRATION-COMPATIBILITY GATE for 0051 (generation subjects). Before 0051 may be applied to a database that a deployed
 * build reads, every reader that build uses must handle Shot, Character and Location attempts. With subject attempts
 * PRESENT (queued and succeeded), the Shot readers behave exactly as before: Shot history, listings and views contain
 * only Shot attempts; a subject id is "not found" (never a crash); a cross-kind idempotency key is refused cleanly.
 * The same gate runs on Postgres in scripts/db-generation-subjects.mts.
 */
vi.setConfig({ testTimeout: 60_000 });

async function withSubjects(h: Harness) {
  const data = await h.data();
  const character = data.characters[0]!;
  const location = data.locations[0]!;
  const make = (subject: Parameters<typeof prepareSubjectImage>[0]["input"]["subject"]) => {
    const p = prepareSubjectImage({
      data,
      input: { subject, direction: "" },
      registry: h.registry,
      provider: "mock",
      modelId: "mock-image-1",
      aspectRatio: "1:1",
      userId: null,
      idempotencyKey: `subject-${randomUUID()}`,
      config: h.config,
      now: h.clock.now,
    });
    if (!p.ok) throw new Error(p.reasons.join(" · "));
    return p.input;
  };
  const done = await h.repo.generation.createSubjectImageAttempt(
    make({ kind: "character", characterId: character.id, intent: "portrait" }),
  );
  for (let i = 0; i < 8; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
  const queuedInput = make({ kind: "location", locationId: location.id, intent: "background" });
  const queued = await h.repo.generation.createSubjectImageAttempt(queuedInput);
  return {
    data,
    done: done.attempt.id,
    queued: queued.attempt.id,
    queuedKey: queuedInput.job.idempotencyKey,
  };
}

describe("0051 migration-compatibility gate: Shot readers with Character / Location attempts present", () => {
  it("old Shot data reads exactly as before", async () => {
    const h = makeHarness();
    const before = await h.data();
    const shotSubmit = await h.submit("1A", "mock-video-1", { acknowledge: true });
    expect(shotSubmit.attemptId).toBeTruthy();
    const withShot = await h.data();
    await withSubjects(h);
    const after = await h.data();
    expect(after.attempts.map((a) => a.id).sort()).toEqual(withShot.attempts.map((a) => a.id).sort());
    expect(after.attempts.every((a) => typeof a.shotId === "string" && a.shotId.length > 0)).toBe(true);
    expect(after.shots).toEqual(before.shots);
    const shotViews = await h.repo.generation.listShotAttempts(withShot.attempts[0]!.shotId);
    expect(shotViews.every((v) => v.attempt.shotId === withShot.attempts[0]!.shotId)).toBe(true);
  });

  it("the project generations listing stays Shot-only", async () => {
    const h = makeHarness();
    const { data, done, queued } = await withSubjects(h);
    const rows = await h.repo.generation.listProjectGenerations(data.project.id, {});
    expect(rows.some((r) => r.attempt.id === done || r.attempt.id === queued)).toBe(false);
    expect(rows.every((r) => typeof r.attempt.shotId === "string")).toBe(true);
  });

  it("a subject id is 'not found' to the Shot attempt view and to review (never a crash)", async () => {
    const h = makeHarness();
    const { done } = await withSubjects(h);
    expect(await h.repo.generation.getAttemptView(done)).toBeNull();
    expect(
      await h.repo.generation.reviewAttempt(done, {
        status: "approved",
        categories: [],
        reason: "",
        notes: "",
        now: h.clock.now.toISOString(),
      }),
    ).toBeNull();
    // the subject reader still finds it
    expect((await h.repo.generation.getSubjectImageAttempt(done))?.attempt.status).toBe("succeeded");
  });

  it("a cross-kind idempotency key is refused cleanly", async () => {
    const h = makeHarness();
    const { queuedKey } = await withSubjects(h);
    const shot = await h
      .submit("1A", "mock-video-1", { acknowledge: true, key: queuedKey })
      .catch((e: Error) => e);
    expect(shot instanceof Error ? shot.message : "no error").toMatch(/belongs to another generation/);
  });

  it("asset usage never crashes on a subject output (its attempt is not in Shot history)", async () => {
    const h = makeHarness();
    const { done } = await withSubjects(h);
    const data = await h.data();
    const out = (await h.repo.generation.getSubjectImageAttempt(done))!.outputs[0]!.asset;
    expect(() => findAssetUsage(data, out.id)).not.toThrow();
    expect(() => indexAssetUsage(data)).not.toThrow();
  });
});
