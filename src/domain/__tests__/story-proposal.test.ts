import { describe, expect, it } from "vitest";
import { buildSeedProject } from "../../data/seed";
import type { ProjectData } from "../schemas";
import { proposalFromScreenplay } from "../../story/providers/fake";
import { derivedId, planApply } from "../story/apply";
import { PROPOSAL_JSON_SCHEMA, proposalSchema, validateProposal } from "../story/proposal";
import { defaultReview, findMatch, itemId, normalizeName, proposalMatches } from "../story/review";
import {
  describeSources,
  excerpt,
  lineCount,
  normalizeSourceText,
  numberedSource,
  pagesFor,
} from "../story/source";

/** Phase 5B-S1 (pure): the Production Proposal contract, matching, review and the deterministic apply plan. */
const OJOUSAMA = normalizeSourceText(buildSeedProject().episodes[0]!.scriptText);
const proposal = () => proposalFromScreenplay(OJOUSAMA, "Ojou-sama");
const NOW = "2026-11-08T00:00:00.000Z";

/** Every object node of the JSON schema has the same keys as the Zod schema node, all required, no extras. */
function walk(json: Record<string, unknown>, zod: unknown, path = "$"): string[] {
  const out: string[] = [];
  const def = (zod as { _zod?: { def?: Record<string, unknown> } })._zod?.def ?? {};
  const unwrap = (z: unknown): unknown => {
    let cur = z as { _zod?: { def?: Record<string, unknown> } };
    while (cur?._zod?.def && ["nullable", "optional", "pipe"].includes(String(cur._zod.def.type)))
      cur = (cur._zod.def.innerType ?? cur._zod.def.in) as typeof cur;
    return cur;
  };
  const z = unwrap(zod) as { _zod?: { def?: Record<string, unknown> } };
  const d = z._zod?.def ?? def;
  if (json.type === "object") {
    const props = json.properties as Record<string, Record<string, unknown>>;
    const shape = (d.shape ?? {}) as Record<string, unknown>;
    if (JSON.stringify(Object.keys(props).sort()) !== JSON.stringify(Object.keys(shape).sort()))
      out.push(`${path}: keys differ`);
    if (JSON.stringify((json.required as string[]).sort()) !== JSON.stringify(Object.keys(props).sort()))
      out.push(`${path}: not all required`);
    if (json.additionalProperties !== false) out.push(`${path}: additionalProperties`);
    for (const k of Object.keys(props)) if (shape[k]) out.push(...walk(props[k]!, shape[k], `${path}.${k}`));
  } else if (json.type === "array")
    out.push(...walk(json.items as Record<string, unknown>, d.element, `${path}[]`));
  return out;
}

describe("Production Proposal schema", () => {
  it("the strict JSON schema sent to the model and the Zod validator describe the same object", () => {
    expect(walk(PROPOSAL_JSON_SCHEMA as Record<string, unknown>, proposalSchema)).toEqual([]);
    // only the keywords the verified Structured Outputs schema already relies on
    const keywords = new Set<string>();
    const collect = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(collect);
      if (n && typeof n === "object")
        for (const [k, v] of Object.entries(n)) {
          if (k === "properties") {
            for (const child of Object.values(v as object)) collect(child);
            continue;
          }
          keywords.add(k);
          collect(v);
        }
    };
    collect(PROPOSAL_JSON_SCHEMA);
    for (const k of keywords)
      expect([
        "type",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "maxItems",
        "minimum",
        "enum",
      ]).toContain(k);
  });

  it("validates a real proposal and rejects malformed output without partial results", () => {
    const n = lineCount(OJOUSAMA);
    expect(validateProposal(proposal(), n)).toMatchObject({ ok: true });
    expect(validateProposal(JSON.stringify(proposal()), n)).toMatchObject({ ok: true });
    const bad = (mutate: (p: ReturnType<typeof proposal>) => unknown, pattern: RegExp) => {
      const p = structuredClone(proposal());
      const v = validateProposal(mutate(p) ?? p, n);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.join(" | ")).toMatch(pattern);
    };
    expect(validateProposal("{not json", n)).toEqual({
      ok: false,
      errors: ["The answer is not valid JSON."],
    });
    bad((p) => ({ ...p, extra: 1 }), /Unrecognized key|unrecognized/i);
    bad((p) => {
      p.characters[0]!.name = "";
    }, /characters\.0\.name/);
    bad((p) => {
      p.scenes[0]!.locationKey = "l99";
    }, /unknown reference "l99"/);
    bad((p) => {
      p.characters.push({ ...p.characters[0]! });
    }, /duplicate key/);
    bad((p) => {
      p.scenes[1]!.order = 5;
    }, /order must run 1\.\.n/);
    bad((p) => {
      p.shots[0]!.sources = [{ startLine: 1, endLine: 9999 }];
    }, /outside the input/);
    bad((p) => {
      (p.locations[0] as { intExt: string }).intExt = "OUTSIDE";
    }, /intExt/);
  });
});

