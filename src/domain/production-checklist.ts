import { REFERENCE_SET_VIEWS, type ReferenceSetViewId } from "./generation/reference-studio";
import { hasStoredImage } from "./generation/subject-image";
import { referenceOrigin } from "./generation/reference-integrity";
import { locationBibleOf } from "./location-visual-bible";
import type { Asset, IdentityRef, ProjectData } from "./schemas";
import { visualRoleOf } from "./visual-bible";

/**
 * The Production checklist: for one Episode, what each person, outfit, place and Shot still needs before its frames
 * can be made, in the order it has to happen (people → outfits → places → Shots), each item with the screen that fixes
 * it. It reads only what exists; it decides nothing and changes nothing.
 */

/** Below this many of their own photos, a Character's views are guesses from too little. */
export const PHOTOS_WANTED = 4;

export type ChecklistArea = "people" | "outfits" | "places" | "shots";

export interface ChecklistStep {
  area: ChecklistArea;
  /** What is missing, in the creator's words. */
  title: string;
  detail: string;
  /** The screen that fixes it, already set up. */
  href: string;
  /** The button's words. */
  action: string;
}

export interface ChecklistPerson {
  characterId: string;
  name: string;
  photos: number;
  views: Array<{ id: ReferenceSetViewId; label: string; filled: boolean }>;
  /** Every reference image is locked. */
  locked: boolean;
  /** The set is complete (all views) and every outfit this Episode uses has its picture. */
  readyToApprove: boolean;
  looks: Array<{ lookId: string; name: string }>;
  studioHref: string;
  characterHref: string;
}

export interface ChecklistOutfit {
  lookId: string;
  characterId: string;
  characterName: string;
  name: string;
  hasPicture: boolean;
  locked: boolean;
}

export interface ChecklistPlace {
  locationId: string;
  name: string;
  hasPicture: boolean;
  studioHref: string;
}

export type ShotLight = "ready" | "partial" | "blocked";

export interface ChecklistShot {
  shotId: string;
  code: string;
  title: string;
  href: string;
  people: string[];
  light: ShotLight;
  /** What keeps the Shot from a good frame (empty when it is ready). */
  missing: string[];
  hasFrame: boolean;
}

export interface ProductionChecklist {
  episodeId: string;
  episodeTitle: string;
  steps: ChecklistStep[];
  people: ChecklistPerson[];
  outfits: ChecklistOutfit[];
  places: ChecklistPlace[];
  shots: ChecklistShot[];
}

const stored = (assets: Map<string, Asset>, id: string | null | undefined) =>
  !!id && hasStoredImage(assets.get(id));

/** Which views of a Character's reference set hold a stored image. */
export function referenceSetFill(
  refs: readonly IdentityRef[],
  assets: Map<string, Asset>,
): Map<ReferenceSetViewId, string | null> {
  const out = new Map<ReferenceSetViewId, string | null>();
  for (const v of REFERENCE_SET_VIEWS) {
    const slotRef =
      v.slot === "additional"
        ? refs.find((r) => r.slot === "additional" && (r.metadata as { view?: unknown }).view === v.id)
        : refs.find((r) => r.slot === v.slot && visualRoleOf(r) === null);
    const canonicalRef = v.canonical ? refs.find((r) => visualRoleOf(r) === "canonical") : undefined;
    const ref = [canonicalRef, slotRef].find((r) => stored(assets, r?.assetId));
    out.set(v.id, ref?.assetId ?? null);
  }
  return out;
}

