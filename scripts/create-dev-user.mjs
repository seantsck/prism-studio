// Creates the dev user through the supported Supabase Auth sign-up flow (no direct auth.users writes).
// Records PRISM_STUDIO_DEV_USER_ID / _EMAIL / _PASSWORD in .env.local (git-ignored). Never prints the password.
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const REF = "lyqdxiyjperhniwhzsvg";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url?.includes(REF))
  throw new Error("NEXT_PUBLIC_SUPABASE_URL is not the Prism Studio project; refusing.");
if (process.env.PRISM_STUDIO_DEV_USER_ID) {
  console.log("dev user already recorded:", process.env.PRISM_STUDIO_DEV_USER_ID);
  process.exit(0);
}

const email = process.env.PRISM_STUDIO_DEV_EMAIL ?? "prism-studio-dev@example.com";
const password = randomBytes(18).toString("base64url");
const res = await fetch(`${url}/auth/v1/signup`, {
  method: "POST",
  headers: { apikey: key, "content-type": "application/json" },
  body: JSON.stringify({ email, password, data: { purpose: "prism-studio local dev" } }),
});
const body = await res.json();
if (!res.ok || (!body.id && !body.user?.id)) {
  console.error(
    "signup failed:",
    res.status,
    body.msg ?? body.error_description ?? body.message ?? JSON.stringify(body),
  );
  process.exit(1);
}
const id = body.id ?? body.user.id;
const env = readFileSync(".env.local", "utf8");
const lines = [
  `PRISM_STUDIO_DEV_USER_ID=${id}`,
  `PRISM_STUDIO_DEV_EMAIL=${email}`,
  `PRISM_STUDIO_DEV_PASSWORD=${password}`,
];
appendFileSync(".env.local", `${env.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`);
console.log(
  "created dev user",
  id,
  "confirmed:",
  Boolean(body.email_confirmed_at ?? body.user?.email_confirmed_at),
);
