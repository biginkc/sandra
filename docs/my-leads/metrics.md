# My Leads metrics

The top nine cards ignore search and stage filters. The rep selector selects identity scope. Daily activity uses America/Chicago half-open day bounds; current inventory includes previous days.

- Contact without follow-up counts active Contact leads lacking an open/snoozed future appointment. A callback alone does not qualify. Future snooze time satisfies follow-up scheduling.
- Needs offer counts active leads in that stage.
- Overdue counts open/snoozed appointments assigned to the rep on their active leads, using original due time. Consequently a snoozed appointment may be overdue while satisfying future follow-up scheduling.
- Contacts and latest attempt include existing manual outreach as well as call attempts. Activity is credited to the actor even after reassignment.
- Call-quality cards include only call attempts. Reached is a rep selection, never inferred from transport answer status.
- Missing recordings requires expected=true, a finished call at least five minutes old, and no nonblank supplied recording path/URL or available child recording. Unknown expectation is excluded and displayed as coverage.
- Talk metrics use verified seller bridge-to-terminal seconds. Ringing and artifact recording length are not substitutes. Unknown duration is excluded and displayed as coverage. The long-conversation threshold is strictly greater than 300 seconds.

## Provider contract and rollout

Deploy Sandra's additive migrations and signed endpoint acceptance before enabling the paired Jitter producer. Old payloads remain valid. The original KPI response fields remain during rollout.

The signed call-activity PUT accepts nullable `talk_duration_seconds` (nonnegative int4) and `recording_expected` (boolean). Jitter sends terminal evidence with `call_evidence_version: 1`, exact org/attempt/session/provider identity, and finite `ended_at`. This branch updates only evidence and end time, atomically with its webhook receipt. It never updates rep notes/disposition. `provider_ended_at` retains the terminal timestamp independently of browser wrap-up. Ordinary delayed provider writes cannot overwrite terminal evidence.

Jitter must successfully deliver the original call writeback before its durable terminal-evidence sibling. Retries reuse the frozen evidence payload and idempotency key. Historical rows have no guessed timing or expectation backfill. Previously inferred Sandra outcomes without a finalization receipt become pending and available for rep selection.

## Verification

`node scripts/verify-my-leads-metrics.mjs` runs real read-model and metrics SQL on disposable PostgreSQL with a minimal fixture schema. `node scripts/rehearse-call-metrics-writeback.mjs` verifies the additive transaction wrapper with the prior matching function stubbed; existing writeback integration tests remain responsible for the original matching logic. Both are wired into CI. PostgreSQL binaries must be on PATH.

The new synthetic browser scenario checks mobile/desktop card containment. Client tests separately prove filter-independent requests, rep scope, refresh and playback preservation. Full local database E2E requires the existing configured Supabase fixture environment; no shared database reset is part of these rehearsals.
