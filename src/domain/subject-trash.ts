import type { ProjectData } from "./schemas";

/**
 * Characters and Locations in the Trash (migration 0064). A deleted one keeps its row and everything attached to it
 * (references, Looks, voices, views, locks, generation history) with `trashedAt` set; the server loaders set it apart,
 * so every view behaves as if it were gone, and Restore clears the stamp. It can go to the Trash only when nothing in
 * the story uses it (a Shot, a Scene, a line of dialogue, a take), so nothing ever points at something hidden.
 */

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Where the story still uses this Character: one line per kind ("2 Shots: 1A, 4B"). Empty = free to delete. */
export function characterUsage(data: ProjectData, characterId: string): string[] {
  const out: string[] = [];
  const shots = data.shots.filter((s) => s.characters.some((c) => c.characterId === characterId));
  if (shots.length)
    out.push(
      `${n(shots.length, "Shot")}: ${shots
        .slice(0, 4)
        .map((s) => s.shotCode)
        .join(", ")}${shots.length > 4 ? "…" : ""}`,
    );
  const scenes = data.scenes.filter((s) => s.characterIds.includes(characterId));
  if (scenes.length)
    out.push(
      `${n(scenes.length, "Scene")}: ${scenes
        .slice(0, 4)
        .map((s) => s.sceneNumber)
        .join(", ")}${scenes.length > 4 ? "…" : ""}`,
    );
  const lines = data.dialogueLines.filter((l) => l.characterId === characterId).length;
  if (lines) out.push(n(lines, "line of dialogue", "lines of dialogue"));
  const takes = data.takes.filter((t) => t.characterId === characterId).length;
  if (takes) out.push(n(takes, "performance take"));
  return out;
}

/** Where the story still uses this Location: Scenes set there, and Shots on its set. Empty = free to delete. */
export function locationUsage(data: ProjectData, locationId: string): string[] {
  const out: string[] = [];
  const scenes = data.scenes.filter((s) => s.locationId === locationId);
  if (scenes.length)
    out.push(
      `${n(scenes.length, "Scene")}: ${scenes
        .slice(0, 4)
        .map((s) => s.sceneNumber)
        .join(", ")}${scenes.length > 4 ? "…" : ""}`,
    );
  const shots = data.shots.filter((s) => s.spatial.locationId === locationId);
  if (shots.length)
    out.push(
      `${n(shots.length, "Shot")}: ${shots
        .slice(0, 4)
        .map((s) => s.shotCode)
        .join(", ")}${shots.length > 4 ? "…" : ""}`,
    );
  return out;
}

/** The refusal shown when it is still used: what to change first. */
export const inUseRefusal = (name: string, usage: string[]) =>
  `${name} can't be deleted yet: it is still used in ${usage.join("; ")}. Take ${
    usage.length === 1 && /^1 /.test(usage[0]!) ? "it" : "them"
  } out first.`;

/** Sets trashed Characters and Locations apart (and what hangs off a trashed Character), so no view shows them. */
export function setTrashedSubjectsApart(data: ProjectData): ProjectData {
  const goneC = data.characters.filter((c) => c.trashedAt);
  const goneL = data.locations.filter((l) => l.trashedAt);
  if (!goneC.length && !goneL.length) return data;
  const gone = new Set(goneC.map((c) => c.id));
  return {
    ...data,
    characters: data.characters.filter((c) => !c.trashedAt),
    identityRefs: data.identityRefs.filter((r) => !gone.has(r.characterId)),
    looks: data.looks.filter((l) => !gone.has(l.characterId)),
    voiceProfiles: data.voiceProfiles.filter((v) => !gone.has(v.characterId)),
    locations: data.locations.filter((l) => !l.trashedAt),
    trashedCharacters: goneC,
    trashedLocations: goneL,
  };
}
