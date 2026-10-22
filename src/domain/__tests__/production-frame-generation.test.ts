import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  draftGeneratedProductionFrame,
  generatedFramePromotion,
  candidateInputBasis,
  candidateInputStaleness,
  currentProductionFrameAttemptId,
  NEEDS_CONFORM_MESSAGE,
  PRODUCTION_FRAME_REFERENCE,
  REFERENCE_CHANGED_MESSAGE,
  SHOT_CHANGED_MESSAGE,
  type GeneratedFrameCandidate,
} from "@/domain/generated-production-frame";
import { FRESHNESS_PARTS } from "@/domain/fingerprint";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { deriveProductionFrameReferenceCandidates } from "@/domain/generation/compatibility";
import type { Asset } from "@/domain/schemas";
import { seed, shotByCode } from "./helpers";
import { attach, contextOf, draftFor, newUploadAsset, storeImage, T } from "./production-frame-fixtures";

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
    expect(candidateInputStaleness(contextOf(data, "3A"), c.attempt)).toEqual({ changed: [], unknown: true });
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
    if (!p.available) expect(p.changedParts).toEqual(["productionFrameReference"]);
  });

  it("a refinement that is itself the canonical frame is not stale: using it again is the duplicate-promotion path", () => {
    const data = seed();
    const v1Asset = outputAsset(data, { width: 1912, height: 800, label: "v1" });
    data.assets.push(v1Asset);
    const f1 = { ...draftFor(data, "3A", { asset: v1Asset }), version: 1 };
    attach(data, [f1], f1);
    // R was generated FROM v1 and then promoted: v2 is canonical and IS R
    const r = candidateOf(data, { references: [{ role: "production_frame", assetId: v1Asset.id }] });
    data.assets.push(r.original!);
    const f2 = {
      ...draftFor(data, "3A", {
        asset: r.original!,
        source: "generation_output",
        sourceGenerationAttemptId: r.attempt.id,
      }),
      version: 2,
    };
    attach(data, [f1, f2], f2);
    expect(generatedFramePromotion(contextOf(data, "3A"), r).available).toBe(true);
    // ANOTHER refinement of v1 is stale: v2 (not its basis, and not itself) is canonical
    const sibling = candidateOf(data, { references: [{ role: "production_frame", assetId: v1Asset.id }] });
    expect(generatedFramePromotion(contextOf(data, "3A"), sibling)).toMatchObject({
      available: false,
      code: "stale",
      changedParts: ["productionFrameReference"],
    });
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

describe("the candidate input basis (what a candidate was ACTUALLY generated from)", () => {
  it("is reconstructed from the frozen attempt alone: named parts, purpose, and the Production Frame it used", () => {
    const data = seed();
    const v1Asset = outputAsset(data, { width: 1912, height: 800, label: "v1" });
    data.assets.push(v1Asset);
    const f1 = { ...draftFor(data, "3A", { asset: v1Asset }), version: 1 };
    attach(data, [f1], f1);
    const c = candidateOf(data, { references: [{ role: "production_frame", assetId: v1Asset.id }] });
    const frozen = JSON.parse(JSON.stringify(c.attempt)); // only what was persisted
    // what is selected TODAY is irrelevant to the basis: clear the selection entirely
    attach(data, [f1], null);
    const basis = candidateInputBasis(frozen);
    expect(Object.keys(basis.namedParts ?? {}).sort()).toEqual([...FRESHNESS_PARTS].sort());
    expect(basis.productionFrameReference).toEqual({ assetId: v1Asset.id, frameId: f1.id, version: 1 });
    expect((frozen.request as { purpose: string }).purpose).toBe("production_frame");
    // a candidate generated with NO Production Frame input has no frame in its basis, whatever is selected later
    const text = candidateOf(seed());
    expect(candidateInputBasis(text.attempt).productionFrameReference).toBeNull();
  });

  it("is a different identity from provenance.parts.overall (which follows the CURRENT selection)", () => {
    const data = seed();
    const c = candidateOf(data);
    const before = assembleGenerationPackage(contextOf(data, "3A")).provenance.parts.overall;
    const a = outputAsset(data, { width: 1912, height: 800, label: "sel" });
    data.assets.push(a);
    const f = { ...draftFor(data, "3A", { asset: a }), version: 1 };
    attach(data, [f], f);
    const after = assembleGenerationPackage(contextOf(data, "3A")).provenance.parts.overall;
    expect(after).not.toBe(before); // the Shot's production-input identity moved with the selection…
    expect(candidateInputStaleness(contextOf(data, "3A"), c.attempt)).toBeNull(); // …the candidate's basis did not
  });
});

describe("MERGE-CRITICAL: sibling selection never stales siblings", () => {
  it("no frame selected → A/B/C from the same Shot truth → use A → B and C stay fresh, A is current", () => {
    const data = seed();
    const [a, b, c] = ["A", "B", "C"].map((l) =>
      candidateOf(data, { original: outputAsset(data, { width: 1912, height: 800, label: l }) }),
    ) as [GeneratedFrameCandidate, GeneratedFrameCandidate, GeneratedFrameCandidate];
    data.assets.push(a.original!, b.original!, c.original!);
    const drafted = draftGeneratedProductionFrame(contextOf(data, "3A"), a, {
      id: randomUUID(),
      now: T,
      userId: null,
    });
    if (!drafted.ok) throw new Error(drafted.reason);
    const frame = { ...drafted.draft, version: 1 };
    attach(data, [frame], frame);
    const ctx = contextOf(data, "3A");
    expect(currentProductionFrameAttemptId(ctx)).toBe(a.attempt.id);
    for (const sibling of [b, c]) {
      expect(candidateInputStaleness(ctx, sibling.attempt)).toBeNull(); // fresh
      expect(generatedFramePromotion(ctx, sibling).available).toBe(true); // usable without regenerating
    }
  });
});

describe("MERGE-CRITICAL: a change of the REFERENCED Production Frame stales the candidates made from it", () => {
  it("v1 selected → A/B/C generated with v1 as a reference → v2 selected → A/B/C stale and refused", () => {
    const data = seed();
    const v1Asset = outputAsset(data, { width: 1912, height: 800, label: "v1" });
    const v2Asset = outputAsset(data, { width: 1912, height: 800, label: "v2" });
    data.assets.push(v1Asset, v2Asset);
    const f1 = { ...draftFor(data, "3A", { asset: v1Asset }), version: 1 };
    const f2 = { ...draftFor(data, "3A", { asset: v2Asset }), version: 2 };
    attach(data, [f1, f2], f1);
    const made = ["A", "B", "C"].map((l) =>
      candidateOf(data, {
        original: outputAsset(data, { width: 1912, height: 800, label: l }),
        references: [{ role: "production_frame", assetId: v1Asset.id }],
      }),
    );
    for (const m of made) expect(generatedFramePromotion(contextOf(data, "3A"), m).available).toBe(true);

    attach(data, [f1, f2], f2);
    for (const m of made) {
      const p = generatedFramePromotion(contextOf(data, "3A"), m);
      expect(p).toMatchObject({
        available: false,
        code: "stale",
        changedParts: [PRODUCTION_FRAME_REFERENCE],
      });
      if (!p.available) {
        expect(p.reason.startsWith(REFERENCE_CHANGED_MESSAGE)).toBe(true);
        expect(p.reason).toContain("Production Frame reference changed");
      }
    }
  });
});

describe("named-part staleness: every relevant production input stales a candidate (the attempt is never touched)", () => {
  type Mutate = (d: Data) => void;
  const ctx3A = (d: Data) => contextOf(d, "3A");
  const cases: Array<[string, string, Mutate]> = [
    [
      "character identity",
      "characters",
      (d) => {
        const id = ctx3A(d).characters[0]!.character!.id;
        d.characters.find((x) => x.id === id)!.physicalDescription = "now with a scar";
      },
    ],
    [
      "Look / wardrobe",
      "looks",
      (d) => {
        const id = ctx3A(d).characters.find((x) => x.look)!.look!.id;
        d.looks.find((x) => x.id === id)!.wardrobe = "a different coat";
      },
    ],
    ["camera", "camera", (d) => void (shotByCode(d, "3A").composition.lens = "135mm")],
    ["lighting", "lighting", (d) => void (shotByCode(d, "3A").lighting.mood = "harsh noon sun")],
    [
      "location",
      "location",
      (d) => {
        const id = ctx3A(d).location!.id;
        d.locations.find((x) => x.id === id)!.description = "the gate after the storm";
      },
    ],
    ["blocking", "blocking", (d) => void (shotByCode(d, "3A").spatial.subjectBlocking = "she walks away")],
    [
      "performance",
      "performance",
      (d) => {
        const id = ctx3A(d).lines[0]!.line.id;
        d.dialogueLines.find((x) => x.id === id)!.originalText = "A different line.";
      },
    ],
  ];
  it.each(cases)("%s", (_label: string, part: string, mutate: Mutate): void => {
    const data = seed();
    const c = candidateOf(data);
    const frozen = JSON.stringify(c.attempt);
    mutate(data);
    const p = generatedFramePromotion(contextOf(data, "3A"), c);
    expect(p).toMatchObject({ available: false, code: "stale" });
    if (!p.available) {
      expect(p.changedParts).toContain(part);
      expect(p.reason.startsWith(SHOT_CHANGED_MESSAGE)).toBe(true);
    }
    expect(JSON.stringify(c.attempt)).toBe(frozen);
  });
});

describe("Production Frame reference order (deterministic, deduplicated, stored bytes only)", () => {
  it("frame → storyboard → identity → Look → location → lighting → explicit refs; placeholders never sent", () => {
    const data = seed();
    const ctx0 = contextOf(data, "3A");
    // before anything is stored, every seed reference is a placeholder (no bytes): nothing is sent
    expect(deriveProductionFrameReferenceCandidates(assembleGenerationPackage(ctx0))).toEqual([]);
    // give every referenced image real stored facts
    for (const id of Object.keys(assembleGenerationPackage(ctx0).assets)) {
      const a = data.assets.find((x) => x.id === id);
      if (a && (a.type === "image" || a.type === "reference"))
        storeImage(data, id, { width: 800, height: 800 });
    }
    // and one stored image for each remaining role (the seed has none for these)
    const stored = (label: string) => {
      const a = outputAsset(data, { width: 800, height: 800, label });
      data.assets.push(a);
      return a.id;
    };
    const lookId = ctx0.characters.find((x) => x.look)!.look!.id;
    const look = stored("look");
    data.looks.find((x) => x.id === lookId)!.referenceAssetIds = [look];
    const loc = stored("location");
    data.locations.find((x) => x.id === ctx0.location!.id)!.referenceAssetIds = [loc];
    const light = stored("lighting");
    shotByCode(data, "3A").lighting.referenceAssetId = light;
    const explicit = stored("explicit");
    const identity = ctx0.characters.flatMap((c) => c.identityRefs.map((r) => r.assetId))[0]!;
    // an explicit Shot reference that duplicates an identity image is sent ONCE, at its highest priority
    shotByCode(data, "3A").generation.referenceAssetIds = [explicit, identity];
    const pfAsset = outputAsset(data, { width: 1912, height: 800, label: "pf" });
    data.assets.push(pfAsset);
    const f = { ...draftFor(data, "3A", { asset: pfAsset }), version: 1 };
    attach(data, [f], f);

    const refs = deriveProductionFrameReferenceCandidates(assembleGenerationPackage(contextOf(data, "3A")));
    const roles = refs.map((r) => r.role);
    const identities = roles.filter((r) => r === "identity").length;
    expect(identities).toBeGreaterThan(0);
    expect(roles).toEqual([
      "production_frame",
      "storyboard",
      ...Array<string>(identities).fill("identity"),
      "character_look",
      "location",
      "style",
      "other",
    ]);
    expect(refs[0]!.assetId).toBe(pfAsset.id);
    expect(refs.filter((r) => r.assetId === identity)).toHaveLength(1); // deduplicated
    expect(refs.find((r) => r.assetId === identity)!.role).toBe("identity"); // at its highest priority
    expect(refs.at(-1)!.assetId).toBe(explicit);
    // deterministic
    expect(
      deriveProductionFrameReferenceCandidates(assembleGenerationPackage(contextOf(data, "3A"))),
    ).toEqual(refs);
  });
});

describe("CURRENT PRODUCTION FRAME derives only from the selected frame's source attempt", () => {
  it("follows selection and reselection, never Best, approval or recency", () => {
    const data = seed();
    const a = candidateOf(data, { original: outputAsset(data, { width: 1912, height: 800, label: "A" }) });
    const b = candidateOf(data, { original: outputAsset(data, { width: 1912, height: 800, label: "B" }) });
    data.assets.push(a.original!, b.original!);
    const da = draftGeneratedProductionFrame(contextOf(data, "3A"), a, {
      id: randomUUID(),
      now: T,
      userId: null,
    });
    const db = draftGeneratedProductionFrame(contextOf(data, "3A"), b, {
      id: randomUUID(),
      now: T,
      userId: null,
    });
    if (!da.ok || !db.ok) throw new Error("draft refused");
    const fa = { ...da.draft, version: 1 };
    const fb = { ...db.draft, version: 2 };
    expect(currentProductionFrameAttemptId(contextOf(data, "3A"))).toBeNull();
    attach(data, [fa, fb], fb);
    expect(currentProductionFrameAttemptId(contextOf(data, "3A"))).toBe(b.attempt.id);
    attach(data, [fa, fb], fa); // reselect the older frame: the badge moves with it
    expect(currentProductionFrameAttemptId(contextOf(data, "3A"))).toBe(a.attempt.id);
    attach(data, [fa, fb], null);
    expect(currentProductionFrameAttemptId(contextOf(data, "3A"))).toBeNull();
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
