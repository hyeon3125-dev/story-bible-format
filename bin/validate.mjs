#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import Ajv from "ajv/dist/2020.js";
import JSZip from "jszip";

const required = ["WORLD_BIBLE.md", "canon.json", "relationships.json", "timeline.json", "voice-guide.json", "source-index.json", "OPEN_QUESTIONS.md", "LLM_CONTEXT.md", "manifest.json"];
const schemaFor = { "canon.json": "canon.schema.json", "relationships.json": "relationships.schema.json", "timeline.json": "timeline.schema.json", "voice-guide.json": "voice-guide.schema.json", "source-index.json": "source-index.schema.json", "manifest.json": "manifest.schema.json" };
const provenanceSchemaFor = { "provenance/ledger.json": "provenance-ledger.schema.json", "provenance/release-receipt.json": "release-receipt.schema.json", "provenance/anchor-ack.json": "anchor-ack.schema.json" };
const provenanceFiles = new Set([...Object.keys(provenanceSchemaFor), "provenance/release-receipt.sig", "provenance/release-seal.ots"]);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_FILES = 1_100;
const MAX_FILE_BYTES = 20_000_000;
const MAX_TOTAL_BYTES = 64_000_000;
const EPISODE = /^---\nchapter_id: ([^\n]+)\nstatus: accepted\n---\n\n<!-- scene:(S-[0-9]{3,}) -->\n\n# ([^\n]+)\n\n([\s\S]+)\n$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function safeName(name) {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized) || normalized.includes("\0") || normalized.split("/").includes("..")) throw new Error(`unsafe path: ${name}`);
  return normalized.replace(/^\.\//u, "");
}

