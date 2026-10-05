#!/usr/bin/env node
/**
 * Provisions a FRESH, throwaway local Supabase stack for the chaos-day stress harness.
 * Loopback only, distinct ports (never the long-running dev stack), repo migrations only.
 *
 *   node e2e/stress/provision-stack.mjs --workdir <dir> [--api-port 55431] [--db-port 55430] [--stop]
 *
 * Prints a JSON blob (API_URL, DB_URL, ANON_KEY, SERVICE_ROLE_KEY) to stdout and writes
 * <workdir>/stress-env.json. Never reads or writes any hosted-project credential.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const workdir = arg("--workdir");
if (!workdir) throw new Error("--workdir is required");
const apiPort = Number(arg("--api-port", "55431"));
const dbPort = Number(arg("--db-port", "55430"));
if (![apiPort, dbPort].every((p) => Number.isInteger(p) && p >= 1024 && p <= 65535) || apiPort === dbPort) throw new Error("bad ports");
if ([54321, 54322, 54329, 54331].some((p) => p === apiPort || p === dbPort)) {
  throw new Error("refusing the dev stack ports (54321/54322/54329/54331); pick fresh ones");
}
const run = (...argv) => execFileSync("supabase", argv, { stdio: ["ignore", "pipe", "inherit"] });
if (process.argv.includes("--stop")) {
  run("stop", "--workdir", workdir, "--no-backup");
  process.exit(0);
}
mkdirSync(workdir, { recursive: true });
run("init", "--workdir", workdir, "--force");
const source = readFileSync("supabase/config.toml", "utf8");
if (!/^major_version\s*=\s*17\s*$/m.test(source)) throw new Error("Repo config must pin Postgres 17");
const config = source
  .replace(/^project_id\s*=.*$/m, `project_id = "sandra-stress-${randomUUID().slice(0, 8)}"`)
  .replace(/(\[api\][\s\S]*?^port\s*=\s*)\d+/m, (_, p) => `${p}${apiPort}`)
  .replace(/(\[db\][\s\S]*?^port\s*=\s*)\d+/m, (_, p) => `${p}${dbPort}`)
  + "\n[studio]\nenabled = false\n[inbucket]\nenabled = false\n[analytics]\nenabled = false\n[edge_runtime]\nenabled = false\n[db.pooler]\nenabled = false\n";
writeFileSync(path.join(workdir, "supabase/config.toml"), config);
mkdirSync(path.join(workdir, "supabase/migrations"), { recursive: true });
for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"))) {
  cpSync(path.join("supabase/migrations", f), path.join(workdir, "supabase/migrations", f));
}
try { run("start", "--workdir", workdir); } catch { try { run("stop", "--workdir", workdir, "--no-backup"); } catch {} run("start", "--workdir", workdir); }
const status = JSON.parse(run("status", "--workdir", workdir, "--output", "json").toString());
if (status.API_URL !== `http://127.0.0.1:${apiPort}` || !String(status.DB_URL).includes(`127.0.0.1:${dbPort}`)) {
  throw new Error(`Unexpected stack endpoints: ${status.API_URL} ${status.DB_URL}`);
}
// A permanent owner must exist for the org (FINAL_OWNER_GUARD) before any membership can be inserted.
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const owner = await admin.auth.admin.createUser({ email: `stress-baseline-${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID(), email_confirm: true, app_metadata: { purpose: "stress-baseline-owner" } });
if (owner.error || !owner.data.user) throw new Error("baseline owner creation failed");
const membership = await admin.from("memberships").upsert({ user_id: owner.data.user.id, org_id: "00000000-0000-0000-0000-000000000bbb", role: "owner" }, { onConflict: "user_id,org_id" });
if (membership.error) throw new Error("baseline owner membership failed");
const out = { API_URL: status.API_URL, DB_URL: status.DB_URL, ANON_KEY: status.ANON_KEY, SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY };
writeFileSync(path.join(workdir, "stress-env.json"), JSON.stringify(out, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...out, ANON_KEY: "***", SERVICE_ROLE_KEY: "***", env_file: path.join(workdir, "stress-env.json") }));
