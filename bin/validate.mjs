#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";
import JSZip from "jszip";

const required = ["WORLD_BIBLE.md", "canon.json", "relationships.json", "timeline.json", "voice-guide.json", "source-index.json", "OPEN_QUESTIONS.md", "LLM_CONTEXT.md", "manifest.json"];
const schemaFor = { "canon.json": "canon.schema.json", "relationships.json": "relationships.schema.json", "timeline.json": "timeline.schema.json", "voice-guide.json": "voice-guide.schema.json", "source-index.json": "source-index.schema.json", "manifest.json": "manifest.schema.json" };
const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function inputFiles(path) {
  if (path.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await readFile(path), { checkCRC32: true });
    const names = Object.keys(zip.files);
    if (names.some((name) => name.startsWith("/") || name.split("/").includes(".."))) throw new Error("unsafe ZIP path");
    return new Map(await Promise.all(names.filter((name) => !zip.files[name].dir).map(async (name) => [name, await zip.files[name].async("nodebuffer")])));
  }
  return new Map(await Promise.all((await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map(async (entry) => [entry.name, await readFile(resolve(path, entry.name))])));
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
    parsed[name] = JSON.parse(files.get(name).toString("utf8"));
    const schema = JSON.parse(await readFile(resolve(root, `schemas/${schemaName}`), "utf8"));
    const validate = ajv.compile(schema);
    if (!validate(parsed[name])) throw new Error(`${name}: ${ajv.errorsText(validate.errors)}`);
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
  console.log(`valid story-bible 1.0.0 (${files.size} files)`);
}

main().catch((error) => { console.error(`invalid: ${error.message}`); process.exitCode = 1; });
