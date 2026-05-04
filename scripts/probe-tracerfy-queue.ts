#!/usr/bin/env tsx
/**
 * Probe Tracerfy for the status of a batch queue id.
 *
 * Usage:
 *   TRACERFY_API_KEY=xxx npx tsx scripts/probe-tracerfy-queue.ts <queueId>
 *
 * Read-only — uses GET /queue/:id, which doesn't deduct credits.
 */

import { TracerfyProvider } from "../src/lib/skip-trace/providers/tracerfy";

async function main() {
  const queueId = process.argv[2];
  if (!queueId) {
    console.error("Usage: probe-tracerfy-queue.ts <queueId>");
    process.exit(1);
  }
  const apiKey = process.env.TRACERFY_API_KEY;
  if (!apiKey) {
    console.error("TRACERFY_API_KEY not set");
    process.exit(1);
  }
  const provider = new TracerfyProvider(apiKey);
  const rows = await provider.pollBatch(queueId);
  if (rows === null) {
    console.log(JSON.stringify({ queueId, status: "pending" }, null, 2));
    return;
  }
  const hits = rows.filter((r) => r.hit).length;
  const credits = rows.reduce((s, r) => s + (r.creditsDeducted ?? 0), 0);
  console.log(
    JSON.stringify(
      {
        queueId,
        status: "complete",
        rows: rows.length,
        hits,
        misses: rows.length - hits,
        creditsDeducted: credits,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
