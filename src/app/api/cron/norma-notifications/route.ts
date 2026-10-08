import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNormaNotificationsCron } from "@/lib/norma/notifications-cron";
import { createNormaSlackPoster, readNormaSlackConfig } from "@/lib/norma/slack-worker";

// Keep equal to NORMA_CRON_MAX_DURATION_MS (the shared deadline in notifications-cron.ts is derived from it).
export const maxDuration = 60;

/**
 * Norma Slack outbox worker (PLAN section 4). Posts one channel summary per
 * completed call. A no-op that leaves rows pending while NORMA_SLACK_BOT_TOKEN
 * or NORMA_SLACK_CHANNEL_ID is unset. Also posts one notice per Norma follow-up reassignment (a no-op while that table does not exist). Never changes call or CRM state.
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
    const { summary, followups } = await runNormaNotificationsCron({
      client: createAdminClient(),
      post: config ? createNormaSlackPoster(config) : null,
      onFollowupError: (followupError) => reportError(followupError, { tags: { surface: "cron_norma_followup_notices" } }),
    });
    return NextResponse.json({ ok: true, ...summary, followups });
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
