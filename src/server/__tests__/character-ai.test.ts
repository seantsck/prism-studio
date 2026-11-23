import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * "Fill in with Prism" on a Character, through the REAL actions, memory repository and Story worker with the FREE
 * test writer: the request carries the Character's sheet and asks one idea per field; the answer is reviewed field by
 * field and applied only where ticked. A Character made on its own (the library) is never given a role.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
  // a test server: the free test writer may be offered (a real deployment never offers it; tested below)
  process.env.PRISM_STUDIO_SHOW_TEST_MODELS = "1";
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});
const world = vi.hoisted(() => ({
  repo: null as unknown,
  files: new Map<string, Uint8Array>(),
  redirects: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => void world.redirects.push(to)),
  notFound: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/storage", () => {
  const store = {
    name: "local" as const,
    bucket: null,
    put: async (p: string, b: Uint8Array) => void world.files.set(p, new Uint8Array(b)),
    get: async (p: string) => world.files.get(p) ?? null,
  };
  return {
    getUploadStorage: async () => store,
    storageForAsset: async () => store,
    checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  };
});

import { createProject } from "../actions";
import { fillCharacter, reviewCharacterFill } from "../character-ai-actions";
import { createStandaloneCharacter, createStandaloneLocation } from "../library-actions";
import { quoteCharacterFill, quoteLocationFill, quoteNewFill } from "../series-start";
import { fillLocation, reviewLocationFill } from "../location-ai-actions";
import { autoFillCharacter, autoFillLocation } from "../sheet-autofill";
import { LOCATION_AI_FIELDS, isLocationRequest, namedLines, parseLocationIdeas } from "@/domain/location-ai";
import type { Location } from "@/domain/schemas";
import {
  CHARACTER_AI_FIELDS,
  characterAiFields,
  characterFillInstruction,
  isCharacterRequest,
  parseCharacterIdeas,
} from "@/domain/character-ai";
import type { Character } from "@/domain/schemas";

let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.redirects = [];
});
afterEach(() => vi.clearAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const work = () =>
  new StoryWorker({
    store: repo.story,
    writing: repo.writing,
    registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [new FakeStoryProvider()]),
    workerId: "test-worker",
  }).tick(20);

async function proposalsOf(slug: string) {
  const data = (await repo.loadProject(slug))!;
  const out = [];
  for (const e of data.episodes)
    for (const s of await repo.writing.listSessions(data.project.id, e.id))
      out.push(...(await repo.writing.listProposals(data.project.id, s.id)));
  return out;
}

const TAKUMI =
  "Takumi Saionji, Japanese man in his mid-30s, heir to a powerful Tokyo conglomerate. Jet-black hair swept back.";

