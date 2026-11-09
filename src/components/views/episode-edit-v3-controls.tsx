import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import {
  removeEditTitle,
  restoreEditRevision,
  saveEditRevision,
  setEditItemTransition,
  setEditTitle,
} from "@/server/episode-edit-actions";
import type { EditTarget } from "./episode-edit-controls";
import type { ManifestVM, SavedRevisionVM, TitleSlotVM, TransitionVM } from "./episode-edit-model";

/**
 * Phase 5B-V3 controls of the Episode Edit: transitions, title cards, saved revisions and the render manifest. Same
 * pattern as 2I.1D: plain server-action forms carrying the edit id and the revision the page showed; the repository
 * re-validates everything (a dissolve against both neighbours, a title's text and length, a revision against the
 * current state) and the page re-renders from the saved edit. Nothing here renders, uploads or calls a provider.
 */

function Hidden({ target }: { target: EditTarget }) {
  return (
    <>
      <input type="hidden" name="projectSlug" value={target.projectSlug} />
      <input type="hidden" name="editId" value={target.editId} />
      <input type="hidden" name="expectedRevision" value={target.revision} />
    </>
  );
}

const sectionTitle = "text-[11px] font-semibold uppercase tracking-[0.08em] text-muted";

/** The transition INTO an item: Cut or Cross dissolve, with the longest dissolve its neighbours allow. */
export function TransitionControl({
  target,
  itemId,
  shotCode,
  transition,
}: {
  target: EditTarget;
  itemId: string;
  shotCode: string;
  transition: TransitionVM;
}) {
  return (
    <ActionForm
      action={setEditItemTransition}
      successMessage=""
      resetOnSuccess
      className="flex flex-wrap items-center gap-2 text-[11.5px]"
      data-testid="transition-form"
    >
      <Hidden target={target} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="predecessorId" value={transition.predecessorId} />
      <span className="text-faint">
        {transition.predecessorCode} → {shotCode}
      </span>
      <select
        name="transition"
        defaultValue={transition.kind}
        aria-label={`Transition into ${shotCode}`}
        className="!w-auto"
        data-testid="transition-kind"
      >
        <option value="cut">Cut</option>
        <option value="dissolve" disabled={!transition.dissolveFits}>
          Cross dissolve
        </option>
      </select>
      <label>
        <input
          name="duration"
          defaultValue={transition.durationS}
          inputMode="decimal"
          className="!w-16"
          aria-label={`Dissolve seconds into ${shotCode}`}
          data-testid="transition-duration"
        />{" "}
        s <span className="text-faint">(max {transition.maxS} s)</span>
      </label>
      <Button type="submit" size="sm" data-testid="apply-transition">
        Apply
      </Button>
      <span data-testid="transition-label" data-kind={transition.kind} className="text-muted">
        {transition.label}
      </span>
    </ActionForm>
  );
}

const PLACEMENT_LABEL = { opening: "Opening title", closing: "Closing title" } as const;

