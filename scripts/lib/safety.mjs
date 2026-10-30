// Safety rails shared by every script that touches the dedicated Prism Studio database.
//   - ref guard (the connection string must name the dedicated project)
//   - visible target banner BEFORE any mutation
//   - secret redaction for anything that gets printed (including exception messages)
export const PRISM_STUDIO_REF = "lyqdxiyjperhniwhzsvg";

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
  if (!url.includes(PRISM_STUDIO_REF))
    throw new Error(`${what} does not target Prism Studio project ${PRISM_STUDIO_REF}; refusing.`);
}

/** Prints the target banner. Call before the first statement that can mutate anything. */
export function printBanner({ mode, url, devOwner = null, log = console.log, env = process.env }) {
  log("──────────────────────────────────────────────");
  log(
    disposableLocalTarget(url, env)
      ? "Target:                  DISPOSABLE LOCAL DATABASE (not Supabase)"
      : `Target Supabase project: ${PRISM_STUDIO_REF}`,
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
export function startScript({ mode, devOwner = null, env = process.env }) {
  installRedactingHandlers();
  assertProjectRef(env.SUPABASE_DB_URL, "SUPABASE_DB_URL", env);
  printBanner({ mode, url: env.SUPABASE_DB_URL, devOwner, env });
  return env.SUPABASE_DB_URL;
}
