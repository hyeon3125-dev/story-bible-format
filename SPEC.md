# Story Bible Format 1.1.0

A package contains the following required artifacts at its root:

- `WORLD_BIBLE.md`: human-editable canonical overview
- `canon.json`: facts and author decisions
- `relationships.json`: staged changes between character pairs
- `timeline.json`: ordered events and causes
- `voice-guide.json`: character voice and stage-sensitive address terms
- `source-index.json`: paragraph locations and SHA-256 evidence hashes
- `OPEN_QUESTIONS.md`: unresolved and conflicting questions
- `LLM_CONTEXT.md`: budgeted, portable context
- `manifest.json`: format version and integrity hashes

Status semantics:

- `LOCKED`: explicitly confirmed by a user; models must never create it
- `OBSERVED`: directly supported by one or more source paragraph hashes
- `INFERRED`: model interpretation, not confirmed canon
- `OPEN`: intentionally undecided
- `CONFLICT`: evidence disagrees
- `SEALED`: confirmed but disclosure is limited by story position

Consumers must preserve `LOCKED` values, must not present `INFERRED`/`OPEN`/`CONFLICT` as canon, and should enforce reveal timing for `SEALED`. All `OBSERVED` records must carry at least one evidence reference resolvable in `source-index.json`.

## Optional 1.1 continuation handoff

Version 1.1 packages may add:

- `story-project.json`: the minimal `scalar.story-project.v2` cursor used to continue an accepted story.
- `manuscript/<language>/*.md`: user-accepted generated episodes only. Imported source prose is not duplicated by default.

Every optional file must be listed in `manifest.json.outputHashes`. A 1.0 consumer may ignore these files and continue using the nine required artifacts. A 1.1 consumer must validate `story-project.json`, keep stable scene IDs, and treat only episodes listed in `acceptedEpisodes` as accepted narrative history.

Each accepted episode uses this canonical UTF-8/LF envelope, with one trailing newline:

```markdown
---
chapter_id: episode-001
status: accepted
---

<!-- scene:S-001 -->

# Episode title

Prose begins here.
```

`id`, `sceneId`, and `title` must match the envelope. `characterCount` and `contentHash` cover only the prose after the title, including internal whitespace but excluding the envelope and final newline. `sourceRevisionHash`, `contentHash`, and a valid `acceptedAt` are required. Episode paths must use `canonicalLanguage`; `currentEpisodeId` must identify an accepted episode; `nextSceneId` must be numerically greater than every accepted `sceneId`; relationship validity events must exist in `timeline.json`; and `manifest.sourceHashes` must exactly match `source-index.json`.

Relationship stages may include `validFromEventId` and `validToEventId`. Consumers choose the stage valid at the current timeline event and must not leak a later address term into an earlier scene.
