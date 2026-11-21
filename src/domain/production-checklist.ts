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
    if (p.photos < PHOTOS_WANTED)
      steps.push({
        area: "people",
        title: `Add photos of ${p.name} (${p.photos} of ${PHOTOS_WANTED})`,
        detail:
          "Their own photos are the ground truth every view is made from: the face large, sharp and evenly lit.",
        href: p.studioHref,
        action: "Add photos",
      });
    const empty = p.views.filter((v) => !v.filled);
    if (empty.length > 0 && p.photos > 0) {
      const first = REFERENCE_SET_VIEWS.find((v) => v.id === empty[0]!.id)!;
      steps.push({
        area: "people",
        title: `Make ${p.name}'s ${empty.map((v) => v.label.toLowerCase()).join(", ")}`,
        detail: `${p.views.length - empty.length} of ${p.views.length} views done. Make each from their photos, then drop it on its view.`,
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
