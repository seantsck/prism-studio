"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { buildShotContext } from "@/domain/context";
import { approvalSnapshot } from "@/domain/fingerprint";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { reorderShotsInScene } from "@/domain/ordering";
import {
  CONTINUITY_DIMENSIONS,
  PACES,
  VOLUMES,
  TAKE_SOURCES,
  ASSET_PURPOSES,
  assetSchema,
  bibleSchema,
  characterSchema,
  continuityCheckSchema,
  dialogueLineSchema,
  episodeSchema,
  generationAttemptSchema,
  locationSchema,
  lookSchema,
  performanceDirectionSchema,
  performanceTakeSchema,
  projectSchema,
  sceneSchema,
  shotSchema,
  storyboardFrameSchema,
  voiceProfileSchema,
  type Asset,
  type IDENTITY_SLOTS,
  type Shot,
} from "@/domain/schemas";
import {
  emptyEpisodeOne,
  newProjectRecords,
  PREMISE_MAX,
  TITLE_MAX,
  titleFromPremise,
} from "@/domain/series-start";
import { emptyShot } from "@/domain/shot-defaults";
import { SHOT_SECTION_SPECS, applySection } from "@/domain/shot-fields";
import { validateLookLink } from "@/domain/looks";
import { nextTakeNumber, selectTake as selectTakeDomain } from "@/domain/takes";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { ProjectArchiveUnavailableError, ProjectTrashUnavailableError } from "@/data/repository";
import { getRepo, requireProjectFresh } from "./repo";
import { recordCreatorEdit, syncEpisodeScript } from "./script-sync";
import { deleteProjectForGood, moveAssetToTrash } from "./trash";
import { isTrashed } from "@/domain/trash";
import { discardUpload, hasFile, ingestUpload } from "./ingest-upload";

// ───────────────────────── helpers ─────────────────────────

const now = () => new Date().toISOString();
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const lines = (f: FormData, k: string) =>
  str(f, k)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const int = (f: FormData, k: string, fallback = 0) => {
  const v = str(f, k);
  return v === "" || Number.isNaN(Number(v)) ? fallback : Math.round(Number(v));
};
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `project-${randomUUID().slice(0, 8)}`;

async function load(form: FormData) {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  return { data, repo: await getRepo(), slug: data.project.slug };
}

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

// ───────────────────────── Projects & bible ─────────────────────────

async function createProject_impl(form: FormData) {
  // Starting from a prompt: the premise seeds the Bible, the Episodes wait (empty) for Prism to plan and write them,
  // and the creator lands on the guided start page, where every AI step shows its price before it runs. Without a
  // premise, a project opens exactly as before. With no title, the premise names it (titleFromPremise).
  const premise = str(form, "premise").slice(0, PREMISE_MAX);
  const title = (str(form, "title") || titleFromPremise(premise)).slice(0, TITLE_MAX);
  if (!title) throw new UserFacingError("Describe your series, or give it a title.");
  const repo = await getRepo();
  // a project in the Trash keeps its slug until it is deleted for good
  const existing = new Set([
    ...(await repo.listProjects()).map((p) => p.slug),
    ...(await repo.trashedProjects()).projects.map((t) => t.project.slug),
  ]);
  let slug = slugify(title) || "series";
  while (existing.has(slug)) slug = `${slug}-${randomUUID().slice(0, 4)}`;
  const id = randomUUID();
  const records = newProjectRecords({
    id,
    userId: repo.currentUserId(),
    title,
    slug,
    projectType: str(form, "projectType"),
    description: str(form, "description"),
    genre: str(form, "genre"),
    tone: str(form, "tone"),
    defaultLanguage: str(form, "defaultLanguage"),
    premise,
    episodeCount: Number(str(form, "episodeCount")) || undefined,
    now: now(),
  });
  await repo.createProject(records.project, records.bible);
  if (records.episodes.length) await repo.upsertMany(id, "episodes", records.episodes);
  revalidatePath("/");
  redirect(premise ? `/projects/${slug}/start` : `/projects/${slug}`);
}

/**
 * Start an existing project from a prompt: the premise goes into the Bible (replacing an empty one only — a written
 * premise is never overwritten here) and, if the project has no Episode yet, an empty Episode 1 is added. Then the
 * guided start page.
 */
async function startFromPremise_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const premise = str(form, "premise").slice(0, PREMISE_MAX);
  if (!premise) throw new UserFacingError("Describe your series in a few lines.");
  if (data.bible?.premise?.trim())
    throw new UserFacingError("This project already has a premise. Edit it on the Bible page.");
  await repo.saveBible(
    bibleSchema.parse({ ...data.bible, projectId: data.project.id, premise, updatedAt: now() }),
  );
  if (data.episodes.length === 0)
    await repo.upsert(data.project.id, "episodes", emptyEpisodeOne(data.project.id, now()));
  refresh(slug);
  redirect(`/projects/${slug}/start`);
}

/** One of the owner's projects, by slug (the Projects list acts on projects it shows, not on the open project). */
async function ownedProject(form: FormData) {
  const repo = await getRepo();
  const project = (await repo.listProjects()).find((p) => p.slug === str(form, "projectSlug"));
  if (!project) throw new UserFacingError("That project no longer exists.");
  return { repo, project };
}

/** Archive: the project leaves the Projects list; everything in it is kept, and Restore brings it back. */
async function archiveProject_impl(form: FormData) {
  const { repo, project } = await ownedProject(form);
  const archived = str(form, "archived") !== "0";
  try {
    await repo.setProjectArchived(project.id, archived);
  } catch (err) {
    if (err instanceof ProjectArchiveUnavailableError) throw new UserFacingError(err.message);
    throw err;
  }
  revalidatePath("/");
}

/**
 * Delete a project: it goes to the Trash (out of the Projects list, not openable) for 30 days, where Restore brings it
 * back whole; after that, or with "Delete now" (confirmed by typing its exact title), it is deleted for good.
 */
async function deleteProject_impl(form: FormData) {
  const { repo, project } = await ownedProject(form);
  if (str(form, "confirm") !== "1")
    throw new UserFacingError("Confirm that you want to delete this project.");
  try {
    await repo.setProjectTrashed(project.id, true);
  } catch (err) {
    if (err instanceof ProjectTrashUnavailableError) throw new UserFacingError(err.message);
    throw err;
  }
  revalidatePath("/");
  redirect("/");
}

async function trashedProject(form: FormData) {
  const repo = await getRepo();
  const found = (await repo.trashedProjects()).projects.find((t) => t.project.id === str(form, "projectId"));
  if (!found) throw new UserFacingError("That project is not in the Trash.");
  return { repo, project: found.project };
}

