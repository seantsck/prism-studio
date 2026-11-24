import "server-only";
import { randomUUID } from "node:crypto";
import { planCharacterCopy, type CharacterCopyPlan } from "@/domain/character-library";
import { planLocationCopy, type LocationCopyPlan } from "@/domain/location-library";
import type { Asset, ProjectData } from "@/domain/schemas";
import { canonicalRefOf } from "@/domain/visual-bible";
import { buildObjectPath } from "@/lib/storage-paths";
import { assetUrl } from "@/lib/utils";
import { CharacterLibraryUnavailableError } from "@/data/repository";
import { UserFacingError } from "./action-result";
import { getRepo } from "./repo";
import { checksum, getUploadStorage, storageForAsset } from "./storage";

/** One Character in the library, as the library panel shows it. */
export interface LibraryCharacter {
  characterId: string;
  name: string;
  role: string;
  description: string;
  projectId: string;
  projectSlug: string;
  projectTitle: string;
  thumbUrl: string | null;
  /** Pictures that travel with it (identity references, Look pictures, voice samples). */
  pictures: number;
  looks: number;
  savedAt: string;
}

/** The owner's library (`available: false` until migration 0062 is applied). */
export async function loadLibrary(): Promise<{ characters: LibraryCharacter[]; available: boolean }> {
  const repo = await getRepo();
  const { entries, available } = await repo.libraryEntries();
  if (!entries.length) return { characters: [], available };
  const slugs = new Map((await repo.listProjects()).map((p) => [p.id, p.slug]));
  const loaded = new Map<string, ProjectData | null>();
  const characters: LibraryCharacter[] = [];
  for (const e of entries) {
    const slug = slugs.get(e.projectId);
    if (!slug) continue;
    if (!loaded.has(e.projectId)) loaded.set(e.projectId, await repo.loadProject(slug));
    const data = loaded.get(e.projectId);
    const c = data?.characters.find((x) => x.id === e.characterId);
    if (!data || !c || c.trashedAt) continue; // a Character in the Trash is out of the library until restored
    const plan = planCharacterCopy(data, c.id, data, randomUUID, e.savedAt);
    const canonical = canonicalRefOf(data, c.id);
    const thumb =
      data.assets.find((a) => a.id === canonical?.assetId) ??
      data.assets.find(
        (a) => a.id === data.identityRefs.find((r) => r.characterId === c.id && r.assetId)?.assetId,
      );
    characters.push({
      characterId: c.id,
      name: c.name,
      role: c.role,
      description: c.description || c.physicalDescription,
      projectId: data.project.id,
      projectSlug: slug,
      projectTitle: data.project.title,
      thumbUrl: assetUrl(thumb),
      pictures: plan.assets.filter((a) => a.from.objectPath).length,
      looks: plan.looks.length,
      savedAt: e.savedAt,
    });
  }
  return { characters, available };
}

/** Copies pictures' bytes into the target project's own storage and returns the new asset rows (and what to undo). */
async function copyPictures(
  target: ProjectData,
  pairs: ReadonlyArray<{ from: Asset; to: Asset }>,
  userId: string | null,
  who: string,
  written: string[],
): Promise<Asset[]> {
  const storage = await getUploadStorage();
  const out: Asset[] = [];
  for (const { from, to } of pairs) {
    if (!from.objectPath) {
      out.push({ ...to, createdBy: userId });
      continue;
    }
    const bytes = await (await storageForAsset(from))?.get(from.objectPath);
    if (!bytes) throw new UserFacingError(`A picture of ${who} could not be read to copy.`);
    const objectPath = buildObjectPath(
      target.project.id,
      to.id,
      from.originalFilename || from.name || "file",
    );
    await storage.put(objectPath, bytes, from.mime ?? "application/octet-stream");
    written.push(objectPath);
    out.push({
      ...to,
      createdBy: userId,
      storageProvider: storage.name,
      bucket: storage.bucket,
      objectPath,
      byteSize: bytes.length,
      checksum: checksum(bytes),
    });
  }
  return out;
}

