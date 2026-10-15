#!/usr/bin/env node
// One-off, READ-ONLY comparison for the My Leads unified work queue (design v7, Phase A1).
//
// For one rep it prints, side by side:
//   OLD  today's Call next top ten (my_leads_call_next_rows), the stage section, and the drip
//        section (leads in an active drip, which Call next leaves out)
//   NEW  the lead's tab, chip and decision row from my_leads_work_classified
// and then lists every lead that is in NEITHER Needs attention NOR Waiting on them, with its reason.
//
// It never writes: the whole run is one `begin read only` transaction that is rolled back. Both
// functions it calls are internal (not granted to any API role), so it needs a direct database
// connection, not the app's API keys.
//
// DO NOT RUN THIS AGAINST PRODUCTION. It refuses the production project host and requires the
// connection string in COMPARE_DB_URL (it never reads .env files). Run it against the test project
// or a local database that holds the A1 migration (20261015010000_my_leads_work_queue_classifier):
//
//   COMPARE_DB_URL='postgresql://...test-project or 127.0.0.1...' \
//     node scripts/my-leads-work-compare.mjs --org <org uuid> --member <rep uuid> [--at <iso time>] [--json]
//
// Local example (disposable database with the repo's migrations applied):
//   COMPARE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54329/postgres' \
//     node scripts/my-leads-work-compare.mjs --org <org> --member <rep>
//
// Note: the classifier takes the pending offer from the LATEST offer by sent_at (as my_leads_queue_rows does); Call next
// takes the latest PENDING offer. They only differ for a lead whose newest offer is no longer pending.
//
// Exit codes: 0 ok, 2 bad arguments or a refused connection string, 1 database error.
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const PRODUCTION_PROJECT_REFS = ['copflsklaefwzipsrjqz'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--org' || a === '--member' || a === '--at') { out[a.slice(2)] = argv[i + 1]; i += 1; }
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.org || !UUID.test(out.org)) throw new Error('--org <uuid> is required');
  if (!out.member || !UUID.test(out.member)) throw new Error('--member <uuid> is required');
  if (out.at && Number.isNaN(Date.parse(out.at))) throw new Error('--at must be an ISO timestamp');
  return out;
}

export function refuseProduction(url) {
  if (!url) throw new Error('COMPARE_DB_URL is required (the script never reads .env files)');
  const lowered = url.toLowerCase();
  for (const ref of PRODUCTION_PROJECT_REFS) {
    if (lowered.includes(ref)) throw new Error(`refusing to run against the production project (${ref})`);
  }
}

// Old-world placement for one lead, from the same SQL the page uses today.
export function oldPlacement(callNext, inDrip, topTen) {
  if (inDrip) return 'drip section';
  if (!callNext) return 'stage section only';
  if (topTen.has(callNext.property_id)) return `Call next #${[...topTen].indexOf(callNext.property_id) + 1}`;
  return 'stage section only';
}

export async function compare(client, { org, member, at }) {
  await client.query('begin isolation level repeatable read read only');
  try {
    const when = at ? new Date(at).toISOString() : (await client.query('select statement_timestamp() as t')).rows[0].t.toISOString();
    const callNext = (await client.query('select * from public.my_leads_call_next_rows($1,$2,$3)', [org, member, when])).rows;
    const work = (await client.query('select * from public.my_leads_work_classified($1,$2,$3)', [org, member, when])).rows;
    const drips = new Set((await client.query(
      "select distinct property_id from public.sequence_enrollments where org_id=$1 and status='active'", [org])).rows.map((r) => r.property_id));
    // Today's strip: rank by tier, sort key, assignment age, id; excluded and hidden leads are not on it.
    const ranked = callNext
      .filter((r) => !r.excluded_reason && !r.hidden)
      .sort((a, b) => a.tier - b.tier || a.sort_key - b.sort_key || new Date(a.assignment_sort) - new Date(b.assignment_sort) || (a.property_id < b.property_id ? -1 : 1));
    const topTen = new Set(ranked.slice(0, 10).map((r) => r.property_id));
    const byProperty = new Map(callNext.map((r) => [r.property_id, r]));
    const rows = work.map((w) => ({
      propertyId: w.property_id,
      address: w.facts.row?.address ?? null,
      stage: w.stage,
      old: oldPlacement(byProperty.get(w.property_id), drips.has(w.property_id), topTen),
      oldCallNextReason: byProperty.get(w.property_id)?.reason ?? null,
      tab: w.place === 'your_move' ? 'Needs attention' : w.place === 'their_move' ? 'Waiting on them' : 'All leads only',
      chip: w.reason,
      decisionRow: w.row_no,
      labels: w.labels,
    }));
    const neither = rows.filter((r) => r.tab === 'All leads only');
    const strip = ranked.slice(0, 10).map((r, i) => {
      const w = rows.find((x) => x.propertyId === r.property_id);
      return { rank: i + 1, propertyId: r.property_id, address: r.row_data?.address ?? null, oldReason: r.reason, newTab: w?.tab ?? 'not in queue', newChip: w?.chip ?? null, decisionRow: w?.decisionRow ?? null };
    });
    const tally = {};
    for (const r of rows) tally[`${r.tab} / ${r.chip}`] = (tally[`${r.tab} / ${r.chip}`] ?? 0) + 1;
    return { at: when, org, member, leadCount: rows.length, callNextTopTen: strip, leads: rows, inNeitherTab: neither, tally };
  } finally {
    await client.query('rollback');
  }
}

function print(result) {
  const pad = (v, n) => String(v ?? '').slice(0, n).padEnd(n);
  console.log(`My Leads work queue comparison for member ${result.member} at ${result.at} (${result.leadCount} leads)\n`);
  console.log('Call next top ten today -> new placement');
  for (const r of result.callNextTopTen) console.log(`  #${pad(r.rank, 2)} ${pad(r.address, 28)} ${pad(r.oldReason, 24)} -> ${pad(r.newTab, 16)} ${pad(r.newChip, 16)} row ${r.decisionRow}`);
  console.log('\nEvery lead: old placement -> new tab / chip');
  for (const r of result.leads) {
    console.log(`  ${pad(r.address, 28)} ${pad(r.stage, 14)} ${pad(r.old, 20)} -> ${pad(r.tab, 16)} ${pad(r.chip, 16)} row ${pad(r.decisionRow, 3)} ${r.labels.join(',')}`);
  }
  console.log('\nCounts by new placement');
  for (const [k, v] of Object.entries(result.tally).sort()) console.log(`  ${pad(k, 44)} ${v}`);
  console.log(`\nLeads in NEITHER Needs attention NOR Waiting on them (${result.inNeitherTab.length}), each with its reason`);
  for (const r of result.inNeitherTab) console.log(`  ${pad(r.address, 28)} stage ${pad(r.stage, 14)} decision row ${r.decisionRow} (${r.chip}); old: ${r.old}`);
  if (result.inNeitherTab.length === 0) console.log('  none');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    refuseProduction(process.env.COMPARE_DB_URL);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: process.env.COMPARE_DB_URL });
  try {
    await client.connect();
    const result = await compare(client, args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else print(result);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
