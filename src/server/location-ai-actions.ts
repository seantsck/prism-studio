"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  LOCATION_AI_FIELDS,
  isLocationRequest,
  locationAsText,
  locationFieldText,
  locationFillInstruction,
  namedLines,
  parseLocationIdeas,
  type LocationAiKey,
} from "@/domain/location-ai";
import { emptyEpisodeOne, REFINE_NOTE_MAX } from "@/domain/series-start";
import { locationSchema, type Location, type ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { quoteLocationFill } from "./series-start";
import { getWritingRepo } from "./story";
import { askPrism } from "./writing-actions";

/**
 * Fill in a Location's sheet with Prism, then review it field by field (src/domain/location-ai.ts). Priced before it
 * runs; nothing on the Location changes until the creator applies the fields they tick. A locked Location is not
 * changed.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function load(form: FormData): Promise<{ slug: string; data: ProjectData; location: Location }> {
  const slug = str(form, "projectSlug");
  let data = await requireProjectFresh(slug);
  if (data.episodes.length === 0) {
    // Prism's requests are kept with Episode 1; the library never shows it
    await (
      await getRepo()
    ).upsert(data.project.id, "episodes", emptyEpisodeOne(data.project.id, new Date().toISOString()));
    data = await requireProjectFresh(slug);
  }
  const location = data.locations.find((l) => l.id === str(form, "locationId"));
  if (!location) throw new UserFacingError("That location is not in this project.");
  return { slug, data, location };
}

async function queue(
  data: ProjectData,
  slug: string,
  location: Location,
  sheet: Record<LocationAiKey, string>,
  opts: { note?: string; revise?: boolean },
  form: FormData,
) {
  const q = quoteLocationFill(data, location.id, str(form, "model"), { refine: opts.revise });
  if (!q.ok) throw new UserFacingError(q.reason);
  if (q.paid) {
    const c = Number(str(form, "confirmedTotalUsd"));
    if (!str(form, "confirmedTotalUsd") || !Number.isFinite(c) || c + 1e-9 < q.usd)
      throw new UserFacingError("The price changed. Reload the page to see it, then try again.");
  }
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
  const fields: Record<string, string> = {
    projectSlug: slug,
    episodeId: first.id,
    preset: "brainstorm",
    scopeKind: "episode",
    instruction: locationFillInstruction(data, location, sheet, opts),
    model: q.model,
    noRedirect: "1",
    ...(data.project.purpose !== "library" ? { withBible: "1" } : {}),
    ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
  };
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  const r = await askPrism(f);
  if (!r.ok) throw new UserFacingError(r.error);
  revalidatePath(`/projects/${slug}`, "layout");
}

async function fillLocation_impl(form: FormData) {
  const { slug, data, location } = await load(form);
  if (location.locked) throw new UserFacingError(`${location.name} is locked. Unlock it to fill it in.`);
  const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
  await queue(data, slug, location, locationAsText(location), { note }, form);
  return { ok: true as const, message: `Prism is filling in ${location.name}…` };
}

async function reviewLocationFill_impl(form: FormData) {
  const { slug, data, location } = await load(form);
  const writing = await getWritingRepo();
  const proposal = await writing.getProposal(data.project.id, str(form, "proposalId"));
  if (
    !proposal ||
    !isLocationRequest(proposal.instruction, location.id) ||
    proposal.status !== "ready" ||
    !proposal.result
  )
    throw new UserFacingError("That draft is not ready.");
  const proposed = parseLocationIdeas(proposal.result.ideas);
  const shown = LOCATION_AI_FIELDS.filter((f) => proposed[f.key] !== undefined && form.has(`text_${f.key}`));
  const edited = Object.fromEntries(
    shown.map((f) => [f.key, locationFieldText(f.key, String(form.get(`text_${f.key}`) ?? ""))]),
  ) as Partial<Record<LocationAiKey, string>>;
  const intent = str(form, "intent") || "apply";
  const done = () => writing.rejectProposal(data.project.id, proposal.id, new Date().toISOString());

  if (intent === "discard") {
    await done();
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true as const, message: "Draft discarded." };
  }
  if (intent === "refine") {
    const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
    if (!note) throw new UserFacingError("Tell Prism what to change in the draft.");
    await queue(
      data,
      slug,
      location,
      { ...locationAsText(location), ...edited },
      { note, revise: true },
      form,
    );
    return { ok: true as const, message: "Prism is revising the draft…" };
  }

  if (location.locked) throw new UserFacingError(`${location.name} is locked. Unlock it to change it.`);
  const chosen = shown.filter((f) => str(form, `use_${f.key}`) === "1");
  if (chosen.length === 0) throw new UserFacingError("Tick the fields you want to use.");
  const next: Record<string, unknown> = { ...location };
  for (const f of chosen) {
    const text = edited[f.key] ?? "";
    if (f.key === "zones" || f.key === "entrances")
      next[f.key] = namedLines(text).map((x, i) => ({
        id: `${f.key === "zones" ? "z" : "e"}-${i}-${randomUUID().slice(0, 6)}`,
        ...x,
      }));
    else if (f.key === "recurringProps") next[f.key] = text.split("\n").filter(Boolean);
    else next[f.key] = text;
  }
  await (await getRepo()).upsert(data.project.id, "locations", locationSchema.parse(next));
  // applied: the draft is done with (a Location keeps no edit time to compare it with)
  await done();
  revalidatePath(`/projects/${slug}`, "layout");
  return {
    ok: true as const,
    message: `${chosen.length} field${chosen.length === 1 ? "" : "s"} applied to ${location.name}.`,
  };
}

export async function fillLocation(form: FormData): Promise<ActionResult> {
  return runAction(() => fillLocation_impl(form), { name: "fillLocation" });
}

export async function reviewLocationFill(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewLocationFill_impl(form), { name: "reviewLocationFill" });
}
