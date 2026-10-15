import type { Rect } from "@/domain/framing/crop";

/**
 * Planning overlay: the full PROVIDER canvas with the PRODUCTION crop box inside it, the discarded regions
 * hatched, safe-area guides and centre lines. "Only this region survives final delivery."
 *
 * Presentation only: every number comes from the GenerationAdaptationPlan; this component decides nothing.
 * The production frame stays production-shaped everywhere else in the app; the provider canvas appears only
 * in execution/adaptation contexts like this one.
 */

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

const HATCH = "repeating-linear-gradient(135deg, rgba(8,8,10,0.62) 0 6px, rgba(8,8,10,0.38) 6px 12px)";

function boxStyle(r: Rect) {
  return { left: pct(r.x), top: pct(r.y), width: pct(r.width), height: pct(r.height) };
}

export interface FrameOverlayProps {
  /** width / height of the provider canvas (the outer frame). */
  providerRatio: number;
  /** Surviving region as 0..1 fractions of the provider canvas (crop strategies). */
  retained: Rect | null;
  safeArea?: { action: Rect; title: Rect } | null;
  /** Letterbox/pillarbox: the provider picture is padded into a production-shaped frame instead. */
  pad?: { mode: "letterbox" | "pillarbox"; barFraction: number } | null;
  productionRatio?: number | null;
  productionLabel: string | null;
  providerLabel: string | null;
  canvas?: { width: number; height: number } | null;
  /** Optional picture (approved storyboard frame, a review frame...). */
  imageUrl?: string | null;
  showGuides?: boolean;
  className?: string;
  testId?: string;
}

export function FrameOverlay(props: FrameOverlayProps) {
  const { retained, pad, productionLabel, providerLabel, imageUrl } = props;
  const guides = props.showGuides ?? true;

  // Letterbox / pillarbox: outer frame is the PRODUCTION frame; the provider picture sits inside it.
  if (pad && props.productionRatio) {
    const picture =
      pad.mode === "letterbox"
        ? { left: "0%", top: pct(pad.barFraction / 2), width: "100%", height: pct(1 - pad.barFraction) }
        : { left: pct(pad.barFraction / 2), top: "0%", width: pct(1 - pad.barFraction), height: "100%" };
    return (
      <figure className={props.className} data-testid={props.testId ?? "frame-overlay"} data-mode={pad.mode}>
        <div
          className="relative w-full overflow-hidden border border-line2 bg-black"
          style={{ aspectRatio: String(props.productionRatio) }}
        >
          <div className="absolute overflow-hidden bg-panel2" style={picture}>
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="" className="h-full w-full object-cover" />
            ) : null}
          </div>
          <span className="absolute left-1.5 top-1.5 bg-black/70 px-1 font-mono text-[10px] text-fg">
            Production frame {productionLabel} · {pad.mode} · provider canvas {providerLabel}
          </span>
        </div>
        <figcaption className="mt-1 text-[11px] text-muted">
          Whole {providerLabel} picture kept; {(pad.barFraction * 100).toFixed(1)}% of the frame is bars.
        </figcaption>
      </figure>
    );
  }

  return (
    <figure className={props.className} data-testid={props.testId ?? "frame-overlay"} data-mode="crop">
      <div
        className="relative w-full overflow-hidden border border-line2 bg-panel2"
        style={{ aspectRatio: String(props.providerRatio) }}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
        {retained ? (
          <>
            {/* discard regions: top, bottom, left, right */}
            <div
              data-testid="discard-region"
              className="absolute left-0 right-0 top-0"
              style={{ height: pct(retained.y), background: HATCH }}
            />
            <div
              data-testid="discard-region"
              className="absolute bottom-0 left-0 right-0"
              style={{ height: pct(1 - retained.y - retained.height), background: HATCH }}
            />
            <div
              data-testid="discard-region"
              className="absolute left-0"
              style={{
                top: pct(retained.y),
                height: pct(retained.height),
                width: pct(retained.x),
                background: HATCH,
              }}
            />
            <div
              data-testid="discard-region"
              className="absolute right-0"
              style={{
                top: pct(retained.y),
                height: pct(retained.height),
                width: pct(1 - retained.x - retained.width),
                background: HATCH,
              }}
            />
            <div
              data-testid="protected-crop"
              className="absolute border-2 border-accent"
              style={boxStyle(retained)}
            >
              {guides && props.safeArea ? (
                <>
                  <div
                    className="absolute border border-dashed border-pass/70"
                    style={{
                      left: pct((props.safeArea.action.x - retained.x) / retained.width),
                      top: pct((props.safeArea.action.y - retained.y) / retained.height),
                      width: pct(props.safeArea.action.width / retained.width),
                      height: pct(props.safeArea.action.height / retained.height),
                    }}
                    title="Action safe"
                  />
                  <div
                    className="absolute border border-dashed border-warn/70"
                    style={{
                      left: pct((props.safeArea.title.x - retained.x) / retained.width),
                      top: pct((props.safeArea.title.y - retained.y) / retained.height),
                      width: pct(props.safeArea.title.width / retained.width),
                      height: pct(props.safeArea.title.height / retained.height),
                    }}
                    title="Title safe"
                  />
                </>
              ) : null}
              {guides ? (
                <>
                  <div className="absolute left-1/2 top-0 h-full w-px bg-white/25" />
                  <div className="absolute left-0 top-1/2 h-px w-full bg-white/25" />
                </>
              ) : null}
              <span className="absolute left-1 top-1 bg-black/70 px-1 font-mono text-[10px] text-accent">
                Protected crop · {productionLabel}
              </span>
            </div>
          </>
        ) : null}
        <span className="absolute bottom-1 right-1 bg-black/70 px-1 font-mono text-[10px] text-muted">
          Provider canvas · {providerLabel}
          {props.canvas ? ` ${props.canvas.width}×${props.canvas.height}` : ""}
        </span>
      </div>
      <figcaption className="mt-1 text-[11px] text-muted">
        {retained
          ? `Only the ${productionLabel} protected crop survives final delivery; hatched regions are discarded.`
          : "No crop: the provider canvas is the production frame."}
      </figcaption>
    </figure>
  );
}
