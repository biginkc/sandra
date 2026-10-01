# Direct calling Phase 1: feasibility results

Status: **template, nothing run yet.** Fill from `scripts/direct-call-feasibility/.run/` output. Record Telnyx IDs, event names, hangup causes and timestamps only. No secrets, tokens, phone numbers or SIP passwords.

Run date: ____  Operator: ____  SDK version tested: @telnyx/webrtc 2.27.1 (also 2.27.10 where noted)
Decisions in force: D1, D2 ($25, 60 attempts, 30 s ring, 180 s leg, 30 s F7 deadline), D3, D4 (no recovery). See `DECISIONS.md`.

## 1. Preflight account snapshot (read-only)

| Resource type | Count | Snapshot file saved |
|---|---|---|
| phone numbers | | |
| credential connections | | |
| call control applications | | |
| outbound voice profiles | | |

Caller ID present on this account: ____ (if not, stop and ask Jarrad)

## 2. Resource inventory (created by this test)

| Type | Telnyx ID | Created at | Deleted at |
|---|---|---|---|
| credential connection | | | |
| call control application | | | |
| outbound voice profile (disabled, on connection) | | | |
| outbound voice profile (enabled, capped, on app) | | | |
| telephony credential (browser) | | | |
| telephony credential (escape target) | | | |
| legs found/created (add rows) | | | |
| recordings (add rows) | | | |

Profile read-back: enabled profile daily cap ____ , concurrent limit ____ ; disabled profile enabled=false ____ ; connection's profile id matches ____ ; app's profile id matches ____ .

## 3. Results

### F1 Server dials browser, then phone with link_to (pass: 5/5)

| Run | Browser leg ID | Phone leg ID | Answered | Two-way audio | Caller ID shown correct | Notes |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |

### F2 Disabled outbound profile: receive works, every escape rejected for the right reason

Documented provider duration bound read back before each probe (at or below 180 s): ____
(As of 2026-10-01 no documented provider-enforced duration field exists for browser-originated legs on a credential connection or outbound voice profile, so the harness's allowlist is empty and the probes are recorded "not executed - no documented provider duration bound". If so, F2 is NOT passed.)

| Probe | Valid request to known-working owned destination | Browser registered, spare capacity | Provider code / reason | Result (pass / fail / inconclusive) | Leg ended by (method) |
|---|---|---|---|---|---|
| Receive server-dialed leg | n/a | | | | |
| PSTN | | | | | |
| On-account SIP | | | | | |
| External SIP (dev-owned) | | | | | |
| Transfer | | | | | |

Any untested probe means F2 is NOT passed.

### F3 Browser identifies the exact leg before answering

| Run | Server leg ID | `call.telnyxIDs` seen before answer | `client_state` / headers seen | Equal? | Second unexpected leg distinguishable and rejected? |
|---|---|---|---|---|---|
| 1 | | | | | |

### F4 Stream, both_tracks, speaker mapping

| Run | Start-frame media format | Track names seen | Bytes per track | Seller track | Rep track | Repeatable? |
|---|---|---|---|---|---|---|
| 1 | | | | | | |

### F5 Dual-channel recording

| Run | Channel 0 party | Channel 1 party | `call.recording.saved` received | Fresh URL fetched by recording ID after first link expired | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |

### F6 DTMF and hangup

| Case | Reached test phone across bridge | Both legs ended | Webhooks match | Notes |
|---|---|---|---|---|
| Server `send_dtmf` | | | | |
| Browser SDK DTMF | | | | |
| Server hangup | | | | |

### F7 Browser leg ends, seller leg must end on its own (D4: no recovery; deadline 30 s)

| Fault | Fault injected at | Browser leg terminal at | Seller leg terminal at | Seconds to seller end | Seller hangup cause | Ended on its own (not cap, not cleanup)? | Pass |
|---|---|---|---|---|---|---|---|
| Clean hangup | | | | | | | |
| Killed tab | | | | | | | |
| Network cut | | | | | | | |

Record times for every case whether or not the deadline is met.

### R1 to R3

Skipped per D4 (no mid-call recovery in the first release). Intentionally not run.

## 4. Measure and record

Priority (evidence for D1):

| Measure | Value |
|---|---|
| Time from "call" to test phone ringing (per call, with stats) | |
| Time from "call" to two-way audio | |
| Dropped or failed attempts, total and reason | |

Other:

| Item | Observation |
|---|---|
| Delay from credential creation to successful registration | |
| Deleting a credential: drops live registration or call? | |
| Hold webhooks for SDK hold; what `hold()` returns on failure | |
| Repeated Dial with the same `command_id`: behaviour and duration | |
| Effect of app "hang up on webhook timeout" setting | |
| Voice API app needs outbound profile to dial on-net SIP username? | |
| Attestation | |
| What the rep hears while the seller rings | |
| Time to report browser leg ended: killed tab vs network cut | |
| SDK 2.27.10 vs 2.27.1 | |

## 5. Stop-condition log

| Time | Condition (call to non-D3 number / existing resource changed / spend cap / live Jitter or Dialpad affected / key exposed / other) | Action taken |
|---|---|---|
| | | |

Budget at end: attempts used ____ / 60 ; estimated spend ____ / $25 (estimate only; check Telnyx portal usage).

## 6. Teardown

| Step | Done at | Provider evidence |
|---|---|---|
| New attempts stopped | | |
| Active legs listed on test connection and app | | |
| Each leg's connection/app ID re-checked against inventory | | |
| Each leg hung up and confirmed terminal | | |
| Credentials deleted | | |
| Connection deleted | | |
| App deleted | | |
| Both profiles deleted | | |
| Recordings deleted | | |
| Tunnel closed | | |

Post-teardown diff against preflight snapshot (only pre-existing resources should remain): ____

API key untouched: ____
