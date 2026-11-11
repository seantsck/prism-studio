// Safety rails shared by every script that touches the dedicated Prism Studio database.
//   - ref guard (the connection string must name the dedicated project)
//   - visible target banner BEFORE any mutation
//   - secret redaction for anything that gets printed (including exception messages)
//   - environment-scoped targeting (Phase 5A.2): which Supabase project a run may touch, and refusal of
//     non-production-safe tooling on production
/** The DEV / staging project (owner review, previews, tests). Never customer production. */
export const DEV_PROJECT_REF = "lyqdxiyjperhniwhzsvg";
/** @deprecated the DEV project ref; use resolveTarget(env).ref for the project a run is allowed to touch */
export const PRISM_STUDIO_REF = DEV_PROJECT_REF;

export const ENVIRONMENTS = ["development", "staging", "rehearsal", "production"];
const REF_RE = /^[a-z]{20}$/;

/**
 * Which Supabase project this run targets, from NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT and
 * NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF (public names: the browser checks the same target). Unset means the
 * historical default: development on the DEV project, so existing machines and staging are unchanged.
 *   - development / staging may only target the DEV project;
 *   - rehearsal / production must name their project explicitly, and it can never be the DEV project.
 */
export function resolveTarget(env = process.env) {
  const environment = (env.NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT ?? "").trim() || "development";
  if (!ENVIRONMENTS.includes(environment))
    throw new Error(`NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}`);
  const explicit = (env.NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF ?? "").trim();
  if (explicit && !REF_RE.test(explicit))
    throw new Error("NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF is not a Supabase project ref");
  const isolated = environment === "rehearsal" || environment === "production";
  if (isolated && !explicit)
    throw new Error(`The ${environment} environment must name its Supabase project explicitly; refusing.`);
  const ref = explicit || DEV_PROJECT_REF;
  if (isolated && ref === DEV_PROJECT_REF)
    throw new Error(`The ${environment} environment can never target the DEV project; refusing.`);
  if (!isolated && ref !== DEV_PROJECT_REF)
    throw new Error(
      `The ${environment} environment may only target the DEV project; a different project needs rehearsal or production. Refusing.`,
    );
  return { environment, ref };
}

/** True when a Postgres connection string addresses `ref`: a pooler user `<role>.<ref>` or the direct host. */
export function connectionTargetsRef(url, ref) {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    return user.endsWith(`.${ref}`) || u.hostname === `db.${ref}.supabase.co`;
  } catch {
    return false;
  }
}

/** Removes passwords/keys from any text. Safe to call on arbitrary strings and error messages. */
export function redact(input, env = process.env) {
  let text = String(input ?? "");
  // postgres://user:password@host/db  →  postgres://user:***@host/db
  text = text.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, "$1***$3");
  // JWT-shaped tokens and sb_secret / sb_publishable style keys.
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "***jwt***");
  text = text.replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/g, "***key***");
  // Auth artefacts: header values, bearer tokens, token/code/password key=value pairs, URL fragments.
  text = text.replace(/\b(authorization|cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^\r\n"']+)/gi, "$1$2***");
  text = text.replace(
    /\b(access_token|refresh_token|token_hash|code_verifier|password)(["']?\s*[:=]\s*["']?)([^\s&"',;}]+)/gi,
    "$1$2***",
  );
  text = text.replace(/#\S*(?:access_token|refresh_token)\S*/gi, "#***");
  // Literal secret values from the environment (password inside the DB URL, service key, ...).
  for (const value of secretValues(env)) text = text.split(value).join("***");
  return text;
}

function secretValues(env) {
  const values = new Set();
  for (const urlKey of ["SUPABASE_DB_URL", "PRISM_STUDIO_WORKER_DB_URL", "PRISM_STUDIO_CONTINUITY_DB_URL"]) {
    const url = env[urlKey];
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.password) {
        values.add(u.password);
        try {
          values.add(decodeURIComponent(u.password));
        } catch {
          /* not percent-encoded */
        }
      }
    } catch {
      /* not a URL */
    }
  }
  for (const key of [
    "SUPABASE_SERVICE_ROLE_KEY",
    "PRISM_STUDIO_DEV_USER_PASSWORD",
    "PRISM_STUDIO_WORKER_DB_PASSWORD",
    "PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY",
    "PRISM_STUDIO_WORKER_SERVICE_KEY",
    "PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY",
    "RUNWAYML_API_SECRET",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "PRISM_STUDIO_CONTINUITY_DB_PASSWORD",
    "PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY",
    "PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY",
    "PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY",
    "PRISM_STUDIO_STORY_WORKER_DB_URL",
    "PRISM_STUDIO_STORY_DB_PASSWORD",
    "PRISM_STUDIO_RENDER_WORKER_DB_URL",
    "PRISM_STUDIO_RENDER_DB_PASSWORD",
    "PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY",
  ]) {
    const v = env[key];
    if (v && v.length >= 6) values.add(v);
  }
  return [...values].filter((v) => v.length >= 6);
}

