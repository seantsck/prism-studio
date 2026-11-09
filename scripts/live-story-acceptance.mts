import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { PostgresWritingData } from "../src/data/writing-postgres";
import { canonical, estimateWritingInputTokens, scopeOf, sceneRanges, WRITING_SCHEMA_VERSION, writingOutputTokens } from "../src/domain/story/writing";
import { sourceFingerprint } from "../src/domain/story/source";
import { buildWritingContext } from "../src/story/writing-context";
import { WRITING_INSTRUCTIONS, WRITING_PROMPT_VERSION, writingInput } from "../src/story/writing-prompt";
import { createStoryRegistry } from "../src/story/registry";
import { estimateUsd } from "../src/story/provider";

const SESSION_ID = "4abf0e6b-56bc-4d93-8d75-dcaa3e20b689";
const PROPOSAL_ID = "aca5ce82-c39a-49ce-ab0a-ef1e06e55d3a";
const INSTRUCTION = "Make Yumeko more guarded and emotionally restrained without changing what happens in the scene.";
const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error("SUPABASE_DB_URL missing");

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
try {
  const projectRow = await pool.query("select id, user_id from projects where slug='ojousama' limit 1");
  const projectId = String(projectRow.rows[0]?.id ?? "");
  const owner = String(projectRow.rows[0]?.user_id ?? "");
  if (!projectId || !owner) throw new Error("Ojou-sama project/owner not found");

  const active = await pool.query(`
    select
      (select count(*)::int from story_proposals where status in ('queued','running')) as story,
      (select count(*)::int from writing_proposals where status in ('queued','running')) as writing,
      (select count(*)::int from shot_list_proposals where status in ('queued','running')) as shot_lists,
      (select count(*)::int from shot_direction_proposals where status in ('queued','running')) as directions
  `);
  const counts = active.rows[0] ?? {};
  if (Object.values(counts).some((n) => Number(n) !== 0))
    throw new Error("Story queues are not empty: " + JSON.stringify(counts));

  const admin = new AdminRepository(pool, owner);
  const data = await admin.loadProject("ojousama");
  if (!data) throw new Error("Ojou-sama project data not found");
  const episode = data.episodes.find((e) => e.number === 1);
  if (!episode) throw new Error("Ojou-sama Episode 1 not found");
  const scene = data.scenes.find((s) => s.episodeId === episode.id && s.sceneNumber === "6");
  if (!scene) throw new Error("Ojou-sama Scene 6 not found");

  const repo = new PostgresWritingData(pool, "begin");
  const prior = await repo.getProposal(projectId, PROPOSAL_ID);
  if (prior) {
    console.log("STORY_ACCEPTANCE_ALREADY_EXISTS=" + JSON.stringify({
      proposalId: prior.id,
      status: prior.status,
      provider: prior.provider,
      model: prior.model,
      estimateUsd: prior.estimate.usd,
      actualUsd: prior.actualUsd,
      providerCalls: prior.providerCalls,
      error: prior.error
    }));
    process.exitCode = 0;
  } else {
    const text = canonical(episode.scriptText);
    const range = sceneRanges(text, data, episode.id).get(scene.id);
    if (!range) throw new Error("Scene 6 range not found in canonical screenplay");
    const scope = scopeOf(text, "scene", range, scene.id);
    const targetText = text.slice(scope.start, scope.end);
    if (!targetText.trim()) throw new Error("Scene 6 target is empty");

    const context = buildWritingContext({
      data,
      episode,
      text,
      scope,
      instruction: INSTRUCTION,
      conversation: [],
    });
    const env = {
      ...process.env,
      PRISM_STUDIO_STORY_AI_PROVIDERS: "openai",
      PRISM_STUDIO_ALLOW_PAID_STORY_AI: "true",
      PRISM_STUDIO_STORY_AI_MAX_USD: "0.01",
    };
    const registry = createStoryRegistry(env);
    const model = registry.model("openai", "gpt-6-luna");
    if (!model) throw new Error("gpt-6-luna missing from Prism Story registry");
    const promptText = writingInput({
      mode: "rewrite",
      instruction: INSTRUCTION,
      count: 1,
      scopeKind: "scene",
      context,
      targetText,
      draftText: null,
    });
    const inputTokens = estimateWritingInputTokens(WRITING_INSTRUCTIONS, promptText);
    const maxOutputTokens = writingOutputTokens("rewrite", 1, targetText.length, model.maxOutputTokens || 32_000);
    const usd = estimateUsd(model, inputTokens, maxOutputTokens);
    if (usd > 0.003) throw new Error("Story estimate exceeded acceptance ceiling: $" + usd.toFixed(4));
    if (usd > 0.01) throw new Error("Story estimate exceeded worker hard cap");

    const session = (await repo.getSession(projectId, SESSION_ID)) ?? await repo.createSession({
      id: SESSION_ID,
      projectId,
      episodeId: episode.id,
      title: "Phase 5B real Story acceptance",
      createdBy: owner,
      createdAt: new Date().toISOString(),
    });
    if (session.episodeId !== episode.id) throw new Error("Acceptance session points at another Episode");

    const revisions = await repo.listRevisions(projectId, episode.id);
    const latest = revisions[0];
    const fingerprint = sourceFingerprint(text);
    const createdAt = new Date().toISOString();
    const proposal = await repo.createProposal({
      id: PROPOSAL_ID,
      projectId,
      sessionId: session.id,
      episodeId: episode.id,
      parentId: null,
      parentAlternative: null,
      mode: "rewrite",
      scope,
      instruction: INSTRUCTION,
      alternativesRequested: 1,
      baseFingerprint: fingerprint,
      baseRevisionId: latest && sourceFingerprint(canonical(latest.text)) === fingerprint ? latest.id : null,
      targetText,
      draftText: null,
      context,
      provider: "openai",
      model: "gpt-6-luna",
      schemaVersion: WRITING_SCHEMA_VERSION,
      promptVersion: WRITING_PROMPT_VERSION,
      estimate: { inputTokens, maxOutputTokens, usd },
      confirmedUsd: usd,
      spendAuthorization: "confirmed",
      createdBy: owner,
      createdAt,
    }, { reserveUsd: null, now: createdAt });

    console.log("STORY_ACCEPTANCE_QUEUED=" + JSON.stringify({
      proposalId: proposal.id,
      sessionId: proposal.sessionId,
      episodeId: proposal.episodeId,
      sceneId: scene.id,
      sceneNumber: scene.sceneNumber,
      slugline: scene.slugline,
      targetLines: targetText.split("\n").length,
      inputTokens,
      maxOutputTokens,
      estimateUsd: usd,
      confirmedUsd: proposal.confirmedUsd,
      provider: proposal.provider,
      model: proposal.model,
      status: proposal.status
    }));
  }
} finally {
  await pool.end();
}
