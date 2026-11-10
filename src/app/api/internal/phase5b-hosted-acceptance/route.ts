import { NextRequest, NextResponse } from "next/server";
import { Pool, type PoolClient } from "pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_REF = "lyqdxiyjperhniwhzsvg";

type Db = Pool | PoolClient;

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, message }, { status, headers: { "cache-control": "no-store" } });
}

function safeError(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[redacted]@")
    .replace(/password\s*=\s*[^\s;]+/gi, "password=[redacted]");
}

async function one<T extends Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query(sql, params);
  if (r.rowCount !== 1) throw new Error(`Expected exactly one row, got ${r.rowCount ?? 0}`);
  return r.rows[0] as T;
}

async function inventory(db: Db) {
  const project = await one<{ id: string; user_id: string }>(
    db,
    "select id, user_id from projects where slug = $1",
    ["ojousama"],
  );

  const shot = await one<{ id: string; location_id: string }>(
    db,
    "select id, location_id from shots where project_id = $1 and shot_code = '3A'",
    [project.id],
  );

  const location = await one<{
    id: string;
    name: string;
    locked: boolean;
    visual_bible: { canonicalAssetId?: string | null; entries?: Array<{ assetId: string; role: string; label: string }> };
  }>(
    db,
    "select id, name, locked, visual_bible from locations where id = $1 and project_id = $2",
    [shot.location_id, project.id],
  );
  if (location.name !== "Grand Celeste Lobby") {
    throw new Error(`Shot 3A location is "${location.name}", not Grand Celeste Lobby`);
  }

  const yumeko = await one<{ id: string }>(
    db,
    "select id from characters where project_id = $1 and name = 'Yumeko'",
    [project.id],
  );

  const canonicalRows = await db.query(
    `select r.id, r.asset_id, a.name
       from character_identity_refs r
       join assets a on a.id = r.asset_id and a.project_id = $1
      where r.character_id = $2
        and r.metadata ->> 'visualRole' = 'canonical'`,
    [project.id, yumeko.id],
  );
  if (canonicalRows.rowCount !== 1 || !canonicalRows.rows[0]?.asset_id) {
    throw new Error(`Expected one stored Yumeko canonical identity, got ${canonicalRows.rowCount ?? 0}`);
  }
  const identity = { id: String(canonicalRows.rows[0].asset_id), label: "Yumeko canonical identity" };

  const look = await one<{ id: string; reference_asset_ids: string[] }>(
    db,
    `select id, reference_asset_ids
       from character_looks
      where project_id = $1 and character_id = $2 and name = 'Episode 1 — Formal Black'`,
    [project.id, yumeko.id],
  );
  const lookIds = Array.isArray(look.reference_asset_ids) ? look.reference_asset_ids : [];
  if (lookIds.length !== 1) {
    throw new Error(`Expected exactly one Formal Black Look reference, got ${lookIds.length}`);
  }
  const lookRef = { id: String(lookIds[0]), label: "Formal Black Look reference" };

  const viewRows = await db.query(
    `select id, asset_id, name
       from location_views
      where project_id = $1
        and location_id = $2
        and name ilike '%entrance%'
        and name ilike '%elevator%'`,
    [project.id, location.id],
  );
  if (viewRows.rowCount !== 1) {
    throw new Error(`Expected exactly one Entrance → elevators Location View, got ${viewRows.rowCount ?? 0}`);
  }
  const view = {
    id: String(viewRows.rows[0].id),
    assetId: String(viewRows.rows[0].asset_id),
    name: String(viewRows.rows[0].name),
  };

  const vb = location.visual_bible ?? {};
  const entries = Array.isArray(vb.entries) ? vb.entries : [];
  const canonicalId = vb.canonicalAssetId ?? null;
  if (!canonicalId) throw new Error("Lobby Visual Bible has no canonical asset");

  const establishing = entries.filter((e) => e.role === "establishing");
  if (establishing.length !== 1) {
    throw new Error(`Expected exactly one Lobby establishing entry, got ${establishing.length}`);
  }
  const night = entries.filter(
    (e) => e.role === "variant" && typeof e.label === "string" && e.label.toLowerCase().includes("night"),
  );
  if (night.length !== 1) {
    throw new Error(`Expected exactly one Lobby night variant, got ${night.length}`);
  }

  const refs = [
    identity,
    lookRef,
    { id: view.assetId, label: `Location View: ${view.name}` },
    { id: String(canonicalId), label: "Lobby canonical" },
    { id: String(establishing[0]!.assetId), label: `Lobby establishing: ${establishing[0]!.label}` },
    { id: String(night[0]!.assetId), label: `Lobby night variant: ${night[0]!.label}` },
  ];

  const ids = refs.map((r) => r.id);
  if (new Set(ids).size !== 6) throw new Error("The six intended Shot 3A references are not six distinct Assets");

  const assets = await db.query(
    `select id, name, type, purpose, object_path, checksum
       from assets
      where project_id = $1 and id = any($2::uuid[])`,
    [project.id, ids],
  );
  if (assets.rowCount !== 6) throw new Error(`Only ${assets.rowCount ?? 0} of the six intended Assets exist`);
  const byId = new Map(assets.rows.map((a) => [String(a.id), a]));
  for (const ref of refs) {
    const a = byId.get(ref.id);
    if (!a?.object_path || !a?.checksum) throw new Error(`${ref.label} is not a stored, checksummed Asset`);
  }

  const currentRefs = await db.query(
    `select r.asset_id, r.position, a.name
       from shot_reference_assets r
       join assets a on a.id = r.asset_id
      where r.shot_id = $1 and r.role = 'reference'
      order by r.position`,
    [shot.id],
  );
  const currentSelection = await db.query(
    `select s.location_view_id, v.name
       from shot_location_view_selections s
       join location_views v on v.id = s.location_view_id
      where s.shot_id = $1`,
    [shot.id],
  );

  return {
    project,
    shot,
    location: { id: location.id, name: location.name, locked: location.locked },
    view,
    refs: refs.map((r) => ({ ...r, assetName: String(byId.get(r.id)?.name ?? "") })),
    currentRefs: currentRefs.rows.map((r) => ({
      assetId: String(r.asset_id),
      position: Number(r.position),
      name: String(r.name),
    })),
    currentSelection: currentSelection.rows.map((r) => ({
      locationViewId: String(r.location_view_id),
      name: String(r.name),
    })),
  };
}

