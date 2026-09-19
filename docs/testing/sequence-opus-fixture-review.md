# Opus 5 browser and clock fixture review

Candidate: `5038da7899e188f5d9d02e1564b3c08abe8c3858`. Session: `d31c059c-ae63-4c3c-a75e-513a2a9cf23a`. Model usage verifies `claude-opus-5`. This was a bounded diff-only review; several objections request unchanged source context. It is not final readiness approval.

## Verdict: **CHANGES REQUIRED**

Scope note honored: this reviews only the test/harness delta at `5038da78`. Runtime code is unchanged, so nothing here can regress production behavior; my objections are about whether these tests *prove* what they claim. I am **not** asserting readiness — full CI is pending, both browser cases are unverified, and no mutation runs exist. Several findings below are specifically about evidence that does not yet exist.

---

## Blockers

### B1 — `baseURL` is not in the diff, and the hostname bind can strand the webServer
`playwright.sequence-readiness.config.ts`: `command: "npx next dev --webpack --hostname 127.0.0.1 -p 3557"` with `url: \`${baseURL}/login\``.

Binding explicitly to `127.0.0.1` makes the server **IPv4-only**. If `baseURL` is `http://localhost:3557`, then on any host where `localhost` resolves to `::1` first, webServer readiness polling fails and every test errors before it runs — and separately, navigating to `localhost:3557` sends `Host: localhost:3557`, which is exactly the class of mismatch the Next origin check rejects (the stated 403 you were chasing). The diff shows `isLoopbackHttpUrl` accepting a set of loopback forms, which suggests the harness is *tolerant* of both spellings elsewhere; that tolerance is now load-bearing and unverified.

Evidence required: the `baseURL` declaration from the unchanged portion of that config. If it is not the literal `http://127.0.0.1:3557`, change it, and state whether `--hostname 127.0.0.1` or `allowedDevOrigins` is the mechanism actually preventing the 403 (the commit message credits the hostname flag; these are different fixes).

### B2 — The 30-minute horizon does not cover the largest clock jump the suites perform
`tests/sequence-readiness/clock.ts` guarantees quiet-hours-open at `applicationNow` and `applicationNow + horizonMinutes` only. Callers advance the clock two ways:

- `recovery-security.integration.test.ts`: `applicationNow + 5min`, `+15min` — inside 30. ✓
- `reliability.integration.test.ts` / `scheduling-reliability.integration.test.ts`: `setApplicationTimeAfterPersistedDue(nextRunAt)` sets the clock to `max(Date.now(), new Date(nextRunAt) + 1)`.

`next_run_at` is computed by the recovery RPC from **database `now()`**, i.e. ≈ `DB_T0` — the new code comments say so explicitly. So the jump lands at `DB_T0 + backoff`, and the distance past the guaranteed window is `backoff − offset`. Because six widely-spread timezones are candidates, `offset` is **0** for the overwhelming majority of runs. Therefore any retry backoff greater than ~30 minutes silently escapes the window the selector promised, and the failure mode is a quiet-hours refusal inside `expect(repaired...)` — a confusing, time-of-day-dependent red with no diagnostic pointing at the clock.

`MAX_SAFE_HORIZON_MINUTES = 60` also means a backoff >60min **cannot be expressed** — `selectSafeApplicationClock` would throw rather than accommodate it.

Concrete fix (an added assertion, not a relaxation): inside `setApplicationTimeAfterPersistedDue`, after computing `applicationDue`, assert the invariant the selector claims —

```ts
const check = checkQuietHours(safeTestState, applicationDue);
expect(check.ok, `clock jump to ${applicationDue.toISOString()} left the send window`).toBe(true);
```

This converts an implicit dependency into a self-describing failure and is the only way to *detect* horizon underestimation rather than assume it. Please also state the actual max backoff constant these paths use, and derive `horizonMinutes` from it rather than hardcoding `30`.

### B3 — `T0` changed meaning; only three references were audited in the diff
This is the highest-risk aspect of the change. `T0` used to be the database anchor; it is now the application anchor and may be up to 24h later. The diff corrects five references (three `next_run_at` lower bounds, two `staleAt` computations) — all correctly, see V1/V2 below — but I cannot see the rest of the files.

Specifically unverifiable from this diff:
- **`chooseQuietState(anchor)`** in `scheduling-reliability.integration.test.ts` survives unchanged, still using hand-rolled hour arithmetic and a "+10 hours must reach the open window" heuristic. Its call sites are not in the diff. If it is passed `DB_T0` it is now inconsistent with the clock the tick actually reads; if passed `T0`, the +10h heuristic must still hold from the *advanced* anchor. Note the asymmetry this creates: the send-window fixture is now validated against production `checkQuietHours`, the quiet fixture is not.
- **`testNow`** in `recovery-security.integration.test.ts` is still assigned from `anchor.created_at` and retained alongside the new `applicationNow`. Two of its uses were migrated; any remaining use (seed helpers writing timestamps, other `setSystemTime` calls) is now ambiguous.

