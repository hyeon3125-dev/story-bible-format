import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, open, readFile, symlink, writeFile } from "node:fs/promises";
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function provenancePackage() {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-provenance-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await mkdir(join(dir, "provenance"));
  await cp("test/fixtures/provenance-valid", join(dir, "provenance"), { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.schemaVersion = "1.2.0";
  for (const name of ["provenance/ledger.json", "provenance/anchor-ack.json", "provenance/release-receipt.json"]) {
    manifest.outputHashes[name] = createHash("sha256").update(await readFile(join(dir, name))).digest("hex");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

async function hashIntoManifest(dir, name) {
  const data = await readFile(join(dir, name));
  await rewriteJson(dir, "manifest.json", (manifest) => {
    manifest.outputHashes[name] = createHash("sha256").update(data).digest("hex");
  });
}

test("synthetic address-change package validates", () => {
  const result = spawnSync(process.execPath, ["bin/validate.mjs", "examples/korean-address-change"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid story-bible 1\.0\.0/u);
});

test("relationship registerTier is limited to 0 through 3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-register-"));
  await cp("examples/korean-address-change", dir, { recursive: true });
  await rewriteJson(dir, "relationships.json", (relationships) => { relationships[0].registerTier = 4; });
  const result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /registerTier must be <= 3/u);
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

test("ZIP extraction caps actual expansion when size headers lie", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-bomb-"));
  const zip = new JSZip();
  zip.file("bomb.txt", Buffer.alloc(20_000_001, 65));
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const local = archive.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(local, -1); assert.notEqual(central, -1);
  archive.writeUInt32LE(1, local + 22);
  archive.writeUInt32LE(1, central + 24);
  const path = join(dir, "forged-size.zip");
  await writeFile(path, archive);
  const result = validate(path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file too large/u);
});

test("ZIP archive size is rejected before reading its bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-large-archive-"));
  const path = join(dir, "large.zip");
  const handle = await open(path, "w");
  await handle.truncate(64_000_001);
  await handle.close();
  const result = validate(path);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive too large/u);
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

test("1.2 provenance golden package and derived anchor status validate", async () => {
  let dir = await provenancePackage();
  let result = validate(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid story-bible 1\.2\.0/u);

  dir = await provenancePackage();
  await rewriteJson(dir, "provenance/ledger.json", (ledger) => { ledger.events[1].anchorStatus = "unanchored"; });
  await rewriteJson(dir, "provenance/anchor-ack.json", (ack) => { ack.anchors.pop(); });
  result = validate(dir);
  assert.equal(result.status, 0, result.stderr);

  dir = await provenancePackage();
  await rewriteJson(dir, "provenance/anchor-ack.json", (ack) => { ack.anchors[0].receivedAt = "2026-08-28T00:00:00.000Z"; });
  result = validate(dir);
  assert.equal(result.status, 0, result.stderr);
});

test("rights reconfirmation preserves history and becomes the ledger head", async () => {
  const dir = await provenancePackage();
  let head;
  await rewriteJson(dir, "provenance/ledger.json", (ledger) => {
    const previous = ledger.events.at(-1);
    const event = {
      ...previous,
      eventId: "evt-rights-003",
      parentReceiptSha256: previous.receiptSha256,
      receiptSha256: "",
      eventKind: "rights_reconfirmed",
      artifactSha256: previous.afterSha256,
      sourceRevisionSha256: previous.afterSha256,
      requestSha256: "8888888888888888888888888888888888888888888888888888888888888888",
      executionMode: "imported",
      provider: "manual",
      models: ["none"],
      contribution: "manual",
      beforeSha256: previous.afterSha256,
      afterSha256: previous.afterSha256,
      addedCharacters: 0,
      deletedCharacters: 0,
      decisionNote: "권리 범주를 비상업 동인으로 재확인",
      rightsBasis: "third_party_fan_noncommercial",
      createdAt: "2026-08-29T00:18:00.000Z",
      acceptedAt: "2026-08-29T00:18:00.000Z",
      anchorStatus: "unanchored"
    };
    const { receiptSha256, anchorStatus, ...body } = event;
    event.receiptSha256 = createHash("sha256").update(canonicalJson(body)).digest("hex");
    ledger.events.push(event);
    head = event.receiptSha256;
  });
  const releasePath = join(dir, "provenance/release-receipt.json");
  const release = JSON.parse(await readFile(releasePath, "utf8"));
  release.headReceiptSha256 = head;
  release.rightsBasis = "third_party_fan_noncommercial";
  await writeFile(releasePath, `${canonicalJson(release)}\n`);
  await hashIntoManifest(dir, "provenance/release-receipt.json");
  const result = validate(dir);
  assert.equal(result.status, 0, result.stderr);
});

