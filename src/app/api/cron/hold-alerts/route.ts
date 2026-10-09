import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { runHoldAlertsForAllOrgs } from "@/lib/hold-alerts";
import type { Database } from "@/lib/supabase/types";

/**
 * Vercel cron -> `/api/cron/hold-alerts` every five minutes (Messages v2
 * Phase 1, PLAN 4.7 / 4.11). Creates durable hold_alert_deliveries rows and
 * sends Slack DMs (first + 1h nudge), hot-hold SMS to the owner, and (behind
 * HOLD_ALERT_EMAIL_ENABLED=1) the hourly email digest. Nothing sends unless
 * HOLD_ALERTS_ENABLED=1. Payloads carry ids, first names and a link only, never
 * seller message text or the property address.
 */
export const maxDuration = 60;

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("hold alerts need Supabase service credentials.");
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runHoldAlertsForAllOrgs(createServiceRoleClient(), {
      onError: (error, orgId) =>
        reportError(error, { tags: { surface: "cron_hold_alerts" }, extra: { orgId } }),
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_hold_alerts" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
