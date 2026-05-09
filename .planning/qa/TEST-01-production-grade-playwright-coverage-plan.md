# TEST-01 production-grade Playwright coverage plan

Date: 2026-05-09
Status: planned

## Purpose

Track the automated, repeatable production validation Sandra still needs before
the application can be called production-ready.

This plan is specifically for production-grade Playwright coverage. These tests
must run against the real deployed app and exercise real auth, real production
services, real provider calls, real storage, and real database writes. They must
not rely on mocked APIs, mocked providers, request stubbing, fake services, or
synthetic-only service replacements.

Lower-level unit tests, RTL tests, local Playwright tests, seeded test-database
tests, and mocked provider tests remain valuable, but they do not count toward
this production-readiness tracker.

## Current baseline

Sandra already has meaningful automated coverage, but most of it is not
production-grade by this plan's definition.

- GitHub Actions `E2E` runs `npm run test:e2e` against the shared test Supabase
  project, not production.
- The E2E workflow intentionally uses `SKIP_INTENT_GATE=1`, so it does not prove
  the real AI/provider path.
- `SMS Prod Canaries` run weekday production smoke scripts for AI responder
  happy path, AI responder escalation, and STOP keyword behavior.
- `Sequences V1 Prod Canary` runs a weekday production smoke script that seeds
  throwaway production data, waits for the production sequence tick, verifies the
  provider-delivered SMS path, and cleans up seed data.
- Existing production smoke scripts guard against accidental test-project usage
  by refusing the known test Supabase project ref.
- Existing production canaries are script-level smoke checks, not Playwright
  user-flow checks across the whole application UI.

## Production validation rules

Every production-grade Playwright test must follow these rules.

- Run against the production deployment URL.
- Authenticate with real production credentials for a dedicated canary account.
- Write only canary-tagged production data.
- Use owned and allowlisted phone numbers, emails, files, contacts, and provider
  accounts.
- Make real provider calls whenever the feature depends on a provider.
- Verify both the visible application result and the underlying persisted state.
- Clean up only data created by the current canary run.
- Fail loudly if production secrets, provider credentials, canary account
  credentials, allowlisted destinations, or cleanup safeguards are missing.
- Record the canary run id in created records whenever a metadata or notes field
  is available; otherwise use a `PROD-CANARY <run_id>` prefix in names, labels,
  addresses, message bodies, or file names.
- Document expected provider cost before moving any canary to a schedule.

## Required coverage tracker

