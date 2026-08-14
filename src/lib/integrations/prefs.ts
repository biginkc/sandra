import type { SupabaseClient } from "@supabase/supabase-js";

import { DatabaseError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";
import { normalizeTimeZone } from "@/lib/time/zoned";

export interface IntegrationPrefs {
  slackEnabled: boolean;
  calendarEnabled: boolean;
  timezone: string;
  /** PR 3 — R2-5 fail-closed contract: absent row = DISABLED, never
   *  inferred-enabled. Unlike slack/calendar, this has no "default
   *  enabled" behavior. */
  smsRemindersEnabled: boolean;
  /** PR 3 — E.164, or null when no number is on file (settings action
   *  writes the row with enabled=false first; enabling is a separate
   *  explicit toggle — see `setReminderPhone`). */
  reminderPhone: string | null;
}

export type IntegrationChannel = "slack" | "google_calendar" | "sms_reminder";

type IntegrationPrefsRow = {
  channel: IntegrationChannel;
  enabled: boolean;
  timezone: string;
  reminder_phone: string | null;
};

type IntegrationPrefsUpsertRow = {
  user_id: string;
  channel: IntegrationChannel;
  enabled?: boolean;
  timezone?: string;
  reminder_phone?: string | null;
  updated_at: string;
};

type IntegrationPrefsClient = {
  from(table: "user_integration_prefs"): {
    select(columns: "channel, enabled, timezone, reminder_phone"): {
      eq(
        column: "user_id",
        value: string,
      ): Promise<{
        data: IntegrationPrefsRow[] | null;
        error: { message: string } | null;
      }>;
    };
    upsert(
      rows: IntegrationPrefsUpsertRow | IntegrationPrefsUpsertRow[],
      options: { onConflict: "user_id,channel" },
    ): Promise<{ error: { message: string } | null }>;
  };
};

export const DEFAULT_PREFS: IntegrationPrefs = {
  slackEnabled: true,
  calendarEnabled: true,
  timezone: "America/Chicago",
  smsRemindersEnabled: false,
  reminderPhone: null,
};

function prefsClient(supabase: SupabaseClient<Database>): IntegrationPrefsClient {
  return supabase as unknown as IntegrationPrefsClient;
}

export async function loadIntegrationPrefs(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<IntegrationPrefs> {
  try {
    const { data, error } = await prefsClient(supabase)
      .from("user_integration_prefs")
      .select("channel, enabled, timezone, reminder_phone")
      .eq("user_id", userId);

    if (error) {
      reportError(error, {
        tags: { surface: "load_integration_prefs" },
        extra: { userId },
      });
      return DEFAULT_PREFS;
    }

    const slackRow = data?.find((row) => row.channel === "slack");
    const calendarRow = data?.find((row) => row.channel === "google_calendar");
    const smsRow = data?.find((row) => row.channel === "sms_reminder");

    return {
      slackEnabled: slackRow?.enabled ?? DEFAULT_PREFS.slackEnabled,
      calendarEnabled: calendarRow?.enabled ?? DEFAULT_PREFS.calendarEnabled,
      timezone: normalizeTimeZone(
        calendarRow?.timezone ?? slackRow?.timezone ?? DEFAULT_PREFS.timezone,
      ),
      // Fail-closed: an absent row means `smsRow` is undefined, so this
      // resolves to DEFAULT_PREFS.smsRemindersEnabled (false) — never
      // inferred-enabled the way slack/calendar default to true.
      smsRemindersEnabled: smsRow?.enabled ?? DEFAULT_PREFS.smsRemindersEnabled,
      reminderPhone: smsRow?.reminder_phone ?? DEFAULT_PREFS.reminderPhone,
    };
  } catch (error) {
    reportError(error, {
      tags: { surface: "load_integration_prefs" },
      extra: { userId },
    });
    return DEFAULT_PREFS;
  }
}

export async function setChannelEnabled(
  supabase: SupabaseClient<Database>,
  userId: string,
  channel: IntegrationChannel,
  enabled: boolean,
): Promise<void> {
  const { error } = await prefsClient(supabase)
    .from("user_integration_prefs")
    .upsert(
      {
        user_id: userId,
        channel,
        enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,channel" },
    );

  if (error) {
    throw new DatabaseError("Failed to update integration preference", {
      userId,
      channel,
      message: error.message,
    });
  }
}

type ReminderPhoneReadClient = {
  from(table: "user_integration_prefs"): {
    select(columns: "enabled"): {
      eq(
        column: "user_id",
        value: string,
      ): {
        eq(
          column: "channel",
          value: "sms_reminder",
        ): {
          maybeSingle(): Promise<{
            data: { enabled: boolean } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
  };
};

/**
 * Sets the `sms_reminder` channel's `reminder_phone`. R2-5's fail-closed
 * contract requires the row to come into existence with `enabled=false`
 * — the DB column defaults `enabled` to `true` (061), so a bare upsert
 * that omits `enabled` would silently turn SMS reminders ON for a brand
 * new row. This reads whether the row already exists first: if not,
 * the insert explicitly sets `enabled: false`; if it does, `enabled` is
 * left untouched so editing an existing phone number never flips the
 * toggle either way — enabling stays a separate, explicit action
 * (`setChannelEnabled`).
 */
export async function setReminderPhone(
  supabase: SupabaseClient<Database>,
  userId: string,
  phone: string,
): Promise<void> {
  const client = prefsClient(supabase) as unknown as ReminderPhoneReadClient;
  const { data: existing, error: readError } = await client
    .from("user_integration_prefs")
    .select("enabled")
    .eq("user_id", userId)
    .eq("channel", "sms_reminder")
    .maybeSingle();

  if (readError) {
    throw new DatabaseError("Failed to read existing SMS reminder preference", {
      userId,
      message: readError.message,
    });
  }

  const row: IntegrationPrefsUpsertRow = {
    user_id: userId,
    channel: "sms_reminder",
    reminder_phone: phone,
    updated_at: new Date().toISOString(),
    ...(existing ? {} : { enabled: false }),
  };

  const { error } = await prefsClient(supabase)
    .from("user_integration_prefs")
    .upsert(row, { onConflict: "user_id,channel" });

  if (error) {
    throw new DatabaseError("Failed to update SMS reminder phone", {
      userId,
      message: error.message,
    });
  }
}

export async function setTimezone(
  supabase: SupabaseClient<Database>,
  userId: string,
  timezone: string,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const channels: IntegrationChannel[] = ["slack", "google_calendar"];
  const rows: IntegrationPrefsUpsertRow[] = channels.map((channel) => ({
      user_id: userId,
      channel,
      timezone,
      updated_at: updatedAt,
    }));

  const { error } = await prefsClient(supabase)
    .from("user_integration_prefs")
    .upsert(rows, { onConflict: "user_id,channel" });

  if (error) {
    throw new DatabaseError("Failed to update integration timezone", {
      userId,
      timezone,
      message: error.message,
    });
  }
}
