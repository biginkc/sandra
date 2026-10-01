import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { assertNoUnacknowledgedCanaryFailure } from "../src/lib/sequences/canary-failure-latch";

async function main() {
  const url = process.env.PROD_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) throw new Error("Canary history unavailable");
  const client = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await assertNoUnacknowledgedCanaryFailure(
    process.env.GITHUB_RUN_ID ?? "",
    process.env.GITHUB_TOKEN ?? "",
    client,
  );
  console.log("Prior completed full canary run permits enrollment");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
