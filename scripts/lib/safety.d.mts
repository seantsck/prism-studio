export const DEV_PROJECT_REF: string;
/** @deprecated the DEV project ref; use resolveTarget(env).ref */
export const PRISM_STUDIO_REF: string;
export type PrismEnvironment = "development" | "staging" | "rehearsal" | "production";
export const ENVIRONMENTS: readonly PrismEnvironment[];
export function resolveTarget(env?: Record<string, string | undefined>): {
  environment: PrismEnvironment;
  ref: string;
};
export function connectionTargetsRef(url: string, ref: string): boolean;
export function assertToolAllowed(
  mode: string,
  opts?: { productionSafe?: boolean },
  env?: Record<string, string | undefined>,
): void;
export function redact(input: unknown, env?: Record<string, string | undefined>): string;
export function safeTarget(url: string): string;
export function assertProjectRef(
  url: string | undefined,
  what?: string,
  env?: Record<string, string | undefined>,
): void;
export function disposableLocalTarget(
  url: string | undefined,
  env?: Record<string, string | undefined>,
): boolean;
export function printBanner(opts: {
  mode: string;
  url: string;
  devOwner?: string | null;
  log?: (line: string) => void;
  env?: Record<string, string | undefined>;
}): void;
export function installRedactingHandlers(): void;
export function startScript(opts: {
  mode: string;
  devOwner?: string | null;
  productionSafe?: boolean;
  env?: Record<string, string | undefined>;
}): string;
