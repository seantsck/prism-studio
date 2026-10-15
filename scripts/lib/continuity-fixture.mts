// Disposable, SYNTHETIC continuity fixtures for live analyzer smoke tests (never the canonical drama, no real
// or public person, no copyrighted character). Exactly two analyzer criteria result (identity + wardrobe), image
// set only, no video.
//
//   variant "semantic" (default, slug continuity-semantic-test): a fictional character drawn by
//       synthetic-character.mts. Prism's production truth is only: an identity reference (character A in a plain
//       grey top), an assigned BLACK FORMAL Look (character A in a black jacket), and an output frame that keeps
//       character A but wears a clearly RED jacket (or, with mismatch, shows a DIFFERENT character). Nothing
//       about the expected verdict is encoded anywhere a provider can read it.
//   variant "abstract" (slug continuity-smoke-test): the original gradient/grid frames. They carry no visible
//       character, so a vision model correctly answers UNCHECKED; kept because Run 5 history references them.
import { createHash, randomUUID } from "node:crypto";
import type { AttemptView } from "../../src/data/generation-repository";
import { buildSeedProject } from "../../src/data/seed";
import { buildShotContext } from "../../src/domain/context";
import { generationAttemptSchema, type Asset, type ProjectData } from "../../src/domain/schemas";
import { emptyShot } from "../../src/domain/shot-defaults";
import { encodeMockPng } from "../../src/generation/providers/mock-image";
import { renderSyntheticCharacter, type SyntheticArtwork } from "./synthetic-character.mjs";
import { buildObjectPath } from "../../src/lib/storage-paths";

export const FIXTURE_SLUG = "continuity-semantic-test";
/** The first (abstract-gradient) smoke fixture. Historical Run 5 hangs off this project: never recreate or remove it implicitly. */
export const LEGACY_FIXTURE_SLUG = "continuity-smoke-test";
export type FixtureVariant = "semantic" | "abstract";
export const fixtureSlug = (variant: FixtureVariant): string =>
  variant === "abstract" ? LEGACY_FIXTURE_SLUG : FIXTURE_SLUG;

const artCache = new Map<string, SyntheticArtwork>();
function art(character: "A" | "B", outfit: "grey" | "black" | "red"): SyntheticArtwork {
  const key = `${character}:${outfit}`;
  let a = artCache.get(key);
  if (!a) artCache.set(key, (a = renderSyntheticCharacter({ character, outfit })));
  return a;
}

export interface SyntheticFixture {
  data: ProjectData;
  view: AttemptView;
  bytes: Map<string, Uint8Array>;
  shotId: string;
  attemptId: string;
  variant: FixtureVariant;
  slug: string;
  /** What each synthetic image plainly shows (documentation/tests only; never sent as an expectation). */
  pictures: { identity: string; look: string; output: string };
}

export function buildSyntheticFixture(opts: {
  userId: string;
  mismatch?: boolean;
  variant?: FixtureVariant;
}): SyntheticFixture {
  const variant: FixtureVariant = opts.variant ?? "semantic";
  const semantic = variant === "semantic";
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

  const asset = (
    name: string,
    purpose: Asset["purpose"],
    source: Asset["source"],
    seed: number,
    picture?: SyntheticArtwork,
  ): Asset => {
    const id = randomUUID();
    const png = picture ? picture.png : encodeMockPng(512, 288, seed);
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
      width: picture ? picture.width : 512,
      height: picture ? picture.height : 288,
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
  const pics = semantic
    ? {
        identity: art("A", "grey"),
        look: art("A", "black"),
        output: opts.mismatch ? art("B", "red") : art("A", "red"),
      }
    : null;
  const identity = asset("synthetic-a-identity.png", "identity_ref", "upload", 11, pics?.identity);
  const lookRef = asset("synthetic-a-look.png", "look_ref", "upload", 11, pics?.look);
  const output = asset(
    "synthetic-a-output.png",
    "generation_output",
    "provider_output",
    opts.mismatch ? 97 : 11,
    pics?.output,
  );

  const project = {
    ...demo.project,
    id: PID,
    userId: opts.userId,
    title: semantic
      ? "ZZ Continuity semantic smoke test (disposable)"
      : "ZZ Continuity analysis smoke test (disposable)",
    slug: fixtureSlug(variant),
    description: semantic
      ? "Disposable synthetic fixture (fictional character, identity + wardrobe) for the semantic continuity-analysis smoke test. Safe to delete."
      : "Disposable synthetic fixture for the first live continuity-analysis smoke test. Safe to delete.",
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
    physicalDescription: semantic
      ? "A fictional adult with dark shoulder-length hair, round glasses and a distinctive blue scarf."
      : "A synthetic test character shown by the supplied reference image.",
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
    name: semantic ? "Black Formal Look" : "Synthetic Look",
    wardrobe: semantic
      ? "Black formal jacket over a white shirt."
      : "the outfit shown in the reference image",
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
    // never inherit the canonical drama's synopsis or script into a disposable fixture
    synopsis: "Synthetic fixture episode.",
    scriptText: "",
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
    intExt: "INT" as const,
    timeOfDay: "DAY" as const,
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
  return {
    data,
    view,
    bytes,
    shotId: SH,
    attemptId: AT,
    variant,
    slug: fixtureSlug(variant),
    pictures: pics
      ? {
          identity: pics.identity.describes,
          look: pics.look.describes,
          output: pics.output.describes,
        }
      : {
          identity: "abstract gradient with a grid",
          look: "abstract gradient with a grid",
          output: "abstract gradient with a grid",
        },
  };
}
