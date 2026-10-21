#!/usr/bin/env tsx
/**
 * Answer sellers who asked for our offer before the approved asked_offer reply
 * shipped (PR #909, 2026-10-20). See src/lib/ai-responder/asked-offer-backfill.ts.
 *
 * Dry run is the default: reads the database, asks Jev, writes nothing, and
 * prints the target list. Writes need --apply AND an explicit human yes on the
 * dry-run list (these are real sellers).
 *
 * Usage
 *   vercel env pull --environment=production <scratch>/.env.sandra-prod
 *   env $(grep -v '^#' <scratch>/.env.sandra-prod | xargs) \
 *     npx tsx scripts/backfill-asked-offer-replies.ts [--apply] [--only <propertyId>]...
 *
 * --apply queues the approved text in the normal outbox (scheduled now). The
 * production sequence-tick drain releases it, re-checking consent, opt-out,
 * suppression, human-owned dispositions and quiet hours, and sends through the
 * configured provider. A second run skips every lead it queued ("texted_since").
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  ASKED_OFFER_BACKFILL_BODY,
  liveClassifier,
  runAskedOfferBackfill,
  type BackfillRow,
} from "../src/lib/ai-responder/asked-offer-backfill";
import { createAdminClient } from "../src/lib/supabase/admin";

const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const BMH_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
/** PR #909 merged 2026-10-20 ~19:58 CT; inbounds from then on ran with the asked_offer reply. */
const DEFAULT_BEFORE = "2026-10-21T00:58:00Z";
const DEFAULT_SINCE_DAYS = 30;
/**
 * Already handled by hand (2026-10-20): five texts queued in Messages, and Lees
 * Summit, which got this answer on Oct 2.
 */
const ALWAYS_EXCLUDED = [
  "438d2cc1-0af7-4be5-a4f6-ac6ae461b29b",
  "5c4c6a14-5ae2-44f6-b42c-ffb1a2ace2fc",
  "5e4db5f3-6cfd-44cf-b353-7a4f7ea87fe9",
  "58c4115a-034d-4eea-9bf6-2c54ad9d4d08",
  "4e64ede3-c441-4999-9ca3-075996a1b181",
  "dfa97566-421c-4b09-9daf-782861d8be1a",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Options = {
  apply: boolean;
  statuses: string[];
  since: Date;
  before: Date;
  exclude: string[];
  only: string[];
  out: string;
};

function value(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

function uuid(v: string, flag: string): string {
  if (!UUID.test(v)) throw new Error(`${flag}: not a uuid: ${v}`);
  return v.toLowerCase();
}

function date(v: string, flag: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${flag}: not a date: ${v}`);
  return d;
}

function parse(argv: string[]): Options {
  const o: Options = {
    apply: false,
    statuses: [],
    since: new Date(Date.now() - DEFAULT_SINCE_DAYS * 86_400_000),
    before: new Date(DEFAULT_BEFORE),
    exclude: [],
    only: [],
    out: `tmp/asked-offer-backfill/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--status") o.statuses.push(value(argv, ++i, a));
    else if (a === "--since") o.since = date(value(argv, ++i, a), a);
    else if (a === "--before") o.before = date(value(argv, ++i, a), a);
    else if (a === "--exclude") o.exclude.push(uuid(value(argv, ++i, a), a));
    else if (a === "--only") o.only.push(uuid(value(argv, ++i, a), a));
    else if (a === "--out") o.out = value(argv, ++i, a);
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: tsx scripts/backfill-asked-offer-replies.ts [options]
  --apply              Queue the approved text for every target (default: dry run, no writes).
  --status <s>         Lead status to scan; repeatable. Default: new_lead.
  --since <iso>        Oldest inbound to consider. Default: ${DEFAULT_SINCE_DAYS} days ago.
  --before <iso>       Inbounds at or after this ran with the new reply. Default: ${DEFAULT_BEFORE}.
  --exclude <uuid>     Extra property to skip; repeatable (the six handled by hand are always skipped).
  --only <uuid>        Limit to these properties; repeatable.
  --out <path>         Where to write the JSON report.`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (o.statuses.length === 0) o.statuses = ["new_lead"];
  return o;
}

function assertProd(): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set.");
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== PROD_PROJECT_REF) throw new Error(`Refusing to run: ${ref} is not prod ${PROD_PROJECT_REF}.`);
}

function oneLine(s: string | null, n = 90): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function report(rows: BackfillRow[], apply: boolean): void {
  const targets = rows.filter((r) => r.target);
  console.log(`\n${apply ? "APPLY" : "DRY RUN"}: ${targets.length} target(s). Text: "${ASKED_OFFER_BACKFILL_BODY}"\n`);
  for (const r of targets) {
    const q = r.queued ? `  -> ${r.queued.status}${r.queued.detail ? ` (${r.queued.detail})` : ""}` : "";
    console.log(`  ${r.address}  |  "${oneLine(r.sellerText)}"  |  p=${r.askedOfferProbability ?? "?"}  |  ${r.propertyId}${q}`);
  }
  const notOffer = rows.filter((r) => !r.target && !r.skip && !r.classifyError);
  console.log(`\nWaiting but not asked_offer now (${notOffer.length}):`);
  for (const r of notOffer) console.log(`  ${r.answer}  |  ${r.address}  |  "${oneLine(r.sellerText)}"`);
  const skipped = rows.filter((r) => r.skip);
  console.log(`\nSkipped (${skipped.length}):`);
  for (const r of skipped) console.log(`  ${r.skip}  |  ${r.address}  |  "${oneLine(r.sellerText)}"`);
  const failed = rows.filter((r) => r.classifyError);
  if (failed.length) {
    console.log(`\nJev failed (${failed.length}), not sent:`);
    for (const r of failed) console.log(`  ${r.address}  |  ${r.classifyError}`);
  }
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  assertProd();
  const apiKey = process.env.TYPESAFE_API_KEY ?? "";
  if (!apiKey) throw new Error("TYPESAFE_API_KEY must be set (the classifier is re-asked).");
  const rows = await runAskedOfferBackfill(
    createAdminClient(),
    {
      orgId: BMH_ORG_ID,
      statuses: o.statuses,
      since: o.since,
      before: o.before,
      excludePropertyIds: new Set([...ALWAYS_EXCLUDED, ...o.exclude]),
      onlyPropertyIds: o.only.length ? new Set(o.only) : null,
      apply: o.apply,
    },
    { classify: liveClassifier(apiKey), now: () => new Date() },
  );
  report(rows, o.apply);
  const out = resolve(o.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ apply: o.apply, options: o, rows }, null, 2)}\n`);
  console.log(`\nReport: ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
