import "server-only";
import type { SpendAuthorization } from "@/data/writing-repository";
import { WritingError } from "@/data/writing-repository";
import type { StoryModel } from "@/story/provider";
import type { StoryRegistry } from "@/story/registry";
import { UserFacingError } from "./action-result";
import { getWritingRepo } from "./story";

/**
 * Phase 5B-S4/S5: the shared spend gate for Story requests that are not writing turns (Shot Lists, Storyboard
 * Direction). Free models need nothing. A paid request needs, under the per-request ceiling, EITHER the explicit
 * "Confirm total" OR the capped allowance of the Episode's newest live writing session (S2), reserved atomically and
 * never exceeded. The worker re-checks every request. Nothing silently spends.
 */
export async function authorizeStorySpend(args: {
  form: FormData;
  registry: StoryRegistry;
  model: StoryModel;
  projectId: string;
  episodeId: string;
  usd: number;
  inputTokens: number;
  maxOutputTokens: number;
}): Promise<{ confirmedUsd: number | null; spendAuthorization: SpendAuthorization }> {
  const { form, registry, model, usd } = args;
  if (!model.paid) return { confirmedUsd: null, spendAuthorization: "free" };
  if (args.inputTokens + args.maxOutputTokens > model.contextTokens)
    throw new UserFacingError("This request is too long for the model.");
  if (usd > registry.spend.maxUsd)
    throw new UserFacingError(
      `The estimated cost ($${usd.toFixed(4)}) is over this server's per-request limit ($${registry.spend.maxUsd.toFixed(2)}).`,
    );
  const raw = String(form.get("confirmedTotalUsd") ?? "").trim();
  const confirmed = Number(raw);
  if (raw && Number.isFinite(confirmed) && confirmed + 1e-9 >= usd)
    return { confirmedUsd: confirmed, spendAuthorization: "confirmed" };
  const now = new Date().toISOString();
  const writing = await getWritingRepo({ startInlineWorker: false });
  const live = (await writing.listSessions(args.projectId, args.episodeId)).find(
    (s) => s.budgetExpiresAt && s.budgetExpiresAt > now && s.reservedUsd + usd <= s.budgetUsd + 1e-9,
  );
  if (!live)
    throw new UserFacingError(
      `Estimated cost: $${usd.toFixed(4)} (about ${args.inputTokens.toLocaleString("en-US")} input tokens and up to ${args.maxOutputTokens.toLocaleString("en-US")} output tokens with ${model.label}). Enter ${usd.toFixed(4)} in "Confirm total", or allow a capped writing session for this Episode.`,
    );
  try {
    await writing.reserveBudget(args.projectId, live.id, usd, now);
  } catch (err) {
    if (err instanceof WritingError) throw new UserFacingError(err.message);
    throw err;
  }
  return { confirmedUsd: usd, spendAuthorization: "session" };
}

/** The model a Story request uses: the creator's choice (Advanced), else the first available one. */
export function chooseStoryModel(registry: StoryRegistry, wanted: string): StoryModel {
  const listed = registry.models();
  const pick = wanted
    ? listed.find((m) => `${m.provider}/${m.modelId}` === wanted)
    : listed.find((m) => m.available);
  if (!pick) throw new UserFacingError("Prism AI is not set up on this server.");
  if (!pick.available) throw new UserFacingError(pick.reason ?? "That model is not available.");
  return registry.model(pick.provider, pick.modelId)!;
}
