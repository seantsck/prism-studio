import {
  productionFrameSchema,
  productionFrameSelectionSchema,
  type ProductionFrame,
  type ProductionFrameSelection,
} from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import type { MemoryProjectsAccess } from "./generation-memory";
import {
  ProductionFrameError,
  type CreateProductionFrameResult,
  type NewProductionFrame,
  type ProductionFrameRepository,
  type SelectProductionFrameInput,
} from "./production-frame-repository";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-process Production Frame persistence for memory/demo mode and fast tests. Semantics mirror the Postgres
 * implementation and its constraints: per-Shot versions assigned atomically (JavaScript runs each method without
 * interleaving, so there is no gap between reading the maximum and inserting), a unique frame fingerprint per Shot,
 * frames frozen after creation, a selection that can only name a frame of its own Shot and Project, and a new Asset
 * stored together with its frame.
 */
export class MemoryProductionFrameService implements ProductionFrameRepository {
  private frames: ProductionFrame[] = [];
  private selections = new Map<string, ProductionFrameSelection>(); // by shot id

  constructor(private readonly access: MemoryProjectsAccess) {}

  private projectOf(projectId: string): ProjectData | undefined {
    return this.access.all().find((p) => p.project.id === projectId);
  }

  async listForProject(projectId: string) {
    // a deleted Shot takes its frames and selection with it (the database cascades the same way)
    const shots = new Set(this.projectOf(projectId)?.shots.map((s) => s.id) ?? []);
    return {
      frames: this.frames
        .filter((f) => f.projectId === projectId && shots.has(f.shotId))
        .sort((a, b) => a.shotId.localeCompare(b.shotId) || b.version - a.version)
        .map(clone),
      selections: [...this.selections.values()]
        .filter((s) => s.projectId === projectId && shots.has(s.shotId))
        .map(clone),
    };
  }

  async create(input: NewProductionFrame): Promise<CreateProductionFrameResult> {
    const { draft } = input;
    const project = this.projectOf(draft.projectId);
    if (!project) throw new ProductionFrameError("not_found", "That project no longer exists.");
    if (!project.shots.some((s) => s.id === draft.shotId))
      throw new ProductionFrameError("not_found", "That Shot no longer exists.");

    // an identical frame already exists: return it (and select it when asked) instead of a new version
    const existing = this.frames.find(
      (f) => f.shotId === draft.shotId && f.frameFingerprint === draft.frameFingerprint,
    );
    if (existing) {
      const selection = input.select
        ? this.writeSelection(existing, input.userId, input.now)
        : this.selectionOf(existing.shotId);
      return { frame: clone(existing), created: false, selection: selection ? clone(selection) : null };
    }

    // what the database trigger checks: a real, stored image of THIS project whose facts are the frame's facts
    const asset =
      input.newAsset && input.newAsset.id === draft.assetId
        ? input.newAsset
        : project.assets.find((a) => a.id === draft.assetId);
    if (!asset || asset.projectId !== draft.projectId)
      throw new ProductionFrameError("wrong_project", "The Production Frame image is not in this project.");
    if (
      asset.type !== "image" ||
      !asset.objectPath ||
      asset.checksum !== draft.assetChecksum ||
      asset.width !== draft.width ||
      asset.height !== draft.height
    )
      throw new ProductionFrameError("invalid", "The Production Frame facts do not match its image.");

    const version =
      this.frames.filter((f) => f.shotId === draft.shotId).reduce((m, f) => Math.max(m, f.version), 0) + 1;
    const frame = productionFrameSchema.parse({ ...draft, version });
    if (input.newAsset && !project.assets.some((a) => a.id === input.newAsset!.id))
      project.assets.push(clone(input.newAsset));
    this.frames.push(clone(frame));
    const selection = input.select
      ? this.writeSelection(frame, input.userId, input.now)
      : this.selectionOf(frame.shotId);
    return { frame: clone(frame), created: true, selection: selection ? clone(selection) : null };
  }

  private selectionOf(shotId: string): ProductionFrameSelection | null {
    return this.selections.get(shotId) ?? null;
  }

  private writeSelection(
    frame: ProductionFrame,
    userId: string | null,
    now: string,
  ): ProductionFrameSelection {
    const selection = productionFrameSelectionSchema.parse({
      projectId: frame.projectId,
      shotId: frame.shotId,
      productionFrameId: frame.id,
      selectedBy: userId,
      selectedAt: now,
    });
    const current = this.selections.get(frame.shotId);
    // re-selecting the frame that is already canonical changes nothing (no spurious write)
    if (current?.productionFrameId === frame.id) return current;
    this.selections.set(frame.shotId, selection);
    return selection;
  }

  async select(input: SelectProductionFrameInput): Promise<ProductionFrameSelection> {
    const project = this.projectOf(input.projectId);
    if (!project) throw new ProductionFrameError("not_found", "That project no longer exists.");
    if (!project.shots.some((s) => s.id === input.shotId))
      throw new ProductionFrameError("not_found", "That Shot no longer exists.");
    const frame = this.frames.find((f) => f.id === input.productionFrameId);
    if (!frame) throw new ProductionFrameError("not_found", "That Production Frame no longer exists.");
    if (frame.projectId !== input.projectId)
      throw new ProductionFrameError(
        "wrong_project",
        "That Production Frame belongs to a different project.",
      );
    if (frame.shotId !== input.shotId)
      throw new ProductionFrameError("wrong_shot", "That Production Frame belongs to a different Shot.");
    if (input.expectedSelectedFrameId !== undefined) {
      const current = this.selections.get(input.shotId)?.productionFrameId ?? null;
      if (current !== input.expectedSelectedFrameId)
        throw new ProductionFrameError(
          "conflict",
          "The selected Production Frame changed in the meantime. Reload and choose again.",
        );
    }
    return clone(this.writeSelection(frame, input.userId, input.now));
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.frames.some((f) => f.assetId === assetId);
  }
}
