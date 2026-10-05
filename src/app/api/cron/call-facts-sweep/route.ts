import { NextResponse } from "next/server";

import { createFactsExtractorFromEnv, runCallFactsSweep, type ClaimResult } from "@/lib/call-facts";
import { CLAIM_BATCH, CLAIM_LEASE_SECONDS, CLAIM_WINDOW_HOURS } from "@/lib/call-facts/budget";
import { reportError } from "@/lib/errors/report";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createAdminClient } from "@/lib/supabase/admin";

// Worst case for the claimed call is bounded in budget.ts (asserted by budget.test.ts) and the lease outlives it.
// Plan default is 300s; this literal must equal ROUTE_MAX_DURATION_S (Next reads it statically).
export const maxDuration = 300;

/**
 * Call facts sweep (§3.12). Claims and extracts only: it returns `{ ok: true, disabled }` before
 * claiming anything unless the `call_facts` schema is ready AND at least one org has `facts_job`
 * on (the flag defaults OFF; the claim function also filters per org). It fetches nothing from any
 * provider. Without TYPESAFE_API_KEY or an approved question text the extractor is null and the
 * sweep writes only the Dialpad summary note.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (!(await schemaReady("call_facts"))) return NextResponse.json({ ok: true, disabled: "schema_not_ready" });
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose = admin as any;
    const flags = await loose.from("my_leads_feature_flags").select("org_id").eq("facts_job", true).limit(1);
    if (flags.error || !Array.isArray(flags.data) || flags.data.length === 0) {
      return NextResponse.json({ ok: true, disabled: "flag_off" });
    }
    const result = await runCallFactsSweep(CLAIM_BATCH, {
      extractor: createFactsExtractorFromEnv(),
      claim: async (limit) => {
        const { data, error } = await loose.rpc("fn_claim_call_facts", { p_limit: limit, p_lease_seconds: CLAIM_LEASE_SECONDS, p_window_hours: CLAIM_WINDOW_HOURS });
        if (error) throw error;
        return data as ClaimResult;
      },
      complete: async ({ factId, claimToken, facts, status, model }) => {
        const { error } = await loose.rpc("fn_complete_call_facts", {
          p_fact_id: factId,
          p_claim_token: claimToken,
          p_facts: facts,
          p_status: status,
          p_model: model,
        });
        if (error) throw error;
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_call_facts_sweep" } });
    return NextResponse.json({ error: "call facts sweep failed" }, { status: 503 });
  }
}
