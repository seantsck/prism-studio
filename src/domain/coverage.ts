import type { ActionBlock, DialogueLine, ProjectData, Shot } from "./schemas";

/**
 * Deterministic script coverage. No AI: a script element is "covered" when at least one shot links to it
 * (shot.scriptSources for action blocks and dialogue, or shot.audio.dialogueLineIds for performed dialogue).
 */

export interface CoverageItem {
  kind: "action" | "dialogue";
  id: string;
  order: number;
  startLine: number | null;
  speaker: string | null;
  text: string;
  covered: boolean;
  shotIds: string[];
  shotCodes: string[];
}

export interface SceneCoverage {
  sceneId: string;
  sceneNumber: string;
  slugline: string;
  location: string | null;
  timeOfDay: string;
  characters: string[];
  props: string[];
  items: CoverageItem[];
  covered: number;
  total: number;
  /** 0..100, 100 when the scene has no script content. */
  percent: number;
  uncovered: CoverageItem[];
  shots: Array<{ id: string; code: string; title: string }>;
}

export interface EpisodeCoverage {
  episodeId: string;
  scenes: SceneCoverage[];
  covered: number;
  total: number;
  percent: number;
}

const pct = (covered: number, total: number) => (total === 0 ? 100 : Math.round((covered / total) * 100));

/** Shots that cover each source element, keyed by element id. */
function coverageIndex(shots: readonly Shot[]) {
  const action = new Map<string, Shot[]>();
  const dialogue = new Map<string, Shot[]>();
  const add = (m: Map<string, Shot[]>, id: string, shot: Shot) => {
    const list = m.get(id) ?? [];
    if (!list.includes(shot)) list.push(shot);
    m.set(id, list);
  };
  for (const shot of shots) {
    for (const id of shot.scriptSources.actionBlockIds) add(action, id, shot);
    for (const id of shot.scriptSources.dialogueLineIds) add(dialogue, id, shot);
    for (const id of shot.audio.dialogueLineIds) add(dialogue, id, shot);
  }
  return { action, dialogue };
}

export function buildSceneCoverage(data: ProjectData, sceneId: string): SceneCoverage {
  const scene = data.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  const { action, dialogue } = coverageIndex(data.shots);

  const blocks = data.actionBlocks.filter((b) => b.sceneId === sceneId);
  const lines = data.dialogueLines.filter((l) => l.sceneId === sceneId);
  const nameOf = (l: DialogueLine) =>
    data.characters.find((c) => c.id === l.characterId)?.name ?? (l.speakerLabel || null);

  const items: CoverageItem[] = [
    ...blocks.map<CoverageItem>((b: ActionBlock) => {
      const shots = action.get(b.id) ?? [];
      return {
        kind: "action",
        id: b.id,
        order: b.order,
        startLine: b.startLine,
        speaker: null,
        text: b.text,
        covered: shots.length > 0,
        shotIds: shots.map((s) => s.id),
        shotCodes: shots.map((s) => s.shotCode),
      };
    }),
    ...lines.map<CoverageItem>((l) => {
      const shots = dialogue.get(l.id) ?? [];
      return {
        kind: "dialogue",
        id: l.id,
        order: l.order,
        startLine: l.sourceStartLine,
        speaker: nameOf(l),
        text: l.originalText,
        covered: shots.length > 0,
        shotIds: shots.map((s) => s.id),
        shotCodes: shots.map((s) => s.shotCode),
      };
    }),
  ].sort(
    (a, b) =>
      (a.startLine ?? Number.MAX_SAFE_INTEGER) - (b.startLine ?? Number.MAX_SAFE_INTEGER) ||
      a.order - b.order ||
      a.kind.localeCompare(b.kind),
  );

  const covered = items.filter((i) => i.covered).length;
  return {
    sceneId,
    sceneNumber: scene.sceneNumber,
    slugline: scene.slugline,
    location: data.locations.find((l) => l.id === scene.locationId)?.name ?? null,
    timeOfDay: scene.timeOfDay,
    characters: scene.characterIds.map((id) => data.characters.find((c) => c.id === id)?.name ?? "?"),
    props: scene.propIds.map((id) => data.props.find((p) => p.id === id)?.name ?? "?"),
    items,
    covered,
    total: items.length,
    percent: pct(covered, items.length),
    uncovered: items.filter((i) => !i.covered),
    shots: data.shots
      .filter((s) => s.sceneId === sceneId)
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, code: s.shotCode, title: s.title })),
  };
}

export function buildEpisodeCoverage(data: ProjectData, episodeId: string): EpisodeCoverage {
  const scenes = data.scenes
    .filter((s) => s.episodeId === episodeId)
    .sort((a, b) => a.order - b.order)
    .map((s) => buildSceneCoverage(data, s.id));
  const covered = scenes.reduce((n, s) => n + s.covered, 0);
  const total = scenes.reduce((n, s) => n + s.total, 0);
  return { episodeId, scenes, covered, total, percent: pct(covered, total) };
}

export interface ShotSourceContent {
  actions: ActionBlock[];
  dialogue: DialogueLine[];
  /** Lines performed in the shot that are not (also) listed as sources — shown together in Shot Prep. */
  empty: boolean;
}

/** Resolved source script content of a shot (linked action blocks + dialogue it covers or performs). */
export function shotSourceContent(data: ProjectData, shot: Shot): ShotSourceContent {
  const actions = shot.scriptSources.actionBlockIds
    .map((id) => data.actionBlocks.find((b) => b.id === id))
    .filter((b): b is ActionBlock => Boolean(b));
  const lineIds = [...new Set([...shot.scriptSources.dialogueLineIds, ...shot.audio.dialogueLineIds])];
  const dialogue = lineIds
    .map((id) => data.dialogueLines.find((l) => l.id === id))
    .filter((l): l is DialogueLine => Boolean(l));
  return { actions, dialogue, empty: actions.length === 0 && dialogue.length === 0 };
}
