// Shared safety checks for scripts that act as the dev Auth user. The UUID is the canonical owner id;
// the email, when present, is only a cross-check.
export const PRISM_STUDIO_REF = "lyqdxiyjperhniwhzsvg";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pure checks on env values; throws before any database access. */
export function readDevUserEnv(env = process.env) {
  const url = env.SUPABASE_DB_URL;
  if (!url?.includes(PRISM_STUDIO_REF))
    throw new Error(`SUPABASE_DB_URL does not target Prism Studio project ${PRISM_STUDIO_REF}; refusing.`);
  const id = env.PRISM_STUDIO_DEV_USER_ID?.trim();
  if (!id) throw new Error("PRISM_STUDIO_DEV_USER_ID is not set (the Supabase Auth user UUID).");
  if (!UUID.test(id))
    throw new Error(
      "PRISM_STUDIO_DEV_USER_ID must be the Supabase Auth user UUID, not an email address." +
        (id.includes("@") ? "" : ` Got a value that is not a UUID.`),
    );
  const email = env.PRISM_STUDIO_DEV_USER_EMAIL?.trim() || null;
  return { url, id: id.toLowerCase(), email };
}

/** Confirms the user exists in auth.users of THIS database and that the email matches when given. */
export async function assertDevUserExists(queryable, { id, email }) {
  const { rows } = await queryable.query("select id::text, email from auth.users where id = $1::uuid", [id]);
  if (rows.length !== 1)
    throw new Error(
      `PRISM_STUDIO_DEV_USER_ID ${id} does not exist in auth.users of project ${PRISM_STUDIO_REF}.`,
    );
  const actual = rows[0].email;
  if (email && actual?.toLowerCase() !== email.toLowerCase())
    throw new Error(
      `PRISM_STUDIO_DEV_USER_EMAIL does not match the email of user ${id} (expected the Auth user's email).`,
    );
  return { id, email: actual };
}
