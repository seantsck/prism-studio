import "server-only";
import { randomUUID } from "node:crypto";
import type { WritingProposal } from "@/data/writing-repository";
import { characterAiFields, parseCharacterIdeas } from "@/domain/character-ai";
import { LOCATION_AI_FIELDS, locationAsText, namedLines, parseLocationIdeas } from "@/domain/location-ai";
import {
  characterSchema,
  locationSchema,
  type Character,
  type Location,
  type ProjectData,
} from "@/domain/schemas";
import { getRepo } from "./repo";
import { getWritingRepo } from "./story";

/**
 * When Prism's answer to "Fill in with Prism" arrives, the fields the creator left EMPTY are filled in at once: asking
 * for it was the creator's go-ahead, and nothing they wrote is touched. Fields they wrote stay as written; Prism's
 * version of those stays in the review, to take or leave. When nothing is left to review, the draft is done.
 *
 * Runs once per draft: a Character only while it has not been edited since the request (so a field the creator empties
 * afterwards is not filled again); a Location keeps no edit time, so its draft is closed as soon as nothing is left to
 * review, and until then only fields that are still empty are written.
 */

const isEmpty = (v: unknown) => (Array.isArray(v) ? v.length === 0 : !String(v ?? "").trim());

const done = async (data: ProjectData, proposal: WritingProposal) =>
  (await getWritingRepo()).rejectProposal(data.project.id, proposal.id, new Date().toISOString());

/** Returns the Character as it is after filling (the same object when nothing changed). */
export async function autoFillCharacter(
  data: ProjectData,
  character: Character,
  proposal: WritingProposal | null,
): Promise<{ character: Character; filled: string[]; proposalDone: boolean }> {
  const none = { character, filled: [], proposalDone: false };
  if (!proposal || proposal.status !== "ready" || !proposal.result) return none;
  const inStory = data.project.purpose !== "library";
  const proposed = parseCharacterIdeas(proposal.result.ideas, inStory);
  const record = character as unknown as Record<string, unknown>;
  const fields = characterAiFields(inStory).filter((f) => proposed[f.key] !== undefined);
  const fill = character.updatedAt <= proposal.createdAt ? fields.filter((f) => isEmpty(record[f.key])) : [];
  let next = character;
  if (fill.length) {
    // always after the request, even within the same millisecond, so this draft never fills the sheet twice
    const after = Math.max(Date.now(), Date.parse(proposal.createdAt) + 1);
    const changed: Record<string, unknown> = { ...character, updatedAt: new Date(after).toISOString() };
    for (const f of fill) changed[f.key] = proposed[f.key];
    next = characterSchema.parse(changed);
    await (await getRepo()).upsert(data.project.id, "characters", next);
  }
  // anything left to review: a field the creator wrote that Prism words differently
  const after = next as unknown as Record<string, unknown>;
  const left = fields.some((f) => {
    const mine = after[f.key];
    const theirs = proposed[f.key];
    return (
      (Array.isArray(mine) ? mine.join("\n") : String(mine ?? "")).trim() !==
      (Array.isArray(theirs) ? theirs.join("\n") : String(theirs ?? "")).trim()
    );
  });
  if (!left) await done(data, proposal);
  return { character: next, filled: fill.map((f) => f.label), proposalDone: !left };
}

/** Returns the Location as it is after filling (the same object when nothing changed). */
export async function autoFillLocation(
  data: ProjectData,
  location: Location,
  proposal: WritingProposal | null,
): Promise<{ location: Location; filled: string[]; proposalDone: boolean }> {
  const none = { location, filled: [], proposalDone: false };
  if (!proposal || proposal.status !== "ready" || !proposal.result || location.locked) return none;
  const proposed = parseLocationIdeas(proposal.result.ideas);
  const fields = LOCATION_AI_FIELDS.filter((f) => proposed[f.key] !== undefined);
  const record = location as unknown as Record<string, unknown>;
  const fill = fields.filter((f) => isEmpty(record[f.key]));
  let next = location;
  if (fill.length) {
    const changed: Record<string, unknown> = { ...location };
    for (const f of fill) {
      const text = proposed[f.key]!;
      if (f.key === "zones" || f.key === "entrances")
        changed[f.key] = namedLines(text).map((x, i) => ({
          id: `${f.key === "zones" ? "z" : "e"}-${i}-${randomUUID().slice(0, 6)}`,
          ...x,
        }));
      else if (f.key === "recurringProps") changed[f.key] = text.split("\n").filter(Boolean);
      else changed[f.key] = text;
    }
    next = locationSchema.parse(changed);
    await (await getRepo()).upsert(data.project.id, "locations", next);
  }
  // left to review: a field the creator wrote that Prism words differently
  const mine = locationAsText(location);
  const left = fields.some((f) => !fill.includes(f) && mine[f.key].trim() !== proposed[f.key]!.trim());
  if (!left) await done(data, proposal);
  return { location: next, filled: fill.map((f) => f.label), proposalDone: !left };
}
