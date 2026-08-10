# START HERE

You are Claude. Act as orchestrator and reviewer. Codex is executor and verifier.

Goal:
- goal_id: sandra-credit-snapshot
- goal_description: Remove the live skip-trace provider balance request from Sandra Overview startup. Refresh and store it every 15 minutes between 06:00 and 00:00 America/Chicago, make Overview read the stored snapshot, and provide an admin-only manual refresh with freshness UI.
- plan_source: Jarrad's approved design in the 2026-08-10 Codex task
- baseline_ref: origin/main c4297c62e2b140f30184646e0600dc14ad0390e4
- authority_profile: Production-aware

Plan Alignment:
- plan_items: reuse the existing metric_snapshots table and authenticated Vercel cron pattern; preserve current dashboard structure
- exclusions_or_divergence: no Messages, Prospects, Leads, dashboard-summary, or unrelated performance changes
- plan_gate_delta: protect the last successful snapshot on provider failure; enforce the Central-Time window in application logic to avoid DST drift

Loop State:
- iteration_count: 1
- current_status: architecture proposed; no code changes yet
- evidence_delta_last_iteration: yes; fresh production direct-URL loads exceeded 10 seconds and were inspectable at about 22 and 31 seconds
- blockers: none
- prior_advice_log: none
- budget_remaining: 10 iterations

Acceptance Gates:
- [ ] Overview reads latest stored balance without invoking provider
- [ ] Authenticated idempotent refresh only calls provider within 06:00-00:00 America/Chicago
- [ ] DST-safe scheduling
- [ ] Admin manual refresh persists and refreshes UI
- [ ] Non-admin cannot trigger refresh
- [ ] UI shows last-checked/not-yet-checked
- [ ] Provider failure preserves last successful snapshot
- [ ] Tests, typecheck, build pass
- [ ] Manual review clean
- [ ] Preview Chrome proof

Verification Results:
- all implementation gates: untested
- baseline diagnosis: pass; DashboardPage awaits getSkipTraceBalance(), which awaits provider.getBalance()

Evidence:
- src/app/(dashboard)/dashboard/page.tsx awaits getSkipTraceBalance in the page Promise.all
- src/lib/skip-trace/balance.ts directly awaits provider.getBalance
- supabase/migrations/049_metric_snapshots_table.sql already supports a latest metric snapshot and authenticated reads
- vercel.json and src/app/api/cron/phone-coverage-snapshot/route.ts establish the cron-auth pattern

Constraints:
- no secrets or customer data
- no provider call during page render
- no production migration or deployment in this iteration
- keep the change scoped

Exact Question:
- Stress-test this architecture before implementation. Identify any missing acceptance gate or unsafe design assumption, then give the single best next implementation action.

Return exactly one verdict: NEXT_STEP, RESEARCH_NEEDED, DONE, BLOCKED, or LOOP_REASSESS.
Use proposed_action, not next_step, in this exact shape:

verdict: NEXT_STEP | RESEARCH_NEEDED | DONE | BLOCKED | LOOP_REASSESS
reasoning: <short rationale>
confidence: low | medium | high

proposed_action:
  action: <only for NEXT_STEP>
  scope: <files/systems/providers allowed>
  expected_verification: <proof>
  hard_gate_risk: <none or named gate>

research_questions:
  - <only for RESEARCH_NEEDED; max 3>

done_criteria:
  - <only for DONE>

blocker_description: <only for BLOCKED>
iteration_budget_advice: <continue | reduce scope | reassess | stop>
