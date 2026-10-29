import {
  buildAnalysisPlan,
  summarizePlan,
  toAnalysisCriterion,
  type PlanSummary,
} from "@/domain/continuity/analysis/plan";
import {
  analysisSpendBlockers,
  type AnalysisSpendPolicy,
  type CostEstimateUsd,
  type SpendBlocker,
} from "@/domain/continuity/analysis/cost";
import {
  ANALYSIS_SCHEMA_VERSION,
  DEFAULT_ANALYSIS_BUDGET,
  promptVersionFor,
  RUBRIC_VERSION,
  type AnalysisMedia,
  type ContinuityAnalysisInput,
} from "@/domain/continuity/analysis/types";
import { TEMPORAL_SAMPLING_V1 } from "@/domain/continuity/analysis/temporal";
import type { QaInputs } from "@/continuity/service";
import type { Asset } from "@/domain/schemas";
import { reviewFramePositions } from "@/media/delivery";
import type { ContinuityAnalysisProvider } from "./provider";

/** Everything the review frames step produced (or would produce) for the examined asset. */
export interface OutputMediaSet {
  frames: Array<{ atMs: number; asset: Asset | null }>;
  contactSheet: Asset | null;
}

const asMedia = (
  inputId: string,
  kind: AnalysisMedia["kind"],
  role: string,
  label: string,
  a: Pick<Asset, "id" | "checksum" | "mime" | "width" | "height" | "byteSize" | "durationMs">,
  atMs: number | null = null,
): AnalysisMedia => ({
  inputId,
  kind,
  role,
  label,
  assetId: a.id,
  checksum: a.checksum,
  mime: a.mime,
  width: a.width,
  height: a.height,
  byteSize: a.byteSize,
  durationMs: kind === "video" ? a.durationMs : null,
  atMs,
});

/**
 * Media eligible for an analysis, with stable input ids. References come ONLY from the run's frozen reference
 * set (explicitly assigned Look/identity/location refs, the approved storyboard, explicitly included approved
 * neighbours): a generated frame never enters as a reference.
 */
export function buildAnalysisMedia(args: {
  inputs: QaInputs;
  assets: Asset[];
  output: OutputMediaSet;
  subject: Asset;
}): AnalysisMedia[] {
  const out: AnalysisMedia[] = [];
  const byId = new Map(args.assets.map((a) => [a.id, a] as const));
  const counters = new Map<string, number>();
  for (const item of args.inputs.references.items) {
    if (!item.assetId) continue;
    const a = byId.get(item.assetId);
    // only still images are sent as visual references (performance audio / documents are not)
    if (!a || a.type !== "image" || !a.objectPath) continue;
    const n = (counters.get(item.role) ?? 0) + 1;
    counters.set(item.role, n);
    out.push(asMedia(`ref:${item.role}:${n}`, "reference", item.role, item.label, a));
  }
  for (const f of args.output.frames) {
    if (f.asset)
      out.push(
        asMedia(
          `frame:${f.atMs}`,
          "output_frame",
          "output_frame",
          `Output frame at ${f.atMs} ms`,
          f.asset,
          f.atMs,
        ),
      );
  }
  if (args.output.contactSheet) {
    out.push(
      asMedia(
        "sheet",
        "contact_sheet",
        "contact_sheet",
        "Contact sheet of review frames",
        args.output.contactSheet,
      ),
    );
  }
  if (args.subject.type === "video" && args.subject.objectPath) {
    out.push(asMedia("video", "video", "output_video", "Output video", args.subject));
  }
  return out;
}

export function buildAnalysisInput(args: {
  inputs: QaInputs;
  media: AnalysisMedia[];
  provider: ContinuityAnalysisProvider;
  runKey: string;
  subject: Asset;
  /** 3A.3: the Project allows the full video for this path (default false: no video is planned). */
  directVideoAllowed?: boolean;
}): ContinuityAnalysisInput {
  const { inputs, provider } = args;
  const plan = buildAnalysisPlan({
    analyzer: provider.plannerView(),
    criteria: inputs.criteria,
    media: args.media,
    budget: DEFAULT_ANALYSIS_BUDGET,
    directVideoAllowed: args.directVideoAllowed === true,
    sampling: TEMPORAL_SAMPLING_V1,
  });
  const adaptation = inputs.adaptation;
  return {
    version: 1,
    runKey: args.runKey,
    attemptId: "",
    subjectAssetId: args.subject.id,
    providerOriginalAssetId:
      inputs.original && inputs.original.id !== args.subject.id ? inputs.original.id : null,
    criteria: inputs.criteria.flatMap((c) => {
      const ac = toAnalysisCriterion(c);
      return ac ? [ac] : [];
    }),
    media: args.media,
    framing: {
      productionAspectRatio: inputs.pkg.style.aspectRatio || null,
      deliveryWidth: inputs.deliverySize?.width ?? null,
      deliveryHeight: inputs.deliverySize?.height ?? null,
      providerCanvas: adaptation?.framing.providerLabel ?? null,
      strategy: adaptation?.framing.strategy ?? null,
    },
    analyzer: provider.id,
    analyzerVersion: provider.version,
    model: provider.model,
    promptVersions: {
      image_set: promptVersionFor(provider.id, "image_set"),
      direct_video: promptVersionFor(provider.id, "direct_video"),
    },
    rubricVersion: RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    plan,
  };
}