Evidence required: `rg -n '\bT0\b|\btestNow\b|chooseQuietState' src/lib/sequences/*.integration.test.ts` output, with each hit classified DB-clock or application-clock. Two variables that differ by up to 24 hours and are distinguished only by name are a standing trap for the next editor.

### B4 — The `offset > 0` branch is reachable in production CI and has never been exercised
"Selector 96 hourly/seasonal cases and all minute increments passed" validates the selector *in isolation*. It does not exercise the three integration suites under a nonzero offset, and the suites are where the DB-vs-application skew actually bites.

The offset>0 path is not hypothetical. Take standard time: PR (UTC−4) is open UTC 12:00–01:00; HI (UTC−10) is open UTC 18:00–07:00; their union leaves a gap at UTC 07:00–12:00. Guam (UTC+10) covers UTC 07:00–11:00 (local 17:00–21:00). At **UTC 11:00–12:00** all six candidates are quiet — Guam 21:xx, PR 07:xx, ET 06:xx, CT 05:xx, PT 03:xx, HI 01:xx. So roughly a one-hour band of UTC each day forces `offset > 0`, i.e. ~4% of CI runs take a code path with zero end-to-end evidence, on which B2's `backoff − offset` arithmetic and the selector's central claim ("SQL stale-claim predicates clamp future application times to database `now()`") both depend.

That clamping claim is asserted in the docstring and nowhere demonstrated. Either cite the SQL that performs the clamp, or — cheaper and stronger — add a test-only override to force `dbAnchor` into the all-quiet band and run the three suites once at a nonzero offset. Until one of those exists, the forward-advance capability this patch introduces is unproven.

---

## Should-fix

### S1 — Two divergent implementations of one named helper
`reliability.integration.test.ts`: `Math.max(Date.now(), persistedDue)`.
`scheduling-reliability.integration.test.ts`: `Math.max(DB_T0.getTime(), Date.now(), persistedDue)`.

Same name, same stated rationale, different bodies. The `DB_T0` term is redundant given `Date.now() ≥ T0 ≥ DB_T0`, but a reader cannot tell whether the difference is deliberate. Move it into `tests/sequence-readiness/clock.ts` next to the selector, with the B2 assertion built in.

### S2 — Diagnostics cannot capture the failure they were built for
`installBrowserDiagnostics` filters responses with `if (request.resourceType() !== "script" || response.status() < 400) return;`.

The motivating defect is an **HMR 403**. HMR is a WebSocket plus `fetch`/`eventsource` traffic — never `resourceType() === "script"`. As written, the one failure mode named in the commit rationale is invisible to the diagnostics. Also missed: `document` 5xx, and RSC payload fetches. Drop the resourceType filter; keep loopback + `status >= 400` + the 50-item cap.

### S3 — `attachBrowserDiagnostics` can lose the diagnostics on the most likely failure
The most probable new failure is the hydration `waitForFunction` timing out. In that state, the `page.evaluate` in the `afterEach` has no bounded timeout. `try/catch` covers rejection (closed page) but not a hang on a page that is navigating or blocked by the egress guard's route interception — the hook stalls to its own timeout and the JSON is never written. Wrap the evaluate in a `Promise.race` against a ~5s timer (or short-circuit on `page.isClosed()`) and fall through to the existing `"unavailable"` shape.

### S4 — The 10s hydration cap is likely to fire on a cold dev server
`waitForSequenceFormHydration` uses `{ timeout: 10_000 }`, and the accompanying comment claims `test.setTimeout(120_000)` lets "the cold Webpack dev server compile them without changing the bounded 10-second readiness assertions." Those two do not compose: raising the outer test budget does nothing when the inner cap is the binding constraint. The config's own `webServer.timeout: 120_000` is evidence the team already expects slow cold starts, and on a first hit Webpack must compile the route's client chunks *after* `goto` resolves.

Keep it bounded — that principle is right and the removal of the old retry hack is an improvement — but either warm `/sequences/new` once in a `beforeAll`/global setup before the timing-sensitive assertion, or give the first navigation a distinct, larger constant. A 10s cap that only passes on a warm cache is a flaky harness, not a bounded assertion.

### S5 — `__reactProps` presence is a weaker signal than the reproduction's own observable
React attaches `__reactProps$*` during the hydration **commit** for that host node; passive effects (`useEffect`) run afterward. Base UI `Field`/`Form` primitives commonly register control state in effects. So the predicate can return `true` before the field is fully wired — a false-positive direction.

Your isolated reproduction already found a cleaner observable: Create **disabled before hydration, enabled after**. If that transition is hydration-driven rather than validation-gated on a non-empty name, `await expect(createButton).toBeEnabled()` before filling is a stronger, framework-version-independent gate than probing React internals. I cannot tell which it is from this diff — the component source is not included. Please state which, and prefer the button gate if it holds.

Relatedly: `waitForSequenceFormHydration` and `attachBrowserDiagnostics` inline the *same* input-finding predicate twice (exact label match `=== "Name"`, which a required-marker `<span>` in the label would break, falling through to the placeholder). The `page.evaluate` boundary forces some duplication, but export one source and reuse it so the two cannot drift.

