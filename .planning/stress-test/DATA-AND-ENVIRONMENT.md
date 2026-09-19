# My Leads data and environment stress matrix

Research baseline: `65c58eb0` (2026-09-12). All cases below are **PLANNED**, not passed. Historical tests inform coverage but are not evidence for this campaign. UI execution belongs in the in-app browser; direct database/API operations may prepare synthetic states or corroborate outcomes, but must not be described as browser passes.

## Environment contract

- Worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-my-leads-stress-20260912`.
- Dedicated Colima profile `sandra-my-leads-20260911`; explicitly select `DOCKER_HOST=unix:///Users/jarradhenry/.colima/sandra-my-leads-20260911/docker.sock` for every Docker/Supabase action. Preserve all other profiles and worktrees.
- Supabase workdir `/tmp/sandra-my-leads-acceptance-20260911`, project ID `sandra-my-leads-acceptance-20260911`, API `http://127.0.0.1:58321`, PostgreSQL port58322/version17. App `http://127.0.0.1:58700`.
- Four principals only, reused from the original secret-free identity manifest: owner A `10000000-0000-4000-8000-000000000002`, rep A `10000000-0000-4000-8000-000000000003`, member B `10000000-0000-4000-8000-000000000013`, owner B `10000000-0000-4000-8000-000000000014`. Organization A must use native Sandra organization `00000000-0000-0000-0000-000000000bbb`; B is `10000000-0000-4000-8000-000000000012`.
- Protected local identities/runtime files remain mode0600 outside repository. No credentials in screenshots, reports or tool output. Use only local Supabase environment values; no imported private environment files/provider credentials. Verify Next will not automatically load a copied `.env.local`.
- Leave `NEXT_PUBLIC_HUGO_SSO` unset for native password fixture login with real membership/domain checks; do not set `E2E_AUTH_BYPASS`. This does not prove production Hugo OAuth parity.
- Rebuild uses `scripts/verify-my-leads-full-schema.mjs --reset-owned-local`: guards owned containers, hosted-link absence and known data before resetting only this local stack. It replays216 baseline+13acquisition migrations, prepares four users and nine leads. The later omitted historical alias migration `20260909150529_skip_trace_submission_claim_history.sql` contains only `SELECT 1`, no schema change.
- No broad E2E/global setup or shared fixture reset. Additional synthetic properties use the guarded `20000000-0000-4000-8000-` namespace and addresses ending `Fixture Lane`; keep an explicit ledger of IDs, initial states, expected changes and cleanup ownership.
- No live calls, texts, emails, eSign sends or real customer contact. Local signed receiver simulation can exercise persistence and replay, but cannot prove live provider transport.
- Stop/remove only this owned stack and temporary credentials after retaining secret-free results. Original cleanup receipt showed database volumes and principals removed; never assume a previously stopped runtime retains usable fixtures.

## Evidence and fixture discipline

For each case record fixture IDs, role, exact starting facts, browser actions, expected UI, observed UI, persisted result after reload, unexpected writes, screenshot/log references and final status. Use PASS/FAIL/BLOCKED only after execution; a prepared fixture alone is not a pass. Critical mutations require both visible result and persisted evidence. Keep separate leads for incompatible lifecycle branches. For boundary cases set server-side synthetic timestamps relative to a recorded server instant; do not treat a client-authored clock as authoritative.

Browser-only tests cannot prove direct-RPC authorization or exact transaction idempotency without corroboration. Pair those cases with authenticated API/SQL assertions and label both evidence channels. Do not invent successful network-failure simulation if the supported browser tool cannot supply it.

## Timers and warnings