| App area | User happy path | Real services exercised | Real database/storage writes | Existing coverage | Missing Playwright coverage | Cleanup/guardrails | Priority | Cadence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Auth | Login as the dedicated canary user, persist session, reload, and confirm protected app access. | Production Supabase Auth, production app. | Auth session only. | Test-project E2E auth setup exists. | Production login/session Playwright spec. | Dedicated low-privilege canary user; fail if URL is not production. | P0 | Pre-release and post-deploy |
| Auth and membership | Confirm canary user only sees tenant-scoped data and cannot access another tenant's records. | Production Supabase Auth, RLS, production app. | Canary tenant rows. | Test-project membership/RLS coverage exists. | Production RLS/membership UI proof. | Canary tenant only; no cross-tenant destructive writes. | P0 | Pre-release |
| Dashboard shell | Load authenticated dashboard, navigate primary sections, and verify protected routes do not leak unauthenticated content. | Production app, production auth. | None or canary audit row if added later. | Local/test E2E shell coverage exists. | Production shell/navigation Playwright spec. | Read-only after login. | P0 | Post-deploy |
| Imports | Upload a canary CSV, create an import job, process rows, show skipped rows, and display final counts. | Production app, Supabase DB, Supabase Storage if upload path stores files, import worker/runtime. | Import job, properties/prospects, contacts, skipped-row records, uploaded file if applicable. | Test-project import wizard specs exist. | Production import Playwright spec with real file upload and row verification. | Canary CSV only; all rows tagged/prefixed; cleanup imported records and storage object. | P0 | Pre-release |
| Import updates | Re-import matching canary rows and verify update mode changes existing records instead of duplicating them. | Production app, production DB, import update logic. | Updated canary property/prospect/contact rows, import job rows. | Test-project update wizard spec exists. | Production update-mode Playwright spec. | Use unique canary addresses; cleanup by run id. | P0 | Pre-release |
| Prospects list | Load prospects table, search for a canary address, sort, and verify the expected row appears. | Production app, production DB. | Canary prospect/property rows. | Test-project and prod-data filter smoke coverage exists. | Production UI Playwright spec using canary-created rows. | Seed only canary rows; verify row identity, not only counts. | P0 | Post-deploy |
| Prospects filters | Apply drawer filters, quick presets, and multi-filter combinations; verify counts and exact canary rows. | Production app, production DB. | Canary properties, lists, contacts, filterable attributes. | Dynamic DB-oracle smoke exists for filters; drawer specs exist in test project. | Production Playwright matrix across high-risk filters and combinations. | Create small oracle data set per run; cleanup by run id. | P0 | Pre-release |
| Saved filter state | Save a filter or preset if supported, reload, apply it, and remove it. | Production app, production DB. | Saved filter/preset row. | Some UI filter behavior exists in test E2E. | Production saved-filter Playwright coverage. | Name with `PROD-CANARY`; delete saved preset after test. | P1 | Pre-release |
| Lists | Create a list, add canary properties, filter by the list, remove members, and delete the list. | Production app, production DB. | List rows and list membership rows. | Test/project list-filter coverage exists. | Production list CRUD and list-filter Playwright spec. | Canary list name; cleanup memberships before list. | P0 | Pre-release |
| Large lists | Create or select a large canary-safe list and verify large-list filtering does not create oversized requests or 400s. | Production app, production DB. | Canary list and many membership rows, unless using an existing canary list. | Large-list bug has regression coverage outside production UI. | Production Playwright proof for large-list filter path. | Use generated canary members or a dedicated reusable canary list. | P0 | Pre-release |
| Lead qualification | Qualify a canary prospect into a lead and verify it appears in the pipeline. | Production app, production DB. | Lead row, prospect status/linkage updates, activity rows if created. | Test-project qualify flow exists. | Production qualify Playwright spec. | Canary prospect only; cleanup lead and linked rows. | P0 | Pre-release |
| Lead management | Open a canary lead, edit details, assign owner/status, and verify persistence after reload. | Production app, production DB. | Lead updates, assignment/status rows if applicable. | Test-project cockpit/lead detail specs exist. | Production lead detail Playwright spec. | Dedicated canary lead; restore/delete after run. | P1 | Pre-release |
| Kanban | Drag a canary lead between pipeline columns and verify persisted status. | Production app, production DB. | Lead status/stage updates. | Test-project Kanban drag spec exists. | Production Kanban Playwright spec. | Canary lead only; cleanup or restore original status. | P1 | Pre-release |
| Messaging outbound | Send an SMS from the UI to an owned allowlisted number and verify provider send plus UI thread update. | Production app, production DB, real SMS provider. | Message row, provider delivery/log row, contact activity. | Script-level production SMS canaries exist. | Production Playwright outbound SMS spec. | Allowlisted recipient; message body includes canary run id. | P0 | Pre-release and scheduled |
| Messaging inbound | Receive a real inbound SMS from an owned number and verify thread rendering and persisted inbound message. | Real carrier/provider inbound path, production webhook, production DB, production app. | Inbound message row, contact/thread updates. | Some signed webhook canaries exist; true provider round trip is not fully covered by Playwright. | Production Playwright inbound SMS verification. | Owned sender only; cleanup canary contact/messages. | P0 | Scheduled |
| STOP and DNC | Send STOP through the real provider path and verify opt-out state, paused enrollments, and UI state. | Real SMS provider, production webhook, production DB, production app. | Consent/contact flags, consent event, paused enrollment if present. | Script-level STOP prod canary exists. | Playwright UI verification after STOP production canary. | Owned number only; reset canary consent state after run if legally safe. | P0 | Scheduled |
| AI responder | Trigger a real inbound message that should get an AI response and verify the outbound response appears in UI. | Production app, production DB, AI provider, SMS provider. | Messages, AI responder logs/activity, contact state. | Script-level AI happy and escalation prod canaries exist. | Playwright coverage that verifies the UI and persisted state after real production AI flow. | Canary contact/message body; allowlisted number. | P0 | Scheduled |
| AI escalation | Trigger a real inbound escalation case and verify no outbound response is sent, escalation reason persists, and UI flags it. | Production app, AI provider/classifier, SMS provider guardrails, production DB. | Escalation/activity rows, message rows. | Script-level escalation prod canary exists. | Playwright UI verification for escalation state. | Canary contact only; assert no outbound provider send. | P0 | Scheduled |
| Sequences | Enroll a canary contact, wait for production sequence tick, verify real provider delivery and completed enrollment. | Production app, production DB, Vercel cron/runtime, SMS provider. | Sequence, enrollment, contact, message, consent rows. | Script-level production sequence canary exists. | Playwright sequence enrollment and UI verification around the existing prod canary. | Canary sequence/contact only; cleanup all seeded rows. | P0 | Scheduled |
| Templates | Create, edit, use, and delete an SMS template in a real send-capable flow. | Production app, production DB, SMS provider if used in send step. | Template row, message row if send is included. | Unit/test E2E coverage may exist, not production-grade. | Production Playwright template lifecycle spec. | Canary template name; delete after run. | P1 | Pre-release |
| Notifications/realtime | Produce a real message or assignment event and verify the notification/realtime UI updates without manual refresh. | Production app, production DB realtime, provider/webhook or assignment action. | Message/assignment/notification rows. | Test-project notification and cockpit realtime specs exist. | Production realtime Playwright spec. | Canary event only; cleanup notification source rows. | P1 | Post-deploy |
| Webhooks | Configure or verify a production webhook path with a real signed provider delivery and visible UI result. | Real provider webhook, production app, production DB. | Webhook event/log rows and downstream records. | Admin webhook E2E exists outside production-grade provider delivery. | Production Playwright/admin verification tied to real webhook event. | Use provider-owned test event only; no destructive webhook config changes without restore. | P1 | Pre-release |
| Skip trace | Run skip trace for a canary record and verify real provider result is persisted and visible. | Production app, Tracerfy or configured real skip-trace provider, production DB. | Skip-trace job/result rows, contact updates. | Script smoke exists for real provider when env is configured. | Production Playwright skip-trace UI spec. | Canary property only; expected cost documented. | P1 | Manual or pre-release |
| Address/CASS verification | Run address verification for canary addresses and verify persisted verification state and UI badges. | Production app, real address verification provider, production DB. | Address verification fields/status rows. | Retry scripts exist; no production Playwright coverage identified. | Production Playwright address verification spec. | Use controlled canary addresses; cleanup or reset canary rows. | P1 | Pre-release |
| File/storage flows | Upload, read, and delete files used by imports or attachments through the production app. | Production app, Supabase Storage, production DB. | Storage object, metadata/job rows. | Import tests may cover upload in test project. | Production Playwright storage-path spec. | Prefix file names with canary run id; delete storage object. | P1 | Pre-release |
| Dialer/Jitter handoff | Create a Sandra dialer batch, verify Jitter consumes it, and verify Sandra receives call activity/writeback. | Sandra production app/DB, Jitter production integration, real provider path where applicable. | Dialer batch/items, call activity, recording/transcript metadata if produced. | Dialer batch create E2E exists in test project; Phase 1 integration exists outside production. | Production Playwright/Sandra verification around real Jitter handoff. | Canary batch/list only; cleanup batch/items/writeback rows. | P0 | Pre-release |

