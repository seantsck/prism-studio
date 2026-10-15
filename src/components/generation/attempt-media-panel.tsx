import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { CropPreviewPlayer } from "@/components/framing/crop-preview-player";
import { Badge, Button } from "@/components/ui";
import { QA_STATUS_LABELS, describeSummary, type QaStatus } from "@/domain/continuity/status";
import { FRAMING_LABELS } from "@/domain/framing/adaptation";
import type { GenerationAttempt } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import { createDeliveryConform, selectDeliveryMaster, startContinuityReview } from "@/server/media-actions";
import type { AttemptMedia } from "@/server/attempt-media";

type Tone = "neutral" | "pass" | "warn" | "fail" | "info" | "accent";

const QA_TONE: Record<QaStatus, Tone> = {
  not_started: "neutral",
  in_review: "info",
  passed: "pass",
  passed_with_warnings: "warn",
  failed: "fail",
};

const secs = (ms: number | null | undefined) => (ms ? `${(ms / 1000).toFixed(2)}s` : "—");
const dims = (a: { width: number | null; height: number | null } | null | undefined) =>
  a?.width && a.height ? `${a.width}×${a.height}` : "—";

/**
 * Three SEPARATE facts about an attempt, never one overloaded green check:
 *   Generated · Continuity · Creative review
 */
export function StageChips({
  attempt,
  generated,
  qaStatus,
  qaStale,
}: {
  attempt: Pick<GenerationAttempt, "status" | "reviewStatus">;
  /** Execution result label (job status or attempt status). */
  generated: { label: string; tone: Tone };
  qaStatus: QaStatus;
  qaStale: boolean;
}) {
  const creative: Tone =
    attempt.reviewStatus === "approved" ? "pass" : attempt.reviewStatus === "rejected" ? "fail" : "neutral";
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="stage-chips">
      <span title="Generation" data-testid="chip-generated">
        <Badge tone={generated.tone}>Generated · {generated.label}</Badge>
      </span>
      <span title="Continuity QA (advisory)" data-testid="chip-continuity" data-status={qaStatus}>
        <Badge tone={QA_TONE[qaStatus]}>
          Continuity · {QA_STATUS_LABELS[qaStatus].replace(/^QA /, "")}
          {qaStale ? " · stale" : ""}
        </Badge>
      </span>
      <span title="Creative approval (human)" data-testid="chip-creative" data-review={attempt.reviewStatus}>
        <Badge tone={creative}>Creative · {attempt.reviewStatus}</Badge>
      </span>
    </div>
  );
}

