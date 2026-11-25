import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareCoverArt } from "../cover-submission";
import { makeHarness, type Harness } from "./helpers";

/**
 * Editing a cover picture: the picture is sent FIRST as "the image to edit" with the creator's instruction (the cast's
 * pictures follow), on the existing pipeline. The result is a NEW cover take; the picture edited is never changed.
 */
vi.setConfig({ testTimeout: 60_000 });

async function drain(h: Harness, rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

const base = (h: Harness) => ({
  registry: h.registry,
  provider: "mock",
  modelId: "mock-image-1",
  aspectRatio: "1:1",
  userId: null,
  config: h.config,
  now: h.clock.now,
});

async function makeCover(h: Harness) {
  const prepared = prepareCoverArt({
    ...base(h),
    data: await h.data(),
    input: { direction: "rainy neon street" },
    idempotencyKey: `cover-${randomUUID()}`,
  });
  if (!prepared.ok) throw new Error(prepared.reasons.join(" · "));
  await h.repo.generation.createSubjectImageAttempt(prepared.input);
  await drain(h);
  const data = await h.data();
  const [view] = await h.repo.generation.listSubjectImageAttempts({ kind: "cover", projectId: data.project.id });
  expect(view!.attempt.status).toBe("succeeded");
  return view!.outputs[0]!.asset;
}

describe("editing a cover picture", () => {
  it("sends the picture first with the instruction and makes a new take; the source is untouched", async () => {
    const h = makeHarness();
    const source = await makeCover(h);
    const data = await h.data();
    const before = data.assets.find((a) => a.id === source.id)!;
    const prepared = prepareCoverArt({
      ...base(h),
      data,
      input: { direction: "" },
      idempotencyKey: `cover-edit-${randomUUID()}`,
      edit: { sourceAssetId: source.id, instruction: "  Put them under one umbrella.  " },
    });
    if (!prepared.ok) throw new Error(prepared.reasons.join(" · "));
    const a = prepared.input.attempt;
    const request = a.request as {
      modality: string;
      references: Array<{ assetId: string; order: number; label: string }>;
      providerOptions: Record<string, string>;
      prompt: { positive: string };
    };
    expect(request.modality).toBe("image_to_image");
    expect(request.references[0]).toMatchObject({ assetId: source.id, order: 0, label: "the image to edit" });
    expect(request.providerOptions.prismImageOperation, "an edit is not a new picture from references").toBe(
      undefined,
    );
    expect(request.prompt.positive).toContain("Edit the first image: Put them under one umbrella.");
    expect(a.inputAssetIds).toContain(source.id);
    expect(a.projectCover).toBe(true);
    expect(a.modelSettings).toMatchObject({
      operation: "edit",
      editSourceAssetId: source.id,
      composer: { edit: "Put them under one umbrella." },
    });
    expect(a.packageSnapshot).toMatchObject({
      edit: { sourceAssetId: source.id, instruction: "Put them under one umbrella." },
    });

    await h.repo.generation.createSubjectImageAttempt(prepared.input);
    await drain(h);
    const after = await h.data();
    const views = await h.repo.generation.listSubjectImageAttempts({ kind: "cover", projectId: data.project.id });
    expect(views).toHaveLength(2);
    const edited = views.find((v) => v.attempt.id === a.id)!;
    expect(edited.attempt.status).toBe("succeeded");
    expect(edited.outputs[0]!.asset.id).not.toBe(source.id);
    expect(after.assets.find((x) => x.id === source.id), "the picture edited is never changed").toEqual(before);
  });

  it("refuses an empty instruction and a picture that is not in the project; nothing is prepared", async () => {
    const h = makeHarness();
    const source = await makeCover(h);
    const data = await h.data();
    const empty = prepareCoverArt({
      ...base(h),
      data,
      input: { direction: "" },
      idempotencyKey: `cover-edit-${randomUUID()}`,
      edit: { sourceAssetId: source.id, instruction: "   " },
    });
    expect(empty.ok).toBe(false);
    expect(!empty.ok && empty.reasons[0]).toMatch(/Say what to change/);
    const foreign = prepareCoverArt({
      ...base(h),
      data,
      input: { direction: "" },
      idempotencyKey: `cover-edit-${randomUUID()}`,
      edit: { sourceAssetId: randomUUID(), instruction: "make it night" },
    });
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.reasons[0]).toMatch(/no longer in this project/);
  });
});
