// Integration tests for Phase 2I.1B Episode edits against the REAL dedicated Prism Studio database (migration 0043:
// episode_edits, episode_edit_items, episode_edit_audio_placements).
//   npm run db:episode-edits
//
// Everything runs in TWO THROWAWAY projects (purpose 'test') owned by the dev user, created here and deleted at the end
// (the Project delete is itself under test: it must cascade through the edit). The demo project is never touched.
//
// Exercises: structure + owner-only RLS (owner / stranger / anon) + no worker privilege; memory/Postgres PARITY (the
// same op script through PostgresEpisodeEditData and a MemoryEpisodeEditService fed from the same rows: same refusal
// codes, same resulting edit); every database backstop with raw SQL (kind/column check, the source trigger: Production
// Frame purpose, not succeeded, attempt of another Shot, Asset not of the attempt, trim beyond the clip, unknown
// duration; placement bounds, archived take, take of another line; Shot of another Episode / Project; one edit per
// Episode; deferred position swap in one transaction vs a duplicate position at commit); optimistic concurrency (two
// writers on one revision → exactly one wins, nothing partial; a held FOR UPDATE blocks the second writer); deletion
// (a referenced Shot / attempt / frame cannot be deleted directly, the edit intact; after removing the item the Shot
// can; an upstream approval / delivery change never rewrites the edit; a Project delete cascades). No provider call.
//
// Requires migration 0043 to be APPLIED: the suite refuses to start (and writes nothing) when it is not.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { MemoryEpisodeEditService, type MemoryEpisodeEditAccess } from "../src/data/episode-edit-memory";
import { PostgresEpisodeEditData } from "../src/data/episode-edit-postgres";
import {
  EpisodeEditError,
  type EditOp,
  type EpisodeEditRepository,
  type NewEditItem,
} from "../src/data/episode-edit-repository";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import type { AudioPlacement, EpisodeEdit, VisualSource } from "../src/domain/edit/model";
import type { ProductionFrame } from "../src/domain/production-frame";
import type { Asset } from "../src/domain/schemas";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "episode edit integration tests (throwaway projects, removed afterwards)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 10 });
await assertDevUserExists(pool, dev);

const applied = (await pool.query("select to_regclass('public.episode_edits') as t")).rows[0].t;
if (!applied) {
  console.error(
    "Migration 0043 is not applied to this database; db:episode-edits needs it. Nothing was written.",
  );
  await pool.end();
  process.exit(1);
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const NOW = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE = { num: 24, den: 1 };

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresEpisodeEditData(pool, rlsPreamble({ sub: dev.id }));
const strangerSvc = new PostgresEpisodeEditData(pool, rlsPreamble({ sub: stranger }));

async function raw(preamble: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await c.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount ?? 0, error: null as string | null };
  } catch (e) {
    return { rows: [], rowCount: 0, error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const asOwner = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: dev.id }), sql, p);
const asStranger = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: stranger }), sql, p);
const asAnon = (sql: string, p: unknown[] = []) => raw(rlsPreamble(null, "anon"), sql, p);
/** Statements in ONE transaction as the signed-in owner, COMMITTED (deferred keys run at commit); null = success. */
async function ownerCommit(statements: Array<[string, unknown[]]>): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query(rlsPreamble({ sub: dev.id }));
    for (const [sql, params] of statements) await c.query(sql, params);
    await c.query("commit");
    return null;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return (e as Error).message;
  } finally {
    c.release();
  }
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof EpisodeEditError ? e.code : `other: ${(e as Error).message}`),
  );

// ───────────────────────── fixtures (two throwaway projects) ─────────────────────────

const P = randomUUID();
const P2 = randomUUID();
const slug = `db-ee-${P.slice(0, 8)}`;
const slug2 = `db-ee-${P2.slice(0, 8)}`;
const id = () => randomUUID();
const E1 = id(),
  E2 = id(),
  E3 = id(),
  S1 = id(),
  S2 = id(),
  S3 = id(),
  A = id(),
  B = id(),
  C = id(),
  X = id(),
  Z = id(),
  CH = id(),
  L1 = id(),
  L2 = id(),
  T1 = id(),
  T2 = id(),
  T3 = id(),
  FA = id(),
  FB = id(),
  PFA = id(),
  PFC = id();

