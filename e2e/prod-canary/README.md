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
