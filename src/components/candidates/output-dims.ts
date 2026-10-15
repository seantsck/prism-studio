/**
 * What a candidate card says about picture size. Three different things that must not be conflated:
 *   - requested provider canvas: what Prism asked the provider to generate (only when the frozen request
 *     carries one; some model families take a resolution tier, not a ratio, and then it is genuinely unknown)
 *   - actual output: the stored provider file's dimensions (probed at ingest), else read from the file in the
 *     browser, else unknown. Never copied from the request.
 *   - delivery: the master Prism delivers when it differs from the provider original.
 */
export interface DimsInput {
  /** Dimensions recorded on the stored provider output asset ("1280×720"), when known. */
  recorded: string | null;
  /** Dimensions read from the loaded video element ("1344×768"), when available. */
  measured: string | null;
  /** The frozen provider canvas ("1280×720"), when the request carries one. */
  requestedCanvas: string | null;
  /** Dimensions of the conformed delivery master, when one exists. */
  deliveryResolution: string | null;
  deliveryNote: string;
}

export interface DimsText {
  actualOutput: string;
  providerCanvas: string;
  delivery: string;
}

export function describeDims(i: DimsInput): DimsText {
  const actualOutput = i.recorded
    ? i.recorded
    : i.measured
      ? `${i.measured} (read from the file)`
      : "unknown (not recorded)";
  const providerCanvas = i.requestedCanvas
    ? `${i.requestedCanvas} (requested)`
    : "unknown (this model takes a resolution tier, no canvas was frozen)";
  const delivery = i.deliveryResolution ? `${i.deliveryNote} · ${i.deliveryResolution}` : i.deliveryNote;
  return { actualOutput, providerCanvas, delivery };
}
