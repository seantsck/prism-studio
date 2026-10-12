"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Old (implicit-flow) recovery links deliver tokens in the URL *fragment*. We deliberately do not support
 * that flow. If such a fragment reaches any page we (1) scrub it from the address bar and history entry
 * without reading or storing it, and (2) send the user to the "request a new link" page.
 * Only the presence of a key is tested; the value is never read.
 */
export function LegacyLinkGuard() {
  const router = useRouter();
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !/(?:^#|&)(access_token|refresh_token|provider_token|error_code|error)=/.test(hash)) return;
    const expired = /(?:^#|&)error_code=otp_expired(?:&|$)/.test(hash);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    router.replace(`/auth/error?reason=${expired ? "expired" : "legacy"}`);
  }, [router]);
  return null;
}