export function productionChecklist(data: ProjectData, episodeId: string): ProductionChecklist | null {
  const episode = data.episodes.find((e) => e.id === episodeId);
  if (!episode) return null;
  const slug = data.project.slug;
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const studio = (subject: string, extra = "") => `/projects/${slug}/studio?subject=${subject}${extra}`;
  const sceneOrder = new Map(data.scenes.map((s) => [s.id, s.order]));
  const shots = data.shots
    .filter((s) => s.episodeId === episode.id)
    .sort(
      (a, b) =>
        (sceneOrder.get(a.sceneId) ?? 0) - (sceneOrder.get(b.sceneId) ?? 0) ||
        a.shotCode.localeCompare(b.shotCode, undefined, { numeric: true }),
    );
  const framed = new Set((data.productionFrameSelections ?? []).map((s) => s.shotId));

  // ── people ──
  const characterIds = [...new Set(shots.flatMap((s) => s.characters.map((c) => c.characterId)))];
  const people: ChecklistPerson[] = characterIds.flatMap((id) => {
    const c = data.characters.find((x) => x.id === id);
    if (!c) return [];
    const refs = data.identityRefs.filter((r) => r.characterId === id);
    const fill = referenceSetFill(refs, assets);
    const photos = refs.filter(
      (r) =>
        r.slot === "additional" &&
        visualRoleOf(r) === null &&
        !(r.metadata as { view?: unknown }).view &&
        referenceOrigin(assets.get(r.assetId ?? "")) === "uploaded" &&
        stored(assets, r.assetId),
    ).length;
    const lookIds = [
      ...new Set(
        shots.flatMap((s) =>
          s.characters.filter((x) => x.characterId === id && x.lookId).map((x) => x.lookId!),
        ),
      ),
    ];
    const looks = lookIds.flatMap((l) =>
      data.looks.filter((x) => x.id === l).map((x) => ({ lookId: x.id, name: x.name })),
    );
    const withImage = refs.filter((r) => stored(assets, r.assetId));
    const views = REFERENCE_SET_VIEWS.map((v) => ({ id: v.id, label: v.label, filled: !!fill.get(v.id) }));
    const outfitsPictured = looks.every((l) =>
      data.looks.find((x) => x.id === l.lookId)!.referenceAssetIds.some((a) => stored(assets, a)),
    );
    return [
      {
        characterId: id,
        name: c.name,
        photos,
        views,
        locked: withImage.length > 0 && withImage.every((r) => r.locked),
        readyToApprove: views.every((v) => v.filled) && outfitsPictured,
        looks,
        studioHref: studio(`character:${id}`),
        characterHref: `/projects/${slug}/characters/${id}`,
      },
    ];
  });

  // ── outfits ──
  const outfits: ChecklistOutfit[] = people.flatMap((p) =>
    p.looks.map((l) => {
      const look = data.looks.find((x) => x.id === l.lookId)!;
      return {
        lookId: look.id,
        characterId: p.characterId,
        characterName: p.name,
        name: look.name,
        hasPicture: look.referenceAssetIds.some((a) => stored(assets, a)),
        locked: look.locked,
      };
    }),
  );

  // ── places ──
  const locationIds = [...new Set(shots.map((s) => s.spatial.locationId).filter((x): x is string => !!x))];
  const places: ChecklistPlace[] = locationIds.flatMap((id) => {
    const l = data.locations.find((x) => x.id === id);
    if (!l) return [];
    const bible = locationBibleOf(l);
    const hasPicture =
      stored(assets, bible.canonicalAssetId) ||
      l.referenceAssetIds.some((a) => stored(assets, a)) ||
      bible.entries.some((e) => stored(assets, e.assetId));
    return [{ locationId: id, name: l.name, hasPicture, studioHref: studio(`location:${id}`) }];
  });

  // ── shots ──
  const personOf = new Map(people.map((p) => [p.characterId, p]));
  const placeOf = new Map(places.map((p) => [p.locationId, p]));
  const outfitOf = new Map(outfits.map((o) => [o.lookId, o]));
  const checklistShots: ChecklistShot[] = shots.map((s) => {
    const missing: string[] = [];
    let blocked = false;
    for (const a of s.characters) {
      const p = personOf.get(a.characterId);
      if (!p) continue;
      const front = p.views.find((v) => v.id === "front")?.filled;
      if (!front) {
        missing.push(`${p.name}: no face (front view) yet`);
        blocked = true;
      } else if (p.views.some((v) => !v.filled))
        missing.push(`${p.name}: ${p.views.filter((v) => !v.filled).length} views missing`);
      if (!a.lookId) missing.push(`${p.name}: no outfit (Look) chosen`);
      else if (!outfitOf.get(a.lookId)?.hasPicture) missing.push(`${p.name}: the outfit has no picture`);
    }
    const place = s.spatial.locationId ? placeOf.get(s.spatial.locationId) : undefined;
    if (!s.spatial.locationId) missing.push("No location chosen");
    else if (place && !place.hasPicture) missing.push(`${place.name}: no picture yet`);
    if (s.characters.length === 0) missing.push("No one is in this shot (fine for an establishing shot)");
    const problems = missing.filter((m) => !m.startsWith("No one is in this shot"));
    return {
      shotId: s.id,
      code: s.shotCode,
      title: s.title,
      href: `/projects/${slug}/episodes/${episode.slug}/shots/${s.id}`,
      people: s.characters.flatMap((a) =>
        personOf.get(a.characterId) ? [personOf.get(a.characterId)!.name] : [],
      ),
      light: blocked ? "blocked" : problems.length > 0 ? "partial" : "ready",
      missing,
      hasFrame: framed.has(s.id),
    };
  });

  // ── the next steps, in the order they have to happen ──
  const steps: ChecklistStep[] = [];
  for (const p of people) {
    const hasFront = !!p.views.find((v) => v.id === "front")?.filled;
    if (!hasFront && p.photos === 0)
      steps.push({
        area: "people",
        title: `Add photos of ${p.name}, or describe them`,
        detail: `A real person: ${PHOTOS_WANTED} to 8 photos, the face large and sharp. A fictional one: describe how they look, and the front view is made from the description.`,
        href: p.studioHref,
        action: "Open the Studio",
      });
    else if (p.photos > 0 && p.photos < PHOTOS_WANTED)
      steps.push({
        area: "people",
        title: `Add photos of ${p.name} (${p.photos} of ${PHOTOS_WANTED})`,
        detail:
          "Their own photos are the ground truth every view is made from: the face large, sharp and evenly lit.",
        href: p.studioHref,
        action: "Add photos",
      });
    const empty = p.views.filter((v) => !v.filled);
    if (empty.length > 0 && (p.photos > 0 || hasFront)) {
      const first = REFERENCE_SET_VIEWS.find((v) => v.id === empty[0]!.id)!;
      steps.push({
        area: "people",
        title: `Make ${p.name}'s ${empty.map((v) => v.label.toLowerCase()).join(", ")}`,
        detail: `${p.views.length - empty.length} of ${p.views.length} views done. Make each from their ${p.photos > 0 ? "photos" : "front view"}, then drop it on its view.`,
        href: studio(`character:${p.characterId}`, `&make=${first.intent}`),
        action: `Make the ${first.label.toLowerCase()}`,
      });
    }
  }
  for (const o of outfits)
    if (!o.hasPicture && personOf.get(o.characterId)?.views.find((v) => v.id === "front")?.filled)
      steps.push({
        area: "outfits",
        title: `Make the picture of ${o.characterName}'s "${o.name}"`,
        detail: "A full-body Wardrobe reference made from their set, dropped on the Look card.",
        href: studio(`character:${o.characterId}`, `&make=outfit_variant&look=${o.lookId}`),
        action: "Make it",
      });
  for (const pl of places)
    if (!pl.hasPicture)
      steps.push({
        area: "places",
        title: `Make a picture of ${pl.name}`,
        detail: "A location concept, then Use as canonical location.",
        href: pl.studioHref,
        action: "Open in the Studio",
      });
  for (const s of checklistShots)
    for (const m of s.missing)
      if (m.endsWith("no outfit (Look) chosen") || m === "No location chosen")
        steps.push({
          area: "shots",
          title: `Shot ${s.code}: ${m.replace(/^.*?: /, "").replace(/^No /, "no ")}`,
          detail: m,
          href: s.href,
          action: "Open the shot",
        });
  for (const s of checklistShots)
    if (s.light === "ready" && !s.hasFrame && s.people.length > 0)
      steps.push({
        area: "shots",
        title: `Make the frame for shot ${s.code}`,
        detail: `${s.title}: everything it needs is ready.`,
        href: s.href,
        action: "Make the frame",
      });

  return {
    episodeId: episode.id,
    episodeTitle: episode.title,
    steps,
    people,
    outfits,
    places,
    shots: checklistShots,
  };
}

