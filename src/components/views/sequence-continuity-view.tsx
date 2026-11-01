import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { SequenceAutoReconciler, SequenceJobPoller } from "@/components/continuity/sequence-automation";
import { ContinuityFilters } from "@/components/sequence/continuity-filters";
import type { SequenceAutoView } from "@/continuity/sequence-automation";
import { Badge, Button, Empty, PageHeader } from "@/components/ui";
import {
  CUT_INTENT_KIND_LABELS,
  CUT_INTENT_KINDS,
  CUT_INTENT_NOTE_MAX,
} from "@/domain/continuity/cut-intent";
import { CATEGORY_LABELS, CONTINUITY_CATEGORIES } from "@/domain/continuity/model";
import { shouldPollSequenceStatus, type SequenceStatus } from "@/domain/continuity/sequence-status";
import type { Episode } from "@/domain/schemas";
import { clearCutIntent, setCutIntent } from "@/server/episode-edit-actions";
import { startSequenceReview } from "@/server/sequence-review-actions";
import {
  EDGE_MEDIA_NOTE,
  NO_CUTS_MESSAGE,
  NO_EDIT_MESSAGE,
  RUNS_NOTE,
  SEMANTIC_NOTE,
  SEQUENCE_MODE_LABELS,
  type ContinuityPageVM,
  type CutRowVM,
  type FindingVM,
  type RunHistoryVM,
  type SideVM,
  type SupervisorLinks,
} from "./sequence-continuity-model";

const REVIEW_FORM = "sequence-review-select";

/**
 * Phase 3A.4B Continuity Supervisor: the actual cuts of the persisted Episode Edit, deterministic review only. Advisory:
 * nothing here approves, rejects, regenerates, selects, edits or analyses anything. Media comes only through the
 * private asset route.
 */
