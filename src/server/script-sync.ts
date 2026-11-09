import "server-only";
import { randomUUID } from "node:crypto";
import { WritingError } from "@/data/writing-repository";
import type { Repository } from "@/data/repository";
import { parseScreenplay, syncScript } from "@/domain/script";
import {
  actionBlockSchema,
  dialogueLineSchema,
  sceneSchema,
  type Episode,
  type ProjectData,
} from "@/domain/schemas";
import { changedSceneIds } from "@/domain/story/revisions";
import { sourceFingerprint } from "@/domain/story/source";
import { requireUser } from "./auth";
import { getWritingRepo } from "./story";

/**
 * The ONE way an Episode's screenplay text changes (the Script page's "Save & sync structure", an accepted Prism AI
 * revision, a restored revision): parse the text and reconcile it with the stored Scenes / dialogue lines / action
 * blocks, preserving ids and locked dialogue, then store it as the Episode's canonical script. Scenes and lines that
 * vanished are removed only when nothing downstream depends on them (unchanged pre-S2 behaviour).
 */
const now = () => new Date().toISOString();

export async function syncEpisodeScript(data: ProjectData, repo: Repository, episode: Episode, text: string) {
  const parsed = parseScreenplay(text);
  const epScenes = data.scenes.filter((s) => s.episodeId === episode.id);
  const epLines = data.dialogueLines.filter((l) => l.episodeId === episode.id);
  const nameOf = (l: (typeof epLines)[number]) =>
    l.characterId
      ? (data.characters.find((c) => c.id === l.characterId)?.name.toUpperCase() ?? l.speakerLabel)
      : l.speakerLabel;
  const epActions = data.actionBlocks.filter((a) => a.episodeId === episode.id);
  const sync = syncScript(parsed, epScenes, epLines, nameOf, epActions);

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
        sourceStartLine: l.parsed.line,
        sourceEndLine: l.parsed.endLine,
      });
      await repo.upsert(data.project.id, "dialogueLines", line);
    }

    // Action paragraphs get stable ids too, so shots can reference them and coverage can be computed.
    for (const [order, a] of s.actions.entries()) {
      await repo.upsert(
        data.project.id,
        "actionBlocks",
        actionBlockSchema.parse({
          id: a.existingId ?? randomUUID(),
          projectId: data.project.id,
          episodeId: episode.id,
          sceneId: scene.id,
          text: a.parsed.text,
          order,
          startLine: a.parsed.line,
          endLine: a.parsed.endLine,
        }),
      );
    }
  }

  // Blocks that vanished from the script: unlink them from shots first, so no shot points at nothing.
  for (const id of sync.removedActionIds) {
    for (const shot of data.shots.filter((x) => x.scriptSources.actionBlockIds.includes(id))) {
      await repo.upsert(data.project.id, "shots", {
        ...shot,
        scriptSources: {
          ...shot.scriptSources,
          actionBlockIds: shot.scriptSources.actionBlockIds.filter((x) => x !== id),
        },
        updatedAt: now(),
      });
    }
    await repo.remove(data.project.id, "actionBlocks", id);
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
}

export async function actorId(): Promise<string | null> {
  const user = await requireUser();
  return user.kind === "supabase" ? user.id : null;
}

/**
 * Phase 5B-S2: a manual script save is recorded as an immutable "Creator edit" revision BEFORE the text changes (with
 * the previous text as the baseline when the Episode has no history yet), and Scenes with production breakdown whose
 * text changed are flagged "Story changed after production breakdown". A database without migration 0055 (undefined
 * table) keeps the pre-S2 behaviour: the save proceeds without history.
 */
export async function recordCreatorEdit(data: ProjectData, episode: Episode, text: string) {
  if (text === episode.scriptText) return;
  const scenes = changedSceneIds(episode.scriptText, text, data, episode.id);
  try {
    await (
      await getWritingRepo({ startInlineWorker: false })
    ).recordRevision({
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      origin: "creator_edit",
      text,
      fingerprint: sourceFingerprint(text),
      previousText: episode.scriptText,
      changedSceneIds: scenes.changed,
      flagSceneIds: scenes.withBreakdown,
      createdBy: await actorId(),
      createdAt: now(),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "42P01" && !(err instanceof WritingError)) return;
    throw err;
  }
}

/**
 * Phase 5B-S2: an Episode created by Apply selected (S1) starts its history with its ORIGINAL IMPORTED SOURCE, linked to
 * the Story proposal, so later creator-approved AI revisions are never mistaken for words from the uploaded screenplay.
 */
export async function recordImportedScript(
  projectId: string,
  episodeId: string,
  text: string,
  storyProposalId: string,
) {
  try {
    await (
      await getWritingRepo({ startInlineWorker: false })
    ).recordRevision({
      id: randomUUID(),
      projectId,
      episodeId,
      origin: "import",
      text,
      fingerprint: sourceFingerprint(text),
      previousText: null,
      storyProposalId,
      createdBy: await actorId(),
      createdAt: now(),
    });
  } catch (err) {
    if ((err as { code?: string }).code === "42P01" && !(err instanceof WritingError)) return;
    throw err;
  }
}