describe("filling in a Character with Prism", () => {
  it("asks one idea per field, with the sheet as written; the answer is applied only where ticked", async () => {
    expect(
      await createProject(
        form({ title: "Ojousama", premise: "An heiress must marry a stranger.", defaultLanguage: "ja" }),
      ),
    ).toMatchObject({ ok: true });
    const slug = world.redirects.at(-1)!.split("/")[2]!;
    let data = (await repo.loadProject(slug))!;
    const now = new Date().toISOString();
    const takumi = {
      id: crypto.randomUUID(),
      projectId: data.project.id,
      name: "Takumi Saionji",
      role: "",
      description: TAKUMI,
      personality: "",
      behaviorNotes: "",
      physicalDescription: TAKUMI,
      continuityRules: [],
      signatureBehavior: "",
      relationshipNotes: "",
      createdAt: now,
      updatedAt: now,
    } as Character;
    await repo.upsert(data.project.id, "characters", takumi);
    data = (await repo.loadProject(slug))!;

    const q = quoteCharacterFill(data, takumi.id);
    expect(q).toMatchObject({ ok: true, paid: false });
    expect(
      await fillCharacter(form({ projectSlug: slug, characterId: takumi.id, note: "Raised in Kyoto." })),
    ).toMatchObject({ ok: true, message: "Prism is filling in Takumi Saionji…" });
    const [asked] = (await proposalsOf(slug)).filter((p) => isCharacterRequest(p.instruction, takumi.id));
    expect(asked).toMatchObject({ mode: "brainstorm", status: "queued" });
    // a story's Character: every field, the role and relationships included; the sheet and the note are sent
    expect(asked!.alternativesRequested).toBe(CHARACTER_AI_FIELDS.length);
    expect(asked!.instruction).toContain("- role: ");
    expect(asked!.instruction).toContain(`Description: ${TAKUMI}`);
    expect(asked!.instruction).toContain("Creator's note: Raised in Kyoto.");
    expect(asked!.instruction).toContain("Story premise: An heiress must marry a stranger.");

    await work();
    const ready = (await proposalsOf(slug)).find((p) => p.id === asked!.id)!;
    expect(ready.status).toBe("ready");
    expect(Object.keys(parseCharacterIdeas(ready.result!.ideas, true))).toHaveLength(
      CHARACTER_AI_FIELDS.length,
    );

    expect(
      await reviewCharacterFill(form({ projectSlug: slug, characterId: takumi.id, proposalId: ready.id })),
    ).toMatchObject({ ok: false, error: "Tick the fields you want to use." });
    expect(
      await reviewCharacterFill(
        form({
          projectSlug: slug,
          characterId: takumi.id,
          proposalId: ready.id,
          text_personality: "Charming, transactional.",
          use_personality: "1",
          text_continuityRules: "Hair always swept back\n- Silver cufflinks",
          use_continuityRules: "1",
          text_role: "Antagonist — fiancé candidate",
        }),
      ),
    ).toMatchObject({ ok: true, message: "2 fields applied to Takumi Saionji." });
    const after = (await repo.loadProject(slug))!.characters.find((c) => c.id === takumi.id)!;
    expect(after.personality).toBe("Charming, transactional.");
    expect(after.continuityRules).toEqual(["Hair always swept back", "Silver cufflinks"]);
    // not ticked: unchanged, as edited or not
    expect(after.role).toBe("");
    expect(after.description).toBe(TAKUMI);
  });

  it("a Character made on its own gets no role or relationships, and its library gets an Episode for the request", async () => {
    const made = await createStandaloneCharacter(form({ prompt: TAKUMI, name: "Takumi" }));
    const { slug, id } = made.created!;
    expect((await repo.loadProject(slug))!.episodes).toHaveLength(0);
    expect(await fillCharacter(form({ projectSlug: slug, characterId: id }))).toMatchObject({ ok: true });
    expect((await repo.loadProject(slug))!.episodes).toHaveLength(1);
    const [asked] = (await proposalsOf(slug)).filter((p) => isCharacterRequest(p.instruction, id));
    expect(asked!.alternativesRequested).toBe(characterAiFields(false).length);
    expect(asked!.instruction).not.toContain("- role: ");
    expect(asked!.instruction).not.toContain("- relationshipNotes: ");
    expect(asked!.instruction).toContain("belongs to no story yet");
    await work();
    const ready = (await proposalsOf(slug)).find((p) => p.id === asked!.id)!;
    expect(Object.keys(parseCharacterIdeas(ready.result!.ideas, false)).sort()).toEqual(
      characterAiFields(false)
        .map((f) => f.key)
        .sort(),
    );
  });

  it("recognises its own requests, and names each field once", () => {
    const c = { id: "abc", name: "Ren" } as Character;
    const data = { project: { purpose: "library" }, bible: { premise: "" } } as never;
    const text = characterFillInstruction(data, {
      ...c,
      description: "",
      personality: "",
      behaviorNotes: "",
      physicalDescription: "",
      signatureBehavior: "",
      relationshipNotes: "",
      role: "",
      continuityRules: [],
    } as Character);
    expect(isCharacterRequest(text, "abc")).toBe(true);
    expect(isCharacterRequest(text, "other")).toBe(false);
    expect(isCharacterRequest("Draft the project Bible")).toBe(false);
    expect(
      parseCharacterIdeas(
        [
          { title: "Personality", detail: "Calm." },
          { title: "personality", detail: "Twice." },
          { title: "role", detail: "Lead" },
        ],
        false,
      ),
    ).toEqual({ personality: "Calm." });
  });
});

