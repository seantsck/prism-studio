import { createBrowserClient } from "@supabase/ssr";
import { supabasePublicConfig } from "./config";

/**
 * Browser Supabase client (publishable key only). Used for the one flow that must start in the browser:
 * requesting a password-reset email, so the PKCE code verifier is stored in this browser's cookies and the
 * emailed link can only be completed here. @supabase/ssr defaults to the PKCE flow.
 */
export function createSupabaseBrowserClient() {
  const { url, key } = supabasePublicConfig();
  return createBrowserClient(url, key);
}
