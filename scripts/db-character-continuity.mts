// Integration tests for Phase 2G.4 Character Continuity Locks against the REAL dedicated Prism Studio database
// (migration 0041: character_continuity_locks, character_continuity_lock_assets, shot_character_continuity_selections;
// 0042: the Lock image → Asset key is deferred so a Project cascade passes through Lock images).
//   npm run db:character-continuity
//
// Exercises (with real rows, cleaned up afterwards): create (Lock + frozen images together; existing Assets reused, no
// bytes copied), dedupe under real concurrency, immutability of Locks AND their membership (no update, no later
// growth, no incomplete Lock), the Asset-facts trigger, the Look-of-this-Character check, the one-per-assignment
// selection with compare-and-set, wrong Character / wrong Look / not assigned refused in the service AND the database,
// the Look-change trigger (only that Character's selection), the diff-based Shot write (an unrelated Shot save keeps
// selections; removing the Character cascades), owner-only RLS (owner / stranger / anon), that NEITHER worker role has
// any privilege, asset pinning, cascades (assignment, Shot, Character, Project), and that the loaded state resolves
// into a GenerationPackage v5. Requires `npm run db:seed` first (uses the demo project). No provider call, no 3D, no GPU.
// Image BYTES are not stored here (the Storage path is covered by the Supabase e2e); this suite proves the relational
// contract.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresCharacterContinuityData } from "../src/data/character-continuity-postgres";
import { CharacterContinuityError } from "../src/data/character-continuity-repository";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import {
  draftCharacterContinuityLock,
  type CharacterContinuityLock,
} from "../src/domain/character-continuity";
import { buildShotContext } from "../src/domain/context";
import { assembleGenerationPackage, PACKAGE_SCHEMA_VERSION } from "../src/domain/generation-package";
import { deriveProductionFrameReferenceCandidates } from "../src/domain/generation/compatibility";
import type { CharacterLook, IdentityRef, ProjectData } from "../src/domain/schemas";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "character continuity integration tests (rows created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 12 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresCharacterContinuityData(pool, rlsPreamble({ sub: dev.id }));
const strangerSvc = new PostgresCharacterContinuityData(pool, rlsPreamble({ sub: stranger }));

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
/** A statement in its own transaction (deferred constraint triggers run at its commit). */
const sqlErr = async (sql: string, params: unknown[] = []) => {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(sql, params);
    await c.query("commit");
    return null as string | null;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return (e as Error).message;
  } finally {
    c.release();
  }
};
const code = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: unknown) => (e instanceof CharacterContinuityError ? e.code : `other: ${(e as Error).message}`),
  );

const created = {
  assetIds: [] as string[],
  lookIds: [] as string[],
  characterIds: [] as string[],
  shotIds: [] as string[],
  projectIds: [] as string[],
};
// the demo assignments this suite touches, exactly as they were (restored afterwards)
let restoreAssignments: Array<Record<string, unknown>> = [];
let touchedShots: string[] = [];

