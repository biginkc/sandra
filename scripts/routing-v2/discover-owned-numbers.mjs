#!/usr/bin/env node
/**
 * READ-ONLY discovery of the business's own phone numbers for the §5.4 test allowlist
 * (TEST_DEST_ALLOWLIST). One GET to Telnyx `GET /v2/phone_numbers` (paged); nothing is sent,
 * created, changed or purchased.
 *
 * Usage (the key never appears in argv or output):
 *   export OP_SERVICE_ACCOUNT_TOKEN=$(security find-generic-password -w -s OP_SERVICE_ACCOUNT_TOKEN)
 *   TELNYX_API_KEY="$(op read 'op://BMH Secrets/Telnyx - Switchboard Acceptance Dialer/credential')" \
 *     node scripts/routing-v2/discover-owned-numbers.mjs [--write-env <path>]
 *
 * Output: counts and the LAST 4 DIGITS only. With --write-env, writes
 *   TEST_DEST_ALLOWLIST=<comma-separated E.164>
 * to that file with mode 0600 (for the harness to load at run time). Never commit that file.
 */
import { chmodSync, existsSync, writeFileSync } from "node:fs";

const key = process.env.TELNYX_API_KEY ?? "";
if (!key.trim()) {
  console.error("TELNYX_API_KEY is not set (read it from 1Password with the service account).");
  process.exit(2);
}
const envFileIdx = process.argv.indexOf("--write-env");
const envFile = envFileIdx > 0 ? process.argv[envFileIdx + 1] : null;
const last4 = (n) => `…${String(n).replace(/\D/g, "").slice(-4)}`;

const numbers = [];
let page = 1;
for (;;) {
  const url = `https://api.telnyx.com/v2/phone_numbers?page[number]=${page}&page[size]=250`;
  const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  if (!res.ok) {
    console.error(`Telnyx GET /v2/phone_numbers -> HTTP ${res.status} (${res.status === 401 || res.status === 403 ? "the key cannot list numbers" : "error"})`);
    process.exit(1);
  }
  const body = await res.json();
  for (const n of body.data ?? []) {
    numbers.push({
      e164: n.phone_number,
      status: n.status ?? null,
      messaging: Boolean(n.messaging_profile_id),
      tags: Array.isArray(n.tags) ? n.tags : [],
    });
  }
  const total = body.meta?.total_pages ?? 1;
  if (page >= total) break;
  page++;
}

console.log(`owned numbers: ${numbers.length} (with a messaging profile: ${numbers.filter((n) => n.messaging).length})`);
for (const n of numbers) console.log(`  ${last4(n.e164)}  status=${n.status}  messaging=${n.messaging}${n.tags.length ? `  tags=${n.tags.length}` : ""}`);
if (envFile) {
  const allow = numbers.filter((n) => n.status === "active").map((n) => n.e164);
  // `mode` applies only when the file is created: tighten an existing file BEFORE the numbers
  // go in, and again after (in case it was replaced in between).
  if (existsSync(envFile)) chmodSync(envFile, 0o600);
  writeFileSync(envFile, `TEST_DEST_ALLOWLIST=${allow.join(",")}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(`wrote ${allow.length} active numbers to ${envFile} (mode 0600; full numbers only in that file)`);
}
