#!/usr/bin/env tsx
/**
 * Skip-trace — local smoke against the real Tracerfy API.
 *
 * Proves the parts the unit + integration tests skip:
 *   1. The Tracerfy client actually loads + the API key works
 *   2. Single lookup returns the schema we expect
 *   3. Account balance read works
 *
 * Cost: 5 credits per hit (1 lookup) — the script only hits one
 * address. At Tracerfy's standard credit rate this is roughly
 * $0.10–0.15 per run.
 *
 * Usage:
 *   TRACERFY_API_KEY=xxx SKIP_TRACE_PROVIDER=tracerfy npx tsx scripts/smoke-skip-trace.ts
 *   (or put both vars in .env.local and run without the prefix)
 *
 * Customize the test address with TRACERFY_SMOKE_ADDRESS / _CITY /
 * _STATE / _ZIP env vars. Defaults to a known Kansas City address.
 */

import fs from "node:fs";
import path from "node:path";

import { TracerfyProvider } from "../src/lib/skip-trace/providers/tracerfy";

function loadLocalEnv(file: string): Record<string, string> {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadLocalEnv(".env.local"), ...process.env };
if (!env.TRACERFY_API_KEY) {
  console.error(
    "Missing TRACERFY_API_KEY. Add it to .env.local or pass it inline.",
  );
  process.exit(2);
}
const apiKey: string = env.TRACERFY_API_KEY;

const ADDRESS = env.TRACERFY_SMOKE_ADDRESS ?? "1600 Pennsylvania Ave NW";
const CITY = env.TRACERFY_SMOKE_CITY ?? "Washington";
const STATE = env.TRACERFY_SMOKE_STATE ?? "DC";
const ZIP = env.TRACERFY_SMOKE_ZIP ?? "20500";

async function main() {
  const provider = new TracerfyProvider(apiKey);

  console.log(`\nTracerfy smoke — provider=${provider.providerId}`);
  console.log("=".repeat(60));

  // 1. Account balance
  let balance = -1;
  try {
    balance = await provider.getBalance();
    console.log(`\n[OK] balance check: ${balance} credits available`);
  } catch (e) {
    console.error(`[FAIL] balance check:`, e);
    process.exit(1);
  }

  if (balance < 5) {
    console.error(
      `\nBalance is only ${balance} credits — single lookup needs 5. Top up first.`,
    );
    process.exit(1);
  }

  // 2. Single lookup
  const t0 = Date.now();
  try {
    const result = await provider.lookupSingle({
      propertyId: "smoke-test",
      address: ADDRESS,
      city: CITY,
      state: STATE,
      zip: ZIP,
    });
    const ms = Date.now() - t0;
    console.log(`\n[OK] lookupSingle  (${ms}ms)`);
    console.log(`     query:      ${ADDRESS}, ${CITY}, ${STATE} ${ZIP}`);
    console.log(`     hit:        ${result.hit}`);
    console.log(`     credits:    ${result.creditsDeducted}`);
    console.log(`     persons:    ${result.persons.length}`);
    if (result.hit && result.persons.length > 0) {
      const owner = result.persons[0];
      console.log(`     name:       ${owner.firstName ?? "?"} ${owner.lastName ?? "?"}`);
      console.log(`     phones:     ${owner.phones.length} (${owner.phones.slice(0, 3).map((p) => `${p.number}${p.dnc ? "*DNC" : ""}`).join(", ")})`);
      console.log(`     emails:     ${owner.emails.length} (${owner.emails.slice(0, 2).map((e) => e.email).join(", ")})`);
    }
  } catch (e) {
    console.error(`\n[FAIL] lookupSingle:`, e);
    process.exit(1);
  }

  console.log(`\n${"=".repeat(60)}\nDone.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
