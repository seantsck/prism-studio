import { ZodError } from "zod";

/**
 * Expected, user-correctable problems (bad input, locked entity, asset in use...). The message is shown
 * to the user verbatim, so it must never contain internals. Anything else is treated as a bug: logged
 * server-side with a reference id, and reported to the user generically.
 */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "UserFacingError";
  }
}

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string>; reference?: string };

export const OK: ActionResult = { ok: true };

/** Next.js implements redirect()/notFound() by throwing; those must pass through untouched. */
function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") || digest === "NEXT_NOT_FOUND");
}

/** Runs a server action body and converts failures into an ActionResult the form can render inline. */
export async function runAction(
  body: () => Promise<void | ActionResult>,
  opts: { name?: string } = {},
): Promise<ActionResult> {
  try {
    const result = await body();
    return result ?? OK;
  } catch (err) {
    if (isNextControlFlow(err)) throw err;
    if (err instanceof UserFacingError) {
      return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    }
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join(".") || "_";
        fieldErrors[key] ??= issue.message;
      }
      return { ok: false, error: "Some fields are invalid.", fieldErrors };
    }
    // Unexpected: keep detail server-side.
    const reference = Math.random().toString(36).slice(2, 10);
    console.error(`[action:${opts.name ?? "unknown"}] ${reference}`, err);
    return {
      ok: false,
      error: `Something went wrong and your change was not saved. (ref ${reference})`,
      reference,
    };
  }
}
