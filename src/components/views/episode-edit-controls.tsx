import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import {
  addShotToEdit,
  moveEditItem,
  pinEditItemTake,
  removeEditItem,
  repinSelectedTakes,
  setEditItemClipAudio,
  setEditItemHold,
  setEditItemSource,
  silenceEditItem,
  trimEditItem,
  useEditItemReplacement,
} from "@/server/episode-edit-actions";
import type { AddableShotVM, ItemEditorVM } from "./episode-edit-editor-model";

/**
 * Phase 2I.1D editing controls of the Episode Edit page. Every control is a plain server-action form carrying the edit
 * id, the item id and the revision the page showed; the server re-validates and the page re-renders from the saved
 * edit (no optimistic state). A stale revision comes back as "This edit changed before your update was saved…" next to
 * the control (the form is not remounted, so the message stays) while the page shows the latest edit. After a success
 * the form resets to the re-rendered values (`resetOnSuccess`). No playback, no drag editing (2I.1E and later).
 */

export interface EditTarget {
  projectSlug: string;
  editId: string;
  revision: number;
}

function Hidden({ target, itemId }: { target: EditTarget; itemId?: string }) {
  return (
    <>
      <input type="hidden" name="projectSlug" value={target.projectSlug} />
      <input type="hidden" name="editId" value={target.editId} />
      <input type="hidden" name="expectedRevision" value={target.revision} />
      {itemId ? <input type="hidden" name="itemId" value={itemId} /> : null}
    </>
  );
}

const sectionTitle = "mb-1 text-[10.5px] uppercase tracking-wide text-faint";

export function ItemOrderControls({
  target,
  editor,
  shotCode,
}: {
  target: EditTarget;
  editor: ItemEditorVM;
  shotCode: string;
}) {
  return (
    <div className="flex items-start gap-1">
      {(["up", "down"] as const).map((direction) => (
        <ActionForm key={direction} action={moveEditItem} quiet>
          <Hidden target={target} itemId={editor.itemId} />
          <input type="hidden" name="direction" value={direction} />
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={direction === "up" ? !editor.canMoveUp : !editor.canMoveDown}
            aria-label={`Move ${shotCode} ${direction}`}
            data-testid={`move-${direction}`}
          >
            {direction === "up" ? "↑" : "↓"}
          </Button>
        </ActionForm>
      ))}
      <ActionForm
        action={removeEditItem}
        quiet
        confirmMessage={`Remove ${shotCode} from the edit? The Shot, its clips, frames and takes are not deleted.`}
      >
        <Hidden target={target} itemId={editor.itemId} />
        <Button type="submit" size="sm" variant="danger" data-testid="remove-item">
          Remove
        </Button>
      </ActionForm>
    </div>
  );
}

