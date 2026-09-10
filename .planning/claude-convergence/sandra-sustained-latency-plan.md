# Sandra sustained latency planning review

Goal: produce an evidence-backed, provider-documented technical plan resolving recurring Messages, lead detail and Leads latency. User explicitly requested agents, exhaustive relevant documentation/code scanning and Fable help. Scope for this turn is planning; no new implementation, migration, deployment or customer contact.

Plan: `docs/performance/2026-09-10-sustained-latency-plan.md`. Baseline reviewed code `cbf022f5`, diagnostics `a685af5f`. Source map and content-free production counters already recorded. Known latency is measured; cause of a24-hour cycle is unknown.

## Acceptance gates

- [x] Database, application and observability/rollout research completed independently.
- [x] Provider sources and installed-version differences recorded.
- [x] Plan preserves cutoff, search, exact counts, current safety/authorization and source-write reliability.
- [x] Work packages include experiments, ownership areas, files, dependencies, tests, budgets and rollback.
- [x] No unmeasured benefit or solved concurrency protocol claimed.
- [x] Fable consolidated plan review completed; valid concerns incorporated.
- [x] Final local plan consistency/review check and evidence saved.

## Research lanes

- `/root/latency_database_plan`: query/index alternatives, message-facts projection semantics, exact cutoff/unread/search/collision invariants, trigger/MVCC/backfill gates and PostgreSQL/Supabase docs.
- `/root/latency_application_plan`: PR514 scope, remaining serial work, duplicate global Auth rosters, lazy PostgREST builders, unthrottled detail refreshes, safety gating and Next/React/Supabase/Google docs.
- `/root/review_security` reused for observability/rollout: tracing/browser metrics, percentile limitations, synthetic production-build lane, hosted retention/entitlements, exact-SHA migration and separate Vercel rollback.

Two new agents spawned; third spawn hit thread limit, so existing reviewer was reused. No scope was left uncovered; no workers changed code.

## Fable preflight

Existing authenticated Chrome profile through DevTools; no shared desktop input. Original conversation page40 had Fable5.1 checked in model picker, Medium. After page40 disappeared, reopened SAME conversation in background page49; authentication and Fable5.1 Medium preserved. No model substitution or CLI fallback.

Conversation: https://claude.ai/chat/ec54bfa6-ef05-4e8b-bd24-1af8838e7a04

## Iteration1

Initial planning questions and measured/source facts supplied. Completed response: RESEARCH_NEEDED. Accepted actual-node cost attribution, refresh-fanout measurement, conditional projection and ingestion reliability as work-package gates. Independently rejected/corrected: buffer hits proving CPU-only/no indexing opportunity; pg_stat_statements p95; unfiltered subscription equaling cross-org event exposure; unconditional failure swallowing; trigger-disabled timestamp-only backfill; silently stale facet counts.

Source eligibility/cutoff/write mutation questions resolved by database agent. Actual node attribution and campaign rates require instrumented experiments and are explicitly first-phase gates, not assumed answers. No production settings changed to manufacture evidence.

## Iteration2

Complete174-line phased plan supplied with all research results, source register, corrections, scope distinction and plan-only approval criteria. Fable5.1 Medium confirmed before submission. Completed response NEXT_STEP: four plan edits requested, no new research. Added explicit selected-detail hop reduction and region verification; measured deferral trigger for cross-client amplification; zero-dirty whole-request fallback and database-owned per-org rollback control; measured-cost escalation for stale-count product decision. Auth-before-data admission is retained rather than assuming parallel auth is harmless.

## Independent package5 review

Database lane confirmed the conditional concurrency gate is honest. Added candidate-universe dirty/missing detection before counts/pagination and forced-old behavior after maintenance disable until catchup/completeness proof.

## Iteration3

Resubmitted complete revised plan with all four edits and independent database review refinements. Fable5.1 Medium verified. Completed response DONE, confidence high, plan approved for implementation from package0 onward. Full response completed and selected model remained Fable5.1 Medium. Included final non-blocking implementation notes on dirty-detection overhead, existing search indexes and explicit safety table coverage. No remaining planning blocker.

## Final outcome

Planning scope complete. Local consistency/diff checks passed. No product source or production state changed. No browser operator acceptance, migration or merge is claimed or required for plan approval. Implementation outcomes and seven-day improvement remain unproven. Source plan and review ledger retained in isolated worktree; vault capture stored only in _inbox.