/** The opening / closing title cards: text, duration, style. Not Shots and not media. */
export function TitlePanel({ target, titles }: { target: EditTarget; titles: TitleSlotVM[] }) {
  return (
    <section className="space-y-3 border border-line bg-panel p-3" data-testid="title-panel">
      <h2 className={sectionTitle}>Titles</h2>
      {titles.map((t) => (
        <div key={t.placement} data-testid="title-slot" data-placement={t.placement} data-exists={t.exists}>
          <ActionForm
            action={setEditTitle}
            successMessage=""
            resetOnSuccess
            className="grid grid-cols-[1fr_1fr_auto_auto_auto] items-end gap-2 text-[11.5px]"
          >
            <Hidden target={target} />
            <input type="hidden" name="placement" value={t.placement} />
            <label className="flex flex-col gap-0.5">
              <span className="text-faint">
                {PLACEMENT_LABEL[t.placement]}
                {t.exists ? ` · from ${t.start}` : ""}
              </span>
              <input name="title" defaultValue={t.title} placeholder="Title" data-testid="title-text" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-faint">Second line</span>
              <input
                name="subtitle"
                defaultValue={t.subtitle}
                placeholder="e.g. Episode 1 — …"
                data-testid="title-subtitle"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-faint">Seconds</span>
              <input
                name="duration"
                defaultValue={t.durationS}
                inputMode="decimal"
                className="!w-16"
                data-testid="title-duration"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-faint">Style</span>
              <select name="style" defaultValue={t.style} className="!w-auto" data-testid="title-style">
                <option value="film">Film</option>
                <option value="plain">Plain</option>
              </select>
            </label>
            <Button type="submit" size="sm" data-testid="save-title">
              {t.exists ? "Update" : "Add"}
            </Button>
          </ActionForm>
          {t.exists ? (
            <ActionForm action={removeEditTitle} successMessage="" className="mt-1">
              <Hidden target={target} />
              <input type="hidden" name="placement" value={t.placement} />
              <Button type="submit" size="sm" variant="ghost" data-testid="remove-title">
                Remove {PLACEMENT_LABEL[t.placement].toLowerCase()}
              </Button>
            </ActionForm>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/**
 * Saved revisions: "Save revision" freezes the current state as the next number; Restore makes a saved state current
 * as a NEW revision (the saved one never changes).
 */
export function RevisionPanel({
  target,
  revisions,
  savedAs,
}: {
  target: EditTarget;
  revisions: SavedRevisionVM[];
  savedAs: number | null;
}) {
  return (
    <section className="space-y-2 border border-line bg-panel p-3" data-testid="revision-panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={sectionTitle}>Revisions</h2>
        <span data-testid="edit-saved-state" data-saved-as={savedAs ?? ""}>
          {savedAs != null ? (
            <Badge tone="pass">Saved as revision {savedAs}</Badge>
          ) : (
            <Badge tone="warn">{revisions.length ? "Unsaved changes" : "Not saved yet"}</Badge>
          )}
        </span>
      </div>
      <ActionForm
        action={saveEditRevision}
        successMessage=""
        resetOnSuccess
        className="flex flex-wrap items-center gap-2 text-[11.5px]"
      >
        <Hidden target={target} />
        <input
          name="label"
          placeholder="Label (optional), e.g. Tighter opening"
          className="!w-64"
          data-testid="revision-label"
        />
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={savedAs != null}
          data-testid="save-revision"
        >
          Save revision
        </Button>
      </ActionForm>
      {revisions.length ? (
        <ol className="space-y-1 text-[11.5px]" data-testid="revision-list">
          {revisions.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-2"
              data-testid="saved-revision"
              data-number={r.number}
              data-current={r.current}
            >
              <span className="font-mono font-medium">#{r.number}</span>
              <span>{r.label || "—"}</span>
              <span className="text-faint">{r.savedAt}</span>
              <span className="font-mono text-faint">{r.fingerprint}</span>
              {r.restoredFrom != null ? <Badge>restored from #{r.restoredFrom}</Badge> : null}
              {r.current ? (
                <Badge tone="pass">Current</Badge>
              ) : (
                <ActionForm action={restoreEditRevision} successMessage="" quiet>
                  <Hidden target={target} />
                  <input type="hidden" name="revisionId" value={r.id} />
                  <Button type="submit" size="sm" variant="ghost" data-testid="restore-revision">
                    Restore
                  </Button>
                </ActionForm>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

/** The deterministic render manifest of exactly this edit state: what V4 will render (V3 renders nothing). */
export function ManifestPanel({ manifest }: { manifest: ManifestVM }) {
  return (
    <details
      className="border border-line bg-panel p-3 text-[11.5px]"
      data-testid="render-manifest"
      data-fingerprint={manifest.fingerprint}
      data-state-fingerprint={manifest.stateFingerprint}
      data-total-ms={manifest.totalMs}
    >
      <summary className="cursor-pointer">
        <span className={sectionTitle}>Render manifest</span>{" "}
        <span className="text-muted">
          {manifest.segments.length} segments · {manifest.total} · dissolves overlap {manifest.overlap} s ·{" "}
          <span className="font-mono">{manifest.fingerprint.slice(0, 12)}</span>
        </span>
      </summary>
      <p className="mt-1 text-faint">
        {manifest.version}: the exact input for the segmented final render (V4). Nothing is rendered here.
      </p>
      <ol className="mt-2 space-y-0.5" data-testid="manifest-segments">
        {manifest.segments.map((s) => (
          <li
            key={s.order}
            data-testid="manifest-segment"
            data-kind={s.kind}
            className="flex flex-wrap gap-2"
          >
            <span className="font-mono text-faint">{s.order + 1}.</span>
            <span>{s.label}</span>
            <span className="text-muted">
              at {s.start} · {s.duration} · then {s.next}
            </span>
          </li>
        ))}
      </ol>
      <pre
        className="mt-2 max-h-72 overflow-auto bg-black/30 p-2 font-mono text-[10.5px]"
        data-testid="manifest-json"
      >
        {manifest.json}
      </pre>
    </details>
  );
}
