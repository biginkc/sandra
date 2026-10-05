# My Leads chaos-day stress harness

Opt-in tooling for the one-call-close stress test (plan: "My Leads one-call close: autonomous stress test, rev 2").
It runs once, at the very end, after every build PR is merged and migrated, executed by Codex.
It is NOT in any default lane: nothing here runs in `npm test`, the default Playwright config (`**/stress/**` is
ignored), or CI. It never runs against production and the live leg is disabled.

## Run it (Codex, at the end)

```
# 1. fresh local stack, loopback only, repo migrations only (never the dev stack ports)
node e2e/stress/provision-stack.mjs --workdir /tmp/sandra-stress-stack --api-port 55431 --db-port 55430
# 2. start the candidate app against it (see "App env"), with NODE_OPTIONS=--require e2e/stress/egress-guard.cjs
# 3. egress ring 2 (optional but required for the real run): sudo pfctl -a com.apple.sandra-stress -f e2e/stress/egress-pf.conf
# 4. self-test, then the day
STRESS_HARNESS=1 ... npm run stress -- selftest
STRESS_HARNESS=1 STRESS_SCOPE=full STRESS_ROOT_BROWSER_CONTEXT=1 STRESS_REQUIRE_OS_EGRESS=1 ... npm run stress -- run
```

