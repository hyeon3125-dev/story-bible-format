#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import JSZip from "jszip";

const required = ["WORLD_BIBLE.md", "canon.json", "relationships.json", "timeline.json", "voice-guide.json", "source-index.json", "OPEN_QUESTIONS.md", "LLM_CONTEXT.md", "manifest.json"];
const schemaFor = { "canon.json": "canon.schema.json", "relationships.json": "relationships.schema.json", "timeline.json": "timeline.schema.json", "voice-guide.json": "voice-guide.schema.json", "source-index.json": "source-index.schema.json", "manifest.json": "manifest.schema.json" };
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

async function inputFiles(path) {
  if (!path.toLowerCase().endsWith(".zip")) return directoryFiles(path);
  const archive = await readFile(path);
  if (archive.byteLength > MAX_TOTAL_BYTES) throw new Error("archive too large");
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  const names = Object.keys(zip.files);
  if (names.length > MAX_FILES) throw new Error("too many files");
  const files = new Map();
  let total = 0;
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
    const data = await entry.async("nodebuffer");
    if (data.byteLength > MAX_FILE_BYTES) throw new Error(`file too large: ${safe}`);
    total += data.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new Error("package too large");
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
  const manuscriptNames = [...files.keys()].filter((name) => name.startsWith("manuscript/"));
  if (version === "1.0.0" && (projectFile || manuscriptNames.length)) throw new Error("1.1 handoff files require schemaVersion 1.1.0");
  if (version === "1.1.0") {
    if (!projectFile && manuscriptNames.length) throw new Error("manuscript requires story-project.json");
    if (projectFile) {
      const schema = JSON.parse(await readFile(resolve(root, "schemas/story-project.schema.json"), "utf8"));
      const validate = ajv.compile(schema);
      const project = JSON.parse(text(projectFile, "story-project.json"));
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
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) throw new Error(`${name}: SHA-256 mismatch`);
  }
  for (const name of required) if (name !== "manifest.json" && !parsed["manifest.json"].outputHashes[name]) throw new Error(`unhashed core file: ${name}`);
  for (const name of ["story-project.json", ...manuscriptNames]) if (files.has(name) && !parsed["manifest.json"].outputHashes[name]) throw new Error(`unhashed handoff file: ${name}`);
  console.log(`valid story-bible ${version} (${files.size} files)`);
}

main().catch((error) => { console.error(`invalid: ${error.message}`); process.exitCode = 1; });
