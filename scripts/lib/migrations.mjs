// Pure migration-integrity logic (no I/O) so it can be unit tested.
import { createHash } from "node:crypto";

/** Line endings are normalised so Windows checkouts (CRLF) and Linux (LF) agree. */
export function checksumOf(sql) {
  return createHash("sha256").update(String(sql).replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export const MISMATCH_MESSAGE =
  "Applied migration has changed on disk. Create a new migration instead.";

/**
 * files:   [{ name, sql }]            migrations on disk
 * applied: [{ name, checksum|null }]  rows of public.prism_migrations
 * Returns what to do. Never mutates.
 */
export function planMigrations(files, applied) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const appliedByName = new Map(applied.map((a) => [a.name, a]));
  const mismatched = [];
  const unrecorded = []; // applied before checksums existed: need a baseline
  const pending = [];
  for (const f of sorted) {
    const row = appliedByName.get(f.name);
    if (!row) {
      pending.push(f);
      continue;
    }
    if (row.checksum == null) {
      unrecorded.push(f.name);
      continue;
    }
    if (row.checksum !== checksumOf(f.sql)) mismatched.push(f.name);
  }
  const missingOnDisk = applied.map((a) => a.name).filter((n) => !sorted.some((f) => f.name === n));
  // A pending file that sorts before an applied one would be applied out of order.
  const lastApplied = applied.map((a) => a.name).sort().at(-1);
  const outOfOrder = pending.filter((f) => lastApplied && f.name < lastApplied).map((f) => f.name);
  return { pending, mismatched, unrecorded, missingOnDisk, outOfOrder };
}

export function assertPlanSafe(plan) {
  if (plan.mismatched.length)
    throw new Error(`${MISMATCH_MESSAGE} (${plan.mismatched.join(", ")})`);
  if (plan.missingOnDisk.length)
    throw new Error(`Applied migration file is missing on disk: ${plan.missingOnDisk.join(", ")}`);
  if (plan.outOfOrder.length)
    throw new Error(`Pending migration sorts before an applied one: ${plan.outOfOrder.join(", ")}`);
}
