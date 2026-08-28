# Story Bible Format

An open ZIP/directory format for evidence-backed fiction world bibles. It separates author-confirmed canon from source observations, model inferences, unresolved questions, conflicts, and spoiler-sealed facts.

## Validate

Requires Node.js 22 or newer.

```sh
npx @scalar-atelier/story-bible-format ./my-story-bible.zip
```

The validator checks required files, JSON Schemas, source evidence shape, and every output SHA-256 listed in `manifest.json`. It never uploads manuscript content.

See [SPEC.md](SPEC.md) and the synthetic Korean address-change example in `examples/korean-address-change`.
