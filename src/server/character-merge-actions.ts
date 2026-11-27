"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { planCharacterMerge, type MergePrefer } from "@/domain/character-merge";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { saveCharacterWithSize } from "./part-size";
import { getRepo, requireProjectFresh } from "./repo";
import { needsMigration0064, setSubjectTrashed } from "./trash";

/**
 * "Merge into…" on a Character's page (src/domain/character-merge.ts): the Character is merged into the one chosen,
 * which is kept (its place in the story is untouched); the merged one then goes to the Trash. The plan is worked out
 * again here from the project as it is now; the browser only names the two Characters, the name and which side wins.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function mergeCharacter_impl(form: FormData) {
  await requireUser();
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const mergedId = str(form, "characterId");
  const keptId = str(form, "intoCharacterId");
  const prefer: MergePrefer = str(form, "prefer") === "kept" ? "kept" : "merged";
  const result = planCharacterMerge(data, mergedId, keptId, { name: str(form, "name"), prefer });
  if (!result.ok) throw new UserFacingError(result.reason);
  const { plan } = result;
  const repo = await getRepo();
  const refs = new Map(data.identityRefs.map((r) => [r.id, r]));
  // the pictures first (pointers only), then the Looks and voices, then the sheet; the merged one goes to the Trash last
  for (const sw of plan.refSwaps) {
    const k = refs.get(sw.keptRefId)!;
    const m = refs.get(sw.mergedRefId)!;
    const contents = (r: typeof k) => ({ assetId: r.assetId, label: r.label, metadata: r.metadata });
    await repo.upsert(data.project.id, "identityRefs", { ...k, ...contents(m) });
    await repo.upsert(data.project.id, "identityRefs", { ...m, ...contents(k) });
  }
  for (const m of plan.refMoves)
    await repo.upsert(data.project.id, "identityRefs", {
      ...refs.get(m.refId)!,
      characterId: m.toCharacterId,
    });
  for (const l of data.looks.filter((x) => plan.lookIds.includes(x.id)))
    await repo.upsert(data.project.id, "looks", { ...l, characterId: keptId });
  for (const v of data.voiceProfiles.filter((x) => plan.voiceIds.includes(x.id)))
    await repo.upsert(data.project.id, "voiceProfiles", { ...v, characterId: keptId });
  await saveCharacterWithSize(data.project.id, { ...plan.character, updatedAt: new Date().toISOString() });
  try {
    await setSubjectTrashed(data, "character", mergedId, new Date().toISOString(), { mergedIntoId: keptId });
  } catch (err) {
    if (needsMigration0064(err))
      throw new UserFacingError(
        "The merge is done, but the merged actor could not go to the Trash: that needs a one-time database update (migration 0064).",
      );
    throw err;
  }
  revalidatePath(`/projects/${slug}`, "layout");
  redirect(`/projects/${slug}/characters/${keptId}?merged=1`);
}

export async function mergeCharacter(form: FormData): Promise<ActionResult> {
  return runAction(() => mergeCharacter_impl(form), { name: "mergeCharacter" });
}