test("1.2 detects one-character receipt changes and broken chains", async () => {
  let dir = await provenancePackage();
  await rewriteJson(dir, "provenance/ledger.json", (ledger) => { ledger.events[0].decisionNote += "!"; });
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provenance receipt mismatch/u);

  dir = await provenancePackage();
  await rewriteJson(dir, "provenance/ledger.json", (ledger) => {
    const event = ledger.events[1];
    event.parentReceiptSha256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { receiptSha256, anchorStatus, ...body } = event;
    event.receiptSha256 = createHash("sha256").update(canonicalJson(body)).digest("hex");
  });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken provenance chain/u);

  dir = await provenancePackage();
  const episodePath = join(dir, "manuscript/ko/episode-001.md");
  const changed = (await readFile(episodePath, "utf8")).replace(/\n$/u, "추가\n");
  const prose = changed.match(/\n\n# [^\n]+\n\n([\s\S]+)\n$/u)[1];
  await writeFile(episodePath, changed);
  await rewriteJson(dir, "story-project.json", (project) => {
    project.acceptedEpisodes[0].characterCount = [...prose].length;
    project.acceptedEpisodes[0].contentHash = createHash("sha256").update(prose).digest("hex");
  });
  await hashIntoManifest(dir, "story-project.json");
  await hashIntoManifest(dir, "manuscript/ko/episode-001.md");
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provenance does not bind accepted episode/u);
});

test("strict provenance schemas reject prompt and anchor content", async () => {
  let dir = await provenancePackage();
  await cp("test/fixtures/provenance-invalid/ledger-with-prompt.json", join(dir, "provenance/ledger.json"));
  await hashIntoManifest(dir, "provenance/ledger.json");
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /additional properties/u);

  dir = await provenancePackage();
  await cp("test/fixtures/provenance-invalid/anchor-ack-with-title.json", join(dir, "provenance/anchor-ack.json"));
  await hashIntoManifest(dir, "provenance/anchor-ack.json");
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /additional properties/u);

  dir = await provenancePackage();
  await rewriteJson(dir, "provenance/release-receipt.json", (receipt) => { receipt.title = "제목은 영수증에 넣지 않음"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /additional properties/u);
});

test("release receipts are canonical and bind files and ledger head", async () => {
  let dir = await provenancePackage();
  await rewriteJson(dir, "provenance/release-receipt.json", () => {});
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not canonical JSON/u);

  dir = await provenancePackage();
  await rewriteJson(dir, "provenance/release-receipt.json", (receipt) => { receipt.files[0].bytes += 1; });
  const receipt = JSON.parse(await readFile(join(dir, "provenance/release-receipt.json"), "utf8"));
  await writeFile(join(dir, "provenance/release-receipt.json"), `${canonicalJson(receipt)}\n`);
  await hashIntoManifest(dir, "provenance/release-receipt.json");
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release file mismatch/u);
});

test("1.2 exact inventory covers opaque seals while older versions reject provenance", async () => {
  let dir = await provenancePackage();
  await writeFile(join(dir, "unlisted.txt"), "unlisted\n");
  let result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly match package files/u);

  dir = await provenancePackage();
  await writeFile(join(dir, "provenance/release-receipt.sig"), "opaque detached signature\n");
  await writeFile(join(dir, "provenance/release-seal.ots"), "opaque ots proof\n");
  await hashIntoManifest(dir, "provenance/release-receipt.sig");
  await hashIntoManifest(dir, "provenance/release-seal.ots");
  result = validate(dir);
  assert.equal(result.status, 0, result.stderr);

  await rewriteJson(dir, "manifest.json", (manifest) => { manifest.schemaVersion = "1.1.0"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provenance files require schemaVersion 1\.2\.0/u);
});

test("anchor acknowledgement byte tampering fails manifest integrity", async () => {
  const dir = await provenancePackage();
  const path = join(dir, "provenance/anchor-ack.json");
  const ack = JSON.parse(await readFile(path, "utf8"));
  ack.anchors[0].hmac = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await writeFile(path, `${JSON.stringify(ack, null, 2)}\n`);
  const result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 mismatch/u);
});

test("1.2 provenance remains optional", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-optional-provenance-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  await rewriteJson(dir, "manifest.json", (manifest) => { manifest.schemaVersion = "1.2.0"; });
  const result = validate(dir);
  assert.equal(result.status, 0, result.stderr);
});

test("1.3 objectives are additive, exact, and cannot overlap priorities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "story-bible-objectives-"));
  await cp("examples/korean-continuation-handoff", dir, { recursive: true });
  const objectives = {
    schema: "scalar.story-objectives.v1",
    readerPromise: "인물의 선택이 성공의 의미를 뒤집는 비극",
    primary: "character_attachment",
    secondary: ["emotional_impact", "next_episode_pull"],
    payoffCadence: "arc",
    confirmedAt: "2026-08-30T00:00:00.000Z"
  };
  await writeFile(join(dir, "objectives.json"), `${JSON.stringify(objectives, null, 2)}\n`);
  await rewriteJson(dir, "manifest.json", (manifest) => {
    manifest.schemaVersion = "1.3.0";
    manifest.outputHashes["objectives.json"] = createHash("sha256").update(JSON.stringify(objectives, null, 2) + "\n").digest("hex");
  });
  let result = validate(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid story-bible 1\.3\.0/u);

  await rewriteJson(dir, "objectives.json", (value) => { value.secondary[0] = value.primary; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /primary and secondary must differ/u);

  await rewriteJson(dir, "manifest.json", (manifest) => { manifest.schemaVersion = "1.2.0"; });
  result = validate(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires schemaVersion 1\.3\.0/u);
});
