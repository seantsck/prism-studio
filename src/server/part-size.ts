import "server-only";
import { PART_SIZES, type Character, type PartSize } from "@/domain/schemas";
import { getRepo } from "./repo";

/** Postgres "undefined column": the part-size column is not there until migration 0067 is applied. */
const UNDEFINED_COLUMN = "42703";

export const NEEDS_0067 =
  "The size of part is not remembered yet: it needs a one-time database update (migration 0067).";

/** The size of part a form chose (or null: none chosen). */
export function partSizeFrom(form: FormData): PartSize | null {
  const v = String(form.get("partSize") ?? "").trim();
  return (PART_SIZES as readonly string[]).includes(v) ? (v as PartSize) : null;
}

/**
 * Saves a Character, its size of part included. Before migration 0067 the column is not there: the Character is saved
 * without it (everything else as asked) and `remembered` is false, so the caller can say so.
 */
export async function saveCharacterWithSize(
  projectId: string,
  character: Character,
): Promise<{ remembered: boolean }> {
  const repo = await getRepo();
  try {
    await repo.upsert(projectId, "characters", character);
    return { remembered: true };
  } catch (err) {
    if ((err as { code?: string }).code !== UNDEFINED_COLUMN || character.partSize === undefined) throw err;
    await repo.upsert(projectId, "characters", { ...character, partSize: undefined });
    return { remembered: false };
  }
}
