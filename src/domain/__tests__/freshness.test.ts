import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import {
  approvalSnapshot,
  computeShotParts,
  storyboardFreshness,
  visualFingerprint,
} from "@/domain/fingerprint";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { canonicalJson, fingerprint, sha256 } from "@/domain/hash";
import { runPreflight } from "@/domain/preflight";
import { selectTake } from "@/domain/takes";
import type { ProjectData } from "@/domain/schemas";
import { seed, shotByCode } from "./helpers";

describe("hashing", () => {
  it("matches the SHA-256 test vectors", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256("日本語")).toHaveLength(64);
  });
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

/** Approves 3A's frame against the current state, then returns a mutated project to compare. */
function approved3A(data: ProjectData) {
  const shot = shotByCode(data, "3A");
  const { fingerprint: fp, snapshot } = approvalSnapshot(buildShotContext(data, shot.id));
  const frame = data.frames.find((f) => f.shotId === shot.id && f.approved)!;
  frame.approvedFingerprint = fp;
  frame.approvedSnapshot = {
    parts: snapshot.parts as Record<string, string>,
    durationMs: snapshot.durationMs,
  };
  return { shot, frame };
}
const freshness = (data: ProjectData, shotId: string) => {
  const ctx = buildShotContext(data, shotId);
  return storyboardFreshness(ctx, ctx.approvedFrame);
};

describe("freshness: stale-asset signals", () => {
  it("the seeded approved storyboard is fresh", () => {
    const data = seed();
    const { shot } = approved3A(data);
    expect(freshness(data, shot.id)).toMatchObject({ status: "fresh", changedParts: [], timingChange: null });
  });

  it("a camera change after approval marks the storyboard stale and names the camera", () => {
    const data = seed();
    const { shot } = approved3A(data);
    shotByCode(data, "3A").composition.lens = "35mm";
    const f = freshness(data, shot.id);
    expect(f.status).toBe("stale");
    expect(f.changedParts).toEqual(["camera"]);
    expect(f.messages[0]).toMatch(/predates the current camera setup/);
  });

  it("a Look change is detected and reported as a Look change", () => {
    const data = seed();
    const { shot } = approved3A(data);
    const lookId = shotByCode(data, "3A").characters[0].lookId!;
    data.looks.find((l) => l.id === lookId)!.wardrobe = "completely different gown";
    const f = freshness(data, shot.id);
    expect(f.status).toBe("stale");
    expect(f.changedParts).toContain("looks");
    expect(f.messages.join(" ")).toMatch(/Character Look changed after storyboard approval/);
  });

  it("a location change is detected", () => {
    const data = seed();
    const { shot } = approved3A(data);
    data.locations.find((l) => l.id === shotByCode(data, "3A").spatial.locationId)!.geography = "moved";
    expect(freshness(data, shot.id).changedParts).toContain("location");
  });

  it("selecting a different performance changes timing without making the picture stale", () => {
    const data = seed();
    const { shot } = approved3A(data);
    const lineId = shot.audio.dialogueLineIds[0];
    const alt = data.takes.find((t) => t.dialogueLineId === lineId && !t.selected)!;
    data.takes = selectTake(data.takes, alt.id) as typeof data.takes;
    const f = freshness(data, shot.id);
    expect(f.status).toBe("fresh"); // visual inputs unchanged
    expect(f.timingChange).toEqual({ fromMs: 4500, toMs: 800 + alt.durationMs + 900 });
    expect(f.messages[0]).toMatch(/Selected performance changed; derived duration changed from 4\.5s →/);
    // …and preflight surfaces it as a warning, never silently
    const report = runPreflight(buildShotContext(data, shot.id));
    expect(report.items.find((i) => i.ruleId === "storyboard.fresh")?.status).toBe("warn");
  });

  it("editing only the beat ids (re-saving unchanged beats) is not a change", () => {
    const data = seed();
    const shot = shotByCode(data, "2B");
    const before = visualFingerprint(computeShotParts(buildShotContext(data, shot.id)));
    shot.action.beats = shot.action.beats.map((b) => ({ ...b, id: `${b.id}-resaved` }));
    expect(visualFingerprint(computeShotParts(buildShotContext(data, shot.id)))).toBe(before);
  });

  it("untracked approvals (pre-fingerprint) are reported as unknown, not fresh", () => {
    const data = seed();
    const shot = shotByCode(data, "1A");
    const frame = data.frames.find((f) => f.shotId === shot.id && f.approved)!;
    frame.approvedFingerprint = null;
    frame.approvedSnapshot = null;
    expect(freshness(data, shot.id).status).toBe("unknown");
  });
});

