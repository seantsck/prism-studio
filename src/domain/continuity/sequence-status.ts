/**
 * What the Continuity Supervisor may learn about Prism's own analysis jobs while it is open (Phase 3A.4F): enough to
 * notice that this edit's jobs moved or that the Project's shared capacity changed, and nothing else. Built field by
 * field, so a provider payload, snapshot, manifest or provider reference can never reach the browser through it.
 *
 * Polling only ever causes a page refresh. It queues, derives, spends and calls nothing: after the refresh the server
 * re-reads the truth, and `SequenceAutoReconciler` remains the only thing that asks for a wave.
 */

export interface SafeJobState {
  id: string;
  subjectKind: "attempt" | "transition";
  status: string;
}

export interface SequenceStatus {
  /** this edit's transition jobs, active or not */
  edit: { active: number; jobs: Array<{ id: string; status: string }> };
  /** every ACTIVE job of the Project, across Shot QA and every edit: the shared capacity */
  project: { active: number; jobs: SafeJobState[] };
  /** changes exactly when one of the above does */
  signature: string;
}

/** `isActive` is injected so this stays free of the job-state module's dependencies. */
export function sequenceStatusOf(args: {
  editJobs: ReadonlyArray<{ id: string; status: string }>;
  projectActiveJobs: readonly SafeJobState[];
  isActive: (status: never) => boolean;
}): SequenceStatus {
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const editJobs = args.editJobs.map(({ id, status }) => ({ id, status })).sort(byId);
  const projectJobs = args.projectActiveJobs
    .map(({ id, subjectKind, status }) => ({ id, subjectKind, status }))
    .sort(byId);
  return {
    edit: { active: editJobs.filter((j) => args.isActive(j.status as never)).length, jobs: editJobs },
    project: { active: projectJobs.length, jobs: projectJobs },
    signature: [
      `edit:${editJobs.map((j) => `${j.id}:${j.status}`).join(",")}`,
      `project:${projectJobs.map((j) => `${j.id}:${j.subjectKind}:${j.status}`).join(",")}`,
    ].join("|"),
  };
}

/**
 * Poll only while a change could matter: this edit has active Sequence jobs, or Sequence Automatic has settled due work
 * waiting for shared capacity. Never because cuts are settling, and never in off mode or before migration 0047.
 */
export function shouldPollSequenceStatus(args: {
  mode: "off" | "suggest" | "automatic";
  ready: boolean;
  editActive: number;
  capacityBlocked: boolean;
}): boolean {
  if (!args.ready || args.mode === "off") return false;
  return args.editActive > 0 || (args.mode === "automatic" && args.capacityBlocked);
}

export const SEQUENCE_STATUS_POLL_MS = 3000;

/**
 * The poller's behaviour, without React. It remembers the signature the server RENDERED, so a job that finished before
 * the first poll is noticed on that first response. It refreshes once per change: the signature it saw becomes the new
 * baseline, so a stable state cannot loop. A failed read changes nothing.
 */
export function createSequenceStatusPoller(args: {
  initialSignature: string;
  fetchSignature: () => Promise<string | null>;
  refresh: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: never) => void;
  intervalMs?: number;
}) {
  let baseline = args.initialSignature;
  let stopped = false;
  const tick = async () => {
    const signature = await args.fetchSignature().catch(() => null);
    if (stopped || signature === null || signature === baseline) return;
    baseline = signature;
    args.refresh();
  };
  const handle = args.setInterval(() => void tick(), args.intervalMs ?? SEQUENCE_STATUS_POLL_MS);
  return {
    tick,
    /** a refreshed page rendered this signature */
    rendered(signature: string) {
      baseline = signature;
    },
    stop() {
      stopped = true;
      args.clearInterval(handle as never);
    },
  };
}
