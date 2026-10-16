import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { compareSnapshots, deleteTagged, snapshot, type Snapshot } from "./cleanup";
import { assertStressDbEnv } from "./core";
import { CANARY_ORG_ID } from "./d-lane-fixture";

/**
 * Run 7 (D lane) for a Run 4 seed: delete every row tagged `STRESS <runId>` in the canary org, then compare the
 * untagged counts with the snapshot load-seed.ts took BEFORE seeding. Exit 1 unless every untagged count is
 * identical and no tagged row is left. Disposable stack only.
 *
 *   MV2_STRESS_RUN_ID=<the seed's run id> npm run stress:messages-v2:cleanup
 */
async function main() {
  assertStressDbEnv(process.env);
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  const runId = process.env.MV2_STRESS_RUN_ID;
  if (!runId) throw new Error("MV2_STRESS_RUN_ID is required (the tag to delete)");
  const out = path.resolve(process.env.MV2_STRESS_OUT_DIR ?? "test-results/messages-v2-stress");
  const before = JSON.parse(readFileSync(path.join(out, `cleanup-before-${runId}.json`), "utf8")) as Snapshot;
  const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
  await pg.connect();
  try {
    const mid = await snapshot(pg, CANARY_ORG_ID, runId);
    const deleted = await deleteTagged(pg, CANARY_ORG_ID, runId);
    const after = await snapshot(pg, CANARY_ORG_ID, runId);
    const verdict = compareSnapshots(before, after);
    const result = { lane: "D", runId, before, mid, deleted, after, verdict };
    writeFileSync(path.join(out, `cleanup-${runId}.json`), JSON.stringify(result, null, 1));
    const rows = Object.keys(before.tables).map((t) => `${t.padEnd(26)} untagged ${String(before.tables[t].untagged).padStart(7)} -> ${String(after.tables[t].untagged).padStart(7)}   tagged ${String(mid.tables[t].tagged).padStart(6)} -> ${after.tables[t].tagged}`);
    console.log([`Run 7 cleanup (D lane) run ${runId}  before ${before.sha256.slice(0, 12)}  after ${after.sha256.slice(0, 12)}`, ...rows, `verdict: ${JSON.stringify(verdict)}`].join("\n"));
    if (!verdict.ok) process.exit(1);
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