### S6 — `T0 → DB_T0` is correct but leaves the assertion very weak
`expect(new Date(next_run_at).getTime()).toBeGreaterThanOrEqual(DB_T0.getTime())` now only proves the retry was not scheduled before the test began. The property worth asserting — the retry is scheduled *after the failed attempt* — is available without mocks: bound against the step run's `attempt_started_at`, or capture a second DB `now()` immediately before the recovery call. Worth restoring since the (necessary) bound change gave it up.

---

## Verified — not weakening

- **V1 — `T0 → DB_T0` on the three `next_run_at` bounds is a correctness fix, not a relaxation.** `next_run_at` is RPC-computed from database `now()` and is never derived from the application clock. Bounding it against an application clock advanced up to 24h would have been a guaranteed false negative. The bound is strictly weaker in the ordering sense but is now *true for the right reason*. (See S6 for restoring strength properly.)
- **V2 — `T0 → DB_T0` on the two `staleAt` computations fixes a latent false pass.** `new Date(T0 - 16min)` against an advanced `T0` could land *after* database `now()`, making a deliberately aged claim look fresh and letting the "must never blind-retry" assertions pass vacuously. Correcting to `DB_T0` restores the intended aging. This is the most valuable fix in the patch.
- **V3 — No quiet-hours mocking and no production weakening.** `clock.ts` imports and *calls* the production `checkQuietHours`; the fixture adapts to production logic rather than the reverse. No stub, no injected override, no relaxed predicate. This is the right direction.
- **V4 — Endpoint-only quiet-hours checking is sound at this horizon.** The minimum closed interval is 21:00→08:00 = 660 min; spring-forward shortens it to 600, fall-back lengthens it to 720. All exceed `MAX_SAFE_HORIZON_MINUTES = 60`, so a horizon that fits cannot bridge a closed period undetected. The reasoning in the user-supplied rationale checks out — but it holds *only* while every candidate state shares that window shape and the 60-minute cap is enforced. Both facts deserve a comment in `clock.ts`, since B2's fix depends on them.
- **V5 — Forward clock advance cannot retire a fresh claim.** Stale-claim predicates run on DB timestamps, which fake timers (`toFake: ["Date"]`) do not touch. Advancing the application clock is inert with respect to staleness. The converse risk — application-written `next_run_at` landing far beyond a SQL-side due filter — is the unproven half; see B4.
- **V6 — Removing the double-`fill()` eliminates a blind retry.** The deleted "re-apply the value and assert React retained it" hack was itself the anti-pattern the review brief warns about. Replacing it with a readiness gate plus real keyboard events is the correct shape, and the value/enabled assertions plus the unchanged DB read-back persistence assertions are all retained. No weakening in this file.
- **V7 — Redaction ordering is correct.** Token patterns run before URL collapsing, and `diagnosticUrl` reduces to `origin + pathname`, discarding query strings entirely — so query-embedded credentials are dropped structurally rather than by pattern luck. Supabase anon/service JWTs are caught by the `eyJ` rule.

---

## Optional polish (explicitly not blockers)

- `process.stderr.write` echoes the full JSON in addition to the attachment: 4 buckets × 50 items × 2,000 chars ≈ 400KB of CI log per failure. Attach only, or truncate the stderr copy.
- `diagnosticText` is not applied to `diagnostics.dom` values (`propertyValue`, `attributeValue`, `location.*` are raw, `.slice(0, 200)` only). Low risk — loopback origins and a generated sequence name — but inconsistent with the rest.
- Newer Supabase secret keys (`sb_secret_…`) match no pattern unless preceded by a key name. One-line addition if you want belt-and-braces.
- Requests aborted by `installBrowserEgressGuard` will appear as `failedRequests` entries. Expected noise that reads as a network fault to whoever debugs the attachment — label or exclude guard-aborted URLs.
- `pressSequentially` does not clear existing content; the exact `toHaveValue` assertions would catch an append, so this is cosmetic.
- The new comment attributes the failure to "`fill()` leaving the DOM value present while the controlled name state stayed empty." Given `fill()` does dispatch an `input` event, the likelier cause is the pre-hydration race the new gate now closes — meaning the keyboard change is defense in depth, not the fix. Keep both, but state the actual root cause from the isolated reproduction, since this comment replaces an earlier one telling a different story and neither is evidenced in-tree.
- `test.setTimeout(120_000)` duplicated in two tests; a project-level `timeout` or `test.slow()` makes the allowance visible in config rather than buried mid-test.
- `selectSafeApplicationClock` allows `horizonMinutes = 0` (degenerate, harmless).

---

## What would move this to approval

B1–B4 resolved, with: the `baseURL` declaration; the B2 invariant assertion in place and a stated max-backoff justifying the horizon; the `T0`/`testNow`/`chooseQuietState` audit output; and one integration run forced through `offset > 0`. S2–S4 should land before you rely on these cases in CI, since a green run that depended on a warm cache or lost its diagnostics tells you very little. Even with all of that, the browser cases remain unverified and mutation testing unexecuted — approval of this patch would mean the delta is sound to run, not that the suite has demonstrated the behavior it targets.
