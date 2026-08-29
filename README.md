# Story Bible Format

An open ZIP/directory format for evidence-backed fiction world bibles. It separates author-confirmed canon from source observations, model inferences, unresolved questions, conflicts, and spoiler-sealed facts.

## Validate

Requires Node.js 22 or newer.

```sh
npx @scalar-atelier/story-bible-format ./my-story-bible.zip
```

The validator checks required files, JSON Schemas, source evidence shape, every output SHA-256 listed in `manifest.json`, the optional 1.1 continuation handoff, and the optional 1.2 local provenance chain. Version 1.2 also requires the manifest inventory to exactly match the package. It rejects path traversal, symlinks, oversized files, and oversized archives. It never uploads manuscript content.

See [SPEC.md](SPEC.md), the 1.0 Korean address-change example in `examples/korean-address-change`, the 1.1 continuation handoff in `examples/korean-continuation-handoff`, and the 1.2 valid/invalid provenance vectors in `test/fixtures`.

Provenance records contain pseudonymous references and hashes, not source text, titles, prompts, or recipient data. They record integrity, issue timing, production decisions, and distribution clues; they are not proof of copyright ownership.

Long-form workflow evidence and its claim boundary live in [`proof/`](proof/README.md).
