# Properties Filter Characterization

Goal ID: properties-filter-characterization

## Goal

Characterize the merged `/properties` filter implementation on current `main`, fix only a concretely reproduced root cause, and drive the work to proof.

## Authority

- Autonomy: A5 gated.
- Target DB: production Supabase project `copflsklaefwzipsrjqz`.
- Test user: `sandra-filter-test@bmhgroupkc.com`.
- Production data writes allowed only for throwaway `saved_filters` rows owned by the test user, with cleanup.
- All other production data access is read-only.
- No paid provider, AI, Twilio, skip-trace, SMS, or external customer contact paths.
- Do not merge or cherry-pick stale branch `claude/20260507-225956-05-09-wire-page` / `b2cb9e0`.

## Acceptance Gates

- [x] Current `main` baseline verified.
- [x] Production credentials and auth path verified without printing secrets.
- [x] Pass 1 matrix run against production: real parse/translate/query path compared to independent oracle.
- [x] Pass 2 matrix run against deployed production app: block interactions, URL rehydration, and preset save/reload compared to oracle.
- [x] Any failure has a reproduced root cause before code changes.
- [x] Fixes are scoped to reproduced root cause only; no Phase 05 rebuild.
- [x] Focused regression tests added or updated for each fix.
- [x] Focused tests and relevant verification pass.
- [x] Browser verification proves `/properties` behavior.
- [x] `manual-code-review` runs before Claude review/next-step escalation after code changes.
- [ ] Claude reviews with veto before final merge/deploy.
- [x] Pre-merge Vercel deployment ID recorded for rollback if merge proceeds.
- [ ] Slack notification and vault note are posted at DONE or BLOCKED when available.

## Iteration Log

### 2026-05-31 Iteration 0

- Baseline worktree: `/Users/jarradhenry/Sites/Sandra-codex-20260531-properties-filter-characterize`.
- Branch: `codex/20260531-properties-filter-characterize`.
- Baseline commit: `ee2d482`.
- Open authored PRs at start: none.
- Main checkout has unrelated dirty/untracked files; ignored per worktree rule.
- Existing evidence found:
  - `e2e/properties-filter-db-oracle-smoke.spec.ts`
  - `e2e/properties-filter-production-data.spec.ts`
  - `e2e/prod-canary/filters.spec.ts`
  - `src/lib/prospects/filter-to-supabase.ts`
  - `src/lib/prospects/filter-schema.ts`
- Credential check: Keychain item `SANDRA_FILTER_TEST_USER_PW` is available; value not printed.
- Vercel env names for production are present in linked Sandra project; values not printed.

### 2026-05-31 Iteration 1

- Supabase MCP tools were not available in this Codex runtime. This line supersedes earlier stale notes: account-level Supabase CLI evidence is invalid for this run and was not used for final verification after Jarrad's correction.
- Production auth verified through `/tmp/sandra-prod.env` anon-key test-user path:
  - Project ref: `copflsklaefwzipsrjqz`.
  - Test user signs in successfully.
  - Membership: org `00000000-0000-0000-0000-000000000bbb`, role `member`.
  - RLS-visible active properties: 51,708.
  - RLS-visible prospects: 49,052.
- Baseline prospects tests:
  - Command: `npx vitest run src/lib/prospects/`.
  - Result: 3 files passed, 100 tests passed.
- Current Vercel prod deployment before any merge:
  - Alias inspected: `sandra-sooty.vercel.app`.
  - Deployment id: `dpl_Ebmqgk2eY6xKx259tVHyYQ35xnMj`.
  - Status: Ready.

### 2026-05-31 Iteration 2

- User correction applied: every production query/test sources `/tmp/sandra-prod.env`; no `supabase projects ...`, no account-level key retrieval, no service-role app/oracle validation.
- 1Password state inspected via Computer Use: no active approval modal was visible; no lingering Supabase account-level CLI process was running.
- Pass 1 harness changed to use anon key + `PROD_PASSWORD` only and to refuse non-`copflsklaefwzipsrjqz` URLs.
- Pass 1 final result: 272/272 passed; output curated at `docs/qa/properties-filter-characterization/pass1-production-matrix.{json,md}`.
- Reproduced deployed production UI failures before fix:
  - Pass 2 count matrix: 94/100 passed; failures limited to `tag` and `list_count` relationship filters.
  - Pass 2 URL rehydration: 22/23 passed; failure was `list_count`.
  - Pass 2 saved preset save/reload/cleanup: 1/1 passed.
- Local-dev verification on fix branch:
  - Pass 2 count matrix: 100/100 passed.
  - Pass 2 URL rehydration: 23/23 passed.
  - Pass 2 saved preset save/reload/cleanup: 1/1 passed.
- Curated Pass 2 summary: `docs/qa/properties-filter-characterization/pass2-ui-summary.md`.
- Focused regression tests: `npx vitest run src/lib/prospects/ src/app/'(dashboard)'/properties/actions.select-all.test.ts` passed 119/119.
- Full repo verification: `npm run verify` passed (`tsc --noEmit`, 983 unit tests, 316 RTL tests).
- Manual code review started before Claude review. Valid findings accepted:
  - Fix `getAllMatchingProspectIds` to select `filterSelectFragment(...)` for embedded relationship filters.
  - Avoid shared embedded aliases for repeated `list`/`tag` blocks by falling back to the existing parent-id prefetch path for repeated positive or negative relationship blocks.
  - Move Pass 2 runtime outputs and auth storage under ignored `test-results`; disable traces/screenshots by default.
  - Add stable selectors for Pass 2 count and preset controls.
  - Remove untracked `supabase/.temp` CLI state.

### 2026-05-31 Iteration 3

- Final post-review verification after harness compatibility fixes:
  - `source /tmp/sandra-prod.env; npm run filters:characterize:pass1` passed 272/272.
  - `source /tmp/sandra-prod.env; RUN_PROPERTIES_FILTER_CHARACTERIZATION=1 EXPECT_PROPERTIES_FILTER_UI_PASS=0 FILTER_UI_TARGET=prod npm run test:e2e:properties-filter` completed as characterization: count matrix 94/100, URL rehydration 22/23, saved preset 1/1.
  - `source /tmp/sandra-prod.env; RUN_PROPERTIES_FILTER_CHARACTERIZATION=1 EXPECT_PROPERTIES_FILTER_UI_PASS=1 FILTER_UI_TARGET=local-dev FILTER_UI_BASE_URL=http://localhost:3466 npm run test:e2e:properties-filter` passed: count matrix 100/100, URL rehydration 23/23, saved preset 1/1.
  - `source /tmp/sandra-prod.env; npm run verify` passed (`tsc --noEmit`, 983 unit tests, 316 RTL tests).
- Pass 2 harness compatibility fixes:
  - Legacy deployed production can be read without the new `prospects-result-count` and `save-preset-toggle` test ids.
  - Runtime outputs and target-specific auth state remain under ignored `test-results/properties-filter-characterization/`; traces/screenshots remain disabled unless explicitly opted in.
  - Diagnostic test timeout defaults to 10 minutes because deployed production characterization is intentionally exhaustive.
- Redundant post-auth-path prod rerun stalled in the saved-preset leg after count and URL characterization completed; it was killed, no throwaway saved filters remained, and the prod saved-preset slice was rerun directly and passed 1/1.