async function restoreProject_impl(form: FormData) {
  const { repo, project } = await trashedProject(form);
  await repo.setProjectTrashed(project.id, false);
  revalidatePath("/");
}

/** Delete a project in the Trash for good, now: confirmed by typing its exact title. */
async function deleteProjectNow_impl(form: FormData) {
  const { project } = await trashedProject(form);
  if (str(form, "confirmTitle") !== project.title.trim())
    throw new UserFacingError(`Type the project's title exactly ("${project.title}") to delete it for good.`);
  const refusal = await deleteProjectForGood(project);
  if (refusal) throw new UserFacingError(refusal);
  revalidatePath("/");
}

async function saveProject_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const project = projectSchema.parse({
    ...data.project,
    title: str(form, "title") || data.project.title,
    projectType: str(form, "projectType") || data.project.projectType,
    description: str(form, "description"),
    genre: str(form, "genre"),
    tone: str(form, "tone"),
    defaultLanguage: str(form, "defaultLanguage") || data.project.defaultLanguage,
    productionStatus: str(form, "productionStatus") || data.project.productionStatus,
    updatedAt: now(),
  });
  await repo.updateProject(project);
  refresh(slug);
}

async function saveBible_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const bible = bibleSchema.parse({
    ...data.bible,
    premise: str(form, "premise"),
    genre: str(form, "genre"),
    tone: str(form, "tone"),
    visualStyle: str(form, "visualStyle"),
    cinematographyRules: lines(form, "cinematographyRules"),
    colorLanguage: str(form, "colorLanguage"),
    aspectRatio: str(form, "aspectRatio") || "16:9",
    defaultFrameRate: Number(str(form, "defaultFrameRate")) || 24,
    ...deliverySize(form),
    dialogueLanguageStrategy: str(form, "dialogueLanguageStrategy"),
    subtitleStrategy: str(form, "subtitleStrategy"),
    audioPhilosophy: str(form, "audioPhilosophy"),
    canonFacts: lines(form, "canonFacts"),
    continuityRules: lines(form, "continuityRules"),
    guardrails: lines(form, "guardrails"),
    updatedAt: now(),
  });
  await repo.saveBible(bible);
  refresh(slug);
}

/** Optional production pixel size: both or neither (a width without a height is not a format). */
function deliverySize(form: FormData): { deliveryWidth: number | null; deliveryHeight: number | null } {
  const dim = (k: string) => {
    const n = Number(str(form, k));
    return n > 0 ? Math.round(n) : null;
  };
  const deliveryWidth = dim("deliveryWidth");
  const deliveryHeight = dim("deliveryHeight");
  if ((deliveryWidth === null) !== (deliveryHeight === null)) {
    throw new UserFacingError("Set both delivery width and height, or leave both empty.");
  }
  return { deliveryWidth, deliveryHeight };
}

// ───────────────────────── Characters / looks / voices ─────────────────────────

async function saveCharacter_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const id = str(form, "id");
  const existing = data.characters.find((c) => c.id === id);
  const character = characterSchema.parse({
    id: existing?.id ?? randomUUID(),
    projectId: data.project.id,
    name: str(form, "name"),
    role: str(form, "role"),
    description: str(form, "description"),
    personality: str(form, "personality"),
    behaviorNotes: str(form, "behaviorNotes"),
    physicalDescription: str(form, "physicalDescription"),
    continuityRules: lines(form, "continuityRules"),
    signatureBehavior: str(form, "signatureBehavior"),
    relationshipNotes: str(form, "relationshipNotes"),
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
  });
  await repo.upsert(data.project.id, "characters", character);
  refresh(slug);
  if (!existing) redirect(`/projects/${slug}/characters/${character.id}`);
}

async function saveLook_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const existing = data.looks.find((l) => l.id === str(form, "id"));
  const look = lookSchema.parse({
    id: existing?.id ?? randomUUID(),
    projectId: data.project.id,
    characterId: str(form, "characterId"),
    episodeId: str(form, "episodeId") || null,
    name: str(form, "name"),
    wardrobe: str(form, "wardrobe"),
    shoes: str(form, "shoes"),
    jewelry: str(form, "jewelry"),
    hair: str(form, "hair"),
    makeup: str(form, "makeup"),
    grooming: str(form, "grooming"),
    bodyNotes: str(form, "bodyNotes"),
    accessories: str(form, "accessories"),
    referenceAssetIds: existing?.referenceAssetIds ?? [],
    locked: existing?.locked ?? false,
  });
  if (existing?.locked) throw new UserFacingError("Look is locked; unlock it before editing.");
  await repo.upsert(data.project.id, "looks", look);
  refresh(slug);
}

async function setLookLocked_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const look = data.looks.find((l) => l.id === str(form, "id"));
  if (!look) throw new UserFacingError("Look not found");
  await repo.upsert(data.project.id, "looks", { ...look, locked: str(form, "locked") === "true" });
  refresh(slug);
}

async function saveVoiceProfile_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const existing = data.voiceProfiles.find((v) => v.id === str(form, "id"));
  if (existing?.locked) throw new UserFacingError("Voice profile is locked.");
  const voice = voiceProfileSchema.parse({
    id: existing?.id ?? randomUUID(),
    projectId: data.project.id,
    characterId: str(form, "characterId"),
    name: str(form, "name"),
    language: str(form, "language") || "ja",
    locale: str(form, "locale"),
    provider: str(form, "provider") || "unassigned",
    providerVoiceId: str(form, "providerVoiceId") || null,
    description: str(form, "description"),
    pitchNotes: str(form, "pitchNotes"),
    timbreNotes: str(form, "timbreNotes"),
    accent: str(form, "accent"),
    speakingStyle: str(form, "speakingStyle"),
    emotionalRange: str(form, "emotionalRange"),
    pronunciationRules: lines(form, "pronunciationRules"),
    sampleAssetIds: existing?.sampleAssetIds ?? [],
    locked: existing?.locked ?? false,
  });
  await repo.upsert(data.project.id, "voiceProfiles", voice);
  refresh(slug);
}

async function setVoiceLocked_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const v = data.voiceProfiles.find((x) => x.id === str(form, "id"));
  if (!v) throw new UserFacingError("Voice profile not found");
  await repo.upsert(data.project.id, "voiceProfiles", { ...v, locked: str(form, "locked") === "true" });
  refresh(slug);
}

