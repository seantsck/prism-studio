import { parseScreenplay, syncScript } from "@/domain/script";
import type { ProjectData } from "@/domain/schemas";
import { parsedSceneRanges } from "./writing";

/**
 * Phase 5B-S2: what an accepted screenplay change does to EXISTING structure. Pure.
 *
 * The Scenes of the old and the new text are matched to their stored ids with the same stable-id sync the Script page
 * uses; a Scene whose block text differs (or that vanished) changed. Only Scenes with production breakdown — Shots, or
 * a written summary — are flagged "Story changed after production breakdown". Nothing is deleted or rewritten here.
 */
export const REVISION_ORIGINS = ["baseline", "import", "creator_edit", "ai_revision", "restore"] as const;
export type RevisionOrigin = (typeof REVISION_ORIGINS)[number];

export const ORIGIN_LABEL: Record<RevisionOrigin, string> = {
  baseline: "Script before Prism AI history began",
  import: "Original imported source",
  creator_edit: "Creator edit",
  ai_revision: "Creator-approved Prism AI revision",
  restore: "Restored earlier revision",
};

export interface SceneRange {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  slugline: string;
}

/**
 * Where each stored Scene of the Episode lies in `text` (canonical, LF), matched with the stable-id sync: character
 * offsets and 1-based lines, trailing blank lines trimmed. Scenes not found in the text are absent.
 */
export function sceneRanges(text: string, data: ProjectData, episodeId: string): Map<string, SceneRange> {
  const ranges = parsedSceneRanges(text);
  const scenes = data.scenes.filter((s) => s.episodeId === episodeId);
  const sync = syncScript(parseScreenplay(text), scenes, [], (l) => l.speakerLabel);
  const out = new Map<string, SceneRange>();
  sync.scenes.forEach((s, i) => {
    if (s.existingId && ranges[i]) out.set(s.existingId, ranges[i]!);
  });
  return out;
}

function sceneTexts(text: string, data: ProjectData, episodeId: string): Map<string, string> {
  const lines = text.split("\n");
  const scenes = data.scenes.filter((s) => s.episodeId === episodeId);
  const dl = data.dialogueLines.filter((l) => l.episodeId === episodeId);
  const sync = syncScript(
    parseScreenplay(text),
    scenes,
    dl,
    (l) =>
      l.characterId
        ? (data.characters.find((c) => c.id === l.characterId)?.name.toUpperCase() ?? l.speakerLabel)
        : l.speakerLabel,
    data.actionBlocks.filter((a) => a.episodeId === episodeId),
  );
  const out = new Map<string, string>();
  for (const s of sync.scenes)
    if (s.existingId)
      out.set(
        s.existingId,
        lines
          .slice(s.parsed.startLine - 1, s.parsed.endLine)
          .join("\n")
          .trim(),
      );
  return out;
}

export function changedSceneIds(
  oldText: string,
  newText: string,
  data: ProjectData,
  episodeId: string,
): { changed: string[]; withBreakdown: string[] } {
  const before = sceneTexts(oldText, data, episodeId);
  const after = sceneTexts(newText, data, episodeId);
  const changed = [...before.keys()].filter((id) => before.get(id) !== after.get(id));
  const withBreakdown = changed.filter((id) => {
    const scene = data.scenes.find((s) => s.id === id);
    return data.shots.some((sh) => sh.sceneId === id) || Boolean(scene?.summary.trim());
  });
  return { changed, withBreakdown };
}
