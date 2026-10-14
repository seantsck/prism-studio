// Disposable, NON-CANONICAL fixture for the first live Runway smoke test.
//   npm run runway:fixture                 validate in memory only (no database writes)
//   npm run runway:fixture -- --create     create the separate project "runway-smoke-test"
//   npm run runway:fixture -- --remove     delete it again
//
// It is a SEPARATE project (own slug, own rows). The demo/drama project and Shot 3A are never touched.
// One 16:9, 2 s, character-free establishing shot of a paper lantern: harmless, no public figures or
// copyrighted material. It sends nothing to Runway and spends nothing.
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { buildShotContext } from "../src/domain/context";
import { approvalSnapshot } from "../src/domain/fingerprint";
import { runPreflight } from "../src/domain/preflight";
import type { ProjectData } from "../src/domain/schemas";
import { emptyShot } from "../src/domain/shot-defaults";
import { readGenerationConfig } from "../src/generation/config";
import { encodeMockPng } from "../src/generation/providers/mock-image";
import { createRegistry } from "../src/generation/registry";
import { createOutputSink } from "../src/generation/sink";
import { evaluateShotForModel } from "../src/generation/submission";
import { buildObjectPath } from "../src/lib/storage-paths";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const SLUG = "runway-smoke-test";
const create = process.argv.includes("--create");
const remove = process.argv.includes("--remove");