async function uploadIdentityRef_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const file = hasFile(form, "file");
  if (!file) throw new UserFacingError("Choose an image to upload.");
  const slot = str(form, "slot") as (typeof IDENTITY_SLOTS)[number];
  const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
    allowed: ["image"],
    purpose: "identity_ref",
    source: "upload",
    tags: ["identity"],
  });
  try {
    await repo.upsert(data.project.id, "assets", asset);
  } catch (err) {
    await discardUpload(asset);
    throw err;
  }
  const characterId = str(form, "characterId");
  const existing = data.identityRefs.find(
    (r) => r.characterId === characterId && r.slot === slot && slot !== "additional",
  );
  await repo.upsert(data.project.id, "identityRefs", {
    id: existing?.id ?? randomUUID(),
    characterId,
    slot,
    assetId: asset.id,
    label: str(form, "label") || slot.replace("_", " "),
    metadata: {},
    locked: false,
  });
  refresh(slug);
}

/** Adds one uploaded image to a Look's reference images (the editable source library; a Lock freezes it later). */
async function uploadLookReference_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const look = data.looks.find((l) => l.id === str(form, "lookId"));
  if (!look) throw new UserFacingError("Look not found.");
  if (look.locked) throw new UserFacingError("Look is locked; unlock it before editing.");
  const file = hasFile(form, "file");
  if (!file) throw new UserFacingError("Choose an image to upload.");
  const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
    allowed: ["image"],
    purpose: "look_ref",
    source: "upload",
    tags: ["look"],
  });
  try {
    await repo.upsert(data.project.id, "assets", asset);
  } catch (err) {
    await discardUpload(asset);
    throw err;
  }
  await repo.upsert(data.project.id, "looks", {
    ...look,
    referenceAssetIds: [...look.referenceAssetIds, asset.id],
  });
  refresh(slug);
}

async function setIdentityLocked_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const characterId = str(form, "characterId");
  const locked = str(form, "locked") === "true";
  for (const ref of data.identityRefs.filter((r) => r.characterId === characterId)) {
    await repo.upsert(data.project.id, "identityRefs", { ...ref, locked });
  }
  refresh(slug);
}

// ───────────────────────── Locations ─────────────────────────

const namedList = (f: FormData, k: string, prefix: string) =>
  lines(f, k).map((l, i) => {
    const [name, ...rest] = l.split(":");
    return {
      id: `${prefix}-${i}-${randomUUID().slice(0, 6)}`,
      name: name.trim(),
      description: rest.join(":").trim(),
    };
  });

async function saveLocation_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const existing = data.locations.find((l) => l.id === str(form, "id"));
  if (existing?.locked) throw new UserFacingError("Location is locked; unlock it before editing.");
  const location = locationSchema.parse({
    id: existing?.id ?? randomUUID(),
    projectId: data.project.id,
    name: str(form, "name"),
    description: str(form, "description"),
    geography: str(form, "geography"),
    zones: namedList(form, "zones", "z"),
    entrances: namedList(form, "entrances", "e"),
    lighting: str(form, "lighting"),
    recurringProps: lines(form, "recurringProps"),
    referenceAssetIds: existing?.referenceAssetIds ?? [],
    locked: false,
    set3d: existing?.set3d ?? null,
    ...(existing?.visualBible ? { visualBible: existing.visualBible } : {}),
  });
  await repo.upsert(data.project.id, "locations", location);
  refresh(slug);
}

async function setLocationLocked_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const l = data.locations.find((x) => x.id === str(form, "id"));
  if (!l) throw new UserFacingError("Location not found");
  await repo.upsert(data.project.id, "locations", { ...l, locked: str(form, "locked") === "true" });
  refresh(slug);
}

// ───────────────────────── Episodes / script / scenes ─────────────────────────

async function createEpisode_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const number = data.episodes.reduce((m, e) => Math.max(m, e.number), 0) + 1;
  const episode = episodeSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    number,
    slug: `ep-${number}`,
    title: str(form, "title") || `Episode ${number}`,
    synopsis: str(form, "synopsis"),
    scriptText: "",
    order: number - 1,
    createdAt: now(),
    updatedAt: now(),
  });
  await repo.upsert(data.project.id, "episodes", episode);
  refresh(slug);
  redirect(`/projects/${slug}/episodes/${episode.slug}/script`);
}

/**
 * Parse the script and reconcile it with stored scenes/lines, preserving IDs and locked dialogue. Phase 5B-S2: the
 * change is first recorded as an immutable script revision ("Creator edit"), so the previous text stays recoverable.
 */
async function saveScript_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const episode = data.episodes.find((e) => e.id === str(form, "episodeId"));
  if (!episode) throw new UserFacingError("Episode not found");
  const text = String(form.get("scriptText") ?? "");
  await recordCreatorEdit(data, episode, text);
  await syncEpisodeScript(data, repo, episode, text);
  refresh(slug);
}

async function saveScene_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const scene = data.scenes.find((s) => s.id === str(form, "id"));
  if (!scene) throw new UserFacingError("Scene not found");
  const next = sceneSchema.parse({
    ...scene,
    summary: str(form, "summary"),
    dramaticPurpose: str(form, "dramaticPurpose"),
    emotionEntering: str(form, "emotionEntering"),
    emotionLeaving: str(form, "emotionLeaving"),
    timeOfDay: str(form, "timeOfDay"),
    locationId: str(form, "locationId") || null,
    continuityNotes: str(form, "continuityNotes"),
    characterIds: form.getAll("characterIds").map(String),
    propIds: form.getAll("propIds").map(String),
  });
  await repo.upsert(data.project.id, "scenes", next);
  refresh(slug);
}

// ───────────────────────── Shots ─────────────────────────

async function createShot_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const scene = data.scenes.find((s) => s.id === str(form, "sceneId"));
  if (!scene) throw new UserFacingError("Scene not found");
  const siblings = data.shots.filter((s) => s.sceneId === scene.id);
  const letter = String.fromCharCode(65 + siblings.length);
  const base = emptyShot({
    id: randomUUID(),
    projectId: data.project.id,
    episodeId: scene.episodeId,
    sceneId: scene.id,
    shotCode: str(form, "shotCode") || `${scene.sceneNumber}${letter}`,
    title: str(form, "title") || "Untitled shot",
    order: siblings.length,
  });
  const shot = shotSchema.parse({
    ...base,
    composition: { ...base.composition, aspectRatio: data.bible.aspectRatio },
    spatial: { ...base.spatial, locationId: scene.locationId },
  });
  await repo.upsert(data.project.id, "shots", shot);
  refresh(slug);
  const episode = data.episodes.find((e) => e.id === scene.episodeId);
  redirect(`/projects/${slug}/episodes/${episode?.slug}/shots/${shot.id}`);
}

async function loadShot(form: FormData) {
  const base = await load(form);
  const shot = base.data.shots.find((s) => s.id === str(form, "shotId"));
  if (!shot) throw new UserFacingError("Shot not found");
  return { ...base, shot };
}

