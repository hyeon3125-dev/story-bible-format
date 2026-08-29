# Story Bible Format

An open ZIP/directory format for evidence-backed fiction world bibles. It separates author-confirmed canon from source observations, model inferences, unresolved questions, conflicts, and spoiler-sealed facts.

## Validate

Requires Node.js 22 or newer.

```sh
npx @scalar-atelier/story-bible-format ./my-story-bible.zip
```

The validator checks required files, JSON Schemas, source evidence shape, every output SHA-256 listed in `manifest.json`, and the optional 1.1 continuation handoff. It rejects path traversal, symlinks, oversized files, and oversized archives. It never uploads manuscript content.

See [SPEC.md](SPEC.md), the 1.0 Korean address-change example in `examples/korean-address-change`, and the 1.1 continuation handoff in `examples/korean-continuation-handoff`.

Long-form workflow evidence and its claim boundary live in [`proof/`](proof/README.md).