export function SequenceContinuityView({ episode, page }: { episode: Episode; page: ContinuityPageVM }) {
  const header = (
    <PageHeader
      title={`Continuity Supervisor — ${episode.title}`}
      subtitle={<Subtitle links={page.links} />}
      actions={
        page.state === "edit" ? (
          <Badge tone="accent">
            <span data-testid="continuity-revision">Edit revision {page.revision}</span>
          </Badge>
        ) : null
      }
    />
  );

  if (page.state === "error")
    return (
      <div>
        {header}
        <div className="p-6">
          <div
            role="alert"
            data-testid="continuity-error"
            className="border border-fail/50 bg-fail/10 p-4 text-fail"
          >
            {page.message}
          </div>
        </div>
      </div>
    );

  if (page.state === "no_edit")
    return (
      <div data-testid="continuity-no-edit">
        {header}
        <div className="p-6">
          <Empty>
            <p>{NO_EDIT_MESSAGE}</p>
            <p className="mt-2">
              <Link href={page.links.edit} className="text-accent hover:underline">
                Open the Episode Edit
              </Link>{" "}
              ·{" "}
              <Link href={page.links.sequence} className="text-accent hover:underline">
                Sequence Board (planned order)
              </Link>
            </p>
          </Empty>
        </div>
      </div>
    );

  const s = page.summary;
  return (
    <div data-testid="continuity-supervisor">
      {header}
      <div className="space-y-4 p-4 sm:p-6">
        <dl
          className="grid grid-cols-2 gap-2 text-[11.5px] sm:grid-cols-3 lg:grid-cols-6"
          data-testid="continuity-summary"
          aria-label="Cut counts"
        >
          <Count label="Cuts" value={s.cuts} id="cuts" />
          <Count label="Critical breaks" value={s.criticalBreaks} id="critical" tone="fail" />
          <Count label="Cuts with deterministic warnings" value={s.warningCuts} id="warnings" tone="warn" />
          <Count label="Semantic criteria unchecked" value={s.semanticUnchecked} id="semantic-unchecked" />
          <Count label="Scene boundaries" value={s.sceneBoundaries} id="scene-boundaries" />
          <Count
            label="Cuts blocked from semantic media"
            value={s.semanticMediaBlocked}
            id="semantic-media-blocked"
          />
        </dl>
        <p className="text-[11px] text-faint" data-testid="continuity-runs-note">
          {RUNS_NOTE}
        </p>
        {page.autoSequence ? (
          <SequenceAutomationPanel
            auto={page.autoSequence}
            status={page.sequenceStatus ?? null}
            projectSlug={page.projectSlug}
            episodeId={page.episodeId ?? episode.id}
            editId={page.editId}
            continuityHref={`/projects/${page.projectSlug}/episodes/${episode.slug}/continuity`}
          />
        ) : null}
        {page.rows.length > 0 && page.analyzers.length > 0 ? (
          // a plain GET: selecting cuts only DISCLOSES what a review would do (nothing is derived or queued)
          <form
            id={REVIEW_FORM}
            method="get"
            className="flex flex-wrap items-center gap-2 border border-line bg-panel p-2 text-[11.5px]"
            data-testid="sequence-review-select"
          >
            <span className="font-semibold">Sequence Continuity review</span>
            <span className="text-faint">Tick cuts below, then</span>
            <select
              name="analyzer"
              defaultValue={page.selectedAnalyzer ?? undefined}
              aria-label="Sequence Continuity analyzer"
              className="!w-auto"
              data-testid="sequence-review-analyzer"
            >
              {page.analyzers.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <Button type="submit" data-testid="sequence-review-prepare">
              Prepare semantic review
            </Button>
          </form>
        ) : null}
        {page.review ? <ReviewPanel page={page} episode={episode} /> : null}
        {page.info.length ? (
          <ul className="text-[11.5px] text-muted" data-testid="continuity-info">
            {page.info.map((i) => (
              <li key={i}>ⓘ {i}</li>
            ))}
          </ul>
        ) : null}
        {page.rows.length === 0 ? (
          <Empty>
            <span data-testid="continuity-no-cuts">{NO_CUTS_MESSAGE}</span>
          </Empty>
        ) : (
          <ContinuityFilters counts={page.filterCounts}>
            <ol className="space-y-3">
              {page.rows.map((r) => (
                <CutRow
                  key={r.anchor}
                  row={r}
                  target={{ projectSlug: page.projectSlug, editId: page.editId, revision: page.revision }}
                />
              ))}
            </ol>
          </ContinuityFilters>
        )}
      </div>
    </div>
  );
}

/** Sequence automation status. It shows counts and reasons only: never an Episode continuity score. */
export function SequenceAutomationPanel({
  auto,
  status,
  projectSlug,
  episodeId,
  editId,
  continuityHref,
}: {
  auto: SequenceAutoView;
  status: SequenceStatus | null;
  projectSlug: string;
  episodeId: string;
  editId: string;
  continuityHref: string;
}) {
  const c = auto.counts;
  const money = (n: number | null) => (n == null ? "unknown" : `$${n.toFixed(4)}`);
  const review = auto.reviewBatch;
  const reviewHref = review
    ? `${continuityHref}?${[
        ...review.transitionKeys.map((k) => `review=${encodeURIComponent(k)}`),
        `analyzer=${encodeURIComponent(review.analyzer)}`,
      ].join("&")}`
    : null;
  return (
    <section
      className="space-y-1 border border-line bg-panel p-3 text-[12px]"
      data-testid="sequence-automation"
      data-mode={auto.mode}
    >
      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        Sequence Continuity automation ·{" "}
        <span data-testid="sequence-auto-mode">{SEQUENCE_MODE_LABELS[auto.mode]}</span>
      </h2>
      {!auto.ready ? (
        <p className="text-muted" data-testid="sequence-auto-not-ready">
          Automatic Sequence Continuity needs database migration 0047. Manual reviews still work.
        </p>
      ) : auto.mode === "off" ? (
        <p className="text-muted">
          No cut is analysed automatically. Manual reviews below stay available.{" "}
          <Link href={`/projects/${projectSlug}/qa`} className="text-accent hover:underline">
            QA settings
          </Link>
        </p>
      ) : (
        <>
          <p className="text-muted">
            Analyzer {auto.analyzer ?? "none"}
            {auto.calibration
              ? ` · calibration ${auto.calibration.version}, ${auto.calibration.acceptedFamilies} accepted families`
              : ""}{" "}
            · batch cap {auto.batchCap}
          </p>
          <p data-testid="sequence-auto-counts">
            <span data-testid="sequence-auto-due">{c.due}</span> settled cuts due ·{" "}
            <span data-testid="sequence-auto-settling">{c.settling}</span> settling ·{" "}
            <span data-testid="sequence-auto-blocked">{c.blocked + c.unknown}</span> blocked ·{" "}
            <span data-testid="sequence-auto-covered">{c.covered}</span> covered ·{" "}
            <span data-testid="sequence-auto-active">{status?.edit.active ?? 0}</span> active jobs
          </p>
          {c.due > 0 ? (
            <p className="text-muted" data-testid="sequence-auto-cost">
              Estimated worst case {money(auto.dueMaxUsd)}
              {auto.waveCuts < c.due ? ` · next wave ${auto.waveCuts} cuts, ${money(auto.waveMaxUsd)}` : ""}
            </p>
          ) : null}
          {c.settling > 0 ? (
            <p className="text-faint">
              A cut settles after 10 quiet minutes, and is picked up the next time this page opens.
            </p>
          ) : null}
          {c.unknown > 0 ? (
            <p className="text-warn" data-testid="sequence-auto-unknown">
              {c.unknown} cuts cannot be shown to have settled, so they are not submitted automatically.
              Manual review stays available.
            </p>
          ) : null}
          {auto.mode === "automatic" ? (
            <p className="text-faint">
              Queued work runs under this Project&apos;s standing authorisation. It is advisory only.
            </p>
          ) : null}
          {reviewHref ? (
            <p>
              <Link
                href={reviewHref}
                className="text-accent hover:underline"
                data-testid="sequence-auto-review"
              >
                Review batch
              </Link>
              {review && review.more > 0 ? (
                <span className="text-muted"> · {review.more} more stay due after this batch</span>
              ) : null}
            </p>
          ) : null}
          {auto.reasons.length > 0 ? (
            <ul className="text-[11px] text-warn" data-testid="sequence-auto-reasons">
              {auto.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <SequenceAutoReconciler projectSlug={projectSlug} episodeId={episodeId} dueKey={auto.dueKey} />
      {status ? (
        <SequenceJobPoller
          projectSlug={projectSlug}
          editId={editId}
          initialSignature={status.signature}
          poll={shouldPollSequenceStatus({
            mode: auto.mode,
            ready: auto.ready,
            editActive: status.edit.active,
            capacityBlocked: auto.capacityBlocked,
          })}
        />
      ) : null}
    </section>
  );
}

function Subtitle({ links }: { links: SupervisorLinks }) {
  return (
    <>
      The actual cuts in the persisted{" "}
      <Link href={links.edit} className="text-accent hover:underline">
        Episode Edit
      </Link>{" "}
      (the editorial assembly), in edit order. The{" "}
      <Link
        href={links.sequence}
        className="text-accent hover:underline"
        data-testid="continuity-sequence-link"
      >
        Sequence Board
      </Link>{" "}
      is the planned Shot order. Deterministic checks are live; Sequence Continuity review is manual and each
      cut family is calibration-gated. Advisory only.
    </>
  );
}

function Count({
  label,
  value,
  id,
  tone,
}: {
  label: string;
  value: number;
  id: string;
  tone?: "fail" | "warn";
}) {
  return (
    <div className="border border-line bg-panel px-2.5 py-1.5" data-testid={`count-${id}`}>
      <dt className="text-faint">{label}</dt>
      <dd
        className={`font-mono text-[15px] ${value > 0 && tone === "fail" ? "text-fail" : value > 0 && tone === "warn" ? "text-warn" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

interface IntentTarget {
  projectSlug: string;
  editId: string;
  revision: number;
}

/** The fields every intent form sends: the edit at its revision and the cut (right item, reviewed predecessor). */
function IntentFields({ target, row }: { target: IntentTarget; row: CutRowVM }) {
  return (
    <>
      <input type="hidden" name="projectSlug" value={target.projectSlug} />
      <input type="hidden" name="editId" value={target.editId} />
      <input type="hidden" name="expectedRevision" value={target.revision} />
      <input type="hidden" name="itemId" value={row.rightItemId} />
      <input type="hidden" name="expectedPredecessorId" value={row.leftItemId} />
    </>
  );
}

/**
 * 3A.4C: the person's declaration that this cut is deliberate. Editorial, not QA: it records intent, it never changes
 * a finding, hides evidence or approves anything, and until a sequence analysis has run it does not change the state.
 */
function CutIntentPanel({ row, target }: { row: CutRowVM; target: IntentTarget }) {
  const intent = row.intent;
  return (
    <section className="mt-2 border-t border-line pt-2 text-[11.5px]" data-testid="cut-intent">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">
        Intentional discontinuity
      </h3>
      {intent ? (
        <div data-testid="cut-intent-declared" className="mt-1 space-y-0.5">
          <p>
            <Badge tone="accent">
              <span data-testid="cut-intent-badge">This cut is deliberate</span>
            </Badge>{" "}
            <span data-testid="cut-intent-kinds">{intent.kinds.join(", ")}</span>
            <span className="text-faint"> · scope: </span>
            <span data-testid="cut-intent-scope">{intent.scope.join(", ")}</span>
          </p>
          <p className="text-muted" data-testid="cut-intent-note">
            “{intent.note}”
          </p>
          <p className="text-faint">
            Declared {intent.declaredAt.slice(0, 16).replace("T", " ")} UTC for this exact cut ({row.title}).
            It is kept while these two items stay adjacent and cleared if the cut changes. It does not change
            or hide any finding, and it is not a QA result.
          </p>
          <ActionForm action={clearCutIntent} successMessage="" className="inline">
            <IntentFields target={target} row={row} />
            <Button type="submit" size="sm" data-testid="cut-intent-clear">
              Remove intent
            </Button>
          </ActionForm>
        </div>
      ) : (
        <p className="mt-1 text-muted" data-testid="cut-intent-none">
          No intent declared for this cut.
        </p>
      )}
      <details className="mt-1" data-testid="cut-intent-editor">
        <summary className="cursor-pointer text-accent">
          {intent ? "Update the declared intent" : "This cut is deliberate…"}
        </summary>
        <ActionForm action={setCutIntent} successMessage="" className="mt-1 space-y-1.5">
          <IntentFields target={target} row={row} />
          <fieldset>
            <legend className="text-faint">What kind of discontinuity (at least one)</legend>
            <div className="flex flex-wrap gap-x-3">
              {CUT_INTENT_KINDS.map((k) => (
                <label key={k} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    name="kinds"
                    value={k}
                    defaultChecked={intent?.raw.kinds.includes(k)}
                    data-testid={`cut-intent-kind-${k}`}
                  />
                  {CUT_INTENT_KIND_LABELS[k]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-faint">Which continuity it concerns (none = every category)</legend>
            <div className="flex flex-wrap gap-x-3">
              {CONTINUITY_CATEGORIES.map((c) => (
                <label key={c} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    name="scope"
                    value={c}
                    defaultChecked={intent?.raw.scope.includes(c)}
                  />
                  {CATEGORY_LABELS[c]}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="text-faint">Why it is deliberate</span>
            <textarea
              name="note"
              required
              maxLength={CUT_INTENT_NOTE_MAX}
              defaultValue={intent?.raw.note ?? ""}
              rows={2}
              data-testid="cut-intent-note-input"
              className="mt-0.5 block w-full rounded-[3px] border border-line2 bg-bg px-2 py-1"
            />
          </label>
          <Button type="submit" size="sm" variant="primary" data-testid="cut-intent-submit">
            Record intentional discontinuity
          </Button>
        </ActionForm>
      </details>
    </section>
  );
}

function CutRow({ row, target }: { row: CutRowVM; target: IntentTarget }) {
  const issues = row.attention.length;
  return (
    <li
      id={row.anchor}
      data-testid="cut-row"
      data-state={row.state}
      data-has-fail={row.flags.hasFail}
      data-has-warn={row.flags.hasWarn}
      data-has-unchecked={row.flags.hasUnchecked}
      data-crosses-scene={row.crossesScene}
      data-media-eligible={row.mediaEligible}
      data-left-item={row.leftItemId}
      data-right-item={row.rightItemId}
      data-has-intent={row.intent !== null}
      aria-label={`Cut ${row.index + 1}: ${row.title}, ${row.stateLabel}${issues ? `, ${issues} deterministic issue${issues === 1 ? "" : "s"}` : ""}`}
      className="scroll-mt-4 border border-line bg-panel p-3 target:border-accent target:bg-accent/5"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <label className="flex items-center gap-1 text-[11px] text-faint">
          <input
            type="checkbox"
            form={REVIEW_FORM}
            name="review"
            value={row.transitionKey}
            disabled={!row.mediaEligible}
            data-testid="cut-review-select"
            aria-label={`Select cut ${row.index + 1} for Sequence Continuity review`}
          />
        </label>
        <span className="font-mono text-[11px] text-muted">Cut {row.index + 1}</span>
        <h2 className="font-mono text-[13px] font-semibold" data-testid="cut-title">
          {row.title}
        </h2>
        <span className="text-[11px] text-faint">{row.context}</span>
        {row.crossesScene ? (
          <Badge tone="info">
            <span data-testid="cut-new-scene">New scene</span>
          </Badge>
        ) : null}
        <Badge tone={row.stateTone}>
          <span data-testid="cut-state">{row.stateLabel}</span>
        </Badge>
        {issues ? (
          <Badge tone={row.flags.hasFail ? "fail" : "warn"}>
            <span data-testid="cut-issue-count">
              {issues} deterministic issue{issues === 1 ? "" : "s"}
            </span>
          </Badge>
        ) : null}
        {row.semanticUnchecked ? (
          <Badge>
            <span data-testid="cut-semantic-count">{row.semanticUnchecked} semantic unchecked</span>
          </Badge>
        ) : null}
      </div>
      {row.topIssue ? (
        <p
          data-testid="cut-top-issue"
          className={`mt-1 text-[11.5px] ${row.topIssue.tone === "fail" ? "text-fail" : row.topIssue.tone === "warn" ? "text-warn" : "text-muted"}`}
        >
          {row.topIssue.tone === "fail" ? "✕ " : row.topIssue.tone === "warn" ? "⚠ " : "○ "}
          {row.topIssue.text}
        </p>
      ) : null}

      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <SidePane side={row.left} />
        <SidePane side={row.right} />
      </div>
      {row.hasClipEdge ? (
        <p className="mt-1 text-[11px] text-faint" data-testid="cut-edge-media-note">
          {EDGE_MEDIA_NOTE}
        </p>
      ) : null}

      {row.attention.length ? (
        <section className="mt-2" data-testid="cut-attention">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">Needs attention</h3>
          <Findings findings={row.attention} />
        </section>
      ) : null}
      {row.info.length ? (
        <section className="mt-2" data-testid="cut-context">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-faint">Context</h3>
          <ul className="text-[11.5px] text-muted">
            {row.info.map((i) => (
              <li key={i}>ⓘ {i}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <CutIntentPanel row={row} target={target} />
      <details className="mt-2 text-[11.5px]" data-testid="cut-checks">
        <summary className="cursor-pointer text-muted">
          Current deterministic checks ({row.checks.length})
        </summary>
        <Findings findings={row.checks} />
      </details>
      <details className="mt-1 text-[11.5px]" data-testid="cut-semantic">
        <summary className="cursor-pointer text-muted">
          Sequence Continuity ({row.semantic.length} criteria)
        </summary>
        <p className="mt-1 text-faint">{SEMANTIC_NOTE}</p>
        {!row.mediaEligible && row.mediaReasons.length ? (
          <p className="text-faint" data-testid="cut-media-reasons">
            Media not eligible for Sequence Continuity: {row.mediaReasons.join(" ")}
          </p>
        ) : null}
        <Findings findings={row.semantic} />
      </details>
      {row.runs.length ? <RunHistory runs={row.runs} /> : null}
    </li>
  );
}

const MARK: Record<FindingVM["result"], string> = {
  fail: "✕",
  warn: "⚠",
  pass: "✓",
  n_a: "–",
  unchecked: "○",
};

function Findings({ findings }: { findings: FindingVM[] }) {
  if (findings.length === 0) return <p className="mt-1 text-faint">None.</p>;
  return (
    <ul className="mt-1 space-y-1">
      {findings.map((f) => (
        <li
          key={f.key}
          data-testid="cut-finding"
          data-key={f.key}
          data-result={f.result}
          className="flex flex-wrap gap-x-2"
        >
          <Badge tone={f.tone}>
            <span data-testid="cut-finding-result">
              {MARK[f.result]} {f.resultLabel}
            </span>
          </Badge>
          <span className="font-medium">{f.title}</span>
          <span className="text-faint">{f.severity}</span>
          {f.analyzed ? (
            <Badge tone="info">
              <span data-testid="cut-finding-analyzed">
                {f.analyzed.mock ? "MOCK ANALYSIS" : f.analyzed.analyzer}
              </span>
            </Badge>
          ) : null}
          {f.intentional ? (
            <Badge tone="accent">
              <span data-testid="cut-finding-intentional">Covered by declared intent</span>
            </Badge>
          ) : null}
          <span className="w-full pl-1 text-muted" data-testid="cut-finding-reason">
            {f.reason}
          </span>
          {f.evidence?.length ? (
            <ul className="w-full pl-3 text-faint" data-testid="cut-finding-evidence">
              {f.evidence.map((e, i) => (
                <li key={i} data-side={e.side ?? ""} data-input={e.input}>
                  {e.where}: {e.observation}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** 3A.4D: this cut's Sequence Continuity runs, newest first, with the exact derived edge media each one used. */
function RunHistory({ runs }: { runs: RunHistoryVM[] }) {
  return (
    <details className="mt-1 text-[11.5px]" data-testid="cut-runs" open>
      <summary className="cursor-pointer text-muted">Sequence Continuity runs ({runs.length})</summary>
      <ol className="mt-1 space-y-2">
        {runs.map((r) => (
          <li
            key={r.runNumber}
            data-testid="cut-run"
            data-status={r.status}
            data-freshness={r.freshness}
            className="border border-line2 p-2"
          >
            <div className="flex flex-wrap gap-2">
              <span className="font-mono">Run {r.runNumber}</span>
              <Badge>{r.status}</Badge>
              <Badge tone={r.freshness === "current" ? "neutral" : "warn"}>
                {r.freshness === "current" ? "Current" : "Stale"}
              </Badge>
              <span className="text-faint">
                {r.mock ? "MOCK ANALYSIS" : r.analyzer} · {r.model}
              </span>
            </div>
            {r.staleReasons.length ? <p className="text-warn">{r.staleReasons.join(" ")}</p> : null}
            {r.error ? <p className="text-fail">{r.error}</p> : null}
            {r.edgeMedia.length ? (
              <div className="mt-1 flex flex-wrap gap-2" data-testid="cut-run-edge-media">
                {r.edgeMedia.map((m) =>
                  m.url ? (
                    <figure key={m.inputId} className="w-[160px]">
                      {m.mediaType === "video" ? (
                        <video src={m.url} muted controls preload="metadata" className="w-full" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- private asset route
                        <img src={m.url} alt={`Exact edge frame ${m.inputId}`} className="w-full" />
                      )}
                      <figcaption className="font-mono text-[10.5px] text-faint">{m.inputId}</figcaption>
                    </figure>
                  ) : null,
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

const secs = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

/**
 * 3A.4D: the EXACT disclosure of a manual Sequence Continuity review of the selected cuts, and its confirmation. The
 * confirmation re-reads everything on the server; nothing on this page derives media or queues work.
 */
function ReviewPanel({
  page,
  episode,
}: {
  page: Extract<ContinuityPageVM, { state: "edit" }>;
  episode: Episode;
}) {
  const r = page.review!;
  const d = r.disclosure;
  const blocked = d.blockers.length > 0;
  return (
    <section
      className="space-y-2 border border-accent/60 bg-panel p-3 text-[11.5px]"
      data-testid="sequence-review"
    >
      <h2 className="font-semibold">Sequence Continuity review: what would be sent</h2>
      <ul className="text-muted">
        <li>
          Analyzer: <span data-testid="review-analyzer">{d.analyzer.label}</span> ({d.analyzer.model})
          {d.analyzer.kind === "mock" ? " — MOCK: nothing leaves Prism, no cost" : ""}
        </li>
        <li>
          Cuts: <span data-testid="review-cut-count">{d.cuts.length}</span> · Audio:{" "}
          <span data-testid="review-audio">{d.audio}</span> · Worst-case cost:{" "}
          <span data-testid="review-cost">
            {d.totalMaxUsd == null ? "unknown" : `$${d.totalMaxUsd.toFixed(4)}`}
          </span>
        </li>
      </ul>
      <ol className="space-y-2">
        {d.cuts.map((c) => (
          <li key={c.transitionKey} className="border border-line2 p-2" data-testid="review-cut">
            <div className="font-mono font-medium">{c.title}</div>
            {[c.left, c.right].map((s, i) => (
              <div key={i} data-testid={i === 0 ? "review-left" : "review-right"}>
                <span className="text-faint">{i === 0 ? "Left (outgoing)" : "Right (incoming)"}:</span>{" "}
                {s.shotCode} · item {s.itemId.slice(0, 8)} · source{" "}
                {s.sourceAssetName ?? s.sourceAssetId ?? "none"}
                {s.differsFromCurrentDelivery ? " (not the currently selected delivery master)" : ""}
                {s.window
                  ? ` · edge window ${secs(s.window.startMs)}–${secs(s.window.endMs)} (${secs(s.window.durationMs)})`
                  : ""}
                {s.still
                  ? ` · ${s.still.frame === "last_displayed" ? "last" : "first"} displayed frame at ${secs(s.still.atMs)}`
                  : ""}
                {` · references: ${s.references.length ? s.references.map((x) => `${x.count} ${x.role.replace(/_/g, " ")}`).join(", ") : "none"}`}
                <span data-testid="review-transfer" data-transfer={s.transfer} data-basis={s.transferBasis}>
                  {` · transfer: ${s.transfer === "not_sent" ? "not sent" : s.transfer === "provider_file" ? "temporary provider file" : "inline"}`}
                  {s.transfer !== "not_sent"
                    ? s.transferBasis === "exact"
                      ? ` (exact: ${s.clipBytes} bytes)`
                      : " (estimated; verified against the exact clip before anything is sent)"
                    : ""}
                </span>
              </div>
            ))}
            <div className="text-muted">
              Criteria analysed: {c.planned.length}
              {c.unavailable.length
                ? ` · unavailable: ${c.unavailable.length} (${c.unavailable[0]!.reason})`
                : ""}
            </div>
          </li>
        ))}
      </ol>
      {blocked ? (
        <ul className="text-fail" data-testid="review-blockers">
          {d.blockers.map((b) => (
            <li key={b}>✕ {b}</li>
          ))}
        </ul>
      ) : (
        <ActionForm
          action={startSequenceReview}
          successMessage="Sequence Continuity review queued"
          className="space-y-1"
        >
          <input type="hidden" name="projectSlug" value={page.projectSlug} />
          <input type="hidden" name="episodeId" value={episode.id} />
          <input type="hidden" name="analyzer" value={d.analyzer.id} />
          <input type="hidden" name="nonce" value={r.nonce} />
          {d.cuts.map((c) => (
            <input
              key={c.transitionKey}
              type="hidden"
              name="cut"
              value={[
                c.transitionKey,
                c.truth.subjectFingerprint,
                c.truth.criteriaFingerprint,
                c.truth.referenceFingerprint,
                c.left.transfer,
                c.right.transfer,
              ].join("|")}
            />
          ))}
          {d.totalMaxUsd != null ? (
            <input type="hidden" name="confirmedMaxUsd" value={String(d.totalMaxUsd)} />
          ) : null}
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" value="1" required data-testid="review-confirm" />I confirm
            sending exactly this edge media (no audio) for these cuts, at this worst-case cost.
          </label>
          <Button type="submit" data-testid="review-submit">
            Start Sequence Continuity review
          </Button>
        </ActionForm>
      )}
    </section>
  );
}

function SidePane({ side }: { side: SideVM }) {
  const p = side.picture;
  return (
    <div className="min-w-0 border border-line2 p-2" data-testid="cut-side" data-item-id={side.itemId}>
      <div className="flex flex-wrap items-baseline gap-2 text-[11.5px]">
        <span className="text-faint">{side.label}</span>
        <span className="font-mono font-medium">{side.shotCode}</span>
        <span className="truncate text-muted">{side.shotTitle}</span>
        <span className="text-faint">{side.run || side.scene}</span>
      </div>
      <div className="mt-1 aspect-video max-w-[320px] overflow-hidden border border-line2 bg-black/40">
        {p.mediaType === "video" && p.mediaUrl ? (
          <video
            src={p.mediaUrl}
            preload="metadata"
            muted
            controls
            aria-label={`${side.shotCode}: pinned source clip (not an extracted edge frame)`}
            className="h-full w-full object-contain"
          />
        ) : p.mediaType === "image" && p.mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- private asset route, not a static image
          <img
            src={p.mediaUrl}
            alt={`${side.shotCode}: ${p.kindLabel}`}
            className="h-full w-full object-contain"
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-[11px] text-faint"
            data-testid="cut-no-picture"
          >
            No picture
          </div>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-[11px] text-muted" data-testid="cut-side-facts">
        <li>
          <span className={p.placeholder ? "text-warn" : "text-fg"}>{p.kindLabel}</span> · {p.source}
        </li>
        {side.trim ? <li>{side.trim}</li> : null}
        {side.window ? <li data-testid="cut-window">{side.window}</li> : null}
        {side.edgeFrame ? <li data-testid="cut-edge-frame">{side.edgeFrame}</li> : null}
        {!side.usable ? (
          <li className="text-fail">✕ Source not usable: {side.violations.join(", ") || "unresolved"}</li>
        ) : side.current ? (
          <li>Source current</li>
        ) : (
          <li className="text-warn">⚠ Source not current: {side.currentness.join(" ")}</li>
        )}
        <li>Location: {side.location}</li>
        {side.characters.length ? <li>Characters: {side.characters.join(", ")}</li> : null}
        {side.direction ? <li>Direction: {side.direction}</li> : null}
        {side.time ? <li>Time / weather / lighting: {side.time}</li> : null}
      </ul>
      <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
        {side.shotPrepUrl ? (
          <Link href={side.shotPrepUrl} className="text-accent hover:underline" data-testid="cut-shot-prep">
            Shot Prep {side.shotCode}
          </Link>
        ) : null}
        {side.shotQaUrl ? (
          <Link href={side.shotQaUrl} className="text-accent hover:underline" data-testid="cut-shot-qa">
            Shot QA of the pinned clip
          </Link>
        ) : null}
      </div>
    </div>
  );
}