describe("generation package fingerprint", () => {
  const build = (data: ProjectData, code: string, at: string) =>
    assembleGenerationPackage(buildShotContext(data, shotByCode(data, code).id), new Date(at));

  it("is stable across rebuilds (builtAt excluded) and deterministic", () => {
    const data = seed();
    const a = build(data, "3A", "2026-01-01T00:00:00Z");
    const b = build(data, "3A", "2026-06-01T12:00:00Z");
    expect(a.provenance.fingerprint).toBe(b.provenance.fingerprint);
    expect(a.provenance.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the selected performance, Look, camera or location changes", () => {
    const base = build(seed(), "3A", "2026-01-01T00:00:00Z").provenance.fingerprint;

    const perf = seed();
    const shot = shotByCode(perf, "3A");
    const alt = perf.takes.find((t) => t.dialogueLineId === shot.audio.dialogueLineIds[0] && !t.selected)!;
    perf.takes = selectTake(perf.takes, alt.id) as typeof perf.takes;
    expect(build(perf, "3A", "2026-01-01T00:00:00Z").provenance.fingerprint).not.toBe(base);

    const look = seed();
    look.looks.find((l) => l.id === shotByCode(look, "3A").characters[0].lookId)!.hair = "loose";
    expect(build(look, "3A", "2026-01-01T00:00:00Z").provenance.fingerprint).not.toBe(base);

    const cam = seed();
    shotByCode(cam, "3A").composition.movement = "static";
    expect(build(cam, "3A", "2026-01-01T00:00:00Z").provenance.fingerprint).not.toBe(base);

    const loc = seed();
    loc.locations.find((l) => l.id === shotByCode(loc, "3A").spatial.locationId)!.description = "renovated";
    expect(build(loc, "3A", "2026-01-01T00:00:00Z").provenance.fingerprint).not.toBe(base);
  });

  it("embeds self-describing assets and provenance so history stays interpretable", () => {
    const data = seed();
    const pkg = build(data, "3A", "2026-01-01T00:00:00Z");
    expect(pkg.packageSchemaVersion).toBe(3);
    expect(Object.keys(pkg.assets).length).toBeGreaterThan(0);
    const take = pkg.performance[0].selectedTake!;
    expect(pkg.assets[take.audioAssetId!]).toMatchObject({ type: "audio", id: take.audioAssetId });
    expect(pkg.provenance.sourceVersions.selectedTakeIds).toEqual([take.takeId]);
    expect(pkg.provenance.sourceVersions.lookIds).toHaveLength(1);
    expect(pkg.timing.segments.map((s) => s.kind)).toEqual(["pre_roll", "dialogue", "reaction"]);
    expect(pkg.sourceScript.dialogue[0].text).toBe("もう帰りたい……");
    expect(pkg.project.slug).toBe("ojousama");
  });

  it("a rebuilt package differs from a stored historical snapshot without altering it", () => {
    const data = seed();
    const attempt = data.attempts[0];
    const snapshotBefore = JSON.stringify(attempt.packageSnapshot);
    shotByCode(data, "2B").composition.lens = "135mm";
    const now = build(data, "2B", "2026-01-01T00:00:00Z");
    expect(now.provenance.fingerprint).not.toBe(attempt.packageFingerprint);
    expect(attempt.packageFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(attempt.packageSnapshot)).toBe(snapshotBefore);
  });
});
