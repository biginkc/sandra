import type { SupabaseClient } from "@supabase/supabase-js";

import { DatabaseError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";
import { normalizeTimeZone } from "@/lib/time/zoned";

export interface IntegrationPrefs {
  slackEnabled: boolean;
  calendarEnabled: boolean;
  timezone: string;
}

export type IntegrationChannel = "slack" | "google_calendar";

type IntegrationPrefsRow = {
  channel: IntegrationChannel;
  enabled: boolean;
  timezone: string;
};

type IntegrationPrefsUpsertRow = {
  user_id: string;
  channel: IntegrationChannel;
  enabled?: boolean;
  timezone?: string;
  updated_at: string;
};

type IntegrationPrefsClient = {
  from(table: "user_integration_prefs"): {
    select(columns: "channel, enabled, timezone"): {
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
      .select("channel, enabled, timezone")
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

    return {
      slackEnabled: slackRow?.enabled ?? DEFAULT_PREFS.slackEnabled,
      calendarEnabled: calendarRow?.enabled ?? DEFAULT_PREFS.calendarEnabled,
      timezone: normalizeTimeZone(
        calendarRow?.timezone ?? slackRow?.timezone ?? DEFAULT_PREFS.timezone,
      ),
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
