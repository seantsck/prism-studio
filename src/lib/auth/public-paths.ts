/** Routes reachable without a session. Everything else is protected by the proxy. */
const PUBLIC_EXACT = new Set(["/forgot-password", "/update-password"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || pathname === "/auth/callback" || pathname === "/auth/error";
}

/**
 * The remote Local Agent protocol (docs/local-agent-protocol.md). A workstation has no browser session: every
 * request authenticates itself (one-time pairing secret, or an Ed25519-signed request with a strictly increasing
 * counter), so the session proxy must neither redirect it nor refresh cookies for it.
 */
export function isAgentProtocolPath(pathname: string): boolean {
  return pathname.startsWith("/api/local-agent/v1/");
}
