import type { ProposalReview } from "@/domain/story/review";
import { validateProposal } from "@/domain/story/proposal";
import { lineCount } from "@/domain/story/source";
import type { StoryWorkerStore } from "@/data/story-repository";
import type { ShotDirectionProposal, ShotDirectionWorkerStore } from "@/data/shot-direction-repository";
import type { ShotListProposal, ShotListWorkerStore } from "@/data/shot-list-repository";
import type { WritingProposal, WritingWorkerStore } from "@/data/writing-repository";
import { validateShotDirection } from "@/domain/story/shot-direction";
import { validateShotPlan } from "@/domain/story/shot-list";
import {
  LIMITS,
  LONG_FORM_TAIL_CHARS,
  longFormPartInstruction,
  validateWriting,
  type LongFormPlan,
} from "@/domain/story/writing";
import { actualUsd, writingOperation, type StoryIntelligenceProvider, type StoryModel } from "./provider";
import type { StoryRegistry } from "./registry";

/** The lease of a writing request: long enough for a whole film written in parts. */
export const WRITING_LEASE_MS = 30 * 60_000;

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
 *
 * Phase 5B-S2: the same worker also processes WRITING proposals (`writing` store): the same spend gate against the
 * frozen estimate and confirmation, one `provider.write` call (one correction turn at most), `validateWriting`, the
 * result written once. It still reads only the frozen row (target text + frozen textual context) and never writes a
 * screenplay: accepting is the creator's action on the web.
 */
export class StoryWorker {
  constructor(
    private readonly deps: {
      store: StoryWorkerStore;
      /** Phase 5B-S2 writing proposals (optional: an S1-only store keeps working). */
      writing?: WritingWorkerStore;
      /** Phase 5B-S4 Shot List Proposals (optional). */
      shotLists?: ShotListWorkerStore;
      /** Phase 5B-S5 Storyboard Direction Proposals (optional). */
      directions?: ShotDirectionWorkerStore;
      registry: StoryRegistry;
      workerId: string;
      leaseMs?: number;
      clock?: () => Date;
    },
  ) {}

  private now() {
    return (this.deps.clock?.() ?? new Date()).toISOString();
  }

  /** The spend gate, on the worker, against what the creator confirmed (nothing silently spends). */
  private spendRefusal(
    model: StoryModel,
    row: { confirmedUsd: number | null; estimate: { usd: number } },
  ): [string, string] | null {
    if (!model.paid) return null;
    const spend = this.deps.registry.spend;
    if (!spend.paidEnabled) return ["paid_disabled", "Paid Prism AI is switched off."];
    if (
      row.confirmedUsd == null ||
      row.confirmedUsd + 1e-9 < row.estimate.usd ||
      row.estimate.usd > spend.maxUsd
    )
      return ["spend_not_confirmed", "The estimated cost was not confirmed within the limit."];
    return null;
  }

  async tick(limit = 2): Promise<number> {
    const processed = await this.tickProposals(limit);
    const writing = this.deps.writing ? await this.tickWriting(limit) : 0;
    const lists = this.deps.shotLists ? await this.tickShotLists(limit) : 0;
    return processed + writing + lists + (this.deps.directions ? await this.tickDirections(limit) : 0);
  }