/** The pictures (and clips) a Shot is generated from, by where they sit on it. */
const SHOT_INPUTS = [
  "reference",
  "start_frame",
  "end_frame",
  "reference_video",
  "reference_audio",
  "lighting_reference",
] as const;

/**
 * Take one picture (or clip) off a Shot's generation inputs: its reference images, start or end frame, reference
 * video or audio, or lighting reference. The picture itself is kept (it can then be deleted, if nothing else uses it);
 * the Shot's next generation simply goes without it. A locked Shot refuses.
 */
async function removeShotInput_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  if (shot.status === "locked")
    throw new UserFacingError("This Shot is locked. Unlock it before changing its inputs.");
  const role = str(form, "role") as (typeof SHOT_INPUTS)[number];
  const assetId = str(form, "assetId");
  if (!SHOT_INPUTS.includes(role)) throw new UserFacingError("Choose which input to remove.");
  const g = shot.generation;
  const next: Shot =
    role === "lighting_reference"
      ? { ...shot, lighting: { ...shot.lighting, referenceAssetId: null } }
      : {
          ...shot,
          generation: {
            ...g,
            ...(role === "reference"
              ? { referenceAssetIds: g.referenceAssetIds.filter((x) => x !== assetId) }
              : {}),
            ...(role === "start_frame" ? { startFrameAssetId: null } : {}),
            ...(role === "end_frame" ? { endFrameAssetId: null } : {}),
            ...(role === "reference_video" ? { referenceVideoAssetId: null } : {}),
            ...(role === "reference_audio" ? { referenceAudioAssetId: null } : {}),
          },
        };
  const held =
    role === "reference"
      ? g.referenceAssetIds.includes(assetId)
      : role === "lighting_reference"
        ? shot.lighting.referenceAssetId === assetId
        : (role === "start_frame"
            ? g.startFrameAssetId
            : role === "end_frame"
              ? g.endFrameAssetId
              : role === "reference_video"
                ? g.referenceVideoAssetId
                : g.referenceAudioAssetId) === assetId;
  if (!held) throw new UserFacingError("That picture is no longer on this Shot.");
  await saveShot(data.project.id, next, slug);
}

async function saveShot(projectId: string, shot: Shot, slug: string) {
  const parsed = shotSchema.parse({ ...shot, updatedAt: now() });
  await (await getRepo()).upsert(projectId, "shots", parsed);
  refresh(slug);
}

async function saveShotSection_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const spec = SHOT_SECTION_SPECS.find((s) => s.key === str(form, "section"));
  if (!spec) throw new UserFacingError("Unknown section");
  await saveShot(data.project.id, applySection(shot, spec, form), slug);
}

async function saveShotCharacters_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const ids = form.getAll("characterId").map(String).filter(Boolean);
  const characters = ids.map((characterId) => {
    const lookId = str(form, `look:${characterId}`) || null;
    const err = validateLookLink({ characterId, lookId }, data.looks, shot.episodeId);
    if (err) throw new Error(err.message);
    return {
      characterId,
      lookId,
      expression: str(form, `expression:${characterId}`),
      posture: str(form, `posture:${characterId}`),
      gestures: str(form, `gestures:${characterId}`),
      physicalInteractions: str(form, `interactions:${characterId}`),
      performanceNotes: str(form, `notes:${characterId}`),
    };
  });
  const syncCount = str(form, "syncCount") === "on";
  await saveShot(
    data.project.id,
    {
      ...shot,
      characters,
      continuity: syncCount ? { ...shot.continuity, characterCount: characters.length } : shot.continuity,
    },
    slug,
  );
}

async function saveShotDialogue_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const ids = form.getAll("lineId").map(String);
  await saveShot(data.project.id, { ...shot, audio: { ...shot.audio, dialogueLineIds: ids } }, slug);
}

async function saveShotBeats_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  // The beats form (Action timing) and the marks form (Blocking) are separate; only touch what was sent.
  let action = shot.action;
  let spatial = shot.spatial;
  if (form.has("beats")) {
    const previous = [...shot.action.beats].sort((a, b) => a.order - b.order);
    const beats = lines(form, "beats").map((l, order) => {
      const [at, ...rest] = l.split("|");
      const hasTime = rest.length > 0 && !Number.isNaN(Number(at));
      return {
        // Keep ids stable for unchanged positions.
        id: previous[order]?.id ?? randomUUID(),
        order,
        atMs: hasTime ? Math.round(Number(at) * 1000) : 0,
        description: (hasTime ? rest.join("|") : l).trim(),
      };
    });
    action = { ...action, beats };
  }
  if (form.has("marks")) {
    const marks = lines(form, "marks").map((l) => {
      const [label, x, y, notes] = l.split("|").map((p) => p.trim());
      return { label: label ?? "", x: Number(x) || 0, y: Number(y) || 0, notes: notes ?? "" };
    });
    spatial = { ...spatial, marks };
  }
  await saveShot(data.project.id, { ...shot, action, spatial }, slug);
}

async function saveShotProps_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const known = new Set(data.props.map((p) => p.id));
  const propIds = form
    .getAll("propId")
    .map(String)
    .filter((id) => known.has(id));
  await saveShot(data.project.id, { ...shot, propIds }, slug);
}

async function setShotApproval_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const gate = str(form, "gate") as keyof Shot["approval"];
  if (!["storyboardApproved", "performanceApproved", "continuityApproved"].includes(gate))
    throw new UserFacingError("Unknown gate");
  await saveShot(
    data.project.id,
    { ...shot, approval: { ...shot.approval, [gate]: str(form, "value") === "true" } },
    slug,
  );
}

async function setShotDuration_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const mode =
    str(form, "durationMode") === "derived_from_performance" ? "derived_from_performance" : "manual";
  const seconds = str(form, "seconds");
  await saveShot(
    data.project.id,
    {
      ...shot,
      durationMode: mode,
      targetDurationMs:
        seconds === "" ? shot.targetDurationMs : Math.max(0, Math.round(Number(seconds) * 1000)),
    },
    slug,
  );
}

async function reorderShots_impl(sceneId: string, orderedIds: string[], projectSlug: string) {
  const data = await requireProjectFresh(projectSlug);
  const sceneShots = data.shots.filter((s) => s.sceneId === sceneId);
  const byId = new Map(sceneShots.map((s) => [s.id, s]));
  if (orderedIds.length !== sceneShots.length || orderedIds.some((id) => !byId.has(id)))
    throw new UserFacingError("Invalid order");
  // Express the requested order as a sequence of rule-checked single moves.
  let current = [...sceneShots].sort((a, b) => a.order - b.order);
  orderedIds.forEach((id, target) => {
    if (current[target].id !== id && byId.get(id)?.status !== "locked") {
      current = reorderShotsInScene(current, id, target);
    }
  });
  await (
    await getRepo()
  ).upsertMany(
    data.project.id,
    "shots",
    current.map((s) => ({ ...s, updatedAt: now() })),
  );
  refresh(projectSlug);
}