export function ItemEditor({ target, editor }: { target: EditTarget; editor: ItemEditorVM }) {
  return (
    <details className="text-[11.5px]" data-testid="item-editor">
      <summary className="cursor-pointer text-accent">Edit item</summary>
      <div className="mt-2 space-y-3 border-l border-line2 pl-3">
        {editor.replacement ? (
          <ActionForm action={useEditItemReplacement} successMessage="" data-testid="use-replacement-form">
            <Hidden target={target} itemId={editor.itemId} />
            <input type="hidden" name="attemptId" value={editor.replacement.attemptId} />
            <input type="hidden" name="assetId" value={editor.replacement.assetId} />
            <div className={sectionTitle}>Replacement</div>
            <Button type="submit" size="sm" variant="primary" data-testid="use-replacement">
              Use replacement: {editor.replacement.label}
            </Button>
          </ActionForm>
        ) : null}

        <ActionForm action={setEditItemSource} successMessage="" resetOnSuccess data-testid="source-form">
          <Hidden target={target} itemId={editor.itemId} />
          <div className={sectionTitle}>Picture source</div>
          <ul className="space-y-1">
            {editor.sources.map((o) => (
              <li key={o.value}>
                <label
                  className="flex cursor-pointer items-center gap-2"
                  data-testid="source-option"
                  data-kind={o.kind}
                >
                  <input type="radio" name="source" value={o.value} defaultChecked={o.pinned} />
                  {o.previewType === "video" && o.previewUrl ? (
                    <video
                      src={o.previewUrl}
                      preload="metadata"
                      muted
                      className="h-9 w-16 border border-line2 bg-black/40"
                    />
                  ) : o.previewType === "image" && o.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- private asset route, not a static image
                    <img src={o.previewUrl} alt="" className="h-9 w-16 border border-line2 object-contain" />
                  ) : null}
                  <span className={o.kind === "video" ? "text-pass" : "text-warn"}>{o.kindLabel}</span>
                  <span>{o.label}</span>
                  {o.facts.length ? <span className="text-muted">· {o.facts.join(" · ")}</span> : null}
                  {o.badges.map((b) => (
                    <Badge key={b.label} tone={b.tone}>
                      {b.label}
                    </Badge>
                  ))}
                </label>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-faint">
            Any completed Shot clip can be pinned; Best and approval are facts, not requirements. A clip is
            pinned at its full length; trim it afterwards. A still keeps the item&apos;s current duration.
          </p>
          <Button type="submit" size="sm" className="mt-1" data-testid="pin-source">
            Pin source
          </Button>
        </ActionForm>

        {editor.trim ? (
          <ActionForm action={trimEditItem} successMessage="" resetOnSuccess data-testid="trim-form">
            <Hidden target={target} itemId={editor.itemId} />
            <div className={sectionTitle}>Trim (seconds of the pinned clip)</div>
            <div className="flex flex-wrap items-center gap-2">
              <label>
                In{" "}
                <input
                  name="sourceIn"
                  defaultValue={editor.trim.inS}
                  inputMode="decimal"
                  className="!w-20"
                  data-testid="trim-in"
                />
              </label>
              <label>
                Out{" "}
                <input
                  name="sourceOut"
                  defaultValue={editor.trim.outS}
                  inputMode="decimal"
                  className="!w-20"
                  data-testid="trim-out"
                />
              </label>
              <span className="text-faint">of {editor.trim.assetS ?? "?"} s</span>
              <Button type="submit" size="sm" data-testid="apply-trim">
                Apply trim
              </Button>
            </div>
          </ActionForm>
        ) : null}

        {editor.hold ? (
          <ActionForm action={setEditItemHold} successMessage="" resetOnSuccess data-testid="hold-form">
            <Hidden target={target} itemId={editor.itemId} />
            <div className={sectionTitle}>Hold (seconds)</div>
            <input
              name="duration"
              defaultValue={editor.hold.durationS}
              inputMode="decimal"
              className="!w-20"
              data-testid="hold-duration"
            />{" "}
            <Button type="submit" size="sm" data-testid="apply-hold">
              Apply
            </Button>
          </ActionForm>
        ) : null}

        <div data-testid="performance-editor">
          <div className={sectionTitle}>Performance</div>
          {editor.lines.length === 0 ? <p className="text-muted">This Shot has no dialogue lines.</p> : null}
          {editor.lines.map((line) => (
            <div key={line.dialogueLineId} className="mb-2" data-testid="line-editor">
              <div>{line.label}</div>
              <ActionForm action={pinEditItemTake} successMessage="" resetOnSuccess className="mt-0.5">
                <Hidden target={target} itemId={editor.itemId} />
                <input type="hidden" name="dialogueLineId" value={line.dialogueLineId} />
                <ul className="space-y-0.5">
                  {line.takes.map((t) => (
                    <li key={t.takeId}>
                      <label className="flex cursor-pointer items-center gap-2" data-testid="take-option">
                        <input type="radio" name="takeId" value={t.takeId} defaultChecked={t.pinned} />
                        <span>{t.label}</span>
                        <span className="text-muted">· {t.facts.join(" · ")}</span>
                        {t.pinned ? <Badge>Pinned</Badge> : null}
                      </label>
                    </li>
                  ))}
                </ul>
                <Button type="submit" size="sm" className="mt-0.5" data-testid="pin-take">
                  Pin take
                </Button>
              </ActionForm>
              {line.placed ? (
                <ActionForm action={silenceEditItem} successMessage="" className="mt-0.5">
                  <Hidden target={target} itemId={editor.itemId} />
                  <input type="hidden" name="dialogueLineId" value={line.dialogueLineId} />
                  <Button type="submit" size="sm" variant="ghost">
                    Silence this line
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <ActionForm action={repinSelectedTakes} successMessage="">
              <Hidden target={target} itemId={editor.itemId} />
              <Button type="submit" size="sm" variant="ghost" data-testid="repin-selected">
                Pin the selected takes
              </Button>
            </ActionForm>
            <ActionForm action={silenceEditItem} successMessage="">
              <Hidden target={target} itemId={editor.itemId} />
              <Button type="submit" size="sm" variant="ghost" data-testid="silence-item">
                Silence
              </Button>
            </ActionForm>
          </div>
        </div>

        {editor.clipAudio ? (
          <ActionForm
            action={setEditItemClipAudio}
            successMessage=""
            resetOnSuccess
            data-testid="clip-audio-form"
          >
            <Hidden target={target} itemId={editor.itemId} />
            <div className={sectionTitle}>Clip&apos;s own audio</div>
            <label className="mr-3">
              <input
                type="radio"
                name="sourceAudio"
                value="muted"
                defaultChecked={editor.clipAudio.value === "muted"}
              />{" "}
              Muted
            </label>
            <label className={editor.clipAudio.available ? "" : "text-faint"}>
              <input
                type="radio"
                name="sourceAudio"
                value="included"
                defaultChecked={editor.clipAudio.value === "included"}
                disabled={!editor.clipAudio.available}
              />{" "}
              Use clip audio
            </label>
            {editor.clipAudio.note ? (
              <p className="text-[11px] text-faint" data-testid="clip-audio-note">
                {editor.clipAudio.note}
              </p>
            ) : null}
            <Button type="submit" size="sm" className="mt-1" disabled={!editor.clipAudio.available}>
              Apply
            </Button>
          </ActionForm>
        ) : null}
      </div>
    </details>
  );
}

export function AddShotPanel({
  target,
  addable,
  items,
}: {
  target: EditTarget;
  addable: AddableShotVM[];
  items: number;
}) {
  if (addable.length === 0) return null;
  return (
    <section className="border border-line bg-panel p-3" data-testid="add-shot-panel">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        Shots not in the edit
      </h2>
      <p className="mt-0.5 text-[11px] text-faint">
        Not added automatically. Adding one creates what Prism proposes for it (shown), at the position you
        choose.
      </p>
      <ul className="mt-2 space-y-1.5">
        {addable.map((s) => (
          <li key={s.shotId} data-testid="addable-shot" data-shot-code={s.shotCode}>
            <ActionForm
              action={addShotToEdit}
              successMessage=""
              className="flex flex-wrap items-center gap-2"
            >
              <Hidden target={target} />
              <input type="hidden" name="shotId" value={s.shotId} />
              <input type="hidden" name="itemKey" value={s.itemKey} />
              <span className="font-mono font-medium">{s.shotCode}</span>
              <span className="text-muted">{s.title}</span>
              <span>
                → {s.proposed}, {s.duration}
              </span>
              <label>
                at{" "}
                <select name="position" defaultValue="end" className="!w-auto" data-testid="add-position">
                  {Array.from({ length: items + 1 }, (_, i) => (
                    <option key={i} value={i === items ? "end" : String(i)}>
                      {i === items ? "the end" : `position ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm" data-testid="add-shot">
                Add to edit
              </Button>
            </ActionForm>
          </li>
        ))}
      </ul>
    </section>
  );
}
