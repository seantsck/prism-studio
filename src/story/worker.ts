import type { ProposalReview } from "@/domain/story/review";
import { validateProposal } from "@/domain/story/proposal";
import { lineCount } from "@/domain/story/source";
import type { StoryWorkerStore } from "@/data/story-repository";
import { actualUsd } from "./provider";
import type { StoryRegistry } from "./registry";

/**
 * Phase 5B-S1: the Story Intelligence worker. It is the ONLY place a provider is called (and the only process that
 * holds a provider key in Supabase mode). Everything it knows comes from the frozen proposal row (the analysed text,
 * and for a section revision the frozen proposal it revises); everything it writes is that row's result. It reads no
 * project content and never touches Characters, Locations, Scenes or Shots: matching and applying happen on the web,
 * with the creator.
 *
 *   claim → re-check the model and the spend gate against the FROZEN estimate and confirmation → provider.analyze →
 *   Prism validation (inside the provider: one correction turn at most) → complete (the proposal) or fail. The default
 *   review and possible matches are computed on the web, with the creator.
 *   A lease that expired mid-analysis is failed as ambiguous, never re-sent.
 */
export class StoryWorker {
  constructor(
    private readonly deps: {
      store: StoryWorkerStore;
      registry: StoryRegistry;
      workerId: string;
      leaseMs?: number;
      clock?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.clock?.() ?? new Date()).toISOString();
  }

  async tick(limit = 2): Promise<number> {
    await this.deps.store.expireAbandoned(this.now());
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const row = await this.deps.store.claim(this.deps.workerId, this.deps.leaseMs ?? 600_000, this.now());
      if (!row) break;
      processed++;
      const model = this.deps.registry.model(row.provider, row.model);
      const provider = this.deps.registry.provider(row.provider);
      const fail = (code: string, message: string, extra: { calls?: number; usd?: number | null } = {}) =>
        this.deps.store.fail(row.id, this.deps.workerId, {
          error: { code, message },
          usage: null,
          actualUsd: extra.usd ?? null,
          providerCalls: extra.calls ?? 0,
          now: this.now(),
        });
      if (!model || !provider) {
        await fail("model_unavailable", "That model is not available on the worker.");
        continue;
      }
      // the spend gate again, on the worker, against what the creator confirmed (nothing silently spends)
      if (model.paid) {
        const spend = this.deps.registry.spend;
        if (!spend.paidEnabled) {
          await fail("paid_disabled", "Paid analysis is switched off.");
          continue;
        }
        if (
          row.confirmedUsd == null ||
          row.confirmedUsd + 1e-9 < row.estimate.usd ||
          row.estimate.usd > spend.maxUsd
        ) {
          await fail("spend_not_confirmed", "The estimated cost was not confirmed within the limit.");
          continue;
        }
      }
      const lines = lineCount(row.inputText);
      const previous = row.scope.kind === "section" ? row.baseProposal : null;
      if (row.scope.kind === "section" && !previous) {
        await fail("parent_missing", "The proposal to revise no longer exists.");
        continue;
      }
      const result = await provider.analyze({
        model,
        text: row.inputText,
        title: row.title,
        ...(row.scope.kind === "section" && previous
          ? { revise: { previous, section: row.scope.section, note: row.scope.note } }
          : {}),
        validate: (raw) => validateProposal(raw, lines),
      });
      const usd = actualUsd(model, result.usage);
      if (result.ok) {
        await this.deps.store.complete(row.id, this.deps.workerId, {
          proposal: result.proposal,
          usage: result.usage,
          actualUsd: usd,
          providerCalls: result.providerCalls,
          now: this.now(),
        });
      } else if (result.retryable) {
        await this.deps.store.retryLater(
          row.id,
          this.deps.workerId,
          new Date(Date.parse(this.now()) + 60_000).toISOString(),
          result.providerCalls,
        );
      } else {
        await this.deps.store.fail(row.id, this.deps.workerId, {
          error: { code: result.code, message: result.message },
          usage: result.usage,
          actualUsd: usd,
          providerCalls: result.providerCalls,
          now: this.now(),
        });
      }
    }
    return processed;
  }

  async run(signal: AbortSignal, idleMs = 1000): Promise<void> {
    while (!signal.aborted) {
      const n = await this.tick().catch(() => 0);
      if (n === 0) await new Promise((r) => setTimeout(r, idleMs));
    }
  }
}

/** A revision keeps the creator's decisions for items that still exist (same key); new items get the defaults. */
export function carryReview(fresh: ProposalReview, previous: ProposalReview): ProposalReview {
  const items = { ...fresh.items };
  for (const [id, r] of Object.entries(previous.items)) if (items[id]) items[id] = { ...items[id]!, ...r };
  return { ...fresh, items, story: { ...previous.story }, target: previous.target };
}
