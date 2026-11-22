import "server-only";
import { randomUUID } from "node:crypto";
import { planCharacterCopy, type CharacterCopyPlan } from "@/domain/character-library";
import type { Asset, ProjectData } from "@/domain/schemas";
import { canonicalRefOf } from "@/domain/visual-bible";
import { buildObjectPath } from "@/lib/storage-paths";
import { assetUrl } from "@/lib/utils";
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
  const written: { paths: string[]; assets: string[]; character: boolean } = {
    paths: [],
    assets: [],
    character: false,
  };
  try {
    const assets: Asset[] = [];
    for (const { from, to } of plan.assets) {
      if (!from.objectPath) {
        assets.push({ ...to, createdBy: userId });
        continue;
      }
      const bytes = await (await storageForAsset(from))?.get(from.objectPath);
      if (!bytes) throw new UserFacingError(`A picture of ${plan.character.name} could not be read to copy.`);
      const objectPath = buildObjectPath(
        target.project.id,
        to.id,
        from.originalFilename || from.name || "file",
      );
      await storage.put(objectPath, bytes, from.mime ?? "application/octet-stream");
      written.paths.push(objectPath);
      assets.push({
        ...to,
        createdBy: userId,
        storageProvider: storage.name,
        bucket: storage.bucket,
        objectPath,
        byteSize: bytes.length,
        checksum: checksum(bytes),
      });
    }
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
    for (const p of written.paths) await storage.remove(p).catch(() => undefined);
    throw err;
  }
}
