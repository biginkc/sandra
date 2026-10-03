import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { runSlackUnfurlSweep } from "@/lib/integrations/slack/unfurl-worker";

export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, ...(await runSlackUnfurlSweep()) });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_slack_unfurl_sweep" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
