import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  draftGeneratedProductionFrame,
  generatedFramePromotion,
  generatedFrameStaleness,
  NEEDS_CONFORM_MESSAGE,
  SHOT_CHANGED_MESSAGE,
  type GeneratedFrameCandidate,
} from "@/domain/generated-production-frame";
import { assembleGenerationPackage } from "@/domain/generation-package";
import type { Asset } from "@/domain/schemas";
import { seed, shotByCode } from "./helpers";
import { attach, contextOf, draftFor, newUploadAsset, T } from "./production-frame-fixtures";

/**
 * Phase 2G.2: when may a GENERATED still become the Shot's Production Frame? Pure rules. Everything is fictional, in
 * memory, and needs no provider, no GPU and no 3D set.
 */

type Data = ReturnType<typeof seed>;

/** A provider output / conform Asset as ingestion would store it. */
function outputAsset(
  data: Data,
  o: { width: number; height: number; label: string; derived?: boolean },
): Asset {
  const a = newUploadAsset(data.project.id, { width: o.width, height: o.height, label: o.label });
  return {
    ...a,
    purpose: "generation_output",
    source: o.derived ? "derived" : "provider_output",
    createdAt: T,
  };
}

/** A succeeded Production Frame candidate frozen from the Shot's CURRENT state. */
function candidateOf(
  data: Data,
  o: {
    code?: string;
    original?: Asset | null;
    delivery?: Asset | null;
    id?: string;
    purpose?: "production_frame" | "shot_output";
    status?: string;
    references?: Array<{ role: string; assetId: string }>;
  } = {},
): GeneratedFrameCandidate {
  const code = o.code ?? "3A";
  const ctx = contextOf(data, code);
  const pkg = assembleGenerationPackage(ctx);
  return {
    attempt: {
      id: o.id ?? randomUUID(),
      projectId: ctx.project.id,
      shotId: ctx.shot.id,
      status: (o.status ?? "succeeded") as never,
      request: {
        ...(o.purpose === "shot_output" ? {} : { purpose: "production_frame" }),
        references: o.references ?? [],
      },
      packageSnapshot: JSON.parse(JSON.stringify(pkg)),
      packageFingerprint: pkg.provenance.fingerprint,
    },
    original:
      o.original === undefined ? outputAsset(data, { width: 1912, height: 800, label: "o" }) : o.original,
    delivery: o.delivery ?? null,
  };
}

describe("Use as Production Frame — which stored image becomes the frame", () => {
  it("a provider original that already matches the production aspect is used directly", () => {
    const data = seed();
    const c = candidateOf(data);
    const p = generatedFramePromotion(contextOf(data, "3A"), c);
    expect(p).toMatchObject({ available: true, image: { role: "provider_original" } });
    if (p.available) expect(p.image.asset.id).toBe(c.original!.id);
  });

  it("a wrong-aspect provider original is refused until the production conform exists: never a silent crop", () => {
    const data = seed();
    const wrong = outputAsset(data, { width: 1920, height: 1080, label: "169" }); // 16:9 for a 2.39:1 Shot
    const c = candidateOf(data, { original: wrong });
    const p = generatedFramePromotion(contextOf(data, "3A"), c);
    expect(p).toMatchObject({ available: false, code: "needs_conform", reason: NEEDS_CONFORM_MESSAGE });
    expect(NEEDS_CONFORM_MESSAGE).toBe("Create the production conform first.");
    // the draft is refused with the same truthful reason, and nothing was created
    const d = draftGeneratedProductionFrame(contextOf(data, "3A"), c, {
      id: randomUUID(),
      now: T,
      userId: null,
    });
    expect(d).toMatchObject({ ok: false, code: "needs_conform" });
  });

  it("the selected delivery conform (production-shaped) is used instead of the wrong-shaped original", () => {
    const data = seed();
    const wrong = outputAsset(data, { width: 1920, height: 1080, label: "169" });
    const conform = outputAsset(data, { width: 1920, height: 803, label: "conform", derived: true });
    const c = candidateOf(data, { original: wrong, delivery: conform });
    const p = generatedFramePromotion(contextOf(data, "3A"), c);
    expect(p).toMatchObject({ available: true, image: { role: "delivery_conform" } });
    if (p.available) expect(p.image.asset.id).toBe(conform.id);
  });

  it("a wrong-aspect delivery does not rescue a wrong-aspect original", () => {
    const data = seed();
    const wrong = outputAsset(data, { width: 1920, height: 1080, label: "169" });
    const alsoWrong = outputAsset(data, { width: 1000, height: 1000, label: "sq", derived: true });
    const p = generatedFramePromotion(
      contextOf(data, "3A"),
      candidateOf(data, { original: wrong, delivery: alsoWrong }),
    );
    expect(p).toMatchObject({ available: false, code: "needs_conform" });
  });

  it("drafts through the ONE shared draftProductionFrame, as generation_output with the attempt id", () => {
    const data = seed();
    const c = candidateOf(data);
    const ctx = contextOf(data, "3A");
    const d = draftGeneratedProductionFrame(ctx, c, { id: randomUUID(), now: T, userId: null });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.draft).toMatchObject({
      source: "generation_output",
      sourceGenerationAttemptId: c.attempt.id,
      sourceStoryboardFrameId: null,
      sourceMasterFrameId: null,
      assetId: c.original!.id, // the existing Asset: no copy
      width: 1912,
      height: 800,
    });
    // identical to what drafting the same image directly produces (no second drafting implementation)
    const direct = draftFor(data, "3A", {
      asset: c.original!,
      source: "generation_output",
      sourceGenerationAttemptId: c.attempt.id,
      id: d.draft.id,
    });
    expect(d.draft).toEqual(direct);
  });
});

