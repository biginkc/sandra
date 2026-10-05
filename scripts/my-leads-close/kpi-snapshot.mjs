#!/usr/bin/env node
// Read-only KPI snapshot for the next-step relabel parity check (TECH-PLAN Phase 4, item 4.6).
//
//   SANDRA_PRODUCTION_DATABASE_URL=... node scripts/my-leads-close/kpi-snapshot.mjs \
//     --org <uuid> --owner <owner uid> --member <uuid> [--member <uuid> ...] --out kpi-before.json \
//     [--from 2026-09-12] [--migration-applied-at <iso>] [--windows-from kpi-before.json]
//
// The after snapshot must pass `--windows-from <before file>` (reuses the exact windows) and
// `--migration-applied-at <iso>`; kpi-compare only compares windows ending at or before that instant.
//
// Refuses any database whose project ref is not production, forces every transaction read-only, and
// records `{error: code}` for a member the function rejects (compared as equal-to-itself, never skipped).
// The connection string is supplied by `op run`; nothing here reads a vault or prints a secret.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXPECTED_PROJECT_REF = "copflsklaefwzipsrjqz";
export const DATABASE_URL_ENV = "SANDRA_PRODUCTION_DATABASE_URL";
export const CENTRAL = "America/Chicago";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the connection string points at the production project (pooler or direct host). */
export function isProductionRef(connectionString, expected = EXPECTED_PROJECT_REF) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const user = decodeURIComponent(url.username).toLowerCase();
  return host === `db.${expected}.supabase.co` || user === `postgres.${expected}`;
}

function centralDayStart(date) {
  // The instant of 00:00 America/Chicago on the Central calendar day containing `date`.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  // Probe offsets at 05:00Z and 06:00Z: Central is UTC-5 (CDT) or UTC-6 (CST).
  for (const hour of [5, 6]) {
    const guess = new Date(`${day}T0${hour}:00:00.000Z`);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric", hour12: false, day: "2-digit" }).formatToParts(guess);
    const h = Number(local.find((p) => p.type === "hour")?.value) % 24;
    const d = local.find((p) => p.type === "day")?.value;
    if (h === 0 && d === day.slice(8, 10)) return guess;
  }
  throw new Error(`cannot resolve Central midnight for ${day}`);
}

/**
 * Windows per the plan: every completed Central day from `fromDate`, plus the September month, plus
 * `[fromDate, start of the migration day Central)`. `now` bounds "completed" days.
 */
export function buildWindows(now, fromDate = "2026-09-12", migrationAppliedAt = now) {
  const windows = [];
  const todayStart = centralDayStart(now);
  let cursor = centralDayStart(new Date(`${fromDate}T12:00:00.000Z`));
  while (cursor < todayStart) {
    const next = centralDayStart(new Date(cursor.getTime() + 36 * 3600_000));
    windows.push({ label: `day:${new Intl.DateTimeFormat("en-CA", { timeZone: CENTRAL }).format(cursor)}`, start: cursor.toISOString(), end: next.toISOString() });
    cursor = next;
  }
  windows.push({ label: "month:2026-09", start: centralDayStart(new Date("2026-09-01T12:00:00.000Z")).toISOString(), end: centralDayStart(new Date("2026-10-01T12:00:00.000Z")).toISOString() });
  const migrationDay = centralDayStart(new Date(migrationAppliedAt));
  windows.push({ label: "since-launch", start: centralDayStart(new Date(`${fromDate}T12:00:00.000Z`)).toISOString(), end: migrationDay.toISOString() });
  return windows;
}

/** The before file's windows, verbatim, so both snapshots measure identical intervals. */
export function windowsFromFile(path) {
  const windows = JSON.parse(readFileSync(path, "utf8")).windows;
  if (!Array.isArray(windows) || windows.length === 0) throw new Error(`${path} has no windows to reuse`);
  return windows;
}

export function parseArgs(argv) {
  const out = { members: [], from: "2026-09-12", migrationAppliedAt: null, windowsFrom: null, out: null, org: null, owner: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--org") out.org = value;
    else if (flag === "--owner") out.owner = value;
    else if (flag === "--member") out.members.push(value);
    else if (flag === "--from") out.from = value;
    else if (flag === "--migration-applied-at") out.migrationAppliedAt = value;
    else if (flag === "--windows-from") out.windowsFrom = value;
    else if (flag === "--out") out.out = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  for (const id of [out.org, out.owner, ...out.members]) if (!id || !UUID.test(id)) throw new Error("--org, --owner and every --member must be UUIDs");
  if (out.members.length === 0) throw new Error("at least one --member is required");
  if (!out.out) throw new Error("--out is required");
  if (out.windowsFrom && !out.migrationAppliedAt) throw new Error("--windows-from (the after snapshot) requires --migration-applied-at");
  if (out.migrationAppliedAt && Number.isNaN(Date.parse(out.migrationAppliedAt))) throw new Error("--migration-applied-at must be an ISO timestamp");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from)) throw new Error("--from must be YYYY-MM-DD");
  return out;
}

/**
 * Takes one snapshot. `client` is a connected pg Client; every window runs in its own read-only
 * transaction as the owner JWT identity (My Leads reads need auth.uid(), plan F4).
 */
export async function snapshot(client, { org, owner, members, windows, now = new Date() }) {
  await client.query("set default_transaction_read_only = on");
  const rows = [];
  for (const member of members) {
    for (const window of windows) {
      await client.query("begin read only");
      try {
        await client.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
        await client.query("select set_config('request.jwt.claim.role','authenticated',true)");
        await client.query("set local role authenticated");
        const r = await client.query("select public.fn_get_acquisition_kpis($1::uuid,$2::uuid,$3::timestamptz,$4::timestamptz) as kpi", [org, member, window.start, window.end]);
        rows.push({ member, window: window.label, kpi: r.rows[0].kpi });
      } catch (error) {
        const code = error?.code ?? "ERROR";
        const message = String(error?.message ?? "");
        const known = /NOT_FOUND|FORBIDDEN/.exec(message)?.[0] ?? code;
        rows.push({ member, window: window.label, kpi: { error: known } });
      } finally {
        await client.query("rollback").catch(() => {});
      }
    }
  }
  const version = await client.query("select max(version) as v from supabase_migrations.schema_migrations").catch(() => ({ rows: [{ v: null }] }));
  return { capturedAt: now.toISOString(), schemaVersion: version.rows[0]?.v ?? null, windows, rows };
}

export async function main(argv, env = process.env, io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }) {
  const args = parseArgs(argv);
  const url = env[DATABASE_URL_ENV];
  if (!url) throw new Error(`${DATABASE_URL_ENV} must be provided by op run`);
  if (!isProductionRef(url)) throw new Error("kpi-snapshot refuses a database that is not the production project");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, application_name: "my-leads-close-kpi-snapshot" });
  await client.connect();
  try {
    const now = new Date();
    const windows = args.windowsFrom ? windowsFromFile(args.windowsFrom) : buildWindows(now, args.from, args.migrationAppliedAt ?? now);
    const result = await snapshot(client, { org: args.org, owner: args.owner, members: args.members, windows, now });
    if (args.migrationAppliedAt) result.migrationAppliedAt = args.migrationAppliedAt;
    writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
    io.out(`wrote ${args.out}: ${result.rows.length} rows, schema ${result.schemaVersion}\n`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exit(1);
    },
  );
}
