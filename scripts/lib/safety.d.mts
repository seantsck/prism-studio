export const PRISM_STUDIO_REF: string;
export function redact(input: unknown, env?: Record<string, string | undefined>): string;
export function safeTarget(url: string): string;
export function assertProjectRef(url: string | undefined, what?: string): void;
export function printBanner(opts: {
  mode: string;
  url: string;
  devOwner?: string | null;
  log?: (line: string) => void;
}): void;
export function installRedactingHandlers(): void;
export function startScript(opts: {
  mode: string;
  devOwner?: string | null;
  env?: Record<string, string | undefined>;
}): string;
