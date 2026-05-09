import { beforeEach, describe, expect, it, vi } from "vitest";

import { OAuthSecret } from "@/lib/integrations/tokens/store";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));
const { getDecryptedToken, upsertOAuthToken } = vi.hoisted(() => ({
  getDecryptedToken: vi.fn(),
  upsertOAuthToken: vi.fn(),
}));
const { loadIntegrationPrefs } = vi.hoisted(() => ({
  loadIntegrationPrefs: vi.fn(),
}));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
const {
  oauth2Instances,
  calendarInsert,
  calendarUpdate,
  setCredentials,
} = vi.hoisted(() => ({
  oauth2Instances: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    emitTokens: (tokens: Record<string, unknown>) => Promise<void>;
  }>,
  calendarInsert: vi.fn(),
  calendarUpdate: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/integrations/tokens/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/tokens/store")>(
    "@/lib/integrations/tokens/store",
  );
  return { ...actual, getDecryptedToken, upsertOAuthToken };
});
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: function MockOAuth2() {
        let tokensHandler: ((tokens: Record<string, unknown>) => Promise<void>) | null = null;
        const instance = {
          setCredentials,
          on: vi.fn((event: string, handler: (tokens: Record<string, unknown>) => Promise<void>) => {
            if (event === "tokens") tokensHandler = handler;
          }),
          emitTokens: async (tokens: Record<string, unknown>) => {
            await tokensHandler?.(tokens);
          },
        };
        oauth2Instances.push(instance);
        return instance;
      },
    },
    calendar: vi.fn(() => ({
      events: {
        insert: calendarInsert,
        update: calendarUpdate,
      },
    })),
  },
  calendar_v3: {},
}));

import * as dispatchModule from "./dispatch";
import {
  dispatchTaskCalendarEvent,
  dispatchTaskCalendarEventUpdate,
} from "./dispatch";

type SupabaseMockOptions = {
  taskRow?: Record<string, unknown> | null;
  updateError?: { message: string } | null;
};

function makeSupabase(opts: SupabaseMockOptions = {}) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  return {
    updates,
    from(table: string) {
      const builder = {
        select: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          updates.push({ table, payload });
          return builder;
        }),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => ({
          data: opts.taskRow ?? null,
          error: null,
        })),
        then: (
          onFulfilled: (value: { error: { message: string } | null }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve({ error: opts.updateError ?? null }).then(
            onFulfilled,
            onRejected,
          ),
      };
      return builder;
    },
  };
}

const input = {
  taskId: "11111111-1111-4111-8111-111111111111",
  assigneeId: "user-1",
  taskTitle: "Call the owner",
  propertyAddress: "123 Calendar Ln",
  dueAt: "2026-05-10T15:00:00.000Z",
  timezone: "America/Chicago",
  deepLink: "https://sandra-sooty.vercel.app/messages?property_id=property-1",
};