Environment (all loopback): `E2E_DISPOSABLE_DATABASE=1`, `E2E_CI_SUPABASE_DB_URL`, `STRESS_SUPABASE_URL` (or `TEST_SUPABASE_URL`),
`TEST_SUPABASE_ANON_KEY`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `STRESS_REP_EMAIL` / `STRESS_REP_PASSWORD` (the rep `provision-stack.mjs` creates; values are in its `stress-env.json`), `STRESS_APP_URL`, `E2E_CRON_SECRET` (= the app's `CRON_SECRET`),
`DIALPAD_CTI_WEBHOOK_SECRET_E2E` (= the app's), `STRESS_APP_LOG` (the app's stdout file; scanned for 5xx and unhandled rejections),
`E2E_QUIET_HOURS_NOW` (set on the app; recorded), `CHAOS_SEED` (default 20261005), `STRESS_SHA` (default `git rev-parse HEAD`).
`npm run stress -- plan` writes `schedule.ndjson` with no connection of any kind. `npm run stress -- kill` drops a KILL file.
Unit tests: `npm run test:stress-unit`.

App env for the app under test: `MESSAGING_PROVIDER=mock`, `DIALPAD_DIAL_PROVIDER=stub`, `DIALPAD_CTI_DIAL_KEY_E2E`, `E2E_AUTH_BYPASS=1`,
`NEXT_PUBLIC_HUGO_SSO=1`, `SKIP_INTENT_GATE=1`, `DROPBOX_SIGN_API_BASE_URL=<stub url>/dropbox-sign`, same as `playwright.config.ts`'s webServer env.

## What it is

| File | Role |
|---|---|
| `manifest.ts`, `prng.ts` | `CHAOS_SEED` to one PRNG to `schedule.ndjson`: 59 calls in the plan's counts (+ background noise), each with an `expected` column. Byte-identical for the same seed. |
| `scenarios.ts`, `actions.ts`, `contract.ts` | Replay engine: signed Dialpad webhooks (duplicate x2-3, reorder, late, delay) to the real app, concurrent RPCs, cron routes by HTTP with `CRON_SECRET`, and the app's own dial guards modelled (4/min, 20 s in flight, per-lead unresolved) so the harness paces like a rep. |
| `gates.ts`, `stubs.ts`, `proxy.ts` | Request gates `received` / `provider_accepted` / `response_sent` (no sleeps), provider stubs (Dialpad, Dropbox Sign) with request logs and probes, and a loopback gate proxy in front of the app for the browser. Real order goes to `ordering.jsonl`. |
| `oracle.ts` | 10 safety invariants (checked every 30 s and at the end) and 6 expected outcomes (after a bounded drain), as SQL plus assertions against the schedule and stub logs. Planned totals must equal observed totals. |
| `selftest.ts`, `engine.ts` | Self-test: control + three fault injections (duplicate a send, drop an offer, attach a note to the wrong lead); each fault must turn the run red at its intended check. |
| `guards.ts` | Lane guards before ANY connection: opt-in, #804's `assertLaneSafe('ci')` (`E2E_DISPOSABLE_DATABASE`), loopback for every binding, hosted-ref scan, cron target = app, no live flag. T0 then proves the four bindings and probes each stub. |
| `egress-guard.cjs`, `egress.ts`, `egress-pf.conf` | Egress denial, fail closed: in-process guard preloaded into every process (and a browser route that aborts non-loopback requests) plus the pf ring; a denial must be SEEN at T0 or the run is refused. Any violation fails the run. |
| `kill-switch.ts` | On any miss: 1 close provider gates, 2 all 13 flags false, 3 cancel run-owned in-flight intents, 4 snapshot evidence, 5 only then clean up. The report lists what cannot be recalled. |
| `levers.ts` | Per-decision time levers, each demonstrated before the chaos sequence (no universal clock). |
| `browser/` + `/playwright.stress.config.ts` | Scripted Playwright specs (no improvising): double-click, two tabs, back/forward, setOffline, Slow-3G, gated reload; rendered-parity after the drain. Run in root's desktop context. |
| `live-leg.ts`, `browser/live-leg.spec.ts` | Live leg: written, DISABLED, refuses unless every prerequisite is met. |

Verdicts: `PASS` only for profile=full, scope=full, no fault, every check green, every mandatory scenario executed. A reduced run is `PARTIAL_PASS` (exit 3 unless `STRESS_ALLOW_PARTIAL=1`);
anything red, skipped, errored, egress-hit or 5xx is `FAIL`. Artifacts: `artifacts/chaos-<seed>-<sha>/` with `REPORT.md`, `schedule.ndjson`, `executed.ndjson`, `ordering.jsonl`,
`stub.ndjson`, `invariants.jsonl`, `invariants.final.json`, `test-org-dump.json`, `egress.jsonl`, `kill-switch.json`, Playwright traces.

## Decision switches (the plan's "Decisions needed"; none decided here, all default to the safe/off choice)

| Owner | Decision | Switch | Default |
|---|---|---|---|
| Jarrad | Approve the test SMS string `SANDRA TEST <run-id> <n> ignore` (spot check only) | `STRESS_TEST_SMS_STRING_APPROVED` | off |
| Jarrad | Sendillo live leg: human-confirmed spot check or autonomous tagged rows | `STRESS_SENDILLO_MODE` | `spot_check_human` (autonomous mode is not built) |
| Jarrad | Present (passive) for the Dialpad live leg, or defer to the attended ring test | `STRESS_DIALPAD_LIVE_JARRAD_PRESENT` | off (deferred) |
| Root | Browser-capable execution context (Codex desktop) provided | `STRESS_ROOT_BROWSER_CONTEXT` | off (full scope refuses) |
| Root | Candidate checkout carries #804 (merged or layered) | `STRESS_ROOT_CANDIDATE_HAS_LANE_GUARD` | off (recorded; the code imports `assertLaneSafe`, so a checkout without it fails to load) |
| Root | Production Dialpad connection has no active subscription for Jarrad's user | `STRESS_ROOT_PROD_DIALPAD_NO_SUBSCRIPTION` | off (live Dialpad leg BLOCKED) |
| Jarrad | The five pending rules (offersSent with supersede, owner-mismatch, reassign target, motivation-required, earnest money) | none: reported under "Pending Jarrad", never asserted, never in PASS | n/a |

## Live leg (disabled)

`npm run stress -- live-check` lists every unmet prerequisite and never dials. All of these must hold: `STRESS_LIVE_LEG=1`; a full-scope, full-profile, no-fault PASS report for THIS sha;
the three decisions above plus root's browser context and prod-Dialpad confirmation; Jarrad's desktop app running; an isolated loopback instance with a disposable DB and an https tunnel as the only
non-loopback endpoint; a subscription proof for that tunnel; both owned numbers resolving through `op read` (refs only in env, never values, never persisted); an artifacts dir for the kill switch.
`live-leg.ts` contains no provider call: calls leave only through the real app UI. Telnyx is a ring target, not a provider. Sendillo is a human step: the module prints the one approved string and the read-only check.

## Findings and deviations from the plan (found while proving the harness locally)

1. `fn_fail_stale_dialpad_intents(p_cutoff_seconds := 0)` (plan, time levers) raises `INVALID_INPUT`; the deployed function requires 30..900. The lever is: backdate `dispatch_authorized_at`, then sweep with 30.
2. The fixture's `expireStripOverride` (e2e/support/my-leads-close-fixture.ts) violates `my_leads_strip_overrides_one_kind_check` (`least()` ignores NULL). `levers.ts` carries a corrected copy; the fixture is untouched.
3. The plan's "call_activities grouped by `dialpad_call_id`" is `provider_call_id` in the schema; the invariant uses that.
4. A seller reminder to a seller with no prior SMS thread is skipped as `opening_identity_required` (the approved copy says "Jarrad with BMH Group", the rule wants "Mel with BMH"). The harness seeds a seller reply first so the reminder path is exercised, and reports the skipped count.
5. Dial guards (rate 4/min, 20 s in flight, per-lead unresolved) live in TypeScript and are non-atomic by design ("accepted race"); a real day therefore paces itself (a few minutes for the replay leg; the plan's 60-90 min is dominated by the live drain).
6. Second-tab prompt save (fresh keys) is accepted by the finalize function and writes a second note: the plan expects one. Reported as the known finding `second_tab_duplicate_note`; it is a FAILURE by default and is tolerated only when `STRESS_KNOWN_FINDINGS=second_tab_duplicate_note` is set (the self-test sets it so its control run can be clean).
7. Supersede is modelled with one contract (the projection exists before the stale offer, as in the integration test); the plan's "2 contracts by revision" needs a failed-send retry chain and is not modelled.
8. The Dialpad `initiate_call` stub on `main` is in-process (`DIALPAD_DIAL_PROVIDER=stub`), so the Next server's own dial cannot reach the harness stub server. The replay engine models the dial server action (guards, authorize, then a POST to the stub) and the browser lane drives the real Call button against the in-process stub with intent rows as the evidence. A base-URL seam for Dialpad would close this.
9. `kpi-snapshot.mjs` refuses any non-production database, so oracle 15 calls `fn_get_acquisition_kpis` directly and uses `kpi-rules.mjs` (every key classified; `EQUAL_IN_CLOSED_WINDOWS` keys equal to the schedule's totals).

## Not built / not verified here (read before the real run)

- **The browser lane is NOT proven green.** Proven locally on this Mac: the engine spawns Playwright with Chromium through the gate proxy, signs the rep in with SSR cookies,
  blocks non-loopback browser requests, the Call button creates an authorized intent, and (in a standalone probe) saving the queue's post-call prompt finalizes the webhook attempt.
  The serial spec set did not complete: the first tick (`second_tab_retry`) timed out waiting for the post-call prompt for that lead on the queue page after the Call click; the cause
  was not found (suspects: prompt timing/identity on the queue page). Until that is fixed, a full-scope run ends FAIL ("browser lane executed 0/N scheduled ticks"), never PASS, and
  oracle 16 (rendered parity) is unverified. Selectors used: `call-button-<id>`, `post-call-*`, `lead-add-note-composer`, `lead-next-action`, `send-contract-card`.
- The contract-send browser runner (`offline_send`) and the Slow-3G/offline gestures need the e-sign provider fully configured in the candidate app (template, credentials, Dropbox base URL to the stub); written against the real test ids, not exercised.
- The lost-response `sms` instance is realized as a gated reload of the prompt save (the mock provider cannot be gated server-side).
- The live leg has gating, the call plan, owned-number resolution and the evidence classifier; the per-call UI driver in `browser/live-leg.spec.ts` is deliberately NOT built (it throws after the prerequisites pass).
- OS-level `pf` egress needs sudo and was not applied; the in-process guard and the browser route guard are proven, and `STRESS_REQUIRE_OS_EGRESS=1` proves the pf ring when it is applied.
- The autonomous Sendillo mode (accepting tagged production `webhook_events` rows) is deliberately not built.
- Local proofs ran against `next dev` on a throwaway stack (port 3466); a production build was not tested.