const dev = readDevUserEnv();
startScript({
  mode: remove
    ? "REMOVE runway smoke fixture"
    : create
      ? "CREATE runway smoke fixture"
      : "validate runway smoke fixture (memory only)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 3 });
await assertDevUserExists(pool, dev);
const admin = new AdminRepository(pool, dev.id);

if (remove) {
  const found = (await admin.listProjects()).find((p) => p.slug === SLUG);
  if (!found) console.log("fixture project not present");
  else {
    await pool.query("delete from projects where id = $1 and slug = $2 and user_id = $3", [
      found.id,
      SLUG,
      dev.id,
    ]);
    console.log(
      "fixture project removed (rows cascade; generated Storage objects, if any, are unreferenced)",
    );
  }
  await pool.end();
  process.exit(0);
}

// ── templates from the demo project: valid shapes, never modified ──
const demo = (await admin.loadProject("ojousama"))!;
const now = new Date().toISOString();
const PID = randomUUID();
const EP = randomUUID();
const SC = randomUUID();
const LOC = randomUUID();
const SH = randomUUID();
const FR = randomUUID();
const AS = randomUUID();
const png = encodeMockPng(1280, 720, 11);

const project = {
  ...demo.project,
  id: PID,
  userId: dev.id,
  title: "ZZ Runway smoke test (disposable)",
  slug: SLUG,
  description: "Disposable, non-canonical fixture for the first live Runway test. Safe to delete.",
  genre: "",
  tone: "",
  productionStatus: "development" as typeof demo.project.productionStatus,
  createdAt: now,
  updatedAt: now,
};
const bible = {
  ...demo.bible,
  projectId: PID,
  premise: "Disposable smoke-test project.",
  genre: "",
  tone: "calm",
  visualStyle: "soft, warm, natural light",
  cinematographyRules: [],
  colorLanguage: "",
  canonFacts: [],
  continuityRules: [],
  aspectRatio: "16:9",
  guardrails: ["No people, no text, no logos."],
  updatedAt: now,
};
const location = {
  ...demo.locations[0]!,
  id: LOC,
  projectId: PID,
  name: "Smoke Test Room",
  description: "A bare wooden table beside a window at dusk.",
  locked: true,
  geography: "",
  zones: [],
  entrances: [],
  lighting: "soft warm light through a window at dusk",
  recurringProps: [],
  referenceAssetIds: [],
  set3d: null,
};
const episode = {
  ...demo.episodes[0]!,
  id: EP,
  projectId: PID,
  title: "Smoke test",
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
  slugline: "INT. SMOKE TEST ROOM - DUSK",
  intExt: "INT" as (typeof demo.scenes)[0]["intExt"],
  locationId: LOC,
  timeOfDay: "dusk",
  summary: "A paper lantern on a table.",
  dramaticPurpose: "",
  emotionEntering: "",
  emotionLeaving: "",
  scriptRange: null,
  characterIds: [],
  propIds: [],
  continuityNotes: "",
  order: 1,
};
const base = emptyShot({
  id: SH,
  projectId: PID,
  episodeId: EP,
  sceneId: SC,
  shotCode: "SMOKE-1",
  title: "Paper lantern at dusk",
  order: 1,
});
const shot = {
  ...base,
  storyBeat: "A single paper lantern glows on a wooden table beside a window at dusk.",
  dramaticPurpose: "Smoke test: prove submission, polling, ingest and review.",
  durationMode: "manual" as const,
  targetDurationMs: 2000,
  composition: {
    ...base.composition,
    framing: "static wide",
    shotSize: "wide",
    movement: "slow push-in",
    aspectRatio: "16:9",
    lens: "35mm",
  },
  spatial: { ...base.spatial, locationId: LOC, setZone: "table" },
  continuity: {
    ...base.continuity,
    weather: "clear",
    timeOfDay: "dusk",
    characterCount: 0,
    vehicleInPlay: false,
  },
  approval: { ...base.approval, continuityApproved: true, storyboardApproved: true },
  generation: { ...base.generation, provider: "runway", model: "gen4.5" },
  createdAt: now,
  updatedAt: now,
};
const asset = {
  ...demo.assets.find((a) => a.type === "image")!,
  id: AS,
  projectId: PID,
  name: "smoke-frame.png",
  originalFilename: "smoke-frame.png",
  mime: "image/png",
  width: 1280,
  height: 720,
  durationMs: null,
  byteSize: png.length,
  checksum: createHash("sha256").update(png).digest("hex"),
  purpose: "storyboard" as const,
  source: "storyboard" as const,
  storageProvider: "supabase" as const,
  bucket: "prism-assets",
  objectPath: buildObjectPath(PID, AS, "smoke-frame.png"),
  tags: ["smoke-test"],
  metadata: {},
  createdBy: dev.id,
  createdAt: now,
  updatedAt: now,
};
const frame0 = {
  ...demo.frames[0]!,
  id: FR,
  projectId: PID,
  shotId: SH,
  assetId: AS,
  version: 1,
  approved: true,
  source: demo.frames[0]!.source,
  notes: "Smoke test frame",
  approvedAt: now,
  createdAt: now,
};
const data: ProjectData = {
  project,
  bible,
  assets: [asset],
  characters: [],
  identityRefs: [],
  looks: [],
  voiceProfiles: [],
  locations: [location],
  props: [],
  episodes: [episode],
  scenes: [scene],
  shots: [shot],
  dialogueLines: [],
  actionBlocks: [],
  directions: [],
  takes: [],
  frames: [frame0],
  attempts: [],
  continuityChecks: [],
} as ProjectData;
// approval snapshot so the storyboard is FRESH
{
  const ctx = buildShotContext(data, SH);
  const snap = approvalSnapshot(ctx);
  data.frames = [{ ...frame0, approvedFingerprint: snap.fingerprint, approvedSnapshot: snap.snapshot }];
}

// ── validate against the real gate, with the real environment's spend configuration ──
const config = readGenerationConfig(process.env);
const registry = createRegistry(process.env, config);
const pre = runPreflight(buildShotContext(data, SH));
console.log(
  `preflight ready: ${pre.ready}${pre.blockers.length ? ` (blockers: ${pre.blockers.map((b) => b.ruleId).join(", ")})` : ""}`,
);
const ev = evaluateShotForModel({ data, shotId: SH, registry, provider: "runway", modelId: "gen4.5" });
console.log(`modality: ${ev.compatibility?.modality}  compatible: ${ev.compatibility?.compatible}`);
console.log(`estimate: ${ev.estimate?.amount} ${ev.estimate?.currency} (${ev.estimate?.units} credits)`);
console.log(
  `ignored features to acknowledge: ${ev.compatibility?.ignoredFeatures.map((f) => f.id).join(", ") || "none"}`,
);
{
  const { buildPromptPlan } = await import("../src/domain/generation/prompt-plan");
  const { compileRunwayPrompt } = await import("../src/generation/providers/runway/compile");
  const c = compileRunwayPrompt(buildPromptPlan(ev.pkg));
  console.log(
    `prompt: ${c.text.length} chars; omitted: ${c.omissions.map((o) => `${o.label} ${o.omittedLines}/${o.totalLines}`).join(", ") || "none"}`,
  );
  if (process.argv.includes("--show-prompt")) console.log(c.text);
}
console.log(
  `gate allowed: ${ev.gate.allowed}; blockers: ${ev.gate.blockers.map((b) => b.code).join(", ") || "none"}`,
);
{
  // Phase 2E: the proposed FIRST real candidate set, planned in memory (nothing is submitted, nothing is spent).
  const { planCandidateSet } = await import("../src/generation/candidate-set");
  const plan = planCandidateSet({
    data,
    shotId: SH,
    registry,
    config,
    selections: [
      { provider: "runway", modelId: "gen4.5" },
      { provider: "runway", modelId: "gen4_turbo" },
      { provider: "runway", modelId: "hailuo3", tierId: "768p" },
    ],
    outcomes: [],
  });
  console.log("proposed candidate set (planning only):");
  for (const it of plan.items) {
    console.log(
      `  ${it.label} ${it.fit.displayName.padEnd(20)} ${it.fit.status.padEnd(20)} ${it.fit.duration.text}  est ${it.estimateUsd == null ? "unknown" : "$" + it.estimateUsd.toFixed(2)}`,
    );
  }
  console.log(
    `  maximum total: ${plan.spend.totalUsd == null ? "unknown" : "$" + plan.spend.totalUsd.toFixed(2)}; set blockers now: ${plan.blockers.length ? plan.blockers.join(" | ").slice(0, 400) : "none"}`,
  );
}
if (!pre.ready || !ev.compatibility?.compatible) {
  console.error("fixture is NOT ready; nothing written");
  await pool.end();
  process.exit(1);
}

if (!create) {
  console.log("validation only: pass --create to write the fixture project");
  await pool.end();
  process.exit(0);
}

// ── persist (separate project; private Storage object through the worker secret) ──
if ((await admin.listProjects()).some((p) => p.slug === SLUG)) {
  console.error("fixture project already exists; remove it first (--remove)");
  await pool.end();
  process.exit(1);
}
const sink = await createOutputSink(process.env as Record<string, string | undefined>, "supabase");
await sink.put(asset.objectPath, png, "image/png");
await admin.createProject(project, bible);
await admin.upsert(PID, "assets", asset as never);
await admin.upsert(PID, "locations", location as never);
await admin.upsert(PID, "episodes", episode as never);
await admin.upsert(PID, "scenes", scene as never);
await admin.upsert(PID, "shots", shot as never);
await admin.upsert(PID, "frames", data.frames[0] as never);
console.log(`fixture created: /projects/${SLUG} (shot SMOKE-1)`);
await pool.end();
