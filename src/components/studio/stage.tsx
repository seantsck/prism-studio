"use client";

import { priceText, showsOwnerCost } from "@/domain/pricing/user-price";

import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import { referencePreset, referenceSetViewOf, usd } from "@/domain/generation/reference-studio";
import { cn } from "@/lib/utils";
import { setCanonicalLocation } from "@/server/location-visual-bible-actions";
import type {
  StudioImage,
  StudioSetView,
  StudioShot,
  StudioState,
  StudioTake,
} from "@/server/reference-studio";
import { reviewReferenceImage } from "@/server/reference-studio-actions";
import {
  removeBackground,
  saveAsCharacterReference,
  saveAsLocationReference,
  saveAsLocationView,
  replaceLookReference,
  saveAsLookReference,
} from "@/server/subject-image-actions";
import type { HostedMattingOffer } from "@/server/subject-images";
import { setCanonicalIdentity, setCharacterCutout } from "@/server/visual-bible-actions";
import { ArchiveButton, DeleteButton } from "./archive";
import { AddToSet, ReferenceSetPanel, startPictureDrag } from "./reference-set";

const SLOTS: Array<[string, string]> = [
  ["front", "Front"],
  ["three_quarter", "3/4"],
  ["profile", "Profile"],
  ["full_body", "Full body"],
  ["additional", "Extra reference"],
];

const REJECTIONS: Array<[string, string]> = [
  ["identity_drift", "Not the same person or place"],
  ["wrong_wardrobe", "Wrong wardrobe"],
  ["wrong_set", "Wrong setting"],
  ["bad_anatomy", "Bad anatomy"],
  ["extra_person", "Extra person"],
  ["artifact", "Artifacts"],
  ["other", "Something else"],
];

const CHECKER =
  "bg-[length:16px_16px] bg-[conic-gradient(#cfcfd3_25%,#f2f2f4_0_50%,#cfcfd3_0_75%,#f2f2f4_0)]";

/** What kind of picture a take is, so a generated one is never read as a photograph. */
const kindNote = (t: StudioTake) =>
  t.operation === "cutout"
    ? "Cutout: the original pixels with the background removed"
    : t.operation === "edit"
      ? "Generated change, not the original picture"
      : "Generated reference, not a photograph";

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** What the creator was charged: the price shown before it ran (the owner also sees what the provider billed). */
const cost = (t: StudioTake) => {
  if (!t.paid) return "No charge";
  const price = t.estimateUsd != null ? `Price ${priceText(t.estimateUsd)}` : "";
  if (!showsOwnerCost()) return price;
  const billed =
    t.actualUsd != null
      ? `provider billed ${usd(t.actualUsd)}`
      : t.status === "succeeded"
        ? "provider bill not reported"
        : "";
  return [price, billed].filter(Boolean).join(" · ");
};

/**
 * The stage: a result beside what it was made from, at a size a picture can be judged at, on a neutral grey surround;
 * or, while the creator is choosing them, the pictures the NEXT request starts from (all of them, numbered in the
 * order they are sent). Under it, what the result is and what it cost, the acts that use it (each one explicit;
 * nothing is promoted on its own), and every take made for this subject. Two or more takes can be put side by side.
 */
