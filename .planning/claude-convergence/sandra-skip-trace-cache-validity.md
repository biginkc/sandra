# Sandra Skip-Trace Cache Validity

Goal ID: `sandra-skip-trace-cache-validity`

## Goal

Make cached Tracefy results replayable without losing provider-returned phone data, prevent semantically empty positive cache entries from suppressing a fresh lookup, and report cache/provider outcomes honestly.

## Plan alignment

- User request on 2026-08-28: fix the cache problem before processing the larger PropStream audience.
- Existing plan source: `.planning/claude-convergence/skip-trace-preflight.md`.
- Scope: Sandra skip-trace provider adapter, cache replay/validity, job metrics, and focused regression coverage.
- Excluded: bulk CASS spend, a full-audience Tracefy run, SMS launch, unrelated Sandra work.
- Provider-doc drift: current Tracerfy docs price the adapter's `advanced` batch mode at 2 credits per hit, while the existing preflight plan/code still assumes 1 credit per batch row. This is a launch-safety defect and must be reconciled before another paid run.

## Baseline and authority

- Worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-skip-trace-cache-validity`
- Branch: `codex/skip-trace-cache-validity`
- Baseline: `origin/main` at `876d9f50d781ce35456def6acd36177a727eba8f`
- Authority profile: production-aware. Production reads are allowed; no provider spend or SMS launch. Merge/deploy remain quality-gated by the repository protocol.

## Production failure evidence

- Canary tag contained 130 CASS-verified properties with no stored phone.
- Job `9f81c606-a5a4-4e25-af7d-05fdc6416327` completed 130/130 with 109 `matched`, 21 `no_match`, 130 cache hits, zero provider credits, and zero phone fields added.
- The cache rows were created on 2026-06-12, 2026-06-18, and 2026-06-22.
- All 130 rows retained raw provider payloads. Of the 109 provider matches, raw data contains 86 `primary_phone` values: 55 Mobile and 31 Landline. The normalized cached `persons[].phones` arrays contain none because the flat batch parser ignores `primary_phone` / `primary_phone_type`.
- Remaining raw outcomes: 23 email-only and 21 explicit `provider_no_data`.
- No PII or provider credentials are recorded in this ledger.

## Provider documentation

- Official docs: `https://www.tracerfy.com/skip-tracing-api-documentation/`
- Batch results contain one row per person/address match; contact fields can be empty.
- Batch output documents `primary_phone`, `primary_phone_type`, `mobile_1..5`, and `landline_1..3`.
- Instant lookup documents explicit hit/miss semantics, phone line types, and zero credits on miss.
- Tracerfy documents current batch pricing as normal=1, advanced=2, enhanced=15 credits per hit.
- Tracerfy documents live data as queried at request time; the 90-day cache is Sandra-owned behavior.
- No official idempotency key or force-refresh flag was found. Ambiguous paid submissions must remain fail-closed.

## Tool preflight

- Repository CLI and GitHub CLI: available.
- Claude CLI fallback: installed and authenticated.
- Chrome control: previously verified in this task and available for final visible proof.
- Primary Claude desktop surface: not yet exercised for this loop; must be attempted before the first Claude review packet.
- Provider sandbox: official hosted sandbox exists at `https://mock.tracerfy.com`; use it for non-billable adapter proof where helpful.

## Acceptance gates

- [x] Cached Tracerfy raw payloads are re-normalized through the current adapter before persistence.
- [x] `primary_phone` and `primary_phone_type` are parsed without duplicating numbered mobile/landline fields.
- [x] A positive cache entry is reusable only when it satisfies the normalized contact-data contract; explicit negative cache entries remain reusable.
- [x] A malformed or name-only positive cache entry becomes provider-bound instead of a false cached success.
- [x] Cache replay never counts historical provider credits as credits charged in the current job.
- [x] Cache overwrite refreshes its TTL timestamp.
- [x] Advanced-batch credit preflight matches current official provider pricing.
- [x] Job detail renders the summary keys the runner actually writes and separates mobile, landline-only, and email-only outcomes.
- [x] Focused unit/integration tests cover the exact legacy raw payload, cache fallback, negative cache, immutable credit cap, fan-out/resume accounting, and UI metrics.
- [x] Full typecheck, unit, integration, and RTL verification are green locally.
- [ ] Claude adversarial review returns high-confidence DONE on the exact head.
- [ ] Preview/production deployment is proven before any paid re-canary.
- [ ] A final 130-record re-canary requires a new explicit provider-spend confirmation only if the corrected preflight shows fresh provider-bound rows.

## Implementation and verification evidence

- The adapter now rehydrates preserved raw rows through the current parser, recovers `primary_phone` / `primary_phone_type`, prefers classified mobile numbers, rejects malformed or name-only positives, and preserves explicit provider no-data.
- Preflight and runtime now use owner names where available: Normal costs 1 credit per provider hit; Advanced costs 2; a true one-record synchronous lookup costs 5.
- Every new/approved job stores an immutable maximum-credit authorization. The runner recomputes the unique provider-bound plan and live balance immediately before submission and stops if either gate changed.
- Retry children also run a fresh preflight and persist their own credit ceiling before the workflow starts; the runner refuses every paid call when the persisted ceiling is absent or invalid.
- Batch credits are estimated once per unique provider hit, never per miss or property fan-out, and the submitted trace type survives finalization.
- Cache lookups are bounded-concurrent so a later 16K preflight does not serialize roughly 107 cache requests.
- Full verification: 256 unit files / 2,807 tests and 93 RTL files / 929 tests passed; typecheck passed.
- Read-only production projection on the current code: 130/130 tag rows reusable, zero provider-bound, with 55 mobile, 31 landline-only, 23 email-only, and 21 explicit no-data results. No production row or provider state was changed.

## Manual review reconciliation

- Three independent reviews found credit drift, malformed-cache, fan-out/resume accounting, metrics, phone dedupe, trace-type, bulk latency, and DNC/TCPA parsing risks. The code and regression suite now cover the first seven and parse every explicit compliance flag surfaced in the provider payload.
- Claude iteration 2 at `9bad021` returned `NEXT_STEP`: it confirmed the cache repair and SMS/DNC separation, then found that flat batch misses were being charged in the displayed credit estimate. The repair now applies the per-hit rate only to `result.hit`, labels the UI metric estimated, and regression-tests one paid hit plus three free misses as 2 credits rather than 8.
- A read-only production query found zero active (`queued` or `pending_approval`) skip-trace jobs and zero active jobs missing a credit ceiling. No backfill or cancellation was needed.
- Codex additionally found the retry RPC created queued children without a ceiling. Retry now preflights and stamps the cap before workflow start, while the runner independently fails closed if any paid path still reaches it without a persisted cap.
- Residual hard gate: the historical queue rows contain no DNC/TCPA fields even though current Tracerfy documentation says new skip-trace results include inline flags. Mobile classification is not registry-grade DNC clearance. Do not launch SMS from the 55 recovered mobile numbers until a separately authorized DNC scrub or equivalent verified compliance source is applied.

## Research agents

- `cache_code_audit`: confirmed the cache/runner/persistence semantic contradiction and identified regression surfaces.
- `tracerfy_docs`: confirmed first-party provider semantics, response fields, pricing, retry limits, and absence of an idempotency key.
- `cache_fix_design`: independently confirmed that raw-payload rehydration, semantic cache validity, immutable spend ceilings, and honest outcome accounting are the smallest safe repair; those recommendations are reconciled in the implementation above.