try {
  const data: ProjectData = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shot6A = data.shots.find((s) => s.shotCode === "6A")!; // Sean + Yumeko
  const shot3A = data.shots.find((s) => s.shotCode === "3A")!; // Yumeko
  const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
  const sean = data.characters.find((c) => c.name === "Sean")!;
  const seanLook = data.looks.find((l) => l.characterId === sean.id)!;
  const black = data.looks.find((l) => l.characterId === yumeko.id)!;
  check(
    "the demo Shots are where this suite expects (6A: Sean + Yumeko; 3A: Yumeko)",
    shot6A.characters.map((c) => c.characterId).join() === [sean.id, yumeko.id].join() &&
      shot3A.characters.some((c) => c.characterId === yumeko.id),
  );
  touchedShots = [shot6A.id, shot3A.id];
  restoreAssignments = (
    await pool.query("select * from shot_characters where shot_id = any($1::uuid[])", [touchedShots])
  ).rows;
  const preexisting = (
    await pool.query(
      "select count(*)::int n from shot_character_continuity_selections where shot_id = any($1::uuid[])",
      [touchedShots],
    )
  ).rows[0].n;
  check(
    "no pre-existing selections on the demo Shots this suite uses",
    preexisting === 0,
    String(preexisting),
  );

  // ── 1. structure, security ──
  const tables = [
    "character_continuity_locks",
    "character_continuity_lock_assets",
    "shot_character_continuity_selections",
  ];
  for (const t of tables) {
    const rls = await pool.query("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [
      t,
    ]);
    check(`${t} exists with row-level security enabled`, rls.rows[0]?.relrowsecurity === true);
  }
  const pols = await pool.query(
    "select tablename, cmd from pg_policies where schemaname = 'public' and tablename = any($1::text[])",
    [tables],
  );
  const cmds = (t: string) =>
    pols.rows
      .filter((p) => p.tablename === t)
      .map((p) => p.cmd)
      .sort();
  check(
    "Locks: SELECT and INSERT policies only (immutable: no UPDATE or DELETE policy)",
    JSON.stringify(cmds("character_continuity_locks")) === JSON.stringify(["INSERT", "SELECT"]),
    JSON.stringify(cmds("character_continuity_locks")),
  );
  check(
    "Lock images: SELECT and INSERT policies only",
    JSON.stringify(cmds("character_continuity_lock_assets")) === JSON.stringify(["INSERT", "SELECT"]),
  );
  check("selections: one owner policy", cmds("shot_character_continuity_selections").length === 1);
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    for (const t of tables) {
      const p = await pool.query(
        `select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i,
                has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d`,
        [role, `public.${t}`],
      );
      const r = p.rows[0];
      check(`${role} has NO privilege on ${t}`, !r.s && !r.i && !r.u && !r.d);
    }
  }

  // ── fixtures: stored images, an "Ivory Suit" Look for Yumeko, assigned on 3A and 6A ──
  const mkAsset = async (
    name: string,
    o: { project?: string; path?: string | null; type?: string; w?: number; h?: number } = {},
  ) => {
    const id = randomUUID();
    const project = o.project ?? projectId;
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum, width, height, metadata)
       values ($1,$2,$3,$4,'identity_ref','upload','local',$5,'image/png',$6,$7,$8,'{}'::jsonb)`,
      [
        id,
        project,
        name,
        o.type ?? "image",
        o.path === undefined ? `${project}/${id}/db-cc.png` : o.path,
        sha(name),
        o.w ?? 768,
        o.h ?? 1024,
      ],
    );
    created.assetIds.push(id);
    return id;
  };
  const ivoryId = randomUUID();
  await pool.query(
    `insert into character_looks (id, project_id, character_id, name, wardrobe, hair, makeup, jewelry, locked)
     values ($1,$2,$3,'db:cc Ivory Suit','ivory tailored suit','low chignon','soft matte','pearl earrings', false)`,
    [ivoryId, projectId, yumeko.id],
  );
  created.lookIds.push(ivoryId);
  const front = await mkAsset("db:cc yumeko front");
  const profile = await mkAsset("db:cc yumeko profile");
  const lookRef = await mkAsset("db:cc ivory look ref");
  await pool.query("update character_looks set reference_asset_ids = $2 where id = $1", [ivoryId, [lookRef]]);
  const refs = (f = front, p = profile): IdentityRef[] => [
    {
      id: "r1",
      characterId: yumeko.id,
      slot: "front",
      assetId: f,
      label: "front",
      metadata: {},
      locked: true,
    },
    {
      id: "r2",
      characterId: yumeko.id,
      slot: "profile",
      assetId: p,
      label: "profile",
      metadata: {},
      locked: true,
    },
    // a placeholder: never frozen
    {
      id: "r3",
      characterId: yumeko.id,
      slot: "full_body",
      assetId: null,
      label: "full body",
      metadata: {},
      locked: false,
    },
  ];
  const lookRow = async (id: string): Promise<CharacterLook> =>
    (await admin.loadProject("ojousama"))!.looks.find((l) => l.id === id)!;
  const draftOf = async (
    o: { name?: string; look?: CharacterLook | null; identity?: IdentityRef[]; characterId?: string } = {},
  ): Promise<CharacterContinuityLock> => {
    const d = (await admin.loadProject("ojousama"))!;
    const character = d.characters.find((c) => c.id === (o.characterId ?? yumeko.id))!;
    const r = draftCharacterContinuityLock({
      id: randomUUID(),
      now: now(),
      userId: dev.id,
      projectId,
      name: o.name ?? "db:cc Yumeko — Ivory Suit",
      character,
      look: o.look === undefined ? await lookRow(ivoryId) : o.look,
      identityRefs: o.identity ?? refs(),
      assets: d.assets,
    });
    if (!r.ok) throw new Error(`draft refused: ${r.message}`);
    return r.draft;
  };
  const assetCount = async () =>
    (await pool.query("select count(*)::int n from assets where project_id = $1", [projectId])).rows[0]
      .n as number;
  await pool.query("update shot_characters set look_id = $3 where shot_id = $1 and character_id = $2", [
    shot3A.id,
    yumeko.id,
    ivoryId,
  ]);
  await pool.query("update shot_characters set look_id = $3 where shot_id = $1 and character_id = $2", [
    shot6A.id,
    yumeko.id,
    ivoryId,
  ]);

  // ── 2. create: the Lock and its frozen images together; Assets reused ──
  const a0 = await assetCount();
  const draftA = await draftOf();
  const rA = await owner.create(draftA);
  const lockA = rA.lock;
  check("a Lock is created with its frozen images", rA.created && lockA.references.length === 3);
  check(
    "…identity images in slot order, then the Look image; the placeholder is NOT frozen",
    JSON.stringify(lockA.references.map((r) => [r.role, r.identitySlot, r.assetId])) ===
      JSON.stringify([
        ["identity", "front", front],
        ["identity", "profile", profile],
        ["look", null, lookRef],
      ]),
  );
  check(
    "…the stored record equals the draft (facts, images, fingerprint by value)",
    lockA.lockFingerprint === draftA.lockFingerprint &&
      JSON.stringify(lockA.facts) === JSON.stringify(draftA.facts) &&
      JSON.stringify(lockA.references) === JSON.stringify(draftA.references),
  );
  check("…no Asset was created or copied", (await assetCount()) === a0);
  check(
    "…facts snapshot copied by value (wardrobe, hair, Look name, Character name)",
    lockA.facts.look?.wardrobe === "ivory tailored suit" &&
      lockA.facts.look?.hair === "low chignon" &&
      lockA.facts.look?.name === "db:cc Ivory Suit" &&
      lockA.facts.characterName === "Yumeko",
  );

  // ── 3. dedupe, concurrency ──
  const dup = await owner.create(await draftOf({ name: "db:cc another name" }));
  check(
    "an identical appearance returns the EXISTING Lock (name is not identity)",
    !dup.created && dup.lock.id === lockA.id,
  );
  const twinDraft = await draftOf({
    name: "db:cc twin",
    identity: refs(front, await mkAsset("db:cc twin profile")),
  });
  const twins = await Promise.all(
    Array.from({ length: 5 }, () => owner.create({ ...twinDraft, id: randomUUID() })),
  );
  check(
    "5 concurrent IDENTICAL creates make exactly one Lock",
    twins.filter((t) => t.created).length === 1 && new Set(twins.map((t) => t.lock.id)).size === 1,
  );
  const twinRows = (
    await pool.query(
      "select count(*)::int n from character_continuity_locks where character_id = $1 and lock_fingerprint = $2",
      [yumeko.id, twinDraft.lockFingerprint],
    )
  ).rows[0].n;
  check("…one row in the database", twinRows === 1);
  await pool.query("update character_looks set wardrobe = 'black evening gown' where id = $1", [ivoryId]);
  const wardrobe = await owner.create(await draftOf({ name: "db:cc changed wardrobe" }));
  check("a changed wardrobe is a NEW Lock", wardrobe.created && wardrobe.lock.id !== lockA.id);
  await pool.query("update character_looks set wardrobe = 'ivory tailored suit' where id = $1", [ivoryId]);
  const newFront = await mkAsset("db:cc yumeko front v2");
  const identityChange = await owner.create(
    await draftOf({ name: "db:cc new front", identity: refs(newFront) }),
  );
  check(
    "a changed identity image is a NEW Lock",
    identityChange.created && identityChange.lock.id !== lockA.id,
  );
  const lockA2 = await owner.create(await draftOf({ name: "db:cc again" }));
  check("…and the original appearance is still the original Lock", lockA2.lock.id === lockA.id);

  // ── 4. immutability ──
  for (const [label, sql] of [
    ["name", "update character_continuity_locks set name = 'renamed' where id = $1"],
    ["facts", "update character_continuity_locks set facts_snapshot = facts_snapshot where id = $1"],
    ["source Look", "update character_continuity_locks set source_look_id = null where id = $1"],
    [
      "fingerprint",
      "update character_continuity_locks set lock_fingerprint = lock_fingerprint where id = $1",
    ],
  ] as const)
    check(
      `a Lock's ${label} cannot be updated (even by the database owner)`,
      (await sqlErr(sql, [lockA.id]))?.includes("immutable") === true,
    );
  check(
    "a Lock image row cannot be updated",
    (
      await sqlErr("update character_continuity_lock_assets set label = 'x' where lock_id = $1", [lockA.id])
    )?.includes("immutable") === true,
  );
  check(
    "RLS: the owner cannot UPDATE or DELETE a Lock (no policy)",
    (await asOwner("update character_continuity_locks set name = 'x' where id = $1", [lockA.id])).rowCount ===
      0 && (await asOwner("delete from character_continuity_locks where id = $1", [lockA.id])).rowCount === 0,
  );
  check(
    "RLS: the owner cannot DELETE a Lock image (no policy)",
    (await asOwner("delete from character_continuity_lock_assets where lock_id = $1", [lockA.id]))
      .rowCount === 0,
  );
  const extra = await mkAsset("db:cc extra");
  const grow = await sqlErr(
    `insert into character_continuity_lock_assets (lock_id, project_id, position, asset_id, role, identity_slot, label, asset_checksum, width, height)
     values ($1,$2,9,$3,'look',null,'',$4,768,1024)`,
    [lockA.id, projectId, extra, sha("db:cc extra")],
  );
  check(
    "a Lock's membership can never grow after creation",
    grow?.includes("frozen at creation") === true,
    grow ?? "",
  );
  const lockBad = randomUUID();
  const incomplete = await sqlErr(
    `insert into character_continuity_locks (id, project_id, character_id, source_look_id, schema_version, name, facts_snapshot, reference_count, lock_fingerprint)
     values ($1,$2,$3,$4,'prism.character-continuity-lock.v1','db:cc incomplete',$5::jsonb,2,$6)`,
    [lockBad, projectId, yumeko.id, ivoryId, JSON.stringify({ ...lockA.facts }), sha("db:cc incomplete")],
  );
  check(
    "an incomplete Lock (fewer images than it froze) is refused at commit",
    incomplete?.includes("frozen at creation") === true,
    incomplete ?? "",
  );

  // ── 5. the Asset-facts trigger, the Look check ──
  const insertLockWith = async (member: { asset: string; checksum: string; project?: string }) =>
    sqlErr(
      `with l as (
         insert into character_continuity_locks (id, project_id, character_id, source_look_id, schema_version, name, facts_snapshot, reference_count, lock_fingerprint)
         values ($1,$2,$3,null,'prism.character-continuity-lock.v1','db:cc probe',$4::jsonb,1,$5) returning id)
       insert into character_continuity_lock_assets (lock_id, project_id, position, asset_id, role, identity_slot, label, asset_checksum, width, height)
       select id, $2, 0, $6, 'identity', 'front', 'front', $7, 768, 1024 from l`,
      [
        randomUUID(),
        member.project ?? projectId,
        yumeko.id,
        JSON.stringify({ ...lockA.facts, sourceLookId: null, look: null }),
        sha(randomUUID()),
        member.asset,
        member.checksum,
      ],
    );
  check(
    "the database refuses a Lock image whose checksum differs from its Asset",
    (await insertLockWith({ asset: front, checksum: sha("not the bytes") }))?.includes("do not match") ===
      true,
  );
  const placeholder = await mkAsset("db:cc placeholder", { path: null });
  check(
    "…a placeholder Asset (no stored file)",
    (await insertLockWith({ asset: placeholder, checksum: sha("db:cc placeholder") }))?.includes(
      "no stored file",
    ) === true,
  );
  const video = await mkAsset("db:cc video", { type: "video" });
  check(
    "…a non-image Asset",
    (await insertLockWith({ asset: video, checksum: sha("db:cc video") }))?.includes("must be an image") ===
      true,
  );
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-cc-${otherProject.slice(0, 8)}`,
    "db:cc other project",
  ]);
  created.projectIds.push(otherProject);
  const foreign = await mkAsset("db:cc foreign image", { project: otherProject });
  check(
    "…an Asset of another project",
    (await insertLockWith({ asset: foreign, checksum: sha("db:cc foreign image") })) !== null,
  );
  check(
    "the database refuses a Lock of ANOTHER Character's Look",
    (
      await sqlErr(
        `insert into character_continuity_locks (id, project_id, character_id, source_look_id, schema_version, name, facts_snapshot, reference_count, lock_fingerprint)
         values ($1,$2,$3,$4,'prism.character-continuity-lock.v1','db:cc wrong look',$5::jsonb,0,$6)`,
        [
          randomUUID(),
          projectId,
          yumeko.id,
          seanLook.id,
          JSON.stringify({ ...lockA.facts, sourceLookId: seanLook.id }),
          sha("w"),
        ],
      )
    )?.includes("not a Look of this Character") === true,
  );
  check(
    "the database refuses facts that name another Character",
    (await sqlErr(
      `insert into character_continuity_locks (id, project_id, character_id, source_look_id, schema_version, name, facts_snapshot, reference_count, lock_fingerprint)
       values ($1,$2,$3,null,'prism.character-continuity-lock.v1','db:cc wrong facts',$4::jsonb,0,$5)`,
      [
        randomUUID(),
        projectId,
        yumeko.id,
        JSON.stringify({ ...lockA.facts, characterId: sean.id, sourceLookId: null, look: null }),
        sha("f"),
      ],
    )) !== null,
  );

  // ── 6. selection: same Character + same Look only; compare-and-set ──
  // Sean's Lock (his Charcoal Suit, one identity image) and Yumeko's Lock of her OTHER Look
  const seanFront = await mkAsset("db:cc sean front");
  const seanLock = (
    await owner.create(
      await draftOf({
        name: "db:cc Sean — Charcoal",
        characterId: sean.id,
        look: seanLook,
        identity: [
          {
            id: "s1",
            characterId: sean.id,
            slot: "front",
            assetId: seanFront,
            label: "front",
            metadata: {},
            locked: true,
          },
        ],
      }),
    )
  ).lock;
  const blackLock = (await owner.create(await draftOf({ name: "db:cc Yumeko — Black", look: black }))).lock;
  const sel = (shotId: string, characterId: string, lockId: string, expected?: string | null) =>
    owner.selectForAssignment({
      projectId,
      shotId,
      characterId,
      continuityLockId: lockId,
      userId: dev.id,
      now: now(),
      expectedSelectedLockId: expected,
    });
  check(
    "selecting a Lock of the assignment's Character + Look succeeds",
    (await code(sel(shot6A.id, yumeko.id, lockA.id, null))) === "no error",
  );
  check(
    "…re-selecting it writes nothing and succeeds",
    (await code(sel(shot6A.id, yumeko.id, lockA.id, lockA.id))) === "no error",
  );
  check(
    "Sean's Lock for Yumeko's assignment: REFUSED (wrong_character)",
    (await code(sel(shot6A.id, yumeko.id, seanLock.id))) === "wrong_character",
  );
  check(
    "Yumeko's Black Look Lock for an Ivory Suit assignment: REFUSED (wrong_look)",
    (await code(sel(shot6A.id, yumeko.id, blackLock.id))) === "wrong_look",
  );
  check(
    "a Character not assigned to the Shot: REFUSED",
    (await code(sel(shot3A.id, sean.id, seanLock.id))) === "not_found",
  );
  check(
    "a stale compare-and-set: conflict",
    (await code(sel(shot6A.id, yumeko.id, lockA.id, null))) === "conflict",
  );
  check(
    "Sean's Lock for Sean's assignment succeeds",
    (await code(sel(shot6A.id, sean.id, seanLock.id, null))) === "no error",
  );
  check(
    "the same Lock may be selected by another Shot (no global current Lock)",
    (await code(sel(shot3A.id, yumeko.id, lockA.id))) === "no error",
  );
  const rawSel = (shotId: string, characterId: string, lockId: string, project = projectId) =>
    sqlErr(
      "insert into shot_character_continuity_selections (shot_id, character_id, project_id, continuity_lock_id) values ($1,$2,$3,$4) on conflict (shot_id, character_id) do update set continuity_lock_id = excluded.continuity_lock_id, project_id = excluded.project_id",
      [shotId, characterId, project, lockId],
    );
  check(
    "the database refuses another Character's Lock (composite key)",
    (await rawSel(shot6A.id, yumeko.id, seanLock.id)) !== null,
  );
  check(
    "the database refuses a Lock of another Look (trigger)",
    (await rawSel(shot6A.id, yumeko.id, blackLock.id))?.includes("same Character and Look") === true,
  );
  check(
    "the database refuses a selection for an unassigned Character",
    (await rawSel(shot3A.id, sean.id, seanLock.id)) !== null,
  );
  check(
    "the database refuses a selection naming another project",
    (await rawSel(shot6A.id, yumeko.id, lockA.id, otherProject)) !== null,
  );
  const sels = async (shotId: string) =>
    (
      await pool.query(
        "select character_id, continuity_lock_id from shot_character_continuity_selections where shot_id = $1 order by character_id",
        [shotId],
      )
    ).rows.map((r) => [String(r.character_id), String(r.continuity_lock_id)]);
  check("6A carries one selection per assignment (Sean, Yumeko)", (await sels(shot6A.id)).length === 2);

  // ── 7. the Shot write keeps assignments; Look change clears ONLY that Character's selection ──
  const fresh = async () => (await admin.loadProject("ojousama"))!;
  const s6 = (await fresh()).shots.find((s) => s.id === shot6A.id)!;
  await admin.upsert(projectId, "shots", { ...s6, title: `${s6.title}` });
  check(
    "an unrelated Shot save keeps every selection (assignments are updated, not re-created)",
    (await sels(shot6A.id)).length === 2,
  );
  await pool.query(
    "update shot_characters set expression = 'db:cc' where shot_id = $1 and character_id = $2",
    [shot6A.id, yumeko.id],
  );
  check("an assignment update that keeps the Look keeps the selection", (await sels(shot6A.id)).length === 2);
  await admin.upsert(projectId, "shots", {
    ...s6,
    characters: s6.characters.map((c) => (c.characterId === yumeko.id ? { ...c, lookId: black.id } : c)),
  });
  check(
    "changing Yumeko's Look clears HER selection only (Sean's stays)",
    JSON.stringify(await sels(shot6A.id)) === JSON.stringify([[sean.id, seanLock.id]]),
  );
  check(
    "…and no Ivory Suit selection remains on 6A",
    !(await sels(shot6A.id)).some(([, l]) => l === lockA.id),
  );
  await admin.upsert(projectId, "shots", {
    ...s6,
    characters: s6.characters.filter((c) => c.characterId !== sean.id),
  });
  check("removing Sean from the Shot removes his selection (cascade)", (await sels(shot6A.id)).length === 0);
  await admin.upsert(projectId, "shots", s6);
  check("…the assignment restored, nothing was silently re-selected", (await sels(shot6A.id)).length === 0);
  // clear: compare-and-set
  check(
    "clear with a stale expectation: conflict",
    (await code(
      owner.clearForAssignment({
        projectId,
        shotId: shot3A.id,
        characterId: yumeko.id,
        expectedSelectedLockId: null,
      }),
    )) === "conflict",
  );
  await owner.clearForAssignment({
    projectId,
    shotId: shot3A.id,
    characterId: yumeko.id,
    expectedSelectedLockId: lockA.id,
  });
  check("clear removes the pointer", (await sels(shot3A.id)).length === 0);
  await sel(shot3A.id, yumeko.id, lockA.id, null);

  // ── 8. RLS ──
  const ownerSees = (
    await asOwner("select count(*)::int n from character_continuity_locks where project_id = $1", [projectId])
  ).rows[0].n;
  check("RLS: the owner reads the project's Locks", ownerSees >= 5, String(ownerSees));
  for (const [who, run] of [
    ["a stranger", asStranger],
    ["anon", asAnon],
  ] as const) {
    const r = await run(
      `select (select count(*) from character_continuity_locks)::int + (select count(*) from character_continuity_lock_assets)::int
            + (select count(*) from shot_character_continuity_selections)::int n`,
    );
    check(
      `RLS: ${who} reads 0 Locks, 0 Lock images, 0 selections`,
      r.error !== null || r.rows[0].n === 0,
      JSON.stringify(r.rows[0] ?? r.error),
    );
  }
  check(
    "a stranger's service sees an empty project",
    (await strangerSvc.listForProject(projectId)).locks.length === 0,
  );
  check(
    "a stranger cannot create a Lock in the owner's project",
    (await code(
      strangerSvc.create(
        await draftOf({ name: "db:cc stranger", identity: refs(front, await mkAsset("db:cc stranger p")) }),
      ),
    )) !== "no error",
  );
  check(
    "a stranger cannot select or clear in the owner's project",
    (await code(
      strangerSvc.selectForAssignment({
        projectId,
        shotId: shot3A.id,
        characterId: yumeko.id,
        continuityLockId: lockA.id,
        userId: stranger,
        now: now(),
      }),
    )) !== "no error" &&
      (await code(
        strangerSvc.clearForAssignment({ projectId, shotId: shot3A.id, characterId: yumeko.id }),
      )) !== "no error" &&
      (await sels(shot3A.id)).length === 1,
  );
  check(
    "RLS: a stranger cannot insert a selection row directly",
    (
      await asStranger(
        "insert into shot_character_continuity_selections (shot_id, character_id, project_id, continuity_lock_id) values ($1,$2,$3,$4)",
        [shot6A.id, yumeko.id, projectId, lockA.id],
      )
    ).error !== null,
  );

  // ── 9. asset pinning ──
  check(
    "a Lock image cannot be deleted from under its Lock (project-safe FK, checked at commit)",
    (await sqlErr("delete from assets where id = $1", [front])) !== null,
  );
  const fk = (
    await pool.query(
      "select condeferrable, condeferred from pg_constraint where conname = 'character_continuity_lock_assets_asset_id_project_id_fkey'",
    )
  ).rows[0];
  check(
    "0042: the Lock image → Asset key is DEFERRABLE INITIALLY DEFERRED (Project cascades pass)",
    fk?.condeferrable === true && fk?.condeferred === true,
  );
  check("usesAsset sees the Lock image", await owner.usesAsset(front));

  // ── 10. the loaded state resolves into a GenerationPackage v5 ──
  const cc = await owner.listForProject(projectId);
  const loaded = {
    ...(await fresh()),
    characterContinuityLocks: cc.locks,
    shotCharacterContinuitySelections: cc.selections,
  };
  const pkg = assembleGenerationPackage(buildShotContext(loaded, shot3A.id));
  check(
    "a package built from the database state is v5 and names the Lock by value",
    pkg.version === PACKAGE_SCHEMA_VERSION &&
      PACKAGE_SCHEMA_VERSION === 5 &&
      pkg.references.characterContinuity?.[0]?.lockId === lockA.id &&
      Boolean(pkg.assets[front]) &&
      Boolean(pkg.assets[lookRef]),
  );
  check(
    "…and a Production Frame candidate would send the LOCKED images as identity / character_look",
    JSON.stringify(
      deriveProductionFrameReferenceCandidates(pkg)
        .filter((r) => r.role === "identity" || r.role === "character_look")
        .map((r) => [r.role, r.assetId]),
    ) ===
      JSON.stringify([
        ["identity", front],
        ["identity", profile],
        ["character_look", lookRef],
      ]),
  );

  // ── 11. cascades: Shot, Character, Project (no over-broad trigger) ──
  const tmpShot = randomUUID();
  await pool.query(
    `insert into shots (id, project_id, episode_id, scene_id, shot_code, title, location_id)
     select $1, project_id, episode_id, scene_id, 'DBCC', 'db:cc cascade shot', location_id from shots where id = $2`,
    [tmpShot, shot3A.id],
  );
  created.shotIds.push(tmpShot);
  await pool.query("insert into shot_characters (shot_id, character_id, look_id) values ($1,$2,$3)", [
    tmpShot,
    yumeko.id,
    ivoryId,
  ]);
  await sel(tmpShot, yumeko.id, lockA.id);
  await pool.query("delete from shots where id = $1", [tmpShot]);
  created.shotIds.splice(created.shotIds.indexOf(tmpShot), 1);
  check(
    "deleting a Shot removes its selections (the Lock stays)",
    (
      await pool.query(
        "select count(*)::int n from shot_character_continuity_selections where shot_id = $1",
        [tmpShot],
      )
    ).rows[0].n === 0 &&
      (await pool.query("select count(*)::int n from character_continuity_locks where id = $1", [lockA.id]))
        .rows[0].n === 1,
  );
  const tmpChar = randomUUID();
  await pool.query("insert into characters (id, project_id, name) values ($1,$2,'db:cc Temp')", [
    tmpChar,
    projectId,
  ]);
  created.characterIds.push(tmpChar);
  const tmpAsset = await mkAsset("db:cc temp front");
  const tmpLock = (
    await owner.create(
      await draftOf({
        name: "db:cc Temp — no Look",
        characterId: tmpChar,
        look: null,
        identity: [
          {
            id: "t1",
            characterId: tmpChar,
            slot: "front",
            assetId: tmpAsset,
            label: "front",
            metadata: {},
            locked: true,
          },
        ],
      }),
    )
  ).lock;
  check(
    "an intentional no-Look Lock stores source_look_id null",
    tmpLock.sourceLookId === null && tmpLock.facts.look === null,
  );
  const charDelete = await sqlErr("delete from characters where id = $1", [tmpChar]);
  check(
    "deleting a Character cascades its Locks and their images (the Asset is then deletable)",
    charDelete === null &&
      (
        await pool.query("select count(*)::int n from character_continuity_lock_assets where lock_id = $1", [
          tmpLock.id,
        ])
      ).rows[0].n === 0 &&
      (await sqlErr("delete from assets where id = $1", [tmpAsset])) === null,
    charDelete ?? "",
  );
  if (charDelete === null) created.characterIds.splice(created.characterIds.indexOf(tmpChar), 1);
  created.assetIds.splice(created.assetIds.indexOf(tmpAsset), 1);
  // a whole other project with a Character, Look, image, Lock, Shot, assignment and selection can be deleted
  const ep = randomUUID();
  const sc = randomUUID();
  const opShot = randomUUID();
  const opChar = randomUUID();
  const opLook = randomUUID();
  await pool.query(
    "insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'db-cc','db:cc ep')",
    [ep, otherProject],
  );
  await pool.query(
    "insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext) values ($1,$2,$3,'1','db:cc scene','INT')",
    [sc, otherProject, ep],
  );
  await pool.query(
    "insert into shots (id, project_id, episode_id, scene_id, shot_code, title) values ($1,$2,$3,$4,'1A','db:cc op shot')",
    [opShot, otherProject, ep, sc],
  );
  await pool.query("insert into characters (id, project_id, name) values ($1,$2,'db:cc Other')", [
    opChar,
    otherProject,
  ]);
  await pool.query(
    "insert into character_looks (id, project_id, character_id, name) values ($1,$2,$3,'db:cc other look')",
    [opLook, otherProject, opChar],
  );
  await pool.query("insert into shot_characters (shot_id, character_id, look_id) values ($1,$2,$3)", [
    opShot,
    opChar,
    opLook,
  ]);
  const opImg = foreign;
  const opFacts = {
    ...lockA.facts,
    characterId: opChar,
    characterName: "db:cc Other",
    sourceLookId: opLook,
    look: { ...lockA.facts.look!, name: "db:cc other look" },
  };
  const opLockId = randomUUID();
  const opInsert = await sqlErr(
    `with l as (
       insert into character_continuity_locks (id, project_id, character_id, source_look_id, schema_version, name, facts_snapshot, reference_count, lock_fingerprint)
       values ($1,$2,$3,$4,'prism.character-continuity-lock.v1','db:cc other lock',$5::jsonb,1,$6) returning id)
     insert into character_continuity_lock_assets (lock_id, project_id, position, asset_id, role, identity_slot, label, asset_checksum, width, height)
     select id, $2, 0, $7, 'identity', 'front', 'front', $8, 768, 1024 from l`,
    [
      opLockId,
      otherProject,
      opChar,
      opLook,
      JSON.stringify(opFacts),
      sha("db:cc other lock"),
      opImg,
      sha("db:cc foreign image"),
    ],
  );
  const opSel = await rawSel(opShot, opChar, opLockId, otherProject);
  check(
    "the other project's Lock and selection were created",
    opInsert === null && opSel === null,
    `${opInsert} ${opSel}`,
  );
  const projectDelete = await sqlErr("delete from projects where id = $1", [otherProject]);
  check(
    "deleting a Project cascades through its Locks, images and selections (no over-broad trigger)",
    projectDelete === null,
    projectDelete ?? "",
  );
  if (projectDelete === null) {
    created.projectIds.splice(created.projectIds.indexOf(otherProject), 1);
    created.assetIds = created.assetIds.filter((id) => id !== foreign);
  }
} finally {
  // Locks are append-only for users: this cleanup runs as the database owner (images and selections cascade)
  await pool
    .query("delete from shot_character_continuity_selections where shot_id = any($1::uuid[])", [touchedShots])
    .catch(() => undefined);
  await pool.query("delete from character_continuity_locks where name like 'db:cc%'").catch(() => undefined);
  for (const id of created.shotIds)
    await pool.query("delete from shots where id = $1", [id]).catch(() => undefined);
  // the demo assignments exactly as they were (before the temporary Look can be removed)
  for (const r of restoreAssignments)
    await pool
      .query(
        `insert into shot_characters (shot_id, character_id, look_id, performance_notes, expression, posture, gestures, physical_interactions, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (shot_id, character_id) do update set look_id = excluded.look_id, performance_notes = excluded.performance_notes,
           expression = excluded.expression, posture = excluded.posture, gestures = excluded.gestures,
           physical_interactions = excluded.physical_interactions, position = excluded.position`,
        [
          r.shot_id,
          r.character_id,
          r.look_id,
          r.performance_notes,
          r.expression,
          r.posture,
          r.gestures,
          r.physical_interactions,
          r.position,
        ],
      )
      .catch(() => undefined);
  for (const id of created.lookIds)
    await pool.query("delete from character_looks where id = $1", [id]).catch(() => undefined);
  for (const id of created.characterIds)
    await pool.query("delete from characters where id = $1", [id]).catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = (
  await pool.query(
    `select (select count(*)::int from character_continuity_locks where name like 'db:cc%') as locks,
            (select count(*)::int from assets where name like 'db:cc%') as assets,
            (select count(*)::int from character_looks where name like 'db:cc%') as looks,
            (select count(*)::int from characters where name like 'db:cc%') as characters,
            (select count(*)::int from shots where title like 'db:cc%') as shots,
            (select count(*)::int from projects where title like 'db:cc%') as projects,
            (select count(*)::int from shot_character_continuity_selections where shot_id = any($1::uuid[])) as selections`,
    [touchedShots],
  )
).rows[0];
check(
  "cleanup left no test rows",
  Object.values(leftover).every((n) => n === 0),
  JSON.stringify(leftover),
);
const assignmentsNow = (
  await pool.query(
    "select * from shot_characters where shot_id = any($1::uuid[]) order by shot_id, character_id",
    [touchedShots],
  )
).rows;
const norm = (rows: Array<Record<string, unknown>>) =>
  JSON.stringify(
    [...rows]
      .sort((a, b) => `${a.shot_id}${a.character_id}`.localeCompare(`${b.shot_id}${b.character_id}`))
      .map((r) => [r.shot_id, r.character_id, r.look_id, r.expression, r.posture, r.position]),
  );
check("the demo assignments are exactly as before", norm(assignmentsNow) === norm(restoreAssignments));

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
