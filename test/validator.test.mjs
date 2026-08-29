import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";

async function rewriteJson(dir, name, mutate) {
  const path = join(dir, name);
  const value = JSON.parse(await readFile(path, "utf8"));
  mutate(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  if (name === "manifest.json") return;
  await rewriteJson(dir, "manifest.json", (manifest) => {
    manifest.outputHashes[name] = createHash("sha256").update(JSON.stringify(value, null, 2) + "\n").digest("hex");
  });
}

function validate(path) {
  return spawnSync(process.execPath, ["bin/validate.mjs", path], { encoding: "utf8" });
}

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

test("1.1 continuation handoff validates", () => {
  const result = spawnSync(process.execPath, ["bin/validate.mjs", "examples/korean-continuation-handoff"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid story-bible 1\.1\.0/u);
});

test("1.0 rejects handoff files and directories reject symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-"));
  await cp("examples/korean-address-change", dir, { recursive: true });
  await writeFile(join(dir, "story-project.json"), "{}");
  let result = spawnSync(process.execPath, ["bin/validate.mjs", dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1\.1 handoff files require/u);

  const symlinkDir = await mkdtemp(join(tmpdir(), "story-bible-link-"));
  await cp("examples/korean-address-change", symlinkDir, { recursive: true });
  await symlink(join(symlinkDir, "WORLD_BIBLE.md"), join(symlinkDir, "linked.md"));
  result = spawnSync(process.execPath, ["bin/validate.mjs", symlinkDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink rejected/u);
});

test("ZIP paths reject normalized duplicates and Windows drives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-zip-"));
  const duplicate = new JSZip();
  duplicate.file("folder/file.md", "one", { createFolders: false });
  duplicate.file("folder\\file.md", "two", { createFolders: false });
  const duplicatePath = join(dir, "duplicate.zip");
  await writeFile(duplicatePath, await duplicate.generateAsync({ type: "nodebuffer" }));
  let result = spawnSync(process.execPath, ["bin/validate.mjs", duplicatePath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate path/u);

  const windows = new JSZip();
  windows.file("C:/escape.md", "bad");
  const windowsPath = join(dir, "windows.zip");
  await writeFile(windowsPath, await windows.generateAsync({ type: "nodebuffer" }));
  result = spawnSync(process.execPath, ["bin/validate.mjs", windowsPath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe path/u);
});

test("ZIP symlinks and incomplete integrity maps are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-integrity-"));
  const linked = new JSZip();
  linked.file("linked.md", "WORLD_BIBLE.md", { createFolders: false, unixPermissions: 0o120777 });
  const linkedPath = join(dir, "linked.zip");
  await writeFile(linkedPath, await linked.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
  let result = spawnSync(process.execPath, ["bin/validate.mjs", linkedPath], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink rejected/u);

  const packageDir = join(dir, "package");
  await cp("examples/korean-address-change", packageDir, { recursive: true });
  const manifestPath = join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.outputHashes["WORLD_BIBLE.md"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  result = spawnSync(process.execPath, ["bin/validate.mjs", packageDir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unhashed core file/u);
});

test("duplicate accepted episode ids or files are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-episodes-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  const projectPath = join(dir, "story-project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.acceptedEpisodes.push({ ...project.acceptedEpisodes[0], id: "episode-duplicate" });
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  const result = spawnSync(process.execPath, ["bin/validate.mjs", dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate accepted episode/u);
});

test("1.1 semantic references match app and harness consumers", async () => {
  let dir = await mkdtemp(join(tmpdir(), "story-bible-current-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "story-project.json", (project) => { project.currentEpisodeId = "missing"; });
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown currentEpisodeId/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-event-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "relationships.json", (relationships) => { relationships[0].validFromEventId = "missing"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown validFromEventId/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-language-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "story-project.json", (project) => { project.canonicalLanguage = "en"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /language mismatch/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-next-scene-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "story-project.json", (project) => { project.nextSceneId = "S-000"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nextSceneId must follow/u);
});

test("1.1 requires canonical episode metadata and source hashes", async () => {
  let dir = await mkdtemp(join(tmpdir(), "story-bible-revision-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "story-project.json", (project) => { delete project.acceptedEpisodes[0].sourceRevisionHash; });
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sourceRevisionHash/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-date-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "story-project.json", (project) => { project.acceptedEpisodes[0].acceptedAt = "2026-02-30T00:00:00.000Z"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid acceptedAt/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-source-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "manifest.json", (manifest) => { manifest.sourceHashes = []; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source hashes/u);
});

test("accepted episode envelope and prose-only hash are deterministic", async () => {
  let dir = await mkdtemp(join(tmpdir(), "story-bible-envelope-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  const episode = "manuscript/ko/episode-001.md";
  const path = join(dir, episode);
  const tampered = (await readFile(path, "utf8")).replace("# 제1화. 멈출지, 맞설지", "# 다른 제목");
  await writeFile(path, tampered);
  await rewriteJson(dir, "manifest.json", (manifest) => {
    manifest.outputHashes[episode] = createHash("sha256").update(tampered).digest("hex");
  });
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /metadata mismatch/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-prose-hash-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "story-project.json", (project) => { project.acceptedEpisodes[0].characterCount += 1; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /character count mismatch/u);

  dir = await mkdtemp(join(tmpdir(), "story-bible-line-endings-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  const crlfPath = join(dir, episode);
  const crlf = (await readFile(crlfPath, "utf8")).replaceAll("\n", "\r\n");
  await writeFile(crlfPath, crlf);
  await rewriteJson(dir, "manifest.json", (manifest) => {
    manifest.outputHashes[episode] = createHash("sha256").update(crlf).digest("hex");
  });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid accepted episode envelope/u);
});
