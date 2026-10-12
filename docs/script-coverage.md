# Script traceability and coverage

Goal: for every action paragraph and dialogue line in the script, answer "which shot covers this?", and for
every shot, "which script content is it made from?". Everything is deterministic and manual; no AI decides
coverage.

## Data (migration 0008)

| Structure                                      | Purpose                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action_blocks`                                | Stable-id action paragraphs: `scene_id`, `episode_id`, `text`, `order`, `start_line`, `end_line`.                                                       |
| `dialogue_lines.source_start_line / _end_line` | Where the line sits in the episode script text.                                                                                                         |
| `shot_script_sources`                          | Join table: `(shot_id, action_block_id)` xor `(shot_id, dialogue_line_id)`, `position`. Unique per shot and element; cascades with shot, block or line. |
| RLS                                            | `action_blocks_owner` (by `project_id`), `shot_script_sources_owner` (through the shot).                                                                |

In the domain, `shot.scriptSources = { actionBlockIds, dialogueLineIds }` (`src/domain/schemas.ts`), mapped to
`shot_script_sources` by `shotToRows`.

## Stable ids across script edits (`syncScript`, `src/domain/script.ts`)

`parseScreenplay(text)` produces scenes with action and dialogue blocks; `syncScript` re-associates them with
existing ids so links survive edits:

| Element       | Match order                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene         | slugline (case-insensitive), then position                                                                                                                |
| Dialogue line | same speaker + same text, then next unused line of that speaker; **locked lines never change** (a differing script text is reported as a locked conflict) |
| Action block  | same text (survives reordering), then next unused block by position                                                                                       |

Elements not matched are reported as removed and deleted; links to them cascade away.

## Coverage (`src/domain/coverage.ts`)

An element is **covered** when at least one shot references it:

- action block: in some `shot.scriptSources.actionBlockIds`;
- dialogue line: in some `shot.scriptSources.dialogueLineIds` **or** in `shot.audio.dialogueLineIds`
  (a shot that performs the line covers it).

| Function                                | Result                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildSceneCoverage(data, sceneId)`     | Items sorted by source line, covered flag, covering shot ids/codes; `covered`, `total`, `percent`, `uncovered`; scene facts (location, time of day, characters, props). |
| `buildEpisodeCoverage(data, episodeId)` | Per-scene coverage plus episode totals. A scene with no script content is 100 %.                                                                                        |
| `shotSourceContent(data, shot)`         | Resolved action blocks and dialogue for a shot (linked sources plus performed lines).                                                                                   |

## UI

- **Breakdown** (`/projects/:p/breakdown`, `.../episodes/:e/breakdown`): per scene, coverage bar and
  `covered/total`, each script element with its covering shots (or an `uncovered` badge), and a form to select
  elements and either **create a new shot** from them or **link them to an existing shot** in the scene.
- **Shot Prep → 2 · Source script**: the linked content and linking controls.
- `createShotFromSources` copies the scene's location, sets `audio.dialogueLineIds` to the chosen lines, picks a
  shot code from the scene number and next letter, and opens the new shot. Selections outside the scene are
  ignored.
- The generation package copies source script by value into `sourceScript` so a snapshot stays readable
  ([generation-package](generation-package.md)).

## Rules and limits

- Shot creation from script is a **manual** action. AI may only propose selections in future; it never applies them.
- Coverage means "linked", not "adequately shot". A single shot covering ten paragraphs is 100 %.
- Preflight does not currently gate on coverage; it is a Breakdown-view signal.
- Source line numbers come from the last script parse; they are not recalculated when only a shot changes.
