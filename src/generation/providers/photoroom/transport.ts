/**
 * Phase 5B-I3b: the boundary between the Photoroom adapter and the network. Exactly ONE transport (`http-transport.ts`,
 * lazily imported by the adapter, only where a job executes) holds the key and talks to Photoroom. Tests use
 * `FakePhotoroomTransport`; no test ever reaches Photoroom.
 */
export interface PhotoroomCall {
  image: { bytes: Uint8Array; mime: string; filename: string };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PhotoroomResult {
  /** The cutout as returned (expected: PNG with alpha). */
  bytes: Uint8Array;
  contentType: string | null;
  /** `x-uncertainty-score` when Photoroom sends it (an undocumented-in-reference header; recorded if present). */
  uncertaintyScore: number | null;
}

export interface PhotoroomTransport {
  /** EXACTLY one outbound request. Never retried here: Prism's queue owns every retry decision. */
  segment(call: PhotoroomCall): Promise<PhotoroomResult>;
}

/** A transport failure reduced to a status and a safe code (never the key, never the request). */
export class PhotoroomTransportError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string,
    /** True when the request may have been processed (timeout, dropped connection, 5xx): possibly billed. */
    readonly ambiguous: boolean,
  ) {
    super(message);
  }
}
