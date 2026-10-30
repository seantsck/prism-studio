import { randomUUID } from "node:crypto";
import type { AttemptMediaFacts } from "@/domain/edit/eligibility";
import type { EpisodeEdit } from "@/domain/edit/model";
import type { ProductionFrame } from "@/domain/production-frame";
import type { Asset, CollectionName, GenerationAttempt, ProjectData } from "@/domain/schemas";
import {
  addsOf,
  applyEditOps,
  assertEditValid,
  editRefs,
  emptyEdit,
  type EditRefs,
  type EditSourceFacts,
} from "./episode-edit-ops";
import {
  EDIT_EXISTS_MESSAGE,
  EDIT_REVISION_CONFLICT_MESSAGE,
  EpisodeEditError,
  IN_EDIT_MESSAGE,
  type ApplyEpisodeEditInput,
  type CreateEpisodeEditInput,
  type DeleteEpisodeEditInput,
  type EpisodeEditRepository,
} from "./episode-edit-repository";
import type { MemoryGenerationService } from "./generation-memory";
import type { MemoryMediaQaService } from "./media-qa-memory";
import type { MemoryProductionFrameService } from "./production-frame-memory";

const clone = <T>(v: T): T => structuredClone(v);

/** The memory services an edit's source checks read (resolved lazily, like the repository's own getters). */
export interface MemoryEpisodeEditAccess {
  all(): ProjectData[];
  generation(): Pick<MemoryGenerationService, "getAttemptView">;
  mediaQa(): Pick<MemoryMediaQaService, "listAttemptDerivations" | "getDelivery">;
  productionFrames(): Pick<MemoryProductionFrameService, "listForProject">;
}

/** What a removed row of each collection is called in the refusal (`assertNotReferenced`). */
const REFERENCED_NAME: Partial<Record<CollectionName, string>> = {
  shots: "That Shot",
  assets: "That asset",
  attempts: "That generation",
  frames: "That storyboard frame",
  takes: "That take",
  dialogueLines: "That dialogue line",
};

/**
 * In-process Episode edit persistence for memory/demo mode and fast tests, with the semantics of the Postgres
 * implementation and migration 0043 (the op semantics and checks are the shared src/data/episode-edit-ops.ts):
 * stable edit and item ids, one edit per Episode, one item per Shot, the source rules, trims inside the clip,
 * placements inside their item, compare-and-set on `revision` (a stale write changes nothing), dense order, and a
 * referenced Shot / clip / frame / take / line that cannot be removed while an edit uses it (`assertNotReferenced`,
 * called by the memory repository before it removes a row, as the database's NO ACTION keys refuse it). An Episode
 * that goes takes its edit with it (the database cascades).
 *
 * Atomicity: every mutation loads its facts first (the only awaits), then compares the revision, plans, validates and
 * stores in ONE synchronous block, so two concurrent writers against the same revision cannot both win.
 */
export class MemoryEpisodeEditService implements EpisodeEditRepository {
  private edits = new Map<string, EpisodeEdit>();

  constructor(private readonly access: MemoryEpisodeEditAccess) {}

  private projectOf(projectId: string): ProjectData | undefined {
    return this.access.all().find((p) => p.project.id === projectId);
  }

  /** The edits whose Project and Episode still exist (the database cascades an Episode / Project delete). */
  private live(projectId?: string): EpisodeEdit[] {
    const episodes = new Set(
      this.access.all().flatMap((p) => p.episodes.map((e) => `${p.project.id}:${e.id}`)),
    );
    return [...this.edits.values()].filter(
      (e) =>
        (projectId === undefined || e.projectId === projectId) &&
        episodes.has(`${e.projectId}:${e.episodeId}`),
    );
  }

  private requireEdit(projectId: string, editId: string): EpisodeEdit {
    const edit = this.live().find((e) => e.id === editId);
    if (!edit) throw new EpisodeEditError("not_found", "That edit no longer exists.");
    if (edit.projectId !== projectId)
      throw new EpisodeEditError("wrong_project", "That edit belongs to another project.");
    return edit;
  }

  async get(projectId: string, editId: string) {
    const edit = this.live(projectId).find((e) => e.id === editId);
    return edit ? clone(edit) : null;
  }

  async getForEpisode(projectId: string, episodeId: string) {
    const edit = this.live(projectId).find((e) => e.episodeId === episodeId);
    return edit ? clone(edit) : null;
  }

  async listForProject(projectId: string) {
    return this.live(projectId)
      .sort((a, b) => a.episodeId.localeCompare(b.episodeId) || a.id.localeCompare(b.id))
      .map(clone);
  }

