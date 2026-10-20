import path from "node:path";
import { isWithin } from "../../reconstruction/local/work-root";

/**
 * Where a workstation's Local Agent keeps its identity (Phase 2F M2D.3C1): a per-user application-data directory,
 * never the repository and never a temporary directory.
 *
 *   Windows  %LOCALAPPDATA%\PrismStudio\agent
 *   macOS    ~/Library/Application Support/PrismStudio/agent
 *   Linux    $XDG_CONFIG_HOME/prism-studio/agent, else ~/.config/prism-studio/agent
 *
 * PRISM_LOCAL_AGENT_HOME (absolute) overrides it (tests, several agents for one user). Each pairing is a PROFILE
 * directory under `profiles/` (one device = one project; pairing another project uses another profile).
 */

export class AgentHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentHomeError";
  }
}

export function defaultAgentHome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "PrismStudio", "agent");
  if (platform === "darwin" && env.HOME)
    return path.join(env.HOME, "Library", "Application Support", "PrismStudio", "agent");
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "prism-studio", "agent");
  if (env.HOME) return path.join(env.HOME, ".config", "prism-studio", "agent");
  throw new AgentHomeError(
    "Cannot find a per-user application data directory; set PRISM_LOCAL_AGENT_HOME to an absolute path.",
  );
}

export function resolveAgentHome(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = process.cwd(),
): string {
  const configured = env.PRISM_LOCAL_AGENT_HOME?.trim();
  if (configured && !path.isAbsolute(configured))
    throw new AgentHomeError("PRISM_LOCAL_AGENT_HOME must be an absolute path.");
  const home = path.resolve(/*turbopackIgnore: true*/ configured || defaultAgentHome(env));
  if (isWithin(path.resolve(/*turbopackIgnore: true*/ repoRoot), home))
    throw new AgentHomeError(
      "The Local Agent's identity must be stored outside the Prism repository (it holds a private key).",
    );
  return home;
}

export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function profileDir(home: string, profile: string): string {
  if (!PROFILE_RE.test(profile))
    throw new AgentHomeError("A profile name is 1-32 lowercase letters, digits or hyphens.");
  return path.join(home, "profiles", profile);
}
