import { computeShotDuration, selectedTake, type ShotDuration } from "./duration";
import type { SpatialReference } from "./previs/spatial";
import type {
  ActionBlock,
  Asset,
  Character,
  CharacterLook,
  DialogueLine,
  Episode,
  IdentityRef,
  Location,
  PerformanceDirection,
  PerformanceTake,
  Project,
  ProjectBible,
  ProjectData,
  Prop,
  Scene,
  Shot,
  ShotCharacter,
  StoryboardFrame,
  VoiceProfile,
} from "./schemas";

export interface ShotCharacterContext {
  assignment: ShotCharacter;
  character: Character | null;
  look: CharacterLook | null;
  identityRefs: IdentityRef[];
  voiceProfiles: VoiceProfile[];
}

export interface ShotLineContext {
  line: DialogueLine;
  character: Character | null;
  direction: PerformanceDirection | null;
  takes: PerformanceTake[];
  selectedTake: PerformanceTake | null;
  selectedAudioAsset: Asset | null;
}

/** Everything the domain services need to reason about one shot. Pure data, built from ProjectData. */
export interface ShotContext {
  project: Project;
  bible: ProjectBible;
  episode: Episode;
  scene: Scene;
  shot: Shot;
  previousShot: Shot | null;
  nextShot: Shot | null;
  isFirstInEpisode: boolean;
  location: Location | null;
  characters: ShotCharacterContext[];
  props: Prop[];
  lines: ShotLineContext[];
  frames: StoryboardFrame[];
  approvedFrame: StoryboardFrame | null;
  assets: Map<string, Asset>;
  duration: ShotDuration;
  /** Script content this shot links to, resolved from shot.scriptSources / audio.dialogueLineIds. */
  sourceActions: ActionBlock[];
  sourceDialogue: DialogueLine[];
  /** Frozen into the GenerationPackage when the Shot has a 3D set (Phase 2F). Absent = no 3D set. */
  spatial?: SpatialReference | null;
}

export function buildShotContext(data: ProjectData, shotId: string): ShotContext {
  const shot = data.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error(`Shot ${shotId} not found`);
  const episode = data.episodes.find((e) => e.id === shot.episodeId);
  const scene = data.scenes.find((s) => s.id === shot.sceneId);
  if (!episode || !scene) throw new Error(`Shot ${shot.shotCode} references a missing episode or scene`);

  const episodeShots = data.shots.filter((s) => s.episodeId === shot.episodeId).sort(shotOrder(data));
  const index = episodeShots.findIndex((s) => s.id === shot.id);
  const previousShot =
    (shot.continuity.previousShotId && data.shots.find((s) => s.id === shot.continuity.previousShotId)) ||
    null;
  const assets = new Map(data.assets.map((a) => [a.id, a]));

  const characters = shot.characters.map<ShotCharacterContext>((assignment) => ({
    assignment,
    character: data.characters.find((c) => c.id === assignment.characterId) ?? null,
    look: data.looks.find((l) => l.id === assignment.lookId) ?? null,
    identityRefs: data.identityRefs.filter((r) => r.characterId === assignment.characterId),
    voiceProfiles: data.voiceProfiles.filter((v) => v.characterId === assignment.characterId),
  }));

  const lines = shot.audio.dialogueLineIds
    .map((lineId) => data.dialogueLines.find((l) => l.id === lineId))
    .filter((l): l is DialogueLine => Boolean(l))
    .map<ShotLineContext>((line) => {
      const takes = data.takes.filter((t) => t.dialogueLineId === line.id);
      const picked = selectedTake(takes, line.id);
      return {
        line,
        character: data.characters.find((c) => c.id === line.characterId) ?? null,
        direction: data.directions.find((d) => d.dialogueLineId === line.id) ?? null,
        takes,
        selectedTake: picked,
        selectedAudioAsset: picked?.audioAssetId ? (assets.get(picked.audioAssetId) ?? null) : null,
      };
    });

  const frames = data.frames.filter((f) => f.shotId === shot.id).sort((a, b) => b.version - a.version);
  const lineTakes = lines.flatMap((l) => l.takes);

  return {
    project: data.project,
    bible: data.bible,
    episode,
    scene,
    shot,
    previousShot,
    nextShot: episodeShots[index + 1] ?? null,
    isFirstInEpisode: index === 0,
    location: data.locations.find((l) => l.id === shot.spatial.locationId) ?? null,
    characters,
    props: data.props.filter((p) => shot.propIds.includes(p.id)),
    lines,
    frames,
    approvedFrame: frames.find((f) => f.approved) ?? null,
    assets,
    duration: computeShotDuration(shot, lineTakes),
    sourceActions: shot.scriptSources.actionBlockIds
      .map((id) => data.actionBlocks.find((b) => b.id === id))
      .filter((b): b is ActionBlock => Boolean(b)),
    sourceDialogue: [...new Set([...shot.scriptSources.dialogueLineIds, ...shot.audio.dialogueLineIds])]
      .map((id) => data.dialogueLines.find((l) => l.id === id))
      .filter((l): l is DialogueLine => Boolean(l)),
    ...(data.spatialReferences?.[shot.id] ? { spatial: data.spatialReferences[shot.id] } : {}),
  };
}

/** Episode-wide shot order: scene order first, then shot order within the scene. */
export function shotOrder(data: Pick<ProjectData, "scenes">) {
  const sceneOrder = new Map(data.scenes.map((s) => [s.id, s.order]));
  return (a: Shot, b: Shot) =>
    (sceneOrder.get(a.sceneId) ?? 0) - (sceneOrder.get(b.sceneId) ?? 0) || a.order - b.order;
}
