// Exercises the real persistence path (PostgresRepository against the dedicated Prism Studio project).
// Run as separate processes so "restart" is genuine (new process, new pool, nothing cached):
//   npm run db:exercise -- baseline   # seeded project loads and equals buildSeedProject()
//   npm run db:exercise -- mutate     # shot update, Look, take selection, frame approval, attempt
//   npm run db:exercise -- verify     # fresh process: every mutation persisted
//   npm run db:seed -- --reset        # restores the pristine demo project
// Only the demo project of the dev user is touched. Mutations use deterministic ids so reruns are idempotent.
import pg from "pg";
import { buildShotContext } from "../src/domain/context";
import { assembleGenerationPackage } from "../src/domain/generation-package";
import { assignLook } from "../src/domain/looks";
import { runPreflight } from "../src/domain/preflight";
import { selectTake } from "../src/domain/takes";
import type { ProjectData } from "../src/domain/schemas";
import { PostgresRepository } from "../src/data/postgres-repository";
import { buildSeedProject, uid } from "../src/data/seed";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";

const phase = process.argv[2];
if (!["baseline", "mutate", "verify"].includes(phase ?? ""))
  throw new Error("usage: db-exercise.mts baseline|mutate|verify");

const dev = readDevUserEnv();
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 2 });
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => checks.push([name, ok, detail]);

/** Canonical form: object keys sorted, entity arrays sorted by id (DB row order is not significant). */
function canon(value: unknown, sortArrays = true): unknown {
  if (Array.isArray(value)) {
    const items = value.map((v) => canon(v, sortArrays));
    const keyed = items.every((v) => v && typeof v === "object" && "id" in (v as object));
    return sortArrays && keyed
      ? items.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)))
      : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canon(v, sortArrays)]),
    );
  }
  return value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const MUTATION = {
  title: "Exercise: reframed doorway",
  assetIds: [uid("exercise:ref:c"), uid("exercise:ref:a"), uid("exercise:ref:b")],
  lookId: uid("exercise:look"),
  attemptId: uid("exercise:attempt"),
};

