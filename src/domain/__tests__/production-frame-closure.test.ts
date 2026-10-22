import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findAssetUsage } from "@/domain/asset-usage";
import { computeShotParts, FRESHNESS_PARTS, overallFingerprint, stableParts } from "@/domain/fingerprint";
import {
  assembleGenerationPackage,
  shotChangedSinceAttempt,
  type GenerationPackage,
} from "@/domain/generation-package";
import { fingerprint } from "@/domain/hash";
import {
  assetPromotionStatus,
  buildProductionFrameIntent,
  selectedProductionFrameFreshness,
  storyboardPromotionStatus,
  type ProductionFrame,
} from "@/domain/production-frame";
import { seed, shotByCode } from "./helpers";
import {
  attach,
  contextOf,
  draftFor,
  newUploadAsset,
  seedWithFrame,
  storeImage,
} from "./production-frame-fixtures";

/**
 * Closure of Phase 2G.1: the two fingerprints (package identity vs the Shot's production-input identity), and a few
 * invariants that must keep holding.
 */

const NOW = new Date("2026-10-21T00:00:00Z");
type Data = ReturnType<typeof seed>;
const pkgOf = (data: Data, code = "3A") => assembleGenerationPackage(contextOf(data, code), NOW);
const overallOf = (pkg: GenerationPackage) => pkg.provenance.parts.overall as string;

/** The attempt a PREVIOUS schema froze for the same Shot: package fingerprint by the v2 content, overall by the v2 rule. */
function v2Attempt(pkg: GenerationPackage) {
  const content: Record<string, unknown> = { ...pkg };
  delete content.provenance;
  const fp = fingerprint({ ...content, version: 2, packageSchemaVersion: 2, builtAt: null });
  const legacyOverall = fingerprint(
    FRESHNESS_PARTS.map((p) => [p, (pkg.provenance.parts as Record<string, string>)[p]]),
  );
  const snapshot = {
    ...structuredClone(pkg),
    version: 2,
    packageSchemaVersion: 2,
    provenance: {
      ...structuredClone(pkg.provenance),
      fingerprint: fp,
      parts: { ...structuredClone(pkg.provenance.parts), overall: legacyOverall },
    },
  };
  return {
    attempt: { packageFingerprint: fp, packageSnapshot: snapshot as Record<string, unknown> },
    fp,
    legacyOverall,
  };
}

