"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Kbd } from "@/components/ui";
import { describeDims } from "./output-dims";
import {
  NEGATIVE_LABELS,
  NEGATIVE_TAGS,
  POSITIVE_LABELS,
  POSITIVE_TAGS,
  QUICK_REJECT_REASONS,
  type NegativeTag,
  type PositiveTag,
  type ReviewDecision,
} from "@/domain/generation/reviews";
import { markBest, promoteCandidate, reviewCandidate } from "@/server/candidate-actions";
import { createDeliveryConform } from "@/server/media-actions";
import { chooseGeneratedFrameAsProductionFrame } from "@/server/production-frame-actions";

/**
 * The comparison workspace: 2-up / 3-up / grid, synchronized start/pause/seek/loop, audio solo, same-position
 * frame comparison, fast human review (buttons AND keys 1/2/3/B) and an explicit "Promote to Shot".
 * Videos load lazily and pause when off-screen; nothing is preloaded in bulk.
 *
 * Phase 2G.2: a Production Frame candidate set (`purpose="production_frame"`) is an IMAGE review surface: large
 * stills, no playback controls, the same Good / Shortlist / Best / Reject review, and "Use as Production Frame"
 * instead of "Promote to Shot". Best (this experiment's preference) and CURRENT PRODUCTION FRAME (the Shot's
 * canonical visual) are separate on purpose.
 */

/** What "Use as Production Frame" can do for one candidate right now (computed on the server). */
export interface BoardProductionFrame {
  available: boolean;
  /** Why not, in plain language (null when available). */
  reason: string | null;
  /** The candidate's own image is not production-shaped and no conform exists yet. */
  needsConform: boolean;
  /** The Shot changed after this candidate was generated. */
  stale: boolean;
  /** This candidate is the source of the Shot's currently selected Production Frame. */
  current: boolean;
  /** Which stored image would become the frame. */
  image: "delivery_conform" | "provider_original" | null;
}
export interface BoardCandidate {
  attemptId: string;
  label: string;
  attemptNumber: number | null;
  providerName: string;
  modelLabel: string;
  modelId: string;
  /** "succeeded" | "failed" | "cancelled" | "queued" | "running" | "not_submitted" */
  status: string;
  statusNote: string;
  videoUrl: string | null;
  /** Still-image candidates: the image shown (the production conform when one is selected, else the original). */
  imageUrl?: string | null;
  /** Still-image candidates: quality requested (null = the model has none). */
  quality?: string | null;
  /** Still-image candidates only. */
  productionFrame?: BoardProductionFrame | null;
  posterUrl: string | null;
  frames: Array<{ atMs: number; url: string }>;
  durationMs: number | null;
  /** Dimensions of the stored provider output asset, when recorded. */
  resolution: string | null;
  /** Requested provider canvas from the frozen request, when it carries one. */
  providerCanvas: string | null;
  /** Dimensions of the conformed delivery master (only when it is not the provider original). */
  deliveryResolution: string | null;
  deliveryNote: string;
  estimateUsd: number | null;
  actualUsd: number | null;
  currency: string;
  generationMs: number | null;
  totalMs: number | null;
  adaptations: string[];
  referencesUsed: string;
  inputMode: string | null;
  tier: string | null;
  nativeAudio: boolean;
  review: {
    decision: ReviewDecision;
    negativeTags: NegativeTag[];
    positiveTags: PositiveTag[];
    notes: string;
    reviewedAt: string;
  } | null;
  reviewCount: number;
  preferred: boolean;
  promoted: boolean;
  free: boolean;
  /** Link to the continuity/QA page (extract frames, optional AI check). */
  detailHref: string | null;
}

type Layout = "2" | "3" | "grid";

const money = (n: number | null, c = "USD") =>
  n == null ? "—" : `${c === "USD" ? "$" : ""}${n.toFixed(n < 1 ? 3 : 2)}`;
