import { createHash } from "node:crypto";
import {
  characterSchema,
  episodeSchema,
  locationSchema,
  sceneSchema,
  shotSchema,
  type Character,
  type Episode,
  type Location,
  type ProjectData,
  type Scene,
  type Shot,
} from "../schemas";
import { emptyShot } from "../shot-defaults";
import type { ProductionProposal } from "./proposal";
import { edited, isIncluded, itemId, type ProposalReview } from "./review";
import type { StorySourceKind } from "./source";

/**
 * Phase 5B-S1: APPLY SELECTED — deterministic application code (never the model) that turns the creator's reviewed
 * selection into Prism records through the same schemas the app's own actions use. Pure: it returns the records; the
 * server action writes them.
 *
 *   - Only included items (selected, not rejected) are applied. A possible match needs the creator's decision first.
 *   - use_existing → nothing is written for the item; references point at the existing record.
 *     merge        → the existing record keeps every value it has; empty fields are filled from the proposal.
 *     create_new   → a new record (also when there is no match).
 *   - Ids are derived from (proposal id, item) so applying is deterministic; a proposal applies only once.
 *   - Scenes and Shots go into a NEW Episode (whose script is the analysed source text, so Scene line ranges are
 *     exact) or are appended to an existing Episode (its script is never rewritten).
 *   - Shots carry only what S1 proposes (purpose, Characters, Location, rough visual intent); richer shot planning is
 *     S4/S5. No Look, image, Production Frame or continuity is created or changed.
 */
export const APPLY_VERSION = "prism.story-apply.v1";

