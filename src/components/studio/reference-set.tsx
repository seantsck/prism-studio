"use client";

import { useState, useTransition, type DragEvent } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { REFERENCE_SET_GUIDANCE, type ReferenceSetViewId } from "@/domain/generation/reference-studio";
import { cn } from "@/lib/utils";
import type { StudioImage, StudioSetView, StudioState } from "@/server/reference-studio";
import Link from "next/link";
import { replaceLookReference } from "@/server/subject-image-actions";
import { addToReferenceSet } from "@/server/visual-bible-actions";

/** The drag payload of one of the subject's pictures (a Start-from tile or a take), dropped on a view. */
export const PICTURE_DRAG_TYPE = "application/x-prism-picture";

export function startPictureDrag(
  e: DragEvent<HTMLElement>,
  picture: { assetId: string; attemptId?: string | null },
) {
  e.dataTransfer.setData(PICTURE_DRAG_TYPE, JSON.stringify(picture));
  e.dataTransfer.effectAllowed = "copy";
}

const carriesPicture = (e: DragEvent<HTMLElement>) =>
  Array.from(e.dataTransfer.types).includes(PICTURE_DRAG_TYPE);

/**
 * A Character's reference set: the six views every Production Frame of the Character is made from, and what is in
 * each. A picture goes into a view by dragging it there (from Start from or Takes) or with Choose; an empty view can
 * also be made (which only fills in the brief: nothing is spent until Generate). Dropping or choosing onto a filled
 * view replaces its picture, which stays in the library. Beside it, in a few lines, what makes a strong set.
 */