const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
let attemptNumber = 0;
const mkAsset = async (project: string, type: "video" | "image", durationMs: number | null) => {
  const assetId = id();
  await q(
    `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum,
       width, height, duration_ms, metadata)
     values ($1,$2,$3,$4,$5,$6,'local',$7,$8,$9,1024,576,$10,'{}'::jsonb)`,
    [
      assetId,
      project,
      `db:ee ${type}`,
      type,
      type === "video" ? "generation_output" : "generation_input",
      type === "video" ? "provider_output" : "upload",
      `${project}/${assetId}/db-ee.${type === "video" ? "mp4" : "png"}`,
      type === "video" ? "video/mp4" : "image/png",
      sha(assetId),
      durationMs,
    ],
  );
  return assetId;
};
const mkClip = async (
  project: string,
  shotId: string,
  o: { purpose?: string | null; status?: string; approved?: boolean; durationMs?: number | null } = {},
) => {
  attemptNumber += 1;
  const attemptId = id();
  const approved = o.approved ?? false;
  await q(
    `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality,
       package_snapshot, approved, status, review_status, request, reviewed_at)
     values ($1,$2,$3,$4,'mock','mock-video-1','video','{}'::jsonb,$5::boolean,$6,
       case when $5::boolean then 'approved' else 'unreviewed' end,$7::jsonb,case when $5::boolean then now() end)`,
    [
      attemptId,
      project,
      shotId,
      attemptNumber,
      approved,
      o.status ?? "succeeded",
      o.purpose === null ? null : JSON.stringify({ purpose: o.purpose ?? "shot_output" }),
    ],
  );
  const assetId = await mkAsset(project, "video", o.durationMs === undefined ? 10_000 : o.durationMs);
  await q(
    "insert into generation_outputs (project_id, attempt_id, asset_id, role, position) values ($1,$2,$3,'primary',0)",
    [project, attemptId, assetId],
  );
  return { attemptId, assetId };
};
const mkDeliveryVersion = async (attemptId: string, parentAssetId: string, durationMs: number) => {
  const child = await mkAsset(P, "video", durationMs);
  await q(
    `insert into asset_derivations (project_id, parent_asset_id, child_asset_id, operation, derivation_key, processor,
       processor_version, attempt_id, slot, version)
     values ($1,$2,$3,'conform',$4,'db-ee','1',$5,'delivery',
       (select coalesce(max(version), 0) + 1 from asset_derivations where attempt_id = $5 and slot = 'delivery'))`,
    [P, parentAssetId, child, sha(`dv-${child}`), attemptId],
  );
  return child;
};

