"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { reorderShotsInScene } from "@/domain/ordering";
import {
  CONTINUITY_DIMENSIONS,
  PACES,
  VOLUMES,
  TAKE_SOURCES,
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
import { parseScreenplay, syncScript } from "@/domain/script";
import { emptyShot } from "@/domain/shot-defaults";
import { SHOT_SECTION_SPECS, applySection } from "@/domain/shot-fields";
import { validateLookLink } from "@/domain/looks";
import { nextTakeNumber, selectTake as selectTakeDomain } from "@/domain/takes";
import { getRepo, requireProject } from "./repo";
import { checksum, safeFileName, storage } from "./storage";

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
  const data = await requireProject(str(form, "projectSlug"));
  return { data, repo: getRepo(), slug: data.project.slug };
}

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

async function storeFile(
  projectId: string,
  file: File,
  type: Asset["type"],
  source: Asset["source"],
  extra: { durationMs?: number | null } = {},
): Promise<Asset> {
  const id = randomUUID();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const storagePath = `${projectId}/${id}/${safeFileName(file.name)}`;
  await storage.put(storagePath, bytes);
  return assetSchema.parse({
    id,
    projectId,
    type,
    name: file.name,
    mime: file.type || null,
    storagePath,
    width: null,
    height: null,
    durationMs: extra.durationMs ?? null,
    checksum: checksum(bytes),
    source,
    tags: [],
    metadata: {},
    uploadedAt: now(),
  });
}

const hasFile = (f: FormData, k: string): File | null => {
  const v = f.get(k);
  return v instanceof File && v.size > 0 ? v : null;
};

// ───────────────────────── Projects & bible ─────────────────────────

export async function createProject(form: FormData) {
  const title = str(form, "title");
  if (!title) throw new Error("Title is required");
  const repo = getRepo();
  const existing = new Set((await repo.listProjects()).map((p) => p.slug));
  let slug = slugify(title);
  while (existing.has(slug)) slug = `${slug}-${randomUUID().slice(0, 4)}`;
  const id = randomUUID();
  const project = projectSchema.parse({
    id,
    userId: repo.currentUserId(),
    title,
    slug,
    projectType: str(form, "projectType") || "series",
    description: str(form, "description"),
    genre: str(form, "genre"),
    tone: str(form, "tone"),
    defaultLanguage: str(form, "defaultLanguage") || "en",
    productionStatus: "development",
    createdAt: now(),
    updatedAt: now(),
  });
  const bible = bibleSchema.parse({
    projectId: id,
    premise: "",
    genre: project.genre,
    tone: project.tone,
    visualStyle: "",
    cinematographyRules: [],
    colorLanguage: "",
    aspectRatio: "16:9",
    defaultFrameRate: 24,
    dialogueLanguageStrategy: "",
    subtitleStrategy: "",
    audioPhilosophy: "",
    canonFacts: [],
    continuityRules: [],
    guardrails: [
      "Never silently rewrite approved dialogue.",
      "Never change a locked character Look.",
      "Never add characters not assigned to a shot.",
      "Never change a locked location/set.",
    ],
    updatedAt: now(),
  });
  await repo.createProject(project, bible);
  revalidatePath("/");
  redirect(`/projects/${slug}`);
}

