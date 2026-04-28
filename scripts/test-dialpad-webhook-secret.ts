#!/usr/bin/env tsx
/**
 * Tester for `DIALPAD_WEBHOOK_SECRET` candidates. Forges a Dialpad-shape
 * JWT signed with whatever secret you pass and POSTs it to the prod
 * inbound webhook. The response tells you if the secret matches:
 *
 *   200  → matches the value Vercel has stored. Use this one.
 *   401  → wrong secret. Try the next candidate.
 *
 * Usage:
 *   DIALPAD_WEBHOOK_SECRET='candidate1' npx tsx scripts/test-dialpad-webhook-secret.ts
 *
 * No DB writes, no cleanup needed — even on a 200 the inbound lands as
 * an unmatched message in Sandra (from a fake number that doesn't exist
 * in contacts), so it just becomes one more unknown-sender row.
 */

import { createHmac } from "node:crypto";

const secret = process.env.DIALPAD_WEBHOOK_SECRET;
if (!secret || secret === '""' || secret === "") {
  console.error(
    "DIALPAD_WEBHOOK_SECRET is empty. Pass it in:\n" +
      "  DIALPAD_WEBHOOK_SECRET='your-candidate' npx tsx scripts/test-dialpad-webhook-secret.ts",
  );
  process.exit(2);
}

const PROD_URL = "https://sandra-sooty.vercel.app/api/webhooks/dialpad/sms";

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function main(): Promise<void> {
  const TS = Date.now();
  const event = {
    id: `secret-test-${TS}`,
    from_number: `+1555${String(TS).slice(-7)}`,
    to_number: "+18162804181",
    text: "[secret-tester] ignore — Sandra is checking a webhook secret candidate",
    timestamp: new Date().toISOString(),
  };

  const header = base64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"),
  );
  const payload = base64url(Buffer.from(JSON.stringify(event), "utf8"));
  const sig = createHmac("sha256", secret as string)
    .update(`${header}.${payload}`)
    .digest();
  const jwt = `${header}.${payload}.${base64url(sig)}`;

  const res = await fetch(PROD_URL, {
    method: "POST",
    headers: { "content-type": "application/jwt" },
    body: jwt,
  });

  if (res.status === 200) {
    console.log(`✓ MATCH — secret accepted by prod webhook (200).`);
    console.log(
      `  Use this value for PROD_DIALPAD_WEBHOOK_SECRET in GitHub secrets.`,
    );
    process.exit(0);
  } else if (res.status === 401) {
    console.log(`✗ NO MATCH — prod returned 401. Try the next candidate.`);
    process.exit(1);
  } else {
    console.log(
      `? UNEXPECTED — prod returned ${res.status}. Body: ${await res.text()}`,
    );
    process.exit(1);
  }
}

main();
