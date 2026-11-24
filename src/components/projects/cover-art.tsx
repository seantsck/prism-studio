"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Button } from "@/components/ui";
import { ZoomImage } from "@/components/zoom-image";
import { priceText } from "@/domain/pricing/user-price";
import { cn } from "@/lib/utils";
import { makeCoverArt, setCover, stopCoverArt } from "@/server/cover-art-actions";
import type { CoverArtState } from "@/server/cover-art";

const ratioOf = (r: string | null, w: number | null, h: number | null) => {
  if (w && h) return `${w} / ${h}`;
  const [a, b] = (r ?? "2:3").split(":").map(Number);
  return a && b ? `${a} / ${b}` : "2 / 3";
};

/** A cover with the project's title laid over it (the picture itself carries no lettering). */
export function CoverWithTitle({
  url,
  title,
  ratio,
  width,
  height,
  className,
  testId,
  small = false,
}: {
  url: string | null;
  title: string;
  /** a thumbnail: smaller title type */
  small?: boolean;
  ratio?: string | null;
  width?: number | null;
  height?: number | null;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-[3px] border border-line2 bg-[#1b1b1e]", className)}
      style={{ aspectRatio: ratioOf(ratio ?? null, width ?? null, height ?? null) }}
      data-testid={testId}
    >
      {url ? (
        <ZoomImage
          src={url}
          alt={`Cover art for ${title}`}
          wrapperClassName="block h-full w-full"
          className="h-full w-full object-cover"
          caption={title}
        />
      ) : null}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent",
          small ? "px-2 pb-4 pt-1.5" : "px-3 pb-8 pt-3",
        )}
      >
        <div
          className={cn(
            "text-balance text-center font-semibold leading-tight tracking-tight text-white drop-shadow",
            small ? "text-[11px]" : "text-[18px]",
          )}
        >
          {title}
        </div>
      </div>
    </div>
  );
}

/**
 * Cover art: choose the engine and the shape, add a direction, see the price, and make one; every picture made is
 * listed with the title laid over it, and any of them can be used as the cover.
 */