export function AttemptMediaPanel({
  projectSlug,
  attemptId,
  media,
  succeeded,
}: {
  projectSlug: string;
  attemptId: string;
  media: AttemptMedia;
  succeeded: boolean;
}) {
  const { plan, original, delivery } = media;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="attemptId" value={attemptId} />
    </>
  );
  if (!original) return null;

  const isVideo = original.type === "video";
  const providerRatio = original.width && original.height ? original.width / original.height : 16 / 9;
  const conformRequired = plan?.conform.required === true;
  const conformDone = delivery !== null && !delivery.isOriginal;
  const retained = plan?.framing.status === "adapted" ? plan.framing.retained : null;
  const latest = media.latestRun;

  return (
    <section className="space-y-3 border border-line bg-panel p-3" data-testid="attempt-media">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="border border-line bg-bg p-2.5" data-testid="provider-original-card">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            Provider original
          </div>
          <div className="mt-1 text-[12px]">
            <div>
              {plan?.provider.provider ?? "provider"} / {plan?.provider.modelId ?? ""}
            </div>
            <div className="font-mono text-[11px] text-muted">
              {dims(original)}
              {plan?.framing.providerLabel ? ` · ${plan.framing.providerLabel}` : ""} ·{" "}
              {secs(original.durationMs)}
            </div>
            <div className="text-[11px] text-faint">Immutable · never replaced by a conform</div>
          </div>
        </div>
        <div className="border border-line bg-bg p-2.5" data-testid="production-target-card">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            Production target
          </div>
          {plan ? (
            <div className="mt-1 text-[12px]">
              <div className="font-mono text-[11px]">
                {plan.production.aspectRatio ?? "—"} · {secs(plan.production.durationMs)}
              </div>
              <div className="text-[11px] text-faint">Canonical: provider limits never alter it</div>
            </div>
          ) : (
            <div className="mt-1 text-[12px] text-muted" data-testid="no-adaptation-plan">
              No adaptation plan recorded (this attempt predates framing adaptation).
            </div>
          )}
        </div>
        <div className="border border-line bg-bg p-2.5" data-testid="conform-card">
          <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Conform</div>
          {plan ? (
            <div className="mt-1 space-y-0.5 text-[12px]">
              {conformRequired ? (
                <>
                  {plan.conform.framing === "crop" ? (
                    <div>
                      Crop {plan.framing.providerLabel} → {plan.production.aspectRatio}
                    </div>
                  ) : null}
                  {plan.conform.framing === "letterbox" || plan.conform.framing === "pillarbox" ? (
                    <div>
                      {plan.conform.framing === "letterbox" ? "Letterbox" : "Pillarbox"} into{" "}
                      {plan.production.aspectRatio}
                    </div>
                  ) : null}
                  {plan.conform.trimToMs != null ? (
                    <div>
                      Trim {secs(plan.duration.providerMs)} → {secs(plan.conform.trimToMs)}
                    </div>
                  ) : null}
                  <div className="font-mono text-[11px] text-muted" data-testid="delivery-size">
                    Delivery:{" "}
                    {conformDone
                      ? `${dims(delivery!.asset)} · ${secs(delivery!.asset.durationMs)}`
                      : "not created yet"}
                  </div>
                </>
              ) : (
                <div className="text-muted">None needed: the provider original is the delivery master.</div>
              )}
            </div>
          ) : (
            <div className="mt-1 text-[12px] text-muted">—</div>
          )}
        </div>
      </div>

      {isVideo && original.objectPath ? (
        <CropPreviewPlayer
          originalUrl={assetUrl(original)!}
          deliveryUrl={conformDone ? assetUrl(delivery!.asset) : null}
          retained={conformDone ? null : retained}
          providerRatio={providerRatio}
          productionLabel={plan?.production.aspectRatio ?? null}
          providerLabel={plan?.framing.providerLabel ?? null}
          originalSize={{ width: original.width, height: original.height }}
          deliverySize={conformDone ? { width: delivery!.asset.width, height: delivery!.asset.height } : null}
          durationMs={original.durationMs}
        />
      ) : null}

      <div className="flex flex-wrap items-start gap-3">
        {succeeded && plan && conformRequired && !conformDone ? (
          <ActionForm action={createDeliveryConform} successMessage="Delivery conform created" quiet>
            {hidden}
            <Button size="sm" variant="primary" type="submit" data-testid="create-conform">
              Create delivery conform
            </Button>
          </ActionForm>
        ) : null}
        {succeeded && original ? (
          <ActionForm action={startContinuityReview} successMessage="Continuity review created" quiet>
            {hidden}
            <Button size="sm" type="submit" data-testid="start-continuity">
              {latest ? "Run a new continuity review" : "Start continuity review"}
            </Button>
          </ActionForm>
        ) : null}
        {latest ? (
          <Link
            className="text-[12px] text-accent hover:underline"
            href={`/projects/${projectSlug}/generations/${attemptId}/continuity`}
            data-testid="open-continuity"
          >
            Open continuity review →
          </Link>
        ) : null}
      </div>

      {media.versions.length > 0 ? (
        <div className="border border-line bg-bg p-2.5" data-testid="delivery-versions">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            Delivery versions (derived · lineage kept)
          </div>
          <ul className="space-y-1 text-[12px]">
            {media.versions.map((v) => {
              const selected = delivery?.asset.id === v.asset.id;
              return (
                <li key={v.asset.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px]">v{v.derivation.version}</span>
                  <span>
                    {dims(v.asset)} · {secs(v.asset.durationMs)}
                  </span>
                  <span className="text-faint">
                    {v.derivation.operation} · {v.derivation.processor} {v.derivation.processorVersion}
                  </span>
                  {selected ? (
                    <Badge tone="pass">delivery master</Badge>
                  ) : (
                    <ActionForm action={selectDeliveryMaster} quiet successMessage="Delivery master selected">
                      {hidden}
                      <input type="hidden" name="assetId" value={v.asset.id} />
                      <Button size="sm" variant="ghost" type="submit">
                        Use as delivery master
                      </Button>
                    </ActionForm>
                  )}
                </li>
              );
            })}
            <li className="flex items-center gap-2 text-muted">
              <span className="font-mono text-[11px]">original</span>
              <span>{dims(original)}</span>
              {delivery?.isOriginal ? (
                <Badge tone="pass">delivery master</Badge>
              ) : (
                <ActionForm action={selectDeliveryMaster} quiet successMessage="Original selected">
                  {hidden}
                  <input type="hidden" name="assetId" value={original.id} />
                  <Button size="sm" variant="ghost" type="submit">
                    Use original as delivery master
                  </Button>
                </ActionForm>
              )}
            </li>
          </ul>
        </div>
      ) : null}

      {media.contactSheet ? (
        <div data-testid="contact-sheet">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            Contact sheet · first / 25% / 50% / 75% / last
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={assetUrl(media.contactSheet)!}
            alt="Contact sheet of review frames"
            className="max-h-48 border border-line"
          />
        </div>
      ) : null}

      {latest ? (
        <div className="border border-line bg-bg p-2.5 text-[12px]" data-testid="qa-summary">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">
              Continuity QA · run {latest.view.run.runNumber}
            </span>
            <Badge tone={QA_TONE[latest.status]}>{QA_STATUS_LABELS[latest.status]}</Badge>
            {latest.freshness?.stale ? <Badge tone="warn">stale</Badge> : null}
            {latest.analyzerKind === "mock" ? <Badge tone="info">MOCK ANALYSIS</Badge> : null}
          </div>
          <ul className="space-y-0.5 text-muted">
            {describeSummary(latest.summary, latest.analyzerKind).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {media.advisories.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] text-warn" data-testid="qa-advisories">
          {media.advisories.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}

      {plan && plan.framing.status === "adapted" ? (
        <p className="text-[11px] text-faint">
          Strategy: {FRAMING_LABELS[plan.framing.strategy]} · plan {plan.fingerprint.slice(0, 8)}
        </p>
      ) : null}
    </section>
  );
}
