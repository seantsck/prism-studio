import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * One agent process per profile. Protocol v1 allows ONE in-flight signed request per device, and the request counter
 * is reserved from the profile's file, so two processes signing for the same device would race. A profile lock
 * (created exclusively) makes `pair`, `run` and `status` mutually exclusive. A lock whose process is gone is
 * recovered; a live holder is never killed; an unreadable lock is refused.
 */

export const LOCK_FILE = "agent.lock";

export class AgentLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLockError";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireProfileLock(
  dir: string,
  isAlive: (pid: number) => boolean = alive,
): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, LOCK_FILE);
  const token = randomBytes(8).toString("hex");
  const body = `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, body, { flag: "wx", mode: 0o600 });
      return async () => {
        const current = await readFile(file, "utf8").catch(() => null);
        if (current?.includes(`"token":"${token}"`)) await rm(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let holder: { pid?: unknown } | null = null;
    try {
      holder = JSON.parse(await readFile(file, "utf8"));
    } catch {
      holder = null;
    }
    const pid = holder && Number.isSafeInteger(holder.pid) ? (holder.pid as number) : null;
    if (pid === null)
      throw new AgentLockError(
        `The profile lock (${LOCK_FILE}) is unreadable. If no agent is running for this profile, delete it.`,
      );
    if (pid !== process.pid && isAlive(pid))
      throw new AgentLockError(
        `Another Local Agent process (pid ${pid}) is using this profile. Only one may run per profile.`,
      );
    // stale (its process is gone): move it aside atomically; a concurrent starter that did the same loses harmlessly
    const aside = `${file}.stale-${randomBytes(3).toString("hex")}`;
    if (
      await rename(file, aside).then(
        () => true,
        () => false,
      )
    )
      await rm(aside, { force: true });
  }
  throw new AgentLockError("Another Local Agent process took the profile lock at the same time.");
}
