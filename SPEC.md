# Story Bible Format 1.0.0

A package contains exactly the following required artifacts at its root:

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
