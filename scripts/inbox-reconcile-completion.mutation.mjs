#!/usr/bin/env node

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sourcePath = path.join(root, "scripts/inbox-reconcile-completion.mjs");
const testPath = path.join(root, "scripts/inbox-reconcile-completion.integration.test.mjs");
const catalogPath = path.join(root, "scripts/inbox-reconcile-catalog.expected.json");
const source = readFileSync(sourcePath, "utf8");
const test = readFileSync(testPath, "utf8");

function replaceOnce(input, needle, replacement, name) {
  const index = input.indexOf(needle);
  if (index < 0) throw new Error(`${name}: mutation target not found`);
  return `${input.slice(0, index)}${replacement}${input.slice(index + needle.length)}`;
}

const mutations = [
  {
    name: "M1 recheck=initial",
    source: replaceOnce(
      source,
      "const recheck = await collectEvidence(client, { expectedCatalogFingerprint, sourceWriterAttestation, attestationPath });",
      "const recheck = initial;",
      "M1 recheck=initial",
    ),
  },
  {
    name: "serving_enabled guard removed",
    source: replaceOnce(
      source,
      "serving_disabled: state.rollout?.serving_enabled === false,",
      "serving_disabled: true,",
      "serving_enabled guard removed",
    ),
  },
];

for (const mutation of mutations) {
  const directory = mkdtempSync(path.join(root, ".inbox-reconcile-mutation-"));
  try {
    writeFileSync(path.join(directory, "inbox-reconcile-completion.mjs"), mutation.source);
    writeFileSync(path.join(directory, "inbox-reconcile-completion.integration.test.mjs"), test);
    cpSync(catalogPath, path.join(directory, "inbox-reconcile-catalog.expected.json"));
    const result = spawnSync(process.execPath, ["--test", path.join(directory, "inbox-reconcile-completion.integration.test.mjs")], {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) throw new Error(`${mutation.name} survived; the integration guard is hollow`);
    process.stdout.write(`${mutation.name}: killed (integration test failed as expected)\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
