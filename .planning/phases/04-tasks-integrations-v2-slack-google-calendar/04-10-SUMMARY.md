# 04-10 Summary — Dispatch Wiring

## Completed

- Wired `setOutreachDispo` task creation into a single `after()` block using `Promise.allSettled`.
- The task-created fan-out now calls:
  - in-app `dispatchTaskAssigned`
  - Slack `dispatchTaskAssignedSlack`
  - Google Calendar `dispatchTaskCalendarEvent`
- Preserved self-assignment suppression, so no dispatchers fire when the actor assigns the task to themselves.
- Loaded integration prefs before `after()` and passed captured channel flags/timezone into Slack and Calendar dispatchers.
- Added optional captured-pref inputs to Slack and Google dispatchers so callsites can avoid reloading prefs when already resolved.
- Wired `snoozeTask` due date changes to `dispatchTaskCalendarEventUpdate` via `after()`.
- Added integration coverage for dispo fan-out and unit coverage for snooze calendar updates.

## Files

- `src/app/(dashboard)/messages/dispo-actions.ts`
- `src/app/(dashboard)/messages/dispo-actions.integration.test.ts`
- `src/lib/tasks/index.ts`
- `src/lib/tasks/index.test.ts`
- `src/lib/integrations/slack/dispatch.ts`
- `src/lib/integrations/google/dispatch.ts`
- `.planning/ROADMAP.md`

## Verification

- `npm run typecheck`
- `npm run test:integration -- 'src/app/(dashboard)/messages/dispo-actions.integration.test.ts'`
- `npm test -- --run src/lib/tasks/index.test.ts src/lib/integrations/slack/dispatch.test.ts src/lib/integrations/google/dispatch.test.ts`
- `npx eslint 'src/app/(dashboard)/messages/dispo-actions.ts' 'src/app/(dashboard)/messages/dispo-actions.integration.test.ts' src/lib/tasks/index.ts src/lib/tasks/index.test.ts src/lib/integrations/slack/dispatch.ts src/lib/integrations/google/dispatch.ts`

## Notes

- Calendar updates are now wired for `snoozeTask`, which is the existing V1 due date mutation path.
- Task completion intentionally does not delete Google Calendar events. That remains the documented D-07 tradeoff surfaced in `/settings/integrations`.
- Full live Slack and Google OAuth smoke still depends on production credentials and owned accounts, but the app-side wiring is complete and covered by mocked dispatcher tests.
