# Operator Slack entry points

All operator notification links use `src/lib/leads/deep-link.ts` (`buildLeadDeepLink`).
Pass the **property ID**, not a contact, task, or conversation ID. The result is
`/leads/<encoded property ID>`. With no identified property, it opens `/leads`;
it never guesses a property from an ambiguous conversation.

| Entry point | Link producer |
| --- | --- |
| Hold-alert cron: holds, hot sellers, lead replies, routing alerts, ambiguous replies | `src/lib/hold-alerts/messages.ts` |
| Task creation/assignment | `src/lib/tasks/index.ts`, `src/app/(dashboard)/leads/actions.ts` |
| Next-step creation | `src/lib/next-steps/index.ts` |
| Appointment booking/reassignment | `src/components/appointments/book-appointment-action.ts`, `lifecycle-actions.ts` |
| Appointment reminder cron | `src/lib/notifications/reminders.ts` via Slack dispatch adapter |
| Slack Mark Done update | `src/lib/integrations/slack/dispatch.ts` |
| Norma call summaries and follow-up notices | `src/lib/norma/slack-blocks.ts` via summary/follow-up workers |
| Slack link preview Open button | `src/lib/integrations/slack/unfurl-blocks.ts`, `unfurl-policy.ts` |

Origins use NEXT_PUBLIC_APP_URL, APP_URL, VERCEL_PROJECT_PRODUCTION_URL, then the
existing Sandra fallback. Callers may supply an explicit base URL; Slack previews
retain their fixed trusted production origin and UUID validation.

Legacy `/my-leads?lead=` URLs remain accepted by the preview parser, but new
preview buttons open the lead page. Existing Slack posts are not rewritten.
Ambiguous-thread SMS links retain their prior behavior; this change targets Slack.
Assignment links also used by Google/task notifications share the lead destination.