export function Stage({
  slug,
  subject,
  takes,
  images,
  focused: focusedTake,
  starting,
  view,
  changing,
  hostedMatting,
  locationViewKinds,
  shots,
  onFocus,
  onStartFrom,
  onChange,
  onReuse,
  onChoosePhotos,
  dragging,
  referenceSet,
  photos,
  onMake,
}: {
  slug: string;
  subject: NonNullable<StudioState["selected"]>;
  takes: StudioTake[];
  images: StudioImage[];
  focused: StudioTake | null;
  /** The brief's current starting images: what the next request sends, in order. */
  starting: StudioImage[];
  /** "start": show the starting images (when there are any) instead of the focused take. */
  view: "take" | "start";
  /** true: the brief is changing one image (the starting image is the picture being changed). */
  changing: boolean;
  hostedMatting: HostedMattingOffer;
  locationViewKinds: Array<{ id: string; label: string }>;
  /** The Shots this subject appears in (where its references become a Production Frame). */
  shots: StudioShot[];
  onFocus: (attemptId: string) => void;
  onStartFrom: (assetId: string) => void;
  onChange: (assetId: string) => void;
  onReuse: (take: StudioTake) => void;
  /** Opens the file dialog of the Studio's upload area. */
  onChoosePhotos: () => void;
  /** true: files are being dragged over the Studio (a drop anywhere adds them). */
  dragging: boolean;
  /** A Character's reference set (empty for a Location). */
  referenceSet: StudioSetView[];
  /** How many of the creator's own photos of the subject there are. */
  photos: number;
  /** Fills in the brief to make a view of the reference set (or a Look's picture). */
  onMake: (intent: string, lookId?: string) => void;
}) {
  // while the creator is choosing what to start from, the stage shows that, not an older result
  const focused = view === "start" && starting.length > 0 ? null : focusedTake;
  const [compare, setCompare] = useState<string[]>([]);
  const [showRejected, setShowRejected] = useState(false);
  // the slot a take naturally fills comes from what the take IS (a 3/4 view suggests the 3/4 slot), until changed
  const [slotChoice, setSlotChoice] = useState<{ take: string; slot: string } | null>(null);
  const slot =
    slotChoice && slotChoice.take === focused?.attemptId
      ? slotChoice.slot
      : ((focused ? referencePreset(subject.kind, focused.settings.intent)?.slot : null) ?? "additional");
  const rejectedCount = takes.filter((t) => t.rejected).length;
  const visible = takes.filter((t) => showRejected || !t.rejected || t.attemptId === focused?.attemptId);
  const compared = compare.flatMap((id) => takes.filter((t) => t.attemptId === id && t.asset?.url));
  const comparing = compared.length >= 2;
  const first = compared[0]?.inputs[0];
  const commonStart =
    comparing && first?.url && compared.every((t) => t.inputs[0]?.assetId === first.assetId) ? first : null;
  const toggleCompare = (id: string) =>
    setCompare((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-4)));
  const character = subject.kind === "character";
  const canonicalName = character ? "Canonical identity" : "Canonical location";
  const hasCanonical = images.some((i) => i.roles.includes(canonicalName));
  const hasCutout = images.some((i) => i.roles.includes("Cutout"));
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  // from the starting images, the way back to the take the creator was looking at
  const back =
    !focused && focusedTake ? (
      <button
        type="button"
        className="mt-1 text-[11.5px] text-accent hover:underline"
        onClick={() => onFocus(focusedTake.attemptId)}
        data-testid="studio-back-to-take"
      >
        Back to take #{focusedTake.number}
      </button>
    ) : null;

  return (
    <section className="min-w-0 space-y-3" aria-label="Stage" data-testid="studio-stage">
      <div
        className="flex min-h-[420px] items-center justify-center rounded-[3px] border border-line bg-[#232326] p-4"
        data-testid="studio-surface"
        data-view={comparing ? "compare" : focused ? "take" : starting.length > 0 ? "start" : "empty"}
      >
        {comparing ? (
          <ul
            className="grid w-full gap-3"
            style={{
              gridTemplateColumns: `repeat(${compared.length + (commonStart ? 1 : 0)}, minmax(0, 1fr))`,
            }}
            data-testid="studio-compare"
          >
            {commonStart ? (
              <li className="min-w-0" data-testid="studio-compare-start">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={commonStart.url!}
                  alt=""
                  className="max-h-[520px] w-full rounded-[2px] object-contain"
                />
                <p className="mt-1 text-[11.5px] text-muted">What they started from</p>
              </li>
            ) : null}
            {compared.map((t) => (
              <li key={t.attemptId} className="min-w-0">
                <div className={cn("overflow-hidden rounded-[2px]", t.asset!.hasAlpha ? CHECKER : "")}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.asset!.url!}
                    alt={`Take ${t.number}: ${t.what}`}
                    className="max-h-[520px] w-full object-contain"
                  />
                </div>
                <p className="mt-1 text-[11.5px]">
                  <button
                    type="button"
                    className="font-medium hover:underline"
                    onClick={() => onFocus(t.attemptId)}
                  >
                    #{t.number} {t.what}
                  </button>
                  <span className="text-muted"> · {cost(t)}</span>
                </p>
              </li>
            ))}
          </ul>
        ) : focused ? (
          <div className="flex w-full items-center justify-center gap-4">
            {focused.inputs.length > 0 ? (
              // what THIS take was made from (the next request's starting images are chosen in the brief)
              <div className="w-[22%] min-w-[96px] max-w-[180px] shrink-0" data-testid="studio-inputs">
                <p className="mb-1.5 text-[10.5px] font-medium text-muted">
                  Take #{focused.number}{" "}
                  {focused.operation === "cutout"
                    ? "was cut out of"
                    : focused.operation === "edit"
                      ? "changed"
                      : `was made from${focused.inputs.length > 1 ? ` ${focused.inputs.length} images` : ""}`}
                </p>
                <ol
                  className={focused.inputs.length > 2 ? "grid grid-cols-2 gap-1.5" : "flex flex-col gap-2"}
                >
                  {focused.inputs.slice(0, 6).map((i, n) => (
                    <li key={i.assetId} className="text-[10.5px] text-muted">
                      {i.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={i.url} alt="" className="w-full rounded-[2px]" />
                      ) : null}
                      <span className="mt-0.5 block">
                        {focused.operation === "edit"
                          ? n === 0
                            ? "The image changed"
                            : "Also sent"
                          : focused.operation === "cutout"
                            ? "The original"
                            : `Starting image${focused.inputs.length > 1 ? ` ${n + 1}` : ""}`}
                      </span>
                    </li>
                  ))}
                  {focused.inputs.length > 6 ? (
                    <li className="col-span-2 text-[10.5px] text-muted">
                      and {focused.inputs.length - 6} more
                    </li>
                  ) : null}
                </ol>
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 items-center justify-center">
              {focused.asset?.url ? (
                <div className={cn("overflow-hidden rounded-[2px]", focused.asset.hasAlpha ? CHECKER : "")}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={focused.asset.url}
                    alt={`Take ${focused.number}: ${focused.what}`}
                    className={cn(
                      "max-h-[620px] max-w-full object-contain",
                      focused.rejected ? "opacity-50" : "",
                    )}
                    data-testid="studio-result"
                  />
                </div>
              ) : focused.status === "failed" || focused.status === "cancelled" ? (
                <div className="max-w-sm text-center" data-testid="studio-failed">
                  <p className="text-[13px] font-medium text-fail">
                    {focused.status === "cancelled" ? "Cancelled" : "This image was not made"}
                  </p>
                  <p className="mt-1 text-[12px] text-muted">{focused.error}</p>
                </div>
              ) : (
                <div className="text-center" data-testid="studio-working" aria-live="polite">
                  <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-line2 border-t-accent motion-reduce:animate-none" />
                  <p className="text-[13px]">
                    {focused.status === "queued" ? "Waiting to start" : "Making the picture"}
                  </p>
                  <p className="mt-1 text-[11.5px] text-muted">This page updates on its own.</p>
                </div>
              )}
            </div>
          </div>
        ) : starting.length > 1 ? (
          <div className="w-full text-center" data-testid="studio-starting-set" data-count={starting.length}>
            <ul className="flex flex-wrap items-end justify-center gap-3">
              {starting.map((i, at) => (
                <li key={i.assetId} className="relative">
                  {i.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={i.url}
                      alt={i.label}
                      className={cn(
                        "max-w-full rounded-[2px] object-contain",
                        starting.length > 4
                          ? "max-h-[200px]"
                          : starting.length > 2
                            ? "max-h-[300px]"
                            : "max-h-[420px]",
                      )}
                      data-testid="studio-starting"
                    />
                  ) : null}
                  <span className="absolute left-1 top-1 rounded-[2px] bg-accent px-1.5 text-[11px] font-semibold text-accentfg">
                    {at + 1}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted" data-testid="studio-starting-note">
              Your {starting.length} starting images, sent together as views of the same{" "}
              {subject.kind === "character" ? "person" : "place"}. Choose what to make from them, then
              Generate.
            </p>
            {back}
          </div>
        ) : starting[0]?.url ? (
          <div className="text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={starting[0].url}
              alt={starting[0].label}
              className="mx-auto max-h-[520px] max-w-full rounded-[2px] object-contain"
              data-testid="studio-starting"
            />
            <p className="mt-2 text-[12px] text-muted" data-testid="studio-starting-note">
              {changing
                ? "The picture you are changing. Choose the change, then press Change image."
                : "Your starting image. Choose what to make from it, then Generate."}
            </p>
            {back}
          </div>
        ) : (
          <div className="max-w-sm text-center" data-testid="studio-empty">
            <p className="text-[14px] font-medium">
              {dragging && !subject.locked
                ? `Drop to add to ${subject.name}`
                : images.length > 0
                  ? "No starting image selected"
                  : `No picture of ${subject.name} yet`}
            </p>
            <p className="mt-1 text-[12px] text-muted">
              {images.length > 0
                ? "The next picture is made from the written description alone. Click a picture under Start from to use it. The result appears here."
                : "Add reference photos to start from, or make the first reference from the written description. The result appears here."}
            </p>
            {subject.locked ? null : (
              <div className="mt-3">
                <Button type="button" onClick={onChoosePhotos} data-testid="studio-empty-choose">
                  Choose photos
                </Button>
                <p className="mt-1.5 text-[11.5px] text-faint">or drop them anywhere on this page</p>
              </div>
            )}
          </div>
        )}
      </div>

      {focused && !comparing ? (
        <div
          className="rounded-[3px] border border-line bg-panel p-3"
          data-testid="studio-take"
          data-attempt={focused.attemptId}
          data-status={focused.status}
          data-rejected={focused.rejected ? "true" : "false"}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-[13px] font-medium">
              #{focused.number} {focused.what}
            </h2>
            {focused.asset ? (
              <span className="text-[11.5px] text-muted" data-testid="studio-kind-note">
                {kindNote(focused)}
              </span>
            ) : null}
            {focused.test && focused.asset ? (
              // a test model draws a placeholder pattern: it proves the workflow, never the look of a picture
              <span className="text-[11.5px] text-warn" data-testid="studio-test-take">
                Test pattern, not a real picture
              </span>
            ) : null}
            {focused.rejected ? <Badge tone="fail">Rejected</Badge> : null}
            {focused.roles.map((r) => (
              <Badge key={r} tone="pass">
                {r}
              </Badge>
            ))}
            {focused.status === "succeeded" && focused.asset ? (
              <span className="ml-auto">
                <span className="inline-flex gap-1">
                  <ArchiveButton
                    slug={slug}
                    subject={subject}
                    assetId={focused.asset.id}
                    what="take"
                    label="Archive take"
                  />
                  <DeleteButton slug={slug} subject={subject} assetId={focused.asset.id} what="take" />
                </span>
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11.5px] text-muted">
            {focused.modelLabel} · {when(focused.createdAt)}
            {focused.asset?.width && focused.asset.height
              ? ` · ${focused.asset.width} × ${focused.asset.height} px`
              : ""}
            {" · "}
            <span data-testid="studio-cost">{cost(focused)}</span>
          </p>
          {focused.rejected && focused.rejection ? (
            <p className="mt-1 text-[11.5px] text-fail" data-testid="studio-rejection">
              {focused.rejection}
            </p>
          ) : null}

          {focused.status === "succeeded" && focused.asset && !focused.rejected ? (
            <div className="mt-3 space-y-2" data-testid="studio-use">
              {character && referenceSet.length > 0 && !focused.asset.hasAlpha ? (
                // the one thing most takes are for: a view of the Character's reference set
                <AddToSet
                  slug={slug}
                  characterId={subject.id}
                  set={referenceSet}
                  attemptId={focused.attemptId}
                  assetId={focused.asset.id}
                  suggested={referenceSetViewOf(focused.settings.intent)}
                />
              ) : null}
              {character && referenceSet.length > 0 ? (
                <p className="text-[11px] text-faint">Other uses:</p>
              ) : null}
              {subject.locked ? (
                <p className="text-[12px] text-warn" data-testid="studio-locked">
                  {subject.name} is locked, so its references and Visual Bible cannot change.{" "}
                  <Link href={`/projects/${slug}/locations`} className="underline">
                    Unlock it on the Locations page
                  </Link>{" "}
                  to use this picture.
                </p>
              ) : null}
              <div className="flex flex-wrap items-start gap-2">
                {character && focused.asset.hasAlpha ? (
                  <ActionForm
                    action={setCharacterCutout}
                    successMessage="Cutout set"
                    className="flex flex-col"
                  >
                    {hidden}
                    <input type="hidden" name="characterId" value={subject.id} />
                    <input type="hidden" name="attemptId" value={focused.attemptId} />
                    <Button
                      type="submit"
                      disabled={focused.roles.includes("Cutout")}
                      data-testid="studio-use-cutout"
                    >
                      Use as cutout
                    </Button>
                    {hasCutout && !focused.roles.includes("Cutout") ? (
                      <label className="mt-1 flex items-center gap-1 text-[11px] text-muted">
                        <input type="checkbox" name="confirmReplace" value="1" />
                        Replace the current one
                      </label>
                    ) : null}
                  </ActionForm>
                ) : character ? null : (
                  // a Character's canonical identity is its front view: "Add to the reference set" above sets it
                  <ActionForm
                    action={character ? setCanonicalIdentity : setCanonicalLocation}
                    successMessage={`${canonicalName} set`}
                    className="flex flex-col"
                  >
                    {hidden}
                    <input type="hidden" name={character ? "characterId" : "locationId"} value={subject.id} />
                    <input type="hidden" name="attemptId" value={focused.attemptId} />
                    <Button
                      type="submit"
                      disabled={subject.locked || focused.roles.includes(canonicalName)}
                      data-testid="studio-use-canonical"
                    >
                      Use as {canonicalName.toLowerCase()}
                    </Button>
                    {hasCanonical && !focused.roles.includes(canonicalName) ? (
                      <label className="mt-1 flex items-center gap-1 text-[11px] text-muted">
                        <input
                          type="checkbox"
                          name="confirmReplace"
                          value="1"
                          data-testid="studio-confirm-replace"
                        />
                        Replace the current one
                      </label>
                    ) : null}
                  </ActionForm>
                )}

                {character && !focused.asset.hasAlpha ? (
                  <ActionForm
                    action={saveAsCharacterReference}
                    successMessage="Reference set"
                    className="flex flex-col"
                  >
                    {hidden}
                    <input type="hidden" name="characterId" value={subject.id} />
                    <input type="hidden" name="attemptId" value={focused.attemptId} />
                    <input type="hidden" name="guardReplace" value="1" />
                    <span className="flex gap-1">
                      <select
                        name="slot"
                        value={slot}
                        onChange={(e) => setSlotChoice({ take: focused.attemptId, slot: e.target.value })}
                        aria-label="Reference slot"
                        className="w-32"
                        data-testid="studio-slot"
                      >
                        {SLOTS.map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" data-testid="studio-use-reference">
                        Use as reference
                      </Button>
                    </span>
                    {subject.filledSlots.includes(slot) &&
                    !focused.roles.some((r) => r.endsWith("reference")) ? (
                      <label className="mt-1 flex items-center gap-1 text-[11px] text-muted">
                        <input
                          type="checkbox"
                          name="confirmReplace"
                          value="1"
                          data-testid="studio-confirm-replace-slot"
                        />
                        Replace the current {SLOTS.find(([id]) => id === slot)?.[1].toLowerCase()} reference
                      </label>
                    ) : null}
                  </ActionForm>
                ) : null}

                {character && subject.looks.length > 0 && !focused.asset.hasAlpha ? (
                  <ActionForm
                    action={saveAsLookReference}
                    successMessage="Added to the Look"
                    className="flex gap-1"
                  >
                    {hidden}
                    <input type="hidden" name="attemptId" value={focused.attemptId} />
                    <select name="lookId" aria-label="Look" className="w-40" data-testid="studio-use-look-id">
                      {subject.looks.map((l) => (
                        <option key={l.id} value={l.id} disabled={l.locked}>
                          {l.name}
                          {l.locked ? " (locked)" : ""}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="submit"
                      disabled={subject.looks.every((l) => l.locked)}
                      title={
                        subject.looks.every((l) => l.locked)
                          ? "Every Look is locked. Unlock one on the Character page to add references to it."
                          : undefined
                      }
                      data-testid="studio-use-look"
                    >
                      Add to Look
                    </Button>
                  </ActionForm>
                ) : null}
                {character &&
                subject.looks.length > 0 &&
                !focused.asset.hasAlpha &&
                (focused.settings.intent === "outfit_variant" || !!focused.settings.lookId) ? (
                  // a wardrobe reference made from the reference set is what a Look's picture should be: it shows
                  // this Character's face, so it replaces an older picture rather than standing beside it
                  <ActionForm
                    action={replaceLookReference}
                    successMessage="It is now the Look's picture"
                    className="flex flex-col"
                  >
                    {hidden}
                    <input type="hidden" name="attemptId" value={focused.attemptId} />
                    <input
                      type="hidden"
                      name="lookId"
                      value={focused.settings.lookId ?? subject.looks[0]!.id}
                    />
                    <input type="hidden" name="confirmReplace" value="1" />
                    {(() => {
                      const look =
                        subject.looks.find((l) => l.id === focused.settings.lookId) ?? subject.looks[0]!;
                      return (
                        <>
                          <Button
                            type="submit"
                            variant="primary"
                            disabled={look.locked}
                            data-testid="studio-replace-look"
                          >
                            Make it the picture of &ldquo;{look.name}&rdquo;
                          </Button>
                          <span
                            className="mt-1 text-[11px] text-muted"
                            data-testid="studio-replace-look-note"
                          >
                            {look.locked ? (
                              <>
                                This Look is locked.{" "}
                                <Link
                                  href={`/projects/${slug}/characters/${subject.id}`}
                                  className="underline"
                                >
                                  Unlock it on {subject.name}&apos;s page
                                </Link>{" "}
                                first.
                              </>
                            ) : look.references > 0 ? (
                              `Replaces its ${look.references} current picture${look.references === 1 ? "" : "s"} (kept in the library).`
                            ) : (
                              "The Look has no picture yet."
                            )}
                          </span>
                        </>
                      );
                    })()}
                  </ActionForm>
                ) : null}

                {!character ? (
                  <>
                    <ActionForm action={saveAsLocationReference} successMessage="Added to the references">
                      {hidden}
                      <input type="hidden" name="locationId" value={subject.id} />
                      <input type="hidden" name="attemptId" value={focused.attemptId} />
                      <Button
                        type="submit"
                        disabled={subject.locked}
                        data-testid="studio-use-location-reference"
                      >
                        Add to references
                      </Button>
                    </ActionForm>
                    <ActionForm
                      action={saveAsLocationView}
                      successMessage="Location View saved"
                      className="flex gap-1"
                    >
                      {hidden}
                      <input type="hidden" name="locationId" value={subject.id} />
                      <input type="hidden" name="attemptId" value={focused.attemptId} />
                      <input
                        name="lv_name"
                        aria-label="View name"
                        placeholder="Entrance toward elevators"
                        required
                        className="w-44"
                      />
                      <select name="lv_kind" aria-label="View kind" defaultValue="custom" className="w-32">
                        {locationViewKinds.map((k) => (
                          <option key={k.id} value={k.id}>
                            {k.label}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" disabled={subject.locked} data-testid="studio-use-location-view">
                        Save as Location View
                      </Button>
                    </ActionForm>
                  </>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
                <Button
                  type="button"
                  onClick={() => onChange(focused.asset!.id)}
                  data-testid="studio-change-this"
                >
                  Change this image
                </Button>
                <Button
                  type="button"
                  onClick={() => onStartFrom(focused.asset!.id)}
                  data-testid="studio-start-from-this"
                >
                  Start a new picture from it
                </Button>
                {character && focused.operation !== "cutout" ? (
                  <ActionForm action={removeBackground} successMessage="Background removal queued" quiet>
                    {hidden}
                    <input type="hidden" name="subjectKind" value="character" />
                    <input type="hidden" name="subjectId" value={subject.id} />
                    <input type="hidden" name="sourceAssetId" value={focused.asset.id} />
                    <Button type="submit" data-testid="studio-remove-background">
                      Remove background
                    </Button>
                  </ActionForm>
                ) : null}
                <Button type="button" onClick={() => onReuse(focused)} data-testid="studio-reuse">
                  Reuse these settings
                </Button>
                {focused.asset.url ? (
                  <a
                    href={focused.asset.url}
                    download={`${subject.name}-${focused.number}-${focused.what}.png`.replace(
                      /[^\w.-]+/g,
                      "-",
                    )}
                    className="text-[12px] text-accent hover:underline"
                    data-testid="studio-download"
                  >
                    Download
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}

          {focused.status === "failed" ? (
            <div className="mt-2 space-y-2">
              {focused.cutoutRefused ? (
                <div className="rounded-[3px] border border-line p-2" data-testid="studio-high-quality-offer">
                  <p className="text-[12px]">
                    The free cutout tool only handles plain backgrounds, and this one is busy.
                  </p>
                  {hostedMatting.available && hostedMatting.usdPerImage != null && focused.inputs[0] ? (
                    <ActionForm action={removeBackground} successMessage="High Quality Removal queued">
                      {hidden}
                      <input type="hidden" name="subjectKind" value="character" />
                      <input type="hidden" name="subjectId" value={subject.id} />
                      <input type="hidden" name="sourceAssetId" value={focused.inputs[0].assetId} />
                      <input type="hidden" name="quality" value="high" />
                      <input
                        type="hidden"
                        name="confirmedTotalUsd"
                        value={String(hostedMatting.usdPerImage)}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        className="mt-1"
                        data-testid="studio-high-quality"
                      >
                        High Quality Removal · {priceText(hostedMatting.usdPerImage)}
                      </Button>
                      <p className="mt-1 text-[11px] text-muted">{hostedMatting.privacyShort}</p>
                    </ActionForm>
                  ) : (
                    <p
                      className="mt-1 text-[11.5px] text-muted"
                      data-testid="studio-high-quality-unavailable"
                    >
                      The paid cutout tool is not set up on this server. You can still clean the background
                      with &ldquo;Change an image&rdquo; &rarr; &ldquo;Clean studio background&rdquo;, which
                      redraws it.
                    </p>
                  )}
                </div>
              ) : null}
              <Button type="button" onClick={() => onReuse(focused)} data-testid="studio-reuse">
                Reuse these settings
              </Button>
            </div>
          ) : null}

          {focused.status === "succeeded" ? (
            <div className="mt-2 flex flex-wrap items-start gap-3 border-t border-line pt-2">
              {focused.rejected ? (
                <ActionForm action={reviewReferenceImage} successMessage="Restored">
                  {hidden}
                  <input type="hidden" name="attemptId" value={focused.attemptId} />
                  <input type="hidden" name="decision" value="restore" />
                  <Button type="submit" data-testid="studio-restore">
                    Restore
                  </Button>
                </ActionForm>
              ) : (
                <details data-testid="studio-reject-panel">
                  <summary className="text-[12px] text-muted hover:text-fg" data-testid="studio-reject-open">
                    Reject this take
                  </summary>
                  <ActionForm
                    action={reviewReferenceImage}
                    successMessage="Rejected"
                    className="mt-1.5 flex flex-wrap items-center gap-1.5"
                  >
                    {hidden}
                    <input type="hidden" name="attemptId" value={focused.attemptId} />
                    <input type="hidden" name="decision" value="reject" />
                    <select
                      name="category"
                      aria-label="What is wrong"
                      className="w-52"
                      data-testid="studio-reject-category"
                    >
                      {REJECTIONS.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <input
                      name="reason"
                      aria-label="A note on why"
                      placeholder="A note on why (optional)"
                      className="w-56"
                      data-testid="studio-reject-reason"
                    />
                    <Button type="submit" variant="danger" data-testid="studio-reject">
                      Reject
                    </Button>
                  </ActionForm>
                  <p className="mt-1 text-[11px] text-faint">
                    A rejected take stays in the history with your reason. It is never deleted or made again
                    on its own.
                  </p>
                </details>
              )}
              <details className="min-w-0 flex-1" data-testid="studio-provenance">
                <summary className="text-[12px] text-muted hover:text-fg">What was sent</summary>
                <div className="mt-1.5 space-y-1.5 rounded-[3px] border border-line bg-bg p-2">
                  <p className="text-[11.5px] text-muted">
                    {focused.inputs.length === 0
                      ? "No image was sent: the written description only."
                      : `${focused.inputs.length} image${focused.inputs.length === 1 ? "" : "s"}: ${focused.inputs
                          .map((i) => i.label)
                          .join("; ")}.`}
                  </p>
                  <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed">{focused.prompt}</p>
                </div>
              </details>
            </div>
          ) : null}
        </div>
      ) : null}

      {comparing ? (
        <div className="flex items-center gap-3 text-[12px]">
          <span className="text-muted">Comparing {compared.length} takes.</span>
          <Button type="button" onClick={() => setCompare([])} data-testid="studio-compare-exit">
            Back to one take
          </Button>
        </div>
      ) : null}

      {shots.length > 0 && images.some((i) => i.roles.length > 0) ? (
        <div className="text-[12px]" data-testid="studio-shots">
          <span className="text-muted">
            Next, a Production Frame for a Shot with {subject.name} (Prism sends these references on its
            own):{" "}
          </span>
          {shots.slice(0, 12).map((s) => (
            <Link
              key={s.id}
              href={s.href}
              className="mr-2 inline-block text-accent hover:underline"
              data-testid="studio-shot"
            >
              {s.code}
              {s.hasFrame ? " ✓" : ""}
            </Link>
          ))}
          {shots.length > 12 ? <span className="text-muted">and {shots.length - 12} more</span> : null}
        </div>
      ) : null}

      {character && referenceSet.length > 0 ? (
        <ReferenceSetPanel
          slug={slug}
          subject={subject}
          set={referenceSet}
          pictures={images.filter((i) => !i.wardrobeOnly && !i.rejected)}
          photos={photos}
          onMake={onMake}
        />
      ) : null}

      {takes.length > 0 ? (
        <div data-testid="studio-takes">
          <div className="mb-1.5 flex items-baseline justify-between">
            <h2 className="text-[12px] font-medium">
              Takes <span className="font-normal text-muted">({takes.length})</span>
            </h2>
            <div className="flex items-center gap-3 text-[11px] text-muted">
              {compare.length === 1 ? <span>Tick one more to compare</span> : null}
              {rejectedCount > 0 ? (
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={showRejected}
                    onChange={(e) => setShowRejected(e.target.checked)}
                    data-testid="studio-show-rejected"
                  />
                  Show rejected ({rejectedCount})
                </label>
              ) : null}
            </div>
          </div>
          <ul className="flex flex-wrap gap-2">
            {visible.map((t) => (
              <li key={t.attemptId} className="w-[76px]">
                <button
                  type="button"
                  aria-pressed={t.attemptId === focused?.attemptId}
                  aria-label={`Take ${t.number}: ${t.what}, ${t.rejected ? "rejected" : t.status}`}
                  onClick={() => onFocus(t.attemptId)}
                  draggable={!!t.asset && t.status === "succeeded" && !t.rejected}
                  onDragStart={(e) =>
                    t.asset ? startPictureDrag(e, { assetId: t.asset.id, attemptId: t.attemptId }) : undefined
                  }
                  data-testid="studio-take-thumb"
                  data-attempt={t.attemptId}
                  data-asset={t.asset?.id ?? ""}
                  data-status={t.status}
                  className={cn(
                    "relative block h-[96px] w-full overflow-hidden rounded-[3px] border bg-[#232326]",
                    t.attemptId === focused?.attemptId && !comparing
                      ? "border-accent ring-1 ring-accent"
                      : "border-line2 hover:border-muted",
                  )}
                >
                  {t.asset?.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={t.asset.url}
                      alt=""
                      className={cn("h-full w-full object-cover", t.rejected ? "opacity-40" : "")}
                    />
                  ) : (
                    <span className="flex h-full items-center justify-center px-1 text-center text-[10px] text-muted">
                      {t.status === "failed"
                        ? "Not made"
                        : t.status === "cancelled"
                          ? "Cancelled"
                          : "Working…"}
                    </span>
                  )}
                  {t.roles.length > 0 ? (
                    <span className="absolute right-0.5 top-0.5 rounded-[2px] bg-pass px-1 text-[9px] font-semibold text-black">
                      in use
                    </span>
                  ) : null}
                </button>
                <div className="mt-0.5 flex items-center justify-between gap-1 text-[10.5px] text-muted">
                  <span className="truncate" title={t.what}>
                    #{t.number} {t.what}
                  </span>
                  {t.asset?.url ? (
                    <input
                      type="checkbox"
                      checked={compare.includes(t.attemptId)}
                      onChange={() => toggleCompare(t.attemptId)}
                      aria-label={`Compare take ${t.number}`}
                      title="Compare"
                      data-testid="studio-compare-toggle"
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
