import type { OAuth2Client } from "google-auth-library";
import { calendar_v3, google } from "googleapis";

import { ConfigurationError } from "@/lib/errors/classes";
import { reportError } from "@/lib/errors/report";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import {
  getDecryptedToken,
  type DecryptedOAuthToken,
  upsertOAuthToken,
} from "@/lib/integrations/tokens/store";
import { createAdminClient } from "@/lib/supabase/admin";

export interface DispatchCalendarTaskInput {
  taskId: string;
  assigneeId: string;
  taskTitle: string;
  propertyAddress: string;
  dueAt: string;
  /** ISO timestamptz — appointment-only. When present, the event spans
   *  dueAt..endAt instead of the 30-minute default. */
  endAt?: string;
  timezone: string;
  deepLink: string;
  calendarEnabled?: boolean;
}

export interface DispatchCalendarResult {
  inserted: boolean;
  eventId?: string;
  reason?: "no_token" | "pref_disabled" | "error";
}

type AdminClient = ReturnType<typeof createAdminClient>;
export type CalendarClient = calendar_v3.Calendar;

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export async function dispatchTaskCalendarEvent(
  input: DispatchCalendarTaskInput,
): Promise<DispatchCalendarResult> {
  try {
    const admin = createAdminClient();
    const calendarEnabled =
      input.calendarEnabled ??
      (await loadIntegrationPrefs(admin, input.assigneeId)).calendarEnabled;
    if (!calendarEnabled) {
      return { inserted: false, reason: "pref_disabled" };
    }

    const token = await getDecryptedToken({
      userId: input.assigneeId,
      provider: "google",
      tokenType: "user",
    });
    if (!token) return { inserted: false, reason: "no_token" };

    const calendar = buildCalendarClient(input.assigneeId, token);
    const event = buildCalendarEvent(input);
    const response = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event,
    });
    const eventId = response.data.id;
    if (!eventId) return { inserted: false, reason: "error" };

    const { error } = await admin
      .from("tasks")
      .update({ google_calendar_event_id: eventId })
      .eq("id", input.taskId);
    if (error) throw new Error(error.message);

    return { inserted: true, eventId };
  } catch (error) {
    reportError(error, {
      tags: { surface: "google_calendar_dispatch" },
      extra: { taskId: input.taskId, assigneeId: input.assigneeId },
    });
    return { inserted: false, reason: "error" };
  }
}

export async function dispatchTaskCalendarEventUpdate(
  input: DispatchCalendarTaskInput,
): Promise<DispatchCalendarResult> {
  try {
    const admin = createAdminClient();
    const eventId = await loadStoredCalendarEventId(admin, input.taskId);
    if (!eventId) return dispatchTaskCalendarEvent(input);

    const calendarEnabled =
      input.calendarEnabled ??
      (await loadIntegrationPrefs(admin, input.assigneeId)).calendarEnabled;
    if (!calendarEnabled) {
      return { inserted: false, reason: "pref_disabled" };
    }

    const token = await getDecryptedToken({
      userId: input.assigneeId,
      provider: "google",
      tokenType: "user",
    });
    if (!token) return { inserted: false, reason: "no_token" };

    const calendar = buildCalendarClient(input.assigneeId, token);
    try {
      await calendar.events.update({
        calendarId: "primary",
        eventId,
        requestBody: buildCalendarEvent(input),
      });
      return { inserted: true, eventId };
    } catch (error) {
      if (isGoogleNotFound(error)) {
        return dispatchTaskCalendarEvent(input);
      }
      throw error;
    }
  } catch (error) {
    reportError(error, {
      tags: { surface: "google_calendar_dispatch_update" },
      extra: { taskId: input.taskId, assigneeId: input.assigneeId },
    });
    return { inserted: false, reason: "error" };
  }
}

/**
 * Build an authenticated Google Calendar client for `userId`, wiring up
 * the same token-rotation handler as every other calendar dispatch path.
 * Exported so other callers within the calendar integration (e.g. the
 * durable calendar-mutation worker) can build a client without
 * duplicating the OAuth2Client + rotation-listener plumbing.
 */
export function buildCalendarClient(
  userId: string,
  token: DecryptedOAuthToken,
): CalendarClient {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ConfigurationError("Google OAuth calendar config is required");
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri,
  );
  oauth2Client.setCredentials({
    // reveal at setCredentials only — never log this value.
    access_token: token.accessToken.reveal(),
    refresh_token: token.refreshToken?.reveal(),
    expiry_date: token.expiresAt
      ? new Date(token.expiresAt).getTime()
      : undefined,
  });
  attachTokenRotationHandler(oauth2Client, userId, token);
  return google.calendar({ version: "v3", auth: oauth2Client });
}

function attachTokenRotationHandler(
  oauth2Client: OAuth2Client,
  userId: string,
  currentToken: DecryptedOAuthToken,
): void {
  oauth2Client.on("tokens", async (newTokens) => {
    if (!newTokens.access_token) return;
    try {
      await upsertOAuthToken({
        userId,
        provider: "google",
        tokenType: "user",
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token ?? null,
        accessTokenExpiresAt: newTokens.expiry_date
          ? new Date(newTokens.expiry_date).toISOString()
          : null,
        scopes: currentToken.scopes,
        externalAccountId: currentToken.externalAccountId,
      });
    } catch (error) {
      reportError(error, {
        tags: { surface: "google_calendar_token_rotation" },
        extra: { userId },
      });
    }
  });
}

function buildCalendarEvent(
  input: DispatchCalendarTaskInput,
): calendar_v3.Schema$Event {
  const start = new Date(input.dueAt);
  const end = input.endAt
    ? new Date(input.endAt)
    : new Date(start.getTime() + THIRTY_MINUTES_MS);
  return {
    summary: `Follow up: ${input.propertyAddress}`,
    description: `${input.taskTitle}\n\n${input.deepLink}`,
    location: input.propertyAddress,
    start: {
      dateTime: start.toISOString(),
      timeZone: input.timezone,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: input.timezone,
    },
  };
}

async function loadStoredCalendarEventId(
  admin: AdminClient,
  taskId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("tasks")
    .select("google_calendar_event_id")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.google_calendar_event_id ?? null;
}

/** Exported for other calendar-mutation consumers (e.g. the create-worker's
 *  409-reconcile path) that need to distinguish "already exists"/"not
 *  found" Google errors from real failures without re-deriving the shape. */
export function isGoogleNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.code === 404;
}

/** 409 = the client-supplied event id already exists — the durable-ledger
 *  event-creation retry signal (a crash between provider success and
 *  phase-advance replays the same client_event_id and gets this back). */
export function isGoogleConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 409 || candidate.code === 409;
}