export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") return fail("Not available outside preview", 404);

  const url = process.env.SUPABASE_DB_URL;
  if (!url || !url.includes(EXPECTED_REF)) return fail("Prism Studio database URL is unavailable or targets the wrong project", 503);

  const mode = request.nextUrl.searchParams.get("mode") ?? "inspect";
  if (mode !== "inspect" && mode !== "apply") return fail("mode must be inspect or apply");

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    if (mode === "inspect") {
      const state = await inventory(pool);
      return NextResponse.json({ ok: true, mode, state }, { headers: { "cache-control": "no-store" } });
    }

    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local lock_timeout = '5s'");
      await c.query("set local statement_timeout = '20s'");

      const before = await inventory(c);
      if (!before.location.locked) throw new Error("Grand Celeste Lobby was expected to be locked before acceptance");

      await c.query("update locations set locked = false where id = $1 and project_id = $2", [
        before.location.id,
        before.project.id,
      ]);

      await c.query("delete from shot_reference_assets where shot_id = $1 and role = 'reference'", [before.shot.id]);
      for (let i = 0; i < before.refs.length; i++) {
        await c.query(
          "insert into shot_reference_assets (shot_id, asset_id, role, position) values ($1,$2,'reference',$3)",
          [before.shot.id, before.refs[i]!.id, i],
        );
      }

      await c.query(
        `insert into shot_location_view_selections
           (shot_id, project_id, location_view_id, location_id, selected_by, selected_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (shot_id) do update
           set project_id = excluded.project_id,
               location_view_id = excluded.location_view_id,
               location_id = excluded.location_id,
               selected_by = excluded.selected_by,
               selected_at = excluded.selected_at`,
        [before.shot.id, before.project.id, before.view.id, before.location.id, before.project.user_id],
      );

      await c.query("update locations set locked = true where id = $1 and project_id = $2", [
        before.location.id,
        before.project.id,
      ]);

      const after = await inventory(c);
      const expected = before.refs.map((r) => r.id);
      const actual = after.currentRefs.map((r) => r.assetId);
      if (!after.location.locked) throw new Error("Lobby did not relock");
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error("Shot 3A references did not persist in the intended order");
      }
      if (after.currentSelection.length !== 1 || after.currentSelection[0]!.locationViewId !== before.view.id) {
        throw new Error("Entrance → elevators Location View selection did not persist");
      }

      await c.query("commit");
      return NextResponse.json(
        {
          ok: true,
          mode,
          committed: true,
          paidProviderCalls: 0,
          state: after,
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      await c.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  } catch (err) {
    return fail(safeError(err), 500);
  } finally {
    await pool.end().catch(() => undefined);
  }
}