/**
 * Copies a library Character into `target`: the pictures' bytes into the target's own storage, then the records. If
 * anything fails part-way, what was already written is removed again, so a failed copy leaves nothing behind.
 */
export async function copyIntoProject(
  target: ProjectData,
  source: ProjectData,
  characterId: string,
  /** The signed-in creator (null in memory mode). */
  userId: string | null,
): Promise<CharacterCopyPlan> {
  const now = new Date().toISOString();
  const plan = planCharacterCopy(source, characterId, target, randomUUID, now);
  const repo = await getRepo();
  const storage = await getUploadStorage();
  const paths: string[] = [];
  const written = { assets: [] as string[], character: false };
  try {
    const assets = await copyPictures(target, plan.assets, userId, plan.character.name, paths);
    if (assets.length) await repo.upsertMany(target.project.id, "assets", assets);
    written.assets = assets.map((a) => a.id);
    await repo.upsert(target.project.id, "characters", plan.character);
    written.character = true;
    if (plan.identityRefs.length) await repo.upsertMany(target.project.id, "identityRefs", plan.identityRefs);
    if (plan.looks.length) await repo.upsertMany(target.project.id, "looks", plan.looks);
    if (plan.voiceProfiles.length)
      await repo.upsertMany(target.project.id, "voiceProfiles", plan.voiceProfiles);
    return plan;
  } catch (err) {
    // undo, newest first: voices, Looks, references, the Character, the asset rows, the stored bytes
    const drop = async (name: "voiceProfiles" | "looks" | "identityRefs", ids: string[]) => {
      for (const id of ids) await repo.remove(target.project.id, name, id).catch(() => undefined);
    };
    if (written.character) {
      await drop(
        "voiceProfiles",
        plan.voiceProfiles.map((v) => v.id),
      );
      await drop(
        "looks",
        plan.looks.map((l) => l.id),
      );
      await drop(
        "identityRefs",
        plan.identityRefs.map((r) => r.id),
      );
      await repo.remove(target.project.id, "characters", plan.character.id).catch(() => undefined);
    }
    for (const id of written.assets)
      await repo.remove(target.project.id, "assets", id).catch(() => undefined);
    for (const p of paths) await storage.remove(p).catch(() => undefined);
    throw err;
  }
}

/** Copies a library Location into `target` the same way (pictures first; undone on failure). */
export async function copyLocationIntoProject(
  target: ProjectData,
  source: ProjectData,
  locationId: string,
  userId: string | null,
): Promise<LocationCopyPlan> {
  const plan = planLocationCopy(source, locationId, target, randomUUID, new Date().toISOString());
  const repo = await getRepo();
  const storage = await getUploadStorage();
  const paths: string[] = [];
  let assetIds: string[] = [];
  try {
    const assets = await copyPictures(target, plan.assets, userId, plan.location.name, paths);
    if (assets.length) await repo.upsertMany(target.project.id, "assets", assets);
    assetIds = assets.map((a) => a.id);
    await repo.upsert(target.project.id, "locations", plan.location);
    return plan;
  } catch (err) {
    await repo.remove(target.project.id, "locations", plan.location.id).catch(() => undefined);
    for (const id of assetIds) await repo.remove(target.project.id, "assets", id).catch(() => undefined);
    for (const p of paths) await storage.remove(p).catch(() => undefined);
    throw err;
  }
}

/** One Location in the library, as the library panels show it. */
export interface LibraryLocation {
  locationId: string;
  name: string;
  description: string;
  projectId: string;
  projectSlug: string;
  projectTitle: string;
  thumbUrl: string | null;
  pictures: number;
  savedAt: string;
}

