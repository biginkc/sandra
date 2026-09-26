import { NextResponse } from "next/server";

import { reportError, reportInfo } from "@/lib/errors/report";
import { syncCoachScriptCache } from "@/lib/coach/script-cache";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.CLOSER_LAB_API_BASE_URL || !process.env.SANDRA_SERVICE_TOKEN) {
    reportInfo("Coach script sync skipped: CLOSER_LAB_API_BASE_URL or SANDRA_SERVICE_TOKEN is not configured", {
      tags: { surface: "coach_script_sync", outcome: "missing_configuration" },
    });
    return NextResponse.json({ ok: true, skipped: "missing_configuration" });
  }
  try {
    const result = await syncCoachScriptCache({ fetch, admin: createAdminClient() as never });
    return NextResponse.json(result);
  } catch (error) {
    reportError(error, { tags: { surface: "cron_coach_script_sync" } });
    return NextResponse.json({ error: "coach script sync failed" }, { status: 503 });
  }
}
