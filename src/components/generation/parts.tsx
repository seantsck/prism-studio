import { Badge } from "@/components/ui";
import { JOB_STATUS_LABELS } from "@/domain/generation/job-state";
import { SHOT_GENERATION_LABELS, type ShotGenerationState } from "@/domain/generation/lifecycle";
import type { GenerationJob, ReviewStatus } from "@/domain/generation/schemas";
import type { Asset, GenerationAttempt } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";

type Tone = "neutral" | "pass" | "warn" | "fail" | "info" | "accent";

const JOB_TONE: Record<GenerationJob["status"], Tone> = {
  queued: "neutral",
  submitting: "accent",
  submitted: "accent",
  processing: "accent",
  ingesting: "accent",
  succeeded: "info",
  failed: "fail",
  cancel_requested: "warn",
  cancelled: "neutral",
};

export function JobBadge({ status, testId }: { status: GenerationJob["status"]; testId?: string }) {
  return (
    <span data-testid={testId}>
      <Badge tone={JOB_TONE[status]}>{JOB_STATUS_LABELS[status]}</Badge>
    </span>
  );
}

/** Execution status of an attempt that has no job (legacy manual logs) or whose job is not loaded. */
export function AttemptStatusBadge({ status }: { status: GenerationAttempt["status"] }) {
  const tone: Tone =
    status === "succeeded"
      ? "info"
      : status === "failed"
        ? "fail"
        : status === "running"
          ? "accent"
          : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  const tone: Tone = status === "approved" ? "pass" : status === "rejected" ? "fail" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

const STATE_TONE: Record<ShotGenerationState, Tone> = {
  not_ready: "warn",
  ready: "pass",
  queued: "neutral",
  generating: "accent",
  ready_for_review: "info",
  approved: "pass",
  needs_redo: "fail",
};

export function LifecycleBadge({ state }: { state: ShotGenerationState }) {
  return (
    <span data-testid="shot-generation-state">
      <Badge tone={STATE_TONE[state]}>{SHOT_GENERATION_LABELS[state]}</Badge>
    </span>
  );
}

export function OutputPreview({
  asset,
  className = "w-full",
  controls = true,
}: {
  asset: Pick<Asset, "id" | "type" | "objectPath" | "name">;
  className?: string;
  controls?: boolean;
}) {
  const url = assetUrl(asset);
  if (!url) return <div className="border border-dashed border-line2 p-3 text-muted">No stored file.</div>;
  if (asset.type === "video") {
    return (
      <video
        src={url}
        controls={controls}
        preload="metadata"
        playsInline
        className={className}
        data-testid="output-video"
      />
    );
  }
  if (asset.type === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={asset.name} className={className} data-testid="output-image" />;
  }
  if (asset.type === "audio") {
    return <audio src={url} controls className={className} />;
  }
  return <a href={url}>{asset.name}</a>;
}

export const formatMoney = (amount: number | null, currency: string) =>
  amount == null
    ? "Unknown"
    : `${currency === "USD" ? "$" : ""}${amount.toFixed(amount < 1 ? 3 : 2)}${currency === "USD" ? "" : ` ${currency}`}`;

export function formatElapsed(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return "—";
  const to = toIso ? Date.parse(toIso) : Date.now();
  const s = Math.max(0, Math.round((to - Date.parse(fromIso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
