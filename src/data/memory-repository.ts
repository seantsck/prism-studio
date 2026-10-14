import { LOCAL_USER_ID, buildSeedProject } from "./seed";
import { MemoryCandidateService } from "./candidates-memory";
import { MemoryGenerationService } from "./generation-memory";
import { MemoryMediaQaService } from "./media-qa-memory";
import type { Repository } from "./repository";
import type {
  Asset,
  CollectionName,
  Collections,
  Project,
  ProjectBible,
  ProjectData,
} from "@/domain/schemas";

type Keyed = { id: string };

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryRepository implements Repository {
  private projects = new Map<string, ProjectData>();
  private generationService: MemoryGenerationService | undefined;
  private mediaQaService: MemoryMediaQaService | undefined;
  private candidateService: MemoryCandidateService | undefined;

  /** Derived-media lineage, delivery masters and continuity QA runs (same semantics as Postgres). */
  get mediaQa(): MemoryMediaQaService {
    this.mediaQaService ??= new MemoryMediaQaService({
      all: () => [...this.projects.values()],
      ownerUserId: () => LOCAL_USER_ID,
    });
    return this.mediaQaService;
  }

  /** Jobs, outputs, costs and events for this in-process repository (same semantics as Postgres). */
  get generation(): MemoryGenerationService {
    this.generationService ??= new MemoryGenerationService({
      all: () => [...this.projects.values()],
      ownerUserId: () => LOCAL_USER_ID,
    });
    return this.generationService;
  }

  /** Candidate sets and human generation reviews (Phase 2E; same semantics as Postgres). */
  get candidates(): MemoryCandidateService {
    this.candidateService ??= new MemoryCandidateService(
      { all: () => [...this.projects.values()], ownerUserId: () => LOCAL_USER_ID },
      this.generation,
    );
    return this.candidateService;
  }

  constructor(seed: ProjectData[] = [buildSeedProject()]) {
    for (const p of seed) this.projects.set(p.project.id, clone(p));
  }

  currentUserId(): string {
    return LOCAL_USER_ID;
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects.values()].map((p) => clone(p.project));
  }

  async loadProject(slug: string): Promise<ProjectData | null> {
    const found = [...this.projects.values()].find((p) => p.project.slug === slug);
    return found ? clone(found) : null;
  }

  async createProject(project: Project, bible: ProjectBible): Promise<void> {
    const empty: Collections = {
      assets: [],
      characters: [],
      identityRefs: [],
      looks: [],
      voiceProfiles: [],
      locations: [],
      props: [],
      episodes: [],
      scenes: [],
      shots: [],
      dialogueLines: [],
      actionBlocks: [],
      directions: [],
      takes: [],
      frames: [],
      attempts: [],
      continuityChecks: [],
    };
    this.projects.set(project.id, { project: clone(project), bible: clone(bible), ...empty });
  }

  private get(projectId: string): ProjectData {
    const p = this.projects.get(projectId);
    if (!p) throw new Error(`Project ${projectId} not found`);
    return p;
  }

  async updateProject(project: Project): Promise<void> {
    this.get(project.id).project = clone(project);
  }

  async saveBible(bible: ProjectBible): Promise<void> {
    this.get(bible.projectId).bible = clone(bible);
  }

  async upsert<K extends CollectionName>(
    projectId: string,
    name: K,
    item: Collections[K][number],
  ): Promise<void> {
    const list = this.get(projectId)[name] as unknown as Keyed[];
    const next = clone(item) as unknown as Keyed;
    const i = list.findIndex((x) => x.id === next.id);
    if (i >= 0) list[i] = next;
    else list.push(next);
  }

  async upsertMany<K extends CollectionName>(
    projectId: string,
    name: K,
    items: Collections[K],
  ): Promise<void> {
    for (const item of items) await this.upsert(projectId, name, item);
  }

  async remove(projectId: string, name: CollectionName, id: string): Promise<void> {
    const p = this.get(projectId);
    const list = p[name] as unknown as Keyed[];
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
  }

  async findAsset(assetId: string): Promise<Asset | null> {
    for (const p of this.projects.values()) {
      const a = p.assets.find((x) => x.id === assetId);
      if (a) return clone(a);
    }
    return null;
  }
}