// ───────────────────────── Performance ─────────────────────────

async function saveDialogueLine_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const line = data.dialogueLines.find((l) => l.id === str(form, "lineId"));
  if (!line) throw new UserFacingError("Line not found");
  const text = str(form, "originalText");
  if (line.locked && text !== line.originalText)
    throw new UserFacingError("Dialogue is locked; unlock it to change the text.");
  const next = dialogueLineSchema.parse({
    ...line,
    originalText: line.locked ? line.originalText : text,
    translation: str(form, "translation") || null,
    pronunciationNotes: str(form, "pronunciationNotes"),
    dramaticContext: str(form, "dramaticContext"),
    subtext: str(form, "subtext"),
  });
  await repo.upsert(data.project.id, "dialogueLines", next);
  refresh(slug);
}

async function setLineLocked_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const line = data.dialogueLines.find((l) => l.id === str(form, "lineId"));
  if (!line) throw new UserFacingError("Line not found");
  await repo.upsert(data.project.id, "dialogueLines", { ...line, locked: str(form, "locked") === "true" });
  refresh(slug);
}

async function saveDirection_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const lineId = str(form, "lineId");
  const existing = data.directions.find((d) => d.dialogueLineId === lineId);
  const pace = str(form, "pace");
  const volume = str(form, "volume");
  const direction = performanceDirectionSchema.parse({
    id: existing?.id ?? randomUUID(),
    dialogueLineId: lineId,
    emotion: str(form, "emotion"),
    objective: str(form, "objective"),
    subtext: str(form, "subtext"),
    intensity: Math.max(0, Math.min(100, int(form, "intensity", 40))),
    pace: (PACES as readonly string[]).includes(pace) ? pace : "natural",
    volume: (VOLUMES as readonly string[]).includes(volume) ? volume : "normal",
    pauses: str(form, "pauses"),
    breaths: str(form, "breaths"),
    emphasisNotes: str(form, "emphasisNotes"),
    physicalBehaviorNotes: str(form, "physicalBehaviorNotes"),
  });
  await repo.upsert(data.project.id, "directions", direction);
  refresh(slug);
}

async function addTake_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const line = data.dialogueLines.find((l) => l.id === str(form, "lineId"));
  if (!line) throw new UserFacingError("That dialogue line no longer exists.");
  const sourceRaw = str(form, "sourceType");
  const sourceType = (TAKE_SOURCES as readonly string[]).includes(sourceRaw) ? sourceRaw : "temp_voice";

  const file = hasFile(form, "file");
  const manualMs = Math.round(Number(str(form, "durationSec")) * 1000);
  // The browser's measured length is a hint only (shown while uploading); the file's own metadata wins.
  const hintMs = Math.round(Number(str(form, "durationHintSec")) * 1000) || null;

  let audioAssetId: string | null = null;
  let durationMs: number;
  let durationSource: "server_metadata" | "manual" = "manual";
  let waveform: ReturnType<typeof performanceTakeSchema.parse>["waveform"] = null;
  let ingested: Awaited<ReturnType<typeof ingestUpload>> | null = null;

  if (file) {
    ingested = await ingestUpload(data, repo.currentUserId(), file, {
      allowed: ["audio"],
      purpose: "performance_audio",
      source: sourceType === "human_recording" ? "recording" : "upload",
      tags: ["performance"],
    });
    durationMs = ingested.audio!.durationMs;
    durationSource = "server_metadata";
    waveform = ingested.audio!.waveform;
    ingested.asset.metadata = { ...ingested.asset.metadata, browserHintMs: hintMs };
    audioAssetId = ingested.asset.id;
  } else {
    if (!manualMs || manualMs <= 0)
      throw new UserFacingError("Attach an audio file, or enter the take duration.", {
        durationSec: "Duration is required without a file",
      });
    durationMs = manualMs;
  }

  const existing = data.takes.filter((t) => t.dialogueLineId === line.id);
  const take = performanceTakeSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    dialogueLineId: line.id,
    characterId: line.characterId,
    voiceProfileId: str(form, "voiceProfileId") || null,
    sourceType,
    audioAssetId,
    durationMs,
    durationSource,
    waveform,
    transcript: str(form, "transcript"),
    takeNumber: nextTakeNumber(existing, line.id),
    notes: str(form, "notes"),
    rating: Math.max(0, Math.min(5, int(form, "rating", 0))),
    // First take becomes canonical by default so downstream timing has something to use.
    selected: existing.filter((t) => !t.archived).length === 0,
    archived: false,
    createdAt: now(),
  });
  try {
    if (ingested) await repo.upsert(data.project.id, "assets", ingested.asset);
    await repo.upsert(data.project.id, "takes", take);
  } catch (err) {
    if (ingested) await discardUpload(ingested.asset);
    throw err;
  }
  refresh(slug);
}

/** Archive keeps the take (and its audio) for history but removes it from selection. Never deletes. */
async function setTakeArchived_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const take = data.takes.find((t) => t.id === str(form, "takeId"));
  if (!take) throw new UserFacingError("That take no longer exists.");
  const archived = str(form, "archived") === "true";
  await repo.upsert(data.project.id, "takes", {
    ...take,
    archived,
    selected: archived ? false : take.selected,
  });
  refresh(slug);
}

async function selectTake_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const target = data.takes.find((t) => t.id === str(form, "takeId"));
  if (!target) throw new UserFacingError("That take no longer exists.");
  if (target.archived) throw new UserFacingError("Restore this take before selecting it.");
  const lineId = target.dialogueLineId;
  const updated = selectTakeDomain(data.takes, str(form, "takeId")).filter(
    (t) => t.dialogueLineId === lineId,
  );
  await repo.upsertMany(data.project.id, "takes", updated);
  refresh(slug);
}

async function rateTake_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const take = data.takes.find((t) => t.id === str(form, "takeId"));
  if (!take) throw new UserFacingError("Take not found");
  await repo.upsert(data.project.id, "takes", {
    ...take,
    rating: Math.max(0, Math.min(5, int(form, "rating", 0))),
    notes: form.has("notes") ? str(form, "notes") : take.notes,
  });
  refresh(slug);
}

// ───────────────────────── Storyboard ─────────────────────────

