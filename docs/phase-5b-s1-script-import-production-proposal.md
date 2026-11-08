# Phase 5B Story Intelligence S1: Script import → Production Proposal

> Idea / Script / Upload → **Analyze with Prism AI** → Production Proposal → the creator reviews → **Apply selected** →
> Characters, Locations, an Episode, Scenes and Shots exist.

Story Intelligence has its own integration line, `phase-5b-story-intelligence`, a sibling of the image pipeline. It was
created from `phase-5b-image-pipeline` at `4773dd4` (I1–I6).

**The model never writes Prism records.** It returns a versioned, strictly validated Production Proposal. Prism stores
the proposal immutably, and deterministic application code creates only what the creator selected. S1 is not Phase 6:
nothing is rewritten, generated or applied autonomously.

## 1. Starting modes (Import Story page)

| Mode                 | What is stored                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paste script         | the normalized text, frozen on the proposal row                                                                                                          |
| Upload file          | the original file as an immutable project Asset (`type`/`purpose` `document`, filename, MIME, checksum, size), plus the extracted text frozen on the row |
| Episode script       | a snapshot of that Episode's script text (no re-upload)                                                                                                  |
| An uploaded document | re-analysis of an earlier source Asset of this project (never another project's)                                                                         |

**Extraction** (`src/story/extract.ts`) uses no dependencies (`node:zlib` only). It is bounded, and it never guesses:

- **TXT / Fountain / Markdown:** strict UTF-8; NUL bytes or invalid UTF-8 are refused.
- **DOCX:** `word/document.xml` read from the ZIP container, with zip-bomb limits.
- **PDF (text-based):** Flate streams, object streams, the page tree in order, literal and hex strings, and ToUnicode
  font maps. Pages are kept as a page map, so citations can read "pages 1–3".
  - A PDF whose pages are images without text reports `This PDF appears to require OCR`.
  - Text that cannot be decoded is refused. There is no OCR pipeline in S1.
- **Final Draft (FDX):** not supported.

## 2. Provider architecture

```text
Import Story (web) ──queue──▶ story_proposals (frozen input) ◀──claim── Story worker ──▶ StoryIntelligenceProvider
                                                                                         ├─ OpenAIStoryProvider (first)
                                                                                         ├─ (Claude: same interface, later)
                                                                                         └─ FakeStoryProvider (free, tests)
```

`StoryIntelligenceProvider` (`src/story/provider.ts`) is provider-neutral:

- `analyze` takes source text and returns a Prism `ProductionProposal`.
- The same call with `revise: { previous, section, note }` is `reviseProposal` / `analyzeSection`: it regenerates one
  section.
- No vendor response shape crosses the interface.

**OpenAI** (`src/story/providers/openai.ts`) reuses Prism's existing, verified OpenAI Responses transport:

- the pinned `openai@7.32.0`, with SDK retries off and `store: false`;
- Structured Outputs with a strict JSON schema;
- the verified `gpt-6-luna` model and pricing configuration (2026-10-13).

There is no new SDK and no new price source. Each analysis makes at most two calls: the answer, plus one correction turn
carrying Prism's validation errors. A timeout or network failure is ambiguous and is never re-sent. Rate limits retry
later, up to three attempts in total.

The UI says **Prism AI**. Advanced shows the model, provider, price per 1M tokens and availability. The human chooses
the model; it is never substituted.

### Secret boundary

- `PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY` is read only by the Story worker. It is never `NEXT_PUBLIC_*`, never in the
  browser, and never in a row, log or error.
- In Supabase mode the web only lists and prices models and queues proposals. `scripts/story-worker.mts`
  (`npm run worker:story`) is the only caller.
- The worker connects as the new least-privilege role `prism_story_worker`. It can see only proposals in flight, can
  write only result columns, and has no access to Characters, Locations, scripts or Assets. It fails closed without its
  credential and refuses to run as any other role.
- Memory / demo mode runs the same worker loop in-process, exactly like the generation worker.

### Cost

Before a paid analysis, Prism shows the estimate:

> Estimated cost: $X (about N input tokens and up to M output tokens with GPT-6 Luna). Enter X in "Confirm total" to
> analyse.

The estimate is a ceiling: input tokens plus the whole output budget. Paid analysis is off unless
`PRISM_STUDIO_ALLOW_PAID_STORY_AI=true`, and is capped by `PRISM_STUDIO_STORY_AI_MAX_USD`. The worker re-checks the gate
against the frozen estimate and confirmation. The free test analyser needs no confirmation. Actual usage and cost are
recorded on the proposal.

## 3. The Production Proposal (`prism.production-proposal.v1`)

`src/domain/story/proposal.ts` holds a strict Zod schema and a hand-written strict JSON schema for Structured Outputs.
A test walks both to keep them in lockstep.

| Section    | Fields                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| story      | title, logline, synopsis, tone, genre, languages, notes                                                                                              |
| characters | key, name, role, description, age range, personality, relationships, Look suggestions, visual notes, sources, confidence, ambiguity                  |
| locations  | key, name, description, INT / EXT / INT/EXT / unknown, time / state notes, recurring set, sources, confidence, ambiguity                             |
| scenes     | key, order, heading, Location, time of day, summary, purpose, Characters, beats (beat / emotional turn / key action), sources, confidence, ambiguity |
| shots      | key, Scene, order, purpose, Characters, Location, rough visual intent, sources (deliberately minimal: S4 / S5 plan shots)                            |

**Validation** (`validateProposal`) runs before anything is stored:

1. JSON, then the strict schema;
2. referential integrity: unique keys, every reference resolves, Scene order 1..n with no gaps;
3. every source range lies inside the input.

A malformed answer is never partially persisted. The proposal is either stored whole or the attempt fails.

**Instructions** (`src/story/prompt.ts`, `story-analyst-v1`): a film / script production analyst that extracts,
normalizes, identifies and structures. It writes "unknown" / "unspecified" instead of inventing facts.

**Import safety:**

- The instructions are static and carry no project text.
- The source is a delimited block, declared as content, never instructions.
- The answer is constrained by the schema and validated again by Prism.

## 4. Persistence and versioning (migration 0054, local only)

There is one table, `story_proposals`, with one row per immutable proposal version. Each row records:

- the source kind, source Asset or Episode, source fingerprint (SHA-256 of the analysed text), source metadata, and the
  frozen text;
- the provider, model, schema version and prompt version;
- the estimate, confirmation and timestamps;
- the version and parent;
- the status: `queued`, `running`, `ready`, `failed` or `applied`.

The rules, enforced in the database by trigger as well as in the repository twins:

- The input never changes.
- The result is written once, by the worker only.
- The creator changes only the review, and only while the proposal is `ready`.
- `ready → applied` happens once, and freezes the review.
- A revision (regenerate the whole proposal, or one section) is a new row: version + 1 with `parent_id`. A section
  revision freezes the proposal it revises (`base_proposal`), so the worker reads only its own row. Review decisions
  carry over for items that still exist.
- There is no delete policy: proposals are history.
- The source Asset is pinned: Delete refuses while a proposal references it.

The worker sees a row while it is queued or running, or while its lease is valid. That is the same "visibility follows
active work" rule as 0017.

## 5. Traceability, matching, review

**Why did Prism create this?** Every item cites line ranges, or pages for a PDF. The review shows "lines 12–18" plus a
short excerpt read from the stored source. No source text is duplicated into the proposal.

**Matching** (`src/domain/story/review.ts`) runs on the web, against the project's current records:

- An exact name match (normalized; V.O. / O.S. marks ignored) defaults to Use existing.
- A plural, spelling or partial match is only a possible match: Apply refuses until the creator chooses Use existing,
  Create new, or Merge.
- Merge only fills fields the existing record leaves empty. Nothing is merged automatically.

**Review page** (creator language, not JSON):

- Story: title, logline and synopsis, all editable.
- Characters, Locations, Scenes and suggested Shots. Each item has:
  - an include box and a Reject box;
  - its confidence and ambiguity;
  - the possible-match choice;
  - its sources;
  - an Edit disclosure.
- Select all / Deselect all.
- The target: a new Episode, or the end of an existing one.
- Save review; **Apply selected**.
- Regenerate: the whole proposal or one section, with an optional note, as a new version.

Provider, model, schema, prompt, fingerprint and cost sit under Advanced.

## 6. Apply selected (`src/domain/story/apply.ts`)

Apply is deterministic code, and the same schemas as the app's own actions:

- Only selected, not rejected items are applied.
- **Characters and Locations** are created, reused (Use existing) or merged (fill empty fields only). A locked Location
  is never merged.
- **A new Episode** (`ep-N`) whose script is the analysed text, so each Scene's line range points into it. Alternatively,
  Scenes are appended to an existing Episode without touching its script.
- **Scenes** follow the proposal's order, with heading, INT/EXT, Location, time of day, summary, purpose and Characters.
- **Shots** (`3A`, `3B`, …) are created under applied Scenes, with purpose as the story beat, rough visual intent as the
  composition notes, the Characters, and the Location, using the project aspect ratio.
- No Look, image, Production Frame or continuity is created.
- Ids derive from (proposal, item), so applying is deterministic, and a proposal applies only once.

## 7. Ojou-sama acceptance

**Source:** the seeded Episode 1 screenplay. With the free test analyser it yields:

- **Characters (5):** Yumeko, Sean, Takumi, Reporter, Mother (from `MOTHER (V.O.)`);
- **Locations (5):** Tokyo Night Streets, Grand Celeste Hotel Canopy, Grand Celeste Lobby, Sky-View Restaurant, Hotel
  Hallway;
- **Scenes (6):** in order, Scene 3 being `INT. GRAND CELESTE LOBBY - NIGHT`;
- **Suggested Shots:** including, in Scene 3, Yumeko in the Lobby (the structure of Shot 3A).

**Into the Ojou-sama project:** Yumeko and the Lobby are exact matches and are reused, never duplicated. The new
Episode's Lobby Scene points at the existing Lobby and the existing Yumeko.

**Into an empty project:** 3 Characters (Mother deselected, Reporter rejected), 5 Locations, 1 Episode, 6 ordered
Scenes and the Shots, with the edited Scene summary. Then:

- the created Characters and Locations work in the Visual Bible (I4 / I5);
- a created Character plans an image (I1);
- the created Lobby Shot reads its Production Frame Inputs (I6): "Yumeko", "Grand Celeste Lobby".

## 8. Tests

| Area               | Test file                                              | Covers                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema and apply   | `src/domain/__tests__/story-proposal.test.ts`          | schema lockstep and keywords; malformed output; traceability; matching; deterministic apply; deselect, reject and edit; merge; target Episode                                                                                   |
| Extraction         | `src/story/__tests__/extract.test.ts`                  | TXT, Fountain, DOCX, PDF (plain and ToUnicode), OCR-needed, undecodable                                                                                                                                                         |
| OpenAI adapter     | `src/story/__tests__/openai-story.test.ts`             | fake transport; one-call contract; correction turn; ambiguous timeout; rate limit; refusal; no key, so zero calls; registry and estimate                                                                                        |
| Acceptance         | `src/server/__tests__/story-import.test.ts`            | the real actions, worker and memory repository: paste, TXT, PDF and re-analysis; immutable source; a foreign source refused; malformed output; matches; review and apply; frozen after apply; section versioning; the paid gate |
| Migration (static) | `src/data/__tests__/migration-0054.test.ts`            | the migration file itself; 0051–0053 checksums                                                                                                                                                                                  |
| Database           | `scripts/db-story-proposals.mts` (disposable Postgres) | RLS; immutability; worker role and lease visibility; apply-once                                                                                                                                                                 |
| Browser            | story K                                                | paste → analyse → review (deselect, edit) → apply → the created Shot's Production Frame Inputs                                                                                                                                  |
