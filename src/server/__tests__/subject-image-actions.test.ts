import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { readGenerationConfig } from "@/generation/config";
import { createRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";

/**
 * Phase 5B-I1 server actions on the memory store with the REAL worker: Generate Image → stored output → "Use as …".
 * Generated images are never overwritten; "use as" only points a reference at one, and only for its own subject.
 */
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
};
const world = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("server-only", () => ({}));
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
vi.mock("@/server/generation", async () => {
  const { readGenerationConfig: read } = await import("@/generation/config");
  const { createRegistry: create } = await import("@/generation/registry");
  const e = {
    NODE_ENV: "test",
    PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
    PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
  };
  return {
    getGenerationRepo: async () => (world.repo as MemoryRepository).generation,
    getGenerationConfig: () => read(e),
    getRegistry: () => create(e, read(e)),
  };
});

import {
  saveAsCharacterReference,
  saveAsLocationReference,
  startSubjectImage,
} from "../subject-image-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-subject-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));

let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};

async function generate(fields: Record<string, string>) {
  const r = await startSubjectImage(form({ model: "mock/mock-image-1", aspectRatio: "1:1", ...fields }));
  expect(r).toMatchObject({ ok: true });
  const config = readGenerationConfig(env);
  let t = Date.now();
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: createRegistry(env, config),
    sink: new LocalDiskSink(sinkRoot),
    config,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < 10; i++) {
    await worker.tick(5);
    t += 2000;
  }
}

describe("5B-I1 Character / Location image actions", () => {
  it("Generate Image → Use as Character Reference points the slot at the generated Asset; nothing is overwritten", async () => {
    const data = (await repo.loadProject("ojousama"))!;
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    await generate({ subjectKind: "character", subjectId: yumeko.id, intent: "portrait" });
    const [view] = await repo.generation.listSubjectImageAttempts({
      kind: "character",
      characterId: yumeko.id,
    });
    expect(view!.attempt.status).toBe("succeeded");
    const output = view!.outputs[0]!.asset;
    // changing the canonical front reference is an explicit act: a locked slot is unlocked first (by the creator)
    const seeded = data.identityRefs.find((x) => x.characterId === yumeko.id && x.slot === "front");
    if (seeded?.locked) await repo.upsert(data.project.id, "identityRefs", { ...seeded, locked: false });

    const r = await saveAsCharacterReference(
      form({ characterId: yumeko.id, attemptId: view!.attempt.id, slot: "front", label: "Generated front" }),
    );
    expect(r).toMatchObject({ ok: true });
    const after = (await repo.loadProject("ojousama"))!;
    const front = after.identityRefs.filter((x) => x.characterId === yumeko.id && x.slot === "front");
    expect(front).toHaveLength(1);
    expect(front[0]).toMatchObject({ assetId: output.id, label: "Generated front", locked: false });
    expect(front[0]!.metadata).toMatchObject({ source: "generated", attemptId: view!.attempt.id });
    // the generated Asset itself is unchanged and still the attempt's output
    expect(after.assets.find((a) => a.id === output.id)).toEqual(output);
    expect((await repo.generation.getSubjectImageAttempt(view!.attempt.id))!.outputs[0]!.asset.id).toBe(
      output.id,
    );
    expect(after.attempts.some((a) => a.id === view!.attempt.id)).toBe(false);
  });

  it("refuses a locked slot, another character's image, an unknown attempt and an unfinished image", async () => {
    const data = (await repo.loadProject("ojousama"))!;
    const [yumeko, other] = data.characters;
    await generate({ subjectKind: "character", subjectId: yumeko!.id, intent: "portrait" });
    const [view] = await repo.generation.listSubjectImageAttempts({
      kind: "character",
      characterId: yumeko!.id,
    });
    const ref = data.identityRefs.find((x) => x.characterId === yumeko!.id && x.slot === "front");
    if (ref) await repo.upsert(data.project.id, "identityRefs", { ...ref, locked: true });
    else
      await repo.upsert(data.project.id, "identityRefs", {
        id: "locked-front",
        characterId: yumeko!.id,
        slot: "front",
        assetId: null,
        label: "front",
        metadata: {},
        locked: true,
      });
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko!.id, attemptId: view!.attempt.id, slot: "front" }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/locked/) });
    expect(
      await saveAsCharacterReference(
        form({ characterId: other!.id, attemptId: view!.attempt.id, slot: "profile" }),
      ),
    ).toMatchObject({ ok: false, error: "That generated image no longer exists." });
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko!.id, attemptId: "00000000-0000-4000-8000-000000000000", slot: "profile" }),
      ),
    ).toMatchObject({ ok: false, error: "That generated image no longer exists." });
    // queued but not executed: not usable yet
    const r = await startSubjectImage(
      form({
        subjectKind: "character",
        subjectId: yumeko!.id,
        intent: "portrait",
        model: "mock/mock-image-1",
        aspectRatio: "1:1",
      }),
    );
    expect(r).toMatchObject({ ok: true });
    const queued = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: yumeko!.id })
    )[0]!;
    expect(queued.attempt.status).toBe("queued");
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko!.id, attemptId: queued.attempt.id, slot: "profile" }),
      ),
    ).toMatchObject({ ok: false, error: "Only a finished image can be used." });
  });

  it("a Location image becomes a Location reference (the existing Location View action then applies)", async () => {
    const data = (await repo.loadProject("ojousama"))!;
    const location = data.locations.find((l) => !l.locked) ?? data.locations[0]!;
    if (location.locked) await repo.upsert(data.project.id, "locations", { ...location, locked: false });
    await generate({ subjectKind: "location", subjectId: location.id, intent: "establishing_view" });
    const [view] = await repo.generation.listSubjectImageAttempts({
      kind: "location",
      locationId: location.id,
    });
    expect(view!.attempt.status).toBe("succeeded");
    expect(
      await saveAsLocationReference(form({ locationId: location.id, attemptId: view!.attempt.id })),
    ).toMatchObject({
      ok: true,
    });
    const after = (await repo.loadProject("ojousama"))!;
    expect(after.locations.find((l) => l.id === location.id)!.referenceAssetIds).toContain(
      view!.outputs[0]!.asset.id,
    );
  });

  it("refuses an unknown intent or a model the server does not offer, without queuing anything", async () => {
    const data = (await repo.loadProject("ojousama"))!;
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    expect(
      await startSubjectImage(
        form({
          subjectKind: "character",
          subjectId: yumeko.id,
          intent: "location_concept",
          model: "mock/mock-image-1",
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await startSubjectImage(
        form({ subjectKind: "character", subjectId: yumeko.id, intent: "portrait", model: "nope/none" }),
      ),
    ).toMatchObject({ ok: false, error: "That model is not available on this server." });
    expect(
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: yumeko.id }),
    ).toEqual([]);
  });
});