export async function saveProject(form: FormData) {
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

export async function saveBible(form: FormData) {
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

// ───────────────────────── Characters / looks / voices ─────────────────────────

export async function saveCharacter(form: FormData) {
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

export async function saveLook(form: FormData) {
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
  if (existing?.locked) throw new Error("Look is locked; unlock it before editing.");
  await repo.upsert(data.project.id, "looks", look);
  refresh(slug);
}

export async function setLookLocked(form: FormData) {
  const { data, repo, slug } = await load(form);
  const look = data.looks.find((l) => l.id === str(form, "id"));
  if (!look) throw new Error("Look not found");
  await repo.upsert(data.project.id, "looks", { ...look, locked: str(form, "locked") === "true" });
  refresh(slug);
}

export async function saveVoiceProfile(form: FormData) {
  const { data, repo, slug } = await load(form);
  const existing = data.voiceProfiles.find((v) => v.id === str(form, "id"));
  if (existing?.locked) throw new Error("Voice profile is locked.");
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

export async function setVoiceLocked(form: FormData) {
  const { data, repo, slug } = await load(form);
  const v = data.voiceProfiles.find((x) => x.id === str(form, "id"));
  if (!v) throw new Error("Voice profile not found");
  await repo.upsert(data.project.id, "voiceProfiles", { ...v, locked: str(form, "locked") === "true" });
  refresh(slug);
}

export async function uploadIdentityRef(form: FormData) {
  const { data, repo, slug } = await load(form);
  const file = hasFile(form, "file");
  if (!file) throw new Error("Choose an image");
  const slot = str(form, "slot") as (typeof IDENTITY_SLOTS)[number];
  const asset = await storeFile(data.project.id, file, "reference", "upload");
  await repo.upsert(data.project.id, "assets", { ...asset, tags: ["identity"] });
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

export async function setIdentityLocked(form: FormData) {
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

export async function saveLocation(form: FormData) {
  const { data, repo, slug } = await load(form);
  const existing = data.locations.find((l) => l.id === str(form, "id"));
  if (existing?.locked) throw new Error("Location is locked; unlock it before editing.");
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
  });
  await repo.upsert(data.project.id, "locations", location);
  refresh(slug);
}

export async function setLocationLocked(form: FormData) {
  const { data, repo, slug } = await load(form);
  const l = data.locations.find((x) => x.id === str(form, "id"));
  if (!l) throw new Error("Location not found");
  await repo.upsert(data.project.id, "locations", { ...l, locked: str(form, "locked") === "true" });
  refresh(slug);
}

// ───────────────────────── Episodes / script / scenes ─────────────────────────

export async function createEpisode(form: FormData) {
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

/** Parse the script and reconcile it with stored scenes/lines, preserving IDs and locked dialogue. */
export async function saveScript(form: FormData) {
  const { data, repo, slug } = await load(form);
  const episode = data.episodes.find((e) => e.id === str(form, "episodeId"));
  if (!episode) throw new Error("Episode not found");
  const text = String(form.get("scriptText") ?? "");
  const parsed = parseScreenplay(text);
  const epScenes = data.scenes.filter((s) => s.episodeId === episode.id);
  const epLines = data.dialogueLines.filter((l) => l.episodeId === episode.id);
  const nameOf = (l: (typeof epLines)[number]) =>
    l.characterId
      ? (data.characters.find((c) => c.id === l.characterId)?.name.toUpperCase() ?? l.speakerLabel)
      : l.speakerLabel;
  const sync = syncScript(parsed, epScenes, epLines, nameOf);

  const characterByCue = new Map(data.characters.map((c) => [c.name.toUpperCase(), c.id]));
  const locationByName = (name: string) =>
    data.locations.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  let lineOrder = 0;

  for (const [index, s] of sync.scenes.entries()) {
    const prev = epScenes.find((x) => x.id === s.existingId);
    const scene = sceneSchema.parse({
      id: prev?.id ?? randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      sceneNumber: prev?.sceneNumber ?? String(index + 1),
      slugline: s.parsed.slugline,
      intExt: s.parsed.intExt,
      locationId: locationByName(s.parsed.location) ?? prev?.locationId ?? null,
      timeOfDay: s.parsed.timeOfDay,
      summary: prev?.summary ?? "",
      dramaticPurpose: prev?.dramaticPurpose ?? "",
      emotionEntering: prev?.emotionEntering ?? "",
      emotionLeaving: prev?.emotionLeaving ?? "",
      scriptRange: { startLine: s.parsed.startLine, endLine: s.parsed.endLine },
      characterIds: prev?.characterIds ?? [],
      propIds: prev?.propIds ?? [],
      continuityNotes: prev?.continuityNotes ?? "",
      order: index,
    });
    await repo.upsert(data.project.id, "scenes", scene);

    for (const l of s.lines) {
      const prevLine = epLines.find((x) => x.id === l.existingId);
      const characterId = characterByCue.get(l.parsed.speaker.toUpperCase()) ?? null;
      const line = dialogueLineSchema.parse({
        id: prevLine?.id ?? randomUUID(),
        projectId: data.project.id,
        episodeId: episode.id,
        sceneId: scene.id,
        characterId,
        speakerLabel: l.parsed.speaker.toUpperCase(),
        // Locked dialogue is never rewritten by a script edit.
        originalText: prevLine?.locked ? prevLine.originalText : l.parsed.text,
        language: prevLine?.language ?? data.project.defaultLanguage,
        translation: prevLine?.translation ?? null,
        pronunciationNotes: prevLine?.pronunciationNotes ?? "",
        dramaticContext: prevLine?.dramaticContext ?? "",
        subtext: prevLine?.subtext ?? "",
        locked: prevLine?.locked ?? false,
        order: lineOrder++,
      });
      await repo.upsert(data.project.id, "dialogueLines", line);
    }
  }

  // Remove scenes/lines no longer in the script only when nothing downstream depends on them.
  const usedLineIds = new Set(data.shots.flatMap((s) => s.audio.dialogueLineIds));
  for (const id of sync.removedLineIds) {
    const hasTakes = data.takes.some((t) => t.dialogueLineId === id);
    if (!usedLineIds.has(id) && !hasTakes) await repo.remove(data.project.id, "dialogueLines", id);
  }
  for (const id of sync.removedSceneIds) {
    if (!data.shots.some((s) => s.sceneId === id)) await repo.remove(data.project.id, "scenes", id);
  }

  await repo.upsert(data.project.id, "episodes", { ...episode, scriptText: text, updatedAt: now() });
  refresh(slug);
}

export async function saveScene(form: FormData) {
  const { data, repo, slug } = await load(form);
  const scene = data.scenes.find((s) => s.id === str(form, "id"));
  if (!scene) throw new Error("Scene not found");
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

export async function createShot(form: FormData) {
  const { data, repo, slug } = await load(form);
  const scene = data.scenes.find((s) => s.id === str(form, "sceneId"));
  if (!scene) throw new Error("Scene not found");
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
  if (!shot) throw new Error("Shot not found");
  return { ...base, shot };
}

async function saveShot(projectId: string, shot: Shot, slug: string) {
  const parsed = shotSchema.parse({ ...shot, updatedAt: now() });
  await getRepo().upsert(projectId, "shots", parsed);
  refresh(slug);
}

export async function saveShotSection(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const spec = SHOT_SECTION_SPECS.find((s) => s.key === str(form, "section"));
  if (!spec) throw new Error("Unknown section");
  await saveShot(data.project.id, applySection(shot, spec, form), slug);
}

export async function saveShotCharacters(form: FormData) {
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

export async function saveShotDialogue(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const ids = form.getAll("lineId").map(String);
  await saveShot(data.project.id, { ...shot, audio: { ...shot.audio, dialogueLineIds: ids } }, slug);
}

export async function saveShotBeats(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const beats = lines(form, "beats").map((l, order) => {
    const [at, ...rest] = l.split("|");
    const hasTime = rest.length > 0 && !Number.isNaN(Number(at));
    return {
      id: randomUUID(),
      order,
      atMs: hasTime ? Math.round(Number(at) * 1000) : 0,
      description: (hasTime ? rest.join("|") : l).trim(),
    };
  });
  const marks = lines(form, "marks").map((l) => {
    const [label, x, y, notes] = l.split("|").map((p) => p.trim());
    return { label: label ?? "", x: Number(x) || 0, y: Number(y) || 0, notes: notes ?? "" };
  });
  await saveShot(
    data.project.id,
    { ...shot, action: { ...shot.action, beats }, spatial: { ...shot.spatial, marks } },
    slug,
  );
}

export async function setShotApproval(form: FormData) {
  const { data, shot, slug } = await loadShot(form);
  const gate = str(form, "gate") as keyof Shot["approval"];
  if (!["storyboardApproved", "performanceApproved", "continuityApproved"].includes(gate))
    throw new Error("Unknown gate");
  await saveShot(
    data.project.id,
    { ...shot, approval: { ...shot.approval, [gate]: str(form, "value") === "true" } },
    slug,
  );
}

export async function setShotDuration(form: FormData) {
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

export async function reorderShots(sceneId: string, orderedIds: string[], projectSlug: string) {
  const data = await requireProject(projectSlug);
  const sceneShots = data.shots.filter((s) => s.sceneId === sceneId);
  const byId = new Map(sceneShots.map((s) => [s.id, s]));
  if (orderedIds.length !== sceneShots.length || orderedIds.some((id) => !byId.has(id)))
    throw new Error("Invalid order");
  // Express the requested order as a sequence of rule-checked single moves.
  let current = [...sceneShots].sort((a, b) => a.order - b.order);
  orderedIds.forEach((id, target) => {
    if (current[target].id !== id && byId.get(id)?.status !== "locked") {
      current = reorderShotsInScene(current, id, target);
    }
  });
  await getRepo().upsertMany(
    data.project.id,
    "shots",
    current.map((s) => ({ ...s, updatedAt: now() })),
  );
  refresh(projectSlug);
}

// ───────────────────────── Performance ─────────────────────────

export async function saveDialogueLine(form: FormData) {
  const { data, repo, slug } = await load(form);
  const line = data.dialogueLines.find((l) => l.id === str(form, "lineId"));
  if (!line) throw new Error("Line not found");
  const text = str(form, "originalText");
  if (line.locked && text !== line.originalText)
    throw new Error("Dialogue is locked; unlock it to change the text.");
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

export async function setLineLocked(form: FormData) {
  const { data, repo, slug } = await load(form);
  const line = data.dialogueLines.find((l) => l.id === str(form, "lineId"));
  if (!line) throw new Error("Line not found");
  await repo.upsert(data.project.id, "dialogueLines", { ...line, locked: str(form, "locked") === "true" });
  refresh(slug);
}

export async function saveDirection(form: FormData) {
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

export async function addTake(form: FormData) {
  const { data, repo, slug } = await load(form);
  const line = data.dialogueLines.find((l) => l.id === str(form, "lineId"));
  if (!line) throw new Error("Line not found");
  const durationMs = Math.round(Number(str(form, "durationSec")) * 1000);
  if (!durationMs || durationMs <= 0) throw new Error("Duration is required");
  const sourceRaw = str(form, "sourceType");
  const sourceType = (TAKE_SOURCES as readonly string[]).includes(sourceRaw) ? sourceRaw : "temp_voice";

  let audioAssetId: string | null = null;
  const file = hasFile(form, "file");
  if (file) {
    const asset = await storeFile(
      data.project.id,
      file,
      "audio",
      sourceType === "human_recording" ? "recording" : "upload",
      { durationMs },
    );
    await repo.upsert(data.project.id, "assets", asset);
    audioAssetId = asset.id;
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
    waveform: null,
    transcript: str(form, "transcript"),
    takeNumber: nextTakeNumber(existing, line.id),
    notes: str(form, "notes"),
    rating: Math.max(0, Math.min(5, int(form, "rating", 0))),
    // First take becomes canonical by default so downstream timing has something to use.
    selected: existing.length === 0,
    createdAt: now(),
  });
  await repo.upsert(data.project.id, "takes", take);
  refresh(slug);
}

export async function selectTake(form: FormData) {
  const { data, repo, slug } = await load(form);
  const lineId = data.takes.find((t) => t.id === str(form, "takeId"))?.dialogueLineId;
  if (!lineId) throw new Error("Take not found");
  const updated = selectTakeDomain(data.takes, str(form, "takeId")).filter(
    (t) => t.dialogueLineId === lineId,
  );
  await repo.upsertMany(data.project.id, "takes", updated);
  refresh(slug);
}

export async function rateTake(form: FormData) {
  const { data, repo, slug } = await load(form);
  const take = data.takes.find((t) => t.id === str(form, "takeId"));
  if (!take) throw new Error("Take not found");
  await repo.upsert(data.project.id, "takes", {
    ...take,
    rating: Math.max(0, Math.min(5, int(form, "rating", 0))),
    notes: form.has("notes") ? str(form, "notes") : take.notes,
  });
  refresh(slug);
}

// ───────────────────────── Storyboard ─────────────────────────

export async function addStoryboardFrame(form: FormData) {
  const { data, repo, slug } = await load(form);
  const shotId = str(form, "shotId");
  if (!data.shots.some((s) => s.id === shotId)) throw new Error("Shot not found");
  const file = hasFile(form, "file");
  let assetId: string | null = null;
  const sourceRaw = str(form, "source");
  const source =
    (["upload", "generated", "3d_preview", "sketch"] as const).find((s) => s === sourceRaw) ?? "upload";
  if (file) {
    const asset = await storeFile(
      data.project.id,
      file,
      "image",
      source === "upload" ? "upload" : source === "sketch" ? "sketch" : source,
    );
    await repo.upsert(data.project.id, "assets", { ...asset, tags: ["storyboard"] });
    assetId = asset.id;
  }
  const version =
    data.frames.filter((f) => f.shotId === shotId).reduce((m, f) => Math.max(m, f.version), 0) + 1;
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
      createdAt: now(),
    }),
  );
  refresh(slug);
}

export async function setFrameApproved(form: FormData) {
  const { data, repo, slug } = await load(form);
  const frame = data.frames.find((f) => f.id === str(form, "frameId"));
  if (!frame) throw new Error("Frame not found");
  const approve = str(form, "approved") === "true";
  const siblings = data.frames.filter((f) => f.shotId === frame.shotId);
  // At most one approved frame per shot.
  // Write the target last so the "one approved frame per shot" index is never violated mid-way.
  const ordered = [...siblings.filter((f) => f.id !== frame.id), frame];
  for (const f of ordered) {
    const approved = f.id === frame.id ? approve : approve ? false : f.approved;
    if (approved !== f.approved) await repo.upsert(data.project.id, "frames", { ...f, approved });
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

/** Records an attempt with a frozen package snapshot. Providers are not integrated yet; attempts are logged manually. */
export async function logAttempt(form: FormData) {
  const { data, shot, repo, slug } = await loadShot(form);
  const pkg = assembleGenerationPackage(buildShotContext(data, shot.id));
  const existing = data.attempts.filter((a) => a.shotId === shot.id);
  const attemptNumber = existing.reduce((m, a) => Math.max(m, a.attemptNumber), 0) + 1;
  const status = str(form, "status") || "rejected";
  const approved = status === "approved";
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
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: str(form, "costUsd") ? Number(str(form, "costUsd")) : null,
    durationMs: pkg.timing.durationMs || null,
    status,
    rejectionReason: str(form, "rejectionReason"),
    notes: str(form, "notes"),
    approved,
    createdAt: now(),
  });
  if (approved) {
    for (const a of existing.filter((x) => x.approved))
      await repo.upsert(data.project.id, "attempts", { ...a, approved: false });
  }
  await repo.upsert(data.project.id, "attempts", attempt);
  refresh(slug);
}

/** Review fields only; prompt, package snapshot and settings of an attempt are immutable. */
export async function reviewAttempt(form: FormData) {
  const { data, repo, slug } = await load(form);
  const attempt = data.attempts.find((a) => a.id === str(form, "attemptId"));
  if (!attempt) throw new Error("Attempt not found");
  const status = str(form, "status") || attempt.status;
  const approved = status === "approved";
  if (approved) {
    for (const a of data.attempts.filter(
      (x) => x.shotId === attempt.shotId && x.approved && x.id !== attempt.id,
    )) {
      await repo.upsert(data.project.id, "attempts", { ...a, approved: false });
    }
  }
  await repo.upsert(
    data.project.id,
    "attempts",
    generationAttemptSchema.parse({
      ...attempt,
      status,
      approved,
      rejectionReason: str(form, "rejectionReason"),
      notes: str(form, "notes"),
    }),
  );
  refresh(slug);
}

export async function saveContinuityCheck(form: FormData) {
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
