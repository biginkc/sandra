import { after, NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import {
  completeTaskFromSlack,
  refreshSlackMessage,
} from "@/lib/integrations/slack/dispatch";
import { verifySlackSignature } from "@/lib/integrations/slack/signature";

export const maxDuration = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ACTION_IDS = new Set(["mark_done"]);

type SlackActionPayload = {
  type?: string;
  team?: { id?: string };
  user?: { id?: string; name?: string; username?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  container?: { message_ts?: string };
  actions?: Array<{ action_id?: string; value?: unknown }>;
};

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  const signatureOk =
    !!signingSecret &&
    verifySlackSignature({
      signingSecret,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      rawBody,
    });

  if (!signatureOk) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const payload = parsePayload(rawBody);
  if (payload?.type !== "block_actions") {
    return NextResponse.json({ ok: true });
  }

  const action = payload.actions?.[0];
  const actionId = action?.action_id;
  if (!actionId || !ALLOWED_ACTION_IDS.has(actionId)) {
    return NextResponse.json({ ok: true });
  }

  const taskId = String(action.value ?? "");
  if (!UUID_RE.test(taskId)) {
    return NextResponse.json({ ok: true });
  }

  const slackUserId = payload.user?.id;
  const teamId = payload.team?.id;
  if (!slackUserId || !teamId) {
    return NextResponse.json({ ok: true });
  }

  after(async () => {
    try {
      const result = await completeTaskFromSlack({
        taskId,
        slackUserId,
        teamId,
      });
      if (!result.ok) {
        reportError(new Error("Slack Mark Done rejected"), {
          tags: { surface: "slack_actions_webhook" },
          extra: { taskId, slackUserId, reason: result.reason },
        });
        return;
      }

      const channel = payload.channel?.id;
      const messageTs = payload.message?.ts ?? payload.container?.message_ts;
      if (!channel || !messageTs) return;

      await refreshSlackMessage({
        channel,
        messageTs,
        taskId,
        doneByUserName:
          payload.user?.name ?? payload.user?.username ?? "user",
      });
    } catch (error) {
      reportError(error, {
        tags: { surface: "slack_actions_webhook" },
        extra: { taskId, slackUserId },
      });
    }
  });

  return NextResponse.json({ ok: true });
}

function parsePayload(rawBody: string): SlackActionPayload | null {
  try {
    const params = new URLSearchParams(rawBody);
    return JSON.parse(params.get("payload") ?? "{}") as SlackActionPayload;
  } catch (error) {
    reportError(error, {
      tags: { surface: "slack_actions_parse" },
    });
    return null;
  }
}
