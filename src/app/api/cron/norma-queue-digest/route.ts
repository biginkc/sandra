import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { readNormaQueueConfig } from "@/lib/norma/queue/config";

export const maxDuration = 60;

/**
 * Norma queue digest (plan [B21]), every 15 minutes (Vercel cron is UTC). The gating, dedupe, lease and retry logic
 * lives in `runNormaQueueDigestTick`. The Slack message text built from a digest payload is user-facing copy that
 * is pending Jarrad's approval, so this route does not post anything yet: with the queue flag on it reports
 * `digest_copy_pending` and writes nothing. Wire `post` here once the copy is approved.
 */
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const config = readNormaQueueConfig(process.env);
    if (!config.enabled) return NextResponse.json({ skipped: "disabled" });
    return NextResponse.json({ skipped: "digest_copy_pending" });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_norma_queue_digest" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
