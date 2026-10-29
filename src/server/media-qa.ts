import "server-only";
import type { MediaQaRepository } from "@/data/media-qa-repository";
import type { MemoryRepository } from "@/data/memory-repository";
import { PostgresMediaQaData } from "@/data/media-qa-postgres";
import { rlsPreamble } from "@/data/postgres-repository";
import { MockContinuityAnalyzer, type ContinuityAnalyzer } from "@/domain/continuity/analyzer";
import type { MemoryMediaQaService } from "@/data/media-qa-memory";
import {
  analyzerStatuses,
  createAnalysisProviders,
  createPreviewProviders,
  readAnalysisConfig,
  type AnalysisConfig,
  type AnalyzerStatus,
} from "@/continuity/analysis/registry";
import type { ContinuityAnalysisProvider } from "@/continuity/analysis/provider";
import type { AutoQaDeps } from "@/continuity/automation";
import type { AnalyzerAvailability } from "@/domain/continuity/automation";
import { ContinuityAnalysisWorker } from "@/continuity/analysis/worker";
import {
  FakeGeminiTransport,
  answerAll as geminiAnswerAll,
} from "@/continuity/providers/gemini/fake-transport";
import { FakeOpenAITransport, openaiAnswerAll } from "@/continuity/providers/openai/fake-transport";
import { consoleLogger } from "@/generation/log";
import { LocalDiskSink } from "@/generation/sink";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import type { DeliveryDeps } from "@/media/delivery";
import type { MediaProcessor } from "@/media/types";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";
import { getUploadStorage } from "./storage";

declare global {
  var __prismMediaProcessor: MediaProcessor | undefined;
  var __prismAnalysisProviders: Map<string, ContinuityAnalysisProvider> | undefined;
  var __prismInlineAnalysisWorker: { stop(): void } | undefined;
}

export function getAnalysisConfig(): AnalysisConfig {
  return readAnalysisConfig(process.env);
}

/** Analyzer states for the UI: booleans/enums only, never credentials. */
export function getAnalyzerStatuses(): AnalyzerStatus[] {
  return analyzerStatuses(process.env);
}

/** Providers for plan/estimate previews (includes analyzers that are not runnable here). */
export function getPreviewProviders(): Map<string, ContinuityAnalysisProvider> {
  return createPreviewProviders(process.env);
}

/**
 * Deterministic in-memory transports instead of the network, for the acceptance E2E only. Honoured in MEMORY
 * persistence mode (the local demo, no database) and never otherwise, so a stray variable can never make a
 * Supabase/production deployment return invented analyses. A fake transport cannot spend anything.
 */
function fakeAnalysisTransportsEnabled(): boolean {
  return process.env.PRISM_STUDIO_ANALYSIS_TRANSPORT === "fake" && persistenceMode() === "memory";
}

export function getAnalysisProviders(): Map<string, ContinuityAnalysisProvider> {
  globalThis.__prismAnalysisProviders ??= createAnalysisProviders(
    process.env,
    fakeAnalysisTransportsEnabled()
      ? {
          transport: new FakeGeminiTransport(geminiAnswerAll("pass")),
          openaiTransport: new FakeOpenAITransport(openaiAnswerAll("pass")),
        }
      : {},
  );
  return globalThis.__prismAnalysisProviders;
}

/**
 * Memory/demo mode has no database to share with a separate worker, so the demo server runs the SAME worker
 * loop in-process (Supabase mode never does: use `npm run continuity:worker`).
 */
function ensureInlineAnalysisWorker(service: MemoryMediaQaService) {
  if (globalThis.__prismInlineAnalysisWorker || process.env.PRISM_STUDIO_INLINE_WORKER === "0") return;
  const cfg = getAnalysisConfig();
  const sink = new LocalDiskSink();
  const worker = new ContinuityAnalysisWorker({
    store: service,
    providers: getAnalysisProviders(),
    media: { read: async (ref) => (ref.objectPath ? sink.get(ref.objectPath) : null) },
    processor: getMediaProcessor(),
    logger: consoleLogger,
    paid: cfg.paid,
    maxTransportCalls: cfg.limits.maxTransportCalls,
    maxCorrections: cfg.limits.maxCorrections,
    workerId: "inline-demo-continuity-worker",
    idlePollMs:
      Number(process.env.PRISM_STUDIO_WORKER_IDLE_POLL_MS) > 0
        ? Number(process.env.PRISM_STUDIO_WORKER_IDLE_POLL_MS)
        : 1500,
  });
  const controller = new AbortController();
  void worker.run(controller.signal);
  globalThis.__prismInlineAnalysisWorker = { stop: () => controller.abort() };
}

/**
 * Derivations + continuity QA for the CURRENT user (RLS-bound in Supabase mode). In memory mode the default also starts
 * the demo's in-process analysis worker, so a path that creates or submits work gets it processed. A pure READ (a page
 * that only lists facts) passes `{ startInlineWorker: false }`: the same store, and visiting the page never starts the
 * worker, so it can never begin an already queued job. Supabase mode has no inline worker either way.
 */
export async function getMediaQaRepo(opts: { startInlineWorker?: boolean } = {}): Promise<MediaQaRepository> {
  if (persistenceMode() === "memory") {
    const service = ((await getRepo()) as MemoryRepository).mediaQa;
    if (opts.startInlineWorker !== false) ensureInlineAnalysisWorker(service);
    return service;
  }
  const user = await requireUser();
  return new PostgresMediaQaData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

export function getMediaProcessor(): MediaProcessor {
  globalThis.__prismMediaProcessor ??= new FfmpegMediaProcessor();
  return globalThis.__prismMediaProcessor;
}

/**
 * Analyzer for new QA runs. Only the Mock analyzer exists in Phase 2C; it is always labelled MOCK ANALYSIS.
 * `PRISM_STUDIO_CONTINUITY_ANALYZER=none` runs deterministic checks only.
 */
export function getContinuityAnalyzer(): ContinuityAnalyzer | null {
  return process.env.PRISM_STUDIO_CONTINUITY_ANALYZER === "none" ? null : new MockContinuityAnalyzer();
}

/** Safe availability facts for the Shot QA automation gates (no credentials). */
export function getAnalyzerAvailability(): AnalyzerAvailability[] {
  return getAnalyzerStatuses().map((s) => ({
    id: s.id,
    usable: s.usable || s.kind === "mock",
    kind: s.kind,
    missingConfig: s.missingConfig,
  }));
}

/**
 * Phase 3A.2: everything an automatic reconciliation needs, under the CURRENT user's session (owner RLS). The global
 * spend policy and limits come from the server's own configuration, never from a client or a Project.
 */
export async function getAutoQaDeps(userId: string | null): Promise<AutoQaDeps> {
  const config = getAnalysisConfig();
  return {
    ...(await getDeliveryDeps(userId)),
    providers: getAnalysisProviders(),
    availability: getAnalyzerAvailability(),
    paid: config.paid,
    limits: config.limits,
  };
}

/** Media processing runs in the app server under the user's own session: no extra worker privileges. */
export async function getDeliveryDeps(userId: string | null): Promise<DeliveryDeps> {
  return {
    processor: getMediaProcessor(),
    storage: await getUploadStorage(),
    qa: await getMediaQaRepo(),
    userId,
  };
}
