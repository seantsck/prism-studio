/** Routes reachable without a session. Everything else is protected by the proxy. */
const PUBLIC_EXACT = new Set(["/forgot-password", "/update-password"]);

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || pathname === "/auth/callback" || pathname === "/auth/error";
}