// ───────────────────────── the project's four areas, for Home ─────────────────────────

export type AreaId = "story" | "cast" | "world" | "shots";

export interface AreaCard {
  id: AreaId;
  title: string;
  /** Where the area stands, in a few words. */
  summary: string;
  /** The one next thing, or null when nothing is missing. */
  next: { label: string; href: string } | null;
  /** When nothing can be done here yet, what it is waiting on (a hint, never a lock). */
  waiting: string | null;
  /** The area's main page. */
  href: string;
}

const hasLocationPicture = (data: ProjectData, assets: Map<string, Asset>, locationId: string) => {
  const l = data.locations.find((x) => x.id === locationId);
  if (!l) return false;
  const bible = locationBibleOf(l);
  return (
    stored(assets, bible.canonicalAssetId) ||
    l.referenceAssetIds.some((a) => stored(assets, a)) ||
    bible.entries.some((e) => stored(assets, e.assetId))
  );
};

/** The Episode a project is mostly about: the one with the most Shots. */
export function mainEpisodeId(data: ProjectData): string | null {
  const count = (id: string) => data.shots.filter((s) => s.episodeId === id).length;
  return [...data.episodes].sort((a, b) => count(b.id) - count(a.id) || a.order - b.order)[0]?.id ?? null;
}

