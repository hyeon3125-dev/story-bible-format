# Story Bible Format 1.3.0

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

## Optional continuation handoff (1.1 through 1.3)

Versions 1.1 through 1.3 may add:

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

## Optional local provenance (1.2 and 1.3)

Versions 1.2 and 1.3 may add these exact paths:

- `provenance/ledger.json`: ordered acceptance/edit events validated by `provenance-ledger.schema.json` and `provenance-event.schema.json`.
- `provenance/anchor-ack.json`: one or more server acknowledgements validated by `anchor-ack.schema.json`; omit the file when none exist.
- `provenance/release-receipt.json`: a canonical release receipt validated by `release-receipt.schema.json`.
- `provenance/release-receipt.sig`: optional detached Ed25519 SSH signature bytes.
- `provenance/release-seal.ots`: optional OpenTimestamps proof bytes, allowed only with the signature and receipt.

If any provenance path is present, `provenance/ledger.json` is required. Unknown paths under `provenance/` are invalid. Every package file other than `manifest.json` must appear exactly once as a key in `manifest.outputHashes`, and every key must name a package file. This exact-inventory rule applies to 1.2 and 1.3; 1.0 and 1.1 retain their prior validation behavior.

### Event receipts and chain

The ledger root is `{schemaVersion, projectRef, events}`. Each event records a kind (`generation_accepted`, `human_revision`, `manual_import`, or `rights_reconfirmed`), pseudonymous event/project reference, the immediately preceding receipt hash, artifact/source/request SHA-256 values, execution mode (`managed`, `byok`, or `imported`), provider and model names, tool/source versions, contribution class (`ai_generated`, `human_edited`, or `manual`), before/after hashes and character deltas, the user's decision note, rights basis, creation/acceptance timestamps, explicit user confirmation, and anchor status. Prompt text is not a schema field. A `rights_reconfirmed` event records no prose change: it uses `manual`, identical non-null before/after hashes, and zero character deltas.

`receiptSha256` is lowercase SHA-256 over the event after removing `receiptSha256` and the derived `anchorStatus`, serialized as compact JSON with recursively sorted object keys, array order preserved, UTF-8 encoding, and no insignificant whitespace. The first `parentReceiptSha256` is `null`; every later value must equal the preceding event's `receiptSha256`. Excluding `anchorStatus` lets a failed server call later become anchored without rewriting the accepted-event receipt.

All timestamps use exact UTC millisecond form (`YYYY-MM-DDTHH:mm:ss.sssZ`). `acceptedAt` cannot precede `createdAt`; `human_revision` events require `beforeSha256`; `afterSha256` must equal `artifactSha256`. `userConfirmed` must be `true`. An anchor's server `receivedAt` is validated independently and is not ordered against the untrusted client clock.

For every accepted episode, at least one provenance event must bind either its canonical prose `contentHash` or the packaged manuscript file hash. Anchor acknowledgements are structurally validated by the public format validator; HMAC authenticity requires the server-side verifier key.

### Opaque server acknowledgements

`anchor-ack.json` is `{schemaVersion:"1.0.0", anchors:[...]}`. Each acknowledgement contains only `anchorId`, `receiptSha256`, `receivedAt`, `keyId`, and a lowercase 64-hex `hmac`. It cannot contain project titles, prompts, source text, provider/model details, or buyer/recipient identifiers. Each acknowledgement must resolve to exactly one ledger event marked `anchored`; an `unanchored` event must have no acknowledgement.

The format validator checks acknowledgement shape, timestamps, ledger references, package hashing, and status consistency. It cannot recompute the server HMAC without the server secret; online HMAC verification belongs to the anchor service.

### Canonical release receipt

The release receipt binds a pseudonymous project/release ID, clean source commit, rights basis, ledger-head receipt, creation time, and one or more `{path, sha256, bytes}` entries. Every listed path must be a safe, present, non-provenance package file whose bytes and SHA-256 match. The receipt file is recursively key-sorted compact JSON followed by one LF byte. Its creation time cannot precede the ledger head's acceptance time.

The validator treats `.sig` and `.ots` as opaque, non-empty artifacts and binds their exact bytes through `manifest.outputHashes`. Signature verification still requires the selected Ed25519 SSH public key, and an upgraded OpenTimestamps proof still requires a Bitcoin-chain verification method. Neither a timestamp nor this package establishes authorship, ownership, or permission to use third-party material.

## Optional creative objectives (1.3)

Version 1.3 adds `objectives.json`. It records a user-confirmed reader promise, one primary commercial objective, up to two secondary objectives, and a scene/episode/arc payoff cadence. Objective IDs are limited to next-episode pull, character attachment, emotional impact, memorable moments, payoff delivery, and pacing.

Objectives guide generation and report-only review. They are not canon, do not override `LOCKED` or `SEALED`, and must never turn a quality judgment into a package-validity or continuity verdict. A package containing `objectives.json` must use schema version 1.3.0 and hash the file; a 1.3 package must contain it. Versions 1.0 through 1.2 remain unchanged.
