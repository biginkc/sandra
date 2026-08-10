import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import {
  captureSkipTraceBalanceSnapshot,
  isWithinCreditRefreshWindow,
} from "@/lib/skip-trace/balance";
import { createAdminClient } from "@/lib/supabase/admin";

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  if (!isWithinCreditRefreshWindow(now)) {
    return NextResponse.json({ ok: true, skipped: "outside_business_window" });
  }

  try {
    const snapshot = await captureSkipTraceBalanceSnapshot(
      createAdminClient(),
      now,
    );
    return NextResponse.json({
      ok: true,
      credits: snapshot.credits,
      capturedAt: snapshot.capturedAt,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_skip_trace_balance" } });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