async function addStoryboardFrame_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const shotId = str(form, "shotId");
  if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("Shot not found");
  const file = hasFile(form, "file");
  let assetId: string | null = null;
  const sourceRaw = str(form, "source");
  const source =
    (["upload", "generated", "3d_preview", "sketch"] as const).find((s) => s === sourceRaw) ?? "upload";
  let uploaded: Asset | null = null;
  if (file) {
    const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
      allowed: ["image"],
      purpose: "storyboard",
      source: source === "upload" ? "storyboard" : source === "sketch" ? "sketch" : source,
      tags: ["storyboard"],
    });
    uploaded = asset;
    assetId = asset.id;
  }
  const version =
    data.frames.filter((f) => f.shotId === shotId).reduce((m, f) => Math.max(m, f.version), 0) + 1;
  try {
    if (uploaded) await repo.upsert(data.project.id, "assets", uploaded);
    await repo.upsert(
      data.project.id,
      "frames",
      storyboardFrameSchema.parse({
        id: randomUUID(),
        projectId: data.project.id,
        shotId,
        assetId,
        version,
        source,
        notes: str(form, "notes"),
        approved: false,
        approvedFingerprint: null,
        approvedSnapshot: null,
        approvedAt: null,
        createdAt: now(),
      }),
    );
  } catch (err) {
    if (uploaded) await discardUpload(uploaded);
    throw err;
  }
  refresh(slug);
}

async function setFrameApproved_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const frame = data.frames.find((f) => f.id === str(form, "frameId"));
  if (!frame) throw new UserFacingError("Frame not found");
  const approve = str(form, "approved") === "true";
  const siblings = data.frames.filter((f) => f.shotId === frame.shotId);
  // At most one approved frame per shot.
  // Write the target last so the "one approved frame per shot" index is never violated mid-way.
  const ordered = [...siblings.filter((f) => f.id !== frame.id), frame];
  // Record WHICH shot state this approval is for, so later edits can be flagged as "stale storyboard".
  const approved_ = approve ? approvalSnapshot(buildShotContext(data, frame.shotId)) : null;
  for (const f of ordered) {
    const approved = f.id === frame.id ? approve : approve ? false : f.approved;
    if (approved === f.approved && f.id !== frame.id) continue;
    await repo.upsert(data.project.id, "frames", {
      ...f,
      approved,
      approvedFingerprint:
        f.id === frame.id ? (approved_?.fingerprint ?? null) : approved ? f.approvedFingerprint : null,
      approvedSnapshot:
        f.id === frame.id
          ? approved_
            ? {
                parts: approved_.snapshot.parts as Record<string, string>,
                durationMs: approved_.snapshot.durationMs,
              }
            : null
          : approved
            ? f.approvedSnapshot
            : null,
      approvedAt: f.id === frame.id ? (approve ? now() : null) : approved ? f.approvedAt : null,
    });
  }
  const shot = data.shots.find((s) => s.id === frame.shotId);
  if (shot) {
    await repo.upsert(data.project.id, "shots", {
      ...shot,
      approval: { ...shot.approval, storyboardApproved: approve },
      updatedAt: now(),
    });
  }
  refresh(slug);
}

// ───────────────────────── Generation & continuity ─────────────────────────

/**
 * Logs an attempt made OUTSIDE Prism (another tool). It snapshots the package like any attempt, but there is
 * no job and no output. Attempts created by Prism's own generation pipeline use startGeneration instead.
 */
async function logAttempt_impl(form: FormData) {
  const { data, shot, repo, slug } = await loadShot(form);
  const pkg = assembleGenerationPackage(buildShotContext(data, shot.id));
  const existing = data.attempts.filter((a) => a.shotId === shot.id);
  const attemptNumber = existing.reduce((m, a) => Math.max(m, a.attemptNumber), 0) + 1;
  const outcome = str(form, "outcome") || "rejected";
  const reviewStatus =
    outcome === "approved" ? "approved" : outcome === "unreviewed" ? "unreviewed" : "rejected";
  const approved = reviewStatus === "approved";
  const attempt = generationAttemptSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    shotId: shot.id,
    attemptNumber,
    provider: str(form, "provider") || shot.generation.provider || "manual",
    model: str(form, "model") || shot.generation.model || "manual-log",
    modality: shot.generation.modality,
    prompt: pkg.prompt.positive,
    negativePrompt: pkg.prompt.negative,
    packageSnapshot: JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>,
    packageFingerprint: pkg.provenance.fingerprint,
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: str(form, "costUsd") ? Number(str(form, "costUsd")) : null,
    durationMs: pkg.timing.durationMs || null,
    status: "succeeded",
    reviewStatus,
    reviewedAt: reviewStatus === "unreviewed" ? null : now(),
    rejectionCategories: [],
    rejectionReason: str(form, "rejectionReason"),
    notes: str(form, "notes"),
    approved,
    requestModality: null,
    promptPlan: null,
    request: null,
    compatibility: null,
    acknowledgedIgnored: [],
    adaptationPlan: null,
    createdBy: repo.currentUserId(),
    createdAt: now(),
  });
  if (approved) {
    for (const a of existing.filter((x) => x.approved))
      await repo.upsert(data.project.id, "attempts", { ...a, approved: false, reviewStatus: "unreviewed" });
  }
  await repo.upsert(data.project.id, "attempts", attempt);
  refresh(slug);
}

async function saveContinuityCheck_impl(form: FormData) {
  const { data, shot, repo, slug } = await loadShot(form);
  const scores: Record<string, number | null> = {};
  for (const d of CONTINUITY_DIMENSIONS) {
    const v = str(form, `score:${d}`);
    scores[d] = v === "" ? null : Math.max(0, Math.min(100, Number(v)));
  }
  const present = Object.values(scores).filter((v): v is number => v != null);
  const overall = present.length ? Math.round(present.reduce((a, b) => a + b, 0) / present.length) : null;
  const issues = lines(form, "issues").map((l) => {
    const [dimension, severity, ...rest] = l.split("|").map((p) => p.trim());
    const sev = ["minor", "major", "blocker"].includes(severity) ? severity : "minor";
    return { dimension: dimension || "general", severity: sev, description: rest.join("|").trim() || l };
  });
  await repo.upsert(
    data.project.id,
    "continuityChecks",
    continuityCheckSchema.parse({
      id: randomUUID(),
      projectId: data.project.id,
      shotId: shot.id,
      attemptId: str(form, "attemptId") || null,
      kind: "manual",
      overallScore: overall,
      scores,
      issues,
      reviewer: str(form, "reviewer") || "Reviewer",
      createdAt: now(),
    }),
  );
  refresh(slug);
}