describe("the two fingerprints are not interchangeable", () => {
  it("A. the same unchanged Shot as v2 and v3: the PACKAGE identity differs, the SHOT identity does not, so no false 'shot changed'", () => {
    const data = seed();
    const pkg = pkgOf(data);
    const { attempt, fp, legacyOverall } = v2Attempt(pkg);
    // package identity: a v3 package and a v2 package are different frozen shapes
    expect(pkg.version).toBe(4); // the current shape (Phase 2G.3)
    expect(fp).not.toBe(pkg.provenance.fingerprint);
    // the Shot's production-input identity is exactly the pre-2G.1 value (the legacy rule reproduced above)
    expect(overallOf(pkg)).toBe(legacyOverall);
    // Shot Prep's question is answered from the INPUTS identity, across schema versions
    expect(shotChangedSinceAttempt(attempt, pkg)).toMatchObject({ changed: false, basis: "inputs" });
    // and the exact package fingerprint comparison would have lied here
    expect(attempt.packageFingerprint !== pkg.provenance.fingerprint).toBe(true);
  });

  it("A'. a genuinely changed Shot is still reported as changed, from the same v2 attempt", () => {
    const data = seed();
    const { attempt } = v2Attempt(pkgOf(data));
    shotByCode(data, "3A").lighting.mood = "harsh noon sun";
    expect(shotChangedSinceAttempt(attempt, pkgOf(data))).toMatchObject({ changed: true, basis: "inputs" });
  });

  it("a snapshot that recorded no inputs identity falls back to the exact package fingerprint (never rewritten)", () => {
    const pkg = pkgOf(seed());
    const old = {
      packageFingerprint: "a".repeat(64),
      packageSnapshot: { version: 1, provenance: { fingerprint: "a".repeat(64) } },
    };
    expect(shotChangedSinceAttempt(old, pkg)).toEqual({
      changed: true,
      basis: "package",
      from: "a".repeat(64),
      to: pkg.provenance.fingerprint,
    });
    expect(
      shotChangedSinceAttempt({ ...old, packageFingerprint: pkg.provenance.fingerprint }, pkg)?.changed,
    ).toBe(false);
    expect(shotChangedSinceAttempt({ packageFingerprint: "", packageSnapshot: null }, pkg)).toBeNull();
  });

  it("B. selecting a Production Frame changes BOTH identities; an attempt that predates it is based on different production truth", () => {
    const data = seed();
    const before = pkgOf(data);
    const { attempt } = v2Attempt(before);
    const { data: withFrame } = seedWithFrame("3A");
    const after = pkgOf(withFrame);
    expect(overallOf(after)).not.toBe(overallOf(before));
    expect(after.provenance.fingerprint).not.toBe(before.provenance.fingerprint);
    expect(after.provenance.parts).toHaveProperty("productionFrame");
    expect(shotChangedSinceAttempt(attempt, after)).toMatchObject({ changed: true, basis: "inputs" });
  });

  it("C. an UNSELECTED historical frame changes neither identity: no false warning", () => {
    const { data, frame } = seedWithFrame("3A");
    const before = pkgOf(data);
    // an attempt made while this frame was selected (a v3 snapshot)
    const attempt = {
      packageFingerprint: before.provenance.fingerprint,
      packageSnapshot: structuredClone(before) as unknown as Record<string, unknown>,
    };
    const spare = newUploadAsset(data.project.id, { label: "spare" });
    data.assets.push(spare);
    const older: ProductionFrame = { ...draftFor(data, "3A", { asset: spare }), version: 2 };
    attach(data, [frame, older], frame);
    const after = pkgOf(data);
    expect(overallOf(after)).toBe(overallOf(before));
    expect(after.provenance.fingerprint).toBe(before.provenance.fingerprint);
    expect(shotChangedSinceAttempt(attempt, before)).toMatchObject({ changed: false });
    expect(shotChangedSinceAttempt(attempt, after)).toMatchObject({ changed: false });
    // a Shot with NO selection and only history behaves like a Shot with no frames at all
    attach(data, [frame, older], null);
    expect(overallOf(pkgOf(data))).toBe(overallOf(pkgOf(seed())));
    expect(pkgOf(data).provenance.parts).not.toHaveProperty("productionFrame");
  });

  it("D. switching the selected frame v1 → v2 changes BOTH identities", () => {
    const { data, asset, frame: v1 } = seedWithFrame("3A");
    const spare = newUploadAsset(data.project.id, { label: "v2-image" });
    data.assets.push(spare);
    const v2: ProductionFrame = { ...draftFor(data, "3A", { asset: spare }), version: 2 };
    const on1 = pkgOf(attach(data, [v1, v2], v1));
    const on2 = pkgOf(attach(data, [v1, v2], v2));
    expect(overallOf(on2)).not.toBe(overallOf(on1));
    expect(on2.provenance.fingerprint).not.toBe(on1.provenance.fingerprint);
    // …and switching back restores both exactly (the part names the SELECTED frame, nothing else)
    const back = pkgOf(attach(data, [v1, v2], v1));
    expect(overallOf(back)).toBe(overallOf(on1));
    expect(back.provenance.fingerprint).toBe(on1.provenance.fingerprint);
    void asset;
  });

  it("E. re-selecting the same frame is not a change (deterministic identities)", () => {
    const { data, frame } = seedWithFrame("3A");
    const a = pkgOf(data);
    attach(data, [frame], frame);
    const b = pkgOf(data);
    expect(overallOf(b)).toBe(overallOf(a));
    expect(b.provenance.fingerprint).toBe(a.provenance.fingerprint);
  });

  it("the selection part is derived from the selected frame only and never enters a frame's own stored parts or an approval snapshot", () => {
    const { data, frame } = seedWithFrame("3A");
    const ctx = contextOf(data, "3A");
    const parts = computeShotParts(ctx);
    expect(parts.productionFrame).toBe(
      fingerprint({
        frameId: frame.id,
        frameFingerprint: frame.frameFingerprint,
        assetChecksum: frame.assetChecksum,
        intentFingerprint: frame.intentFingerprint,
      }),
    );
    expect(overallFingerprint(parts)).not.toBe(overallFingerprint(stableParts(parts)));
    // a second frame drafted WHILE another is selected still records only the 13 named parts
    const other = newUploadAsset(data.project.id, { label: "other" });
    data.assets.push(other);
    const second = draftFor(data, "3A", { asset: other });
    expect(Object.keys(second.parts).sort()).toEqual([...FRESHNESS_PARTS].sort());
    expect(second.parts).not.toHaveProperty("productionFrame");
  });

  it("exact package identity stays the package identity: provenance.fingerprint hashes the content, version fields included", () => {
    const pkg = pkgOf(seed());
    const content: Record<string, unknown> = { ...pkg };
    delete content.provenance;
    expect(fingerprint({ ...content, builtAt: null })).toBe(pkg.provenance.fingerprint);
  });
});