function within(base, target) {
  const path = relative(base, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function text(data, name) {
  try { return utf8.decode(data); }
  catch { throw new Error(`invalid UTF-8: ${name}`); }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function timestamp(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`invalid ${label}: ${value}`);
  return parsed;
}

async function directoryFiles(base) {
  const resolvedBase = await realpath(base);
  const files = new Map();
  let total = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const stat = await lstat(absolute);
      const name = safeName(relative(resolvedBase, absolute));
      if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${name}`);
      const resolved = await realpath(absolute);
      if (!within(resolvedBase, resolved)) throw new Error(`path escapes package: ${name}`);
      if (entry.isDirectory()) { await visit(resolved); continue; }
      if (!entry.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) throw new Error(`file too large: ${name}`);
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("package too large");
      files.set(name, await readFile(resolved));
      if (files.size > MAX_FILES) throw new Error("too many files");
    }
  }
  await visit(resolvedBase);
  return files;
}

function zipEntryBytes(entry, name, priorTotal) {
  return new Promise((resolveEntry, rejectEntry) => {
    const chunks = [];
    let size = 0;
    let checksum = 0;
    let settled = false;
    const stream = entry.nodeStream("nodebuffer");
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      rejectEntry(error);
    };
    stream.on("data", (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_FILE_BYTES) return fail(new Error(`file too large: ${name}`));
      if (priorTotal + size > MAX_TOTAL_BYTES) return fail(new Error("package too large"));
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      if ((checksum >>> 0) !== (entry._data?.crc32 >>> 0)) return rejectEntry(new Error(`CRC32 mismatch: ${name}`));
      resolveEntry(Buffer.concat(chunks, size));
    });
  });
}

async function inputFiles(path) {
  if (!path.toLowerCase().endsWith(".zip")) return directoryFiles(path);
  const archiveStat = await lstat(path);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error("archive must be a regular file");
  if (archiveStat.size > MAX_TOTAL_BYTES) throw new Error("archive too large");
  const archive = await readFile(path);
  const zip = await JSZip.loadAsync(archive);
  const names = Object.keys(zip.files);
  if (names.length > MAX_FILES) throw new Error("too many files");
  const files = new Map();
  const entries = [];
  for (const name of names) {
    const entry = zip.files[name];
    const safe = safeName(entry.unsafeOriginalName ?? name);
    if (entry.dir) continue;
    if (files.has(safe)) throw new Error(`duplicate path: ${safe}`);
    const rawMode = entry.unixPermissions;
    const mode = typeof rawMode === "number" ? rawMode : typeof rawMode === "string" ? Number.parseInt(rawMode, 8) : 0;
    if ((mode & 0o170000) === 0o120000) throw new Error(`symlink rejected: ${safe}`);
    const declaredSize = entry._data?.uncompressedSize;
    if (Number.isFinite(declaredSize) && declaredSize > MAX_FILE_BYTES) throw new Error(`file too large: ${safe}`);
    entries.push({ entry, safe });
    files.set(safe, null);
  }
  let total = 0;
  for (const { entry, safe } of entries) {
    const data = await zipEntryBytes(entry, safe, total);
    total += data.byteLength;
    files.set(safe, data);
  }
  return files;
}

async function main() {
  const target = process.argv[2];
  if (!target) throw new Error("usage: story-bible <directory-or-zip>");
  const files = await inputFiles(resolve(target));
  for (const name of required) if (!files.has(name)) throw new Error(`missing ${name}`);

  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(await readFile(resolve(root, "schemas/common.json"), "utf8")));
  ajv.addSchema(JSON.parse(await readFile(resolve(root, "schemas/provenance-event.schema.json"), "utf8")));
  const parsed = {};
  for (const [name, schemaName] of Object.entries(schemaFor)) {
    parsed[name] = JSON.parse(text(files.get(name), name));
    const schema = JSON.parse(await readFile(resolve(root, `schemas/${schemaName}`), "utf8"));
    const validate = ajv.compile(schema);
    if (!validate(parsed[name])) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
  }

  const version = parsed["manifest.json"].schemaVersion;
  const sourceHashes = parsed["manifest.json"].sourceHashes;
  const indexedSources = parsed["source-index.json"];
  const indexedSourceIds = new Set(indexedSources.map((source) => source.id));
  const indexedSourceHashes = new Set(indexedSources.map((source) => source.sha256));
  if (indexedSourceIds.size !== indexedSources.length) throw new Error("duplicate source id");
  if (new Set(sourceHashes).size !== sourceHashes.length || indexedSourceHashes.size !== sourceHashes.length || sourceHashes.some((hash) => !indexedSourceHashes.has(hash))) throw new Error("manifest source hashes do not match source-index.json");
  const projectFile = files.get("story-project.json");
  let storyProject = null;
  const manuscriptNames = [...files.keys()].filter((name) => name.startsWith("manuscript/"));
  if (version === "1.0.0" && (projectFile || manuscriptNames.length)) throw new Error("1.1 handoff files require schemaVersion 1.1.0");
  if (version === "1.1.0" || version === "1.2.0") {
    if (!projectFile && manuscriptNames.length) throw new Error("manuscript requires story-project.json");
    if (projectFile) {
      const schema = JSON.parse(await readFile(resolve(root, "schemas/story-project.schema.json"), "utf8"));
      const validate = ajv.compile(schema);
      const project = JSON.parse(text(projectFile, "story-project.json"));
      storyProject = project;
      if (!validate(project)) throw new Error(`story-project.json: ${ajv.errorsText(validate.errors)}`);
      const accepted = new Set();
      const acceptedIds = new Set();
      const acceptedScenes = new Set();
      for (const episode of project.acceptedEpisodes) {
        if (accepted.has(episode.file) || acceptedIds.has(episode.id) || acceptedScenes.has(episode.sceneId)) throw new Error(`duplicate accepted episode: ${episode.id}`);
        if (!episode.file.startsWith(`manuscript/${project.canonicalLanguage}/`)) throw new Error(`accepted episode language mismatch: ${episode.file}`);
        const acceptedAt = new Date(episode.acceptedAt);
        if (!Number.isFinite(acceptedAt.getTime()) || acceptedAt.toISOString() !== episode.acceptedAt) throw new Error(`invalid acceptedAt: ${episode.id}`);
        accepted.add(episode.file); acceptedIds.add(episode.id); acceptedScenes.add(episode.sceneId);
      }
      if (project.currentEpisodeId && !acceptedIds.has(project.currentEpisodeId)) throw new Error(`unknown currentEpisodeId: ${project.currentEpisodeId}`);
      if (acceptedScenes.has(project.nextSceneId)) throw new Error(`nextSceneId is already accepted: ${project.nextSceneId}`);
      const nextSceneNumber = Number(project.nextSceneId.slice(2));
      const lastSceneNumber = Math.max(0, ...[...acceptedScenes].map((sceneId) => Number(sceneId.slice(2))));
      if (!Number.isSafeInteger(nextSceneNumber) || nextSceneNumber <= lastSceneNumber) throw new Error(`nextSceneId must follow every accepted scene: ${project.nextSceneId}`);
      for (const name of manuscriptNames) if (!accepted.has(name)) throw new Error(`unlisted manuscript: ${name}`);
      for (const episode of project.acceptedEpisodes) {
        const data = files.get(episode.file); if (!data) throw new Error(`accepted episode missing: ${episode.file}`);
        const markdown = text(data, episode.file);
        if (markdown.includes("\r")) throw new Error(`invalid accepted episode envelope: ${episode.file}`);
        const envelope = markdown.match(EPISODE);
        if (!envelope) throw new Error(`invalid accepted episode envelope: ${episode.file}`);
        const [, chapterId, sceneId, title, prose] = envelope;
        if (chapterId !== episode.id || sceneId !== episode.sceneId || title !== episode.title) throw new Error(`accepted episode metadata mismatch: ${episode.file}`);
        if (prose !== prose.trim()) throw new Error(`accepted episode prose is not canonical: ${episode.file}`);
        if ([...prose].length !== episode.characterCount) throw new Error(`accepted character count mismatch: ${episode.file}`);
        if (createHash("sha256").update(prose).digest("hex") !== episode.contentHash) throw new Error(`accepted content hash mismatch: ${episode.file}`);
      }
    }
  }

  const presentProvenance = [...files.keys()].filter((name) => name.startsWith("provenance/"));
  if (version !== "1.2.0" && presentProvenance.length) throw new Error("provenance files require schemaVersion 1.2.0");
  if (version === "1.2.0") {
    for (const name of presentProvenance) if (!provenanceFiles.has(name)) throw new Error(`unknown provenance file: ${name}`);
    const ledgerFile = files.get("provenance/ledger.json");
    if (presentProvenance.length && !ledgerFile) throw new Error("provenance files require provenance/ledger.json");
    if (ledgerFile) {
      const provenance = {};
      for (const [name, schemaName] of Object.entries(provenanceSchemaFor)) {
        const data = files.get(name);
        if (!data) continue;
        provenance[name] = JSON.parse(text(data, name));
        const schema = JSON.parse(await readFile(resolve(root, `schemas/${schemaName}`), "utf8"));
        const validate = ajv.compile(schema);
        if (!validate(provenance[name])) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
      }

      const ledger = provenance["provenance/ledger.json"];
      const eventIds = new Set();
      const eventsByReceipt = new Map();
      let parent = null;
      for (const event of ledger.events) {
        if (event.projectRef !== ledger.projectRef) throw new Error(`provenance project mismatch: ${event.eventId}`);
        if (eventIds.has(event.eventId)) throw new Error(`duplicate provenance event id: ${event.eventId}`);
        if (eventsByReceipt.has(event.receiptSha256)) throw new Error(`duplicate provenance receipt: ${event.receiptSha256}`);
        if (event.parentReceiptSha256 !== parent) throw new Error(`broken provenance chain: ${event.eventId}`);
        const { receiptSha256, anchorStatus, ...receiptBody } = event;
        if (sha256(canonicalJson(receiptBody)) !== receiptSha256) throw new Error(`provenance receipt mismatch: ${event.eventId}`);
        if (event.afterSha256 !== event.artifactSha256) throw new Error(`provenance artifact mismatch: ${event.eventId}`);
        if (event.eventKind === "human_revision" && event.beforeSha256 === null) throw new Error(`human revision missing beforeSha256: ${event.eventId}`);
        if (event.eventKind === "rights_reconfirmed" && (event.contribution !== "manual" || event.beforeSha256 !== event.afterSha256 || event.addedCharacters !== 0 || event.deletedCharacters !== 0)) throw new Error(`invalid rights reconfirmation: ${event.eventId}`);
        if (event.beforeSha256 === null && event.deletedCharacters !== 0) throw new Error(`deletedCharacters requires beforeSha256: ${event.eventId}`);
        const createdAt = timestamp(event.createdAt, `createdAt for ${event.eventId}`);
        const acceptedAt = timestamp(event.acceptedAt, `acceptedAt for ${event.eventId}`);
        if (acceptedAt < createdAt) throw new Error(`acceptedAt precedes createdAt: ${event.eventId}`);
        eventIds.add(event.eventId);
        eventsByReceipt.set(receiptSha256, event);
        parent = receiptSha256;
      }
      if (storyProject?.acceptedEpisodes.length) {
        const artifacts = new Set(ledger.events.map((event) => event.afterSha256));
        for (const episode of storyProject.acceptedEpisodes) {
          const packagedHash = parsed["manifest.json"].outputHashes[episode.file];
          if (!artifacts.has(episode.contentHash) && !artifacts.has(packagedHash)) throw new Error(`provenance does not bind accepted episode: ${episode.id}`);
        }
      }

      const ack = provenance["provenance/anchor-ack.json"];
      const anchoredReceipts = new Set();
      if (ack) {
        const anchorIds = new Set();
        for (const anchor of ack.anchors) {
          if (anchorIds.has(anchor.anchorId)) throw new Error(`duplicate anchor id: ${anchor.anchorId}`);
          if (anchoredReceipts.has(anchor.receiptSha256)) throw new Error(`duplicate anchored receipt: ${anchor.receiptSha256}`);
          const event = eventsByReceipt.get(anchor.receiptSha256);
          if (!event) throw new Error(`anchor references unknown receipt: ${anchor.receiptSha256}`);
          timestamp(anchor.receivedAt, `receivedAt for ${anchor.anchorId}`);
          anchorIds.add(anchor.anchorId);
          anchoredReceipts.add(anchor.receiptSha256);
        }
      }
      for (const event of ledger.events) {
        const hasAck = anchoredReceipts.has(event.receiptSha256);
        if ((event.anchorStatus === "anchored") !== hasAck) throw new Error(`anchor status mismatch: ${event.eventId}`);
      }

      const release = provenance["provenance/release-receipt.json"];
      if (release) {
        if (release.projectRef !== ledger.projectRef) throw new Error("release receipt project mismatch");
        if (release.headReceiptSha256 !== ledger.events.at(-1).receiptSha256) throw new Error("release receipt does not reference ledger head");
        if (release.rightsBasis !== ledger.events.at(-1).rightsBasis) throw new Error("release receipt rights basis mismatch");
        if (timestamp(release.createdAt, "release createdAt") < timestamp(ledger.events.at(-1).acceptedAt, `acceptedAt for ${ledger.events.at(-1).eventId}`)) throw new Error("release receipt predates acceptance");
        if (text(files.get("provenance/release-receipt.json"), "provenance/release-receipt.json") !== `${canonicalJson(release)}\n`) throw new Error("release receipt is not canonical JSON");
        const releasePaths = new Set();
        for (const entry of release.files) {
          if (safeName(entry.path) !== entry.path || entry.path === "manifest.json" || entry.path.startsWith("provenance/")) throw new Error(`invalid release file path: ${entry.path}`);
          if (releasePaths.has(entry.path)) throw new Error(`duplicate release file: ${entry.path}`);
          const data = files.get(entry.path);
          if (!data) throw new Error(`release file missing: ${entry.path}`);
          if (data.byteLength !== entry.bytes || sha256(data) !== entry.sha256) throw new Error(`release file mismatch: ${entry.path}`);
          releasePaths.add(entry.path);
        }
      }
      if (files.has("provenance/release-receipt.sig") && !release) throw new Error("release signature requires release receipt");
      if (files.has("provenance/release-seal.ots") && !files.has("provenance/release-receipt.sig")) throw new Error("OpenTimestamps seal requires release signature");
      for (const name of ["provenance/release-receipt.sig", "provenance/release-seal.ots"]) if (files.has(name) && files.get(name).byteLength === 0) throw new Error(`empty provenance file: ${name}`);
    }
  }

  const timelineIds = new Set(parsed["timeline.json"].map((event) => event.id));
  if (timelineIds.size !== parsed["timeline.json"].length) throw new Error("duplicate timeline event id");
  for (const relationship of parsed["relationships.json"]) {
    if (relationship.validFromEventId && !timelineIds.has(relationship.validFromEventId)) throw new Error(`unknown validFromEventId: ${relationship.id}`);
    if (relationship.validToEventId && !timelineIds.has(relationship.validToEventId)) throw new Error(`unknown validToEventId: ${relationship.id}`);
  }

  const paragraphHashes = new Set(parsed["source-index.json"].flatMap((source) => source.chapters.flatMap((chapter) => chapter.paragraphs.map((paragraph) => `${source.id}:${paragraph.hash}`))));
  for (const name of ["canon.json", "relationships.json", "timeline.json", "voice-guide.json"]) for (const row of parsed[name]) {
    if (row.status === "OBSERVED" && !row.evidence.length) throw new Error(`${name}: OBSERVED record has no evidence`);
    for (const evidence of row.evidence) if (!paragraphHashes.has(`${evidence.sourceId}:${evidence.paragraphHash}`)) throw new Error(`${name}: unresolved evidence ${evidence.paragraphHash}`);
  }
  for (const [name, expected] of Object.entries(parsed["manifest.json"].outputHashes)) {
    const data = files.get(name); if (!data) throw new Error(`manifest references missing ${name}`);
    const actual = sha256(data);
    if (actual !== expected) throw new Error(`${name}: SHA-256 mismatch`);
  }
  for (const name of required) if (name !== "manifest.json" && !parsed["manifest.json"].outputHashes[name]) throw new Error(`unhashed core file: ${name}`);
  for (const name of ["story-project.json", ...manuscriptNames]) if (files.has(name) && !parsed["manifest.json"].outputHashes[name]) throw new Error(`unhashed handoff file: ${name}`);
  if (version === "1.2.0") {
    const actual = [...files.keys()].filter((name) => name !== "manifest.json").sort();
    const declared = Object.keys(parsed["manifest.json"].outputHashes).sort();
    if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error("manifest output hashes do not exactly match package files");
  }
  console.log(`valid story-bible ${version} (${files.size} files)`);
}

main().catch((error) => { console.error(`invalid: ${error.message}`); process.exitCode = 1; });
