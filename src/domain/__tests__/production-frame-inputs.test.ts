import { describe, expect, it } from "vitest";
import type { GenerationPackage } from "../generation-package";
import {
  deriveProductionFrameReferenceCandidates,
  evaluateCompatibility,
  productionFrameReferenceTiers,
} from "../generation/compatibility";
import { productionFrameInputs } from "../generation/production-frame-inputs";
import { buildSeedProject } from "../../data/seed";
import { readGenerationConfig } from "../../generation/config";
import { createRegistry } from "../../generation/registry";
import { buildShotContext } from "../context";
import { assembleGenerationPackage } from "../generation-package";

/** Phase 5B-I6 (pure): tiers with a Character Continuity Lock, and the limit rules around them. */
const img = (id: string) => ({ id, type: "image", objectPath: `p/${id}`, checksum: "c" });

function lockedPkg(): GenerationPackage {
  const ids = ["lock-front", "lock-profile", "lock-look", "view", "loc-canon", "shot-ref"];
  const data = buildSeedProject();
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const real = assembleGenerationPackage(
    buildShotContext(
      {
        ...data,
        shots: data.shots.map((s) =>
          s.id === shot.id ? { ...s, composition: { ...s.composition, aspectRatio: "16:9" } } : s,
        ),
      },
      shot.id,
    ),
    new Date("2026-11-08T00:00:00Z"),
  );
  return {
    ...real,
    assets: Object.fromEntries(ids.map((id) => [id, img(id)])),
    characters: [
      {
        ...real.characters[0]!,
        characterId: "y",
        name: "Yumeko",
        identityReferenceAssetIds: ["lock-front", "lock-profile"],
        look: { name: "Formal", referenceAssetIds: ["lock-look"] },
        canonicalIdentityAssetId: "ignored-with-a-lock",
        continuityLock: { lockId: "L", name: "Ep1", lockFingerprint: "f" },
      },
    ],
    set: {
      ...real.set!,
      name: "Lobby",
      referenceAssetIds: [],
      visualReferences: [{ assetId: "loc-canon", kind: "canonical", label: "Lobby canonical location" }],
    },
    lighting: { ...real.lighting, referenceAssetId: null },
    references: {
      ...real.references,
      approvedStoryboardFrame: null,
      productionFrame: undefined,
      referenceAssetIds: ["shot-ref"],
      locationView: { assetId: "view", name: "Entrance" },
      characterContinuity: [
        {
          characterId: "y",
          characterName: "Yumeko",
          lockId: "L",
          name: "Ep1",
          facts: { look: { name: "Formal" } },
          references: [
            { position: 0, role: "identity", identitySlot: "front", label: "f", assetId: "lock-front" },
            { position: 1, role: "identity", identitySlot: "profile", label: "p", assetId: "lock-profile" },
            { position: 2, role: "look", identitySlot: null, label: "l", assetId: "lock-look" },
          ],
        },
      ],
    },
  } as unknown as GenerationPackage;
}

const ENV = { NODE_ENV: "test", PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1" };
const model = (max: number) => {
  const m = structuredClone(createRegistry(ENV, readGenerationConfig(ENV)).model("mock", "mock-image-1")!);
  m.capabilities.references.maxReferences = max;
  return m;
};

describe("5B-I6 reference tiers", () => {
  it("a Continuity Lock: its first identity and Look images are essential, the rest frozen, in frozen order", () => {
    const pkg = lockedPkg();
    expect(deriveProductionFrameReferenceCandidates(pkg).map((c) => c.assetId)).toEqual([
      "lock-front",
      "lock-profile",
      "lock-look",
      "view",
      "loc-canon",
      "shot-ref",
    ]);
    expect(Object.fromEntries(productionFrameReferenceTiers(pkg))).toEqual({
      "lock-front": "essential",
      "lock-profile": "frozen",
      "lock-look": "essential",
      view: "essential",
      "loc-canon": "optional",
      "shot-ref": "explicit",
    });
    expect(productionFrameInputs(pkg).characters[0]!.lines[0]).toBe('Yumeko — Continuity Lock "Ep1"');
  });

  it("at the limit only OPTIONAL images go; frozen Lock images and explicit Shot references are never dropped", () => {
    const pkg = lockedPkg();
    const five = evaluateCompatibility(pkg, model(5), { purpose: "production_frame" });
    expect(five.errors.map((e) => e.id)).not.toContain("references.too_many");
    expect(five.used.references.map((r) => r.assetId)).toEqual([
      "lock-front",
      "lock-profile",
      "lock-look",
      "view",
      "shot-ref",
    ]);
    // 4: the frozen profile / the Shot reference cannot go: the existing "Reduce references" refusal (no truncation)
    const four = evaluateCompatibility(pkg, model(4), { purpose: "production_frame" });
    expect(four.errors.find((e) => e.id === "references.too_many")?.message).toMatch(
      /Reduce references in Shot Prep/,
    );
    // 2: even the essentials (3) do not fit
    const two = evaluateCompatibility(pkg, model(2), { purpose: "production_frame" });
    expect(two.errors.find((e) => e.id === "references.too_many")?.message).toBe(
      "This model supports 2 references, but this Shot requires 3 essential references.",
    );
    // other purposes keep their own rules (no tiers recorded)
    const video = evaluateCompatibility(pkg, model(8), {});
    expect(video.inputs.some((i) => "tier" in i)).toBe(false);
  });
});
