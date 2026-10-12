import type { CharacterLook, Shot, ShotCharacter } from "./schemas";

export type LookLinkError =
  | { code: "look_not_found"; message: string }
  | { code: "look_character_mismatch"; message: string }
  | { code: "look_episode_mismatch"; message: string };

/** A Look must exist, belong to the assigned character, and (if episode-scoped) to the shot's episode. */
export function validateLookLink(
  assignment: Pick<ShotCharacter, "characterId" | "lookId">,
  looks: readonly CharacterLook[],
  episodeId: string,
): LookLinkError | null {
  if (!assignment.lookId) return null;
  const look = looks.find((l) => l.id === assignment.lookId);
  if (!look) return { code: "look_not_found", message: `Look ${assignment.lookId} does not exist` };
  if (look.characterId !== assignment.characterId) {
    return {
      code: "look_character_mismatch",
      message: `Look "${look.name}" belongs to a different character`,
    };
  }
  if (look.episodeId && look.episodeId !== episodeId) {
    return { code: "look_episode_mismatch", message: `Look "${look.name}" is scoped to another episode` };
  }
  return null;
}

/** Link a Look to a character assignment in a shot. Shots reference the Look id; they never copy wardrobe text. */
export function assignLook(
  shot: Shot,
  characterId: string,
  lookId: string | null,
  looks: readonly CharacterLook[],
): Shot {
  const assignment = shot.characters.find((c) => c.characterId === characterId);
  if (!assignment) throw new Error(`Character ${characterId} is not assigned to shot ${shot.shotCode}`);
  const error = validateLookLink({ characterId, lookId }, looks, shot.episodeId);
  if (error) throw new Error(error.message);
  return {
    ...shot,
    characters: shot.characters.map((c) => (c.characterId === characterId ? { ...c, lookId } : c)),
  };
}
