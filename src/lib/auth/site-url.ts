/**
 * The public origin of THIS app (Prism Studio), used to build Auth redirect targets.
 *
 * Why it exists: Supabase Auth falls back to the project's "Site URL" when no explicit redirect is supplied,
 * and a developer machine usually has another app on :3000. Every redirect we request is therefore built
 * from here, never from `window.location` guesses and never hardcoded in domain logic.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL (explicit configuration always wins)
 *   2. the platform deployment URL (VERCEL_URL, https) — only for a production build
 *   3. http://localhost:3100 — local development only
 * A production build with none of these throws instead of silently emailing localhost links.
 */
export const LOCAL_SITE_URL = "http://localhost:3100";

export interface SiteUrlEnv {
  NEXT_PUBLIC_SITE_URL?: string;
  VERCEL_URL?: string;
  NODE_ENV?: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Normalises to a bare origin (no path, query, hash or trailing slash). Throws on anything unsafe. */
export function normalizeSiteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Site URL is not a valid absolute URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Site URL must use https (http is allowed only for localhost)");
  }
  if (url.username || url.password) throw new Error("Site URL must not contain credentials");
  return url.origin;
}

export function resolveSiteUrl(env: SiteUrlEnv): string {
  const explicit = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return normalizeSiteUrl(explicit);
  if (env.NODE_ENV === "production") {
    const deployment = env.VERCEL_URL?.trim();
    if (deployment) return normalizeSiteUrl(`https://${deployment}`);
    throw new Error("NEXT_PUBLIC_SITE_URL must be set for a production build");
  }
  return LOCAL_SITE_URL;
}

/**
 * Property accesses are written out literally so Next can inline the NEXT_PUBLIC_* value into the browser bundle.
 */
export function getSiteUrl(): string {
  return resolveSiteUrl({
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_URL: process.env.VERCEL_URL,
    NODE_ENV: process.env.NODE_ENV,
  });
}

/** Where a password-recovery email must send the user back to. */
export function recoveryRedirectUrl(siteUrl: string = getSiteUrl()): string {
  return `${siteUrl}/auth/callback?next=/update-password`;
}
