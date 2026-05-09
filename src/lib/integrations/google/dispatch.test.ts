import { describe, it, expect } from "vitest";

describe("google/dispatch", () => {
  it.todo(
    "dispatchTaskCalendarEvent calls calendar.events.insert with calendarId 'primary'",
  );
  it.todo(
    "dispatchTaskCalendarEvent passes user timezone to start.timeZone and end.timeZone",
  );
  it.todo("dispatchTaskCalendarEvent uses 30-min duration");
  it.todo(
    "oauth2Client.on('tokens', ...) UPSERTs rotated tokens with COALESCE-on-refresh",
  );
  it.todo(
    "dispatchTaskCalendarEventUpdate calls events.update with stored eventId on due_at change",
  );
  it.todo("task completion is a no-op (D-07) - no events.delete call");
});
