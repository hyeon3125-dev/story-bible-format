import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("synthetic address-change package validates", () => {
  const result = spawnSync(process.execPath, ["bin/validate.mjs", "examples/korean-address-change"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid story-bible 1\.0\.0/u);
});

test("tampered outputs fail integrity validation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-"));
  await cp("examples/korean-address-change", dir, { recursive: true });
  await writeFile(join(dir, "WORLD_BIBLE.md"), "tampered");
  const result = spawnSync(process.execPath, ["bin/validate.mjs", dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch/u);
});
