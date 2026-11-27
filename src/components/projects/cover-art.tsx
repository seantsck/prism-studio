"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Button } from "@/components/ui";
import {
  COVER_STYLES,
  COVER_TEXT_MAX,
  COVER_TITLE_COLORS,
  COVER_TITLE_SCALE,
  COVER_TITLE_SHIFT,
  COVER_CAST_SCALE,
  COVER_CAST_SHIFT,
  DEFAULT_COVER_DESIGN,
  type CoverDesign,
  type CoverTitleColor,
} from "@/domain/cover-design";
import { MAX_EDIT_INSTRUCTION_CHARS } from "@/domain/generation/image-edit";
import { priceText } from "@/domain/pricing/user-price";
import { cn, fullUrl } from "@/lib/utils";
import {
  editCoverArt,
  makeCoverArt,
  saveCoverDesign,
  setCover,
  stopCoverArt,
} from "@/server/cover-art-actions";
import { drawCover, loadImage, type CoverBoxes, type CoverText } from "./cover-render";
import type { CoverArtState, CoverCard } from "@/server/cover-art";

const ratioOf = (r: string | null, w: number | null, h: number | null) => {
  if (w && h) return `${w} / ${h}`;
  const [a, b] = (r ?? "2:3").split(":").map(Number);
  return a && b ? `${a} / ${b}` : "2 / 3";
};