/** The owner's location library (`available: false` until migration 0066 is applied). */
export async function loadLocationLibrary(): Promise<{ locations: LibraryLocation[]; available: boolean }> {
  const repo = await getRepo();
  const { entries, available } = await repo.locationLibraryEntries();
  if (!entries.length) return { locations: [], available };
  const slugs = new Map((await repo.listProjects()).map((p) => [p.id, p.slug]));
  const loaded = new Map<string, ProjectData | null>();
  const locations: LibraryLocation[] = [];
  for (const e of entries) {
    const slug = slugs.get(e.projectId);
    if (!slug) continue;
    if (!loaded.has(e.projectId)) loaded.set(e.projectId, await repo.loadProject(slug));
    const data = loaded.get(e.projectId);
    const l = data?.locations.find((x) => x.id === e.locationId);
    if (!data || !l || l.trashedAt) continue;
    const plan = planLocationCopy(data, l.id, data, randomUUID, e.savedAt);
    const thumbId = l.visualBible?.canonicalAssetId ?? l.referenceAssetIds[0] ?? null;
    locations.push({
      locationId: l.id,
      name: l.name,
      description: l.description,
      projectId: data.project.id,
      projectSlug: slug,
      projectTitle: data.project.title,
      thumbUrl: assetUrl(data.assets.find((a) => a.id === thumbId)),
      pictures: plan.assets.filter((a) => a.from.objectPath).length,
      savedAt: e.savedAt,
    });
  }
  return { locations, available };
}

/**
 * Copies library Characters and Locations into a project just made from the home page ("Start a new project with
 * …"). Only entries actually in the owner's library are copied; one that fails is skipped (its copy undoes itself) so
 * the new project still opens. Returns the names copied, in order.
 */
export async function copyLibraryIntoNewProject(
  targetSlug: string,
  characterIds: string[],
  locationIds: string[],
  userId: string | null,
): Promise<{ characters: string[]; locations: string[] }> {
  const out = { characters: [] as string[], locations: [] as string[] };
  if (!characterIds.length && !locationIds.length) return out;
  const repo = await getRepo();
  const slugs = new Map((await repo.listProjects()).map((p) => [p.id, p.slug]));
  const sources = new Map<string, ProjectData | null>();
  const source = async (projectId: string) => {
    if (!sources.has(projectId)) {
      const slug = slugs.get(projectId);
      sources.set(projectId, slug ? await repo.loadProject(slug) : null);
    }
    return sources.get(projectId) ?? null;
  };
  const characters = characterIds.length ? (await repo.libraryEntries()).entries : [];
  for (const id of characterIds) {
    const entry = characters.find((e) => e.characterId === id);
    const from = entry ? await source(entry.projectId) : null;
    const target = await repo.loadProject(targetSlug);
    if (!from || !target) continue;
    try {
      out.characters.push((await copyIntoProject(target, from, id, userId)).character.name);
    } catch (err) {
      console.error("[library] could not copy a character into a new project", err);
    }
  }
  const locations = locationIds.length ? (await repo.locationLibraryEntries()).entries : [];
  for (const id of locationIds) {
    const entry = locations.find((e) => e.locationId === id);
    const from = entry ? await source(entry.projectId) : null;
    const target = await repo.loadProject(targetSlug);
    if (!from || !target) continue;
    try {
      out.locations.push((await copyLocationIntoProject(target, from, id, userId)).location.name);
    } catch (err) {
      console.error("[library] could not copy a location into a new project", err);
    }
  }
  return out;
}

/**
 * Every Character the creator makes goes into their library (the owner's choice, 2026-11-24), wherever it is made: a
 * new Character in a project, or the cast a story import creates. A copy of a library Character added to a project is
 * not saved again (the library already has it). Best effort: without the library table (migration 0062) the Character
 * is still made, just not saved.
 */
export async function keepInLibrary(projectId: string, characterIds: readonly string[]): Promise<void> {
  const repo = await getRepo();
  for (const id of characterIds) {
    try {
      await repo.setInLibrary(projectId, id, true);
    } catch (err) {
      if (err instanceof CharacterLibraryUnavailableError) return;
      throw err;
    }
  }
}