describe("Use as Production Frame — the stale-candidate rule", () => {
  it("refuses a candidate once the Shot's intent changed, names the changed part and keeps the attempt untouched", () => {
    const data = seed();
    const c = candidateOf(data);
    const before = JSON.stringify(c.attempt);
    shotByCode(data, "3A").composition.lens = "135mm"; // the camera changed after generation
    const p = generatedFramePromotion(contextOf(data, "3A"), c);
    expect(p).toMatchObject({ available: false, code: "stale" });
    if (p.available) return;
    expect(p.reason.startsWith(SHOT_CHANGED_MESSAGE)).toBe(true);
    expect(SHOT_CHANGED_MESSAGE).toBe(
      "The Shot changed after this candidate was generated. Regenerate it from the current Production Frame intent before using it.",
    );
    expect(p.changedParts).toContain("camera");
    expect(JSON.stringify(c.attempt)).toBe(before); // never rewritten: it stays valid history
  });

  it("regenerating from the current Shot works again", () => {
    const data = seed();
    shotByCode(data, "3A").composition.lens = "135mm";
    const fresh = candidateOf(data); // frozen AFTER the change
    expect(generatedFramePromotion(contextOf(data, "3A"), fresh).available).toBe(true);
  });

  it("an unverifiable snapshot is never treated as fresh", () => {
    const data = seed();
    const c = candidateOf(data);
    (c.attempt as { packageSnapshot: unknown }).packageSnapshot = {};
    expect(generatedFrameStaleness(contextOf(data, "3A"), c.attempt)).toEqual({ changed: [], unknown: true });
    expect(generatedFramePromotion(contextOf(data, "3A"), c)).toMatchObject({
      available: false,
      code: "stale",
    });
  });

  it("a candidate that used Production Frame v1 as its reference stays valid while v1 is canonical and is stale once v2 is", () => {
    const data = seed();
    const v1Asset = outputAsset(data, { width: 1912, height: 800, label: "v1" });
    const v2Asset = outputAsset(data, { width: 1912, height: 800, label: "v2" });
    data.assets.push(v1Asset, v2Asset);
    const f1 = { ...draftFor(data, "3A", { asset: v1Asset }), version: 1 };
    const f2 = { ...draftFor(data, "3A", { asset: v2Asset }), version: 2 };
    attach(data, [f1, f2], f1);

    // generated FROM v1 (it was an image reference, and v1 was canonical at the time)
    const c = candidateOf(data, { references: [{ role: "production_frame", assetId: v1Asset.id }] });
    expect(generatedFramePromotion(contextOf(data, "3A"), c).available).toBe(true); // still v1: proceeds

    attach(data, [f1, f2], f2); // the human switched to v2 before promoting
    const p = generatedFramePromotion(contextOf(data, "3A"), c);
    expect(p).toMatchObject({ available: false, code: "stale" });
    if (!p.available) expect(p.changedParts).toEqual(["productionFrame"]);
  });

  it("choosing candidate A does not make its sibling B stale (same intent; the human may still choose B)", () => {
    const data = seed();
    const a = candidateOf(data, { original: outputAsset(data, { width: 1912, height: 800, label: "A" }) });
    const b = candidateOf(data, { original: outputAsset(data, { width: 1912, height: 800, label: "B" }) });
    const ctx0 = contextOf(data, "3A");
    const first = draftGeneratedProductionFrame(ctx0, a, { id: randomUUID(), now: T, userId: null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    data.assets.push(a.original!, b.original!);
    attach(data, [{ ...first.draft, version: 1 }], { ...first.draft, version: 1 });
    // A is now canonical: the Shot's selection part exists, B was generated without it
    expect(generatedFramePromotion(contextOf(data, "3A"), b).available).toBe(true);
    // and A itself is still promotable (re-selecting it is the duplicate-promotion path)
    expect(generatedFramePromotion(contextOf(data, "3A"), a).available).toBe(true);
  });
});

describe("Use as Production Frame — what a candidate must be", () => {
  it("only a succeeded production_frame attempt with a still-image output of this Shot and Project", () => {
    const data = seed();
    const ctx = contextOf(data, "3A");
    expect(generatedFramePromotion(ctx, candidateOf(data, { purpose: "shot_output" }))).toMatchObject({
      available: false,
      code: "not_production_frame_candidate",
    });
    expect(generatedFramePromotion(ctx, candidateOf(data, { status: "failed" }))).toMatchObject({
      available: false,
      code: "not_succeeded",
    });
    expect(generatedFramePromotion(ctx, candidateOf(data, { original: null }))).toMatchObject({
      available: false,
      code: "no_output",
    });
    const video = { ...outputAsset(data, { width: 1912, height: 800, label: "v" }), type: "video" as const };
    expect(generatedFramePromotion(ctx, candidateOf(data, { original: video }))).toMatchObject({
      available: false,
      code: "not_image",
    });
  });

  it("cross-Shot and cross-Project candidates are refused", () => {
    const data = seed();
    const ctx = contextOf(data, "3A");
    const otherShot = candidateOf(data, { code: "5A" });
    expect(generatedFramePromotion(ctx, otherShot)).toMatchObject({ available: false, code: "other_shot" });

    const other = seed();
    const foreign = candidateOf(other, {
      original: outputAsset(other, { width: 1912, height: 800, label: "x" }),
    });
    // an attempt of another project (different project id) can never become this project's frame
    const mixed: GeneratedFrameCandidate = {
      ...foreign,
      attempt: { ...foreign.attempt, projectId: randomUUID() },
    };
    expect(generatedFramePromotion(ctx, mixed)).toMatchObject({ available: false, code: "other_project" });
    // an output Asset of another project is refused too
    const wrongAsset: GeneratedFrameCandidate = {
      ...candidateOf(data),
      original: { ...outputAsset(data, { width: 1912, height: 800, label: "z" }), projectId: randomUUID() },
    };
    expect(generatedFramePromotion(ctx, wrongAsset)).toMatchObject({ available: false, code: "no_output" });
  });

  it("the legacy attempt.approved flag is not an input: the same candidate gets the same answer either way", () => {
    const data = seed();
    const base = candidateOf(data);
    const approved: GeneratedFrameCandidate = {
      ...base,
      attempt: { ...base.attempt, approved: true } as never,
    };
    const ctx = contextOf(data, "3A");
    expect(generatedFramePromotion(ctx, approved)).toEqual(generatedFramePromotion(ctx, base));
  });
});
