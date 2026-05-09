# 04-08 Summary: Google Calendar Dispatcher

## What Shipped

Added `src/lib/integrations/google/dispatch.ts` with the two contracts Plan 04-10 will wire into the task lifecycle:

```ts
export async function dispatchTaskCalendarEvent(
  input: DispatchCalendarTaskInput,
): Promise<DispatchCalendarResult>;

export async function dispatchTaskCalendarEventUpdate(
  input: DispatchCalendarTaskInput,
): Promise<DispatchCalendarResult>;
```

Both functions are best-effort: they catch errors, report through `reportError`, and return `{ inserted: false, reason: "error" }` instead of throwing across the caller boundary.

## Insert Contract

`dispatchTaskCalendarEvent(input)`:

- loads the assignee's integration preferences
- short-circuits when Google Calendar is disabled
- decrypts the assignee's Google user OAuth token
- creates a Calendar v3 client with `calendarId: "primary"`
- inserts a 30-minute event at `input.dueAt`
- uses the user's timezone on both start and end
- stores the Google event ID on `tasks.google_calendar_event_id`

Event shape:

- `summary`: `Follow up: ${propertyAddress}`
- `description`: task title plus Sandra deep link
- `location`: property address
- `start.dateTime`: due_at ISO
- `end.dateTime`: due_at + 30 minutes

## Update Contract

`dispatchTaskCalendarEventUpdate(input)`:

- reads `tasks.google_calendar_event_id`
- falls through to insert when no event ID is stored
- calls `calendar.events.update` when an event ID exists
- falls back to insert when Google returns 404, covering events manually deleted by the user

The return shape still uses `{ inserted: true, eventId }` for both insert and update so Plan 04-10 can treat it as "synced."

## D-07 No Delete

No delete function exists. This is intentional: task completion does not delete or modify calendar events in V2. Stale calendar events are the documented D-07 tradeoff.

Proof:

- `src/lib/integrations/google/dispatch.test.ts` asserts no `dispatchTaskCalendarEventDelete` export exists.
- `src/lib/integrations/google/dispatch.ts` contains no `events.delete` call.

## Token Rotation

The dispatcher attaches an OAuth2 `tokens` listener. When googleapis refreshes credentials:

- new `access_token` is persisted through `upsertOAuthToken`
- `refreshToken` is passed as `newTokens.refresh_token ?? null`
- the SQL `upsert_oauth_token` COALESCE behavior preserves the existing refresh token when Google omits a new one
- listener failures are reported but do not fail the calendar dispatch

## Verification

- `npm run typecheck`
- `npm test -- --run src/lib/integrations/google/dispatch.test.ts`
