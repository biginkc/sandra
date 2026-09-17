# Opus 5 Clock fixture follow-up

Session: `94a8cffe-4877-4ab6-92bc-cf46b974b644`. Model usage verifies `claude-opus-5`. Scope is the bounded test/harness review; not deployment or final readiness approval.

## Verdict: APPROVED — bounded clock fixture (B1–B4) only

Not a deployment approval. Browser readiness (4/6, login navigation + router initialization) and the mutation gate remain open and are unaffected by this sign-off.

---

### B1 — config host/port pinning: verified

`playwright.sequence-readiness.config.ts` rejects anything but `http:` + `127.0.0.1` + `3557` before any server starts, and independently pins the ledger to `127.0.0.1:3558/ledger` including pathname. Node's `URL` normalizes the alternate IPv4 spellings (`127.1`, `2130706433`) to `127.0.0.1`, so there is no non-loopback bypass. The app guard does not constrain `pathname`/credentials the way the ledger guard does, but a path suffix only breaks the `${baseURL}/login` health probe — self-limiting, cosmetic, no change required.

### B2 — recovery backoff = 0: verified against the seeds

Every fixture that reaches a *successful* `resume_sequence_enrollment` or `retry_sequence_step` has a delay-0 current step:

- reliability: `native-definitive-failure`, `native-crash-after-claim`, `native-crash-after-acceptance`, `native-ambiguous-acceptance`, `native-claim-write-guard` — all `[{ delay: 0 }]`.
- scheduling: `quiet-hours-retained-claim`, `missing-template-recovery`, `missing-sender-recovery`, `provider-off-recovery` — all `[{ delay: 0 }]`.
- recovery-security: `seedSequence` only ever emits `delay_after_previous_minutes: 0`.

`resume` schedules `now() + make_interval(mins => 0)` and `retry` schedules `now()`, so `MAX_RECOVERY_BACKOFF_MINUTES = 0` is accurate, not merely asserted. The only nonzero-delay sequence (`native-three-step`, 0/10/10) never takes a recovery RPC path.

### B3 — timestamp-domain classification: no actual wrong clock

Audit confirmed against the complete files:

| Use | Anchor | Correct |
|---|---|---|
| stale aging (`created_at`/`attempt_started_at = DB_T0 − 16m`) | DB | ✓ |
| `next_run_at ≥ DB_T0` lower bounds after retry/resume | DB | ✓ |
| `retire_stale_sequence_claim(p_stale_before = testNow − 30m)` | DB | ✓ (equality against clamp is exact, deterministic) |
| tied-consent `occurred_at = testNow + 60s` | DB | ✓ |
| lifecycle `next_run_at === T0 + 10m`, `+9/+10/+20/+30` ticks | application | ✓ |
| `+10h` quiet deferral and its release instant | application, own state | ✓ |
| STOP `+5m` / `+15m` ticks | application | ✓ |

Every clock jump is covered: bare `setSystemTime` calls stay within the 30-minute horizon the selector verified at both endpoints; the two deliberate exits (`+10h`, `2026-11-01T14:00Z`) each select and verify their own state through production `checkQuietHours` (`chooseQuietState` checks both anchor and anchor+10h; 14:00Z is exactly 08:00 CST post-fall-back, and the test asserts `sent`); and `setApplicationTimeAfterPersistedDue` asserts the invariant in both files after a recovery jump. The endpoints-only argument in `clock.ts` is sound — shortest closed interval is 600 min on a spring-forward day, so a ≤60-min open pair cannot straddle one.

Two non-blocking domain-hygiene notes, neither of which is a wrong clock (no assertion can flip because of them):

1. `scheduling-reliability` fairness backlog seeds `attempt_started_at: T0.toISOString()` into a DB-audit column consumed by a DB staleness predicate. It works only because future-dating is trivially non-stale; `DB_T0` is the semantically correct anchor and is equally fresh. Optional cleanup.
2. `recovery-security` `pauseEnrollment` writes `next_run_at: testNow` (DB anchor) into an application-domain scheduling field. Inert — the row is paused, and retry/resume overwrite it.

One robustness note: `MAX_LIFECYCLE_ADVANCE_MINUTES = 30` has zero margin against the `T0 + 30m` tick, and bare `setSystemTime` calls carry no `checkQuietHours` assertion. A future `+40m` tick would silently leave the verified window. A small `advanceApplicationClock(minutes)` helper that asserts the invariant would close that, but it is not required for this fixture.

### B4 — nonzero offset: independently corroborated

At 2026-09-17 11:03 UTC every candidate state is closed: GU 21:03, PR 07:03, OH 07:03 (EDT), MO 06:03 (CDT), CA 04:03 (PDT), HI 01:03. First opening is PR/OH at 12:00 UTC (08:00 local), open again at 12:30 UTC, so the selector returned a ~56–57 minute offset with `state = PR` for the whole window. All 231 DB tests passing at that anchor is real evidence that the `DB_T0 ≠ T0` split is exercised end-to-end, not a degenerate zero-offset pass.

### Load-bearing invariant to preserve

`least(p_stale_before, now() − 15m)` in `retire_stale_sequence_claim` is what makes the ~57-minute (and, in the quiet test, ~11-hour) application-ahead-of-DB skew safe. Without it, the application-derived cutoff would retire fresh step-0 claims mid-lifecycle and pause the enrollment. Any future change to the stale predicate must keep the clamp, or these fixtures become clock-skew-dependent.
