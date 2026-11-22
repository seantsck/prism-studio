import { bibleAsText } from "@/domain/bible-ai";
import type { Episode, ProjectData } from "@/domain/schemas";
import {
  estimateWritingInputTokens,
  LIMITS,
  MAX_RECORDED_COUNT,
  LONG_FORM_TAIL_CHARS,
  longFormTokens,
  writingOutputTokens,
  type LongFormPlan,
  type WritingMode,
  type WritingScope,
} from "@/domain/story/writing";
import { estimateUsd, type StoryModel } from "@/story/provider";
import { buildWritingContext } from "@/story/writing-context";
import { WRITING_INSTRUCTIONS, writingInput, type WritingContext } from "@/story/writing-prompt";

/**
 * The price of one writing request, worked out ONE way for the action that queues it and for every price shown before
 * it (the start page, the confirmation), so the amount a creator confirms is the amount the action accepts. A whole
 * Episode or film (`longForm`) is priced as a ceiling for every one of its parts.
 */
export interface WritingPrice {
  context: WritingContext;
  inputTokens: number;
  maxOutputTokens: number;
  usd: number;
  /** The request (or one of its parts) does not fit the model. */
  tooLong: boolean;
}

/** The Bible's fields that have something in them, or null when none does. */
function filled(bible: ProjectData["bible"]): Record<string, string> | null {
  const entries = Object.entries(bibleAsText(bible)).filter(([, v]) => v.trim());
  return entries.length ? Object.fromEntries(entries) : null;
}

export function priceWriting(args: {
  data: ProjectData;
  episode: Episode;
  text: string;
  scope: WritingScope;
  mode: WritingMode;
  instruction: string;
  count: number;
  targetText: string;
  draftText: string | null;
  conversation: WritingContext["conversation"];
  model: StoryModel;
  longForm?: LongFormPlan | null;
  /** Send the season's current plan (refining a plan, writing from one). */
  withPlan?: boolean;
  /** Send the project Bible as it stands (refining it). */
  withBible?: boolean;
}): WritingPrice {
  const built = buildWritingContext({
    data: args.data,
    episode: args.episode,
    text: args.text,
    scope: args.scope,
    instruction: args.instruction,
    conversation: args.conversation,
  });
  const plan = args.data.episodes
    .filter((e) => e.synopsis.trim())
    .sort((a, b) => a.number - b.number)
    .map((e) => ({ episode: e.number, title: e.title, synopsis: e.synopsis.slice(0, 400) }));
  const context: WritingContext = {
    ...built,
    ...(args.longForm ? { longForm: args.longForm } : {}),
    ...((args.longForm || args.withPlan) && plan.length > 0
      ? { seasonPlan: plan.slice(0, LIMITS.ideas) }
      : {}),
    ...(args.mode === "brainstorm" && args.count > MAX_RECORDED_COUNT ? { ideaCount: args.count } : {}),
    // refining the Bible sends all of it; writing a whole Episode or film sends what it has (its look, rules, canon)
    ...(args.withBible || (args.longForm && filled(args.data.bible))
      ? { bible: args.withBible ? bibleAsText(args.data.bible) : filled(args.data.bible)! }
      : {}),
  };
  const promptText = writingInput({
    mode: args.mode,
    instruction: args.instruction,
    count: args.count,
    scopeKind: args.scope.kind,
    context,
    targetText: args.targetText,
    draftText: args.draftText,
  });
  const base = estimateWritingInputTokens(WRITING_INSTRUCTIONS, promptText);
  if (args.longForm) {
    const t = longFormTokens(base, args.longForm);
    const perPart = base + Math.ceil(LONG_FORM_TAIL_CHARS * 1.5) + args.longForm.partTokens;
    return {
      context,
      ...t,
      usd: estimateUsd(args.model, t.inputTokens, t.maxOutputTokens),
      tooLong: args.model.paid && perPart > args.model.contextTokens,
    };
  }
  const maxOutputTokens = writingOutputTokens(
    args.mode,
    args.count,
    args.targetText.length,
    args.model.maxOutputTokens || 32_000,
  );
  return {
    context,
    inputTokens: base,
    maxOutputTokens,
    usd: estimateUsd(args.model, base, maxOutputTokens),
    tooLong: args.model.paid && base + maxOutputTokens > args.model.contextTokens,
  };
}