describe("filling in a Location with Prism", () => {
  it("asks one idea per field; zones and entrances apply as named lists; a locked Location is refused", async () => {
    expect(
      await createProject(
        form({ title: "Ojousama", premise: "An heiress must marry a stranger.", defaultLanguage: "ja" }),
      ),
    ).toMatchObject({ ok: true });
    const slug = world.redirects.at(-1)!.split("/")[2]!;
    let data = (await repo.loadProject(slug))!;
    const hall: Location = {
      id: crypto.randomUUID(),
      projectId: data.project.id,
      name: "The Gilded Hall",
      description: "A ballroom with crystal chandeliers.",
      geography: "",
      zones: [],
      entrances: [],
      lighting: "",
      recurringProps: [],
      referenceAssetIds: [],
      locked: false,
      set3d: null,
    };
    await repo.upsert(data.project.id, "locations", hall);
    data = (await repo.loadProject(slug))!;
    expect(quoteLocationFill(data, hall.id)).toMatchObject({ ok: true, paid: false });

    expect(
      await fillLocation(form({ projectSlug: slug, locationId: hall.id, note: "Kyoto, old money." })),
    ).toMatchObject({
      ok: true,
      message: "Prism is filling in The Gilded Hall…",
    });
    const [asked] = (await proposalsOf(slug)).filter((p) => isLocationRequest(p.instruction, hall.id));
    expect(asked!.alternativesRequested).toBe(LOCATION_AI_FIELDS.length);
    expect(asked!.instruction).toContain("Description: A ballroom with crystal chandeliers.");
    expect(asked!.instruction).toContain("Creator's note: Kyoto, old money.");
    await work();
    const ready = (await proposalsOf(slug)).find((p) => p.id === asked!.id)!;
    expect(Object.keys(parseLocationIdeas(ready.result!.ideas))).toHaveLength(LOCATION_AI_FIELDS.length);

    expect(
      await reviewLocationFill(
        form({
          projectSlug: slug,
          locationId: hall.id,
          proposalId: ready.id,
          text_zones: "- Dance floor: the centre, under the chandelier\nBar: by the east wall",
          use_zones: "1",
          text_lighting: "Warm chandelier light; cold moonlight through the west windows at night.",
          use_lighting: "1",
          text_geography: "Not ticked.",
        }),
      ),
    ).toMatchObject({ ok: true, message: "2 fields applied to The Gilded Hall." });
    const after = (await repo.loadProject(slug))!.locations.find((l) => l.id === hall.id)!;
    expect(after.zones.map((z) => [z.name, z.description])).toEqual([
      ["Dance floor", "the centre, under the chandelier"],
      ["Bar", "by the east wall"],
    ]);
    expect(after.lighting).toBe("Warm chandelier light; cold moonlight through the west windows at night.");
    expect(after.geography).toBe("");
    // applied: the draft is done with
    expect((await proposalsOf(slug)).find((p) => p.id === ready.id)!.status).toBe("rejected");

    await repo.upsert(data.project.id, "locations", { ...after, locked: true });
    expect(await fillLocation(form({ projectSlug: slug, locationId: hall.id }))).toMatchObject({
      ok: false,
      error: "The Gilded Hall is locked. Unlock it to fill it in.",
    });
    expect(namedLines("A: b: c\n\nD")).toEqual([
      { name: "A", description: "b: c" },
      { name: "D", description: "" },
    ]);
  });
});

describe("Have Prism fill in the details, ticked on the create box", () => {
  it("creates, then asks Prism at the price the box showed; unticked, it asks nothing", async () => {
    const offer = quoteNewFill("character");
    if (!offer.ok) throw new Error(offer.reason);
    const made = await createStandaloneCharacter(
      form({ prompt: TAKUMI, name: "Takumi", fill: "1", fillModel: offer.model }),
    );
    expect(made).toMatchObject({ ok: true, created: { filling: true } });
    const { slug, id } = made.created!;
    expect((await proposalsOf(slug)).filter((p) => isCharacterRequest(p.instruction, id))).toHaveLength(1);
    // the box's price covers the request that was sent
    const data = (await repo.loadProject(slug))!;
    const actual = quoteCharacterFill(data, id);
    expect(actual.ok && offer.usd >= actual.usd).toBe(true);

    const plain = await createStandaloneCharacter(form({ prompt: "A courier named Ren." }));
    expect(plain.created!.filling).toBeNull();
    expect(
      (await proposalsOf(slug)).filter((p) => isCharacterRequest(p.instruction, plain.created!.id)),
    ).toHaveLength(0);

    const loc = quoteNewFill("location");
    if (!loc.ok) throw new Error(loc.reason);
    const hall = await createStandaloneLocation(
      form({ prompt: "A ballroom called The Gilded Hall.", fill: "1", fillModel: loc.model }),
    );
    expect(hall.created!.filling).toBe(true);
    expect(
      (await proposalsOf(slug)).filter((p) => isLocationRequest(p.instruction, hall.created!.id)),
    ).toHaveLength(1);
  });
});