const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(1)} s`);

function LazyVideo({
  src,
  poster,
  label,
  registerRef,
  onSize,
}: {
  src: string;
  poster: string | null;
  label: string;
  registerRef: (el: HTMLVideoElement | null) => void;
  onSize?: (width: number, height: number) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          setVisible(e.isIntersecting);
          if (!e.isIntersecting && !el.paused) el.pause(); // off-screen videos never keep playing
        }
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <video
      ref={(el) => {
        ref.current = el;
        registerRef(el);
      }}
      src={visible ? src : undefined}
      poster={poster ?? undefined}
      preload={visible ? "metadata" : "none"}
      muted
      playsInline
      controls={false}
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        if (v.videoWidth > 0 && v.videoHeight > 0) onSize?.(v.videoWidth, v.videoHeight);
      }}
      aria-label={`Candidate ${label} video`}
      className="aspect-video w-full bg-black object-contain"
      data-testid="candidate-video"
    />
  );
}

export function CandidateBoard({
  projectSlug,
  setId,
  candidates,
  canPromote,
  purpose = "shot_output",
  shotId = "",
}: {
  projectSlug: string;
  setId: string;
  candidates: BoardCandidate[];
  canPromote: boolean;
  /** `production_frame`: still images for the Shot's Production Frame (an image review surface). */
  purpose?: "shot_output" | "production_frame";
  shotId?: string;
}) {
  const still = purpose === "production_frame";
  const [layout, setLayout] = useState<Layout>(candidates.length >= 3 ? "3" : "2");
  const videos = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [loop, setLoop] = useState(true);
  const [solo, setSolo] = useState<string>("");
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [framePct, setFramePct] = useState<number | null>(null);
  const maxMs = Math.max(1000, ...candidates.map((c) => c.durationMs ?? 0));

  const each = useCallback((fn: (v: HTMLVideoElement, id: string) => void) => {
    videos.current.forEach((v, id) => fn(v, id));
  }, []);

  const seekAll = useCallback(
    (fraction: number) => {
      const f = Math.min(1, Math.max(0, fraction));
      setPos(f);
      each((v) => {
        if (Number.isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration * f;
      });
    },
    [each],
  );

  const playAll = useCallback(() => {
    each((v) => void v.play().catch(() => undefined));
    setPlaying(true);
  }, [each]);
  const pauseAll = useCallback(() => {
    each((v) => v.pause());
    setPlaying(false);
  }, [each]);

  useEffect(() => {
    each((v, id) => {
      v.muted = solo !== id;
      v.loop = loop;
    });
  }, [solo, loop, each, candidates]);

  // keep the slider in step with the first playing video
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const first = [...videos.current.values()].find((v) => Number.isFinite(v.duration) && v.duration > 0);
      if (first) setPos(first.currentTime / first.duration);
    }, 200);
    return () => clearInterval(t);
  }, [playing]);

  const grid =
    layout === "2" ? "md:grid-cols-2" : layout === "3" ? "md:grid-cols-3" : "md:grid-cols-2 xl:grid-cols-3";
  const withVideo = candidates.filter((c) => c.videoUrl);

  const layoutPicker = (
    <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
      layout
      {(["2", "3", "grid"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLayout(l)}
          aria-pressed={layout === l}
          data-testid={`layout-${l}`}
          className={`rounded-[3px] border px-1.5 py-0.5 ${layout === l ? "border-accent text-fg" : "border-line2"}`}
        >
          {l === "grid" ? "grid" : `${l}-up`}
        </button>
      ))}
    </span>
  );

  if (still) {
    return (
      <div className="space-y-3" data-testid="candidate-board" data-purpose="production_frame">
        <div className="flex flex-wrap items-center gap-2 border border-line bg-panel px-3 py-2 text-[11px] text-muted">
          <span className="font-semibold uppercase tracking-wide">Production Frame candidates</span>
          <span>
            ⭐ Best is this experiment&apos;s preference. &quot;Use as Production Frame&quot; is a separate,
            explicit choice.
          </span>
          {layoutPicker}
        </div>
        <div className={`grid gap-3 ${grid}`}>
          {candidates.map((c) => (
            <CandidateCard
              key={c.attemptId}
              c={c}
              projectSlug={projectSlug}
              setId={setId}
              shotId={shotId}
              canPromote={canPromote}
              still
              register={() => undefined}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="candidate-board">
      <div
        className="flex flex-wrap items-center gap-2 border border-line bg-panel px-3 py-2"
        data-testid="sync-controls"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Playback (all)</span>
        <Button
          size="sm"
          onClick={playing ? pauseAll : playAll}
          disabled={withVideo.length === 0}
          data-testid="sync-play"
        >
          {playing ? "Pause all" : "Play all"}
        </Button>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(pos * 1000)}
          onChange={(e) => seekAll(Number(e.target.value) / 1000)}
          aria-label="Seek all candidates"
          data-testid="sync-seek"
          className="!w-56"
        />
        <span className="text-[11px] tabular-nums text-muted">{secs(pos * maxMs)}</span>
        <label className="flex items-center gap-1 text-[11px] text-muted">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
        </label>
        <label className="flex items-center gap-1 text-[11px] text-muted">
          audio
          <select
            value={solo}
            onChange={(e) => setSolo(e.target.value)}
            aria-label="Audio solo"
            className="!w-auto"
          >
            <option value="">muted</option>
            {candidates.map((c) => (
              <option key={c.attemptId} value={c.attemptId} disabled={!c.videoUrl}>
                solo {c.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
          layout
          {(["2", "3", "grid"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              aria-pressed={layout === l}
              data-testid={`layout-${l}`}
              className={`rounded-[3px] border px-1.5 py-0.5 ${layout === l ? "border-accent text-fg" : "border-line2"}`}
            >
              {l === "grid" ? "grid" : `${l}-up`}
            </button>
          ))}
        </span>
      </div>

      <div
        className="flex flex-wrap items-center gap-2 text-[11px] text-muted"
        data-testid="frame-compare-controls"
      >
        <span className="font-semibold uppercase tracking-wide">Same position</span>
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => {
              pauseAll();
              seekAll(p);
              setFramePct(p);
            }}
            className={`rounded-[3px] border px-1.5 py-0.5 ${framePct === p ? "border-accent text-fg" : "border-line2"}`}
            data-testid={`frame-at-${Math.round(p * 100)}`}
          >
            {Math.round(p * 100)}%
          </button>
        ))}
        <span className="text-faint">
          Pauses every candidate at the same point (identity · wardrobe · set · composition).
        </span>
      </div>

      <div className={`grid gap-3 ${grid}`}>
        {candidates.map((c) => (
          <CandidateCard
            key={c.attemptId}
            c={c}
            projectSlug={projectSlug}
            setId={setId}
            canPromote={canPromote}
            register={(el) => {
              if (el) videos.current.set(c.attemptId, el);
              else videos.current.delete(c.attemptId);
            }}
          />
        ))}
      </div>

      <FrameStrip candidates={candidates} pct={framePct} />
    </div>
  );
}

function FrameStrip({ candidates, pct }: { candidates: BoardCandidate[]; pct: number | null }) {
  const withFrames = candidates.filter((c) => c.frames.length > 0);
  const at = pct ?? 0.5;
  if (withFrames.length === 0) {
    return (
      <div
        className="border border-dashed border-line2 p-2 text-[11px] text-faint"
        data-testid="no-review-frames"
      >
        No review frames have been extracted for these candidates yet. Open a candidate&apos;s review (free,
        deterministic QA) to extract them; the same-position buttons above work from the videos meanwhile.
      </div>
    );
  }
  return (
    <div className="space-y-1" data-testid="frame-strip">
      <div className="text-[10.5px] uppercase tracking-wide text-muted">
        Extracted review frames at ~{Math.round(at * 100)}%
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {withFrames.map((c) => {
          const total = c.durationMs ?? Math.max(...c.frames.map((f) => f.atMs), 1);
          const target = at * total;
          const nearest = [...c.frames].sort(
            (a, b) => Math.abs(a.atMs - target) - Math.abs(b.atMs - target),
          )[0]!;
          return (
            <figure key={c.attemptId} className="border border-line bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={nearest.url}
                alt={`Candidate ${c.label} at ${secs(nearest.atMs)}`}
                className="w-full"
              />
              <figcaption className="px-1.5 py-1 text-[10.5px] text-muted">
                {c.label} · {c.modelLabel} · {secs(nearest.atMs)}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}

const DECISION_TONE: Record<ReviewDecision, "pass" | "warn" | "fail" | "neutral"> = {
  approve: "pass",
  shortlist: "warn",
  reject: "fail",
  unreviewed: "neutral",
};
const DECISION_TEXT: Record<ReviewDecision, string> = {
  approve: "Good",
  shortlist: "Shortlisted",
  reject: "Rejected",
  unreviewed: "Unreviewed",
};

function CandidateCard({
  c,
  projectSlug,
  setId,
  canPromote,
  register,
  still = false,
  shotId = "",
}: {
  c: BoardCandidate;
  projectSlug: string;
  setId: string;
  canPromote: boolean;
  register: (el: HTMLVideoElement | null) => void;
  still?: boolean;
  shotId?: string;
}) {
  const noun = still ? "image" : "clip";
  const pf = c.productionFrame ?? null;
  const [rejecting, setRejecting] = useState(false);
  const [measured, setMeasured] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const reviewable = c.status === "succeeded";
  const decision = c.review?.decision ?? "unreviewed";

  const click = (action: string) => {
    const el = root.current?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    el?.click();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    if (!reviewable) return;
    if (e.key === "1") click("approve");
    else if (e.key === "2") click("shortlist");
    else if (e.key === "3") setRejecting(true);
    else if (e.key.toLowerCase() === "b") click("best");
    else if (e.key === "Escape") setRejecting(false);
  };

  const dims = describeDims({
    recorded: c.resolution,
    measured,
    requestedCanvas: c.providerCanvas,
    deliveryResolution: c.deliveryResolution,
    deliveryNote: c.deliveryNote,
  });

  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="attemptId" value={c.attemptId} />
      <input type="hidden" name="setId" value={setId} />
    </>
  );

  return (
    <div
      ref={root}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={
        reviewable
          ? `Candidate ${c.label}: ${c.modelLabel}. Keys: 1 good, 2 shortlist, 3 reject, B best.`
          : `Candidate ${c.label}: ${c.modelLabel}. No ${noun} to review (${c.status.replace(/_/g, " ")}).`
      }
      className={`space-y-2 border bg-panel p-2.5 outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        c.promoted ? "border-pass" : c.preferred ? "border-accent" : "border-line"
      }`}
      data-testid="candidate-card"
      data-label={c.label}
      data-model={c.modelId}
      data-status={c.status}
      data-decision={decision}
      data-preferred={c.preferred ? "1" : "0"}
      data-promoted={c.promoted ? "1" : "0"}
      data-current-frame={pf?.current ? "1" : "0"}
      data-stale={pf?.stale ? "1" : "0"}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-[3px] bg-panel2 px-1.5 text-[12px] font-semibold">{c.label}</span>
        <span className="font-medium">{c.modelLabel}</span>
        <span className="text-[11px] text-muted">{c.providerName}</span>
        <Badge
          tone={
            c.status === "succeeded"
              ? "pass"
              : c.status === "failed" || c.status === "not_submitted"
                ? "fail"
                : "info"
          }
        >
          {c.status.replace(/_/g, " ")}
        </Badge>
        {c.preferred ? <Badge tone="accent">Best</Badge> : null}
        {c.promoted ? <Badge tone="pass">Promoted to shot</Badge> : null}
        {pf?.current ? (
          <span data-testid="current-production-frame">
            <Badge tone="pass">CURRENT PRODUCTION FRAME</Badge>
          </span>
        ) : null}
        {still && reviewable && pf?.stale ? (
          <span data-testid="candidate-stale">
            <Badge tone="warn">STALE</Badge>
          </span>
        ) : null}
        {reviewable ? <Badge tone={DECISION_TONE[decision]}>{DECISION_TEXT[decision]}</Badge> : null}
      </div>

      {still ? (
        c.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={c.imageUrl}
            alt={`Candidate ${c.label} (${c.modelLabel})`}
            loading="lazy"
            className="max-h-[70vh] w-full border border-line bg-black object-contain"
            data-testid="candidate-image"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center border border-dashed border-line2 text-[11.5px] text-muted">
            {c.status === "failed" || c.status === "not_submitted"
              ? c.statusNote || "This candidate did not produce an image."
              : c.status === "cancelled"
                ? "Cancelled"
                : "Generating…"}
          </div>
        )
      ) : c.videoUrl ? (
        <LazyVideo
          src={c.videoUrl}
          poster={c.posterUrl}
          label={c.label}
          registerRef={register}
          onSize={(w, h) => setMeasured(`${w}×${h}`)}
        />
      ) : (
        <div className="flex aspect-video items-center justify-center border border-dashed border-line2 text-[11.5px] text-muted">
          {c.status === "failed" || c.status === "not_submitted"
            ? c.statusNote || "This candidate did not produce a video."
            : c.status === "cancelled"
              ? "Cancelled"
              : "Generating…"}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]" data-testid="candidate-meta">
        <dt className="text-muted">Cost</dt>
        <dd className="tabular-nums">
          {c.free
            ? "free (mock)"
            : `est ${money(c.estimateUsd, c.currency)} · actual ${money(c.actualUsd, c.currency)}`}
        </dd>
        {still ? null : (
          <>
            <dt className="text-muted">Duration</dt>
            <dd>{secs(c.durationMs)}</dd>
          </>
        )}
        {still && c.quality ? (
          <>
            <dt className="text-muted">Quality</dt>
            <dd data-testid="candidate-quality">{c.quality}</dd>
          </>
        ) : null}
        <dt className="text-muted">Actual output</dt>
        <dd data-testid="dims-actual">{dims.actualOutput}</dd>
        <dt className="text-muted">Provider canvas</dt>
        <dd data-testid="dims-canvas">{dims.providerCanvas}</dd>
        <dt className="text-muted">Delivery</dt>
        <dd data-testid="dims-delivery">{dims.delivery}</dd>
        <dt className="text-muted">Generation / total</dt>
        <dd className="tabular-nums">
          {secs(c.generationMs)} / {secs(c.totalMs)}
        </dd>
        <dt className="text-muted">References</dt>
        <dd>
          {c.referencesUsed}
          {c.inputMode ? ` · ${c.inputMode}` : ""}
          {c.tier && !still ? ` · ${c.tier}` : ""}
          {c.nativeAudio ? " · provider audio" : ""}
        </dd>
      </dl>
      {c.adaptations.length > 0 ? (
        <div className="text-[10.5px] text-warn">{c.adaptations.join(" · ")}</div>
      ) : null}
      {c.review && (c.review.negativeTags.length > 0 || c.review.positiveTags.length > 0) ? (
        <div className="flex flex-wrap gap-1" data-testid="review-tags">
          {c.review.negativeTags.map((t) => (
            <Badge key={t} tone="fail">
              {NEGATIVE_LABELS[t]}
            </Badge>
          ))}
          {c.review.positiveTags.map((t) => (
            <Badge key={t} tone="pass">
              {POSITIVE_LABELS[t]}
            </Badge>
          ))}
        </div>
      ) : null}

      {reviewable ? (
        <div className="space-y-1.5 border-t border-line pt-2" data-testid="review-controls">
          <div className="flex flex-wrap items-center gap-1.5">
            <ActionForm action={reviewCandidate} quiet successMessage="" className="contents">
              {hidden}
              <input type="hidden" name="decision" value="approve" />
              <Button
                size="sm"
                type="submit"
                data-action="approve"
                data-testid="review-good"
                title="Good (1)"
              >
                👍 Good
              </Button>
            </ActionForm>
            <ActionForm action={reviewCandidate} quiet successMessage="" className="contents">
              {hidden}
              <input type="hidden" name="decision" value="shortlist" />
              <Button
                size="sm"
                type="submit"
                data-action="shortlist"
                data-testid="review-shortlist"
                title="Shortlist (2)"
              >
                Shortlist
              </Button>
            </ActionForm>
            <ActionForm action={markBest} quiet successMessage="" className="contents">
              {hidden}
              {c.preferred ? <input type="hidden" name="clear" value="1" /> : null}
              <Button size="sm" type="submit" data-action="best" data-testid="review-best" title="Best (B)">
                {c.preferred ? "★ Best (clear)" : "⭐ Best"}
              </Button>
            </ActionForm>
            <Button
              size="sm"
              variant="danger"
              type="button"
              data-action="reject"
              data-testid="review-reject"
              title="Reject (3)"
              onClick={() => setRejecting((v) => !v)}
              aria-expanded={rejecting}
            >
              👎 Reject
            </Button>
          </div>

          {rejecting ? (
            <div className="space-y-1.5" data-testid="reject-picker">
              <div className="flex flex-wrap gap-1.5">
                {QUICK_REJECT_REASONS.map((r) => (
                  <ActionForm
                    key={r.tag}
                    action={reviewCandidate}
                    quiet
                    successMessage=""
                    className="contents"
                  >
                    {hidden}
                    <input type="hidden" name="decision" value="reject" />
                    <input type="hidden" name="negative" value={r.tag} />
                    <Button size="sm" type="submit" data-testid={`reject-${r.tag}`}>
                      {r.label}
                    </Button>
                  </ActionForm>
                ))}
                <button
                  type="button"
                  className="text-[11px] text-muted underline"
                  onClick={() => setMore((v) => !v)}
                >
                  {more ? "fewer" : "more reasons…"}
                </button>
              </div>
              {more ? (
                <ActionForm action={reviewCandidate} quiet successMessage="" className="space-y-1.5">
                  {hidden}
                  <input type="hidden" name="decision" value="reject" />
                  <div className="grid grid-cols-2 gap-x-3 text-[11px]">
                    {NEGATIVE_TAGS.map((t) => (
                      <label key={t} className="flex items-center gap-1">
                        <input type="checkbox" name="negative" value={t} /> {NEGATIVE_LABELS[t]}
                      </label>
                    ))}
                  </div>
                  <input name="notes" placeholder="Short note (optional)" aria-label="Note" />
                  <Button size="sm" type="submit" variant="danger">
                    Reject with these reasons
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          ) : null}

          <details className="text-[11px] text-muted">
            <summary className="cursor-pointer">What was good? (optional)</summary>
            <ActionForm action={reviewCandidate} quiet successMessage="" className="mt-1 space-y-1.5">
              {hidden}
              <input type="hidden" name="decision" value="approve" />
              <div className="grid grid-cols-2 gap-x-3">
                {POSITIVE_TAGS.map((t) => (
                  <label key={t} className="flex items-center gap-1">
                    <input type="checkbox" name="positive" value={t} /> {POSITIVE_LABELS[t]}
                  </label>
                ))}
              </div>
              <Button size="sm" type="submit">
                Save as good
              </Button>
            </ActionForm>
          </details>

          {still ? (
            <div className="space-y-1 pt-1" data-testid="use-as-production-frame">
              <ActionForm
                action={chooseGeneratedFrameAsProductionFrame}
                quiet={false}
                successMessage="Production Frame saved"
                className="flex items-center gap-2"
              >
                <input type="hidden" name="projectSlug" value={projectSlug} />
                <input type="hidden" name="shotId" value={shotId} />
                <input type="hidden" name="attemptId" value={c.attemptId} />
                <Button
                  size="sm"
                  variant="primary"
                  type="submit"
                  disabled={!pf?.available}
                  data-testid="use-as-pf"
                >
                  {pf?.current ? "Current Production Frame" : "Use as Production Frame"}
                </Button>
              </ActionForm>
              {pf && !pf.available && pf.reason ? (
                <div
                  className={`text-[11px] ${pf.stale ? "text-warn" : "text-muted"}`}
                  data-testid="pf-unavailable-reason"
                >
                  {pf.reason}
                </div>
              ) : null}
              {pf?.needsConform ? (
                <ActionForm
                  action={createDeliveryConform}
                  quiet={false}
                  successMessage="Production conform created"
                  className="flex items-center gap-2"
                >
                  <input type="hidden" name="projectSlug" value={projectSlug} />
                  <input type="hidden" name="attemptId" value={c.attemptId} />
                  <Button size="sm" type="submit" data-testid="create-production-conform">
                    Create production conform
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          ) : canPromote ? (
            <ActionForm
              action={promoteCandidate}
              quiet={false}
              successMessage="Promoted to shot"
              confirmMessage={`Promote candidate ${c.label} (${c.modelLabel}) to the shot? This approves it as the shot's output; the other candidates are kept.`}
              className="pt-1"
            >
              {hidden}
              <input type="hidden" name="confirm" value="1" />
              <Button size="sm" variant="primary" type="submit" disabled={c.promoted} data-testid="promote">
                {c.promoted ? "Promoted" : "Promote to Shot"}
              </Button>
            </ActionForm>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between text-[10.5px] text-faint">
        <span>
          {!reviewable
            ? `No ${noun} to review`
            : c.reviewCount > 0
              ? `${c.reviewCount} review(s) in history`
              : "No review yet"}
          {reviewable ? (
            <>
              {" · "}
              <Kbd>1</Kbd> good <Kbd>2</Kbd> shortlist <Kbd>3</Kbd> reject <Kbd>B</Kbd> best
            </>
          ) : null}
        </span>
        {c.detailHref && !still ? (
          <a className="underline" href={c.detailHref}>
            Open review
          </a>
        ) : null}
      </div>
    </div>
  );
}