let cleanup = true;
try {
  for (const [pid, s] of [
    [P, slug],
    [P2, slug2],
  ] as const) {
    await q("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
      pid,
      dev.id,
      s,
      `db:ee ${s}`,
    ]);
    await q("insert into project_bibles (project_id) values ($1)", [pid]);
  }
  for (const [eid, pid, n] of [
    [E1, P, 1],
    [E2, P, 2],
    [E3, P2, 1],
  ] as const)
    await q("insert into episodes (id, project_id, number, slug, title) values ($1,$2,$3,$4,'E')", [
      eid,
      pid,
      n,
      `ep-${n}`,
    ]);
  for (const [sid, pid, eid] of [
    [S1, P, E1],
    [S2, P, E2],
    [S3, P2, E3],
  ] as const)
    await q(
      "insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext) values ($1,$2,$3,'1','INT. X','INT')",
      [sid, pid, eid],
    );
  for (const [shotId, pid, eid, sid, codeName, order] of [
    [A, P, E1, S1, "1A", 0],
    [B, P, E1, S1, "1B", 1],
    [C, P, E1, S1, "1C", 2],
    [X, P, E2, S2, "2A", 0],
    [Z, P2, E3, S3, "1A", 0],
  ] as const)
    await q(
      `insert into shots (id, project_id, episode_id, scene_id, shot_code, title, "order") values ($1,$2,$3,$4,$5,'S',$6)`,
      [shotId, pid, eid, sid, codeName, order],
    );
  await q("insert into characters (id, project_id, name) values ($1,$2,'C')", [CH, P]);
  for (const line of [L1, L2])
    await q(
      "insert into dialogue_lines (id, project_id, episode_id, scene_id, character_id, original_text) values ($1,$2,$3,$4,$5,'hello')",
      [line, P, E1, S1, CH],
    );
  for (const [takeId, line, n, archived] of [
    [T1, L1, 1, false],
    [T2, L1, 2, true],
    [T3, L2, 1, false],
  ] as const)
    await q(
      `insert into performance_takes (id, project_id, dialogue_line_id, source_type, duration_ms, take_number, archived,
         archived_at)
       values ($1,$2,$3,'human_recording',3400,$4,$5::boolean,case when $5::boolean then now() end)`,
      [takeId, P, line, n, archived],
    );
  for (const [fid, shotId] of [
    [FA, A],
    [FB, B],
  ] as const)
    await q(
      "insert into storyboard_frames (id, project_id, shot_id, version, source) values ($1,$2,$3,1,'upload')",
      [fid, P, shotId],
    );
  for (const [pfId, shotId] of [
    [PFA, A],
    [PFC, C],
  ] as const) {
    const pfImage = await mkAsset(P, "image", null);
    await q(
      `insert into shot_production_frames (id, project_id, shot_id, version, schema_version, asset_id, asset_checksum,
         width, height, production_aspect_ratio, source, intent_snapshot, intent_fingerprint, parts, frame_fingerprint)
       values ($1,$2,$3,1,'prism.production-frame.v1',$4,$5,1024,576,'16:9','upload','{}'::jsonb,$6,'{}'::jsonb,$7)`,
      [pfId, P, shotId, pfImage, sha(pfImage), sha(`intent-${pfId}`), sha(`frame-${pfId}`)],
    );
  }
  const cA = await mkClip(P, A);
  const cAframe = await mkClip(P, A, { purpose: "production_frame" });
  const cArunning = await mkClip(P, A, { status: "running" });
  const cAunprobed = await mkClip(P, A, { durationMs: null });
  const cB = await mkClip(P, B);
  const cBframe = await mkClip(P, B, { purpose: "production_frame" });
  const cZ = await mkClip(P2, Z);
  const cAversion = await mkDeliveryVersion(cA.attemptId, cA.assetId, 8000);

  const none = (durationMs = 3000): VisualSource => ({ kind: "none", durationMs });
  const video = (
    c: { attemptId: string; assetId: string },
    sourceInMs: number,
    sourceOutMs: number,
  ): VisualSource => ({
    kind: "video",
    attemptId: c.attemptId,
    assetId: c.assetId,
    sourceInMs,
    sourceOutMs,
  });
  const placement = (o: Partial<AudioPlacement> = {}): AudioPlacement => ({
    dialogueLineId: L1,
    takeId: T1,
    startMs: 0,
    takeInMs: 0,
    takeOutMs: 2000,
    ...o,
  });
  const item = (shotId: string, visual: VisualSource, performance: AudioPlacement[] = []): NewEditItem => ({
    shotId,
    visual,
    performance,
    performanceBasis: null,
  });

  // ── 1. structure and security ──
  const tables = ["episode_edits", "episode_edit_items", "episode_edit_audio_placements"];
  for (const t of tables) {
    const r = await q("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [t]);
    check(`${t} exists with row-level security enabled`, r.rows[0]?.relrowsecurity === true);
    const pols = await q("select cmd from pg_policies where schemaname = 'public' and tablename = $1", [t]);
    check(`${t}: exactly one owner policy (for all)`, pols.rows.length === 1 && pols.rows[0].cmd === "ALL");
  }
  const cons = await q(
    `select conname, condeferrable, condeferred from pg_constraint
      where conname in ('episode_edits_one_per_episode', 'episode_edit_items_one_per_shot', 'episode_edit_items_position_key')`,
  );
  const con = (n: string) => cons.rows.find((r) => r.conname === n);
  check(
    "one edit per Episode is a named (removable) unique constraint",
    Boolean(con("episode_edits_one_per_episode")),
  );
  check(
    "one item per Shot is a named (removable) unique constraint",
    Boolean(con("episode_edit_items_one_per_shot")),
  );
  check(
    "item positions are unique per edit, DEFERRABLE INITIALLY DEFERRED",
    con("episode_edit_items_position_key")?.condeferrable === true &&
      con("episode_edit_items_position_key")?.condeferred === true,
  );
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await q("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    for (const t of tables) {
      const p = await q(
        `select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i,
                has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d`,
        [role, `public.${t}`],
      );
      const r = p.rows[0];
      check(`${role} has NO privilege on ${t}`, !r.s && !r.i && !r.u && !r.d);
    }
  }

  // ── 2. memory / Postgres parity: the same op script, the same outcomes ──
  const memoryTwin = async (): Promise<MemoryEpisodeEditService> => {
    const projects = [(await admin.loadProject(slug))!, (await admin.loadProject(slug2))!];
    const assets = new Map<string, Asset>(projects.flatMap((p) => p.assets.map((a) => [a.id, a] as const)));
    const outputs = (
      await q("select attempt_id, asset_id, role from generation_outputs where project_id = any($1)", [
        [P, P2],
      ])
    ).rows;
    const versions = (
      await q(
        "select attempt_id, child_asset_id, parent_asset_id, version from asset_derivations where project_id = any($1) and slot = 'delivery'",
        [[P, P2]],
      )
    ).rows;
    const deliveries = (
      await q("select attempt_id, asset_id from attempt_deliveries where project_id = any($1)", [[P, P2]])
    ).rows;
    const frames = (
      await q("select id, shot_id, project_id from shot_production_frames where project_id = any($1)", [
        [P, P2],
      ])
    ).rows;
    const access: MemoryEpisodeEditAccess = {
      all: () => projects,
      generation: () =>
        ({
          getAttemptView: async (attemptId: string) => ({
            outputs: outputs
              .filter((o) => o.attempt_id === attemptId)
              .map((o) => ({
                output: { assetId: o.asset_id, role: o.role },
                asset: assets.get(o.asset_id)!,
              })),
          }),
        }) as unknown as ReturnType<MemoryEpisodeEditAccess["generation"]>,
      mediaQa: () =>
        ({
          listAttemptDerivations: async (attemptId: string) =>
            versions
              .filter((v) => v.attempt_id === attemptId)
              .map((v) => ({
                asset: assets.get(v.child_asset_id)!,
                derivation: {
                  slot: "delivery",
                  parentAssetId: v.parent_asset_id,
                  version: v.version,
                  attemptId,
                },
              })),
          getDelivery: async (attemptId: string) => {
            const d = deliveries.find((x) => x.attempt_id === attemptId);
            return d ? { assetId: d.asset_id } : null;
          },
        }) as unknown as ReturnType<MemoryEpisodeEditAccess["mediaQa"]>,
      productionFrames: () =>
        ({
          listForProject: async (pid: string) => ({
            frames: frames
              .filter((f) => f.project_id === pid)
              .map((f) => ({ id: f.id, shotId: f.shot_id, projectId: f.project_id }) as ProductionFrame),
            selections: [],
          }),
        }) as unknown as ReturnType<MemoryEpisodeEditAccess["productionFrames"]>,
    };
    return new MemoryEpisodeEditService(access);
  };

  /** One step of the parity script: ops computed from the CURRENT edit (item ids differ per backend). */
  type Step = [string, (e: EpisodeEdit) => EditOp[], number?];
  const at = (e: EpisodeEdit, shotId: string) => e.items.find((i) => i.shotId === shotId)!.id;
  const steps: Step[] = [
    [
      "pin an exact clip interval",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cA, 0, 4000) }],
    ],
    [
      "pin a delivery version",
      (e) => [
        {
          op: "set_visual",
          itemId: at(e, A),
          visual: video({ attemptId: cA.attemptId, assetId: cAversion }, 0, 8000),
        },
      ],
    ],
    [
      "back to the provider output",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cA, 0, 4000) }],
    ],
    [
      "Production Frame purpose refused",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cAframe, 0, 4000) }],
    ],
    [
      "not succeeded refused",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cArunning, 0, 4000) }],
    ],
    [
      "unknown duration refused",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cAunprobed, 0, 4000) }],
    ],
    [
      "attempt of another Shot refused",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cB, 0, 4000) }],
    ],
    [
      "attempt of another project refused",
      (e) => [{ op: "set_visual", itemId: at(e, A), visual: video(cZ, 0, 4000) }],
    ],
    [
      "Asset of another attempt refused",
      (e) => [
        {
          op: "set_visual",
          itemId: at(e, A),
          visual: video({ attemptId: cA.attemptId, assetId: cB.assetId }, 0, 4000),
        },
      ],
    ],
    [
      "trim beyond the clip refused",
      (e) => [{ op: "trim", itemId: at(e, A), sourceInMs: 0, sourceOutMs: 10_001 }],
    ],
    ["trim inside the clip", (e) => [{ op: "trim", itemId: at(e, A), sourceInMs: 500, sourceOutMs: 4000 }]],
    ["add a Shot at a position", () => [{ op: "add", item: item(C, none(2500)), atPosition: 1 }]],
    ["a second item for a Shot refused", () => [{ op: "add", item: item(A, none()), atPosition: 0 }]],
    ["a Shot of another Episode refused", () => [{ op: "add", item: item(X, none()), atPosition: 0 }]],
    [
      "Production Frame placeholder of its Shot",
      (e) => [
        {
          op: "set_visual",
          itemId: at(e, C),
          visual: { kind: "production_frame", productionFrameId: PFC, durationMs: 2000 },
        },
      ],
    ],
    [
      "placement outside the item refused",
      (e) => [
        {
          op: "set_performance",
          itemId: at(e, A),
          placements: [placement({ startMs: 2000, takeOutMs: 2000 })],
          performanceBasis: null,
        },
      ],
    ],
    [
      "archived take refused",
      (e) => [
        {
          op: "set_performance",
          itemId: at(e, A),
          placements: [placement({ takeId: T2 })],
          performanceBasis: null,
        },
      ],
    ],
    [
      "take of another line refused",
      (e) => [
        {
          op: "set_performance",
          itemId: at(e, A),
          placements: [placement({ dialogueLineId: L2 })],
          performanceBasis: null,
        },
      ],
    ],
    [
      "two lines placed",
      (e) => [
        {
          op: "set_performance",
          itemId: at(e, A),
          placements: [
            placement({ startMs: 1000, takeOutMs: 1500 }),
            placement({ dialogueLineId: L2, takeId: T3, startMs: 0, takeOutMs: 900 }),
          ],
          performanceBasis: { performance: "p1", timing: "t1" },
        },
      ],
    ],
    [
      "a trim that cuts a placement refused",
      (e) => [{ op: "trim", itemId: at(e, A), sourceInMs: 2000, sourceOutMs: 4000 }],
    ],
    ["reorder (complete list)", (e) => [{ op: "reorder", itemIds: [...e.items].reverse().map((i) => i.id) }]],
    [
      "reorder with a missing item refused",
      (e) => [{ op: "reorder", itemIds: e.items.slice(1).map((i) => i.id) }],
    ],
    [
      "several ops, one revision",
      (e) => [
        { op: "set_source_audio", itemId: at(e, A), sourceAudio: "included" },
        { op: "set_hold", itemId: at(e, B), durationMs: 2600 },
      ],
    ],
    [
      "all-or-nothing: a valid op then an invalid one",
      (e) => [
        { op: "set_hold", itemId: at(e, B), durationMs: 2700 },
        { op: "set_hold", itemId: at(e, C), durationMs: 0 },
      ],
    ],
    ["explicit silence", (e) => [{ op: "clear_performance", itemId: at(e, A) }]],
    ["remove an item", (e) => [{ op: "remove", itemId: at(e, C) }]],
    [
      "a stale revision refused",
      () => [{ op: "set_hold", itemId: "00000000-0000-4000-8000-000000000000", durationMs: 1 }],
      -1,
    ],
  ];
  const strip = (e: EpisodeEdit | null) =>
    e && {
      revision: e.revision,
      editRate: e.editRate,
      items: e.items.map((i) => ({ ...i, id: undefined })),
    };
  const runScript = async (repo: EpisodeEditRepository) => {
    const outcomes: string[] = [];
    let edit = await repo.create({
      projectId: P,
      episodeId: E1,
      editRate: RATE,
      items: [
        item(A, none(3000), [placement()]),
        item(B, { kind: "storyboard_frame", storyboardFrameId: FB, durationMs: 2000 }),
      ],
      userId: dev.id,
      now: NOW(),
    });
    for (const [, ops, revisionOffset = 0] of steps) {
      const outcome = await code(
        repo
          .apply({
            editId: edit.id,
            projectId: P,
            expectedRevision: edit.revision + revisionOffset,
            ops: ops(edit),
            userId: dev.id,
            now: NOW(),
          })
          .then((next) => {
            edit = next;
          }),
      );
      outcomes.push(outcome);
    }
    return { outcomes, edit };
  };
  const pgRun = await runScript(owner);
  const memRun = await runScript(await memoryTwin());
  const expected = [
    "ok",
    "ok",
    "ok",
    "invalid_source",
    "invalid_source",
    "invalid_source",
    "wrong_shot",
    "wrong_project",
    "invalid_source",
    "invalid_source",
    "ok",
    "ok",
    "conflict",
    "wrong_shot",
    "ok",
    "invalid",
    "invalid",
    "invalid",
    "ok",
    "invalid",
    "ok",
    "invalid",
    "ok",
    "invalid",
    "ok",
    "ok",
    "conflict",
  ];
  steps.forEach(([name], i) =>
    check(
      `parity: ${name} → ${expected[i]} (Postgres ${pgRun.outcomes[i]}, memory ${memRun.outcomes[i]})`,
      pgRun.outcomes[i] === expected[i] && memRun.outcomes[i] === expected[i],
    ),
  );
  check(
    "parity: the resulting edits are identical (memory vs Postgres, ids aside)",
    JSON.stringify(strip(pgRun.edit)) === JSON.stringify(strip(memRun.edit)),
    `${JSON.stringify(strip(pgRun.edit))} vs ${JSON.stringify(strip(memRun.edit))}`,
  );
  const reread = await owner.getForEpisode(P, E1);
  check(
    "the stored edit reads back exactly as returned",
    JSON.stringify(reread) === JSON.stringify(pgRun.edit),
  );
  check(
    "revision counted every successful mutation exactly once",
    pgRun.edit.revision === expected.filter((o) => o === "ok").length,
    String(pgRun.edit.revision),
  );
  check("the edit id is its own, not the Episode's", pgRun.edit.id !== E1 && pgRun.edit.episodeId === E1);
  check(
    "positions are dense 0..n-1",
    JSON.stringify(
      (
        await q("select position from episode_edit_items where edit_id = $1 order by position", [
          pgRun.edit.id,
        ])
      ).rows.map((r) => r.position),
    ) === JSON.stringify(pgRun.edit.items.map((_, i) => i)),
  );
  check(
    "a second edit of the same Episode is refused (conflict)",
    (await code(
      owner.create({ projectId: P, episodeId: E1, editRate: RATE, items: [], userId: dev.id, now: NOW() }),
    )) === "conflict",
  );
  const editId = pgRun.edit.id;

  // ── 3. database backstops (raw SQL as the owner; the application checks are never the only barrier) ──
  const rawItem = (o: Record<string, unknown>) => {
    const row = {
      id: id(),
      project_id: P,
      edit_id: editId,
      episode_id: E1,
      shot_id: C,
      position: 50,
      visual_kind: "none",
      attempt_id: null,
      asset_id: null,
      source_in_ms: null,
      source_out_ms: null,
      production_frame_id: null,
      storyboard_frame_id: null,
      duration_ms: 1000,
      ...o,
    };
    const cols = Object.keys(row);
    return [
      `insert into episode_edit_items (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    ] as [string, unknown[]];
  };
  const videoRow = (c: { attemptId: string; assetId: string }, shotId: string, sourceOutMs = 1000) => ({
    shot_id: shotId,
    visual_kind: "video",
    attempt_id: c.attemptId,
    asset_id: c.assetId,
    source_in_ms: 0,
    source_out_ms: sourceOutMs,
    duration_ms: null,
  });
  const barrier = async (name: string, statements: Array<[string, unknown[]]>, match: RegExp) => {
    const err = await ownerCommit(statements);
    check(name, err !== null && match.test(err), err ?? "accepted");
  };
  await barrier(
    "DB: a 'none' item with a clip column is refused (kind/column check)",
    [rawItem({ attempt_id: cB.attemptId })],
    /kind_columns/,
  );
  await barrier(
    "DB: a 'video' item with a hold duration is refused",
    [rawItem({ ...videoRow(cB, B), duration_ms: 1000 })],
    /kind_columns/,
  );
  await barrier("DB: an unknown kind is refused", [rawItem({ visual_kind: "hologram" })], /check constraint/);
  await barrier(
    "DB: a Production Frame candidate cannot be placed as video",
    [rawItem(videoRow(cBframe, B))],
    /Production Frame candidate/,
  );
  await barrier(
    "DB: a not-succeeded attempt cannot be placed",
    [rawItem(videoRow(cArunning, A))],
    /completed generation/,
  );
  await barrier("DB: an attempt of another Shot is refused", [rawItem(videoRow(cA, B))], /another Shot/);
  await barrier(
    "DB: an Asset that is not an output / delivery version of the attempt is refused",
    [rawItem(videoRow({ attemptId: cB.attemptId, assetId: cAunprobed.assetId }, B))],
    /not an output or delivery version/,
  );
  await barrier(
    "DB: a trim beyond the clip is refused",
    [rawItem(videoRow(cB, B, 10_001))],
    /outside the clip/,
  );
  await barrier(
    "DB: a Shot of another Episode is refused (composite key, at commit)",
    [rawItem({ shot_id: X })],
    /foreign key/,
  );
  await barrier(
    "DB: a Shot of another Project is refused (composite key, at commit)",
    [rawItem({ shot_id: Z })],
    /foreign key/,
  );
  await barrier(
    "DB: an item in another Project's edit context is refused",
    [rawItem({ project_id: P2, shot_id: Z, episode_id: E3 })],
    /foreign key|row-level security/,
  );
  await barrier(
    "DB: a storyboard frame of another Shot is refused",
    [rawItem({ visual_kind: "storyboard_frame", storyboard_frame_id: FA, shot_id: C })],
    /foreign key/,
  );
  await barrier(
    "DB: a second edit of the same Episode is refused (one per Episode)",
    [
      [
        "insert into episode_edits (project_id, episode_id, edit_rate_num, edit_rate_den) values ($1,$2,24,1)",
        [P, E1],
      ],
    ],
    /episode_edits_one_per_episode/,
  );
  await barrier(
    "DB: an unsupported edit rate is refused",
    [
      [
        "insert into episode_edits (project_id, episode_id, edit_rate_num, edit_rate_den) values ($1,$2,23,1)",
        [P, E2],
      ],
    ],
    /check constraint/,
  );
  const aItem = (await owner.getForEpisode(P, E1))!.items.find((i) => i.shotId === A)!.id;
  const rawPlacement = (o: Record<string, unknown>) => {
    const row = {
      project_id: P,
      item_id: aItem,
      dialogue_line_id: L1,
      take_id: T1,
      start_ms: 0,
      take_in_ms: 0,
      take_out_ms: 500,
      ...o,
    };
    const cols = Object.keys(row);
    return [
      `insert into episode_edit_audio_placements (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    ] as [string, unknown[]];
  };
  await barrier(
    "DB: a placement before the item start is refused (2I.1 rule)",
    [rawPlacement({ start_ms: -1 })],
    /start_inside_item/,
  );
  await barrier(
    "DB: a placement beyond the item end is refused",
    [rawPlacement({ start_ms: 3450, take_out_ms: 100 })],
    /beyond the end of its edit item/,
  );
  await barrier(
    "DB: a placement beyond its take is refused",
    [rawPlacement({ take_out_ms: 3401 })],
    /beyond the end of its take/,
  );
  await barrier("DB: an archived take cannot be placed", [rawPlacement({ take_id: T2 })], /archived take/);
  await barrier(
    "DB: a take of another line is refused",
    [rawPlacement({ dialogue_line_id: L2 })],
    /not a take of that line/,
  );
  const [first, second] = (await owner.getForEpisode(P, E1))!.items;
  const swap = await ownerCommit([
    ["update episode_edit_items set position = 1 where id = $1", [first!.id]],
    ["update episode_edit_items set position = 0 where id = $1", [second!.id]],
  ]);
  check(
    "DB: swapping two positions in one transaction is accepted (deferred unique)",
    swap === null,
    swap ?? "",
  );
  await barrier(
    "DB: a duplicate position is refused at commit",
    [["update episode_edit_items set position = 0 where id = $1", [first!.id]]],
    /episode_edit_items_position_key/,
  );
  // the swap above changed the order outside the repository: bring the revision story back in line for later sections
  const live = (await owner.getForEpisode(P, E1))!;

  // ── 4. optimistic concurrency ──
  const holdItem = live.items.find((i) => i.visual.kind !== "video")!.id;
  const race = await Promise.allSettled(
    [1111, 2222].map((durationMs) =>
      owner.apply({
        editId,
        projectId: P,
        expectedRevision: live.revision,
        ops: [{ op: "set_hold", itemId: holdItem, durationMs }],
        userId: dev.id,
        now: NOW(),
      }),
    ),
  );
  const won = race.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<EpisodeEdit>[];
  const lost = race.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  check(
    "two writers on the same revision: exactly one wins, the other gets a conflict",
    won.length === 1 && lost.length === 1 && (lost[0]!.reason as EpisodeEditError).code === "conflict",
    JSON.stringify(race.map((r) => r.status)),
  );
  const afterRace = (await owner.getForEpisode(P, E1))!;
  check(
    "…the stored edit is exactly the winner's (revision +1, the loser wrote nothing)",
    won.length === 1 &&
      JSON.stringify(afterRace) === JSON.stringify(won[0]!.value) &&
      afterRace.revision === live.revision + 1,
  );
  // a held row lock blocks a second writer, which then sees the bumped revision
  const holder = await pool.connect();
  let blocked = "";
  try {
    await holder.query(rlsPreamble({ sub: dev.id }));
    await holder.query("select 1 from episode_edits where id = $1 for update", [editId]);
    let settled = false;
    const pending = code(
      owner.apply({
        editId,
        projectId: P,
        expectedRevision: afterRace.revision,
        ops: [{ op: "set_hold", itemId: holdItem, durationMs: 3333 }],
        userId: dev.id,
        now: NOW(),
      }),
    ).then((c) => {
      settled = true;
      return c;
    });
    await sleep(800);
    check("a held FOR UPDATE on the edit blocks a second writer", !settled);
    await holder.query("update episode_edits set revision = revision + 1 where id = $1", [editId]);
    await holder.query("commit");
    blocked = await pending;
  } finally {
    await holder.query("rollback").catch(() => undefined);
    holder.release();
  }
  check(
    "…which, released, finds the revision moved and writes nothing (conflict)",
    blocked === "conflict",
    blocked,
  );
  const current = (await owner.getForEpisode(P, E1))!;
  check(
    "…and the item keeps the race winner's hold",
    JSON.stringify(current.items) === JSON.stringify(afterRace.items),
  );

  // ── 5. upstream changes never rewrite the edit ──
  const approvedClip = await mkClip(P, A, { approved: true, durationMs: 6000 });
  await q(
    "insert into attempt_deliveries (attempt_id, project_id, asset_id, original_asset_id) values ($1,$2,$3,$4)",
    [cA.attemptId, P, cAversion, cA.assetId],
  );
  check(
    "a new approval and a new delivery master leave the pinned clip untouched",
    JSON.stringify(await owner.getForEpisode(P, E1)) === JSON.stringify(current),
  );
  const useReplacement = await owner.apply({
    editId,
    projectId: P,
    expectedRevision: current.revision,
    ops: [
      {
        op: "use_replacement",
        itemId: aItem,
        expected: { attemptId: approvedClip.attemptId, assetId: approvedClip.assetId },
      },
    ],
    userId: dev.id,
    now: NOW(),
  });
  check(
    "…only the explicit use_replacement pins the approved clip",
    JSON.stringify(useReplacement.items.find((i) => i.id === aItem)!.visual) ===
      JSON.stringify(video(approvedClip, 0, 3500)),
    JSON.stringify(useReplacement.items.find((i) => i.id === aItem)!.visual),
  );

  // ── 6. deletion ──
  const shotDelete = await ownerCommit([["delete from shots where id = $1", [A]]]);
  check(
    "a Shot in the edit cannot be deleted directly",
    shotDelete !== null && /foreign key/.test(shotDelete),
    shotDelete ?? "accepted",
  );
  const attemptDelete = await ownerCommit([
    ["delete from generation_attempts where id = $1", [approvedClip.attemptId]],
  ]);
  check(
    "a pinned clip's attempt cannot be deleted directly",
    attemptDelete !== null,
    attemptDelete ?? "accepted",
  );
  const frameDelete = await ownerCommit([["delete from storyboard_frames where id = $1", [FB]]]);
  check(
    "a placeholder storyboard frame cannot be deleted directly",
    frameDelete !== null,
    frameDelete ?? "accepted",
  );
  check(
    "…the edit is intact after every refused delete",
    JSON.stringify(await owner.getForEpisode(P, E1)) === JSON.stringify(useReplacement),
  );
  const removed = await owner.apply({
    editId,
    projectId: P,
    expectedRevision: useReplacement.revision,
    ops: [{ op: "remove", itemId: aItem }],
    userId: dev.id,
    now: NOW(),
  });
  check(
    "removing the item takes its placements with it",
    removed.items.every((i) => i.shotId !== A),
  );
  const shotDeleteAfter = await ownerCommit([["delete from shots where id = $1", [A]]]);
  check("…after which the Shot can be deleted", shotDeleteAfter === null, shotDeleteAfter ?? "");
  const bItem = removed.items.find((i) => i.shotId === B)!.id;
  const withTake = await owner.apply({
    editId,
    projectId: P,
    expectedRevision: removed.revision,
    ops: [
      {
        op: "set_performance",
        itemId: bItem,
        placements: [placement({ takeOutMs: 1000 })],
        performanceBasis: null,
      },
    ],
    userId: dev.id,
    now: NOW(),
  });

  // ── 7. RLS ──
  check("RLS: the owner reads the edit", (await owner.get(P, editId)) !== null);
  check("RLS: a stranger cannot read the edit", (await strangerSvc.get(P, editId)) === null);
  check(
    "RLS: a stranger cannot mutate the edit",
    (await code(
      strangerSvc.apply({
        editId,
        projectId: P,
        expectedRevision: withTake.revision,
        ops: [],
        userId: stranger,
        now: NOW(),
      }),
    )) === "not_found",
  );
  check(
    "RLS: a stranger cannot delete the edit",
    (await code(strangerSvc.delete({ editId, projectId: P, expectedRevision: withTake.revision }))) ===
      "not_found" && (await owner.get(P, editId)) !== null,
  );
  for (const t of tables) {
    const s = await asStranger(`select count(*)::int n from ${t} where project_id = $1`, [P]);
    const a = await asAnon(`select count(*)::int n from ${t} where project_id = $1`, [P]);
    const o = await asOwner(`select count(*)::int n from ${t} where project_id = $1`, [P]);
    check(
      `RLS: ${t} is invisible to a stranger and anon, visible to the owner`,
      s.rows[0]?.n === 0 && a.rows[0]?.n === 0 && o.rows[0]?.n > 0,
    );
  }
  const strangerInsert = await asStranger(
    "insert into episode_edits (project_id, episode_id, edit_rate_num, edit_rate_den) values ($1,$2,24,1)",
    [P, E2],
  );
  check(
    "RLS: a stranger cannot insert an edit into the owner's project",
    /row-level security/.test(strangerInsert.error ?? ""),
    strangerInsert.error ?? "accepted",
  );
  const strangerUpdate = await asStranger(
    "update episode_edits set revision = revision + 100 where id = $1",
    [editId],
  );
  check(
    "RLS: a stranger's update touches nothing",
    strangerUpdate.rowCount === 0 && strangerUpdate.error === null,
  );

  // ── 8. a Project delete cascades through its edit ──
  await owner.create({
    projectId: P2,
    episodeId: E3,
    editRate: RATE,
    items: [item(Z, video(cZ, 0, 2000))],
    userId: dev.id,
    now: NOW(),
  });
  const p2Delete = await ownerCommit([["delete from projects where id = $1", [P2]]]);
  check(
    "deleting a Project with an edit succeeds (cascade, deferred keys)",
    p2Delete === null,
    p2Delete ?? "",
  );
  const p2Left = (
    await q(
      `select (select count(*) from episode_edits where project_id = $1) + (select count(*) from episode_edit_items where project_id = $1)
        + (select count(*) from episode_edit_audio_placements where project_id = $1) as n`,
      [P2],
    )
  ).rows[0].n;
  check("…and leaves no edit, item or placement", Number(p2Left) === 0, String(p2Left));
} catch (err) {
  check("suite ran to completion", false, (err as Error).stack ?? String(err));
} finally {
  if (cleanup) {
    for (const pid of [P, P2]) await q("delete from projects where id = $1", [pid]).catch(() => undefined);
    const left = (
      await q(
        `select (select count(*) from projects where id = any($1)) + (select count(*) from episode_edits where project_id = any($1))
          + (select count(*) from assets where project_id = any($1)) as n`,
        [[P, P2]],
      )
    ).rows[0].n;
    check("cleanup: no row of either throwaway project remains", Number(left) === 0, String(left));
    cleanup = false;
  }
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