describe("google/dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauth2Instances.length = 0;
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://app.test/api/oauth/google/callback");
    createAdminClient.mockReturnValue(makeSupabase());
    loadIntegrationPrefs.mockResolvedValue({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
    });
    getDecryptedToken.mockResolvedValue({
      accessToken: new OAuthSecret("access-token"),
      refreshToken: new OAuthSecret("refresh-token"),
      expiresAt: "2026-05-10T16:00:00.000Z",
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      externalAccountId: "person@example.com",
    });
    upsertOAuthToken.mockResolvedValue(undefined);
    calendarInsert.mockResolvedValue({ data: { id: "event-1" } });
    calendarUpdate.mockResolvedValue({ data: { id: "event-1" } });
  });

  it("dispatchTaskCalendarEvent short-circuits when calendar pref is disabled", async () => {
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: false,
      timezone: "America/Chicago",
    });

    await expect(dispatchTaskCalendarEvent(input)).resolves.toEqual({
      inserted: false,
      reason: "pref_disabled",
    });
    expect(getDecryptedToken).not.toHaveBeenCalled();
  });

  it("dispatchTaskCalendarEvent short-circuits when no user token row exists", async () => {
    getDecryptedToken.mockResolvedValueOnce(null);

    await expect(dispatchTaskCalendarEvent(input)).resolves.toEqual({
      inserted: false,
      reason: "no_token",
    });
    expect(calendarInsert).not.toHaveBeenCalled();
  });

  it("dispatchTaskCalendarEvent calls calendar.events.insert with calendarId primary", async () => {
    await dispatchTaskCalendarEvent(input);

    expect(calendarInsert).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: "primary" }),
    );
  });

  it("dispatchTaskCalendarEvent passes user timezone to start.timeZone and end.timeZone", async () => {
    await dispatchTaskCalendarEvent(input);

    const requestBody = calendarInsert.mock.calls[0][0].requestBody;
    expect(requestBody.start.timeZone).toBe("America/Chicago");
    expect(requestBody.end.timeZone).toBe("America/Chicago");
  });

  it("dispatchTaskCalendarEvent uses 30-min duration", async () => {
    await dispatchTaskCalendarEvent(input);

    const requestBody = calendarInsert.mock.calls[0][0].requestBody;
    expect(
      new Date(requestBody.end.dateTime).getTime() -
        new Date(requestBody.start.dateTime).getTime(),
    ).toBe(1_800_000);
  });

  it("dispatchTaskCalendarEvent updates tasks.google_calendar_event_id after success", async () => {
    const supabase = makeSupabase();
    createAdminClient.mockReturnValueOnce(supabase);

    await expect(dispatchTaskCalendarEvent(input)).resolves.toEqual({
      inserted: true,
      eventId: "event-1",
    });
    expect(supabase.updates).toContainEqual({
      table: "tasks",
      payload: { google_calendar_event_id: "event-1" },
    });
  });

  it("dispatchTaskCalendarEvent reports insert errors and never throws", async () => {
    calendarInsert.mockRejectedValueOnce(new Error("Google unavailable"));

    await expect(dispatchTaskCalendarEvent(input)).resolves.toEqual({
      inserted: false,
      reason: "error",
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "google_calendar_dispatch" } }),
    );
  });

  it("oauth2Client.on('tokens') upserts rotated tokens", async () => {
    await dispatchTaskCalendarEvent(input);
    await oauth2Instances[0].emitTokens({
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expiry_date: Date.parse("2026-05-10T17:00:00.000Z"),
    });

    expect(upsertOAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        provider: "google",
        tokenType: "user",
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        accessTokenExpiresAt: "2026-05-10T17:00:00.000Z",
      }),
    );
  });

  it("tokens handler passes null refreshToken when refresh_token is undefined", async () => {
    await dispatchTaskCalendarEvent(input);
    await oauth2Instances[0].emitTokens({
      access_token: "rotated-access",
      expiry_date: Date.parse("2026-05-10T17:00:00.000Z"),
    });

    expect(upsertOAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: null }),
    );
  });

  it("dispatchTaskCalendarEventUpdate calls events.update with stored eventId on due_at change", async () => {
    createAdminClient.mockReturnValueOnce(
      makeSupabase({ taskRow: { google_calendar_event_id: "event-1" } }),
    );

    await expect(dispatchTaskCalendarEventUpdate(input)).resolves.toEqual({
      inserted: true,
      eventId: "event-1",
    });
    expect(calendarUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "primary",
        eventId: "event-1",
      }),
    );
  });

  it("dispatchTaskCalendarEventUpdate falls through to insert when no eventId is stored", async () => {
    createAdminClient
      .mockReturnValueOnce(makeSupabase({ taskRow: { google_calendar_event_id: null } }))
      .mockReturnValueOnce(makeSupabase());

    await expect(dispatchTaskCalendarEventUpdate(input)).resolves.toEqual({
      inserted: true,
      eventId: "event-1",
    });
    expect(calendarInsert).toHaveBeenCalledTimes(1);
    expect(calendarUpdate).not.toHaveBeenCalled();
  });

  it("dispatchTaskCalendarEventUpdate falls back to insert on Google 404", async () => {
    const error = new Error("not found") as Error & { code: number };
    error.code = 404;
    calendarUpdate.mockRejectedValueOnce(error);
    createAdminClient
      .mockReturnValueOnce(makeSupabase({ taskRow: { google_calendar_event_id: "event-old" } }))
      .mockReturnValueOnce(makeSupabase());

    await expect(dispatchTaskCalendarEventUpdate(input)).resolves.toEqual({
      inserted: true,
      eventId: "event-1",
    });
    expect(calendarUpdate).toHaveBeenCalledTimes(1);
    expect(calendarInsert).toHaveBeenCalledTimes(1);
  });

  it("task completion is a no-op: no calendar delete function is exported", () => {
    expect(
      typeof (
        dispatchModule as typeof dispatchModule & {
          dispatchTaskCalendarEventDelete?: unknown;
        }
      ).dispatchTaskCalendarEventDelete,
    ).toBe("undefined");
  });

  it("sets Google credentials from decrypted OAuthSecret values", async () => {
    await dispatchTaskCalendarEvent(input);

    expect(setCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: Date.parse("2026-05-10T16:00:00.000Z"),
      }),
    );
  });
});
