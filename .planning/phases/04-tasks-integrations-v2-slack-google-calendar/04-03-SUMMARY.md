---
phase: 04-tasks-integrations-v2-slack-google-calendar
plan: 03
status: complete
date: 2026-05-09
tags: [integration-prefs, tasks, slack, google-calendar]
---

# Plan 04-03 Summary — Integration Preferences + External Task IDs

## Outcome

Plan 03 is complete. The planned `054` migration slot was already occupied in current `origin/main`, so this landed as the next available migration: `061_user_integration_prefs.sql`.

## Migration

`supabase/migrations/061_user_integration_prefs.sql` creates `public.user_integration_prefs`:

- Composite primary key: `(user_id, channel)`
- Channels: `slack`, `google_calendar`
- `enabled boolean not null default true`
- `timezone text not null default 'America/Chicago'`
- RLS policy `user_integration_prefs_self_all` lets authenticated users read/write only their own rows.

The migration also adds three nullable task integration columns:

- `tasks.google_calendar_event_id`: populated by the Google Calendar dispatcher after `events.insert`; later used for `events.update`.
- `tasks.slack_channel_id`: populated by the Slack dispatcher after sending the task DM.
- `tasks.slack_message_ts`: populated with the Slack message timestamp and paired with `slack_channel_id` for `chat.update`.

`reset_tenant_tables()` now truncates `public.user_integration_prefs`.

## Runtime Contract

`src/lib/integrations/prefs.ts` exports:

```ts
export interface IntegrationPrefs {
  slackEnabled: boolean;
  calendarEnabled: boolean;
  timezone: string;
}

export type IntegrationChannel = "slack" | "google_calendar";

export async function loadIntegrationPrefs(...): Promise<IntegrationPrefs>;
export async function setChannelEnabled(...): Promise<void>;
export async function setTimezone(...): Promise<void>;
```

`loadIntegrationPrefs` never throws. It returns safe defaults on missing rows, query errors, and unexpected exceptions:

```ts
{
  slackEnabled: true,
  calendarEnabled: true,
  timezone: "America/Chicago",
}
```

Plans 07, 08, 09, and 10 can call `loadIntegrationPrefs` without wrapping it in their own try/catch.

## Verification

- SQL migration guard checks passed for table, RLS, tasks columns, default timezone, and reset helper inclusion.
- `npm test -- --run src/lib/integrations/prefs.test.ts` passed.
- `npm run typecheck` passed.