export function CoverArtPanel({
  slug,
  title,
  state,
  compact = false,
}: {
  slug: string;
  title: string;
  state: CoverArtState;
  /** Start from a prompt: the current cover and the maker only, newest takes in a short row */
  compact?: boolean;
}) {
  const engines = state.engines;
  const [engine, setEngine] = useState(engines.find((e) => !e.paid)?.value ?? engines[0]?.value ?? "");
  const chosen = engines.find((e) => e.value === engine);
  const [ratio, setRatio] = useState(chosen?.shapes[0]?.ratio ?? "2:3");
  const shape = chosen?.shapes.find((s) => s.ratio === ratio) ?? chosen?.shapes[0];
  const [direction, setDirection] = useState("");
  const [cast, setCast] = useState<string[]>(() => state.characters.filter((c) => c.chosen).map((c) => c.id));
  const [locationId, setLocationId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const working = state.takes.some(
    (t) => t.status !== "succeeded" && t.status !== "failed" && t.status !== "cancelled",
  );
  const price = shape?.usd != null ? (chosen?.paid ? priceText(shape.usd) : "free") : "";
  const takes = compact ? state.takes.slice(0, 4) : state.takes;

  return (
    <div className="space-y-3 text-[12.5px]" data-testid="cover-art">
      <RefreshWhileActive active={working} intervalMs={1500} />
      <div className={cn("grid gap-4", compact ? "sm:grid-cols-[160px_1fr]" : "md:grid-cols-[260px_1fr]")}>
        <div>
          {state.cover ? (
            <CoverWithTitle
              url={state.cover.url}
              title={title}
              width={state.cover.width}
              height={state.cover.height}
              testId="cover-current"
              small={compact}
            />
          ) : (
            <div
              className="flex aspect-[2/3] items-center justify-center rounded-[3px] border border-dashed border-line2 px-3 text-center text-muted"
              data-testid="cover-none"
            >
              No cover yet
            </div>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-muted">
            Prism makes a poster from the title, premise, tone and look of your project, with the characters
            and place you choose: each one&apos;s main picture is sent so faces and the place match. The
            picture has no lettering; the title is laid over it.
          </p>
          {state.characters.length ? (
            <fieldset data-testid="cover-cast">
              <legend className="mb-1 text-muted">
                Characters (up to {state.castMax}; {cast.length} chosen)
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {state.characters.map((c) => {
                  const on = cast.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
                        on ? "border-accent bg-accent/10" : "border-line",
                      )}
                      title={
                        c.pictured ? "Their main picture is sent" : "No main picture yet: described in words"
                      }
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && cast.length >= state.castMax}
                        onChange={() =>
                          setCast((prev) => (on ? prev.filter((x) => x !== c.id) : [...prev, c.id]))
                        }
                        data-testid="cover-cast-pick"
                        data-name={c.name}
                      />
                      {c.name}
                      {c.pictured ? null : <span className="text-faint">(no picture)</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          {state.locations.length ? (
            <label className="block">
              <span className="mb-1 block text-muted">Location (optional)</span>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                data-testid="cover-location"
              >
                <option value="">No particular place</option>
                {state.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.pictured ? "" : " (no picture: described in words)"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {!state.available ? (
            <p className="text-warn" data-testid="cover-needs-update">
              Cover art needs a one-time database update (migration 0069) that has not been applied yet.
            </p>
          ) : engines.length === 0 ? (
            <p className="text-warn" data-testid="cover-unavailable">
              No image engine is switched on for this server.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <select
                  value={engine}
                  onChange={(e) => {
                    setEngine(e.target.value);
                    const next = engines.find((x) => x.value === e.target.value);
                    if (next && !next.shapes.some((s) => s.ratio === ratio)) setRatio(next.shapes[0]!.ratio);
                  }}
                  aria-label="Engine"
                  data-testid="cover-engine"
                >
                  {engines.map((e) => (
                    <option key={e.value} value={e.value}>
                      {e.label}
                      {e.paid ? "" : " (free)"}
                    </option>
                  ))}
                </select>
                <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Shape">
                  {chosen?.shapes.map((s) => (
                    <button
                      key={s.ratio}
                      type="button"
                      role="radio"
                      aria-checked={s.ratio === shape?.ratio}
                      onClick={() => setRatio(s.ratio)}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-[12px]",
                        s.ratio === shape?.ratio
                          ? "border-accent bg-accent/10 text-fg"
                          : "border-line text-muted hover:text-fg",
                      )}
                      data-testid="cover-shape"
                      data-ratio={s.ratio}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                rows={2}
                value={direction}
                maxLength={2000}
                onChange={(e) => setDirection(e.target.value)}
                placeholder="Direction (optional): for example, the two leads back to back under a rainy neon sky."
                aria-label="Direction"
                data-testid="cover-direction"
              />
              {shape?.reason ? (
                <p className="text-warn" data-testid="cover-refused">
                  {shape.reason}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    disabled={working}
                    onClick={() => setConfirming(true)}
                    data-testid="cover-make"
                  >
                    {working ? "Prism is making a cover…" : "Make cover art…"}
                  </Button>
                  <span className="text-muted" data-testid="cover-price">
                    {price} with {chosen?.label}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {takes.length > 0 ? (
        <ul
          className={cn(
            "grid gap-3",
            compact ? "grid-cols-4" : "grid-cols-[repeat(auto-fill,minmax(170px,1fr))]",
          )}
        >
          {takes.map((t) => {
            const isCover = !!t.assetId && t.assetId === state.cover?.assetId;
            return (
              <li key={t.attemptId} className="space-y-1" data-testid="cover-take" data-status={t.status}>
                {t.status === "succeeded" ? (
                  <CoverWithTitle
                    url={t.url}
                    title={title}
                    ratio={t.ratio}
                    width={t.width}
                    height={t.height}
                  />
                ) : (
                  <div
                    className="flex items-center justify-center rounded-[3px] border border-line2 bg-[#1b1b1e] px-2 text-center text-[11.5px] text-muted"
                    style={{ aspectRatio: ratioOf(t.ratio, null, null) }}
                  >
                    {t.status === "failed"
                      ? (t.error ?? "This cover could not be made.")
                      : t.status === "cancelled"
                        ? "Stopped"
                        : "Making…"}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
                  <span>
                    #{t.number} · {t.ratio}
                  </span>
                  {isCover ? (
                    <span className="text-pass" data-testid="cover-take-current">
                      · the cover
                    </span>
                  ) : null}
                </div>
                {t.status === "succeeded" && t.assetId && !isCover ? (
                  <ActionForm action={setCover} quiet>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="assetId" value={t.assetId} />
                    <Button type="submit" size="sm" data-testid="cover-use">
                      Use as cover
                    </Button>
                  </ActionForm>
                ) : null}
                {t.status !== "succeeded" && t.status !== "failed" && t.status !== "cancelled" ? (
                  <ActionForm action={stopCoverArt} quiet>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="attemptId" value={t.attemptId} />
                    <Button type="submit" size="sm" data-testid="cover-stop">
                      Stop
                    </Button>
                  </ActionForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {confirming && chosen && shape && shape.usd != null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cover-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          data-testid="cover-confirm"
        >
          <div className="w-full max-w-md rounded-xl border border-line2 bg-panel p-5 shadow-2xl">
            <h2 id="cover-confirm-title" className="text-[16px] font-semibold">
              Make cover art?
            </h2>
            <dl className="mt-3 space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Shape</dt>
                <dd>{shape.label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Featuring</dt>
                <dd className="text-right">
                  {[
                    ...state.characters.filter((c) => cast.includes(c.id)).map((c) => c.name),
                    ...state.locations.filter((l) => l.id === locationId).map((l) => `at ${l.name}`),
                  ].join(", ") || "no one in particular"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Engine</dt>
                <dd>{chosen.label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Price</dt>
                <dd className="font-medium" data-testid="cover-confirm-price">
                  {price}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-muted">
              One picture. It is added to the list; your current cover changes only when you choose Use as
              cover.
              {chosen.paid ? " This is the price, charged when you press Make." : ""}
            </p>
            <ActionForm
              action={makeCoverArt}
              successMessage=""
              className="mt-4 flex justify-end gap-2"
              onResult={(r) => {
                if (r.ok) {
                  setConfirming(false);
                  setKey(crypto.randomUUID());
                }
              }}
            >
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="model" value={chosen.value} />
              <input type="hidden" name="aspectRatio" value={shape.ratio} />
              <input type="hidden" name="direction" value={direction} />
              <input type="hidden" name="castChosen" value="1" />
              {cast.map((id) => (
                <input key={id} type="hidden" name="cast" value={id} />
              ))}
              <input type="hidden" name="locationId" value={locationId} />
              <input type="hidden" name="idempotencyKey" value={key} />
              {chosen.paid ? (
                <input type="hidden" name="confirmedTotalUsd" value={shape.usd.toFixed(4)} />
              ) : null}
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" data-testid="cover-go">
                Make · {price}
              </Button>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
