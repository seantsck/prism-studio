/**
 * Which Supabase project this deployment targets (Phase 5A.2). The same rules as `resolveTarget` in
 * `scripts/lib/safety.mjs` (a parity test keeps them identical):
 *   - NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT: development | staging | rehearsal | production (unset = development);
 *   - NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF: the project ref (unset = the DEV project);
 *   - development / staging may only target the DEV project; rehearsal / production must name their project and can
 *     never target the DEV project.
 * Both names are public on purpose: the browser checks the same target, and Next.js inlines NEXT_PUBLIC_ values only
 * when they are referenced statically, which `fromProcessEnv` does.
 */
export const DEV_PROJECT_REF = "lyqdxiyjperhniwhzsvg";
export const ENVIRONMENTS = ["development", "staging", "rehearsal", "production"] as const;
export type PrismEnvironment = (typeof ENVIRONMENTS)[number];
export interface SupabaseTarget {
  environment: PrismEnvironment;
  ref: string;
}

const REF_RE = /^[a-z]{20}$/;

export function resolveTarget(input: { environment?: string; ref?: string }): SupabaseTarget {
  const environment = (input.environment ?? "").trim() || "development";
  if (!(ENVIRONMENTS as readonly string[]).includes(environment))
    throw new Error(`NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}`);
  const explicit = (input.ref ?? "").trim();
  if (explicit && !REF_RE.test(explicit))
    throw new Error("NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF is not a Supabase project ref");
  const isolated = environment === "rehearsal" || environment === "production";
  if (isolated && !explicit)
    throw new Error(`The ${environment} environment must name its Supabase project explicitly; refusing.`);
  const ref = explicit || DEV_PROJECT_REF;
  if (isolated && ref === DEV_PROJECT_REF)
    throw new Error(`The ${environment} environment can never target the DEV project; refusing.`);
  if (!isolated && ref !== DEV_PROJECT_REF)
    throw new Error(
      `The ${environment} environment may only target the DEV project; a different project needs rehearsal or production. Refusing.`,
    );
  return { environment: environment as PrismEnvironment, ref };
}

/** The deployment's target, from statically referenced public env (inlined into the browser bundle). */
export function deploymentTarget(): SupabaseTarget {
  return resolveTarget({
    environment: process.env.NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT,
    ref: process.env.NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF,
  });
}

/** True when the public Supabase URL is exactly `https://<ref>.supabase.co`. */
export function publicUrlTargetsRef(url: string, ref: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === `${ref}.supabase.co`;
  } catch {
    return false;
  }
}

/** True when a Postgres connection string addresses `ref`: a pooler user `<role>.<ref>` or the direct host. */
export function connectionTargetsRef(url: string, ref: string): boolean {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    return user.endsWith(`.${ref}`) || u.hostname === `db.${ref}.supabase.co`;
  } catch {
    return false;
  }
}
