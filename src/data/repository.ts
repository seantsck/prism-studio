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
  loadProject(slug: string): Promise<ProjectData | null>;
  createProject(project: Project, bible: ProjectBible): Promise<void>;
  updateProject(project: Project): Promise<void>;
  saveBible(bible: ProjectBible): Promise<void>;
  upsert<K extends CollectionName>(projectId: string, name: K, item: Collections[K][number]): Promise<void>;
  upsertMany<K extends CollectionName>(projectId: string, name: K, items: Collections[K]): Promise<void>;
  remove(projectId: string, name: CollectionName, id: string): Promise<void>;
  findAsset(assetId: string): Promise<Asset | null>;
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