/** Host + database name only. Never user, never password. */
export function safeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable connection string>";
  }
}

/**
 * A DISPOSABLE LOCAL database (Phase 3A.4C verification of an unapplied migration without touching hosted): only when
 * `PRISM_STUDIO_DISPOSABLE_DB=1` is set explicitly AND the host is loopback AND the database name starts with
 * `prism_disposable`. Anything else must name the dedicated project. See docs/local-supabase.md.
 */
export function disposableLocalTarget(url, env = process.env) {
  if (env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !url) return false;
  try {
    const u = new URL(url);
    return (
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      /^\/prism_disposable[a-z0-9_]*$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function assertProjectRef(url, what = "SUPABASE_DB_URL", env = process.env) {
  if (!url) throw new Error(`${what} is not set`);
  if (disposableLocalTarget(url, env)) return;
  const { ref } = resolveTarget(env);
  if (!connectionTargetsRef(url, ref))
    throw new Error(`${what} does not target Prism Studio project ${ref}; refusing.`);
}

/**
 * Production refuses every script that is not explicitly production-safe (migrations, validation, role provisioning,
 * workers). Seeds, resets, cleanups and behaviour suites write fixtures and must never share a database with customers.
 */
export function assertToolAllowed(mode, { productionSafe = false } = {}, env = process.env) {
  const { environment } = resolveTarget(env);
  if (environment === "production" && !productionSafe)
    throw new Error(`"${mode}" is not production-safe and refuses the production environment.`);
}

/** Prints the target banner. Call before the first statement that can mutate anything. */
export function printBanner({ mode, url, devOwner = null, log = console.log, env = process.env }) {
  log("──────────────────────────────────────────────");
  const target = disposableLocalTarget(url, env) ? null : resolveTarget(env);
  log(
    target
      ? `Target Supabase project: ${target.ref} (${target.environment})`
      : "Target:                  DISPOSABLE LOCAL DATABASE (not Supabase)",
  );
  log(`Database host:           ${safeTarget(url)}`);
  log(`Mode:                    ${mode}`);
  log(`Dev owner:               ${devOwner ?? "N/A"}`);
  log("──────────────────────────────────────────────");
}

/** Makes uncaught errors print redacted. */
export function installRedactingHandlers() {
  const show = (err) => {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(redact(text));
    process.exitCode = 1;
  };
  process.on("uncaughtException", show);
  process.on("unhandledRejection", show);
}

/** One call for scripts: guard + banner + redacting handlers. Returns the validated connection string. */
export function startScript({ mode, devOwner = null, productionSafe = false, env = process.env }) {
  installRedactingHandlers();
  assertProjectRef(env.SUPABASE_DB_URL, "SUPABASE_DB_URL", env);
  if (!disposableLocalTarget(env.SUPABASE_DB_URL, env)) assertToolAllowed(mode, { productionSafe }, env);
  printBanner({ mode, url: env.SUPABASE_DB_URL, devOwner, env });
  return env.SUPABASE_DB_URL;
}
