import { NextResponse } from "next/server";

import { drainCompQueue } from "@/lib/comps";
import { reportError } from "@/lib/errors/report";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * Comp queue drain (§3.2). Claims nothing unless the `lead_comps` schema is ready and at least
 * one org has the `comp_queue` flag on; the SQL cap ledger (default cap 0) is the spend control.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    if (!(await schemaReady("lead_comps"))) return NextResponse.json({ ok: true, disabled: "schema_not_ready" });
    const admin = createAdminClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flags = await (admin as any).from("my_leads_feature_flags").select("org_id").eq("comp_queue", true).limit(1);
    if (flags.error || !Array.isArray(flags.data) || flags.data.length === 0) {
      return NextResponse.json({ ok: true, disabled: "flag_off" });
    }
    const reaped = await admin.rpc("fn_reap_stuck_comp_fetches" as never);
    // Per-row org gate: a row queued before an org's flag went off is cancelled, not fetched.
    const orgAllowed = async (orgId: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (admin as any).from("my_leads_feature_flags").select("comp_queue").eq("org_id", orgId).maybeSingle();
      return !r.error && r.data?.comp_queue === true;
    };
    const result = await drainCompQueue(3, { admin, orgAllowed });
    return NextResponse.json({ ok: true, reaped: reaped.data ?? 0, claimed: result.claimed, done: result.ok, failed: result.failed });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_comp_queue_drain" } });
    return NextResponse.json({ error: "comp queue drain failed" }, { status: 503 });
  }
}