| ID | Planned action/state | Expected result |
|---|---|---|
| T01 | Eligible new assignment before/at/after30 Central working minutes | Warning boundary and displayed clock agree with server snapshot; no early or late transition. |
| T02 | Assign before09:00 and after17:00 Central | Only configured working window accrues; next working opening is respected. |
| T03 | Friday late-day assignment through Monday | Weekend excluded; remaining working minutes carry correctly. |
| T04 | Spring-forward and fall-back date fixtures | UTC storage and Central display agree; no one-hour deadline drift. |
| T05 | Fractional-minute, exact opening/closing, equal timestamps | Fractional accuracy; zero interval; no negative elapsed duration. |
| T06 | Unknown launch assignment and ineligible assignment | Honest unknown/ineligible display; no fabricated assignment or first-call KPI inclusion. |
| T07 | Log manual outreach while first-call clock outstanding | Contacted milestone allowed; actual first-call clock remains unstopped. |
| T08 | Open/cancel call UI; then separately inject authenticated local seller-start evidence | Open/cancel changes no clock/attempt; actual evidence stops correct episode clock once. |
| T09 | Needs offer at12elapsed hours ± boundary, including weekend | Uses elapsed hours, not working hours; red warning at authoritative boundary. |
| T10 | Offer follow-up before/at/after server instant | Correct warning transition; no invented follow-up task. |
| T11 | Contacted without next step; add future callback/appointment; let it expire | Immediate warning, deliberate scheduling clears it, expiration restores it. |
| T12 | Cancel/complete/reschedule a next step | Only valid future canonical task suppresses missing-next-step warning. |
| T13 | Same lead has both first-call and stage warning | Both reasons retained, stale count deduplicates lead. |
| T14 | Move warning lead Under Contract, terminal or archived | No actionable outreach warnings accumulate; historical evidence remains honest. |
| T15 | Foreground boundary, hidden tab, refocus | Read-only refresh updates warning at intended cadence, pauses hidden and refreshes on focus. |

## KPI correctness

| ID | Planned action/state | Expected result |
|---|---|---|
| K01 | Seed hand-calculated facts for all six tiles | UI matches independently calculated raw facts and sample denominators. |
| K02 | No samples, unknown attribution, pending call outcomes | Zero/unavailable/pending remain distinguishable; no fabricated zero average. |
| K03 | Owner selects rep; rep opens self using same range | All six values and denominator explanations match. |
| K04 | Search several lead subsets and empty result | Queue filtering changes rows/count labels, not rep-wide KPI totals. |
| K05 | Every preset and custom inclusive Central date range | Half-open UTC boundaries; Monday week start; correct DST endpoints. |
| K06 | Facts exactly at start/end and UTC/Central midnight mismatch | Start included, end excluded; Central calendar ownership correct. |
| K07 | Stale lead count across all reporting ranges | Count remains current and period independent; multiple warning reasons count once. |
| K08 | Perform attempt/offer, then reassign/handoff | Original performer retains credit; new assignee receives no fabricated history. |
| K09 | Owner performs action while inspecting rep | Owner performer credited, inspection alone writes nothing. |
| K10 | Booking assignee differs from booker/current property assignee | Appointment accountability stays with booking-time assignee. |
| K11 | Appointment held/cancelled/rescheduled/replaced | Correct known-attribution denominator/numerator; no mutation-ledger double count. |
| K12 | First call spans off-hours/weekend | KPI elapsed seconds differs correctly from warning working minutes. |
| K13 | Toggle designation after historic activity | Historic KPI evidence preserved; no retrospective clock eligibility rewrite. |

## Authorization and lifecycle

| ID | Planned action/state | Expected result |
|---|---|---|
| A01 | Rep UI and authenticated request attempt other-member selection | Self scope only; owner controls absent; backend denies unauthorized selection. |
| A02 | Owner inspect active and former-designated rep | Authorized history accessible; disabled designation label clear. |
| A03 | Foreign owner/member request orgA queue/details/mutations | Denied without data leakage or writes. |
| A04 | Revoke membership while tab/modal open | Subsequent reads/writes fail closed; stale UI cannot authorize mutation. |
| A05 | Disable feature while page open | Operations reject appropriately without deleting history. |
| A06 | Toggle designation; then assign new lead; re-enable | Existing eligible episode preserved; new ineligible episode not retroactively timed. |
| A07 | Apply DNC while action modal open | Canonical DNC protection honored at submission; no unintended mutation. |
| A08 | Reassign lead while old assignee modal open | Stale assignment rejected; refresh reveals current authorized state. |
| A09 | Handoff recipient removed/disabled after modal opens | Recipient unavailable fails atomically; original ownership/state preserved. |
| A10 | Direct authenticated table access/service-only ingestion attempt | RPC-only feature tables and service-only evidence remain inaccessible to ordinary user. |
| A11 | Archive Under Contract then ordinary reassignment/read | Archive remains; history/shared Under Contract preserved. |
| A12 | Handoff then later deliberate reassignment into acquisitions | Only supported handoff archive reopens at Contacted; no read-triggered resurrection. |

