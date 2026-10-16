#!/usr/bin/env tsx
/**
 * Re-mask an existing nine-question report + probabilities file in place using
 * the property addresses of the replayed window (read-only SELECT, rolled back),
 * the regex address masker and the number+word fallback. No paid calls.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { fail } from "./cli";
import { withReadOnlyTransaction } from "./db";
import { buildKnownAddressMasker, maskAddresses } from "./mask";

async function main() {
  const [report, probs] = process.argv.slice(2);
  const dbUrl = process.env.REPLAY_SOURCE_DB_URL;
  if (!dbUrl || !report || !probs) fail("usage: nine-remask <report.md> <probabilities.json> (REPLAY_SOURCE_DB_URL set)");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  let rows: { address: string | null; city: string | null }[];
  try {
    rows = (await withReadOnlyTransaction(client, async (q) =>
      (await q(
        `select distinct p.address, p.city from public.properties p
          where p.id in (select property_id from public.messages
                          where channel='sms' and direction='inbound' and created_at >= now() - interval '31 days' and property_id is not null)`,
      )).rows)) as typeof rows;
  } finally {
    await client.end();
  }
  const known = buildKnownAddressMasker(rows);
  const mask = (t: string) => maskAddresses(known(t));
  console.log(`remask: ${rows.length} property addresses loaded`);
  const md = readFileSync(report, "utf8").split("\n").map((l) => (/^\| \d+ \|/.test(l) ? mask(l) : l)).join("\n");
  writeFileSync(report, md);
  const data = JSON.parse(readFileSync(probs, "utf8")) as { reply: string; ourLastText: string | null }[];
  for (const d of data) {
    d.reply = mask(d.reply);
    if (d.ourLastText) d.ourLastText = mask(d.ourLastText);
  }
  writeFileSync(probs, JSON.stringify(data, null, 1), { mode: 0o600 });
}
main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
