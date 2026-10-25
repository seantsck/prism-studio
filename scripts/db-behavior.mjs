// Behavioural validation of constraints, triggers and RLS. Everything runs inside ONE transaction
// that is always rolled back, so no data is left behind. Requires the real dev Auth user.
import { randomUUID } from "node:crypto";
import pg from "pg";

import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv(); // validates ref + UUID before any query
const url = startScript({ mode: "behavior (single transaction, always rolled back)", devOwner: dev.id });
const owner = dev.id;

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await assertDevUserExists(client, dev);
const results = [];
const id = () => randomUUID();
const P = id(),
  E = id(),
  S = id(),
  L = id(),
  SH = id(),
  CH = id(),
  LK = id();

async function expectError(name, sql, params, match) {
  await client.query("savepoint s");
  try {
    await client.query(sql, params);
    results.push([name, false, "expected an error but statement succeeded"]);
    await client.query("rollback to savepoint s");
  } catch (err) {
    await client.query("rollback to savepoint s");
    const ok = match.test(err.message);
    results.push([name, ok, ok ? "" : `unexpected error: ${err.message}`]);
  }
}

async function expectOk(name, fn) {
  await client.query("savepoint s");
  try {
    const detail = await fn();
    results.push([name, detail?.ok !== false, detail?.msg ?? ""]);
    await client.query("release savepoint s");
  } catch (err) {
    await client.query("rollback to savepoint s");
    results.push([name, false, err.message]);
  }
}

const EMPTY_JSON = "{}";
const attemptInsert =
  "insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality, package_snapshot, approved, status, review_status) " +
  "values ($1,$2,$3,$4,'p','m','video',$5,$6::boolean,$7,case when $6::boolean then 'approved' else 'unreviewed' end)";

