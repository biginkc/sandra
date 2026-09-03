"use server";

import { revalidatePath } from "next/cache";
import { WebClient } from "@slack/web-api";
import { google } from "googleapis";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import {
  loadIntegrationPrefs,
  setChannelEnabled,
  setReminderPhone,
  setTimezone,
  type IntegrationChannel,
} from "@/lib/integrations/prefs";
import {
  deleteOAuthTokens,
  getDecryptedToken,
} from "@/lib/integrations/tokens/store";
import { checkRepSmsFromNumberReady } from "@/lib/notifications/rep-sms";
import { createClient } from "@/lib/supabase/server";
import {
  getEsignConnectionStatus,
} from "@/lib/esign/actions";
import { callbackPathSecretForOrg } from "@/lib/esign/credentials";
import type { EsignConnectionStatus } from "@/lib/esign/contracts";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { webhookBaseUrl } from "@/app/(dashboard)/admin/webhooks/url";

export interface IntegrationStatus {
  slack: { connected: boolean; enabled: boolean; teamName?: string | null };
  google: { connected: boolean; enabled: boolean; email?: string | null };
  /** PR 3 — `available` is a server-checked env gate (REP_SMS_FROM_NUMBER
   *  present): the SMS reminder card is hidden entirely on the client
   *  when this is false, never just disabled. */
  sms: { available: boolean; enabled: boolean; phone: string | null };
  esign: EsignConnectionStatus;
  /** Owner-only, connected-only. The URL to paste into Dropbox Sign's
   *  Account callback settings. Computed server-side from the org's
   *  deterministic path secret (see credentials.ts) and rendered directly
   *  into this page for the owner — the only place Sandra reveals it,
   *  since owners have no other way to find their org's callback path. */
  esignCallbackUrl: string | null;
  timezone: string;
}

type Provider = "slack" | "google";

function unavailableEsignStatus(): EsignConnectionStatus {
  return {
    connected: false,
    canManage: false,
    sendingEnabled: false,
    disconnectPending: false,
    testMode: null,
    apiKeyLastFour: null,
    embeddedTemplateManagementEnabled: false,
    liveSendLimit: null,
    statusUnavailable: true,
  };
}

/**
 * The Dropbox Sign account callback URL, revealed only to the connected
 * org's owner so they can paste it into Dropbox Sign's "Account callback"
 * setting. `callbackPathSecretForOrg` is documented "never return this
 * from an action" because the secret alone lets anyone forge callback
 * signatures for the org — but the owner is the one person who is
 * supposed to have it, and without this the owner has no way to find
 * their org's callback path at all. Scoped to owner + connected so a
 * non-owner or a disconnected org never sees it.
 */
async function resolveEsignCallbackUrl(
  esign: Result<EsignConnectionStatus>,
): Promise<string | null> {
  if (!esign.ok || !esign.data.connected || !esign.data.canManage) {
    return null;
  }
  const membership = await getSingleActiveMembership();
  if (!membership.ok) return null;
  const secret = callbackPathSecretForOrg(membership.membership.org_id);
  return `${webhookBaseUrl()}/api/webhooks/esign/${secret.reveal()}`;
}

/** E.164 — mirrors the DB CHECK
 *  (`user_integration_prefs_reminder_phone_format_check`, 20260814150000). */
const E164_RE = /^\+[1-9][0-9]{6,14}$/;

const ALLOWED_TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
] as const;

export async function getIntegrationStatus(): Promise<
  Result<IntegrationStatus>
> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in to manage integrations." },
      };
    }

    const { data, error } = await supabase
      .from("user_oauth_tokens")
      .select("provider, token_type, external_account_id")
      .eq("user_id", user.id);
    if (error) {
      return {
        ok: false,
        error: {
          code: "INTEGRATIONS_STATUS_FAILED",
          message: error.message,
        },
      };
    }

    const prefs = await loadIntegrationPrefs(supabase, user.id);
    const esign = await getEsignConnectionStatus();
    const esignCallbackUrl = await resolveEsignCallbackUrl(esign);
    const slackRow = data?.find(
      (row) => row.provider === "slack" && row.token_type === "bot",
    );
    const googleRow = data?.find(
      (row) => row.provider === "google" && row.token_type === "user",
    );

    return ok({
      slack: {
        connected: Boolean(slackRow),
        enabled: prefs.slackEnabled,
        teamName: null,
      },
      google: {
        connected: Boolean(googleRow),
        enabled: prefs.calendarEnabled,
        email: googleRow?.external_account_id ?? null,
      },
      sms: {
        available: Boolean(process.env.REP_SMS_FROM_NUMBER),
        enabled: prefs.smsRemindersEnabled,
        phone: prefs.reminderPhone,
      },
      esign: esign.ok ? esign.data : unavailableEsignStatus(),
      esignCallbackUrl,
      timezone: prefs.timezone,
    });
  } catch (error) {
    reportError(error, { tags: { surface: "get_integration_status" } });
    return errFromUnknown(error, "INTEGRATIONS_STATUS_FAILED");
  }
}

