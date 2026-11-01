import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresMediaQaData } from "../media-qa-postgres";

/**
 * Phase 3A.4F code against databases at each migration level (hosted stays at 0046 until its gate). A fake pool stands in
 * for Postgres: a column the level lacks raises 42703, exactly as Postgres does.
 */
type Level = 44 | 45 | 46 | 47;

function fakePool(level: Level) {
  const rows = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      if (/^(set|begin|commit|rollback)/i.test(sql.trim()) || sql.startsWith("--")) return { rows: [] };
      if (sql.includes("pg_attribute")) return { rows: [{ ready: level >= 47 }] };
      if (sql.startsWith("select * from project_qa_policies")) {
        const id = String(params[0]);
        return { rows: rows.has(id) ? [rows.get(id)] : [] };
      }
      if (level < 47 && /sequence_semantic_mode|max_transitions_per_batch/.test(sql))
        throw Object.assign(new Error("column does not exist"), { code: "42703" });
      if (level < 45 && sql.includes("direct_video_allowed"))
        throw Object.assign(new Error("column does not exist"), { code: "42703" });
      const id = String(params[0]);
      const isInsert = sql.trim().startsWith("insert");
      const extra = params.slice(isInsert ? 8 : 9);
      const row: Record<string, unknown> = {
        project_id: id,
        semantic_mode: params[1],
        analyzer: params[2],
        external_media_allowed: params[3],
        max_cost_per_run_usd: params[4],
        max_cost_per_day_usd: params[5],
        revision: (Number(rows.get(id)?.revision ?? 0) || 0) + 1,
        updated_by: params[6],
        updated_at: params[7],
        ...(level >= 45 ? { direct_video_allowed: extra[0] } : {}),
        ...(level >= 47 ? { sequence_semantic_mode: extra[1], max_transitions_per_batch: extra[2] } : {}),
      };
      rows.set(id, row);
      return { rows: [row] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { repo: new PostgresMediaQaData(pool, "begin"), rows };
}

const PROJECT = "00000000-0000-4000-8000-000000000001";
const base = {
  semanticMode: "off" as const,
  analyzer: "gemini",
  externalMediaAllowed: true,
  maxCostPerRunUsd: 0.5,
  maxCostPerDayUsd: 5,
};
const save = (repo: PostgresMediaQaData, extra: object, expectedRevision = 0) =>
  repo.saveQaPolicy({
    projectId: PROJECT,
    policy: { ...base, ...extra },
    expectedRevision,
    by: "u",
    now: "2026-11-01T00:00:00Z",
  });

describe("Project QA policy across migration levels", () => {
  for (const level of [44, 45, 46] as const)
    describe(`at ${level === 44 ? "0044 only" : `00${level}`}`, () => {
      it("sequenceAutomationReady is false; reads map to off and 20", async () => {
        const { repo } = fakePool(level);
        expect(await repo.sequenceAutomationReady()).toBe(false);
        const p = await repo.getQaPolicy(PROJECT);
        expect(p.sequenceSemanticMode).toBe("off");
        expect(p.maxTransitionsPerBatch).toBe(20);
      });

      it("ordinary Shot fields still save, and read back with the Sequence defaults", async () => {
        const { repo } = fakePool(level);
        const saved = await save(repo, {});
        expect(saved.revision).toBe(1);
        expect(saved.analyzer).toBe("gemini");
        expect(saved.sequenceSemanticMode).toBe("off");
        expect(saved.maxTransitionsPerBatch).toBe(20);
      });

      it("a non-default Sequence policy is refused as not_migrated, and stores nothing", async () => {
        const { repo, rows } = fakePool(level);
        await expect(save(repo, { sequenceSemanticMode: "suggest" })).rejects.toMatchObject({
          code: "not_migrated",
        });
        await expect(save(repo, { maxTransitionsPerBatch: 5 })).rejects.toMatchObject({
          code: "not_migrated",
        });
        expect(rows.size).toBe(0);
      });
    });

  it("before 0045 a direct-video permission is still refused as not_migrated (the 0045 rule is unchanged)", async () => {
    const { repo, rows } = fakePool(44);
    await expect(save(repo, { directVideoAllowed: true })).rejects.toMatchObject({ code: "not_migrated" });
    expect(rows.size).toBe(0);
  });

  it("at 0046 a direct-video permission saves without any Sequence column", async () => {
    const { repo } = fakePool(46);
    expect((await save(repo, { directVideoAllowed: true })).directVideoAllowed).toBe(true);
  });

  it("at 0047 the Sequence policy is stored exactly, and is ready", async () => {
    const { repo } = fakePool(47);
    expect(await repo.sequenceAutomationReady()).toBe(true);
    const saved = await save(repo, {
      directVideoAllowed: true,
      sequenceSemanticMode: "automatic",
      maxTransitionsPerBatch: 7,
    });
    expect(saved.sequenceSemanticMode).toBe("automatic");
    expect(saved.maxTransitionsPerBatch).toBe(7);
    expect(saved.semanticMode).toBe("off");
  });
});