export function ReferenceSetPanel({
  slug,
  subject,
  set,
  pictures,
  photos,
  onMake,
}: {
  slug: string;
  subject: NonNullable<StudioState["selected"]>;
  set: StudioSetView[];
  /** Every picture of the subject that can go into a view (the creator's photos and the finished takes). */
  pictures: StudioImage[];
  /** How many of the creator's own photos of the subject there are. */
  photos: number;
  /** Fills in the brief to make this view (from the selected starting images), with a Look for a wardrobe picture. */
  onMake: (intent: string, lookId?: string) => void;
}) {
  const filled = set.filter((v) => v.assetId).length;
  const [choosing, setChoosing] = useState<string | null>(null);
  const looks = subject.looks;
  const lookKey = (id: string) => `look:${id}`;
  const [over, setOver] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ view: string; text: string; ok: boolean } | null>(null);
  const [, startTransition] = useTransition();
  const target = set.find((v) => v.id === choosing) ?? null;
  const targetLook = looks.find((l) => lookKey(l.id) === choosing) ?? null;

  /** Makes a take the Look's picture (replacing the old one, which stays in the library). */
  const assignLook = (
    look: (typeof looks)[number],
    picture: { assetId: string; attemptId?: string | null },
  ) => {
    const key = lookKey(look.id);
    setChoosing(null);
    if (look.pictureAssetId === picture.assetId) return;
    if (look.locked) {
      setMessage({ view: key, text: "This Look is locked: unlock it first.", ok: false });
      return;
    }
    if (!picture.attemptId) {
      setMessage({
        view: key,
        text: "Use a picture made here: your own photo is a picture of the person, not of the Look.",
        ok: false,
      });
      return;
    }
    const form = new FormData();
    form.set("projectSlug", slug);
    form.set("lookId", look.id);
    form.set("attemptId", picture.attemptId);
    form.set("confirmReplace", "1");
    setBusy(key);
    setMessage(null);
    startTransition(async () => {
      const result = await replaceLookReference(form);
      setBusy(null);
      setMessage(
        result.ok
          ? { view: key, text: look.pictureAssetId ? "Replaced" : "Added", ok: true }
          : { view: key, text: result.error, ok: false },
      );
    });
  };

  /** Puts a picture into a view. Dropping or choosing onto a filled view is the explicit replacement. */
  const assign = (view: StudioSetView, picture: { assetId: string; attemptId?: string | null }) => {
    setChoosing(null);
    if (view.assetId === picture.assetId) return;
    if (view.assetId && view.locked) {
      setMessage({ view: view.id, text: "This view is locked on the Character page.", ok: false });
      return;
    }
    const form = new FormData();
    form.set("projectSlug", slug);
    form.set("characterId", subject.id);
    form.set("view", view.id);
    if (picture.attemptId) form.set("attemptId", picture.attemptId);
    else form.set("assetId", picture.assetId);
    if (view.assetId) form.set("confirmReplace", "1");
    setBusy(view.id);
    setMessage(null);
    startTransition(async () => {
      const result = await addToReferenceSet(form);
      setBusy(null);
      setMessage(
        result.ok
          ? { view: view.id, text: view.assetId ? "Replaced" : "Added", ok: true }
          : { view: view.id, text: result.error, ok: false },
      );
    });
  };
  const drop = (view: StudioSetView) => (e: DragEvent<HTMLElement>) => {
    if (!carriesPicture(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    try {
      assign(view, JSON.parse(e.dataTransfer.getData(PICTURE_DRAG_TYPE)));
    } catch {
      // not one of this Studio's pictures
    }
  };

  return (
    <div className="rounded-[3px] border border-line bg-panel p-3" data-testid="studio-reference-set">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-medium">
          {subject.name}&apos;s reference set{" "}
          <span className="font-normal text-muted" data-testid="studio-set-count">
            ({filled} of {set.length} views)
          </span>
        </h2>
        <p className="text-[11.5px] text-muted">
          Every Production Frame of {subject.name} is made from these, the front first.
        </p>
      </div>
      <ul className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {set.map((v) => (
          <li
            key={v.id}
            data-testid="studio-set-view"
            data-view={v.id}
            data-filled={v.assetId ? "true" : "false"}
            data-asset={v.assetId ?? ""}
            onDragOver={(e) => {
              if (!carriesPicture(e)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "copy";
              if (over !== v.id) setOver(v.id);
            }}
            onDragLeave={() => setOver((x) => (x === v.id ? null : x))}
            onDrop={drop(v)}
          >
            <div
              className={cn(
                "relative flex h-[112px] items-center justify-center overflow-hidden rounded-[3px] border bg-[#232326]",
                over === v.id
                  ? "border-accent ring-2 ring-accent"
                  : choosing === v.id
                    ? "border-accent"
                    : v.assetId
                      ? "border-line2"
                      : "border-dashed border-line2",
              )}
            >
              {v.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={v.url}
                  alt={`${subject.name}, ${v.label}`}
                  className={cn("h-full w-full object-cover", busy === v.id ? "opacity-40" : "")}
                />
              ) : (
                <span className="px-1 text-center text-[10.5px] text-faint">
                  {busy === v.id ? "Adding…" : "Drop a picture here"}
                </span>
              )}
              {over === v.id ? (
                <span className="absolute inset-x-0 bottom-0 bg-black/75 py-0.5 text-center text-[10.5px] text-fg">
                  {v.assetId ? `Replace the ${v.label.toLowerCase()}` : `Add as ${v.label.toLowerCase()}`}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-[11px] font-medium">
              {v.label}
              {v.canonical ? <span className="font-normal text-muted"> · canonical</span> : null}
            </p>
            <p className="text-[10.5px] text-muted">{v.from ?? "empty"}</p>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px]">
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => setChoosing(choosing === v.id ? null : v.id)}
                aria-expanded={choosing === v.id}
                data-testid="studio-set-choose"
              >
                {v.assetId ? "Change" : "Choose"}
              </button>
              {v.assetId ? null : (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => onMake(v.intent)}
                  data-testid="studio-set-make"
                >
                  Make it
                </button>
              )}
            </p>
            {message?.view === v.id ? (
              <p
                className={cn("text-[10.5px]", message.ok ? "text-pass" : "text-warn")}
                role="status"
                data-testid="studio-set-message"
              >
                {message.text}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {looks.length > 0 ? (
        <div className="mt-3">
          <p className="text-[11.5px] text-muted">
            Wardrobe: each Look&apos;s picture is sent with every Shot in that Look, so it must show{" "}
            {subject.name}
            &apos;s own face. Drop a Wardrobe reference made here onto it.
          </p>
          <ul className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {looks.map((l) => {
              const key = lookKey(l.id);
              return (
                <li
                  key={l.id}
                  data-testid="studio-set-look"
                  data-look={l.id}
                  data-filled={l.pictureAssetId ? "true" : "false"}
                  onDragOver={(e) => {
                    if (!carriesPicture(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "copy";
                    if (over !== key) setOver(key);
                  }}
                  onDragLeave={() => setOver((x) => (x === key ? null : x))}
                  onDrop={(e) => {
                    if (!carriesPicture(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setOver(null);
                    try {
                      assignLook(l, JSON.parse(e.dataTransfer.getData(PICTURE_DRAG_TYPE)));
                    } catch {
                      // not one of this Studio's pictures
                    }
                  }}
                >
                  <div
                    className={cn(
                      "relative flex h-[112px] items-center justify-center overflow-hidden rounded-[3px] border bg-[#232326]",
                      over === key
                        ? "border-accent ring-2 ring-accent"
                        : choosing === key
                          ? "border-accent"
                          : l.pictureUrl
                            ? "border-line2"
                            : "border-dashed border-line2",
                    )}
                  >
                    {l.pictureUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={l.pictureUrl}
                        alt={`${l.name}`}
                        className={cn("h-full w-full object-cover", busy === key ? "opacity-40" : "")}
                      />
                    ) : (
                      <span className="px-1 text-center text-[10.5px] text-faint">Drop a picture here</span>
                    )}
                    {over === key ? (
                      <span className="absolute inset-x-0 bottom-0 bg-black/75 py-0.5 text-center text-[10.5px] text-fg">
                        {l.pictureUrl ? "Replace its picture" : "Use as its picture"}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] font-medium" title={l.name}>
                    {l.name}
                  </p>
                  {l.locked ? (
                    <p className="text-[10.5px] text-warn">
                      Locked.{" "}
                      <Link href={`/projects/${slug}/characters/${subject.id}`} className="underline">
                        Unlock
                      </Link>
                    </p>
                  ) : (
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px]">
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => setChoosing(choosing === key ? null : key)}
                        data-testid="studio-look-choose"
                      >
                        {l.pictureUrl ? "Change" : "Choose"}
                      </button>
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => onMake("outfit_variant", l.id)}
                        data-testid="studio-look-make"
                      >
                        Make it
                      </button>
                    </p>
                  )}
                  {message?.view === key ? (
                    <p
                      className={cn("text-[10.5px]", message.ok ? "text-pass" : "text-warn")}
                      role="status"
                      data-testid="studio-set-message"
                    >
                      {message.text}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {targetLook ? (
        <div className="mt-2 rounded-[3px] border border-line bg-bg p-2" data-testid="studio-set-picker">
          <p className="mb-1.5 text-[11.5px]">
            The picture of <span className="font-medium">{targetLook.name}</span>: click a picture made here.{" "}
            <button type="button" className="text-muted hover:text-fg" onClick={() => setChoosing(null)}>
              Cancel
            </button>
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {pictures
              .filter((p) => p.attemptId)
              .map((p) => (
                <li key={p.assetId}>
                  <button
                    type="button"
                    onClick={() => assignLook(targetLook, p)}
                    title={p.label}
                    aria-label={p.label}
                    className="relative block h-[84px] w-[66px] overflow-hidden rounded-[3px] border border-line2 bg-[#232326] hover:border-accent"
                    data-testid="studio-set-pick"
                    data-asset={p.assetId}
                  >
                    {p.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.url} alt="" className="h-full w-full object-cover" />
                    ) : null}
                    <span className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[9px] text-fg">
                      {p.label.replace(/^Generated /, "")}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : target ? (
        <div className="mt-2 rounded-[3px] border border-line bg-bg p-2" data-testid="studio-set-picker">
          <p className="mb-1.5 text-[11.5px]">
            {target.assetId ? "Replace" : "Choose"} the{" "}
            <span className="font-medium">{target.label.toLowerCase()}</span>
            {target.canonical ? " (the canonical identity)" : ""}: click a picture.{" "}
            <button type="button" className="text-muted hover:text-fg" onClick={() => setChoosing(null)}>
              Cancel
            </button>
          </p>
          {pictures.length === 0 ? (
            <p className="text-[11.5px] text-muted">No picture yet. Add photos, or make one first.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {pictures.map((p) => (
                <li key={p.assetId}>
                  <button
                    type="button"
                    onClick={() => assign(target, p)}
                    title={`${p.label} · ${p.originLabel}`}
                    aria-label={`${p.label} (${p.originLabel})`}
                    className={cn(
                      "relative block h-[84px] w-[66px] overflow-hidden rounded-[3px] border bg-[#232326]",
                      p.assetId === target.assetId ? "border-accent" : "border-line2 hover:border-accent",
                    )}
                    data-testid="studio-set-pick"
                    data-asset={p.assetId}
                  >
                    {p.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.url} alt="" className="h-full w-full object-cover" />
                    ) : null}
                    <span className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[9px] text-fg">
                      {p.origin === "uploaded" ? "your photo" : p.label.replace(/^Generated /, "")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-faint">
          Drag a picture from Start from or Takes onto a view, or use Choose.
        </p>
      )}
      <details className="mt-2 text-[11.5px]" data-testid="studio-set-guidance">
        <summary className="text-muted hover:text-fg">
          What makes the best set{" "}
          <span className={photos >= 4 ? "text-pass" : "text-warn"}>
            (you have {photos} photo{photos === 1 ? "" : "s"}; 4 to 8 is best)
          </span>
        </summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
          {REFERENCE_SET_GUIDANCE.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * Puts one picture (a take, or one of the creator's photos) into a view of the reference set: one choice, one button.
 * The button says what will happen: add, or replace the picture the view holds now (the old one stays in the library).
 */
export function AddToSet({
  slug,
  characterId,
  set,
  attemptId,
  assetId,
  suggested,
  compact = false,
}: {
  slug: string;
  characterId: string;
  set: StudioSetView[];
  /** A finished take … */
  attemptId?: string;
  /** … or one of the creator's photos of this Character. */
  assetId: string;
  /** The view the picture naturally belongs in (from what it was made as). */
  suggested: ReferenceSetViewId | null;
  compact?: boolean;
}) {
  const firstEmpty = set.find((v) => !v.assetId)?.id;
  const [choice, setChoice] = useState<ReferenceSetViewId | null>(null);
  const viewId = choice ?? suggested ?? firstEmpty ?? set[0]?.id ?? "front";
  const view = set.find((v) => v.id === viewId);
  const here = set.filter((v) => v.assetId === assetId).map((v) => v.label.toLowerCase());
  if (!view) return null;
  const same = view.assetId === assetId;
  const replacing = !!view.assetId && !same;
  const blocked = replacing && view.locked;
  return (
    <ActionForm
      action={addToReferenceSet}
      successMessage="Added to the reference set"
      className={cn("flex flex-wrap items-center gap-1.5", compact ? "mt-1" : "")}
      data-testid="studio-add-to-set"
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      {attemptId ? (
        <input type="hidden" name="attemptId" value={attemptId} />
      ) : (
        <input type="hidden" name="assetId" value={assetId} />
      )}
      {replacing ? <input type="hidden" name="confirmReplace" value="1" /> : null}
      <select
        name="view"
        value={viewId}
        onChange={(e) => setChoice(e.target.value as ReferenceSetViewId)}
        className={compact ? "h-7 text-[11.5px]" : undefined}
        style={{ width: "auto", maxWidth: "16rem" }}
        aria-label="View in the reference set"
        data-testid="studio-set-choice"
      >
        {set.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
            {v.canonical ? " (canonical)" : ""}
            {v.assetId ? (v.assetId === assetId ? " ✓" : " · filled") : " · empty"}
          </option>
        ))}
      </select>
      <Button
        type="submit"
        variant={compact ? undefined : "primary"}
        size={compact ? "sm" : undefined}
        disabled={same || blocked}
        data-testid="studio-add-to-set-submit"
      >
        {same
          ? `In the set as ${view.label.toLowerCase()}`
          : replacing
            ? `Replace the ${view.label.toLowerCase()}`
            : `Add to the set as ${view.label.toLowerCase()}`}
      </Button>
      {blocked ? (
        <span className="text-[11px] text-warn">That view is locked on the Character page.</span>
      ) : here.length > 0 && !same ? (
        <span className="text-[11px] text-muted">Already the {here.join(" and ")}.</span>
      ) : null}
    </ActionForm>
  );
}
