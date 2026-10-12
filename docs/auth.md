# Authentication

Supabase mode uses **Supabase Auth, email + password**. Memory mode has no accounts (`/login` shows a notice
and a link to the demo workspace; `signIn` returns "Sign-in is disabled in demo mode.").

## Pieces

| Piece                                                 | Role                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/app/login/page.tsx`, `components/login-form.tsx` | `/login` page and form (uses `useActionState` with `signIn`).                          |
| `src/server/auth-actions.ts`                          | Server actions `signIn(prev, form)` and `signOut()`.                                   |
| `src/lib/supabase/server.ts`                          | `createSupabaseServerClient()`: `@supabase/ssr` client bound to the request's cookies. |
| `src/lib/supabase/proxy.ts`                           | `updateSession(request)`: rotates cookies, reports `signedIn` via `getClaims()`.       |
| `src/proxy.ts`                                        | Next 16 proxy: redirects / 401s unauthenticated requests.                              |
| `src/server/auth.ts`                                  | `getCurrentUser()` (cached per request) and `requireUser()` (redirects to `/login`).   |
| `src/lib/supabase/config.ts`                          | `persistenceMode()`, public URL/key, project-ref guard.                                |

## Flow

1. Unauthenticated request → proxy redirects to `/login?next=<path+query>` (home `/` carries no `next`).
   API paths get `401 {"error":"unauthenticated"}`.
2. `signIn` calls `supabase.auth.signInWithPassword`; cookies are set by `@supabase/ssr`.
3. On success the action `redirect()`s to the `next` path. Only same-site absolute paths are accepted
   (`/…`, not `//…`, no backslash); anything else becomes `/`. The page and the proxy apply the same rule.
4. Every request: the proxy refreshes the session; server code calls `auth.getClaims()`, which **verifies the
   JWT signature**; cookie contents are never trusted raw. `claims.sub` is the user id.
5. `getRepo()` builds a `UserRepository` from `{ sub, email }`, so Postgres evaluates RLS as that user.
   See [persistence](persistence.md).
6. `signOut` calls `auth.signOut()` and redirects to `/login`.

## Error messages

Failures are logged server-side by code only (`console.warn("[auth] sign-in failed:", code)`); the user sees one
of four fixed messages: incorrect email or password, email not confirmed, too many attempts (HTTP 429 /
`over_request_rate_limit`), or a generic failure. No account-existence detail leaks.

## Where session checks happen

| Place                                           | Check                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/proxy.ts`                                  | Convenience redirect / 401 for everything except the auth-flow pages and static assets. |
| `getRepo()` / `requireUser()`                   | Server components, server actions: redirect to `/login` without a session.              |
| `/api/assets/[id]`, `/api/projects/.../package` | `getCurrentUser()`; 401 without a session, 404 when the row is not visible.             |
| Postgres RLS                                    | The authority: rows of other users are invisible/unwritable regardless.                 |

## Accounts

- There is no sign-up page or email-change UI. Accounts are created in the Supabase dashboard; passwords are
  recovered through `/forgot-password` (below).
- The model is single owner per project (`projects.user_id`); there is no sharing or roles
  ([security-model](security-model.md)).
- `PRISM_STUDIO_DEV_USER_ID` identifies the owner of seeded data for **scripts**. The app never reads it; a
  signed-in user only sees projects owned by their own `auth.users.id`, so a fresh account sees an empty
  workspace until a project is created (or the seed is run for that user's id).
- No service-role key is used anywhere.

## Password recovery

Prism Studio owns the whole reset flow; do not use the dashboard's "Send password recovery" button (see
below). Supported path: **SSR + PKCE**.

```
/forgot-password ──(browser client)──► Supabase  resetPasswordForEmail(email, { redirectTo })
                                         redirectTo = <NEXT_PUBLIC_SITE_URL>/auth/callback?next=/update-password
email link ──► /auth/callback?code=…&next=/update-password   (route handler, server client)
                 exchangeCodeForSession(code)  → session cookies written by @supabase/ssr
                 next validated by safeInternalPath()        → 307 /update-password
/update-password ──(server action)──► getUser() · updateUser({ password }) · signOut({ scope: "global" })
                 → /login?passwordUpdated=1  ("Password updated. Sign in with your new password.")