  private async tickDirections(limit: number): Promise<number> {
    const store = this.deps.directions!;
    await store.expireAbandoned(this.now());
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const row = await store.claim(this.deps.workerId, this.deps.leaseMs ?? 600_000, this.now());
      if (!row) break;
      processed++;
      await this.direct(store, row);
    }
    return processed;
  }

  /** Phase 5B-S5: one Storyboard Direction — the same gate, one `directShot` call, validation, written once. */
  private async direct(store: ShotDirectionWorkerStore, row: ShotDirectionProposal) {
    const fail = (code: string, message: string) =>
      store.fail(row.id, this.deps.workerId, {
        error: { code, message },
        usage: null,
        actualUsd: null,
        providerCalls: 0,
        now: this.now(),
      });
    const model = this.deps.registry.model(row.provider, row.model);
    const provider = this.deps.registry.provider(row.provider);
    if (!model || !provider) return fail("model_unavailable", "That model is not available on the worker.");
    const refusal = this.spendRefusal(model, row);
    if (refusal) return fail(...refusal);
    const result = await provider.directShot({
      model,
      context: row.context,
      instruction: row.instruction,
      maxOutputTokens: row.estimate.maxOutputTokens,
      validate: (raw) => validateShotDirection(raw, row.context),
    });
    const usd = actualUsd(model, result.usage);
    if (result.ok)
      return store.complete(row.id, this.deps.workerId, {
        direction: result.direction,
        usage: result.usage,
        actualUsd: usd,
        providerCalls: result.providerCalls,
        now: this.now(),
      });
    if (result.retryable)
      return store.retryLater(
        row.id,
        this.deps.workerId,
        new Date(Date.parse(this.now()) + 60_000).toISOString(),
        result.providerCalls,
      );
    return store.fail(row.id, this.deps.workerId, {
      error: { code: result.code, message: result.message },
      usage: result.usage,
      actualUsd: usd,
      providerCalls: result.providerCalls,
      now: this.now(),
    });
  }

  private async tickShotLists(limit: number): Promise<number> {
    const store = this.deps.shotLists!;
    await store.expireAbandoned(this.now());
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const row = await store.claim(this.deps.workerId, this.deps.leaseMs ?? 600_000, this.now());
      if (!row) break;
      processed++;
      await this.plan(store, row);
    }
    return processed;
  }

  /** Phase 5B-S4: one Shot List — the same gate, one `planShots` call, `validateShotPlan`, the result written once. */
  private async plan(store: ShotListWorkerStore, row: ShotListProposal) {
    const fail = (code: string, message: string) =>
      store.fail(row.id, this.deps.workerId, {
        error: { code, message },
        usage: null,
        actualUsd: null,
        providerCalls: 0,
        now: this.now(),
      });
    const model = this.deps.registry.model(row.provider, row.model);
    const provider = this.deps.registry.provider(row.provider);
    if (!model || !provider) return fail("model_unavailable", "That model is not available on the worker.");
    const refusal = this.spendRefusal(model, row);
    if (refusal) return fail(...refusal);
    if (row.scope.kind === "shot" && !row.basePlan)
      return fail("parent_missing", "The plan to revise is missing.");
    const result = await provider.planShots({
      model,
      context: row.context,
      sceneText: row.sceneText,
      scope: row.scope,
      basePlan: row.basePlan,
      maxOutputTokens: row.estimate.maxOutputTokens,
      validate: (raw) => validateShotPlan(raw, row.context, row.scope, row.basePlan),
    });
    const usd = actualUsd(model, result.usage);
    if (result.ok)
      return store.complete(row.id, this.deps.workerId, {
        plan: result.plan,
        usage: result.usage,
        actualUsd: usd,
        providerCalls: result.providerCalls,
        now: this.now(),
      });
    if (result.retryable)
      return store.retryLater(
        row.id,
        this.deps.workerId,
        new Date(Date.parse(this.now()) + 60_000).toISOString(),
        result.providerCalls,
      );
    return store.fail(row.id, this.deps.workerId, {
      error: { code: result.code, message: result.message },
      usage: result.usage,
      actualUsd: usd,
      providerCalls: result.providerCalls,
      now: this.now(),
    });
  }

  private async tickWriting(limit: number): Promise<number> {
    const store = this.deps.writing!;
    await store.expireAbandoned(this.now());
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      // a whole film is written in several parts: its lease covers all of them (never shorter than the usual one)
      const lease = Math.max(this.deps.leaseMs ?? 600_000, WRITING_LEASE_MS);
      const row = await store.claim(this.deps.workerId, lease, this.now());
      if (!row) break;
      processed++;
      await this.write(store, row);
    }
    return processed;
  }

  private async write(store: WritingWorkerStore, row: WritingProposal) {
    const fail = (code: string, message: string) =>
      store.fail(row.id, this.deps.workerId, {
        error: { code, message },
        usage: null,
        actualUsd: null,
        providerCalls: 0,
        now: this.now(),
      });
    const model = this.deps.registry.model(row.provider, row.model);
    const provider = this.deps.registry.provider(row.provider);
    if (!model || !provider) return fail("model_unavailable", "That model is not available on the worker.");
    const refusal = this.spendRefusal(model, row);
    if (refusal) return fail(...refusal);
    if (row.context.longForm) return this.writeLong(store, row, model, provider, row.context.longForm);
    const result = await provider.write({
      model,
      operation: writingOperation(row.mode, row.draftText != null),
      mode: row.mode,
      scopeKind: row.scope.kind,
      instruction: row.instruction,
      count: row.context.ideaCount ?? row.alternativesRequested,
      targetText: row.targetText,
      draftText: row.draftText,
      context: row.context,
      maxOutputTokens: row.estimate.maxOutputTokens,
      validate: (raw) =>
        validateWriting(raw, {
          mode: row.mode,
          scopeKind: row.scope.kind,
          count: row.context.ideaCount ?? row.alternativesRequested,
          targetText: row.targetText,
        }),
    });
    const usd = actualUsd(model, result.usage);
    if (result.ok)
      return store.complete(row.id, this.deps.workerId, {
        result: result.result,
        usage: result.usage,
        actualUsd: usd,
        providerCalls: result.providerCalls,
        now: this.now(),
      });
    if (result.retryable)
      return store.retryLater(
        row.id,
        this.deps.workerId,
        new Date(Date.parse(this.now()) + 60_000).toISOString(),
        result.providerCalls,
      );
    return store.fail(row.id, this.deps.workerId, {
      error: { code: result.code, message: result.message },
      usage: result.usage,
      actualUsd: usd,
      providerCalls: result.providerCalls,
      now: this.now(),
    });
  }

  /**
   * A whole Episode or film: the parts in order, each continuing from the tail of what is written so far, then ONE
   * proposal with the whole text for the creator to review. Spend is re-checked after every part against the
   * confirmation; a part that fails ends the request (the parts already paid for are recorded with their usage).
   */
  private async writeLong(
    store: WritingWorkerStore,
    row: WritingProposal,
    model: StoryModel,
    provider: StoryIntelligenceProvider,
    plan: LongFormPlan,
  ) {
    const context = { ...row.context, longForm: undefined };
    let text = row.targetText.trimEnd();
    let inputTokens = 0;
    let outputTokens = 0;
    let unknownUsage = false;
    let calls = 0;
    const facts: string[] = [];
    const usage = () => ({
      inputTokens: unknownUsage ? null : inputTokens,
      outputTokens: unknownUsage ? null : outputTokens,
    });
    for (let part = 0; part < plan.parts; part++) {
      const tail = text.slice(-LONG_FORM_TAIL_CHARS);
      const result = await provider.write({
        model,
        operation: writingOperation("continue", false),
        mode: "continue",
        scopeKind: "episode",
        instruction: longFormPartInstruction(row.instruction, plan, part),
        count: 1,
        targetText: tail,
        draftText: null,
        context,
        maxOutputTokens: plan.partTokens,
        validate: (raw) =>
          validateWriting(raw, { mode: "continue", scopeKind: "episode", count: 1, targetText: tail }),
      });
      calls += result.providerCalls;
      if (result.usage?.inputTokens == null || result.usage?.outputTokens == null) unknownUsage = true;
      else {
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
      }
      if (!result.ok) {
        // nothing paid yet and the provider says try again: the whole request waits (it is re-sent from part one)
        if (result.retryable && part === 0)
          return store.retryLater(
            row.id,
            this.deps.workerId,
            new Date(Date.parse(this.now()) + 60_000).toISOString(),
            calls,
          );
        return store.fail(row.id, this.deps.workerId, {
          error: {
            code: result.code,
            message:
              part === 0 ? result.message : `Part ${part + 1} of ${plan.parts} failed: ${result.message}`,
          },
          usage: usage(),
          actualUsd: actualUsd(model, usage()),
          providerCalls: calls,
          now: this.now(),
        });
      }
      const alt = result.result.alternatives[0]!;
      text = text ? `${text}\n\n${alt.text.trim()}` : alt.text.trim();
      for (const f of alt.newCharacterFacts) if (!facts.includes(f)) facts.push(f);
      // never past what the creator confirmed (the ceiling covers every part; this is the belt and braces)
      const spent = actualUsd(model, usage());
      if (
        model.paid &&
        spent != null &&
        row.confirmedUsd != null &&
        spent > row.confirmedUsd + 1e-9 &&
        part < plan.parts - 1
      )
        return store.fail(row.id, this.deps.workerId, {
          error: { code: "spend_ceiling", message: "Stopped before going over the confirmed amount." },
          usage: usage(),
          actualUsd: spent,
          providerCalls: calls,
          now: this.now(),
        });
    }
    const whole = plan.kind === "film" ? "film" : plan.kind === "short" ? "short film" : "episode";
    return store.complete(row.id, this.deps.workerId, {
      result: {
        message: `Prism wrote the whole ${whole} in ${plan.parts} parts. Read it, then accept it or ask for changes.`,
        alternatives: [
          {
            label: "A",
            text,
            explanation: `The whole ${whole}, written in ${plan.parts} parts.`,
            newCharacterFacts: facts.slice(0, LIMITS.facts),
          },
        ],
        ideas: [],
      },
      usage: usage(),
      actualUsd: actualUsd(model, usage()),
      providerCalls: calls,
      now: this.now(),
    });
  }

  private async tickProposals(limit: number): Promise<number> {
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
      const refusal = this.spendRefusal(model, row);
      if (refusal) {
        await fail(
          refusal[0],
          refusal[0] === "paid_disabled" ? "Paid analysis is switched off." : refusal[1],
        );
        continue;
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
