import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { finalResultSchema, HEX64_RE, JOB_ID_RE, LEASE_ID_RE, UUID_RE } from "../protocol";
import { AgentStateError, writeFileAtomic } from "./store";

/**
 * The ONE active remote job of a profile (Phase 2F M2D.3C2), persisted in the profile directory next to agent.json:
 *
 *   active-job.json   safe facts only: device, project, job, attempt, lease id and expiry, the frozen source sizes
 *                     and checksums, the local run id, the stage reached, and the validated result's metadata once
 *                     there is one. No credential, no source content, no path, no user or host name.
 *
 * It is written atomically BEFORE each step that matters (leased → downloading → reconstructing → result_ready →
 * uploading), so a restarted agent knows exactly what happened: a validated, retained result may be uploaded; anything
 * else is reported failed (COLMAP/Brush are never silently re-run). While it exists the agent leases nothing else.
 */

export const JOB_STATE_SCHEMA = "prism.local-agent-job.v1" as const;
export const JOB_STATE_FILE = "active-job.json";

export const JOB_STAGES = ["leased", "downloading", "reconstructing", "result_ready", "uploading"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const jobStateSchema = z
  .object({
    schema: z.literal(JOB_STATE_SCHEMA),
    deviceId: z.string().regex(UUID_RE),
    projectId: z.string().regex(UUID_RE),
    jobId: z.string().regex(JOB_ID_RE),
    attempt: z.number().int().min(1),
    leaseId: z.string().regex(LEASE_ID_RE),
    leaseExpiresAt: z.string().max(40),
    sources: z
      .array(
        z
          .object({
            ordinal: z.number().int().min(0).max(299),
            mime: z.enum(["image/jpeg", "image/png"]),
            byteSize: z.number().int().min(1),
            sha256: z.string().regex(HEX64_RE),
          })
          .strict(),
      )
      .min(3)
      .max(300),
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    stage: z.enum(JOB_STAGES),
    result: finalResultSchema.nullable(),
    updatedAt: z.string().max(40),
  })
  .strict();
export type JobState = z.infer<typeof jobStateSchema>;

export async function readJobState(dir: string): Promise<JobState | null> {
  const text = await readFile(path.join(dir, JOB_STATE_FILE), "utf8").catch(() => null);
  if (text === null) return null;
  let parsed;
  try {
    parsed = jobStateSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success)
    throw new AgentStateError(
      `${JOB_STATE_FILE} is unreadable. Remove it (the job's attempt will fail when its lease expires).`,
    );
  return parsed.data;
}

export async function writeJobState(dir: string, state: JobState): Promise<void> {
  await writeFileAtomic(
    path.join(dir, JOB_STATE_FILE),
    `${JSON.stringify(jobStateSchema.parse(state), null, 2)}\n`,
  );
}

export async function clearJobState(dir: string): Promise<void> {
  await rm(path.join(dir, JOB_STATE_FILE), { force: true });
}
