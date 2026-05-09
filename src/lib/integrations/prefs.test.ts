import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";

import {
  DEFAULT_PREFS,
  loadIntegrationPrefs,
  setChannelEnabled,
  setTimezone,
  type IntegrationChannel,
} from "./prefs";

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

type SelectResult = {
  data: Array<{
    channel: IntegrationChannel;
    enabled: boolean;
    timezone: string;
  }> | null;
  error: { message: string } | null;
};

function createPrefsSupabaseStub({
  selectResult = { data: [], error: null },
  upsertError = null,
}: {
  selectResult?: SelectResult;
  upsertError?: { message: string } | null;
} = {}) {
  const eq = vi.fn(async () => selectResult);
  const select = vi.fn(() => ({ eq }));
  const upsert = vi.fn(async () => ({ error: upsertError }));
  const from = vi.fn((table: string) => {
    expect(table).toBe("user_integration_prefs");
    return { select, upsert };
  });

  return {
    supabase: { from },
    from,
    select,
    eq,
    upsert,
  };
}

describe("integration prefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadIntegrationPrefs returns defaults when no rows exist", async () => {
    const { supabase } = createPrefsSupabaseStub({
      selectResult: { data: [], error: null },
    });

    await expect(
      loadIntegrationPrefs(supabase as never, "user-1"),
    ).resolves.toEqual(DEFAULT_PREFS);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("loadIntegrationPrefs returns defaults and reports when select errors", async () => {
    const { supabase } = createPrefsSupabaseStub({
      selectResult: { data: null, error: { message: "db down" } },
    });

    await expect(
      loadIntegrationPrefs(supabase as never, "user-1"),
    ).resolves.toEqual(DEFAULT_PREFS);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("loadIntegrationPrefs aggregates slack and calendar rows", async () => {
    const { supabase } = createPrefsSupabaseStub({
      selectResult: {
        data: [
          {
            channel: "slack",
            enabled: false,
            timezone: "America/Denver",
          },
          {
            channel: "google_calendar",
            enabled: true,
            timezone: "America/Chicago",
          },
        ],
        error: null,
      },
    });

    await expect(loadIntegrationPrefs(supabase as never, "user-1")).resolves.toEqual(
      {
        slackEnabled: false,
        calendarEnabled: true,
        timezone: "America/Chicago",
      },
    );
  });

  it("loadIntegrationPrefs prefers google_calendar timezone over slack timezone", async () => {
    const { supabase } = createPrefsSupabaseStub({
      selectResult: {
        data: [
          { channel: "slack", enabled: true, timezone: "America/New_York" },
          {
            channel: "google_calendar",
            enabled: true,
            timezone: "America/Los_Angeles",
          },
        ],
        error: null,
      },
    });

    const prefs = await loadIntegrationPrefs(supabase as never, "user-1");

    expect(prefs.timezone).toBe("America/Los_Angeles");
  });

  it("setChannelEnabled upserts one channel with conflict target", async () => {
    const { supabase, upsert } = createPrefsSupabaseStub();

    await setChannelEnabled(supabase as never, "user-1", "slack", false);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        channel: "slack",
        enabled: false,
      }),
      { onConflict: "user_id,channel" },
    );
  });

  it("setChannelEnabled throws DatabaseError on upsert error", async () => {
    const { supabase } = createPrefsSupabaseStub({
      upsertError: { message: "permission denied" },
    });

    await expect(
      setChannelEnabled(supabase as never, "user-1", "slack", false),
    ).rejects.toBeInstanceOf(DatabaseError);
  });

  it("setTimezone upserts both channels with the same timezone", async () => {
    const { supabase, upsert } = createPrefsSupabaseStub();

    await setTimezone(supabase as never, "user-1", "America/Phoenix");

    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          user_id: "user-1",
          channel: "slack",
          timezone: "America/Phoenix",
        }),
        expect.objectContaining({
          user_id: "user-1",
          channel: "google_calendar",
          timezone: "America/Phoenix",
        }),
      ],
      { onConflict: "user_id,channel" },
    );
  });
});
