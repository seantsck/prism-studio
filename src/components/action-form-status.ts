import type { ActionResult } from "@/server/action-result";

/**
 * Whether an ActionForm shows its status line.
 *
 * `quiet` silences the "Saving…" / "Saved" chatter (the surrounding UI already shows the new state) but must
 * NEVER hide a failure: a click that looks successful while nothing was written is the worst outcome for a
 * review control, so an error is always rendered.
 */
export function actionStatusVisible(opts: {
  quiet: boolean;
  pending: boolean;
  state: ActionResult | null;
  showSaved: boolean;
}): boolean {
  const failed = opts.state?.ok === false;
  if (opts.quiet) return failed && !opts.pending;
  return opts.pending || opts.state !== null || opts.showSaved;
}
