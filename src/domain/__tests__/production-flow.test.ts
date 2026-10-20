import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildAnimaticTimeline } from "@/domain/animatic";
import { buildShotContext } from "@/domain/context";
import { shotSourceContent } from "@/domain/coverage";
import { storyboardFreshness } from "@/domain/fingerprint";
import { assembleGenerationPackage, briefToText, renderGenerationBrief } from "@/domain/generation-package";
import { runPreflight } from "@/domain/preflight";
import { parseScreenplay } from "@/domain/script";
import { selectTake } from "@/domain/takes";
import { timelineFromContext } from "@/domain/timeline";
import { shotByCode } from "./helpers";

/**
 * The whole production chain for Shot 3A "I Already Want to Go Home" on the Japanese-drama seed:
 *   script → locked dialogue → cast + Look + set → performance → timing → storyboard → preflight
 *   → generation package → brief → animatic → persistence.
 */
describe("production workflow: Shot 3A", () => {
  it("runs script → performance → shot → storyboard → package → animatic → persistence", async () => {
    const repo = new MemoryRepository();
    const data = (await repo.loadProject("ojousama"))!;
    const shot = shotByCode(data, "3A");
    const ctx = buildShotContext(data, shot.id);

    // 1. the script line exists, parsed from the episode script with a source line
    const line = data.dialogueLines.find((l) => l.originalText === "もう帰りたい……")!;
    expect(line).toBeDefined();
    expect(
      parseScreenplay(data.episodes[0].scriptText)
        .flatMap((s) => s.blocks)
        .some((b) => b.kind === "dialogue" && b.text === "もう帰りたい……"),
    ).toBe(true);
    expect(line.sourceStartLine).toBeGreaterThan(0);
    expect(shotSourceContent(data, shot).dialogue[0].id).toBe(line.id);

    // 2. dialogue is locked
    expect(line.locked).toBe(true);

    // 3. Yumeko, her Episode 1 Formal Black Look (locked), and the Grand Celeste Lobby (locked)
    expect(ctx.characters).toHaveLength(1);
    expect(ctx.characters[0].character?.name).toBe("Yumeko");
    expect(ctx.characters[0].look?.name).toBe("Episode 1 — Formal Black");
    expect(ctx.characters[0].look?.locked).toBe(true);
    expect(ctx.location?.name).toBe("Grand Celeste Lobby");
    expect(ctx.location?.locked).toBe(true);

    // 4–5. a selected performance take drives timing: 0.8 + 2.8 + 0.9 = 4.5s
    const take = ctx.lines[0].selectedTake!;
    expect(take.durationMs).toBe(2800);
    expect(ctx.duration.durationMs).toBe(4500);
    const timeline = timelineFromContext(ctx);
    expect(timeline.segments.map((s) => [s.kind, s.endMs - s.startMs])).toEqual([
      ["pre_roll", 800],
      ["dialogue", 2800],
      ["reaction", 900],
    ]);

    // 6. storyboard approved and fresh
    expect(ctx.approvedFrame).not.toBeNull();
    expect(storyboardFreshness(ctx, ctx.approvedFrame).status).toBe("fresh");

    // 7. preflight: ready, with every required gate passing and nothing to explain away
    const report = runPreflight(ctx);
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);

    // 8. package builds, deterministically
    const a = assembleGenerationPackage(ctx, new Date("2026-01-01"));
    const b = assembleGenerationPackage(ctx, new Date("2027-01-01"));
    expect(a.provenance.fingerprint).toBe(b.provenance.fingerprint);
    expect(a.timing.durationMs).toBe(4500);
    expect(a.freshness.storyboard.status).toBe("fresh");
    expect(a.references.approvedStoryboardFrame?.frameId).toBe(ctx.approvedFrame!.id);

    // 9. brief tells the filmmaker exactly what will be generated
    const text = briefToText(renderGenerationBrief(a));
    for (const needle of [
      "Yumeko — Look: Episode 1 — Formal Black (locked)",
      "Grand Celeste Lobby (locked)",
      "もう帰りたい……",
      "Selected take #1",
      "READY TO GENERATE",
    ]) {
      expect(text).toContain(needle);
    }

    // 10. animatic shows the approved storyboard frame, with the line placed after the 0.8s pre-roll
    const clip = buildAnimaticTimeline(data, shot.episodeId).clips.find((c) => c.shotId === shot.id)!;
    expect(clip.frame?.approved).toBe(true);
    expect(clip.durationMs).toBe(4500);
    expect(clip.cues).toHaveLength(1);
    expect(clip.cues[0].startMs - clip.startMs).toBe(800);
    expect(clip.cues[0].durationMs).toBe(2800);
    expect(clip.cues[0].waveform?.peaks.length).toBeGreaterThan(10);

    // 11. persistence: switching the canonical take is written and survives a reload of the repository state
    const alt = data.takes.find((t) => t.dialogueLineId === line.id && !t.selected && !t.archived)!;
    const changed = selectTake(data.takes, alt.id).filter((t) => t.dialogueLineId === line.id);
    await repo.upsertMany(data.project.id, "takes", changed);
    const reloaded = (await repo.loadProject("ojousama"))!;
    const reloadedCtx = buildShotContext(reloaded, shot.id);
    expect(reloadedCtx.lines[0].selectedTake?.id).toBe(alt.id);
    expect(reloadedCtx.duration.durationMs).toBe(800 + alt.durationMs + 900);
    // …and the visual storyboard is still fresh (performance changed, picture did not), but timing is flagged
    const f = storyboardFreshness(reloadedCtx, reloadedCtx.approvedFrame);
    expect(f.status).toBe("fresh");
    expect(f.timingChange).toEqual({ fromMs: 4500, toMs: 800 + alt.durationMs + 900 });
  });
});

describe("environment safety", () => {
  /** The logged-in application user must never come from the dev-user env var. */
  it("application code never reads PRISM_STUDIO_DEV_USER_ID (scripts/tests only)", () => {
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) {
          if (f === "__tests__") continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(f)) {
          const text = readFileSync(p, "utf8");
          // the id is script-only everywhere; email/password may be named only by the worker's dev-storage
          // sink and the log redactor that masks the password (the Next.js app itself never reads them)
          const allowed = f === "sink.ts" || f === "redact.ts";
          if (
            text.includes("PRISM_STUDIO_DEV_USER_ID") ||
            (!allowed && text.includes("PRISM_STUDIO_DEV_USER"))
          )
            offenders.push(path.relative(process.cwd(), p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("no source file reads a service-role / secret key", () => {
    // The ONLY modules that may name a server secret key, by exact path: the worker's Storage sink (validates + uses
    // it), the log redactor (masks it), and (M2D.3C2, approved) the Prism server's agent-relay module, the single
    // server-only reader of the dedicated relay key used for remote Local Agent jobs. No other app module, route,
    // client component or same-named file elsewhere is exempt.
    const SECRET_HANDLING = new Set([
      "src/generation/sink.ts",
      "src/lib/auth/redact.ts",
      "src/server/local-agent/relay-storage.ts",
    ]);
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx)$/.test(f) &&
          !p.includes("__tests__") &&
          !SECRET_HANDLING.has(path.relative(process.cwd(), p).replace(/\\/g, "/"))
        ) {
          const text = readFileSync(p, "utf8");
          if (/SERVICE_ROLE|service_role|SUPABASE_SECRET|sb_secret_/.test(text)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