export function derivedId(proposalId: string, item: string): string {
  const h = createHash("sha256").update(`${APPLY_VERSION}|${proposalId}|${item}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ApplyPlan {
  errors: string[];
  characters: { create: Character[]; update: Character[] };
  locations: { create: Location[]; update: Location[] };
  episode: { create: Episode | null; id: string };
  scenes: Scene[];
  shots: Shot[];
  summary: {
    charactersCreated: number;
    charactersMerged: number;
    charactersReused: number;
    locationsCreated: number;
    locationsMerged: number;
    locationsReused: number;
    scenes: number;
    shots: number;
    skipped: string[];
  };
}

const fill = (existing: string, proposed: string) => (existing.trim() ? existing : proposed);

export function planApply(args: {
  proposalId: string;
  proposal: ProductionProposal;
  review: ProposalReview;
  data: ProjectData;
  sourceText: string;
  sourceKind: StorySourceKind;
  now: string;
}): ApplyPlan {
  const { proposalId, proposal: p, review, data, now } = args;
  const errors: string[] = [];
  const skipped: string[] = [];
  const idFor = (kind: string, key: string) => derivedId(proposalId, `${kind}:${key}`);
  const rev = (kind: "character" | "location" | "scene" | "shot", key: string) =>
    review.items[itemId(kind, key)];

  // ── Characters ──
  const characterIds = new Map<string, string>();
  const characters: ApplyPlan["characters"] = { create: [], update: [] };
  let charactersReused = 0;
  for (const raw of p.characters) {
    const r = rev("character", raw.key);
    if (!isIncluded(r)) continue;
    const c = edited("character", raw, r!.edits);
    const decision = r!.match ? r!.match.decision : "create_new";
    if (decision === null) {
      errors.push(`Choose how to use the possible match for Character "${c.name}".`);
      continue;
    }
    const existing = r!.match ? data.characters.find((x) => x.id === r!.match!.existingId) : undefined;
    if (r!.match && !existing && decision !== "create_new") {
      errors.push(`The matched Character for "${c.name}" no longer exists.`);
      continue;
    }
    const relationships = c.relationships
      .map((rel) => {
        const other = p.characters.find((x) => x.key === rel.characterKey);
        return other ? `${other.name}: ${rel.relation}` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (decision === "use_existing") {
      characterIds.set(c.key, existing!.id);
      charactersReused++;
    } else if (decision === "merge") {
      characterIds.set(c.key, existing!.id);
      characters.update.push(
        characterSchema.parse({
          ...existing!,
          role: fill(existing!.role, c.role),
          description: fill(existing!.description, c.description),
          personality: fill(existing!.personality, c.personality),
          physicalDescription: fill(existing!.physicalDescription, c.visualNotes),
          relationshipNotes: fill(existing!.relationshipNotes, relationships),
          updatedAt: now,
        }),
      );
    } else {
      const id = idFor("character", c.key);
      characterIds.set(c.key, id);
      characters.create.push(
        characterSchema.parse({
          id,
          projectId: data.project.id,
          name: c.name.trim(),
          role: c.role,
          description: [c.description, c.ageRange ? `Age: ${c.ageRange}` : ""].filter(Boolean).join("\n"),
          personality: c.personality,
          behaviorNotes: "",
          physicalDescription: [c.visualNotes, ...c.lookSuggestions.map((l) => `Look suggestion: ${l}`)]
            .filter(Boolean)
            .join("\n"),
          continuityRules: [],
          signatureBehavior: "",
          relationshipNotes: relationships,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
  }

  // ── Locations ──
  const locationIds = new Map<string, string>();
  const locations: ApplyPlan["locations"] = { create: [], update: [] };
  let locationsReused = 0;
  for (const raw of p.locations) {
    const r = rev("location", raw.key);
    if (!isIncluded(r)) continue;
    const l = edited("location", raw, r!.edits);
    const decision = r!.match ? r!.match.decision : "create_new";
    if (decision === null) {
      errors.push(`Choose how to use the possible match for Location "${l.name}".`);
      continue;
    }
    const existing = r!.match ? data.locations.find((x) => x.id === r!.match!.existingId) : undefined;
    if (r!.match && !existing && decision !== "create_new") {
      errors.push(`The matched Location for "${l.name}" no longer exists.`);
      continue;
    }
    const description = [l.description, l.timeStateNotes ? `Time / state: ${l.timeStateNotes}` : ""]
      .filter(Boolean)
      .join("\n");
    if (decision === "use_existing") {
      locationIds.set(l.key, existing!.id);
      locationsReused++;
    } else if (decision === "merge") {
      locationIds.set(l.key, existing!.id);
      if (existing!.locked) {
        errors.push(`Location "${existing!.name}" is locked: unlock it to merge, or choose Use existing.`);
        continue;
      }
      locations.update.push(
        locationSchema.parse({ ...existing!, description: fill(existing!.description, description) }),
      );
    } else {
      const id = idFor("location", l.key);
      locationIds.set(l.key, id);
      locations.create.push(
        locationSchema.parse({
          id,
          projectId: data.project.id,
          name: l.name.trim(),
          description,
          geography: "",
          zones: [],
          entrances: [],
          lighting: "",
          recurringProps: [],
          referenceAssetIds: [],
          locked: false,
          set3d: null,
        }),
      );
    }
  }

  // ── Episode ──
  const story = edited("story", p.story, review.story);
  let episode: ApplyPlan["episode"];
  let newEpisode = false;
  if (review.target.kind === "existing_episode") {
    const target = review.target;
    const e = data.episodes.find((x) => x.id === target.episodeId);
    if (!e) errors.push("The chosen Episode no longer exists.");
    episode = { create: null, id: e?.id ?? "" };
  } else {
    newEpisode = true;
    const number = data.episodes.reduce((m, e) => Math.max(m, e.number), 0) + 1;
    let slug = `ep-${number}`;
    for (let i = 2; data.episodes.some((e) => e.slug === slug); i++) slug = `ep-${number}-${i}`;
    const id = derivedId(proposalId, "episode");
    episode = {
      id,
      create: episodeSchema.parse({
        id,
        projectId: data.project.id,
        number,
        slug,
        title: story.title.trim() || "Imported story",
        synopsis: [story.logline, story.synopsis].filter((x) => x.trim()).join("\n\n"),
        // the analysed text IS this Episode's script, so every Scene's line range points into it
        scriptText: args.sourceText,
        order: number - 1,
        createdAt: now,
        updatedAt: now,
      }),
    };
  }

  // ── Scenes (proposal order) ──
  const existingInEpisode = data.scenes.filter((s) => s.episodeId === episode.id);
  const firstNumber = newEpisode
    ? 1
    : existingInEpisode.reduce((m, s) => Math.max(m, Number.parseInt(s.sceneNumber, 10) || 0), 0) + 1;
  const firstOrder = newEpisode ? 0 : existingInEpisode.reduce((m, s) => Math.max(m, s.order + 1), 0);
  const sceneIds = new Map<string, Scene>();
  const scenes: Scene[] = [];
  for (const raw of [...p.scenes].sort((a, b) => a.order - b.order)) {
    const r = rev("scene", raw.key);
    if (!isIncluded(r)) continue;
    const s = edited("scene", raw, r!.edits);
    const prefix = s.heading
      .trim()
      .match(/^(INT\.?\/EXT|INT|EXT|I\/E)[.\s]/i)?.[1]
      ?.toUpperCase();
    const loc = s.locationKey ? p.locations.find((l) => l.key === s.locationKey) : undefined;
    const intExt =
      prefix === "EXT"
        ? "EXT"
        : prefix === "INT"
          ? "INT"
          : prefix
            ? "INT/EXT"
            : loc?.intExt && loc.intExt !== "unknown"
              ? loc.intExt
              : "INT";
    const lines = s.sources.flatMap((x) => [x.startLine, x.endLine]);
    const scene = sceneSchema.parse({
      id: idFor("scene", s.key),
      projectId: data.project.id,
      episodeId: episode.id,
      sceneNumber: String(firstNumber + scenes.length),
      slugline: s.heading.trim() || `Scene ${firstNumber + scenes.length}`,
      intExt,
      locationId: s.locationKey ? (locationIds.get(s.locationKey) ?? null) : null,
      timeOfDay: s.timeOfDay,
      summary: s.summary,
      dramaticPurpose: s.purpose,
      emotionEntering: "",
      emotionLeaving: "",
      scriptRange:
        newEpisode && args.sourceKind !== "episode_script" && lines.length
          ? { startLine: Math.min(...lines), endLine: Math.max(...lines) }
          : null,
      characterIds: s.characterKeys.flatMap((k) => (characterIds.has(k) ? [characterIds.get(k)!] : [])),
      propIds: [],
      continuityNotes: "",
      order: firstOrder + scenes.length,
    });
    sceneIds.set(s.key, scene);
    scenes.push(scene);
  }

  // ── Shots (only under an applied Scene) ──
  const shots: Shot[] = [];
  for (const raw of [...p.shots].sort((a, b) => a.order - b.order)) {
    const r = rev("shot", raw.key);
    if (!isIncluded(r)) continue;
    const sh = edited("shot", raw, r!.edits);
    const scene = sceneIds.get(sh.sceneKey);
    if (!scene) {
      skipped.push(`Shot "${sh.purpose.slice(0, 60)}" (its Scene is not applied)`);
      continue;
    }
    const siblings = shots.filter((x) => x.sceneId === scene.id).length;
    const base = emptyShot({
      id: idFor("shot", sh.key),
      projectId: data.project.id,
      episodeId: episode.id,
      sceneId: scene.id,
      shotCode: `${scene.sceneNumber}${String.fromCharCode(65 + (siblings % 26))}${siblings >= 26 ? Math.floor(siblings / 26) : ""}`,
      title: sh.purpose.trim().slice(0, 80) || "Untitled shot",
      order: siblings,
    });
    shots.push(
      shotSchema.parse({
        ...base,
        storyBeat: sh.purpose,
        composition: { ...base.composition, aspectRatio: data.bible.aspectRatio, notes: sh.visualIntent },
        spatial: {
          ...base.spatial,
          locationId: sh.locationKey
            ? (locationIds.get(sh.locationKey) ?? scene.locationId)
            : scene.locationId,
        },
        characters: sh.characterKeys
          .filter((k) => characterIds.has(k))
          .map((k) => ({
            characterId: characterIds.get(k)!,
            lookId: null,
            performanceNotes: "",
            expression: "",
            posture: "",
            gestures: "",
            physicalInteractions: "",
          })),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  return {
    errors,
    characters,
    locations,
    episode,
    scenes,
    shots,
    summary: {
      charactersCreated: characters.create.length,
      charactersMerged: characters.update.length,
      charactersReused,
      locationsCreated: locations.create.length,
      locationsMerged: locations.update.length,
      locationsReused,
      scenes: scenes.length,
      shots: shots.length,
      skipped,
    },
  };
}