try {
  await client.query("begin");
  await client.query("insert into projects (id, user_id, title, slug) values ($1,$2,'T',$3)", [
    P,
    owner,
    `t-${P.slice(0, 8)}`,
  ]);
  await client.query("insert into project_bibles (project_id) values ($1)", [P]);
  await client.query(
    "insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'ep-1','E')",
    [E, P],
  );
  await client.query(
    "insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext) values ($1,$2,$3,'1','INT. X','INT')",
    [S, P, E],
  );
  await client.query("insert into characters (id, project_id, name) values ($1,$2,'C')", [CH, P]);
  await client.query(
    "insert into character_looks (id, project_id, character_id, name) values ($1,$2,$3,'L')",
    [LK, P, CH],
  );
  await client.query(
    "insert into dialogue_lines (id, project_id, episode_id, scene_id, character_id, original_text, locked) values ($1,$2,$3,$4,$5,'hello',true)",
    [L, P, E, S, CH],
  );
  await client.query(
    "insert into shots (id, project_id, episode_id, scene_id, shot_code, title) values ($1,$2,$3,$4,'1A','S')",
    [SH, P, E, S],
  );

  // ── constraints / triggers ──
  await expectError(
    "locked dialogue text cannot change",
    "update dialogue_lines set original_text='changed' where id=$1",
    [L],
    /locked/,
  );
  await expectOk("locked dialogue metadata may change", async () => {
    await client.query("update dialogue_lines set subtext='x' where id=$1", [L]);
  });
  await expectOk("unlocking then editing works", async () => {
    await client.query("update dialogue_lines set locked=false where id=$1", [L]);
    await client.query("update dialogue_lines set original_text='changed' where id=$1", [L]);
  });

  const takeInsert =
    "insert into performance_takes (id, project_id, dialogue_line_id, source_type, duration_ms, take_number, selected) values ($1,$2,$3,'temp_voice',$4,$5,$6)";
  await client.query(takeInsert, [id(), P, L, 2800, 1, true]);
  await expectError(
    "second selected take on a line is rejected",
    takeInsert,
    [id(), P, L, 3000, 2, true],
    /unique|takes_one_selected/,
  );
  await expectError("duplicate take number is rejected", takeInsert, [id(), P, L, 3000, 1, false], /unique/);
  await expectError("non-positive take duration is rejected", takeInsert, [id(), P, L, 0, 9, false], /check/);

  const frameInsert =
    "insert into storyboard_frames (id, project_id, shot_id, version, source, approved) values ($1,$2,$3,$4,'sketch',$5)";
  await client.query(frameInsert, [id(), P, SH, 1, true]);
  await expectError(
    "second approved frame for a shot is rejected",
    frameInsert,
    [id(), P, SH, 2, true],
    /unique/,
  );

  const A1 = id();
  await client.query(attemptInsert, [A1, P, SH, 1, EMPTY_JSON, false, "queued"]);
  await expectError(
    "attempt snapshot is immutable",
    "update generation_attempts set package_snapshot=$2 where id=$1",
    [A1, '{"a":1}'],
    /append-only/,
  );
  await expectError(
    "attempt prompt is immutable",
    "update generation_attempts set prompt='rewritten' where id=$1",
    [A1],
    /append-only/,
  );
  await expectOk("attempt review fields can change", async () => {
    await client.query(
      "update generation_attempts set status='succeeded', review_status='rejected', rejection_categories='{wrong_set}', rejection_reason='wrong door', notes='n' where id=$1",
      [A1],
    );
  });
  await client.query(attemptInsert, [id(), P, SH, 2, EMPTY_JSON, true, "succeeded"]);
  await expectError(
    "second approved attempt for a shot is rejected",
    attemptInsert,
    [id(), P, SH, 3, EMPTY_JSON, true, "succeeded"],
    /unique/,
  );

  await client.query("insert into shot_characters (shot_id, character_id, look_id) values ($1,$2,$3)", [
    SH,
    CH,
    LK,
  ]);
  await expectError(
    "a Look used by a shot cannot be deleted",
    `do $$ begin delete from character_looks where id = '${LK}'; set constraints all immediate; end $$`,
    [],
    /foreign key|violates/,
  );
  const A_ = [id(), id()];
  for (const [i, a] of A_.entries())
    await client.query("insert into assets (id, project_id, type, name) values ($1,$2,'image',$3)", [
      a,
      P,
      `a${i}`,
    ]);
  const refInsert =
    "insert into shot_reference_assets (shot_id, asset_id, role, position) values ($1,$2,'reference',$3)";
  await client.query(refInsert, [SH, A_[0], 0]);
  await expectError("two references cannot share a position", refInsert, [SH, A_[1], 0], /unique/);
  await expectOk("reference order is returned by position", async () => {
    await client.query(refInsert, [SH, A_[1], 1]);
    const r = await client.query(
      "select asset_id from shot_reference_assets where shot_id=$1 and role='reference' order by position",
      [SH],
    );
    return { ok: r.rows.map((x) => x.asset_id).join() === A_.join() };
  });
  await expectOk("stale cache columns are gone (prep_score, ready_to_generate)", async () => {
    const r = await client.query(
      "select column_name from information_schema.columns where table_name='shots' and column_name in ('prep_score','ready_to_generate')",
    );
    return { ok: r.rows.length === 0 };
  });
  await expectError(
    "invalid shot status is rejected",
    "update shots set status='bogus' where id=$1",
    [SH],
    /check/,
  );

  // ── Phase 1C: assets, archived takes, script sources, freshness ──
  const AB = id();
  await client.query(
    "insert into action_blocks (id, project_id, episode_id, scene_id, text, \"order\", start_line, end_line) values ($1,$2,$3,$4,'He enters.',0,3,3)",
    [AB, P, E, S],
  );
  const srcInsert =
    "insert into shot_script_sources (shot_id, action_block_id, dialogue_line_id, position) values ($1,$2,$3,0)";
  await expectOk("a shot can link an action block as its script source", async () => {
    await client.query(srcInsert, [SH, AB, null]);
  });
  await expectError("the same source cannot be linked twice", srcInsert, [SH, AB, null], /unique/);
  await expectError(
    "a source row must reference exactly one of action block / dialogue line",
    srcInsert,
    [SH, AB, L],
    /check|unique/,
  );
  await expectError("a source row must reference something", srcInsert, [SH, null, null], /check/);

  const TK2 = id();
  await client.query(takeInsert, [TK2, P, L, 1800, 7, false]);
  await expectOk("a take can be archived", async () => {
    await client.query("update performance_takes set archived = true, archived_at = now() where id = $1", [
      TK2,
    ]);
  });
  await expectError(
    "an archived take cannot be selected",
    "update performance_takes set selected = true where id = $1",
    [TK2],
    /takes_archived_not_selected|check|unique/,
  );
  await expectError(
    "waveform must be a versioned object",
    "update performance_takes set waveform = '[0.1,0.2]'::jsonb where id = $1",
    [TK2],
    /takes_waveform_shape|check/,
  );
  await expectOk("a versioned waveform object is accepted", async () => {
    await client.query(
      "update performance_takes set waveform = $2::jsonb, duration_source = 'server_metadata' where id = $1",
      [TK2, JSON.stringify({ version: 1, sampleCount: 2, peaks: [0.1, 1], durationMs: 1800 })],
    );
  });
  await expectError(
    "unknown duration source is rejected",
    "update performance_takes set duration_source = 'guess' where id = $1",
    [TK2],
    /check/,
  );

  const AS = id();
  const assetInsert =
    "insert into assets (id, project_id, type, name, purpose, storage_provider, bucket, object_path, byte_size, source) values ($1,$2,'audio','a.wav',$3,$4,$5,$6,$7,'upload')";
  await expectError(
    "a supabase-stored asset must name its bucket and object path",
    assetInsert,
    [AS, P, "performance_audio", "supabase", null, null, 10],
    /assets_supabase_location_check|check/,
  );
  await expectError(
    "an unknown asset purpose is rejected",
    assetInsert,
    [AS, P, "wallpaper", "none", null, null, 10],
    /assets_purpose_check|check/,
  );
  await expectError(
    "negative byte sizes are rejected",
    assetInsert,
    [AS, P, "other", "none", null, null, -5],
    /byte_size|check/,
  );
  await expectOk("a fully described stored asset is accepted", async () => {
    await client.query(assetInsert, [
      AS,
      P,
      "performance_audio",
      "supabase",
      "prism-assets",
      `${P}/${AS}/a.wav`,
      1234,
    ]);
  });
  await expectError(
    "two assets cannot claim the same bucket object",
    assetInsert,
    [id(), P, "performance_audio", "supabase", "prism-assets", `${P}/${AS}/a.wav`, 1],
    /unique/,
  );
  await expectOk("updated_at is maintained by trigger (cannot be set into the past)", async () => {
    await client.query("update assets set updated_at = '2001-01-01', notes = 'n' where id = $1", [AS]);
    const r = await client.query("select updated_at = now() as fresh from assets where id = $1", [AS]);
    return { ok: r.rows[0].fresh === true };
  });
  await expectError(
    "frame approval snapshot must be an object with parts",
    "update storyboard_frames set approved_snapshot = '[1]'::jsonb where shot_id = $1",
    [SH],
    /frames_snapshot_shape|check/,
  );
  await expectOk("a frame records what it was approved against", async () => {
    await client.query(
      "update storyboard_frames set approved_fingerprint = 'abc', approved_at = now(), approved_snapshot = $2::jsonb where shot_id = $1",
      [SH, JSON.stringify({ parts: { camera: "x" }, durationMs: 4500 })],
    );
  });
  await expectError(
    "the attempt package fingerprint is immutable history",
    "update generation_attempts set package_fingerprint = 'rewritten' where id = $1",
    [A1],
    /append-only/,
  );

  // ── 0043: Episode edits (the full suite is db:episode-edits; these are the core barriers) ──
  if (!(await client.query("select to_regclass('public.episode_edits') t")).rows[0].t) {
    results.push(["migration 0043 (episode edits) is applied", false, "episode_edits does not exist"]);
  } else {
    const ED = id();
    const IT = id();
    const TK = id();
    await client.query(
      "insert into episode_edits (id, project_id, episode_id, edit_rate_num, edit_rate_den) values ($1,$2,$3,24000,1001)",
      [ED, P, E],
    );
    await expectError(
      "edit: a second edit of the same Episode is rejected (one per Episode)",
      "insert into episode_edits (project_id, episode_id, edit_rate_num, edit_rate_den) values ($1,$2,24,1)",
      [P, E],
      /episode_edits_one_per_episode/,
    );
    const itemInsert =
      "insert into episode_edit_items (id, project_id, edit_id, episode_id, shot_id, position, visual_kind, attempt_id, asset_id, source_in_ms, source_out_ms, duration_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,null,$9,$10,$11)";
    await client.query(itemInsert, [IT, P, ED, E, SH, 0, "none", null, null, null, 3000]);
    await expectError(
      "edit: a second item for the same Shot is rejected (one per Shot)",
      itemInsert,
      [id(), P, ED, E, SH, 1, "none", null, null, null, 1000],
      /episode_edit_items_one_per_shot/,
    );
    await expectError(
      "edit: an item with the columns of another kind is rejected",
      itemInsert,
      [id(), P, ED, E, SH, 1, "none", A1, null, null, 1000],
      /kind_columns/,
    );
    await expectError(
      "edit: a generation that has not completed cannot be placed",
      itemInsert,
      [id(), P, ED, E, SH, 1, "video", A1, 0, 1000, null],
      /does not exist in this project|completed generation/,
    );
    await client.query(
      "insert into performance_takes (id, project_id, dialogue_line_id, source_type, duration_ms, take_number) values ($1,$2,$3,'temp_voice',2000,7)",
      [TK, P, L],
    );
    const placementInsert =
      "insert into episode_edit_audio_placements (project_id, item_id, dialogue_line_id, take_id, start_ms, take_in_ms, take_out_ms) values ($1,$2,$3,$4,$5,0,$6)";
    await expectOk("edit: a placement inside its item is accepted", async () => {
      await client.query(placementInsert, [P, IT, L, TK, 500, 1500]);
    });
    await expectError(
      "edit: a placement before the item start is rejected (2I.1 rule)",
      placementInsert,
      [P, IT, L, TK, -1, 1000],
      /start_inside_item|unique/,
    );
    await expectError(
      "edit: shrinking an item under a placed performance is rejected",
      "update episode_edit_items set duration_ms = 1000 where id = $1",
      [IT],
      /cut a placed performance/,
    );
    await expectOk(
      "edit: a Shot in the edit cannot be deleted directly (deferred key, checked here)",
      async () => {
        await client.query("savepoint d");
        let refused = false;
        try {
          await client.query("delete from shots where id = $1", [SH]);
          await client.query("set constraints all immediate");
        } catch (err) {
          refused = /foreign key/.test(err.message);
        }
        await client.query("rollback to savepoint d");
        return { ok: refused };
      },
    );
    await expectOk("edit: a Project delete cascades through its edit (deferred keys checked)", async () => {
      await client.query("savepoint e");
      try {
        await client.query("delete from projects where id = $1", [P]);
        await client.query("set constraints all immediate");
        const n = (
          await client.query(
            "select (select count(*) from episode_edits where project_id = $1)::int + (select count(*) from episode_edit_items where project_id = $1)::int + (select count(*) from episode_edit_audio_placements where project_id = $1)::int as n",
            [P],
          )
        ).rows[0].n;
        return { ok: n === 0, msg: `left ${n}` };
      } finally {
        await client.query("rollback to savepoint e");
      }
    });
  }

  await expectOk("deleting a project cascades to children (incl. shot Looks in use)", async () => {
    await client.query("savepoint c");
    await client.query("delete from projects where id=$1", [P]);
    const n = (
      await client.query(
        "select (select count(*) from shots where project_id=$1)::int s, (select count(*) from dialogue_lines where project_id=$1)::int d, (select count(*) from shot_characters where shot_id=$2)::int sc, (select count(*) from shot_reference_assets where shot_id=$2)::int sr",
        [P, SH],
      )
    ).rows[0];
    await client.query("rollback to savepoint c");
    return { ok: n.s === 0 && n.d === 0 && n.sc === 0 && n.sr === 0, msg: JSON.stringify(n) };
  });

  // ── RLS ──
  const asUser = async (sub, role, sql, params = []) => {
    await client.query("savepoint r");
    try {
      await client.query(`set local role ${role}`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub, role }),
      ]);
      return (await client.query(sql, params)).rows;
    } finally {
      await client.query("reset role");
      await client.query("rollback to savepoint r");
    }
  };
  const other = id();
  await expectOk("RLS: owner sees own project", async () => {
    const rows = await asUser(owner, "authenticated", "select id from projects where id=$1", [P]);
    return { ok: rows.length === 1 };
  });
  await expectOk("RLS: another user sees nothing (projects)", async () => {
    const rows = await asUser(other, "authenticated", "select id from projects where id=$1", [P]);
    return { ok: rows.length === 0 };
  });
  await expectOk("RLS: another user sees nothing (shots, join tables); owner sees them", async () => {
    const a = await asUser(other, "authenticated", "select id from shots where project_id=$1", [P]);
    const b = await asUser(other, "authenticated", "select 1 from shot_characters where shot_id=$1", [SH]);
    const c = await asUser(owner, "authenticated", "select 1 from shot_characters where shot_id=$1", [SH]);
    return {
      ok: a.length === 0 && b.length === 0 && c.length === 1,
      msg: `other=${a.length}/${b.length} owner=${c.length}`,
    };
  });
  await expectOk("RLS: anon sees nothing", async () => {
    const rows = await asUser(owner, "anon", "select id from projects where id=$1", [P]);
    return { ok: rows.length === 0 };
  });
  await expectOk("RLS: another user cannot insert into the project", async () => {
    await client.query("savepoint w");
    let denied = false;
    try {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: other, role: "authenticated" }),
      ]);
      await client.query("insert into characters (id, project_id, name) values ($1,$2,'evil')", [id(), P]);
    } catch (err) {
      denied = /row-level security/.test(err.message);
    }
    await client.query("rollback to savepoint w");
    await client.query("reset role");
    return { ok: denied };
  });
} finally {
  await client.query("rollback").catch(() => undefined);
  await client.end();
}

let failed = 0;
for (const [name, ok, msg] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${msg ? `  — ${msg}` : ""}`);
  if (!ok) failed++;
}
console.log(
  `\n${results.length - failed}/${results.length} passed (transaction rolled back; no data written)`,
);
process.exitCode = failed ? 1 : 0;