  /** The rows the ops reference, from every local project (the memory twin of the caller's RLS scope). */
  private async loadFacts(refs: EditRefs): Promise<EditSourceFacts> {
    const projects = this.access.all();
    const shots = projects.flatMap((p) => p.shots);
    const attemptIds = new Set(refs.attemptIds);
    const replacementShots = new Set(refs.replacementShotIds);
    const attempts: GenerationAttempt[] = projects.flatMap((p) =>
      p.attempts.filter((a) => attemptIds.has(a.id) || (replacementShots.has(a.shotId) && a.approved)),
    );
    const assetIds = new Set(refs.assetIds);
    const assets = new Map<string, Asset>();
    for (const p of projects) for (const a of p.assets) if (assetIds.has(a.id)) assets.set(a.id, a);
    const media = new Map<string, AttemptMediaFacts>();
    for (const attempt of attempts) {
      const view = await this.access.generation().getAttemptView(attempt.id);
      const versions = (await this.access.mediaQa().listAttemptDerivations(attempt.id)).filter(
        (d) => d.derivation.slot === "delivery",
      );
      for (const o of view?.outputs ?? []) assets.set(o.asset.id, o.asset);
      for (const d of versions) assets.set(d.asset.id, d.asset);
      media.set(attempt.id, {
        attemptId: attempt.id,
        outputs: (view?.outputs ?? []).map((o) => ({ assetId: o.output.assetId, role: o.output.role })),
        deliveryVersions: versions.map((d) => ({
          assetId: d.asset.id,
          parentAssetId: d.derivation.parentAssetId,
          version: d.derivation.version,
        })),
        deliveryAssetId: (await this.access.mediaQa().getDelivery(attempt.id))?.assetId ?? null,
      });
    }
    const productionFrames: ProductionFrame[] = [];
    if (refs.productionFrameIds.length)
      for (const p of projects)
        productionFrames.push(
          ...(await this.access.productionFrames().listForProject(p.project.id)).frames.filter((f) =>
            refs.productionFrameIds.includes(f.id),
          ),
        );
    return {
      shots: shots
        .filter((s) => refs.shotIds.includes(s.id))
        .map((s) => ({ id: s.id, projectId: s.projectId, episodeId: s.episodeId })),
      clip: { attempts, assets: [...assets.values()] },
      media: { attempts: media, bestPointers: [] },
      storyboardFrames: projects.flatMap((p) =>
        p.frames.filter((f) => refs.storyboardFrameIds.includes(f.id)),
      ),
      productionFrames,
      takes: projects.flatMap((p) => p.takes.filter((t) => refs.takeIds.includes(t.id))),
    };
  }

  async create(input: CreateEpisodeEditInput): Promise<EpisodeEdit> {
    const project = this.projectOf(input.projectId);
    if (!project) throw new EpisodeEditError("not_found", "That project no longer exists.");
    if (!project.episodes.some((e) => e.id === input.episodeId)) {
      const elsewhere = this.access.all().some((p) => p.episodes.some((e) => e.id === input.episodeId));
      throw elsewhere
        ? new EpisodeEditError("wrong_project", "That Episode belongs to another project.")
        : new EpisodeEditError("not_found", "That Episode no longer exists.");
    }
    const base = emptyEdit({
      id: randomUUID(),
      projectId: input.projectId,
      episodeId: input.episodeId,
      editRate: { ...input.editRate },
    });
    const ops = addsOf(input.items);
    const facts = await this.loadFacts(editRefs(base, ops));
    // ── synchronous from here: nothing interleaves ──
    if (this.live(input.projectId).some((e) => e.episodeId === input.episodeId))
      throw new EpisodeEditError("conflict", EDIT_EXISTS_MESSAGE);
    const plan = applyEditOps(base, ops, facts, randomUUID, { userId: input.userId, now: input.now });
    assertEditValid(plan, facts, base);
    this.edits.set(base.id, clone(plan.next));
    return clone(plan.next);
  }

  async apply(input: ApplyEpisodeEditInput): Promise<EpisodeEdit> {
    const before = this.requireEdit(input.projectId, input.editId);
    if (before.revision !== input.expectedRevision)
      throw new EpisodeEditError("conflict", EDIT_REVISION_CONFLICT_MESSAGE);
    const facts = await this.loadFacts(editRefs(before, input.ops));
    // ── synchronous from here: the revision is compared against the state that is written ──
    const current = this.requireEdit(input.projectId, input.editId);
    if (current.revision !== input.expectedRevision)
      throw new EpisodeEditError("conflict", EDIT_REVISION_CONFLICT_MESSAGE);
    const plan = applyEditOps(current, input.ops, facts, randomUUID, {
      userId: input.userId,
      now: input.now,
    });
    assertEditValid(plan, facts, current);
    const next: EpisodeEdit = { ...plan.next, revision: current.revision + 1 };
    this.edits.set(next.id, clone(next));
    return clone(next);
  }

  async delete(input: DeleteEpisodeEditInput): Promise<void> {
    const edit = this.requireEdit(input.projectId, input.editId);
    if (edit.revision !== input.expectedRevision)
      throw new EpisodeEditError("conflict", EDIT_REVISION_CONFLICT_MESSAGE);
    this.edits.delete(edit.id);
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.live().some((e) =>
      e.items.some((i) => i.visual.kind === "video" && i.visual.assetId === assetId),
    );
  }

  /**
   * The memory twin of migration 0043's NO ACTION keys: a Shot, clip (attempt / Asset), storyboard frame, take or
   * dialogue line an edit references cannot be removed; remove the item (or its placement) first.
   */
  assertNotReferenced(projectId: string, name: CollectionName, id: string): void {
    const what = REFERENCED_NAME[name];
    if (!what) return;
    const used = this.live(projectId).some((e) =>
      e.items.some((i) => {
        const v = i.visual;
        switch (name) {
          case "shots":
            return i.shotId === id;
          case "assets":
            return v.kind === "video" && v.assetId === id;
          case "attempts":
            return v.kind === "video" && v.attemptId === id;
          case "frames":
            return v.kind === "storyboard_frame" && v.storyboardFrameId === id;
          case "takes":
            return i.performance.some((p) => p.takeId === id);
          case "dialogueLines":
            return i.performance.some((p) => p.dialogueLineId === id);
          default:
            return false;
        }
      }),
    );
    if (used) throw new EpisodeEditError("in_use", `${what} can't be deleted. ${IN_EDIT_MESSAGE}`);
  }
}
