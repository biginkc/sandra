# Production Playwright canaries

These specs validate Sandra against the deployed application with real auth and
real production services. They are separate from the default test-project E2E
suite and do not run in regular `npm run test:e2e`.

Run locally with:

```bash
RUN_PROD_CANARIES=1 npm run test:e2e:prod-canary
```

Local env loading:

- put production canary secrets in `.env.prod-canary.local`
- `.env.prod-canary.local` is loaded before `.env.local`
- shell environment variables still take precedence over both files
- do not point `NEXT_PUBLIC_SUPABASE_URL` at the shared test project; DB-backed
  prod canaries will refuse to run unless the URL matches the production
  Supabase project

Required environment:

- `PROD_EMAIL`
- `PROD_PASSWORD`
- `PROD_BASE_URL` when testing a non-default deployed URL
- `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for canaries that
  verify persisted production state directly
- `DIALPAD_WEBHOOK_SECRET` for signed inbound webhook canaries

Canary data must be tagged with `PROD-CANARY <run_id>`, and cleanup must only
target data created by the active canary run.

Current coverage:

- real production auth and shell navigation
- real production membership/RLS coverage that seeds canary-owned rows in the
  authenticated user's org and an unrelated canary org, verifies only the
  visible org row renders through `/properties`, and cleans up both property
  and organization artifacts
- real production list create/archive/delete cleanup for canary-owned rows
- real production prospect insert/search/delete cleanup for canary-owned rows
- real production drawer filter controls against canary-owned prospect rows and
  list membership data
- real production large-list filter coverage that creates 275 canary-owned
  prospects and verifies the UI avoids Bad Request failures
- real production quick preset coverage that applies and clears High Equity
  against canary-owned prospect rows
- real production CSV import coverage that uploads a canary file through the UI,
  waits for the import job to finish, verifies persisted prospects, and cleans
  up the storage/import/job/property artifacts
- real production CSV update-mode coverage that uploads a canary file through
  the UI, previews matched and unmatched rows, applies property status updates,
  verifies the update job counters and persisted statuses, and cleans up the
  canary job/property artifacts
- real production lead qualification coverage that promotes a canary-owned
  prospect through the UI, verifies the `new_lead` persisted state, confirms it
  renders on `/leads`, and cleans up the canary property
- real production Kanban status coverage that creates a canary-owned lead,
  drags it from New Lead to Contacted, verifies the persisted status change,
  confirms the lead still renders after reload, and cleans up the canary
  property
- real production lead management coverage that edits a canary-owned lead
  detail page status, motivation, and assignee, verifies the persisted DB row,
  confirms the controls survive reload, and cleans up the canary property
- real production SMS template lifecycle coverage that creates, edits,
  soft-deletes, verifies persisted state, verifies visible table state, and
  hard-cleans canary-owned template rows
- real production outbound SMS coverage that requires an allowlisted recipient,
  sends through the lead-detail UI, verifies the provider-backed message row is
  `sent`, confirms thread visibility, and cleans up canary-owned contact,
  consent, property, and message rows
- real production inbound SMS coverage that signs and posts a Dialpad-shaped
  webhook, verifies the `received` message row, confirms lead-thread
  visibility, and cleans up canary-owned contact, property, and message rows
- real production STOP/DNC coverage that signs and posts a STOP webhook,
  verifies opt-out consent, contact suppression, sequence enrollment pause,
  lead-thread visibility, blocked-send UI feedback, and canary cleanup
- real production AI responder happy-path coverage that signs and posts an
  inbound SMS, waits for the AI-generated outbound provider send, verifies no
  escalation, confirms both messages render in the lead thread, and cleans up
- real production AI escalation coverage that signs and posts a keyword
  escalation inbound, verifies human-attention state, asserts no outbound
  message is sent, confirms the UI escalation banner, and cleans up
- real production sequence coverage that seeds a one-step active sequence,
  waits for the production sequence tick to send through the provider, verifies
  completed enrollment and lead-thread rendering, and cleans up
- real production Sandra/Jitter dialer handoff coverage that creates a canary
  dialer batch through the UI, registers a canary Jitter writeback consumer,
  verifies signed batch fetch/claim/writeback endpoints, confirms the call
  appears on the lead, and cleans up dialer/webhook/contact/property artifacts
