import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ContinuityFilters } from "@/components/sequence/continuity-filters";
import { Badge, Button, Empty, PageHeader } from "@/components/ui";
import {
  CUT_INTENT_KIND_LABELS,
  CUT_INTENT_KINDS,
  CUT_INTENT_NOTE_MAX,
} from "@/domain/continuity/cut-intent";
import { CATEGORY_LABELS, CONTINUITY_CATEGORIES } from "@/domain/continuity/model";
import type { Episode } from "@/domain/schemas";
import { clearCutIntent, setCutIntent } from "@/server/episode-edit-actions";
import {
  EDGE_MEDIA_NOTE,
  NO_CUTS_MESSAGE,
  NO_EDIT_MESSAGE,
  RUNS_UNAVAILABLE,
  SEMANTIC_NOTE,
  type ContinuityPageVM,
  type CutRowVM,
  type FindingVM,
  type SideVM,
  type SupervisorLinks,
} from "./sequence-continuity-model";

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
        <p className="text-[11px] text-faint" data-testid="continuity-runs-unavailable">
          {RUNS_UNAVAILABLE}
        </p>
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
      is the planned Shot order. Deterministic cut review only: semantic cross-cut analysis is not enabled
      yet. Advisory only.
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
          Semantic cut analysis — not available yet ({row.semantic.length} criteria)
        </summary>
        <p className="mt-1 text-faint">{SEMANTIC_NOTE}</p>
        {!row.mediaEligible && row.mediaReasons.length ? (
          <p className="text-faint" data-testid="cut-media-reasons">
            Media not eligible for a future analysis: {row.mediaReasons.join(" ")}
          </p>
        ) : null}
        <Findings findings={row.semantic} />
      </details>
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
          <span className="w-full pl-1 text-muted" data-testid="cut-finding-reason">
            {f.reason}
          </span>
        </li>
      ))}
    </ul>
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
