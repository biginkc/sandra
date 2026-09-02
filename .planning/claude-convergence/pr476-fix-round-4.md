# PR 476 Fix Round 4 Evidence

Goal: fix PR #476 blockers after review at `3f7341c9`, on branch `codex/esign-disconnect-owner-gate`, without merging.

Baseline:
- PR #476 before edits: `77058a1c419ef5eef720250c0c3873a8f739debe`
- Base `main`: `64a8780f66055b820d1f30304dd54522557208bc`
- PR #475 is underneath in `main`.

Changes:
- Template/editor Dropbox provider construction now refuses when `get_org_esign_credentials` returns preserved credentials with `sendingEnabled=false`.
- Template orchestrator maps this provider-management capability refusal to visible `TEMPLATE_MANAGEMENT_DISABLED` copy.
- Initial template provider create and definitive retry refuse before Dropbox construction when disconnect is pending.
- Atomic production packet now includes `20260902074814_esign_atomic_disconnect_state.sql` with pinned file and statement hashes.
- Lead send provider test coverage now fails if normal send provider construction ignores `sendingEnabled=false`.

Verification:
- `npx vitest run src/lib/esign/template-foundation-adapter.test.ts src/lib/esign/template-initial-runtime.test.ts src/app/'(dashboard)'/leads/'[id]'/lead-esign-provider.test.ts`: 51 passed.
- `npx eslint scripts/apply-esign-production-migrations-atomically.mjs scripts/apply-esign-production-migrations-atomically.test.mjs src/lib/esign/template-foundation-adapter.ts src/lib/esign/template-foundation-adapter.test.ts src/lib/esign/template-initial-runtime.ts src/lib/esign/template-initial-runtime.test.ts src/lib/esign/template-orchestrator.ts src/app/'(dashboard)'/leads/'[id]'/lead-esign-provider.test.ts src/app/'(dashboard)'/leads/'[id]'/lead-esign-bindings.ts`: clean.
- `npm run typecheck`: clean.
- `npm run verify`: green, including packet test, typecheck, 306 unit files / 3506 tests, and 108 RTL files / 1126 tests.
- `TEST_SUPABASE_DB_URL=postgres://postgres:postgres@localhost:55440/postgres npx vitest run --config vitest.integration.config.ts supabase/migrations/20260829194500_esign_foundation.concurrency.integration.test.ts`: 11 passed, covering email bounce same-request resend, pending-disconnect credential/callback preservation, webhook processing after pending disconnect, contact-first locks, duplicate claims, retry/reminder reconciliation, and send_unknown positive resolution.
- `supabase/migrations/20260830080000_esign_template_upload_reservations.integration.test.ts` could not run standalone on blank Docker Postgres because it assumes the Sandra foundation schema already exists; direct `psql -f 20260829194500...` into blank Postgres also refused at missing pre-existing `public.webhook_consumers`.

Mutation checks:
- Temporarily removing the new template-management `sendingEnabled` checks failed 3 focused pending-disconnect tests.
- Temporarily removing the lead `providerForOrg` `sendingEnabled` guard failed 2 provider tests.
- A temporary packet manifest without `20260902074814` was refused by `loadReviewedPlan` with the exact-order check.

No merge performed.