describe("source text and traceability", () => {
  it("normalizes, numbers, fingerprints and cites lines or pages", () => {
    expect(normalizeSourceText("﻿A  \r\nB\u0000\r\n\r\n")).toBe("A\nB");
    expect(numberedSource("a\nb").split("\n")).toEqual(["1| a", "2| b"]);
    expect(excerpt("one\ntwo\nthree", { startLine: 2, endLine: 3 })).toBe("two three");
    expect(
      describeSources([
        { startLine: 3, endLine: 5 },
        { startLine: 9, endLine: 9 },
      ]),
    ).toBe("lines 3–5, 9");
    expect(pagesFor({ startLine: 12, endLine: 30 }, [1, 10, 25])).toBe("pages 2–3");
    expect(describeSources([{ startLine: 1, endLine: 2 }], [1, 10])).toBe("page 1");
  });
});

describe("matching (surfaced, never applied silently)", () => {
  it("exact names match; plural / spelling variants are only possible matches", () => {
    const existing = [
      { id: "y", name: "Yumeko" },
      { id: "t", name: "Tokyo Night Streets" },
      { id: "c", name: "Grand Celeste Hotel Canopy" },
    ];
    expect(normalizeName("MOTHER (V.O.)")).toBe("mother");
    expect(findMatch("YUMEKO", existing)).toEqual({ existingId: "y", existingName: "Yumeko", kind: "exact" });
    expect(findMatch("Tokyo Night Street", existing)).toMatchObject({ existingId: "t", kind: "possible" });
    expect(findMatch("Grand Celeste Canopy", existing)).toMatchObject({ existingId: "c", kind: "possible" });
    expect(findMatch("Takumi", existing)).toBeNull();
  });

  it("the default review selects everything; exact matches propose Use existing, possible matches wait", () => {
    const seed = buildSeedProject();
    const p = proposal();
    const matches = proposalMatches(p, {
      characters: seed.characters,
      locations: seed.locations.map((l) =>
        l.name === "Tokyo Night Streets" ? { ...l, name: "Tokyo Night Street" } : l,
      ),
    });
    const yumeko = p.characters.find((c) => c.name === "Yumeko")!;
    const street = p.locations.find((l) => l.name.startsWith("Tokyo"))!;
    const r = defaultReview(p, matches);
    expect(r.items[itemId("character", yumeko.key)]).toMatchObject({
      selected: true,
      match: { decision: "use_existing" },
    });
    expect(r.items[itemId("location", street.key)]!.match).toMatchObject({ decision: null });
    expect(Object.values(r.items).every((i) => i.selected && !i.rejected)).toBe(true);
  });
});

