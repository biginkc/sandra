import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

import { J5A_MIGRATIONS, J5A_SOURCE_COMMIT } from "./materialize-inbox-j5a.mjs";

function verifyMigration(root, name, expectedSha256) {
  const file = path.join(root, "supabase", "migrations", name);
  const bytes = readFileSync(file);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error(`J5A migration hash mismatch: ${name}`);
  return { file, bytes };
}

export async function applyJ5a({ root = process.cwd(), dsn = process.env.E2E_CI_SUPABASE_DB_URL } = {}) {
  if (!dsn) throw new Error("E2E_CI_SUPABASE_DB_URL_REQUIRED");
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    for (const [name, expectedSha256] of J5A_MIGRATIONS) {
      const { bytes } = verifyMigration(root, name, expectedSha256);
      await client.query(bytes.toString("utf8"));
      const version = name.slice(0, 14);
      const migrationName = name.slice(15, -4);
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
         VALUES($1,$2,$3)
         ON CONFLICT(version) DO NOTHING`,
        [version, migrationName, [`pinned J5a source ${J5A_SOURCE_COMMIT} sha256 ${expectedSha256}`]],
      );
    }
  } finally {
    await client.end();
  }
  return { commit: J5A_SOURCE_COMMIT, files: J5A_MIGRATIONS.map(([name]) => name) };
}

if (process.argv[1]?.endsWith("apply-inbox-j5a.mjs")) {
  applyJ5a().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