// ───────── Assets ─────────

/** Library upload: any supported file with an explicit purpose. */
async function uploadAsset_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const file = hasFile(form, "file");
  if (!file) throw new UserFacingError("Choose a file to upload.");
  const purposeRaw = str(form, "purpose");
  const purpose = (ASSET_PURPOSES as readonly string[]).includes(purposeRaw)
    ? (purposeRaw as Asset["purpose"])
    : "other";
  const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
    allowed: ["image", "audio", "video", "document"],
    purpose,
    source: "upload",
    tags: lines(form, "tags")
      .flatMap((l) => l.split(","))
      .map((t) => t.trim())
      .filter(Boolean),
    notes: str(form, "notes"),
  });
  try {
    await repo.upsert(data.project.id, "assets", asset);
  } catch (err) {
    await discardUpload(asset);
    throw err;
  }
  refresh(slug);
}

async function updateAsset_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const asset = data.assets.find((a) => a.id === str(form, "assetId"));
  if (!asset) throw new UserFacingError("That asset no longer exists.");
  const purposeRaw = str(form, "purpose");
  await repo.upsert(
    data.project.id,
    "assets",
    assetSchema.parse({
      ...asset,
      name: str(form, "name") || asset.name,
      purpose: (ASSET_PURPOSES as readonly string[]).includes(purposeRaw) ? purposeRaw : asset.purpose,
      notes: str(form, "notes"),
      tags: str(form, "tags")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      updatedAt: now(),
    }),
  );
  refresh(slug);
}

/** Refuses when anything references the asset; nothing is ever silently orphaned. */
async function deleteAsset_impl(form: FormData) {
  const { data, slug } = await load(form);
  const asset = data.assets.find((a) => a.id === str(form, "assetId"));
  if (!asset) throw new UserFacingError("That asset no longer exists.");
  if (isTrashed(asset)) throw new UserFacingError("That asset is already in the Trash.");
  // to the Trash (30 days, restorable), refused unless it could be deleted
  await moveAssetToTrash(data, asset, null);
  refresh(slug);
}

// ───────── Script → shot traceability ─────────

/** Link or unlink one script element (action block / dialogue line) to a shot. */
async function setShotSource_impl(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const kind = str(form, "kind");
  const sourceId = str(form, "sourceId");
  const link = str(form, "link") !== "false";
  if (kind !== "action" && kind !== "dialogue") throw new UserFacingError("Unknown source type.");
  const exists =
    kind === "action"
      ? data.actionBlocks.some((b) => b.id === sourceId)
      : data.dialogueLines.some((l) => l.id === sourceId);
  if (!exists) throw new UserFacingError("That script element no longer exists.");
  const key = kind === "action" ? "actionBlockIds" : "dialogueLineIds";
  const current = shot.scriptSources[key];
  const next = link ? [...new Set([...current, sourceId])] : current.filter((x) => x !== sourceId);
  await saveShot(data.project.id, { ...shot, scriptSources: { ...shot.scriptSources, [key]: next } }, slug);
}

/** Manual shot creation from selected script content. (AI may only propose such selections, never apply them.) */
async function createShotFromSources_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const scene = data.scenes.find((s) => s.id === str(form, "sceneId"));
  if (!scene) throw new UserFacingError("Choose a scene.");
  const actionBlockIds = form
    .getAll("actionId")
    .map(String)
    .filter((id) => data.actionBlocks.some((b) => b.id === id && b.sceneId === scene.id));
  const dialogueLineIds = form
    .getAll("lineId")
    .map(String)
    .filter((id) => data.dialogueLines.some((l) => l.id === id && l.sceneId === scene.id));
  if (actionBlockIds.length + dialogueLineIds.length === 0)
    throw new UserFacingError("Select at least one action or dialogue line from the script.");

  // Linking to an existing shot instead of creating one.
  const targetShotId = str(form, "targetShotId");
  if (targetShotId) {
    const target = data.shots.find((s) => s.id === targetShotId && s.sceneId === scene.id);
    if (!target) throw new UserFacingError("That shot is not in this scene.");
    await repo.upsert(data.project.id, "shots", {
      ...target,
      scriptSources: {
        actionBlockIds: [...new Set([...target.scriptSources.actionBlockIds, ...actionBlockIds])],
        dialogueLineIds: [...new Set([...target.scriptSources.dialogueLineIds, ...dialogueLineIds])],
      },
      updatedAt: now(),
    });
    refresh(slug);
    return;
  }

  const siblings = data.shots.filter((s) => s.sceneId === scene.id);
  const letter = String.fromCharCode(65 + siblings.length);
  const firstText =
    data.actionBlocks.find((b) => b.id === actionBlockIds[0])?.text ??
    data.dialogueLines.find((l) => l.id === dialogueLineIds[0])?.originalText ??
    "";
  const base = emptyShot({
    id: randomUUID(),
    projectId: data.project.id,
    episodeId: scene.episodeId,
    sceneId: scene.id,
    shotCode: str(form, "shotCode") || `${scene.sceneNumber}${letter}`,
    title: str(form, "title") || firstText.slice(0, 48) || "Untitled shot",
    order: siblings.length,
  });
  const shot = shotSchema.parse({
    ...base,
    composition: { ...base.composition, aspectRatio: data.bible.aspectRatio },
    spatial: { ...base.spatial, locationId: scene.locationId },
    audio: { ...base.audio, dialogueLineIds },
    scriptSources: { actionBlockIds, dialogueLineIds },
  });
  await repo.upsert(data.project.id, "shots", shot);
  refresh(slug);
  const episode = data.episodes.find((e) => e.id === scene.episodeId);
  redirect(`/projects/${slug}/episodes/${episode?.slug}/shots/${shot.id}`);
}

// ───────── public server actions (every one returns an inline-renderable result) ─────────
export async function createProject(form: FormData): Promise<ActionResult> {
  return runAction(() => createProject_impl(form), { name: "createProject" });
}

export async function startFromPremise(form: FormData): Promise<ActionResult> {
  return runAction(() => startFromPremise_impl(form), { name: "startFromPremise" });
}

export async function archiveProject(form: FormData): Promise<ActionResult> {
  return runAction(() => archiveProject_impl(form), { name: "archiveProject" });
}

export async function restoreProject(form: FormData): Promise<ActionResult> {
  return runAction(() => restoreProject_impl(form), { name: "restoreProject" });
}

export async function deleteProjectNow(form: FormData): Promise<ActionResult> {
  return runAction(() => deleteProjectNow_impl(form), { name: "deleteProjectNow" });
}