export async function setChannelEnabledAction(
  channel: IntegrationChannel,
  enabled: boolean,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in to manage integrations." },
      };
    }

    // R2-4/R3-3: enabling sms_reminder is gated on the same preflight the
    // sweep's send path fail-closes on server-side — an enabled DB row
    // must never outlive what's actually deliverable. Disabling always
    // succeeds unconditionally.
    if (channel === "sms_reminder" && enabled) {
      const ready = await checkRepSmsFromNumberReady();
      if (!ready.ready) {
        return {
          ok: false,
          error: { code: "SMS_REMINDERS_NOT_CONFIGURED", message: ready.message },
        };
      }

      const prefs = await loadIntegrationPrefs(supabase, user.id);
      if (!prefs.reminderPhone) {
        return {
          ok: false,
          error: {
            code: "SMS_REMINDERS_NO_PHONE",
            message: "Add a phone number before turning on SMS reminders.",
          },
        };
      }
    }

    await setChannelEnabled(supabase, user.id, channel, enabled);
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "set_integration_enabled" } });
    return errFromUnknown(error, "INTEGRATION_PREF_UPDATE_FAILED");
  }
}

export async function setReminderPhoneAction(phone: string): Promise<Result<null>> {
  const trimmed = phone.trim();
  if (!E164_RE.test(trimmed)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Enter a phone number in E.164 format, e.g. +18165551234.",
      },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in to manage integrations." },
      };
    }

    await setReminderPhone(supabase, user.id, trimmed);
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "set_reminder_phone" } });
    return errFromUnknown(error, "REMINDER_PHONE_UPDATE_FAILED");
  }
}

export async function setTimezoneAction(
  timezone: string,
): Promise<Result<null>> {
  if (!ALLOWED_TIMEZONES.includes(timezone as (typeof ALLOWED_TIMEZONES)[number])) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Choose a supported timezone.",
      },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in to manage integrations." },
      };
    }

    await setTimezone(supabase, user.id, timezone);
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "set_integration_timezone" } });
    return errFromUnknown(error, "INTEGRATION_TIMEZONE_UPDATE_FAILED");
  }
}

export async function disconnectIntegration(
  provider: Provider,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in to manage integrations." },
      };
    }

    // Revoke first while the token is still available. Revoke is
    // best-effort; local deletion is the user-visible source of truth.
    await revokeUpstream(provider, user.id);
    await deleteOAuthTokens({ userId: user.id, provider });
    revalidatePath("/settings/integrations");
    return ok(null);
  } catch (error) {
    reportError(error, { tags: { surface: "disconnect_integration" } });
    return errFromUnknown(error, "INTEGRATION_DISCONNECT_FAILED");
  }
}

async function revokeUpstream(provider: Provider, userId: string): Promise<void> {
  try {
    const token = await getDecryptedToken({
      userId,
      provider,
      tokenType: provider === "slack" ? "bot" : "user",
    });
    if (!token) return;

    if (provider === "slack") {
      const revealed = token.accessToken.reveal();
      await new WebClient(revealed).auth.revoke({ token: revealed });
      return;
    }

    const client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI,
    );
    client.setCredentials({
      access_token: token.accessToken.reveal(),
      refresh_token: token.refreshToken?.reveal(),
    });
    await client.revokeCredentials();
  } catch (error) {
    reportError(error, {
      tags: {
        surface:
          provider === "slack"
            ? "disconnect_slack_revoke"
            : "disconnect_google_revoke",
      },
      extra: { provider, userId },
    });
  }
}