describe("Prism's answer fills in the empty fields at once", () => {
  it("fills what was empty, keeps what was written for review, and runs once", async () => {
    const made = await createStandaloneCharacter(form({ prompt: TAKUMI, name: "Takumi" }));
    const { slug, id } = made.created!;
    await fillCharacter(form({ projectSlug: slug, characterId: id }));
    await work();
    let data = (await repo.loadProject(slug))!;
    const proposal = (await proposalsOf(slug)).find((p) => isCharacterRequest(p.instruction, id))!;
    const before = data.characters.find((c) => c.id === id)!;
    const first = await autoFillCharacter(data, before, proposal);
    expect(first.filled).toEqual(["Personality", "Behavior notes", "Signature behavior", "Continuity rules"]);
    expect(first.proposalDone).toBe(false); // Prism words the description differently: left to review
    data = (await repo.loadProject(slug))!;
    const after = data.characters.find((c) => c.id === id)!;
    expect(after.personality).toBe("Test personality for Takumi.");
    expect(after.continuityRules).toEqual([
      "Test continuity rules one for Takumi.",
      "Test continuity rules two.",
    ]);
    expect(after.description).toBe(TAKUMI);
    expect(after.physicalDescription).toBe(TAKUMI);
    // once: a field the creator empties afterwards is not filled again
    await repo.upsert(data.project.id, "characters", {
      ...after,
      personality: "",
      updatedAt: new Date().toISOString(),
    });
    data = (await repo.loadProject(slug))!;
    const again = await autoFillCharacter(
      data,
      data.characters.find((c) => c.id === id)!,
      proposal,
    );
    expect(again.filled).toEqual([]);
  });

  it("a Location's empty fields are filled; its draft closes once nothing is left to review", async () => {
    const made = await createStandaloneLocation(form({ prompt: "A ballroom called The Gilded Hall." }));
    const { slug, id } = made.created!;
    await fillLocation(form({ projectSlug: slug, locationId: id }));
    await work();
    let data = (await repo.loadProject(slug))!;
    const proposal = (await proposalsOf(slug)).find((p) => isLocationRequest(p.instruction, id))!;
    const res = await autoFillLocation(
      data,
      data.locations.find((l) => l.id === id)!,
      proposal,
    );
    expect(res.filled).toEqual(["Geography", "Zones", "Entrances / exits", "Lighting", "Recurring props"]);
    expect(res.location.zones.map((z) => z.name)).toEqual(["Test zones A", "Test zones B"]);
    expect(res.location.description).toBe("A ballroom called The Gilded Hall.");
    expect(res.proposalDone).toBe(false);
    // the creator takes Prism's description too: nothing left, the draft is done
    data = (await repo.loadProject(slug))!;
    const l = data.locations.find((x) => x.id === id)!;
    const theirs = parseLocationIdeas(
      (await repo.writing.getProposal(data.project.id, proposal.id))!.result!.ideas,
    );
    await repo.upsert(data.project.id, "locations", { ...l, description: theirs.description! });
    data = (await repo.loadProject(slug))!;
    const closing = await autoFillLocation(
      data,
      data.locations.find((x) => x.id === id)!,
      proposal,
    );
    expect(closing).toMatchObject({ filled: [], proposalDone: true });
    expect((await repo.writing.getProposal(data.project.id, proposal.id))!.status).toBe("rejected");
  });
});