export async function removeShotInput(form: FormData): Promise<ActionResult> {
  return runAction(() => removeShotInput_impl(form), { name: "removeShotInput" });
}

export async function deleteProject(form: FormData): Promise<ActionResult> {
  return runAction(() => deleteProject_impl(form), { name: "deleteProject" });
}

export async function saveProject(form: FormData): Promise<ActionResult> {
  return runAction(() => saveProject_impl(form), { name: "saveProject" });
}

export async function saveBible(form: FormData): Promise<ActionResult> {
  return runAction(() => saveBible_impl(form), { name: "saveBible" });
}

export async function saveCharacter(form: FormData): Promise<ActionResult> {
  return runAction(() => saveCharacter_impl(form), { name: "saveCharacter" });
}

export async function saveLook(form: FormData): Promise<ActionResult> {
  return runAction(() => saveLook_impl(form), { name: "saveLook" });
}

export async function setLookLocked(form: FormData): Promise<ActionResult> {
  return runAction(() => setLookLocked_impl(form), { name: "setLookLocked" });
}

export async function saveVoiceProfile(form: FormData): Promise<ActionResult> {
  return runAction(() => saveVoiceProfile_impl(form), { name: "saveVoiceProfile" });
}

export async function setVoiceLocked(form: FormData): Promise<ActionResult> {
  return runAction(() => setVoiceLocked_impl(form), { name: "setVoiceLocked" });
}

export async function uploadIdentityRef(form: FormData): Promise<ActionResult> {
  return runAction(() => uploadIdentityRef_impl(form), { name: "uploadIdentityRef" });
}

export async function setIdentityLocked(form: FormData): Promise<ActionResult> {
  return runAction(() => setIdentityLocked_impl(form), { name: "setIdentityLocked" });
}

export async function saveLocation(form: FormData): Promise<ActionResult> {
  return runAction(() => saveLocation_impl(form), { name: "saveLocation" });
}

export async function setLocationLocked(form: FormData): Promise<ActionResult> {
  return runAction(() => setLocationLocked_impl(form), { name: "setLocationLocked" });
}

export async function createEpisode(form: FormData): Promise<ActionResult> {
  return runAction(() => createEpisode_impl(form), { name: "createEpisode" });
}

export async function saveScript(form: FormData): Promise<ActionResult> {
  return runAction(() => saveScript_impl(form), { name: "saveScript" });
}

export async function saveScene(form: FormData): Promise<ActionResult> {
  return runAction(() => saveScene_impl(form), { name: "saveScene" });
}

export async function createShot(form: FormData): Promise<ActionResult> {
  return runAction(() => createShot_impl(form), { name: "createShot" });
}

export async function saveShotSection(form: FormData): Promise<ActionResult> {
  return runAction(() => saveShotSection_impl(form), { name: "saveShotSection" });
}

export async function saveShotCharacters(form: FormData): Promise<ActionResult> {
  return runAction(() => saveShotCharacters_impl(form), { name: "saveShotCharacters" });
}

export async function saveShotDialogue(form: FormData): Promise<ActionResult> {
  return runAction(() => saveShotDialogue_impl(form), { name: "saveShotDialogue" });
}

export async function saveShotBeats(form: FormData): Promise<ActionResult> {
  return runAction(() => saveShotBeats_impl(form), { name: "saveShotBeats" });
}

export async function setShotApproval(form: FormData): Promise<ActionResult> {
  return runAction(() => setShotApproval_impl(form), { name: "setShotApproval" });
}

export async function setShotDuration(form: FormData): Promise<ActionResult> {
  return runAction(() => setShotDuration_impl(form), { name: "setShotDuration" });
}

export async function saveDialogueLine(form: FormData): Promise<ActionResult> {
  return runAction(() => saveDialogueLine_impl(form), { name: "saveDialogueLine" });
}

export async function setLineLocked(form: FormData): Promise<ActionResult> {
  return runAction(() => setLineLocked_impl(form), { name: "setLineLocked" });
}

export async function saveDirection(form: FormData): Promise<ActionResult> {
  return runAction(() => saveDirection_impl(form), { name: "saveDirection" });
}

export async function addTake(form: FormData): Promise<ActionResult> {
  return runAction(() => addTake_impl(form), { name: "addTake" });
}

export async function setTakeArchived(form: FormData): Promise<ActionResult> {
  return runAction(() => setTakeArchived_impl(form), { name: "setTakeArchived" });
}

export async function selectTake(form: FormData): Promise<ActionResult> {
  return runAction(() => selectTake_impl(form), { name: "selectTake" });
}

export async function rateTake(form: FormData): Promise<ActionResult> {
  return runAction(() => rateTake_impl(form), { name: "rateTake" });
}

export async function addStoryboardFrame(form: FormData): Promise<ActionResult> {
  return runAction(() => addStoryboardFrame_impl(form), { name: "addStoryboardFrame" });
}

export async function setFrameApproved(form: FormData): Promise<ActionResult> {
  return runAction(() => setFrameApproved_impl(form), { name: "setFrameApproved" });
}

export async function logAttempt(form: FormData): Promise<ActionResult> {
  return runAction(() => logAttempt_impl(form), { name: "logAttempt" });
}

export async function saveContinuityCheck(form: FormData): Promise<ActionResult> {
  return runAction(() => saveContinuityCheck_impl(form), { name: "saveContinuityCheck" });
}

export async function uploadAsset(form: FormData): Promise<ActionResult> {
  return runAction(() => uploadAsset_impl(form), { name: "uploadAsset" });
}

export async function updateAsset(form: FormData): Promise<ActionResult> {
  return runAction(() => updateAsset_impl(form), { name: "updateAsset" });
}

export async function uploadLookReference(form: FormData): Promise<ActionResult> {
  return runAction(() => uploadLookReference_impl(form), { name: "uploadLookReference" });
}
export async function deleteAsset(form: FormData): Promise<ActionResult> {
  return runAction(() => deleteAsset_impl(form), { name: "deleteAsset" });
}

export async function setShotSource(form: FormData): Promise<ActionResult> {
  return runAction(() => setShotSource_impl(form), { name: "setShotSource" });
}

export async function createShotFromSources(form: FormData): Promise<ActionResult> {
  return runAction(() => createShotFromSources_impl(form), { name: "createShotFromSources" });
}

export async function saveShotProps(form: FormData): Promise<ActionResult> {
  return runAction(() => saveShotProps_impl(form), { name: "saveShotProps" });
}

export async function reorderShots(
  sceneId: string,
  orderedIds: string[],
  projectSlug: string,
): Promise<ActionResult> {
  return runAction(() => reorderShots_impl(sceneId, orderedIds, projectSlug), { name: "reorderShots" });
}
