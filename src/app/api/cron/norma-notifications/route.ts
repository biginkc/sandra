import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import { drainNormaFollowupNotices } from "@/lib/norma/followup-notice";
import { createNormaSlackPoster, drainNormaNotifications, readNormaSlackConfig } from "@/lib/norma/slack-worker";

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
    const client = createAdminClient();
    const post = config ? createNormaSlackPoster(config) : null;
    const summary = await drainNormaNotifications({ client, post });
    // Follow-up reassignment notices ride the same cron and poster. A failure here must never hide the call-summary drain.
    let followups: Awaited<ReturnType<typeof drainNormaFollowupNotices>> | { error: string };
    try {
      followups = await drainNormaFollowupNotices({ client, post });
    } catch (followupError) {
      reportError(followupError, { tags: { surface: "cron_norma_followup_notices" } });
      followups = { error: "followup_notice_failed" };
    }
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
