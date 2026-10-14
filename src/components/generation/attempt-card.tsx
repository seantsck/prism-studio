import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import type { AttemptView } from "@/data/generation-repository";
import { isActive } from "@/domain/generation/job-state";
import type { AttemptMedia } from "@/server/attempt-media";
import { AttemptMediaPanel, StageChips } from "./attempt-media-panel";
import { REJECTION_CATEGORIES, REJECTION_LABELS, USER_ERROR_NOTE } from "./constants";
import {
  AttemptStatusBadge,
  JobBadge,
  OutputPreview,
  ReviewBadge,
  formatElapsed,
  formatMoney,
} from "./parts";
import { cancelGeneration, reviewGeneration } from "@/server/generation-actions";

/** One attempt: immutable intent (links to its frozen brief) + execution state + review. */
export function AttemptCard({
  view,
  projectSlug,
  compareWith,
  media = null,
  candidate = null,
}: {
  view: AttemptView;
  projectSlug: string;
  /** Phase 2E: the candidate set this attempt belongs to (null = a standalone generation). */
  candidate?: { setId: string; label: string; title: string } | null;
  /** Media + continuity QA for this attempt (derived delivery, plan, QA status). */
  media?: AttemptMedia | null;
  /** Previous attempt id, for the "compare with attempt N-1" link. */
  compareWith?: { id: string; number: number };
}) {
  const { attempt, job, outputs, costs } = view;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="attemptId" value={attempt.id} />
    </>
  );
  const estimated = costs.find((c) => c.kind === "estimated");
  const final = costs.find((c) => c.kind !== "estimated");
  const active = job ? isActive(job.status) : false;
  const primary = outputs.find((o) => o.output.role === "primary") ?? outputs[0];
  const others = outputs.filter((o) => o !== primary);
  const canReview = attempt.status === "succeeded";

  return (
    <article
      className="border border-line bg-panel"
      data-testid="attempt-card"
      data-attempt={attempt.attemptNumber}
      data-review={attempt.reviewStatus}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium">Attempt {attempt.attemptNumber}</span>
          <span className="text-muted">
            {attempt.provider} / {attempt.model}
          </span>
          {attempt.requestModality ? (
            <span className="font-mono text-[10.5px] text-faint">{attempt.requestModality}</span>
          ) : null}
          {candidate ? (
            <Link
              href={`/projects/${projectSlug}/candidates/${candidate.setId}`}
              className="text-[10.5px] underline"
              data-testid="candidate-origin"
            >
              Candidate {candidate.label} · {candidate.title || "set"}
            </Link>
          ) : (
            <span className="text-[10.5px] text-faint" data-testid="standalone-origin">
              Standalone generation
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {job ? (
            <JobBadge status={job.status} testId="job-status" />
          ) : (
            <AttemptStatusBadge status={attempt.status} />
          )}
          <span data-testid="review-status">
            <ReviewBadge status={attempt.reviewStatus} />
          </span>
          {attempt.approved ? <Badge tone="pass">canonical</Badge> : null}
        </div>
      </header>

      {media ? (
        <div className="border-b border-line px-3 py-1.5">
          <StageChips
            attempt={attempt}
            generated={
              job
                ? {
                    label: job.status.replace(/_/g, " "),
                    tone: job.status === "succeeded" ? "pass" : job.status === "failed" ? "fail" : "neutral",
                  }
                : { label: attempt.status, tone: attempt.status === "succeeded" ? "pass" : "neutral" }
            }
            qaStatus={media.qaStatus}
            qaStale={media.qaStale}
          />
        </div>
      ) : null}

      <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-1.5 text-[12px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt className="text-muted">Started</dt>
            <dd>{new Date(attempt.createdAt).toLocaleString()}</dd>
            <dt className="text-muted">Elapsed</dt>
            <dd>
              {formatElapsed(
                job?.startedAt ?? attempt.createdAt,
                job?.completedAt ?? job?.failedAt ?? job?.cancelledAt ?? null,
              )}
            </dd>
            <dt className="text-muted">Duration</dt>
            <dd>{attempt.durationMs ? `${(attempt.durationMs / 1000).toFixed(2)}s` : "—"}</dd>
            <dt className="text-muted">Cost</dt>
            <dd data-testid="attempt-cost">
              Estimated {formatMoney(estimated?.amount ?? null, estimated?.currency ?? "USD")} · Actual{" "}
              {final
                ? final.kind === "actual"
                  ? formatMoney(final.amount, final.currency)
                  : "Unknown"
                : "—"}
            </dd>
            <dt className="text-muted">Brief</dt>
            <dd>
              <Link
                className="text-accent hover:underline"
                href={`/projects/${projectSlug}/generations/${attempt.id}`}
                data-testid="open-brief"
              >
                Open frozen brief #{attempt.packageFingerprint.slice(0, 8)} →
              </Link>
            </dd>
          </dl>

          {job?.status === "failed" ? (
            <p className="border border-fail/40 bg-fail/5 p-2 text-fail" data-testid="job-error">
              {job.lastErrorMessage || USER_ERROR_NOTE}
            </p>
          ) : null}
          {job?.status === "cancelled" ? (
            <p className="border border-line2 p-2 text-muted" data-testid="cancel-outcome">
              {job.cancelOutcome === "confirmed"
                ? "Cancelled; the provider confirmed."
                : job.cancelOutcome === "local_only"
                  ? "Cancelled before it was sent to a provider."
                  : "Cancelled in Prism. The provider did not confirm cancellation and may still complete (and bill) this generation."}
            </p>
          ) : null}
          {job && job.lastErrorMessage && job.status !== "failed" && active ? (
            <p className="text-[11px] text-warn">{job.lastErrorMessage}</p>
          ) : null}

          {attempt.rejectionCategories.length > 0 || attempt.rejectionReason ? (
            <div className="space-y-1" data-testid="rejection-info">
              <div className="flex flex-wrap gap-1">
                {attempt.rejectionCategories.map((c) => (
                  <Badge key={c} tone="fail">
                    {REJECTION_LABELS[c]}
                  </Badge>
                ))}
              </div>
              {attempt.rejectionReason ? <div className="text-fail">{attempt.rejectionReason}</div> : null}
            </div>
          ) : null}
          {attempt.notes ? <div className="text-muted">Notes: {attempt.notes}</div> : null}
        </div>

        <div className="min-w-0 space-y-2">
          {primary ? (
            <div className="space-y-1.5">
              <OutputPreview asset={primary.asset} className="max-h-72 w-full border border-line bg-black" />
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="font-mono">{primary.asset.name}</span>
                {primary.asset.durationMs ? (
                  <span>{(primary.asset.durationMs / 1000).toFixed(1)}s</span>
                ) : null}
                {primary.asset.width ? (
                  <span>
                    {primary.asset.width}×{primary.asset.height}
                  </span>
                ) : null}
                <Link
                  className="text-accent hover:underline"
                  href={`/projects/${projectSlug}/assets?q=${encodeURIComponent(primary.asset.name)}`}
                >
                  Open in library
                </Link>
              </div>
              {others.length > 0 ? (
                <div className="flex gap-2">
                  {others.map((o) => (
                    <div key={o.output.id} className="w-24">
                      <OutputPreview asset={o.asset} className="w-full border border-line" controls={false} />
                      <div className="text-[10px] text-faint">{o.output.role}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center border border-dashed border-line2 text-muted">
              {active ? "Output will appear here." : "No output."}
            </div>
          )}
        </div>
      </div>

      {media && canReview ? (
        <div className="border-t border-line p-3">
          <AttemptMediaPanel
            projectSlug={projectSlug}
            attemptId={attempt.id}
            media={media}
            succeeded={canReview}
          />
        </div>
      ) : null}

      <footer className="flex flex-wrap items-start gap-3 border-t border-line px-3 py-2">
        {active && job && job.status !== "cancel_requested" ? (
          <ActionForm action={cancelGeneration} successMessage="Cancellation requested" quiet>
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <input type="hidden" name="jobId" value={job.id} />
            <Button size="sm" variant="danger" type="submit" data-testid="cancel-button">
              Cancel generation
            </Button>
          </ActionForm>
        ) : null}

        {canReview && media && media.advisories.length > 0 && attempt.reviewStatus !== "approved" ? (
          <p className="basis-full text-[11px] text-warn" data-testid="approval-advisory">
            Before approving: {media.advisories.join(" ")}
          </p>
        ) : null}
        {canReview ? (
          <>
            {attempt.reviewStatus !== "approved" ? (
              <ActionForm action={reviewGeneration} successMessage="Approved" quiet>
                {hidden}
                <input type="hidden" name="decision" value="approve" />
                <Button size="sm" variant="primary" type="submit" data-testid="approve-button">
                  Approve
                </Button>
              </ActionForm>
            ) : null}
            {attempt.reviewStatus !== "rejected" ? (
              <details className="min-w-[16rem]">
                <summary
                  className="cursor-pointer text-[12px] text-fail hover:underline"
                  data-testid="reject-toggle"
                >
                  Reject…
                </summary>
                <ActionForm action={reviewGeneration} className="mt-2 space-y-2" successMessage="Rejected">
                  {hidden}
                  <input type="hidden" name="decision" value="reject" />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                    {REJECTION_CATEGORIES.map((c) => (
                      <label key={c} className="flex items-center gap-1.5">
                        <input type="checkbox" name="category" value={c} />
                        {REJECTION_LABELS[c]}
                      </label>
                    ))}
                  </div>
                  <input name="reason" placeholder="What is wrong? (e.g. door opened on the wrong side)" />
                  <input name="notes" placeholder="Notes for the next attempt" defaultValue={attempt.notes} />
                  <Button size="sm" variant="danger" type="submit" data-testid="reject-submit">
                    Reject attempt
                  </Button>
                </ActionForm>
              </details>
            ) : null}
            {attempt.reviewStatus !== "unreviewed" ? (
              <ActionForm action={reviewGeneration} quiet>
                {hidden}
                <input type="hidden" name="decision" value="clear" />
                <Button size="sm" variant="ghost" type="submit">
                  Clear review
                </Button>
              </ActionForm>
            ) : null}
          </>
        ) : null}

        {compareWith ? (
          <Link
            className="ml-auto text-[12px] text-accent hover:underline"
            href={`/projects/${projectSlug}/generations/compare?a=${compareWith.id}&b=${attempt.id}`}
          >
            Compare with attempt {compareWith.number} →
          </Link>
        ) : null}
      </footer>
    </article>
  );
}
