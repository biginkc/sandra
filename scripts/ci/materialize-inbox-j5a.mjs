import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const J5A_SOURCE_COMMIT = "93380d869821a0055b766351a9233a1b43f143b6";
export const J5A_MIGRATIONS = Object.freeze([
  ["20260930040000_inbox_control_foundation.sql", "a31799ba96e6f7264f062019cc8113a6401719a686cc31e569b10d21064bfbf6"],
  ["20260930040100_inbox_read_companion.sql", "7a2c5f49fc8fcf58c7f37585c3c347869816912e47e504ec47f9cdac198d3dd7"],
  ["20260930040200_inbox_backend_operation_reply.sql", "2a4b49d43e67963805d547221d04c84c3f7823f430fd9c0cc9b3f22b36844aad"],
]);

export function materialize(root = process.cwd()) {
  const destination = path.join(root, "supabase", "migrations");
  mkdirSync(destination, { recursive: true });
  for (const [name, expectedSha256] of J5A_MIGRATIONS) {
    const relative = `supabase/migrations/${name}`;
    const bytes = execFileSync("git", ["show", `${J5A_SOURCE_COMMIT}:${relative}`], { cwd: root });
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`J5A migration hash mismatch: ${name}`);
    writeFileSync(path.join(destination, name), bytes, { mode: 0o600 });
  }
  return { commit: J5A_SOURCE_COMMIT, files: J5A_MIGRATIONS.map(([name]) => name) };
}

if (process.argv[1]?.endsWith("materialize-inbox-j5a.mjs")) {
  console.log(JSON.stringify(materialize()));
}
