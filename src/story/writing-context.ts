import type { Episode, ProjectData } from "@/domain/schemas";
import { sceneRanges } from "@/domain/story/revisions";
import type { WritingScope } from "@/domain/story/writing";
import type { WritingContext } from "./writing-prompt";

/**
 * Phase 5B-S2: the TEXTUAL project context a writing request carries (frozen on the proposal, so the Story worker
 * reads only that row). Character notes keep voices consistent; the Scene's summary and neighbours keep continuity;
 * the recent turns of the session let the creator say "Version 2, but warmer" without restating the Scene. No image,
 * Visual Bible binary or other project content is included. Pure.
 */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const MAX_CHARACTERS = 12;

export function buildWritingContext(args: {
  data: ProjectData;
  episode: Episode;
  /** The canonical (LF) screenplay. */
  text: string;
  scope: WritingScope;
  instruction: string;
  conversation: WritingContext["conversation"];
}): WritingContext {
  const { data, episode, text, scope } = args;
  const scene = scope.sceneId ? (data.scenes.find((s) => s.id === scope.sceneId) ?? null) : null;
  const range = scope.sceneId ? (sceneRanges(text, data, episode.id).get(scope.sceneId) ?? null) : null;
  const passage = range ? text.slice(range.start, range.end) : text.slice(scope.start, scope.end);

  // Characters: in the Scene, speaking in the passage, or named by the creator (Episode scope: everyone, capped).
  const cues = new Set(
    passage
      .split("\n")
      .map((l) =>
        l
          .trim()
          .replace(/\s*\(.*\)$/, "")
          .toUpperCase(),
      )
      .filter(Boolean),
  );
  const wanted = data.characters.filter(
    (c) =>
      scope.kind === "episode" ||
      scene?.characterIds.includes(c.id) ||
      cues.has(c.name.toUpperCase()) ||
      passage.toUpperCase().includes(c.name.toUpperCase()) ||
      args.instruction.toLowerCase().includes(c.name.toLowerCase()),
  );
  const characters = wanted.slice(0, MAX_CHARACTERS).map((c) => ({
    name: c.name,
    role: clip(c.role, 120),
    description: clip(c.description, 400),
    personality: clip(c.personality, 300),
    voice: clip([c.behaviorNotes, c.signatureBehavior].filter((x) => x.trim()).join(" "), 400),
    relationships: clip(c.relationshipNotes, 400),
  }));

  return {
    project: clip(data.project.title, 200),
    episode: clip(`Episode ${episode.number}: ${episode.title}`, 200),
    synopsis: clip(episode.synopsis || data.project.description || "", 1500),
    tone: clip([data.project.genre, data.project.tone].filter((x) => x.trim()).join("; "), 300),
    scene: scene
      ? {
          heading: clip(scene.slugline, 200),
          summary: clip(scene.summary, 800),
          purpose: clip(scene.dramaticPurpose, 400),
          entering: clip(scene.emotionEntering, 200),
          leaving: clip(scene.emotionLeaving, 200),
        }
      : null,
    characters,
    sceneText: scope.kind === "selection" && range ? clip(text.slice(range.start, range.end), 12_000) : null,
    before: scope.kind === "episode" ? "" : text.slice(Math.max(0, scope.start - 1500), scope.start),
    after: scope.kind === "episode" ? "" : text.slice(scope.end, scope.end + 800),
    conversation: args.conversation.slice(-6).map((t) => ({
      instruction: clip(t.instruction, 600),
      reply: clip(t.reply, 600),
      chosen: t.chosen ? clip(t.chosen, 1500) : null,
    })),
  };
}
