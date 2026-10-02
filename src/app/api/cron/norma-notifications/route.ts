import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { createNormaSlackPoster, drainNormaNotifications, readNormaSlackConfig } from "@/lib/norma/slack-worker";

export const maxDuration = 60;

/**
 * Norma Slack outbox worker (PLAN section 4). Posts one channel summary per
 * completed call. A no-op that leaves rows pending while NORMA_SLACK_BOT_TOKEN
 * or NORMA_SLACK_CHANNEL_ID is unset. Never changes CRM state.
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
    const config = readNormaSlackConfig();
    const summary = await drainNormaNotifications({
      client: createAdminClient(),
      post: config ? createNormaSlackPoster(config) : null,
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: "cron_norma_notifications" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