describe("what other consumers keep using", () => {
  it("only the Shot Prep 'changed since attempt' reasoning uses parts.overall; attempts, candidate sets, runs and exports keep the exact package identity", () => {
    const ROOT = process.cwd();
    const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
    // every place that STORES or COMPARES a package identity for history keeps provenance.fingerprint
    for (const f of [
      "src/generation/submission.ts",
      "src/generation/candidate-set.ts",
      "src/generation/model-comparison.ts",
      "src/continuity/service.ts",
      "src/server/actions.ts",
      "src/server/generation-actions.ts",
    ])
      expect(read(f), f).not.toMatch(/parts\.overall|shotChangedSinceAttempt/);
    expect(read("src/generation/submission.ts")).toMatch(/packageFingerprint: pkg\.provenance\.fingerprint/);
    expect(read("src/generation/candidate-set.ts")).toMatch(
      /packageFingerprint: pkg\.provenance\.fingerprint/,
    );
    // the one consumer of the semantic identity
    expect(read("src/components/views/shot-prep-view.tsx")).toMatch(
      /shotChangedSinceAttempt\(lastAttempt, pkg\)/,
    );
    expect(read("src/domain/generation-package.ts")).toMatch(
      /fingerprint\(\{ \.\.\.content, builtAt: null \}\)/,
    );
  });
});

describe("freshness names every relevant part", () => {
  const stale = (mutate: (d: Data) => void): ReturnType<typeof selectedProductionFrameFreshness> => {
    const { data } = seedWithFrame("3A");
    mutate(data);
    return selectedProductionFrameFreshness(contextOf(data, "3A"));
  };
  const cases: Array<[string, (d: Data) => void]> = [
    [
      "props",
      (d: Data) => {
        d.props.push({ ...d.props[0]!, id: "pf-new-prop", name: "a new prop" });
        shotByCode(d, "3A").propIds.push("pf-new-prop");
      },
    ],
    [
      "action",
      (d: Data) =>
        void shotByCode(d, "3A").action.beats.push({
          id: "pf-b",
          order: 99,
          atMs: 1000,
          description: "she turns",
        }),
    ],
    [
      "characters",
      (d: Data) => void (shotByCode(d, "3A").characters[0]!.expression = "a completely different expression"),
    ],
  ];
  it.each(cases)("a %s change makes the selected frame stale and names it", (part, mutate) => {
    const f = stale(mutate);
    expect(f.status).toBe("stale");
    expect(f.changedParts).toContain(part as never);
  });

  it("a stale selected frame stays selected and its record is untouched", () => {
    const { data, frame } = seedWithFrame("3A");
    const before = structuredClone(frame);
    shotByCode(data, "3A").lighting.mood = "harsh noon sun";
    const ctx = contextOf(data, "3A");
    expect(ctx.selectedProductionFrame?.id).toBe(frame.id);
    expect(selectedProductionFrameFreshness(ctx).status).toBe("stale");
    expect(ctx.selectedProductionFrame).toEqual(before);
  });
});

