import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { readCanaryControl } from "../src/lib/sequences/canary-controls";

async function main() {
  const url = process.env.PROD_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const mode = process.env.GITHUB_EVENT_NAME === "schedule" ? "scheduled" : "manual";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  if (!url || !key || !/^\d+$/.test(runId)) throw new Error("Canary authorization inputs unavailable");
  const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const control = mode === "scheduled" ? "SEQUENCE_CANARY_SCHEDULE_ENABLED" : "SEQUENCE_CANARY_MANUAL_RUN_ID";
  const expected = mode === "scheduled" ? "true" : runId;
  if (await readCanaryControl(client, control) !== expected) throw new Error("Canary authorization disabled");
  console.log("Current canary authorization permits this run");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
