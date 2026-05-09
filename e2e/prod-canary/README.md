# Production Playwright canaries

These specs validate Sandra against the deployed application with real auth and
real production services. They are separate from the default test-project E2E
suite and do not run in regular `npm run test:e2e`.

Run locally with:

```bash
RUN_PROD_CANARIES=1 npm run test:e2e:prod-canary
```

Required environment:

- `PROD_EMAIL`
- `PROD_PASSWORD`
- `PROD_BASE_URL` when testing a non-default deployed URL
- `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for canaries that
  verify persisted production state directly

Canary data must be tagged with `PROD-CANARY <run_id>`, and cleanup must only
target data created by the active canary run.

Current coverage:

- real production auth and shell navigation
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