describe("the frozen intent is production meaning, not infrastructure", () => {
  it("contains no storage path, URL, credential or filesystem path, and stays small", () => {
    const { data } = seedWithFrame("3A");
    for (const code of ["3A", "2B", "4C"]) {
      const json = JSON.stringify(buildProductionFrameIntent(contextOf(data, code)));
      expect(json, code).not.toMatch(
        /objectPath|"bucket"|signedUrl|signed_url|token=|secret|password|api[_-]?key|https?:\/\/|[A-Za-z]:\\|\/Users\/|\/home\//i,
      );
      expect(json.length, code).toBeLessThan(24 * 1024);
    }
    // asset ids are fine (and private): present, but never as a path
    const intent = buildProductionFrameIntent(contextOf(data, "3A"));
    expect(intent.characters[0]!.identityReferenceAssetIds.length).toBeGreaterThan(0);
  });
});

describe("promotion availability is truthful", () => {
  it("the seeded approved Storyboard (a placeholder with no stored file) is disabled with a reason, without throwing", () => {
    const data = seed();
    const ctx = contextOf(data, "3A");
    expect(ctx.approvedFrame).not.toBeNull();
    expect(storyboardPromotionStatus(ctx)).toEqual({
      ok: false,
      reason: "That image has not been uploaded yet (it has no stored file).",
    });
  });

  it("no approved frame; a real image at the production aspect; a wrongly shaped real image; another project's image", () => {
    const data = seed();
    expect(storyboardPromotionStatus(contextOf(data, "5A"))).toEqual({
      ok: false,
      reason: "Approve a storyboard frame first.",
    });
    const ctx = contextOf(data, "3A");
    storeImage(data, ctx.approvedFrame!.assetId!, { label: "sb" });
    expect(storyboardPromotionStatus(contextOf(data, "3A"))).toEqual({ ok: true });
    storeImage(data, ctx.approvedFrame!.assetId!, { label: "sb", width: 1920, height: 1080 });
    const wrong = storyboardPromotionStatus(contextOf(data, "3A"));
    expect(wrong).toMatchObject({ ok: false });
    if (!wrong.ok) expect(wrong.reason).toMatch(/production frame is 2\.39:1/);
    const c = contextOf(data, "3A");
    expect(assetPromotionStatus(c, newUploadAsset("another-project"))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different project/),
    });
    expect(assetPromotionStatus(c, null)).toMatchObject({ ok: false });
    expect(assetPromotionStatus(c, newUploadAsset(data.project.id))).toEqual({ ok: true });
  });
});

describe("the Production Frame source graph is GPU-free", () => {
  it("imports no reconstruction, Local Agent, COLMAP/Brush, GPU or 3D tooling (transitively, through the frame modules)", () => {
    const ROOT = process.cwd();
    const seen = new Set<string>();
    const files = [
      "src/domain/production-frame.ts",
      "src/data/production-frame-repository.ts",
      "src/data/production-frame-memory.ts",
      "src/data/production-frame-postgres.ts",
      "src/server/production-frame-upload.ts",
    ];
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/")
        ? path.join("src", spec.slice(2))
        : spec.startsWith(".")
          ? path.join(path.dirname(from), spec)
          : null;
      if (!base) return null;
      for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")])
        try {
          readFileSync(path.join(ROOT, c));
          return c.replace(/\\/g, "/");
        } catch {
          /* next candidate */
        }
      return null;
    };
    const walk = (f: string) => {
      if (seen.has(f)) return;
      seen.add(f);
      const text = readFileSync(path.join(ROOT, f), "utf8");
      // type-only imports are erased at build time and carry no code
      for (const m of text.matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const next = resolve(f, m[1]!);
        if (next) walk(next);
      }
    };
    files.forEach(walk);
    expect(seen.size).toBeGreaterThan(8);
    for (const f of seen)
      expect(f, f).not.toMatch(
        /reconstruction|local-agent|colmap|brush|vulkan|spatial-pass|splat|\/previs\//i,
      );
    const bad = [...seen].filter(
      (f) => /server-only/.test(readFileSync(path.join(ROOT, f), "utf8")) && f.startsWith("src/domain"),
    );
    expect(bad).toEqual([]);
  });

  it("asset usage reports a Production Frame as pinning its image (so it cannot be deleted from under it)", () => {
    const { data, asset } = seedWithFrame("3A");
    expect(findAssetUsage(data, asset.id).direct.map((u) => u.kind)).toContain("production_frame");
  });
});
