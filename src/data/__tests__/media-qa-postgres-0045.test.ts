import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresMediaQaData } from "../media-qa-postgres";

/**
 * Phase 3A.3 code against a database WITHOUT migration 0045 (hosted DEV until the 0045 gate) and with it. A fake
 * pool stands in for Postgres: the 0044 shape raises 42703 for the new column, exactly as Postgres does.
 */
function fakePool(opts: { has0045: boolean }) {
  const rows = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push(sql);
      if (/^(set|begin|commit|rollback)/i.test(sql.trim()) || sql.startsWith("--")) return { rows: [] };
      if (!opts.has0045 && sql.includes("direct_video_allowed"))
        throw Object.assign(new Error('column "direct_video_allowed" does not exist'), { code: "42703" });
      const id = String(params[0]);
      if (sql.startsWith("select * from project_qa_policies"))
        return { rows: rows.has(id) ? [rows.get(id)] : [] };
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
        ...(opts.has0045
          ? { direct_video_allowed: Boolean(sql.startsWith("insert") ? params[8] : params[9]) }
          : {}),
      };
      rows.set(id, row);
      return { rows: [row] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { repo: new PostgresMediaQaData(pool, "begin"), rows, statements };
}

const PROJECT = "00000000-0000-4000-8000-000000000001";
const policy = (directVideoAllowed: boolean) => ({
  semanticMode: "automatic" as const,
  analyzer: "gemini",
  externalMediaAllowed: true,
  maxCostPerRunUsd: 0.5,
  maxCostPerDayUsd: 5,
  directVideoAllowed,
});
const save = (repo: PostgresMediaQaData, directVideoAllowed: boolean, expectedRevision = 0) =>
  repo.saveQaPolicy({
    projectId: PROJECT,
    policy: policy(directVideoAllowed),
    expectedRevision,
    by: "u",
    now: "2026-10-28T00:00:00Z",
  });

describe("Project QA policy before / after migration 0045", () => {
  it("before 0045: reads map to directVideoAllowed=false; saving false works; saving true fails as not_migrated", async () => {
    const { repo, rows } = fakePool({ has0045: false });
    expect((await repo.getQaPolicy(PROJECT)).directVideoAllowed).toBe(false);
    const saved = await save(repo, false);
    expect(saved.directVideoAllowed).toBe(false);
    expect(saved.revision).toBe(1);
    await expect(save(repo, true, 1)).rejects.toMatchObject({ code: "not_migrated" });
    // nothing was stored by the refused save, and nothing claims the permission
    expect(rows.get(PROJECT)!.revision).toBe(1);
    expect((await repo.getQaPolicy(PROJECT)).directVideoAllowed).toBe(false);
  });

  it("after 0045: the permission is stored exactly as the owner set it", async () => {
    const { repo } = fakePool({ has0045: true });
    expect((await save(repo, false)).directVideoAllowed).toBe(false);
    expect((await save(repo, true, 1)).directVideoAllowed).toBe(true);
    expect((await repo.getQaPolicy(PROJECT)).directVideoAllowed).toBe(true);
  });
});