describe("Apply plan (deterministic)", () => {
  const empty = () => {
    const seed = buildSeedProject();
    return { ...seed, characters: [], locations: [], episodes: [], scenes: [], shots: [] };
  };
  const plan = (review = defaultReview(proposal(), {}), data: ProjectData = empty()) =>
    planApply({
      proposalId: "11111111-1111-4111-8111-111111111111",
      proposal: proposal(),
      review,
      data,
      sourceText: OJOUSAMA,
      sourceKind: "paste",
      now: NOW,
    });

  it("creates Characters, Locations, a new Episode, ordered Scenes and Shots with stable ids", () => {
    const a = plan();
    const b = plan();
    expect(a.errors).toEqual([]);
    expect(a.characters.create.map((c) => c.name).sort()).toEqual([
      "Mother",
      "Reporter",
      "Sean",
      "Takumi",
      "Yumeko",
    ]);
    expect(a.locations.create.map((l) => l.name)).toEqual([
      "Tokyo Night Streets",
      "Grand Celeste Hotel Canopy",
      "Grand Celeste Lobby",
      "Sky-View Restaurant",
      "Hotel Hallway",
    ]);
    expect(a.scenes.map((s) => [s.sceneNumber, s.slugline])).toEqual([
      ["1", "EXT. TOKYO NIGHT STREETS - NIGHT"],
      ["2", "EXT. GRAND CELESTE HOTEL CANOPY - NIGHT"],
      ["3", "INT. GRAND CELESTE LOBBY - NIGHT"],
      ["4", "INT. SKY-VIEW RESTAURANT - NIGHT"],
      ["5", "INT. HOTEL HALLWAY - NIGHT"],
      ["6", "INT. SKY-VIEW RESTAURANT - NIGHT"],
    ]);
    expect(a.episode.create).toMatchObject({ number: 1, slug: "ep-1", scriptText: OJOUSAMA });
    // Scene 3 (the Lobby) has the Shot structure of 3A: Yumeko in the Lobby
    const lobby = a.scenes[2]!;
    const lobbyShots = a.shots.filter((s) => s.sceneId === lobby.id);
    expect(lobbyShots.map((s) => s.shotCode)).toEqual(["3A", "3B"]);
    const yumeko = a.characters.create.find((c) => c.name === "Yumeko")!;
    expect(lobbyShots[1]!.characters.map((c) => c.characterId)).toEqual([yumeko.id]);
    expect(lobbyShots.every((s) => s.spatial.locationId === lobby.locationId)).toBe(true);
    expect(lobby.scriptRange).toMatchObject({ startLine: expect.any(Number) });
    // deterministic: the same proposal and review give the same ids
    expect(b.shots.map((s) => s.id)).toEqual(a.shots.map((s) => s.id));
    expect(derivedId("p", "x")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("deselected and rejected items are not applied; edits are; a Shot whose Scene is not applied is skipped", () => {
    const p = proposal();
    const r = defaultReview(p, {});
    const mother = p.characters.find((c) => c.name === "Mother")!;
    const reporter = p.characters.find((c) => c.name === "Reporter")!;
    r.items[itemId("character", mother.key)]!.selected = false;
    r.items[itemId("character", reporter.key)]!.rejected = true;
    r.items[itemId("scene", "s1")]!.selected = false;
    r.items[itemId("scene", "s3")]!.edits = {
      summary: "Yumeko crosses the lobby alone.",
      order: "99",
    } as never;
    r.story = { title: "Ojou-sama: Episode 1" };
    const a = plan(r);
    expect(a.characters.create.map((c) => c.name).sort()).toEqual(["Sean", "Takumi", "Yumeko"]);
    expect(a.scenes).toHaveLength(5);
    expect(a.scenes[1]!.summary).toBe("Yumeko crosses the lobby alone.");
    expect(a.scenes[1]!.sceneNumber).toBe("2"); // order is not an editable field
    expect(a.episode.create?.title).toBe("Ojou-sama: Episode 1");
    expect(a.summary.skipped.length).toBe(p.shots.filter((s) => s.sceneKey === "s1").length);
  });

  it("matches: use existing reuses, merge fills only empty fields, an undecided match blocks the apply", () => {
    const seed = buildSeedProject();
    const p = proposal();
    const matches = proposalMatches(p, seed);
    const r = defaultReview(p, matches);
    const yumeko = p.characters.find((c) => c.name === "Yumeko")!;
    const takumi = p.characters.find((c) => c.name === "Takumi")!;
    r.items[itemId("character", takumi.key)]!.match!.decision = "merge";
    const a = plan(r, seed);
    expect(a.errors).toEqual([]);
    const seedYumeko = seed.characters.find((c) => c.name === "Yumeko")!;
    expect(a.characters.create.some((c) => c.name === "Yumeko")).toBe(false);
    const lobbyScene = a.scenes.find((s) => s.slugline.includes("LOBBY"))!;
    expect(lobbyScene.characterIds).toContain(seedYumeko.id);
    expect(lobbyScene.locationId).toBe(seed.locations.find((l) => l.name === "Grand Celeste Lobby")!.id);
    const seedTakumi = seed.characters.find((c) => c.name === "Takumi")!;
    const merged = a.characters.update.find((c) => c.id === seedTakumi.id)!;
    expect(merged.description).toBe(seedTakumi.description || "unknown");
    expect(merged.name).toBe("Takumi");
    // an undecided possible match blocks
    r.items[itemId("character", yumeko.key)]!.match!.decision = null;
    expect(plan(r, seed).errors[0]).toMatch(/possible match for Character "Yumeko"/);
    // into an existing Episode: appended after its Scenes, its script untouched
    const r2 = defaultReview(p, matches);
    const ep = seed.episodes[0]!;
    r2.target = { kind: "existing_episode", episodeId: ep.id };
    const b = plan(r2, seed);
    expect(b.episode.create).toBeNull();
    expect(b.scenes[0]!.sceneNumber).toBe("7");
    expect(b.scenes[0]!.scriptRange).toBeNull();
  });
});
