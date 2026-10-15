/**
 * The ONE place automated tests read their sign-in credentials.
 *
 * Automated authentication uses the dedicated TEST pair only. It never falls back to the manual development
 * account (PRISM_STUDIO_DEV_*), so a stale or personal credential can never be used by a test by accident.
 * Values are never logged; a missing variable throws with its NAME only.
 */
export type PrismStudioTestCredentials = { email: string; password: string };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required test environment variable: ${name}`);
  return value;
}

export function getPrismStudioTestCredentials(): PrismStudioTestCredentials {
  return {
    email: requireEnv("PRISM_STUDIO_TEST_EMAIL"),
    password: requireEnv("PRISM_STUDIO_TEST_PASSWORD"),
  };
}