/** Ids of every asset an analysis may read (what the worker's RLS policy keys on). */
export const inputAssetIdsOf = (input: ContinuityAnalysisInput): string[] =>
  [...new Set(input.plan.batches.flatMap((b) => [...b.referenceInputIds, ...b.outputInputIds]))].flatMap(
    (id) => {
      const m = input.media.find((x) => x.inputId === id);
      return m ? [m.assetId] : [];
    },
  );

export interface AnalysisPreview {
  provider: { id: string; label: string; model: string; kind: "mock" | "model" };
  mode: "image_set" | "direct_video";
  plan: ContinuityAnalysisInput["plan"];
  summary: PlanSummary;
  estimate: CostEstimateUsd;
  /** True when the review frames do not exist yet and will be extracted first. */
  framesPending: boolean;
  blockers: SpendBlocker[];
  /** Spend > 0 requires explicit acknowledgement. */
  requiresAcknowledgement: boolean;
  /**
   * 3A.3: the plan sends the FULL output video. Disclosed before the run and acknowledged separately (a spend
   * checkbox is not consent to a full-video transfer).
   */
  fullVideo: {
    durationMs: number | null;
    byteSize: number | null;
    transfer: "inline" | "provider_file" | null;
    criteria: string[];
    sampling: { policy: string; fps: number } | null;
  } | null;
}

export function previewAnalysis(args: {
  inputs: QaInputs;
  assets: Asset[];
  output: OutputMediaSet;
  subject: Asset;
  provider: ContinuityAnalysisProvider;
  policy: AnalysisSpendPolicy;
  spentLast24hUsd: number;
  now: Date;
  /** 3A.3: the Project's full-video permission for this path. */
  directVideoAllowed?: boolean;
}): { preview: AnalysisPreview; input: ContinuityAnalysisInput } {
  let { output } = args;
  let framesPending = false;
  if (output.frames.length === 0 && !output.contactSheet) {
    // The frames will be extracted before the job is queued: estimate with the standard five positions.
    framesPending = true;
    const durationMs = args.subject.durationMs ?? 0;
    output = {
      frames: reviewFramePositions(durationMs, args.subject.frameRate).map((atMs) => ({
        atMs,
        asset: {
          ...args.subject,
          id: `pending-frame-${atMs}`,
          type: "image" as const,
          mime: "image/png",
          checksum: null,
          byteSize: null,
          durationMs: null,
        },
      })),
      contactSheet: null,
    };
  }
  const media = buildAnalysisMedia({
    inputs: args.inputs,
    assets: args.assets,
    output,
    subject: args.subject,
  });
  const input = buildAnalysisInput({
    inputs: args.inputs,
    media,
    provider: args.provider,
    runKey: "preview",
    subject: args.subject,
    directVideoAllowed: args.directVideoAllowed === true,
  });
  const videoBatches = input.plan.batches.filter((b) => b.mode === "direct_video");
  const video = input.media.find((m) => m.kind === "video") ?? null;
  const estimate = args.provider.estimate(input, args.now);
  const maxUsd = Number.isFinite(estimate.maxUsd) ? estimate.maxUsd : null;
  const blockers =
    args.provider.kind === "model"
      ? analysisSpendBlockers({
          policy: args.policy,
          maxEstimateUsd: maxUsd,
          spentLast24hUsd: args.spentLast24hUsd,
        })
      : [];
  return {
    input,
    preview: {
      provider: {
        id: args.provider.id,
        label: args.provider.label,
        model: args.provider.model,
        kind: args.provider.kind,
      },
      mode: input.plan.batches.some((b) => b.mode === "direct_video") ? "direct_video" : "image_set",
      plan: input.plan,
      summary: summarizePlan(input.plan),
      estimate,
      framesPending,
      blockers,
      requiresAcknowledgement: args.provider.kind === "model" && (maxUsd == null || maxUsd > 0),
      fullVideo:
        videoBatches.length > 0 && video
          ? {
              durationMs: video.durationMs,
              byteSize: video.byteSize,
              transfer:
                video.byteSize != null && args.provider.videoTransfer
                  ? args.provider.videoTransfer(video.byteSize)
                  : null,
              criteria: videoBatches.flatMap((b) => b.criterionKeys),
              sampling: videoBatches[0]!.sampling ?? null,
            }
          : null,
    },
  };
}