/** A cover drawn with its title design (the picture itself carries no lettering): the same drawing as the download. */
export function CoverWithTitle({
  url,
  design,
  text,
  ratio,
  width,
  height,
  className,
  testId,
  enlarge = true,
  onMove,
}: {
  url: string | null;
  /** clicking opens it large (the original picture) */
  enlarge?: boolean;
  /** the title and the cast line can be dragged up and down on the cover: their new height (percent of the cover) */
  onMove?: (which: keyof CoverBoxes, shift: number) => void;
  design: CoverDesign;
  text: CoverText;
  ratio?: string | null;
  width?: number | null;
  height?: number | null;
  className?: string;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const boxes = useRef<CoverBoxes>({ title: null, cast: null });
  // a drag in progress: what is moved, where the pointer started, the height it had; `moved` once it really moves
  const drag = useRef<{ which: keyof CoverBoxes; y0: number; shift0: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [hover, setHover] = useState<keyof CoverBoxes | null>(null);
  const hit = (clientY: number): keyof CoverBoxes | null => {
    const el = box.current;
    if (!el || !onMove) return null;
    const r = el.getBoundingClientRect();
    const y = clientY - r.top;
    const pad = r.height * 0.015;
    // where the two overlap, the one whose middle is nearest the pointer
    let best: { which: keyof CoverBoxes; d: number } | null = null;
    for (const which of ["title", "cast"] as const) {
      const b = boxes.current[which];
      if (!b || y < b.top - pad || y > b.bottom + pad) continue;
      const d = Math.abs(y - (b.top + b.bottom) / 2);
      if (!best || d < best.d) best = { which, d };
    }
    return best?.which ?? null;
  };
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!url) return;
    loadImage(url)
      .then((i) => alive && setImage(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url]);
  // the title faces may arrive after the first drawing
  useEffect(() => {
    void document.fonts?.ready.then(() => setFonts((n) => n + 1));
  }, []);
  const key = JSON.stringify([design, text]);
  useEffect(() => {
    const el = box.current;
    const c = canvas.current;
    if (!el || !c) return;
    const draw = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      boxes.current = drawCover(ctx, w, h, image, design, text);
      // where the draggable lettering is (read by the tests)
      const b = boxes.current;
      el.dataset.titleBox = b.title ? `${Math.round(b.title.top)},${Math.round(b.title.bottom)}` : "";
      el.dataset.castBox = b.cast ? `${Math.round(b.cast.top)},${Math.round(b.cast.bottom)}` : "";
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, key, fonts]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <>
      <div
        ref={box}
        className={cn("relative overflow-hidden rounded-[3px] border border-line2 bg-[#1b1b1e]", className)}
        style={{ aspectRatio: ratioOf(ratio ?? null, width ?? null, height ?? null) }}
        data-testid={testId}
        data-title={text.title}
        data-style={design.style}
      >
        <canvas
          ref={canvas}
          className="absolute inset-0 h-full w-full"
          aria-label={`Cover of ${text.title}`}
        />
        {(enlarge && url) || onMove ? (
          <button
            type="button"
            onClick={() => {
              // the click that ends a drag does not open the large view
              if (dragged.current) {
                dragged.current = false;
                return;
              }
              if (enlarge && url) setOpen(true);
            }}
            onPointerDown={(e) => {
              const which = hit(e.clientY);
              if (!which) return;
              drag.current = {
                which,
                y0: e.clientY,
                shift0: which === "title" ? design.titleShift : design.castShift,
                moved: false,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) {
                setHover(hit(e.clientY));
                return;
              }
              const dy = e.clientY - d.y0;
              if (!d.moved && Math.abs(dy) < 4) return;
              d.moved = true;
              const h = box.current?.clientHeight || 1;
              const range = d.which === "title" ? COVER_TITLE_SHIFT : COVER_CAST_SHIFT;
              const next = Math.round(Math.min(range.max, Math.max(range.min, d.shift0 + (dy / h) * 100)));
              onMove?.(d.which, next);
            }}
            onPointerUp={(e) => {
              if (drag.current?.moved) dragged.current = true;
              drag.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerLeave={() => {
              if (!drag.current) setHover(null);
            }}
            className={cn(
              "absolute inset-0",
              onMove && "touch-none",
              hover
                ? "cursor-grab active:cursor-grabbing"
                : enlarge && url
                  ? "cursor-zoom-in"
                  : "cursor-default",
            )}
            title={
              onMove
                ? "Drag the title or the cast names up or down; click to see it large"
                : "Click to see it large"
            }
            aria-label={`See the cover of ${text.title} large`}
            data-testid="cover-zoom-open"
          />
        ) : null}
      </div>
      {open && url ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Cover of ${text.title}`}
          onClick={() => setOpen(false)}
          data-testid="cover-zoom-dialog"
        >
          <div className="flex max-h-full flex-col items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {/* the original picture, drawn with the same title design */}
            <CoverWithTitle
              url={fullUrl(url)}
              design={design}
              text={text}
              ratio={ratio}
              width={width}
              height={height}
              enlarge={false}
              className="h-[84vh] max-w-[92vw]"
              testId="cover-zoom"
            />
            <button
              type="button"
              className="rounded-[3px] border border-line2 px-2 py-1 text-[12px] text-fg hover:bg-panel2"
              onClick={() => setOpen(false)}
              data-testid="cover-zoom-close"
            >
              ✕ Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * The finished cover alone (the picture with its saved title design), as the Start page and the project's card show
 * it; `enlarge` false inside a link.
 */
export function CoverFinal({
  cover,
  enlarge = true,
  className,
}: {
  cover: CoverCard | null;
  enlarge?: boolean;
  className?: string;
}) {
  if (!cover)
    return (
      <div
        className={cn(
          "flex aspect-[2/3] max-w-[220px] items-center justify-center rounded-[3px] border border-dashed border-line2 px-3 text-center text-[12px] text-muted",
          className,
        )}
        data-testid="cover-none"
      >
        No cover yet
      </div>
    );
  return (
    <CoverWithTitle
      url={cover.url}
      design={cover.design}
      text={{ title: cover.title, cast: cover.cast, kindLine: cover.kindLine }}
      width={cover.width}
      height={cover.height}
      enlarge={enlarge}
      className={className ?? "max-w-[220px]"}
      testId="cover-current"
    />
  );
}

/** The finished cover, drawn at the picture's own full size, saved as a PNG. */
async function downloadCover(url: string, design: CoverDesign, text: CoverText, slug: string) {
  const image = await loadImage(fullUrl(url));
  const c = document.createElement("canvas");
  c.width = image.naturalWidth;
  c.height = image.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  await document.fonts?.ready;
  drawCover(ctx, c.width, c.height, image, design, text);
  const blob = await new Promise<Blob | null>((done) => c.toBlob(done, "image/png"));
  if (!blob) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  // the project's slug, not the title: browsers drop non-ASCII download names and save a bare "download"
  a.download = `${slug}-cover.png`;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Size, height and colour of one line of lettering on the cover (the title, or the cast line). */
function Placement({
  what,
  testPrefix,
  scale,
  shift,
  color,
  scaleRange,
  shiftRange,
  onChange,
  resetLabel,
}: {
  what: string;
  testPrefix: string;
  scale: number;
  shift: number;
  color: CoverTitleColor;
  scaleRange: { min: number; max: number };
  shiftRange: { min: number; max: number };
  onChange: (p: { scale?: number; shift?: number; color?: CoverTitleColor }) => void;
  resetLabel: string;
}) {
  return (
    <div className="grid gap-1.5" data-testid={`${testPrefix}-placement`}>
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-muted">{what} size</span>
        <input
          type="range"
          min={scaleRange.min}
          max={scaleRange.max}
          step={5}
          value={scale}
          onChange={(e) => onChange({ scale: Number(e.target.value) })}
          className="flex-1"
          aria-label={`${what} size`}
          data-testid={`${testPrefix}-scale`}
        />
        <span className="w-10 text-right tabular-nums text-muted">{scale}%</span>
      </label>
      <label className="flex items-center gap-2">
        <span className="w-24 shrink-0 text-muted">{what} height</span>
        <input
          type="range"
          min={shiftRange.min}
          max={shiftRange.max}
          step={1}
          value={shift}
          onChange={(e) => onChange({ shift: Number(e.target.value) })}
          className="flex-1"
          aria-label={`Move the ${what.toLowerCase()} up or down`}
          data-testid={`${testPrefix}-shift`}
        />
        <span className="w-10 text-right tabular-nums text-muted">
          {shift === 0 ? "—" : shift < 0 ? "up" : "down"}
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={`${what} colour`}>
        <span className="w-24 shrink-0 text-muted">{what} colour</span>
        {COVER_TITLE_COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={color === c.id}
            onClick={() => onChange({ color: c.id })}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11.5px]",
              color === c.id ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
            )}
            data-testid={`${testPrefix}-color`}
            data-color={c.id}
          >
            {c.label}
          </button>
        ))}
      </div>
      {scale !== 100 || shift !== 0 || color !== "auto" ? (
        <button
          type="button"
          className="justify-self-start text-[11.5px] text-muted underline hover:text-fg"
          onClick={() => onChange({ scale: 100, shift: 0, color: "auto" })}
          data-testid={`${testPrefix}-reset`}
        >
          {resetLabel}
        </button>
      ) : null}
    </div>
  );
}

/** The title design of the current cover: style, subtitle, tagline, cast names and credits, saved with the cover. */
function TitleDesign({
  slug,
  assetId,
  design,
  onChange,
  onDownload,
  castHint,
}: {
  slug: string;
  assetId: string;
  castHint: string;
  design: CoverDesign;
  onChange: (d: CoverDesign) => void;
  onDownload: () => void;
}) {
  const set = (patch: Partial<CoverDesign>) => onChange({ ...design, ...patch });
  return (
    <div className="space-y-2 rounded-[3px] border border-line p-2.5" data-testid="cover-design">
      <div className="font-medium">Title design</div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Title style">
        {COVER_STYLES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={design.style === s.id}
            title={s.hint}
            onClick={() => set({ style: s.id })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px]",
              design.style === s.id
                ? "border-accent bg-accent/10 text-fg"
                : "border-line text-muted hover:text-fg",
            )}
            data-testid="cover-style"
            data-style={s.id}
          >
            {s.label}
          </button>
        ))}
      </div>
      <Placement
        what="Title"
        testPrefix="cover-title"
        scale={design.titleScale}
        shift={design.titleShift}
        color={design.titleColor}
        scaleRange={COVER_TITLE_SCALE}
        shiftRange={COVER_TITLE_SHIFT}
        onChange={(p) =>
          set({
            ...(p.scale != null ? { titleScale: p.scale } : {}),
            ...(p.shift != null ? { titleShift: p.shift } : {}),
            ...(p.color != null ? { titleColor: p.color } : {}),
          })
        }
        resetLabel="Put the title back as the style has it"
      />
      <input
        value={design.subtitle}
        maxLength={COVER_TEXT_MAX.subtitle}
        onChange={(e) => set({ subtitle: e.target.value })}
        placeholder="Subtitle (optional), e.g. the English title"
        aria-label="Subtitle"
        data-testid="cover-subtitle"
      />
      <input
        value={design.tagline}
        maxLength={COVER_TEXT_MAX.tagline}
        onChange={(e) => set({ tagline: e.target.value })}
        placeholder="Tagline (optional), e.g. One proposal. No conditions."
        aria-label="Tagline"
        data-testid="cover-tagline"
      />
      <input
        value={design.castText}
        maxLength={COVER_TEXT_MAX.castText}
        onChange={(e) => set({ castText: e.target.value })}
        placeholder={`Cast line (optional), e.g. ${castHint || "Yumeko & Sean"}`}
        aria-label="Cast line"
        disabled={!design.showCast && !design.showCredits}
        data-testid="cover-cast-text"
      />
      {design.showCast ? (
        <Placement
          what="Cast"
          testPrefix="cover-cast"
          scale={design.castScale}
          shift={design.castShift}
          color={design.castColor}
          scaleRange={COVER_CAST_SCALE}
          shiftRange={COVER_CAST_SHIFT}
          onChange={(p) =>
            set({
              ...(p.scale != null ? { castScale: p.scale } : {}),
              ...(p.shift != null ? { castShift: p.shift } : {}),
              ...(p.color != null ? { castColor: p.color } : {}),
            })
          }
          resetLabel="Put the cast line back as the style has it"
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={design.showCast}
            onChange={(e) => set({ showCast: e.target.checked })}
            data-testid="cover-show-cast"
          />
          Cast names
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={design.showCredits}
            onChange={(e) => set({ showCredits: e.target.checked })}
            data-testid="cover-show-credits"
          />
          Credits block
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <ActionForm action={saveCoverDesign} quiet>
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="assetId" value={assetId} />
          <input type="hidden" name="design" value={JSON.stringify(design)} />
          <Button type="submit" size="sm" variant="primary" data-testid="cover-design-save">
            Save title design
          </Button>
        </ActionForm>
        <Button type="button" size="sm" onClick={onDownload} data-testid="cover-download">
          Download cover
        </Button>
      </div>
    </div>
  );
}

/**
 * Change the picture of the current cover: say what to change, see the price, confirm. The engine redraws this picture
 * with the change (same cast, same shape); the result is a new take, the cover itself is never changed.
 */
function EditPicture({
  slug,
  cover,
  working,
}: {
  slug: string;
  cover: NonNullable<CoverArtState["cover"]>;
  working: boolean;
}) {
  const engines = cover.editEngines.filter((e) => e.usd != null);
  const [engine, setEngine] = useState(engines[0]?.value ?? "");
  const [instruction, setInstruction] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const chosen = engines.find((e) => e.value === engine) ?? engines[0];
  const price = chosen?.usd != null ? (chosen.paid ? priceText(chosen.usd) : "free") : "";
  const refused = cover.editEngines.find((e) => e.usd == null)?.reason;
  return (
    <div className="space-y-2 rounded-[3px] border border-line p-2.5" data-testid="cover-edit">
      <div className="font-medium">Change the picture</div>
      {engines.length === 0 ? (
        <p className="text-warn" data-testid="cover-edit-unavailable">
          {refused ?? "No engine on this server can edit pictures."}
        </p>
      ) : (
        <>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            maxLength={MAX_EDIT_INSTRUCTION_CHARS}
            placeholder="What to change, e.g. Put them closer together under one umbrella; make it night with neon reflections on the wet street."
            aria-label="What to change in the picture"
            data-testid="cover-edit-instruction"
          />
          <div className="flex flex-wrap items-center gap-2">
            {engines.length > 1 ? (
              <select
                value={chosen?.value}
                onChange={(e) => setEngine(e.target.value)}
                aria-label="Engine for the edit"
                data-testid="cover-edit-engine"
              >
                {engines.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                    {e.paid ? "" : " (free)"}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={working || !instruction.trim()}
              onClick={() => setConfirming(true)}
              data-testid="cover-edit-make"
            >
              {working ? "Prism is working on a cover…" : "Change the picture…"}
            </Button>
            <span className="text-muted" data-testid="cover-edit-price">
              {price} with {chosen?.label}
            </span>
          </div>
          <p className="text-[11.5px] text-faint">
            The same people and shape; the change is made to this picture. It is added as a new take: your
            cover stays as it is until you choose Use as cover.
          </p>
        </>
      )}
      {confirming && chosen && chosen.usd != null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cover-edit-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          data-testid="cover-edit-confirm"
        >
          <div className="w-full max-w-md rounded-xl border border-line2 bg-panel p-5 shadow-2xl">
            <h2 id="cover-edit-confirm-title" className="text-[16px] font-semibold">
              Change the cover picture?
            </h2>
            <dl className="mt-3 space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Picture</dt>
                <dd>{cover.number != null ? `Take #${cover.number} (your cover)` : "Your cover"}</dd>
              </div>
              <div className="gap-4">
                <dt className="text-muted">Change</dt>
                <dd className="mt-0.5 whitespace-pre-wrap" data-testid="cover-edit-confirm-change">
                  {instruction.trim()}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Engine</dt>
                <dd>{chosen.label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Price</dt>
                <dd className="font-medium" data-testid="cover-edit-confirm-price">
                  {price}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-muted">
              One picture, added to the list.
              {chosen.paid ? " This is the price, charged when you press Change." : ""}
            </p>
            <ActionForm
              action={editCoverArt}
              successMessage=""
              className="mt-4 flex justify-end gap-2"
              onResult={(r) => {
                if (r.ok) {
                  setConfirming(false);
                  setInstruction("");
                  setKey(crypto.randomUUID());
                }
              }}
            >
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="sourceAssetId" value={cover.assetId} />
              <input type="hidden" name="model" value={chosen.value} />
              <input type="hidden" name="instruction" value={instruction} />
              <input type="hidden" name="idempotencyKey" value={key} />
              {chosen.paid ? (
                <input type="hidden" name="confirmedTotalUsd" value={chosen.usd.toFixed(4)} />
              ) : null}
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" data-testid="cover-edit-go">
                Change · {price}
              </Button>
            </ActionForm>
          </div>
        </div>
      ) : null}
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
  initialDirection = "",
}: {
  slug: string;
  title: string;
  state: CoverArtState;
  /** a description written before arriving (the front page's cover box) */
  initialDirection?: string;
  /** Start from a prompt: the current cover and the maker only, newest takes in a short row */
  compact?: boolean;
}) {
  const engines = state.engines;
  const [engine, setEngine] = useState(engines.find((e) => !e.paid)?.value ?? engines[0]?.value ?? "");
  const chosen = engines.find((e) => e.value === engine);
  const [ratio, setRatio] = useState(chosen?.shapes[0]?.ratio ?? "2:3");
  const shape = chosen?.shapes.find((s) => s.ratio === ratio) ?? chosen?.shapes[0];
  const [direction, setDirection] = useState(initialDirection);
  const [cast, setCast] = useState<string[]>(() => state.characters.filter((c) => c.chosen).map((c) => c.id));
  const [locationId, setLocationId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const working = state.takes.some(
    (t) => t.status !== "succeeded" && t.status !== "failed" && t.status !== "cancelled",
  );
  const price = shape?.usd != null ? (chosen?.paid ? priceText(shape.usd) : "free") : "";
  const takes = compact ? state.takes.slice(0, 4) : state.takes;
  // the title design being edited (saved with the cover): edits hold until the saved design or the cover changes
  const saved = state.cover?.design ?? DEFAULT_COVER_DESIGN;
  const savedKey = `${state.cover?.assetId ?? ""}|${JSON.stringify(saved)}`;
  const [edit, setEdit] = useState<{ key: string; design: CoverDesign } | null>(null);
  const design = edit && edit.key === savedKey ? edit.design : saved;
  const setDesign = (d: CoverDesign) => setEdit({ key: savedKey, design: d });
  const textOf = (castNames: string[]): CoverText => ({ title, cast: castNames, kindLine: state.kindLine });

  return (
    <div className="space-y-3 text-[12.5px]" data-testid="cover-art">
      <RefreshWhileActive active={working} intervalMs={1500} />
      <div className={cn("grid gap-4", compact ? "sm:grid-cols-[160px_1fr]" : "md:grid-cols-[320px_1fr]")}>
        {/* the cover stays in view beside its controls while the page scrolls */}
        <div className={cn(!compact && "md:sticky md:top-4 md:self-start")}>
          {state.cover ? (
            <>
              <CoverWithTitle
                url={state.cover.url}
                design={design}
                text={textOf(state.cover.cast)}
                width={state.cover.width}
                height={state.cover.height}
                testId="cover-current"
                onMove={
                  compact
                    ? undefined
                    : (which, shift) =>
                        setDesign(
                          which === "title"
                            ? { ...design, titleShift: shift }
                            : { ...design, castShift: shift },
                        )
                }
              />
              {compact ? null : (
                <p className="mt-1.5 text-[11.5px] text-faint">
                  Drag the title or the cast names up or down; click the cover to see it large.
                </p>
              )}
            </>
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
          {state.cover && !compact ? (
            <div className="grid gap-2 xl:grid-cols-2 xl:items-start">
              <TitleDesign
                slug={slug}
                assetId={state.cover.assetId}
                castHint={state.cover.cast.join(" & ")}
                design={design}
                onChange={setDesign}
                onDownload={() =>
                  state.cover?.url &&
                  void downloadCover(state.cover.url, design, textOf(state.cover.cast), slug)
                }
              />
              <EditPicture slug={slug} cover={state.cover} working={working} />
            </div>
          ) : null}
          {state.cover && !compact ? (
            <div className="pt-2 font-medium" data-testid="cover-make-new">
              Make a new cover
            </div>
          ) : null}
          <p className="text-muted">
            Prism makes a poster from the title, premise, tone and look of your project, with the actors and
            place you choose: each one&apos;s main picture is sent so faces and the place match. The picture
            has no lettering; the title is laid over it.
          </p>
          {state.characters.length ? (
            <fieldset data-testid="cover-cast">
              <legend className="mb-1 text-muted">
                Actors (up to {state.castMax}; {cast.length} chosen)
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
                    design={design}
                    text={textOf(t.cast)}
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
                  {t.editOf ? (
                    <span title={t.editOf.instruction} data-testid="cover-take-edit-of">
                      · edit of {t.editOf.number != null ? `#${t.editOf.number}` : "an earlier take"}
                    </span>
                  ) : null}
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
