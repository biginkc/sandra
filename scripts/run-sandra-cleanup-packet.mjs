#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";

import {
  EXPECTED_PROJECT_REF,
  assertDatabaseTarget,
  sha256,
} from "./export-sandra-cleanup-packet.mjs";

const { Client } = pg;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL_ENV = "SANDRA_PRODUCTION_DATABASE_URL";

export const PACKETS = Object.freeze({
  a: {
    file: "sandra-cleanup-packet-a.sql",
    sha256: "7008acfe77a65835bec1ecf3a40c00269fe94d1db14d249aa821b0183bfadfc7",
    applyArm: "DELETE_REVIEWED_PACKET_A",
  },
  b: {
    file: "sandra-cleanup-packet-b-access.sql",
    sha256: "52a5a3cb7a5aee0ee20bb7842c5a8092d9ea9cefefa173057dd5ce58992875b5",
    applyArm: "DELETE_REVIEWED_PACKET_B_ACCESS",
  },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseCleanupRunArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--packet" || token === "--env") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${token}`);
      result[token.slice(2)] = value;
      index += 1;
    } else if (token.startsWith("--apply=")) {
      result.applyArm = token.slice("--apply=".length);
      result.apply = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  const packet = PACKETS[result.packet];
  if (!packet) throw new Error("Usage: --packet a|b [--env <file>] [--apply=<exact arm>]");
  if (result.apply && result.applyArm !== packet.applyArm) {
    throw new Error("Refusing an incorrect cleanup apply arm.");
  }
  return result;
}

export function prepareCleanupSql(sql, packet, apply) {
  assert(sha256(sql) === packet.sha256, "Cleanup SQL hash does not match the reviewed packet.");
  if (!apply) return sql;
  assert(sql.trimEnd().endsWith("rollback;"), "Cleanup SQL has no final rollback safeguard.");
  assert(
    (sql.match(/'ROLLBACK_REHEARSAL'/gu) ?? []).length === 1,
    "Cleanup SQL has an unexpected outcome label.",
  );
  const armed = sql
    .replace("'ROLLBACK_REHEARSAL'", "'COMMIT_PENDING'")
    .replace(/rollback;\s*$/u, "commit;\n");
  assert(armed.trimEnd().endsWith("commit;"), "Cleanup SQL commit arm failed.");
  return armed;
}

async function main() {
  const args = parseCleanupRunArgs(process.argv.slice(2));
  if (args.env) process.loadEnvFile(path.resolve(args.env));
  const packet = PACKETS[args.packet];
  const sql = await readFile(path.join(SCRIPT_DIR, "sql", packet.file), "utf8");
  const statement = prepareCleanupSql(sql, packet, args.apply);
  const connectionString = process.env[DATABASE_URL_ENV];
  assert(connectionString, `${DATABASE_URL_ENV} is missing.`);
  const target = assertDatabaseTarget(connectionString, EXPECTED_PROJECT_REF);
  const client = new Client({
    connectionString: target.connectionString,
    ssl: { rejectUnauthorized: true },
  });
  try {
    await client.connect();
    await client.query(statement);
  } finally {
    await client.end().catch(() => undefined);
  }
  process.stdout.write(
    `${JSON.stringify({ mode: args.apply ? "COMMITTED" : "ROLLED_BACK", packet: args.packet, projectRef: EXPECTED_PROJECT_REF, sqlSha256: packet.sha256 })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
