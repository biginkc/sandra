# My Leads stress-test campaign

Objective: actively try to break every My Leads action and connected modal, establish reproducible defects, and prove persisted outcomes. Current candidate65c58eb0.

## Coverage

- PAGE-AND-MODALS.md: queue, role/period/search controls, all7 workflow modes and input/state combinations.
- CONNECTED-FLOWS.md: 41 case groups covering connected notes, appointments, calls and downstream Open lead controls.
- DATA-AND-ENVIRONMENT.md: 74 planned cases covering timers, KPIs, permissions, concurrency, idempotency, pagination and unintended effects.
- FINDINGS.md: verified defects with steps, expected/actual, scope and retest.

## Execution order

1. Live owner-only nonmutating probes, avoiding Maria.
2. Isolated synthetic rep: queue and every modal cancel/validation/success path, refresh persistence, extreme values and duplicate submits.
3. Synthetic owner/member/foreign users: role boundaries, stale two-tab commands and attribution.
4. Expand deterministic synthetic fixtures for paging, timers and KPI arithmetic; corroborate UI via database reads.
5. Connected workflow stress, keyboard/mobile/zoom and failure recovery.
6. Fix independently reproduced product defects only within reviewed scope; repeat exact reproductions and neighboring flows, then normal CI/release verification.

Each test remains PLANNED until evidence is recorded. PASS, FAIL, BLOCKED and NOT RUN are distinct. Provider-dependent actions remain blocked pending explicit owned target/spending scope. Production writes are excluded from current probes; destructive workflow tests use local synthetic leads.

The shared E2E bypass remains in force; it does not waive unit, component, database or this in-app browser campaign.