## Concurrency, idempotency and recovery

| ID | Planned action/state | Expected result |
|---|---|---|
| C01 | Same lead edited from two tabs | First accepted action persists; obsolete version gets typed stale-state response. |
| C02 | Shared Leads board status changes during modal | Expected/current shared status checked; no blind overwrite. |
| C03 | Rapid double-click submit / Enter while pending | One committed effect and clear pending UI. |
| C04 | Retry same UUID and identical request after uncertain result | Original committed result returned; no duplicate fact. |
| C05 | Retry UUID with changed payload | Idempotency conflict, no second mutation. |
| C06 | Retry successful handoff after actor no longer owns lead | Authenticated original command replay succeeds without new access/write. |
| C07 | Two distinct pending offers concurrently | At most one active pending offer; other request rejected. |
| C08 | Repeat contract/archive operation | No fake offer or duplicate lifecycle evidence; clear supported result. |
| C09 | Duplicate local provider event, start/wrap-up either arrival order | One logical attempt, correct outcome and earliest valid actual start. |
| C10 | Late provider event after reassignment | Original episode/actor retained; new assignee stage/clock not advanced. |
| C11 | Switch rep/search/period while old response pending | No previous member rows/details leak; stale responses discarded. |
| C12 | Expand all then collapse immediately | At most3 detail reads in flight; queued reads stop; cached detail reused appropriately. |
| C13 | Detail/group read fails, then retry | Queue stays usable; correct group retry; no duplicated appended rows. |
| C14 | Save failure/validation error | Entered values retained, correct accessible error association; no success toast without commit. |
| C15 | Mutation refresh while another row detail open | Refreshed data does not spuriously unmount desired expansion/dialog. |
| C16 | Reload/back/forward after successful action | Durable outcome consistent across My Leads and affected existing lead surfaces. |

## Pagination and search

| ID | Planned action/state | Expected result |
|---|---|---|
| P01 | More20 synthetic leads in each stage | Each stage has independent load-more and full count; later stages not starved. |
| P02 | Multiple pages in attempts/notes/offers/history | Only requested group appended; no duplicate IDs; chronological order correct. |
| P03 | Lead moves stage/reassigned between page requests | Refresh/count reconciliation and ID dedupe; no claim of immutable MVCC snapshot. |
| P04 | Cursor older than five minutes | Fresh-page recovery; no silent empty success. |
| P05 | Reuse cursor with different member/org/search/stage | Server rejects binding mismatch without leakage. |
| P06 | Change search/period/member after several pages | Old cursor and obsolete rows reset appropriately. |
| P07 | Name/address/phone search, punctuation, whitespace, no matches | Correct matching and explicit empty results; bounded input handled safely. |
| P08 | Collapse stage, expand-all loaded rows, load another page | Visibility and expansion controls remain coherent; no hidden destructive action. |

## Side-effect ledger

| ID | Planned action/state | Expected result |
|---|---|---|
| S01 | Ready for offer | Motivation persisted; no appointment, call, message, sequence or invented temperature. |
| S02 | Log offer with explicit follow-up | One offer and correct stage; no send, task, provider call or enrollment. |
| S03 | Signed contract without prior offer | Signed evidence and Under Contract; no fabricated offer. |
| S04 | Decline current offer | Declined fact, shared Offer Declined, Needs sequence, configured recipient, queue exit atomic. |
| S05 | Nurture/not-interested handoff | Correct reason and reassignment; no Dead status or automatic sequence enrollment. |
| S06 | Archive contract | Queue archive only; shared status/history preserved. |
| S07 | Add note/template; book/reschedule/cancel callback/appointment | Exactly intended canonical records; no extra tasks or duplicate history. |
| S08 | Open/cancel/Escape each modal | No business mutation; local input reset/preservation matches intended UX. |
| S09 | Read queue/details/KPIs or switch owner selector | No credited rep activity or lifecycle change. |
| S10 | End-of-campaign independent database audit | Actual facts/tasks/enrollments match explicit fixture ledger; no unexpected organizations, principals or non-owned property writes. |

Existing `verify-my-leads-local-outcomes.mjs` assumes exactly one appointment and one handoff. Do not use it unchanged as proof for an expanded campaign; build expected assertions from the actual planned synthetic ledger. Existing nine browser tests and historical eight synthetic component checks leave the above cases unproved until executed here.
