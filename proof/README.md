# Long-form validation receipts

These receipts support the narrow claim that the workflow was used to finish and validate two long Korean manuscripts totalling 700,545 characters. They do **not** claim that an AI system had zero drift or that both works were created inside the Story Bible app.

The public receipt can be reproduced at its pinned commit:

```bash
python3 tools/verify_rebuild.py game/script.js manuscript/SNZ_KO_Part*.md -a tools/annotations/base.json -a tools/annotations/ko.json
python3 tools/verify_integrity.py game/script.js manuscript/SNZ_KO_Part*.md -a tools/annotations/base.json -a tools/annotations/ko.json
node tools/validate_graph.mjs game/script.js
python3 tools/check_seals.py
```

The second receipt intentionally exposes only counts, the validation result, and a payload hash. Do not present it as independently auditable public proof.
