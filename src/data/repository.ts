import type {
  Asset,
  CollectionName,
  Collections,
  Project,
  ProjectBible,
  ProjectData,
} from "@/domain/schemas";

/**
 * Persistence boundary. The app only talks to this interface.
 * Today: MemoryRepository (seeded, in-process). Later: a Supabase adapter implementing the same
 * contract against the SQL migrations in /supabase/migrations.
 */
export interface Repository {
  /** Owner of every project this repository exposes. */
  currentUserId(): string;
  listProjects(): Promise<Project[]>;
  /** A project of the owner's, by slug; one in the Trash only with `includeTrashed` (to delete it for good). */
  loadProject(slug: string, opts?: { includeTrashed?: boolean }): Promise<ProjectData | null>;
  createProject(project: Project, bible: ProjectBible): Promise<void>;
  updateProject(project: Project): Promise<void>;
  saveBible(bible: ProjectBible): Promise<void>;
  upsert<K extends CollectionName>(projectId: string, name: K, item: Collections[K][number]): Promise<void>;
  upsertMany<K extends CollectionName>(projectId: string, name: K, items: Collections[K]): Promise<void>;
  remove(projectId: string, name: CollectionName, id: string): Promise<void>;
  findAsset(assetId: string): Promise<Asset | null>;
  /**
   * Which of the owner's projects are archived. `available: false` when this database cannot record it yet
   * (migration 0060 not applied): then nothing is archived and Archive is offered as unavailable.
   */
  archivedProjectIds(): Promise<{ ids: Set<string>; available: boolean }>;
  /** Archives (hides, keeps everything) or restores one of the owner's projects. */
  setProjectArchived(projectId: string, archived: boolean): Promise<void>;
  /** Work still queued or running for the project (one line per kind, e.g. "2 image generations"); empty = none. */
  activeProjectWork(projectId: string): Promise<string[]>;
  /** Deletes one of the owner's projects and everything in it. Irreversible; callers confirm first. */
  deleteProject(projectId: string): Promise<void>;
  /**
   * The owner's projects in the Trash (out of `listProjects`, and `loadProject` does not open them), newest first.
   * `available: false` when this database cannot record it yet (migration 0063 not applied).
   */
  trashedProjects(): Promise<{
    projects: Array<{ project: Project; trashedAt: string }>;
    available: boolean;
  }>;
  /** Moves one of the owner's projects to the Trash, or restores it. */
  setProjectTrashed(projectId: string, trashed: boolean): Promise<void>;
  /**
   * The owner's character library: which Characters (in which of their projects) are saved, newest first.
   * `available: false` when this database cannot record it yet (migration 0062 not applied).
   */
  libraryEntries(): Promise<{ entries: LibraryEntry[]; available: boolean }>;
  /** Saves one of the owner's Characters to their library, or takes it out (idempotent either way). */
  setInLibrary(projectId: string, characterId: string, saved: boolean): Promise<void>;
  /** The owner's location library (`available: false` until migration 0066 is applied), newest first. */
  locationLibraryEntries(): Promise<{ entries: LocationLibraryEntry[]; available: boolean }>;
  /** Saves one of the owner's Locations to their library, or takes it out (idempotent either way). */
  setLocationInLibrary(projectId: string, locationId: string, saved: boolean): Promise<void>;
}

/** This database cannot put projects in the Trash yet (migration 0063 is not applied). */
export class ProjectTrashUnavailableError extends Error {
  constructor() {
    super(
      "Deleting projects (to the Trash) needs a one-time database update (migration 0063) that has not been applied yet.",
    );
    this.name = "ProjectTrashUnavailableError";
  }
}

/** One Character in the owner's library: it lives in its own project and is copied into others. */
export interface LibraryEntry {
  characterId: string;
  projectId: string;
  savedAt: string;
}

/** One Location in the owner's library: it lives in its own project and is copied into others. */
export interface LocationLibraryEntry {
  locationId: string;
  projectId: string;
  savedAt: string;
}

/** This database cannot record the location library yet (migration 0066 is not applied). */
export class LocationLibraryUnavailableError extends Error {
  constructor() {
    super(
      "The location library needs a one-time database update (migration 0066) that has not been applied yet.",
    );
    this.name = "LocationLibraryUnavailableError";
  }
}

/** This database cannot record the character library yet (migration 0062 is not applied). */
export class CharacterLibraryUnavailableError extends Error {
  constructor() {
    super(
      "The character library needs a one-time database update (migration 0062) that has not been applied yet.",
    );
    this.name = "CharacterLibraryUnavailableError";
  }
}

/** This database cannot record archived projects yet (migration 0060 is not applied). */
export class ProjectArchiveUnavailableError extends Error {
  constructor() {
    super(
      "Archiving projects needs a one-time database update (migration 0060) that has not been applied yet.",
    );
    this.name = "ProjectArchiveUnavailableError";
  }
}

/** Collections keyed by a field other than `id` do not exist today; kept explicit for the SQL adapter. */
export const COLLECTION_TABLES: Record<CollectionName, string> = {
  assets: "assets",
  characters: "characters",
  identityRefs: "character_identity_refs",
  looks: "character_looks",
  voiceProfiles: "voice_profiles",
  locations: "locations",
  props: "props",
  episodes: "episodes",
  scenes: "scenes",
  shots: "shots",
  dialogueLines: "dialogue_lines",
  actionBlocks: "action_blocks",
  directions: "performance_directions",
  takes: "performance_takes",
  frames: "storyboard_frames",
  attempts: "generation_attempts",
  continuityChecks: "continuity_checks",
};

/** Counts of unfinished work, by kind, as the lines a refused delete shows. */
export function activeWorkLines(counts: Partial<Record<ActiveWorkKind, number>>): string[] {
  const out: string[] = [];
  for (const [kind, [one, many]] of Object.entries(ACTIVE_WORK_LABELS) as Array<
    [ActiveWorkKind, [string, string]]
  >) {
    const n = counts[kind] ?? 0;
    if (n > 0) out.push(`${n} ${n === 1 ? one : many}`);
  }
  return out;
}

export type ActiveWorkKind =
  | "generation"
  | "continuity"
  | "reconstruction"
  | "render"
  | "story"
  | "writing"
  | "shotList"
  | "shotDirection";

const ACTIVE_WORK_LABELS: Record<ActiveWorkKind, [string, string]> = {
  generation: ["image or video generation", "image or video generations"],
  continuity: ["continuity check", "continuity checks"],
  reconstruction: ["3D reconstruction", "3D reconstructions"],
  render: ["episode render", "episode renders"],
  story: ["story analysis", "story analyses"],
  writing: ["writing request", "writing requests"],
  shotList: ["shot list", "shot lists"],
  shotDirection: ["shot direction request", "shot direction requests"],
};
