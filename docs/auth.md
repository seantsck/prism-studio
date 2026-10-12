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

| Place                                           | Check                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/proxy.ts`                                  | Convenience redirect / 401 for everything except `/login` and static assets. |
| `getRepo()` / `requireUser()`                   | Server components, server actions: redirect to `/login` without a session.   |
| `/api/assets/[id]`, `/api/projects/.../package` | `getCurrentUser()`; 401 without a session, 404 when the row is not visible.  |
| Postgres RLS                                    | The authority: rows of other users are invisible/unwritable regardless.      |

## Accounts

- There is no sign-up page, password reset or email-change UI. Accounts are created in the Supabase dashboard.
- The model is single owner per project (`projects.user_id`); there is no sharing or roles
  ([security-model](security-model.md)).
- `PRISM_STUDIO_DEV_USER_ID` identifies the owner of seeded data for **scripts**. The app never reads it; a
  signed-in user only sees projects owned by their own `auth.users.id`, so a fresh account sees an empty
  workspace until a project is created (or the seed is run for that user's id).
- No service-role key is used anywhere.

## Testing

`e2e/supabase-auth.spec.ts` (`npm run test:e2e:supabase`): redirect with remembered destination, API 401,
friendly bad-credential message, and (with `PRISM_STUDIO_TEST_PASSWORD`) a full signed-in workflow. Without the
password the signed-in test is skipped.
