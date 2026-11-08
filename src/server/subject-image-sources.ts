import "server-only";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { ProjectData } from "@/domain/schemas";
import { getGenerationRepo } from "./generation";

/**
 * The images a Character / Location may use as a source (edit, background removal, Visual Bible designation): its
 * reference images, its Look images and its own generated images, limited to stored images of THIS project.
 * A plain server module (not "use server"), so it is never exposed as a callable action.
 */
export async function subjectImageAssetIds(
  data: ProjectData,
  subject: { kind: "character"; characterId: string } | { kind: "location"; locationId: string },
): Promise<Set<string>> {
  const ids: Array<string | null> = [];
  if (subject.kind === "character") {
    ids.push(...data.identityRefs.filter((r) => r.characterId === subject.characterId).map((r) => r.assetId));
    for (const l of data.looks.filter((x) => x.characterId === subject.characterId))
      ids.push(...l.referenceAssetIds);
  } else {
    ids.push(...(data.locations.find((l) => l.id === subject.locationId)?.referenceAssetIds ?? []));
  }
  const views = await (await getGenerationRepo()).listSubjectImageAttempts(subject);
  for (const v of views) for (const o of v.outputs) ids.push(o.asset.id);
  return new Set(
    ids.filter((id): id is string => !!id && hasStoredImage(data.assets.find((a) => a.id === id))),
  );
}
