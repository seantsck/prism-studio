/**
 * What a candidate card says about picture size. Five different things that must not be conflated:
 *
 *   production frame   what the filmmaker designed (the Shot's aspect; shown elsewhere)
 *   planning canvas    generic geometry the compatibility/adaptation PLAN used ("1920×822"); a plan, not a request
 *   requested canvas   what Prism ACTUALLY sent to the provider, read from the frozen provider provenance of the
 *                      stored output ("2048×880"). Never recomputed from today's catalog, never borrowed from the plan.
 *                      Some model families take an aspect label and/or a resolution tier instead of pixels: that is
 *                      what is shown, and no pixel size is manufactured.
 *   actual output      the stored provider file's dimensions (probed at ingest), else read from the file in the
 *                      browser, else unknown. Never copied from the request.
 *   delivery           the master Prism delivers when it differs from the provider original.
 */

/** What a provider was actually asked for, as frozen in the output's provider provenance. */
export interface FrozenProviderRequest {
  /** Exact pixel canvas sent ("2048×880"), when the request carried one. */
  canvas: string | null;
  /** Aspect label sent instead of pixels ("16:9"), when that is what the provider takes. */
  ratioLabel: string | null;
  /** Resolution tier sent ("768p"), when the provider takes a tier. */
  tier: string | null;
}

const PIXELS = /^(\d{2,5}):(\d{2,5})$/;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Reads the frozen request geometry from an output's provenance (`provenance.provider.settings`, written when the
 * provider result was ingested). Null when the provenance records no settings at all (older attempts, or an output
 * that does not exist yet): the caller then says "unknown" and never substitutes the planning canvas.
 */
export function frozenProviderRequest(outputProvenance: unknown): FrozenProviderRequest | null {
  const settings = (outputProvenance as { provider?: { settings?: Record<string, unknown> } } | null)
    ?.provider?.settings;
  if (!settings || typeof settings !== "object") return null;
  const pc = settings.providerCanvas as { width?: unknown; height?: unknown } | null | undefined;
  let canvas: string | null = null;
  if (pc && typeof pc.width === "number" && typeof pc.height === "number")
    canvas = `${pc.width}×${pc.height}`;
  const ratio = str(settings.ratio) ?? str(settings.aspectRatio);
  let ratioLabel: string | null = null;
  if (ratio) {
    const m = PIXELS.exec(ratio);
    // a pixel string such as "1280:720" IS the canvas; a short label such as "16:9" is an aspect label
    if (m && Number(m[1]) >= 64 && Number(m[2]) >= 64) canvas ??= `${m[1]}×${m[2]}`;
    else ratioLabel = ratio;
  }
  const tier = str(settings.resolutionTier) ?? str(settings.resolution);
  return { canvas, ratioLabel, tier };
}

export interface DimsInput {
  /** Dimensions recorded on the stored provider output asset ("1280×720"), when known. */
  recorded: string | null;
  /** Dimensions read from the loaded video element ("1344×768"), when available. */
  measured: string | null;
  /** What was actually sent to the provider, from the frozen provenance (null = not recorded). */
  requested: FrozenProviderRequest | null;
  /** The adaptation plan's planning canvas ("1920×822"), when a plan exists. */
  planningCanvas: string | null;
  /** Dimensions of the conformed delivery master, when one exists. */
  deliveryResolution: string | null;
  deliveryNote: string;
}

export interface DimsText {
  actualOutput: string;
  /** "Requested provider canvas": only ever what was actually sent. */
  providerCanvas: string;
  /** "Planning canvas": shown only when no exact requested canvas is known (null = do not show). */
  planningCanvas: string | null;
  delivery: string;
}

export function describeDims(i: DimsInput): DimsText {
  const actualOutput = i.recorded
    ? i.recorded
    : i.measured
      ? `${i.measured} (read from the file)`
      : "unknown (not recorded)";
  const r = i.requested;
  const tier = r?.tier && !/^(default|2k)$/i.test(r.tier) ? r.tier : null;
  const providerCanvas = r?.canvas
    ? `${r.canvas}${tier ? ` · ${tier} tier` : ""}`
    : r?.ratioLabel
      ? `${r.ratioLabel}${tier ? ` at the ${tier} tier` : ""} (aspect sent, no pixel canvas)`
      : r?.tier
        ? `${r.tier} tier (no pixel canvas sent)`
        : "unknown (no request geometry was recorded)";
  // the plan's geometry adds information only when the exact request is not known
  const planningCanvas = !r?.canvas && i.planningCanvas ? `${i.planningCanvas} (plan, not a request)` : null;
  const delivery = i.deliveryResolution ? `${i.deliveryNote} · ${i.deliveryResolution}` : i.deliveryNote;
  return { actualOutput, providerCanvas, planningCanvas, delivery };
}

/**
 * The page's mapping, in one tested place: the REQUESTED geometry comes only from the stored output's frozen provider
 * provenance; the adaptation plan's canvas is passed on as PLANNING geometry and never as the request.
 */
export function candidateCanvasFacts(
  primaryOutputProvenance: unknown,
  planCanvas: { width: number; height: number } | null | undefined,
): { requestedProvider: FrozenProviderRequest | null; planningCanvas: string | null } {
  return {
    requestedProvider: frozenProviderRequest(primaryOutputProvenance),
    planningCanvas: planCanvas ? `${planCanvas.width}×${planCanvas.height}` : null,
  };
}
