# START HERE

You are Claude. Act as orchestrator and adversarial reviewer. Codex is executor and verifier.

Goal:
- goal_id: sandra-skip-trace-cache-validity
- goal_description: Correct Sandra's Tracefy cache replay so provider-returned phones are recovered, semantically invalid positive cache rows cannot suppress fresh lookup, current-run credits are truthful, and another paid/full-audience run stays blocked until proven safe.
- plan_source: user request plus `.planning/claude-convergence/skip-trace-preflight.md`
- baseline_ref: origin/main `876d9f50d781ce35456def6acd36177a727eba8f`
- authority_profile: Production-aware

Plan Alignment:
- plan_items: preserve explicit preflight before provider spend; cache-first execution remains; final launch rechecks eligibility and credits.
- exclusions_or_divergence: no full-audience provider run, no SMS, no cache deletion. Current Tracerfy docs say advanced batch is 2 credits/hit, contradicting the existing 1-credit preflight assumption.
- plan_gate_delta: current provider pricing must be reflected; existing raw cache must be re-parsed before any paid refresh is considered.

Loop State:
- iteration_count: 1
- current_status: read-only production evidence, code audit, official provider-doc research, and independent repair design complete; no implementation yet.
- evidence_delta_last_iteration: yes
- blockers: none for local implementation
- prior_advice_log: none
- budget_remaining: 9 iterations

Acceptance Gates:
- [ ] Current Tracefy adapter parses flat `primary_phone` and `primary_phone_type`, deduping numbered phone fields.
- [ ] Cached raw payloads are re-normalized through the current provider adapter before reuse.
- [ ] Positive cache rows must satisfy the normalized contact-data contract; explicit provider no-data remains reusable.
- [ ] Unknown/malformed positive cache data becomes provider-bound, not false success.
- [ ] Cached replay contributes zero current-run credits; provider credits are not multiplied by fan-out.
- [ ] Real provider cache overwrite refreshes TTL; projection-only repair does not pretend to be a fresh observation.
- [ ] Advanced-batch preflight uses current official pricing.
- [ ] Job UI reads actual runner summary keys and avoids equating provider match with mobile readiness.
- [ ] Focused tests, full verification, manual review, and Chrome proof pass.

Verification Results:
- Production canary: fail. 130/130 completed as 109 matched and 21 no-match, but zero phones were persisted and zero provider credits were used.
- Raw-cache audit: 130 raw payloads preserved; 86 contain primary_phone (55 Mobile, 31 Landline), 23 email-only, 21 provider_no_data. Existing normalized persons contain zero phones because the parser ignores the primary fields.
- Provider docs: pass. Official batch schema documents primary_phone/type plus numbered mobile/landline fields; provider match means a person row and can have empty contact fields; advanced costs 2 credits/hit; no idempotency key or force-refresh flag documented.

Evidence:
- `src/lib/skip-trace/providers/tracerfy.ts`: flat parser reads mobile_N/landline_N but not primary_phone/type; name-only flat row becomes hit.
- `src/lib/skip-trace/cache.ts`: all in-TTL rows are returned; write upsert does not renew created_at.
- `src/lib/skip-trace/skip-trace-job.ts`: any cache row suppresses provider lookup; cached historical credits are added to current run.
- `src/lib/skip-trace/types.ts`: contract says hit means a person with phone or email, contradicting adapter behavior.
- `src/app/(dashboard)/jobs/[id]/job-detail.tsx`: reads hits/no_matches/credits_used while runner writes matched/no_match/total_credits.
- Official docs: https://www.tracerfy.com/skip-tracing-api-documentation/

Constraints:
- No secrets or PII in prompts/artifacts.
- No production mutation or paid provider call during implementation.
- Preserve valid mobile, landline, email-only, and explicit no-data cache outcomes; do not waste credits with a generic mobile-only validity rule.
- Rehydrate raw cache before classifying refresh_required.
- Paid request ambiguity must fail closed because no official idempotency key exists.

Exact Question:
- Challenge the proposed smallest repair: parser support for primary_phone/type; provider-specific cache rehydration from raw; contact-contract validation after rehydration; truthful credit/metric fixes; cache timestamp renewal only on fresh provider writes; 2-credit advanced preflight; focused regression tests. Identify any safety or design correction required before Codex edits.

Return exactly one verdict: NEXT_STEP, RESEARCH_NEEDED, DONE, BLOCKED, or LOOP_REASSESS.
Use `proposed_action`, not `next_step`.

Response shape:
verdict: NEXT_STEP | RESEARCH_NEEDED | DONE | BLOCKED | LOOP_REASSESS
reasoning: <short rationale>
confidence: low | medium | high
proposed_action:
  action: <only for NEXT_STEP>
  scope: <files/systems/providers allowed>
  expected_verification: <concrete proof>
  hard_gate_risk: <none or named gate>
research_questions:
  - <only for RESEARCH_NEEDED; max 3>
done_criteria:
  - <only for DONE>
blocker_description: <only for BLOCKED>
iteration_budget_advice: continue | reduce scope | reassess | stop