## Missing test infrastructure

- Dedicated production canary user with least-privilege access.
- Owned allowlisted phone numbers for outbound and inbound SMS.
- Owned canary email inbox or auth-link capture path for production auth flows
  that require email.
- Production-safe data factory for properties, contacts, lists, leads, messages,
  templates, sequences, dialer batches, and storage objects.
- A shared cleanup helper that deletes only rows and files created by the
  current canary run.
- A durable canary run log that records run id, environment, provider calls,
  created record ids, cleanup status, cost estimate, and failure reason.
- A GitHub Actions workflow for production-grade Playwright canaries that is
  separate from the existing test-project E2E workflow.
- Clear cadence labels so high-cost or high-risk flows remain manual until they
  are safe enough for scheduled execution.

## Recommended implementation order

1. Add shared production Playwright canary harness: production URL guard, canary
   credentials, run id, tagging, cleanup registry, and fail-loud secret checks.
2. Add read-mostly production smoke coverage for auth, dashboard shell, and
   protected navigation.
3. Add canary data factory and cleanup helpers for imports, prospects, lists,
   leads, templates, and storage objects.
4. Add production Playwright coverage for imports, prospects, filters, lists,
   lead qualification, and Kanban.
5. Add provider-backed messaging coverage for outbound, inbound, STOP/DNC, AI
   responder happy path, and AI escalation.
6. Wrap the existing Sequences V1 production canary with Playwright UI
   verification.
7. Add higher-cost provider paths for skip trace and address/CASS verification.
8. Add Sandra/Jitter dialer handoff coverage after the production integration
   contract is stable.
9. Move stable P0 canaries to post-deploy or scheduled workflows; keep expensive
   P1 canaries manual or pre-release until cost and cleanup are proven.

## Success condition

Sandra can be called production-ready when every P0 row in the tracker has
automated Playwright coverage proving the complete production path end to end:
real user action, real production auth, real service/provider call, real
database or storage write, visible application result, persisted-state
verification, and safe cleanup.

P1 rows do not block the first production-ready call if they are explicitly
tracked with owner, target cadence, and implementation issue.
