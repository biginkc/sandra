import { WebClient } from "@slack/web-api";
import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";
import { sendRepSmsReminder } from "@/lib/notifications/rep-sms";
import type { Database } from "@/lib/supabase/types";

import type { ChannelResult, EmailMessage } from "./types";

/** Same bounds as the appointment-reminder path: no SDK retry loop, 10s HTTP cap. */
const SLACK_CLIENT_OPTIONS = { timeout: 10_000, retryConfig: { retries: 0 } } as const;
const RESEND_URL = "https://api.resend.com/emails";

type Env = Record<string, string | undefined>;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Per-channel senders. Results are classified so the durable layer can tell a
 * skip (no token, pref off, not configured), a retryable failure (nothing was
 * transmitted) and a terminal failure (transmission started, outcome unknown:
 * never retried, to avoid a duplicate DM or SMS).
 */
export function createChannelSenders(
  admin: SupabaseClient<Database>,
  opts: { env?: Env; fetch?: typeof fetch } = {},
) {
  const env: Env = opts.env ?? process.env;
  const fetchImpl = opts.fetch ?? fetch;

  async function sendSlack(userId: string, text: string): Promise<ChannelResult> {
    let slack: WebClient;
    let channel: string;
    try {
      const prefs = await loadIntegrationPrefs(admin, userId);
      if (!prefs.slackEnabled) return { status: "skipped", reason: "pref_disabled" };
      const token = await getDecryptedToken({ userId, provider: "slack", tokenType: "bot" });
      if (!token?.externalAccountId) return { status: "skipped", reason: "no_token" };
      slack = new WebClient(token.accessToken.reveal(), SLACK_CLIENT_OPTIONS);
      const opened = await slack.conversations.open({ users: token.externalAccountId });
      if (!opened.channel?.id) return { status: "failed", error: "no_dm_channel" };
      channel = opened.channel.id;
    } catch (error) {
      reportError(error, { tags: { surface: "hold_alert_slack" }, extra: { userId, stage: "pre_send" } });
      return { status: "failed", error: messageOf(error) };
    }
    try {
      const posted = await slack.chat.postMessage({ channel, text });
      if (!posted.ts) return { status: "failed", error: "slack_no_receipt", terminal: true };
      return { status: "sent" };
    } catch (error) {
      reportError(error, { tags: { surface: "hold_alert_slack" }, extra: { userId, stage: "send" } });
      return { status: "failed", error: messageOf(error), terminal: true };
    }
  }

  async function sendSms(userId: string, text: string): Promise<ChannelResult> {
    try {
      const prefs = await loadIntegrationPrefs(admin, userId);
      if (!prefs.reminderPhone) return { status: "skipped", reason: "no_phone" };
      const result = await sendRepSmsReminder({ to: prefs.reminderPhone, body: text });
      if (result.ok) return { status: "sent" };
      if (result.reason === "not_configured") return { status: "skipped", reason: "not_configured" };
      // Ambiguous: the provider may have sent it. Never retry.
      if (result.reason === "aborted_ambiguous") {
        return { status: "failed", error: `${result.reason}: ${result.message}`, terminal: true };
      }
      return { status: "failed", error: `${result.reason}: ${result.message}` };
    } catch (error) {
      reportError(error, { tags: { surface: "hold_alert_sms" }, extra: { userId } });
      return { status: "failed", error: messageOf(error) };
    }
  }

  async function sendEmail(userId: string, message: EmailMessage): Promise<ChannelResult> {
    const key = env.RESEND_API_KEY;
    if (!key) return { status: "skipped", reason: "no_resend_key" };
    const from = env.HOLD_ALERT_EMAIL_FROM ?? env.RESEND_FROM;
    if (!from) return { status: "skipped", reason: "no_email_from" };
    try {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      const to = data?.user?.email;
      if (error || !to) return { status: "skipped", reason: "no_email" };
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject: message.subject, text: message.text }),
      });
      if (!res.ok) return { status: "failed", error: `resend_http_${res.status}` };
      return { status: "sent" };
    } catch (error) {
      reportError(error, { tags: { surface: "hold_alert_email" }, extra: { userId } });
      return { status: "failed", error: messageOf(error) };
    }
  }

  return { sendSlack, sendSms, sendEmail };
}