```

| Piece                                     | Behaviour                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/auth/site-url.ts`                | `getSiteUrl()`: `NEXT_PUBLIC_SITE_URL`, then `VERCEL_URL` (production builds only), then `http://localhost:3100` (dev). https only (http for localhost). |
| `src/components/forgot-password-form.tsx` | Browser client (so the PKCE verifier lives in this browser). Same success text whether or not the account exists. Rate/network errors are fixed text.    |
| `src/app/auth/callback/route.ts`          | Exchanges the code, redirects to a validated path or `/auth/error?reason=…`. Never logs or echoes the code, tokens or cookies.                           |
| `src/app/update-password/page.tsx`        | Public route, but the form only renders for a verified session; otherwise "Request another reset link". The server action re-checks the session.         |
| `src/app/auth/error/page.tsx`             | Whitelisted `reason` (expired, used, session, legacy, failed) maps to friendly copy with links to request a new link / sign in.                          |
| `src/lib/auth/safe-redirect.ts`           | One `safeInternalPath()` for login `next`, the proxy, the sign-in action and the callback. Same-origin paths only; decode-then-check.                    |
| `src/lib/auth/redact.ts`                  | `redactUrl` / `redactText` / `describeError`: fragments, tokens, codes, passwords, headers, DB URLs. Used by server error logging.                       |

### Session semantics

- The callback creates a normal session (a recovery session is a regular session in Supabase). The user can
  reach the app with it, but the intended path is `/update-password`.
- After a successful change the app signs out **globally** (all sessions of that user, not just this browser),
  then sends the user to `/login?passwordUpdated=1`. If the global call fails it still ends the local session.
  Rationale: a reset usually means the old password may be compromised, and it gives a clean, testable boundary.
- Passwords exist only in the POST body of the server action: never in a URL, `localStorage`, logs, or the
  returned state.
- Password rules: 10 to 72 bytes (bcrypt's limit), matching confirmation, no composition rules. The project's
  own Supabase password policy remains authoritative (`weak_password` is mapped to friendly text).

### Why not the implicit flow (`#access_token=…`)

Links generated from the dashboard, or by a client created without PKCE, deliver tokens in the URL fragment.
Supporting them would mean establishing a session in client JavaScript from a bearer URL. We do not:
`LegacyLinkGuard` (root layout) only detects such a fragment, scrubs it with `history.replaceState` without
reading or storing the values, and sends the user to `/auth/error?reason=legacy`. Old links must be discarded
and a new reset requested from `/forgot-password`.

### Why `exchangeCodeForSession` and not `token_hash` + `verifyOtp`

`token_hash` is the right choice when the email must work in a _different_ browser than the one that
requested it; that needs a custom template building `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}`.
For an owner-operated tool, PKCE is simpler and stricter (the link is bound to the requesting browser) and uses
Supabase's stock recovery template with no cryptography of our own. Revisit if cross-device reset becomes a
requirement.

### Required Supabase dashboard configuration (manual)

Project `lyqdxiyjperhniwhzsvg` → Authentication → URL Configuration. The app never changes this itself.

| Setting                  | Local development          | Production (later)                |
| ------------------------ | -------------------------- | --------------------------------- |
| Site URL                 | `http://localhost:3100`    | `https://studio.prismsuite.io`    |
| Additional redirect URLs | `http://localhost:3100/**` | `https://studio.prismsuite.io/**` |

- Prism Engine occupies `localhost:3000`; if Site URL still says `:3000`, every email that does not carry an
  allow-listed `redirectTo` lands in the wrong app. That was the root cause of the first wrong redirect.
- The reset request passes an explicit `redirectTo`, which **must** match the allow-list, otherwise Supabase
  silently falls back to the Site URL (the proxy then forwards `/?code=…` to `/auth/callback` as a safety net).
  Supabase uses the Site URL when no `redirectTo` is supplied at all.
- Production rollout checklist: set Site URL to `https://studio.prismsuite.io`; add
  `https://studio.prismsuite.io/**` (this covers `/auth/callback` and `/update-password`); keep the localhost
  entry only if wanted; set `NEXT_PUBLIC_SITE_URL` on the host; request a real reset from production and click
  it end to end.
- Authentication → Emails → Reset password: keep the default template that uses `{{ .ConfirmationURL }}`
  (it already honours the request's `redirectTo`; `{{ .RedirectTo }}` is also available). Do not hard-code
  `{{ .SiteURL }}` into a custom link, or the app's `redirectTo` is discarded. Mind the default SMTP rate limit
  (a couple of emails per hour).
- Do **not** use the dashboard "Send password recovery" action: it has no PKCE verifier from this browser, so
  the callback reports "recovery session is not valid here". Always start from `/forgot-password`.

## Testing

`e2e/supabase-auth.spec.ts` (`npm run test:e2e:supabase`): redirect with remembered destination, API 401,
friendly bad-credential message, and (with `PRISM_STUDIO_TEST_PASSWORD`) a full signed-in workflow. Without the
password the signed-in test is skipped.

The password-recovery flow has unit tests (`src/lib/auth/__tests__`) and unauthenticated browser coverage in
`e2e/supabase-auth.spec.ts` (the request side is mocked at the network layer, so no real email is sent). The email
click itself is a manual step.