/**
 * Home's four cards: Story, Cast, World and Shots, each with where it stands and the one next thing. Any area can be
 * worked on first; "waiting" only says what would make it go further.
 */
export function projectAreas(data: ProjectData): AreaCard[] {
  const slug = data.project.slug;
  const base = `/projects/${slug}`;
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const episodeId = mainEpisodeId(data);
  const list = episodeId ? productionChecklist(data, episodeId) : null;
  const first = (area: ChecklistArea | ChecklistArea[]) => {
    const areas = Array.isArray(area) ? area : [area];
    const s = list?.steps.find((x) => areas.includes(x.area));
    return s ? { label: s.title, href: s.href } : null;
  };

  // Story
  const premise = !!data.bible?.premise?.trim();
  const episodes = [...data.episodes].sort((a, b) => a.order - b.order);
  const unscripted = episodes.find((e) => !e.scriptText?.trim());
  const scripted = episodes.filter((e) => e.scriptText?.trim()).length;
  const story: AreaCard = {
    id: "story",
    title: "Story",
    summary: `${premise ? "Bible written" : "No Bible yet"} · ${
      episodes.length === 0 ? "no episodes" : `${scripted} of ${episodes.length} episodes scripted`
    }`,
    next:
      !premise && scripted === 0
        ? { label: "Start from a premise, or import a story", href: `${base}/start` }
        : !premise
          ? { label: "Write the Bible, or import a story", href: `${base}/story` }
          : scripted === 0
            ? { label: "Write Episode 1 from your premise", href: `${base}/start` }
            : unscripted
              ? {
                  label: `Write the script of “${unscripted.title}”`,
                  href: `${base}/episodes/${unscripted.slug}/script`,
                }
              : null,
    waiting: null,
    href: `${base}/bible`,
  };

  // Cast: every Character, ready once their face (front view) exists
  const ready = data.characters.filter((c) =>
    referenceSetFill(
      data.identityRefs.filter((r) => r.characterId === c.id),
      assets,
    ).get("front"),
  );
  const notReady = data.characters.filter((c) => !ready.includes(c));
  const cast: AreaCard = {
    id: "cast",
    title: "Cast",
    summary:
      data.characters.length === 0
        ? "No characters yet"
        : [
            ready.length ? `${ready.map((c) => c.name).join(", ")} ready` : "",
            notReady.length ? `${notReady.map((c) => c.name).join(", ")} not started` : "",
          ]
            .filter(Boolean)
            .join(" · "),
    next:
      data.characters.length === 0
        ? { label: "Add a character", href: `${base}/characters` }
        : (first(["people", "outfits"]) ??
          (notReady[0]
            ? {
                label: `Start ${notReady[0].name}`,
                href: `${base}/studio?subject=character:${notReady[0].id}`,
              }
            : null)),
    waiting: null,
    href: `${base}/studio`,
  };

  // World
  const pictured = data.locations.filter((l) => hasLocationPicture(data, assets, l.id));
  const bare = data.locations.find((l) => !pictured.includes(l));
  const world: AreaCard = {
    id: "world",
    title: "World",
    summary:
      data.locations.length === 0
        ? "No places yet"
        : `${pictured.length} of ${data.locations.length} places pictured`,
    next:
      data.locations.length === 0
        ? { label: "Add a place", href: `${base}/locations` }
        : (first("places") ??
          (bare
            ? { label: `Make a picture of ${bare.name}`, href: `${base}/studio?subject=location:${bare.id}` }
            : null)),
    waiting: null,
    href: `${base}/locations`,
  };

  // Shots
  const framed = new Set((data.productionFrameSelections ?? []).map((s) => s.shotId));
  const shotsNext = first("shots");
  const blocked = (list?.shots ?? []).filter((s) => s.light === "blocked").length;
  const shots: AreaCard = {
    id: "shots",
    title: "Shots",
    summary: `${data.shots.length} shots · ${data.shots.filter((s) => framed.has(s.id)).length} frames`,
    next: shotsNext,
    waiting:
      !shotsNext && data.shots.length > 0 && blocked > 0
        ? `${blocked} shot${blocked === 1 ? "" : "s"} waiting on Cast or World`
        : null,
    href: `${base}/storyboard`,
  };

  return [story, cast, world, shots];
}
