// Disposable, SYNTHETIC continuity fixture for the first live analyzer smoke test.
//
// Two tiny synthetic images (no real people, no copyrighted material, not the canonical drama):
//   - an expected character reference ("Synthetic A")
//   - one output frame that either MATCHES that reference (same image) or MISMATCHES it (different image)
// Exactly two analyzer criteria result (identity + wardrobe). Image set only: no video.
import { createHash, randomUUID } from "node:crypto";
import type { AttemptView } from "../../src/data/generation-repository";
import { buildSeedProject } from "../../src/data/seed";
import { buildShotContext } from "../../src/domain/context";
import { generationAttemptSchema, type Asset, type ProjectData } from "../../src/domain/schemas";
import { emptyShot } from "../../src/domain/shot-defaults";
import { encodeMockPng } from "../../src/generation/providers/mock-image";
import { buildObjectPath } from "../../src/lib/storage-paths";

export const FIXTURE_SLUG = "continuity-smoke-test";

export interface SyntheticFixture {
  data: ProjectData;
  view: AttemptView;
  bytes: Map<string, Uint8Array>;
  shotId: string;
  attemptId: string;
}

export function buildSyntheticFixture(opts: { userId: string; mismatch?: boolean }): SyntheticFixture {
  const demo = buildSeedProject();
  const now = new Date().toISOString();
  const PID = randomUUID();
  const EP = randomUUID();
  const SC = randomUUID();
  const SH = randomUUID();
  const CH = randomUUID();
  const LK = randomUUID();
  const AT = randomUUID();
  const bytes = new Map<string, Uint8Array>();

  const asset = (name: string, purpose: Asset["purpose"], source: Asset["source"], seed: number): Asset => {
    const id = randomUUID();
    const png = encodeMockPng(512, 288, seed);
    bytes.set(id, png);
    return {
      ...demo.assets.find((a) => a.type === "image")!,
      id,
      projectId: PID,
      name,
      originalFilename: name,
      mime: "image/png",
      type: "image",
      purpose,
      source,
      width: 512,
      height: 288,
      durationMs: null,
      byteSize: png.length,
      checksum: createHash("sha256").update(png).digest("hex"),
      storageProvider: "supabase",
      bucket: "prism-assets",
      objectPath: buildObjectPath(PID, id, name),
      tags: ["continuity-smoke"],
      metadata: {},
      createdBy: opts.userId,
      createdAt: now,
      updatedAt: now,
    };
  };
  // Character A: seed 11. A "matching" output reuses the same pixels; a mismatch uses different pixels.
  const identity = asset("synthetic-a-identity.png", "identity_ref", "upload", 11);
  const lookRef = asset("synthetic-a-look.png", "look_ref", "upload", 11);
  const output = asset(
    "synthetic-a-output.png",
    "generation_output",
    "provider_output",
    opts.mismatch ? 97 : 11,
  );

  const project = {
    ...demo.project,
    id: PID,
    userId: opts.userId,
    title: "ZZ Continuity analysis smoke test (disposable)",
    slug: FIXTURE_SLUG,
    description:
      "Disposable synthetic fixture for the first live continuity-analysis smoke test. Safe to delete.",
    genre: "",
    tone: "",
    createdAt: now,
    updatedAt: now,
  };
  const bible = {
    ...demo.bible,
    projectId: PID,
    premise: "Disposable smoke-test project.",
    genre: "",
    tone: "",
    visualStyle: "",
    cinematographyRules: [],
    colorLanguage: "",
    canonFacts: [],
    continuityRules: [],
    guardrails: [],
    aspectRatio: "16:9",
    updatedAt: now,
  };
  const character = {
    ...demo.characters[0]!,
    id: CH,
    projectId: PID,
    name: "Synthetic A",
    role: "test",
    description: "",
    personality: "",
    behaviorNotes: "",
    physicalDescription: "A synthetic test character shown by the supplied reference image.",
    continuityRules: [],
    signatureBehavior: "",
    relationshipNotes: "",
    createdAt: now,
    updatedAt: now,
  };
  const identityRef = {
    ...demo.identityRefs[0]!,
    id: randomUUID(),
    characterId: CH,
    assetId: identity.id,
    label: "Synthetic A reference",
    locked: true,
  };
  const look = {
    ...demo.looks[0]!,
    id: LK,
    projectId: PID,
    characterId: CH,
    episodeId: null,
    name: "Synthetic Look",
    wardrobe: "the outfit shown in the reference image",
    shoes: "",
    jewelry: "",
    hair: "",
    makeup: "",
    grooming: "",
    bodyNotes: "",
    accessories: "",
    referenceAssetIds: [lookRef.id],
    locked: true,
  };
  const episode = {
    ...demo.episodes[0]!,
    id: EP,
    projectId: PID,
    title: "Smoke",
    order: 1,
    createdAt: now,
    updatedAt: now,
  };
  const scene = {
    ...demo.scenes[0]!,
    id: SC,
    projectId: PID,
    episodeId: EP,
    sceneNumber: "1",
    slugline: "INT. TEST ROOM - DAY",
    summary: "A synthetic test frame.",
    dramaticPurpose: "",
    emotionEntering: "",
    emotionLeaving: "",
    scriptRange: null,
    characterIds: [CH],
    propIds: [],
    locationId: null,
    continuityNotes: "",
    order: 1,
  };
  const base = emptyShot({
    id: SH,
    projectId: PID,
    episodeId: EP,
    sceneId: SC,
    shotCode: "SMOKE-A",
    title: "Synthetic frame",
    order: 1,
  });
  const shot = {
    ...base,
    storyBeat: "A synthetic frame for a continuity smoke test.",
    durationMode: "manual" as const,
    targetDurationMs: 2000,
    characters: [
      {
        characterId: CH,
        lookId: LK,
        performanceNotes: "",
        expression: "",
        posture: "",
        gestures: "",
        physicalInteractions: "",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const attempt = generationAttemptSchema.parse({
    id: AT,
    projectId: PID,
    shotId: SH,
    attemptNumber: 1,
    provider: "mock",
    model: "continuity-smoke-fixture",
    modality: "image",
    prompt: "",
    negativePrompt: "",
    packageSnapshot: {},
    packageFingerprint: "fixture",
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: output.id,
    costUsd: null,
    durationMs: null,
    status: "succeeded",
    reviewStatus: "unreviewed",
    rejectionCategories: [],
    reviewedAt: null,
    rejectionReason: "",
    notes: "",
    approved: false,
    requestModality: null,
    promptPlan: null,
    request: null,
    compatibility: null,
    acknowledgedIgnored: [],
    adaptationPlan: null,
    createdBy: opts.userId,
    createdAt: now,
  });
  const data: ProjectData = {
    ...demo,
    project,
    bible,
    assets: [identity, lookRef, output],
    characters: [character],
    identityRefs: [identityRef],
    looks: [look],
    voiceProfiles: [],
    locations: [],
    props: [],
    episodes: [episode],
    scenes: [scene],
    shots: [shot],
    dialogueLines: [],
    actionBlocks: [],
    directions: [],
    takes: [],
    frames: [],
    attempts: [attempt],
    continuityChecks: [],
  } as ProjectData;
  void buildShotContext;
  const view: AttemptView = {
    attempt,
    job: null,
    outputs: [
      {
        output: {
          id: randomUUID(),
          projectId: PID,
          attemptId: AT,
          assetId: output.id,
          role: "primary",
          position: 0,
          provenance: {},
          createdAt: now,
        },
        asset: output,
      },
    ],
    costs: [],
  };
  return { data, view, bytes, shotId: SH, attemptId: AT };
}
