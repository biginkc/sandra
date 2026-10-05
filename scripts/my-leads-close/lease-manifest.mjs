#!/usr/bin/env node
// Release-lease manifest for one PR (TECH-PLAN Phase 4, item 4.8).
//
//   node scripts/my-leads-close/lease-manifest.mjs <pr-number> [--approved-sha <sha>]
//
// Prints the lease request block (changed files, migration versions in order, vercel.json cron diffs,
// check status) and exits 1 when: checks are red, the head is not the approved SHA, a migration
// version sorts before origin/main's newest, or another open PR touches the same paths.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MIGRATION = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/;

export function migrationVersion(file) {
  const match = MIGRATION.exec(file);
  return match ? match[1] : null;
}

/**
 * Pure manifest builder. Inputs are plain data so the test can drive it without gh/git:
 *  - pr: { number, headRefOid, baseRefName, files: string[], checks: Array<{name, conclusion|status}> }
 *  - approvedSha: string | null
 *  - mainMigrationVersions: string[] (origin/main's `supabase/migrations` versions)
 *  - openPrs: Array<{ number, files: string[] }>
 *  - vercelCronDiff: string ('' when vercel.json is unchanged)
 */
/**
 * @param {{
 *   pr: { number: number; headRefOid: string; baseRefName: string; files: string[]; checks: Array<Record<string, unknown>> };
 *   approvedSha?: string | null;
 *   mainMigrationVersions?: string[];
 *   openPrs?: Array<{ number: number; files: string[] }>;
 *   vercelCronDiff?: string;
 * }} input
 */
export function buildManifest(input) {
  const { pr, approvedSha = null, mainMigrationVersions = [], openPrs = [], vercelCronDiff = "" } = input;
  const problems = [];
  const migrations = pr.files.map(migrationVersion).filter(Boolean).sort();
  const newestOnMain = [...mainMigrationVersions].sort().at(-1) ?? null;
  for (const version of migrations) {
    if (newestOnMain && version < newestOnMain) problems.push(`migration ${version} sorts before origin/main's newest ${newestOnMain} (the safety gate will refuse it)`);
  }
  if (approvedSha && pr.headRefOid !== approvedSha) problems.push(`head ${pr.headRefOid} is not the approved SHA ${approvedSha}`);
  const red = pr.checks.filter((c) => {
    const state = String(c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
    return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state);
  });
  for (const check of red) problems.push(`check ${check.name} is ${check.conclusion ?? check.state ?? check.status}`);
  const overlaps = [];
  for (const other of openPrs) {
    if (other.number === pr.number) continue;
    const shared = other.files.filter((f) => pr.files.includes(f));
    if (shared.length) overlaps.push({ number: other.number, files: shared });
  }
  for (const o of overlaps) problems.push(`open PR #${o.number} touches ${o.files.join(", ")}`);
  const cronChanged = vercelCronDiff.trim().length > 0;
  return {
    pr: pr.number,
    head: pr.headRefOid,
    base: pr.baseRefName,
    files: [...pr.files].sort(),
    migrations,
    newestOnMain,
    cronChanged,
    vercelCronDiff,
    overlaps,
    problems,
    ok: problems.length === 0,
  };
}

export function formatManifest(m) {
  const lines = [
    `Lease request: PR #${m.pr} -> ${m.base}`,
    `Head SHA: ${m.head}`,
    `Migrations (apply order): ${m.migrations.length ? m.migrations.join(", ") : "none"}`,
    `Newest migration on origin/main: ${m.newestOnMain ?? "unknown"}`,
    `vercel.json crons changed: ${m.cronChanged ? "yes" : "no"}`,
    `Files (${m.files.length}):`,
    ...m.files.map((f) => `  ${f}`),
  ];
  if (m.cronChanged) lines.push("Cron diff:", m.vercelCronDiff);
  lines.push(m.ok ? "OK: no blocking problems" : "BLOCKED:");
  for (const p of m.problems) lines.push(`  - ${p}`);
  return `${lines.join("\n")}\n`;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function main(argv, io = { out: (t) => process.stdout.write(t) }, exec = sh) {
  const [number, ...rest] = argv;
  if (!number || !/^\d+$/.test(number)) throw new Error("usage: lease-manifest.mjs <pr-number> [--approved-sha <sha>]");
  let approvedSha = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--approved-sha") {
      approvedSha = rest[i + 1];
      if (!approvedSha || !/^[0-9a-f]{7,40}$/.test(approvedSha)) throw new Error("--approved-sha needs a hex SHA");
      i += 1;
    } else throw new Error(`Unknown argument ${rest[i]}`);
  }
  const view = JSON.parse(exec("gh", ["pr", "view", number, "--json", "number,headRefOid,baseRefName,files,statusCheckRollup"]));
  const pr = {
    number: view.number,
    headRefOid: view.headRefOid,
    baseRefName: view.baseRefName,
    files: (view.files ?? []).map((f) => f.path),
    checks: (view.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? "check", conclusion: c.conclusion ?? c.state ?? c.status })),
  };
  if (approvedSha && pr.headRefOid.startsWith(approvedSha)) approvedSha = pr.headRefOid;
  exec("git", ["fetch", "origin", "main", "--quiet"]);
  const mainMigrationVersions = exec("git", ["ls-tree", "--name-only", "origin/main", "supabase/migrations/"]).split("\n").map((f) => migrationVersion(f.trim())).filter(Boolean);
  const openPrs = JSON.parse(exec("gh", ["pr", "list", "--state", "open", "--json", "number,files", "--limit", "100"])).map((p) => ({ number: p.number, files: (p.files ?? []).map((f) => f.path) }));
  const vercelCronDiff = pr.files.includes("vercel.json") ? exec("git", ["diff", `origin/main...${pr.headRefOid}`, "--", "vercel.json"]) : "";
  const manifest = buildManifest({ pr, approvedSha, mainMigrationVersions, openPrs, vercelCronDiff });
  io.out(formatManifest(manifest));
  return manifest.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  }
}
