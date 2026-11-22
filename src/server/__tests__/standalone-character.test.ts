import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { locationNameFromPrompt, nameFromPrompt } from "@/domain/standalone-character";

/**
 * A character made on its own (the home page's "Create a character"), through the REAL actions and loaders in memory
 * mode: it lives in the account's one `library` project (never among their projects), is in the library at once, and
 * any project adds a copy of it.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_PERSISTENCE = "memory";
});
const world = vi.hoisted(() => ({ redirects: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => void world.redirects.push(to)),
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("@/server/auth", () => ({
  requireUser: async () => ({ kind: "memory", id: "tester" }),
  getCurrentUser: async () => null,
}));

import {
  addFromLibrary,
  addLocationFromLibrary,
  createStandaloneCharacter,
  createStandaloneLocation,
} from "../library-actions";
import { loadLibrary, loadLocationLibrary } from "../character-library";

let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  globalThis.__prismMemoryRepo = repo;
  world.redirects = [];
});
afterEach(() => vi.clearAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("a character made on its own", () => {
  it("takes its name from the description when none is typed", () => {
    expect(nameFromPrompt("A sharp detective named Aiko Mori, early 30s.")).toBe("Aiko Mori");
    expect(nameFromPrompt("an old fisherman called Gen who never smiles")).toBe("Gen");
    expect(nameFromPrompt("Name: Aria. A pilot.")).toBe("Aria");
    expect(nameFromPrompt("A quiet librarian with silver hair.")).toBe("A quiet librarian with");
    expect(nameFromPrompt("   ")).toBe("New character");
  });

  it("is created in the account's characters project, in the library, and opened", async () => {
    expect(await createStandaloneCharacter(form({ prompt: " " }))).toMatchObject({
      ok: false,
      error: "Describe your character first.",
    });
    const prompt = "A sharp detective named Aiko Mori, early 30s, short black bob, long charcoal coat.";
    expect(await createStandaloneCharacter(form({ prompt }))).toEqual({ ok: true });
    const studio = (await repo.listProjects()).filter((p) => p.purpose === "library");
    expect(studio).toHaveLength(1);
    expect(studio[0]).toMatchObject({ title: "Your library", slug: "your-library" });
    const data = (await repo.loadProject(studio[0]!.slug))!;
    expect(data.episodes).toEqual([]);
    const aiko = data.characters.find((c) => c.name === "Aiko Mori")!;
    expect(aiko).toMatchObject({ description: prompt, physicalDescription: prompt });
    expect(world.redirects.at(-1)).toBe(`/projects/your-library/characters/${aiko.id}`);
    expect((await loadLibrary()).characters).toEqual([
      expect.objectContaining({ name: "Aiko Mori", projectTitle: "Your library" }),
    ]);

    // a second one goes into the same project; a typed name wins
    expect(await createStandaloneCharacter(form({ prompt: "A tall courier.", name: "Ren" }))).toEqual({
      ok: true,
    });
    expect((await repo.listProjects()).filter((p) => p.purpose === "library")).toHaveLength(1);
    expect((await loadLibrary()).characters.map((c) => c.name).sort()).toEqual(["Aiko Mori", "Ren"]);
  });

  it("any project adds a copy of it", async () => {
    await createStandaloneCharacter(form({ prompt: "A courier named Ren with a scar over one eye." }));
    const ren = (await loadLibrary()).characters.find((c) => c.name === "Ren")!;
    expect(
      await addFromLibrary(form({ projectSlug: "ojousama", characterId: ren.characterId })),
    ).toMatchObject({
      ok: true,
      message: "Ren added.",
    });
    const copy = (await repo.loadProject("ojousama"))!.characters.find((c) => c.name === "Ren")!;
    expect(copy.id).not.toBe(ren.characterId);
    expect(copy.physicalDescription).toBe("A courier named Ren with a scar over one eye.");
  });
});

describe("a location made on its own", () => {
  it("takes its name from the description when none is typed", () => {
    expect(locationNameFromPrompt("A rain-soaked alley in Shinjuku at night, neon everywhere.")).toBe(
      "Rain-soaked alley in Shinjuku at",
    );
    expect(locationNameFromPrompt("A ballroom called The Gilded Hall, chandeliers.")).toBe("The Gilded Hall");
    expect(locationNameFromPrompt("Name: Harbor Market. Fish stalls.")).toBe("Harbor Market");
    expect(locationNameFromPrompt("  ")).toBe("New location");
  });

  it("goes into the same library project as characters, is saved, and any project adds a copy", async () => {
    expect(await createStandaloneLocation(form({ prompt: "" }))).toMatchObject({
      ok: false,
      error: "Describe your location first.",
    });
    await createStandaloneCharacter(form({ prompt: "A courier named Ren." }));
    const prompt = "A ballroom called The Gilded Hall, crystal chandeliers, marble floor.";
    expect(await createStandaloneLocation(form({ prompt }))).toEqual({ ok: true });
    const studio = (await repo.listProjects()).filter((p) => p.purpose === "library");
    expect(studio).toHaveLength(1);
    const hall = (await repo.loadProject(studio[0]!.slug))!.locations.find(
      (l) => l.name === "The Gilded Hall",
    )!;
    expect(hall).toMatchObject({ description: prompt, locked: false });
    expect(world.redirects.at(-1)).toBe(`/projects/your-library/locations?open=${hall.id}`);
    const lib = await loadLocationLibrary();
    expect(lib.locations).toEqual([
      expect.objectContaining({ name: "The Gilded Hall", projectTitle: "Your library" }),
    ]);

    expect(
      await addLocationFromLibrary(form({ projectSlug: "ojousama", locationId: hall.id })),
    ).toMatchObject({
      ok: true,
      message: "The Gilded Hall added.",
    });
    const copy = (await repo.loadProject("ojousama"))!.locations.find((l) => l.description === prompt)!;
    expect(copy.id).not.toBe(hall.id);
  });
});
