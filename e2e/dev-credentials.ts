/**
 * The ONE place authenticated tests read their sign-in credentials.
 *
 * There is a single local Prism Studio identity: PRISM_STUDIO_DEV_USER_EMAIL / PRISM_STUDIO_DEV_USER_PASSWORD
 * (the same Auth user as PRISM_STUDIO_DEV_USER_ID). There is no separate test account and no fallback chain.
 * Values are never logged; a missing variable throws with its NAME only.
 */
export type PrismStudioDevCredentials = { email: string; password: string };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getPrismStudioDevCredentials(): PrismStudioDevCredentials {
  return {
    email: requireEnv("PRISM_STUDIO_DEV_USER_EMAIL"),
    password: requireEnv("PRISM_STUDIO_DEV_USER_PASSWORD"),
  };
}
