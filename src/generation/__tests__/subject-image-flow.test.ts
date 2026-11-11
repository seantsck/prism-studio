import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildSubjectImagePlan } from "@/domain/generation/subject-image";
import { createRegistry } from "../registry";
import { readGenerationConfig } from "../config";
import { prepareSubjectImage } from "../subject-submission";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 5B-I1: Character / Location images run on the EXISTING pipeline (memory twin, free mock image models, the real
 * worker and sink): request → queue → worker → provider (mock) → stored output with provenance → listed per subject.
 * The Shot history never sees them.
 */
vi.setConfig({ testTimeout: 60_000 });

async function drain(h: Harness, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

async function start(
  h: Harness,
  subject: Parameters<typeof prepareSubjectImage>[0]["input"]["subject"],
  key = `subject-${randomUUID()}`,
) {
  const data = await h.data();
  const prepared = prepareSubjectImage({
    data,
    input: { subject, direction: "warm, confident" },
    registry: h.registry,
    provider: "mock",
    modelId: "mock-image-1",
    aspectRatio: "1:1",
    userId: null,
    idempotencyKey: key,
    config: h.config,
    now: h.clock.now,
  });
  if (!prepared.ok) throw new Error(prepared.reasons.join(" · "));
  return { prepared, created: await h.repo.generation.createSubjectImageAttempt(prepared.input) };
}

describe("5B-I1 Character / Location images on the existing generation pipeline", () => {
  it("a Character portrait is queued, executed by the worker and stored with provenance; Shot history is untouched", async () => {
    const h = makeHarness();
    const data = await h.data();
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    const shotAttemptsBefore = data.attempts.length;

    const { created } = await start(h, { kind: "character", characterId: yumeko.id, intent: "portrait" });
    expect(created.attempt).toMatchObject({
      shotId: null,
      characterId: yumeko.id,
      locationId: null,
      attemptNumber: 1,
    });
    expect(created.attempt.request).toMatchObject({ purpose: "character_image", modality: "text_to_image" });
    await drain(h);

    const [view] = await h.repo.generation.listSubjectImageAttempts({
      kind: "character",
      characterId: yumeko.id,
    });
    expect(view!.attempt.status).toBe("succeeded");
    expect(view!.job?.status).toBe("succeeded");
    expect(view!.outputs).toHaveLength(1);
    const asset = view!.outputs[0]!.asset;
    expect(asset).toMatchObject({
      projectId: data.project.id,
      purpose: "generation_output",
      source: "provider_output",
    });
    expect((asset.metadata as { generation?: { attemptId?: string } }).generation?.attemptId).toBe(
      view!.attempt.id,
    );
    expect(asset.objectPath).toBeTruthy();
    expect(asset.checksum).toMatch(/^[0-9a-f]{64}$/);

    const after = await h.data();
    expect(after.attempts.length, "the Shot history never contains a subject attempt").toBe(
      shotAttemptsBefore,
    );
    expect(
      after.assets.some((a) => a.id === asset.id),
      "the output is a real project Asset",
    ).toBe(true);
    expect(view!.costs.find((c) => c.kind === "estimated")).toBeTruthy();
  });

  it("is idempotent by key and numbered per subject; Locations work the same way", async () => {
    const h = makeHarness();
    const data = await h.data();
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    const location = data.locations[0]!;
    const key = `subject-${randomUUID()}`;
    const first = await start(h, { kind: "character", characterId: yumeko.id, intent: "portrait" }, key);
    const replay = await h.repo.generation.createSubjectImageAttempt(
      first.prepared.ok ? first.prepared.input : (null as never),
    );
    expect(replay.duplicate).toBe(true);
    expect(replay.attempt.id).toBe(first.created.attempt.id);
    await drain(h);
    const second = await start(h, { kind: "character", characterId: yumeko.id, intent: "look_sheet" });
    expect(second.created.attempt.attemptNumber).toBe(2);
    const loc = await start(h, { kind: "location", locationId: location.id, intent: "location_concept" });
    expect(loc.created.attempt).toMatchObject({
      locationId: location.id,
      characterId: null,
      attemptNumber: 1,
    });
    expect(loc.created.attempt.request).toMatchObject({ purpose: "location_image" });
    await drain(h);
    const views = await h.repo.generation.listSubjectImageAttempts({
      kind: "location",
      locationId: location.id,
    });
    expect(views.map((v) => v.attempt.status)).toEqual(["succeeded"]);
  });

  it("refuses a subject that is not in the project (no row is written)", async () => {
    const h = makeHarness();
    const data = await h.data();
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    const { prepared } = await start(h, { kind: "character", characterId: yumeko.id, intent: "portrait" });
    if (!prepared.ok) throw new Error("unreachable");
    const foreign = {
      ...prepared.input,
      attempt: { ...prepared.input.attempt, id: randomUUID(), characterId: randomUUID() },
      job: { ...prepared.input.job, id: randomUUID(), idempotencyKey: `subject-${randomUUID()}` },
    };
    await expect(h.repo.generation.createSubjectImageAttempt(foreign)).rejects.toThrow(
      /character no longer exists/,
    );
    expect(() =>
      buildSubjectImagePlan(data, {
        subject: { kind: "location", locationId: randomUUID(), intent: "background" },
        direction: "",
      }),
    ).toThrow(/location no longer exists/);
  });

  it("the spend gate refuses a paid model while paid generation is off; nothing is queued", async () => {
    const env = {
      NODE_ENV: "test",
      PRISM_STUDIO_GENERATION_PROVIDERS: "mock,runway",
      PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
      RUNWAYML_API_SECRET: "key_test_not_a_real_secret_value",
      PRISM_STUDIO_ALLOW_PAID_GENERATION: "false",
    };
    const config = readGenerationConfig(env);
    const registry = createRegistry(env, config);
    const h = makeHarness();
    const data = await h.data();
    const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
    const prepared = prepareSubjectImage({
      data,
      input: { subject: { kind: "character", characterId: yumeko.id, intent: "portrait" }, direction: "" },
      registry,
      provider: "runway",
      modelId: "gpt_image_2_5_flare",
      aspectRatio: null,
      userId: null,
      idempotencyKey: `subject-${randomUUID()}`,
      config,
    });
    expect(prepared.ok).toBe(false);
    expect(!prepared.ok && prepared.reasons.join(" ")).toMatch(/Paid generation is switched off/);
  });

  it("customer-facing environments never offer the failure-simulation mocks", () => {
    const ids = createRegistry({
      NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT: "production",
      PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
      PRISM_STUDIO_GENERATION_PROVIDERS: "mock",
    })
      .models()
      .map((m) => m.modelId);
    expect(ids).not.toContain("mock-video-flaky");
  });
});
