import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryRepository } from "@/data/memory-repository";
import { submitCandidateSet } from "@/generation/candidate-set";
import { prepareSubjectImage } from "@/generation/subject-submission";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";

/**
 * Phase 5B-I1b Shot image actions. Generate Image / Alternate Composition / Generate Storyboard reuse the EXISTING
 * Production Frame candidate workflow (one human-chosen model); Use as Storyboard Frame adds a new, unapproved frame
 * version pointing at a generated still and never touches existing frames.
 */
vi.setConfig({ testTimeout: 60_000 });
const world = vi.hoisted(() => ({ repo: null as unknown, created: [] as FormData[] }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/generation", () => ({
  getGenerationRepo: async () => (world.repo as MemoryRepository).generation,
}));
vi.mock("@/server/candidate-actions", () => ({
  createCandidateSet: async (fd: FormData) => {
    world.created.push(fd);
    return { ok: true };
  },
}));

import { saveAsStoryboardFrame, startShotImage } from "../shot-image-actions";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};

let h: Harness;
beforeEach(() => {
  h = makeHarness();
  world.repo = h.repo;
  world.created.length = 0;
});

async function generatedStill(shotCode: string) {
  const data = await h.data();
  const shot = data.shots.find((s) => s.shotCode === shotCode)!;
  await h.repo.upsert(data.project.id, "shots", {
    ...shot,
    composition: { ...shot.composition, aspectRatio: "16:9" },
    updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
  });
  await submitCandidateSet({
    data: await h.data(),
    shotId: shot.id,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections: [{ provider: "mock", modelId: "mock-image-1" }],
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "Production Frame candidate",
    purpose: "",
    userId: null,
    projectRevision: null,
    generationPurpose: "production_frame",
    now: h.clock.now,
  });
  for (let i = 0; i < 12; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
  const after = await h.data();
  const attempt = after.attempts.find(
    (a) => a.shotId === shot.id && a.status === "succeeded" && a.outputAssetId,
  )!;
  return { shot, attempt, data: after };
}

describe("5B-I6 Generate Production Frame: candidates and direction", () => {
  it("asks for N candidates of the ONE chosen model and forwards Additional direction; bounds are enforced", async () => {
    expect(
      await startShotImage(
        form({
          shotId: "s1",
          kind: "production_frame",
          model: "mock/mock-image-1",
          count: "3",
          direction: "  a touch tighter ",
        }),
      ),
    ).toEqual({ ok: true });
    const sel = JSON.parse(String(world.created[0]!.get("selections")));
    expect(sel).toHaveLength(3);
    for (const s of sel)
      expect(s).toEqual({
        provider: "mock",
        modelId: "mock-image-1",
        direction: { kind: "additional", text: "a touch tighter" },
      });
    for (const count of ["0", "5", "x"])
      expect(
        await startShotImage(
          form({ shotId: "s1", kind: "production_frame", model: "mock/mock-image-1", count }),
        ),
      ).toMatchObject({ ok: false, error: "Choose between 1 and 4 candidates." });
    // Generate Alternatives with a direction; an edit and a storyboard are always one image
    await startShotImage(
      form({
        shotId: "s1",
        kind: "alternate_composition",
        model: "mock/mock-image-1",
        direction: "low angle",
      }),
    );
    expect(JSON.parse(String(world.created.at(-1)!.get("selections")))[0].direction).toEqual({
      kind: "alternate_composition",
      text: "low angle",
    });
    await startShotImage(form({ shotId: "s1", kind: "storyboard", model: "mock/mock-image-1", count: "4" }));
    expect(JSON.parse(String(world.created.at(-1)!.get("selections")))).toHaveLength(1);
    expect(world.created).toHaveLength(3);
  });
});

describe("5B-I1b Shot image actions", () => {
  it("Generate Image / Alternate Composition / Generate Storyboard delegate ONE chosen model to the Production Frame workflow", async () => {
    for (const kind of ["production_frame", "alternate_composition", "storyboard"]) {
      expect(await startShotImage(form({ shotId: "s1", kind, model: "mock/mock-image-1" }))).toEqual({
        ok: true,
      });
    }
    expect(world.created).toHaveLength(3);
    for (const fd of world.created) {
      expect(fd.get("generationPurpose")).toBe("production_frame");
      expect(fd.get("shotId")).toBe("s1");
    }
    // 5B-I6: Alternate Composition carries its (protected) direction; the others are the plain chosen model
    expect(world.created.map((fd) => JSON.parse(String(fd.get("selections"))))).toEqual([
      [{ provider: "mock", modelId: "mock-image-1" }],
      [
        {
          provider: "mock",
          modelId: "mock-image-1",
          direction: { kind: "alternate_composition", text: "" },
        },
      ],
      [{ provider: "mock", modelId: "mock-image-1" }],
    ]);
    expect(world.created.map((f) => f.get("title"))).toEqual([
      "Production Frame candidate",
      "Alternate composition",
      "Storyboard frame",
    ]);
    expect(
      await startShotImage(form({ shotId: "s1", kind: "nope", model: "mock/mock-image-1" })),
    ).toMatchObject({
      ok: false,
    });
    expect(await startShotImage(form({ shotId: "s1", kind: "storyboard", model: "" }))).toMatchObject({
      ok: false,
      error: "Choose an image model.",
    });
    expect(world.created).toHaveLength(3);
  });

  it("Use as Storyboard Frame adds a new unapproved 'generated' frame; existing frames are untouched", async () => {
    const { shot, attempt, data } = await generatedStill("1A");
    const before = data.frames.filter((f) => f.shotId === shot.id);
    const r = await saveAsStoryboardFrame(form({ shotId: shot.id, attemptId: attempt.id }));
    expect(r).toMatchObject({ ok: true });
    const after = (await h.data()).frames.filter((f) => f.shotId === shot.id);
    expect(after).toHaveLength(before.length + 1);
    for (const f of before) expect(after.find((x) => x.id === f.id)).toEqual(f);
    const added = after.find((f) => !before.some((b) => b.id === f.id))!;
    expect(added).toMatchObject({
      source: "generated",
      assetId: attempt.outputAssetId,
      approved: false,
      version: Math.max(0, ...before.map((f) => f.version)) + 1,
    });
  });

  it("refuses another Shot's still, a Character image (0051 gate) and an unknown attempt", async () => {
    const { attempt, data } = await generatedStill("1A");
    const other = data.shots.find((s) => s.shotCode === "1B")!;
    expect(await saveAsStoryboardFrame(form({ shotId: other.id, attemptId: attempt.id }))).toMatchObject({
      ok: false,
      error: "That generated image no longer exists.",
    });
    const character = data.characters[0]!;
    const p = prepareSubjectImage({
      data,
      input: { subject: { kind: "character", characterId: character.id, intent: "portrait" }, direction: "" },
      registry: h.registry,
      provider: "mock",
      modelId: "mock-image-1",
      aspectRatio: "1:1",
      userId: null,
      idempotencyKey: `subject-${randomUUID()}`,
      config: h.config,
      now: h.clock.now,
    });
    if (!p.ok) throw new Error(p.reasons.join(" "));
    const subject = await h.repo.generation.createSubjectImageAttempt(p.input);
    expect(
      await saveAsStoryboardFrame(form({ shotId: other.id, attemptId: subject.attempt.id })),
    ).toMatchObject({ ok: false, error: "That generated image no longer exists." });
    expect(await saveAsStoryboardFrame(form({ shotId: other.id, attemptId: randomUUID() }))).toMatchObject({
      ok: false,
      error: "That generated image no longer exists.",
    });
  });
});
