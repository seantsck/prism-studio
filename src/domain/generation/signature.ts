/**
 * Cheap change-detection token for status polling. The browser compares the token from the server render
 * with the one the status endpoint returns; a difference triggers a re-render. Never contains content.
 */
export function generationSignature(
  rows: Array<{
    attemptId: string;
    jobStatus: string | null;
    attemptStatus: string;
    review: string;
    updatedAt?: string | null;
  }>,
): string {
  return rows
    .map((r) =>
      [r.attemptId.slice(0, 8), r.jobStatus ?? "-", r.attemptStatus, r.review, r.updatedAt ?? ""].join(":"),
    )
    .sort()
    .join("|");
}
