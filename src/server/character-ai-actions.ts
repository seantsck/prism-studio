"use server";

import { revalidatePath } from "next/cache";
import {
  partSizeOf,
  characterAiFields,
  characterFieldValue,
  characterFillInstruction,
  isCharacterRequest,
  parseCharacterIdeas,
} from "@/domain/character-ai";
import { emptyEpisodeOne, REFINE_NOTE_MAX } from "@/domain/series-start";
import { characterSchema, type Character, type PartSize, type ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { quoteCharacterFill } from "./series-start";
import { getWritingRepo } from "./story";
import { askPrism } from "./writing-actions";
import { NEEDS_0067, partSizeFrom, saveCharacterWithSize } from "./part-size";

/**
 * Fill in a Character's sheet with Prism, then review it field by field (src/domain/character-ai.ts). Each request
 * names its price before it runs and refuses unless the creator confirmed at least that amount; nothing on the
 * Character changes until the creator applies the fields they tick.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function confirmed(form: FormData, usd: number, paid: boolean) {
  if (!paid) return;
  const c = Number(str(form, "confirmedTotalUsd"));
  if (!str(form, "confirmedTotalUsd") || !Number.isFinite(c) || c + 1e-9 < usd)
    throw new UserFacingError("The price changed. Reload the page to see it, then try again.");
}

/** The project and the Character; a project with no Episode (the account's library) gets an empty Episode 1. */
async function load(form: FormData): Promise<{ slug: string; data: ProjectData; character: Character }> {
  const slug = str(form, "projectSlug");
  let data = await requireProjectFresh(slug);
  if (data.episodes.length === 0) {
    // Prism's requests are kept with Episode 1; the library never shows it
    await (
      await getRepo()
    ).upsert(data.project.id, "episodes", emptyEpisodeOne(data.project.id, new Date().toISOString()));
    data = await requireProjectFresh(slug);
  }
  const character = data.characters.find((c) => c.id === str(form, "characterId"));
  if (!character) throw new UserFacingError("That actor is not in this project.");
  return { slug, data, character };
}

async function queue(
  data: ProjectData,
  slug: string,
  character: Character,
  opts: { note?: string; revise?: boolean; edited?: boolean; size?: PartSize },
  form: FormData,
) {
  const q = quoteCharacterFill(data, character.id, str(form, "model"), {
    refine: opts.revise,
    size: opts.size,
  });
  if (!q.ok) throw new UserFacingError(q.reason);
  confirmed(form, q.usd, q.paid);
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
  const f = new FormData();
  const fields: Record<string, string> = {
    projectSlug: slug,
    episodeId: first.id,
    preset: "brainstorm",
    scopeKind: "episode",
    instruction: characterFillInstruction(data, character, opts),
    model: q.model,
    noRedirect: "1",
    ...(data.project.purpose !== "library" ? { withBible: "1" } : {}),
    ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
  };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  const r = await askPrism(f);
  if (!r.ok) throw new UserFacingError(r.error);
  revalidatePath(`/projects/${slug}`, "layout");
}

async function fillCharacter_impl(form: FormData) {
  const { slug, data, character } = await load(form);
  const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
  // the size of part chosen here is the Character's from now on (in this project)
  const size = partSizeFrom(form) ?? partSizeOf(character);
  let remembered = true;
  let current = character;
  if (partSizeFrom(form) && partSizeFrom(form) !== character.partSize) {
    current = characterSchema.parse({ ...character, partSize: size, updatedAt: new Date().toISOString() });
    ({ remembered } = await saveCharacterWithSize(data.project.id, current));
  }
  // "Refine with Prism" on a sheet the creator has written in: their edits lead
  const edited = str(form, "edited") === "1";
  await queue(data, slug, current, { note, size, edited }, form);
  return {
    ok: true as const,
    message: `Prism is ${edited ? "refining" : "filling in"} ${character.name}…${remembered ? "" : ` ${NEEDS_0067}`}`,
  };
}

async function reviewCharacterFill_impl(form: FormData) {
  const { slug, data, character } = await load(form);
  const writing = await getWritingRepo();
  const proposal = await writing.getProposal(data.project.id, str(form, "proposalId"));
  if (
    !proposal ||
    !isCharacterRequest(proposal.instruction, character.id) ||
    proposal.status !== "ready" ||
    !proposal.result
  )
    throw new UserFacingError("That draft is not ready.");
  const inStory = data.project.purpose !== "library";
  const proposed = parseCharacterIdeas(proposal.result.ideas, inStory);
  const shown = characterAiFields(inStory).filter(
    (f) => proposed[f.key] !== undefined && form.has(`text_${f.key}`),
  );
  const edited = Object.fromEntries(
    shown.map((f) => [f.key, characterFieldValue(f.key, String(form.get(`text_${f.key}`) ?? ""))]),
  );
  const intent = str(form, "intent") || "apply";

  if (intent === "discard") {
    await writing.rejectProposal(data.project.id, proposal.id, new Date().toISOString());
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true as const, message: "Draft discarded." };
  }
  if (intent === "refine") {
    const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
    if (!note) throw new UserFacingError("Tell Prism what to change in the draft.");
    // Prism revises the draft as it reads now, the creator's edits included
    await queue(
      data,
      slug,
      { ...character, ...edited } as Character,
      { note, revise: true, size: partSizeOf(character) },
      form,
    );
    return { ok: true as const, message: "Prism is revising the draft…" };
  }

  const chosen = shown.filter((f) => str(form, `use_${f.key}`) === "1");
  if (chosen.length === 0) throw new UserFacingError("Tick the fields you want to use.");
  const next: Record<string, unknown> = { ...character, updatedAt: new Date().toISOString() };
  for (const f of chosen) next[f.key] = edited[f.key];
  await (await getRepo()).upsert(data.project.id, "characters", characterSchema.parse(next));
  // applied: the draft is done with
  await writing.rejectProposal(data.project.id, proposal.id, new Date().toISOString());
  revalidatePath(`/projects/${slug}`, "layout");
  return {
    ok: true as const,
    message: `${chosen.length} field${chosen.length === 1 ? "" : "s"} applied to ${character.name}.`,
  };
}

export async function fillCharacter(form: FormData): Promise<ActionResult> {
  return runAction(() => fillCharacter_impl(form), { name: "fillCharacter" });
}

export async function reviewCharacterFill(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewCharacterFill_impl(form), { name: "reviewCharacterFill" });
}
