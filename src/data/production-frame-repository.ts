import type {
  ProductionFrame,
  ProductionFrameDraft,
  ProductionFrameSelection,
} from "@/domain/production-frame";
import type { Asset } from "@/domain/schemas";

/**
 * Persistence contract for Phase 2G.1 Production Frames: the IMMUTABLE per-Shot history and the ONE mutable selection
 * pointer per Shot. The application path only (acts as the signed-in user; RLS applies in Postgres). Neither worker
 * role has any access: a worker can never write or select a Production Frame.
 *
 * Implementations: src/data/production-frame-memory.ts and src/data/production-frame-postgres.ts (same semantics).
 * Reads reach the domain through ProjectData (the server loaders attach `productionFrames` and
 * `productionFrameSelections`), so ShotContext never depends on this repository or on any 3D/previs state.
 */
export class ProductionFrameError extends Error {
  constructor(
    readonly code: "not_found" | "wrong_project" | "wrong_shot" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ProductionFrameError";
  }
}

export interface NewProductionFrame {
  /** from domain `draftProductionFrame`: everything frozen except the per-Shot version */
  draft: ProductionFrameDraft;
  /**
   * An upload's NEW private `production_frame` Asset, persisted in the SAME transaction as the frame so the pair is
   * all-or-nothing. Null for a promotion (the frame references an existing Asset: nothing is copied).
   */
  newAsset: Asset | null;
  /** make it the Shot's canonical frame in the same transaction */
  select: boolean;
  userId: string | null;
  now: string;
}

export interface CreateProductionFrameResult {
  frame: ProductionFrame;
  /**
   * false: an identical frame (same Shot, source artifact, image checksum, aspect and visual intent) already existed
   * and was returned (and re-selected when asked) instead of creating a duplicate version. `newAsset` was then NOT
   * stored, so the caller removes its uploaded object.
   */
  created: boolean;
  selection: ProductionFrameSelection | null;
}

export interface SelectProductionFrameInput {
  projectId: string;
  shotId: string;
  productionFrameId: string;
  userId: string | null;
  now: string;
  /**
   * Compare-and-set on what the caller saw: a frame id, `null` (expected none), or `undefined` (unconditional). A
   * mismatch is a `conflict`, so two browser tabs never silently overwrite each other's choice.
   */
  expectedSelectedFrameId?: string | null;
}

export interface ProductionFrameRepository {
  /** Every frame (newest first per Shot) and every selection of a project, for the loaders. */
  listForProject(
    projectId: string,
  ): Promise<{ frames: ProductionFrame[]; selections: ProductionFrameSelection[] }>;
  /**
   * Assigns the next per-Shot version under a lock (concurrent creates never duplicate a version), stores the optional
   * new Asset and the frame, and optionally selects it, all in one transaction.
   */
  create(input: NewProductionFrame): Promise<CreateProductionFrameResult>;
  /** Moves the Shot's pointer to a frame of THAT Shot and Project. Touches no historical frame. */
  select(input: SelectProductionFrameInput): Promise<ProductionFrameSelection>;
  /** Whether any Production Frame (of any project the caller owns) uses this Asset. */
  usesAsset(assetId: string): Promise<boolean>;
}