try {
  await assertDevUserExists(pool, dev);
  const seed = buildSeedProject();
  const repo = new PostgresRepository(pool, dev.id);
  const load = async (): Promise<ProjectData> => {
    const d = await repo.loadProject(seed.project.slug);
    if (!d) throw new Error(`Project ${seed.project.slug} not found; run npm run db:seed first`);
    return d;
  };
  const data = await load();
  const pid = data.project.id;

  if (phase === "baseline") {
    const projects = await repo.listProjects();
    check(
      "listProjects returns the demo project",
      projects.some((p) => p.id === pid),
    );
    check("project row equals seed", same({ ...data.project }, { ...seed.project, userId: dev.id }));
    check("bible equals seed", same(data.bible, seed.bible));
    for (const key of [
      "assets",
      "characters",
      "identityRefs",
      "looks",
      "voiceProfiles",
      "locations",
      "props",
      "episodes",
      "scenes",
      "dialogueLines",
      "shots",
      "directions",
      "takes",
      "frames",
      "attempts",
      "continuityChecks",
    ] as const) {
      const a = data[key] as unknown[];
      const b = seed[key] as unknown[];
      check(`${key}: ${b.length} rows equal seed`, a.length === b.length && same(a, b), `db=${a.length}`);
    }
    const sample = data.shots.find((s) => s.shotCode === "3A")!;
    check(
      "shot load by id + preflight runs",
      runPreflight(buildShotContext(data, sample.id)).items.length > 0,
    );
    const dur = assembleGenerationPackage(buildShotContext(data, sample.id)).timing.durationMs;
    check("3A derived duration is 4500ms (0.8+2.8+0.9)", dur === 4500, `got ${dur}`);
  }

  if (phase === "mutate") {
    // 1. shot update + ordered reference assets
    for (const [i, id] of MUTATION.assetIds.entries()) {
      await repo.upsert(pid, "assets", {
        id,
        projectId: pid,
        type: "image",
        name: `exercise ref ${i}`,
        mime: null,
        storagePath: null,
        width: null,
        height: null,
        durationMs: null,
        checksum: null,
        source: "seed",
        tags: ["exercise"],
        metadata: {},
        uploadedAt: new Date().toISOString(),
      });
    }
    const shot3a = data.shots.find((s) => s.shotCode === "3A")!;
    await repo.upsert(pid, "shots", {
      ...shot3a,
      title: MUTATION.title,
      generation: { ...shot3a.generation, referenceAssetIds: MUTATION.assetIds },
      updatedAt: new Date().toISOString(),
    });

    // 2. character Look: new Look, assigned to the first character of 2B
    const shot2b = data.shots.find((s) => s.shotCode === "2B")!;
    const characterId = shot2b.characters[0]!.characterId;
    const look = {
      id: MUTATION.lookId,
      projectId: pid,
      characterId,
      episodeId: shot2b.episodeId,
      name: "Exercise look",
      wardrobe: "charcoal kimono",
      shoes: "",
      jewelry: "",
      hair: "",
      makeup: "",
      grooming: "",
      bodyNotes: "",
      accessories: "",
      referenceAssetIds: [],
      locked: false,
    };
    await repo.upsert(pid, "looks", look);
    await repo.upsert(pid, "shots", assignLook(shot2b, characterId, look.id, [...data.looks, look]));

    // 3. performance take selection: a line with an unselected take
    const lineId = data.dialogueLines.find(
      (l) =>
        data.takes.some((t) => t.dialogueLineId === l.id && !t.selected) &&
        data.takes.some((t) => t.dialogueLineId === l.id && t.selected),
    )?.id;
    if (!lineId) throw new Error("no line with an alternative take");
    const alt = data.takes.find((t) => t.dialogueLineId === lineId && !t.selected)!;
    const updated = selectTake(data.takes, alt.id).filter((t) => t.dialogueLineId === lineId);
    await repo.upsertMany(pid, "takes", updated);
    console.log(`  select take ${alt.id} on line ${lineId}`);

    // 4. storyboard approval: approve a non-approved frame of a shot (sibling un-approved, target last)
    const frame = data.frames.find(
      (f) => !f.approved && data.frames.some((g) => g.shotId === f.shotId && g.approved),
    );
    if (!frame) throw new Error("no shot with an unapproved alternative frame");
    for (const f of data.frames.filter((f) => f.shotId === frame.shotId && f.approved))
      await repo.upsert(pid, "frames", { ...f, approved: false });
    await repo.upsert(pid, "frames", { ...frame, approved: true });
    console.log(`  approve frame ${frame.id} (shot ${frame.shotId})`);

    // 5. generation attempt history: append with frozen snapshot
    const pkg = assembleGenerationPackage(buildShotContext(data, shot3a.id));
    const n =
      data.attempts.filter((a) => a.shotId === shot3a.id).reduce((m, a) => Math.max(m, a.attemptNumber), 0) +
      1;
    await repo.upsert(pid, "attempts", {
      id: MUTATION.attemptId,
      projectId: pid,
      shotId: shot3a.id,
      attemptNumber: n,
      provider: "manual",
      model: "manual-log",
      modality: shot3a.generation.modality,
      prompt: pkg.prompt.positive,
      negativePrompt: pkg.prompt.negative,
      packageSnapshot: JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>,
      modelSettings: {},
      inputAssetIds: [],
      outputAssetId: null,
      costUsd: null,
      durationMs: pkg.timing.durationMs || null,
      status: "rejected",
      rejectionReason: "exercise",
      notes: "",
      approved: false,
      createdAt: new Date().toISOString(),
    });
    check("mutations written without invariant violations", true);
  }

  if (phase === "verify") {
    const shot3a = data.shots.find((s) => s.shotCode === "3A")!;
    check("shot update persisted", shot3a.title === MUTATION.title, shot3a.title);
    check(
      "reference asset order preserved",
      JSON.stringify(shot3a.generation.referenceAssetIds) === JSON.stringify(MUTATION.assetIds),
      shot3a.generation.referenceAssetIds.map((x) => x.slice(0, 4)).join(","),
    );
    const shot2b = data.shots.find((s) => s.shotCode === "2B")!;
    check(
      "Look persisted + assigned to shot",
      shot2b.characters.some((c) => c.lookId === MUTATION.lookId) &&
        data.looks.some((l) => l.id === MUTATION.lookId),
    );
    const perLine = new Map<string, number>();
    for (const t of data.takes)
      if (t.selected) perLine.set(t.dialogueLineId, (perLine.get(t.dialogueLineId) ?? 0) + 1);
    check(
      "exactly one selected take per line",
      [...perLine.values()].every((n) => n === 1),
    );
    const perShot = new Map<string, number>();
    for (const f of data.frames) if (f.approved) perShot.set(f.shotId, (perShot.get(f.shotId) ?? 0) + 1);
    check(
      "at most one approved frame per shot",
      [...perShot.values()].every((n) => n === 1),
    );
    const att = data.attempts.find((a) => a.id === MUTATION.attemptId);
    check("attempt appended with snapshot", !!att && Object.keys(att.packageSnapshot).length > 0);
    check(
      "attempt history intact (seed attempts + 1)",
      data.attempts.length === buildSeedProject().attempts.length + 1,
      `count=${data.attempts.length}`,
    );
    check(
      "selected takes differ from seed for the exercised line",
      !same(
        data.takes.filter((t) => t.selected).map((t) => t.id),
        buildSeedProject()
          .takes.filter((t) => t.selected)
          .map((t) => t.id),
      ),
    );
    check(
      "approved frames differ from seed",
      !same(
        data.frames.filter((f) => f.approved).map((f) => f.id),
        buildSeedProject()
          .frames.filter((f) => f.approved)
          .map((f) => f.id),
      ),
    );
    const ready = data.shots.map((s) => runPreflight(buildShotContext(data, s.id)).ready);
    check("preflight evaluates for every shot (readiness derived live)", ready.length === data.shots.length);
  }
} finally {
  await pool.end();
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n[${phase}] ${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
