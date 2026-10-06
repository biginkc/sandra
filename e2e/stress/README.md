# My Leads chaos-day stress harness

Opt-in tooling for the one-call-close stress test (plan: "My Leads one-call close: autonomous stress test, rev 2").
It runs once, at the very end, after every build PR is merged and migrated, executed by Codex.
It is NOT in any default lane: nothing here runs in `npm test`, the default Playwright config (`**/stress/**` is
ignored), or CI. It never runs against production and the live leg is disabled.

## Run it (Codex, at the end)

```
# 1. fresh local stack, loopback only, repo migrations only (never the dev stack ports)
node e2e/stress/provision-stack.mjs --workdir /tmp/sandra-stress-stack --api-port 55431 --db-port 55430
# 2. start the candidate app against it (see "App env"), with NODE_OPTIONS='--require "<abs path>/e2e/stress/egress-guard.cjs"' (the path MUST be quoted: this repo's path has a space)
# 3. egress ring 2 (required for the real run): e2e/stress/egress-pf.sh check, then sudo e2e/stress/egress-pf.sh apply <harness uid>; remove it with sudo e2e/stress/egress-pf.sh remove
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

**Required at T0 (the engine reads the app process's own environment and refuses otherwise):** the app is started with `NODE_OPTIONS='--require "<abs>/e2e/stress/egress-guard.cjs"'`, `STRESS_EGRESS_LOG=<abs path>` and the harness gets the same path as `STRESS_APP_EGRESS_LOG`; `DIALPAD_DIAL_PROVIDER=stub` (unset means the LIVE Dialpad API), `MESSAGING_PROVIDER=mock`, Dropbox Sign at the stub, a fixed `STRESS_STUB_PORT`. The engine finds the process listening on the app port, checks those variables, and requires a `guard_loaded` line from that pid in the app's egress log. Any non-probe denial in that log fails the run. A `PASS` also requires `STRESS_REQUIRE_OS_EGRESS=1` with the pf ring applied; without it the best result is `PARTIAL_PASS`. The live leg additionally requires a report that records both proofs and a passing self-test at the same sha (`STRESS_SELFTEST_REPORT`, written by `npm run stress -- selftest` to `<artifacts>/selftest-<sha12>.json`). `op read` is refused unless `OP_SERVICE_ACCOUNT_TOKEN` is set. Seeded phones are inside 555-0100..0199. Any outbound message from a provider other than the mock fails check 7.

App env for the app under test: `MESSAGING_PROVIDER=mock`, `DIALPAD_DIAL_PROVIDER=stub`, `DIALPAD_CTI_DIAL_KEY_E2E`, `E2E_AUTH_BYPASS=1`,
`NEXT_PUBLIC_HUGO_SSO=1`, `SKIP_INTENT_GATE=1`, same as `playwright.config.ts`'s webServer env, plus for the contract card: `DROPBOX_SIGN_API_BASE_URL=http://127.0.0.1:<STRESS_STUB_PORT>/dropbox-sign/v3`, `ESIGN_CREDENTIAL_ENCRYPTION_KEY=test-esign-encryption-key`, `DROPBOX_SIGN_CLIENT_ID=test-dropbox-sign-client-id`, `DROPBOX_SIGN_CALLBACK_SECRET_KEY`, `DROPBOX_SIGN_EMBEDDED_DOMAIN=localhost`. The harness is started with the same `STRESS_STUB_PORT` (a fixed port, since the app needs the stub's URL before it starts).

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
6. (Resolved by #823, now on main.) A second tab's fresh-key prompt save used to write a second note; the finalize is now single-shot per attempt and the second tab's save is refused. The harness no longer tolerates it.
7. Supersede is modelled with one contract (the projection exists before the stale offer, as in the integration test); the plan's "2 contracts by revision" needs a failed-send retry chain and is not modelled.
8. The Dialpad `initiate_call` stub on `main` is in-process (`DIALPAD_DIAL_PROVIDER=stub`), so the Next server's own dial cannot reach the harness stub server. The replay engine models the dial server action (guards, authorize, then a POST to the stub) and the browser lane drives the real Call button against the in-process stub with intent rows as the evidence. A base-URL seam for Dialpad would close this.
9. `kpi-snapshot.mjs` refuses any non-production database, so oracle 15 calls `fn_get_acquisition_kpis` directly and uses `kpi-rules.mjs` (every key classified; `EQUAL_IN_CLOSED_WINDOWS` keys equal to the schedule's totals).

## Status of the four closed gaps (2026-10-05) and what is still open

1. **Browser lane.** It runs and passes its 12 scheduled ticks locally against a real `next dev` stack (replay lane first, then the scripted specs, then rendered parity). Causes found and fixed:
   - The old first-tick timeout was waiting for the post-call prompt on `/my-leads`. A lead just called has left the "Call next" strip, and the queue only opens the prompt for a lead it has a row for. The runners now land on `/my-leads?lead=<id>` (the deep link pins the lead), which is how a rep reaches it.
   - Playwright's always-on trace with snapshots made every trace zip of a Next dev page take minutes at teardown, which the 90 s teardown budget reported as a timeout on a test that had passed. The config now records a light trace (actions, network, console; no snapshots).
   - The note composer is a collapsed `<details>`; the runner opens it before filling.
   - Stale post-call prompts from the replay lane (the queue opens the oldest of the newest 20, and does nothing when that one is outside the loaded rows) are dismissed as the rep before each browser tick.
   - Two-tab appointment edits now follow the replay scenario (stale edit refused, refreshed edit lands).
   The Playwright check in CI (`Playwright golden paths`) never ran on this PR before because the branch conflicted with `main`; it is green at the merged head. The stress specs are not in any CI lane (`**/stress/**` is ignored by the default config).
2. **Contract-send runner.** `offline_send` drives the REAL contract card (flag `contract_card`, Dropbox Sign test mode) on the call screen: offline click (no request leaves, 0 provider sends), back online on Slow-3G with the same send intent, then exactly one send on the stub and a logged offer. World seeding (`world.ts`): a test-mode e-sign connection with the repo's own integration-test constants, a finalized residential-v1 template, an `attom`-labelled fixture comp so the card can take a legal description (the comps flags stay off, no ATTOM call), and a seller e-mail in a reserved TLD. The stub now answers the real SDK shapes (send, list, get; `details_url` in the form the app validates). App env additions: `DROPBOX_SIGN_API_BASE_URL=http://127.0.0.1:<STRESS_STUB_PORT>/dropbox-sign/v3`, `ESIGN_CREDENTIAL_ENCRYPTION_KEY=test-esign-encryption-key`, `DROPBOX_SIGN_CLIENT_ID=test-dropbox-sign-client-id`, `DROPBOX_SIGN_CALLBACK_SECRET_KEY=<any>`, `DROPBOX_SIGN_EMBEDDED_DOMAIN=localhost`; set `STRESS_STUB_PORT` so the app and the harness agree on the stub's port. Contract-card observations for the product owner: with a `novation-v1` template the card hard-codes the seller phone to null (`contract-card-context.ts`), and that field is not overridable, so Send can never enable for that template; the harness therefore uses the residential-v1 field set.
3. **Live-leg UI driver.** `live-driver.ts` (pure orchestration over a port, unit-tested with a fake) and `browser/live-leg.spec.ts` (the port wired to the real Call button). DISABLED by default: skipped unless `STRESS_LIVE_LEG=1`, refused when `CI`, `GITHUB_ACTIONS`, `VERCEL` or `VERCEL_ENV` is set (also a failing prerequisite in `liveLegStatus`), and it throws unless every prerequisite passes (stubbed-leg PASS at this sha, human decisions, numbers through `op read`, tunnel and subscription proof, `STRESS_LIVE_WORLD_FILE`). It has never been run. The app has no cancel control once Dialpad has the dial, so `cancel_before_answer` is not dialled and is reported `not_driven` (never a pass); the double-dial pair is dialled back to back and the second must be refused.
4. **Egress.** The pf rules were wrong three ways: the anchor `com.apple.sandra-stress` is never evaluated (macOS evaluates `com.apple/*`), `set skip` is not legal in an anchor, and `block all` cut off the whole machine, including the agent running the harness. `egress-pf.conf` is now one uid-scoped rule set loaded by `egress-pf.sh check|apply|remove|status` (needs sudo to apply; `check` parses without root). The OS probe used TEST-NET, which is blackholed with or without a firewall (it could never fail), and ran inside the guarded process (the in-process guard threw first); it now dials a routable address from a guard-less child and treats only a silent timeout as denial. `NODE_OPTIONS=--require <path>` must quote the path (this repo's path contains a space; unquoted, Node exits at startup). The pf ring itself was parsed here but NOT applied (no sudo in this environment).

Debug aids (never a PASS): `STRESS_DEBUG_SKIP_REPLAY=1`, `STRESS_DEBUG_BROWSER_GREP=<pattern>`.

## Still open (read before the real run)

- Last local full run (with #823 merged; replay + 12 browser ticks + rendered parity, `next dev`, throwaway stack, no known findings tolerated): `PASS`, all 16 checks, every mandatory scenario executed, ~10 min.
- OS-level `pf` egress needs sudo and was not applied; `STRESS_REQUIRE_OS_EGRESS=1` proves the ring when it is.
- The lost-response `sms` instance is realized as a gated reload of the prompt save (the mock provider cannot be gated server-side).
- Supersede is modelled with one contract (finding 7).
- The autonomous Sendillo mode is deliberately not built.
- Local proofs ran against `next dev` on a throwaway stack (port 3466); a production build was not tested.
