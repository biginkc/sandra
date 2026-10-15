APPROVE_PLAN: NO
BLOCKING: 1
NONBLOCKING: 0

Reviewed against `origin/main` at `011ac8a132ad2ea8ff0a5152a46a2108508e19bd`. Both supplied documents were read in full. `design` means `my-leads-unified-queue-design-v4.md`; `mockup` means `index.html`. No files were changed. B7’s remaining issue and finding 16 below are counted once.

**Round-2 resolutions**

- **B2 — RESOLVED.** `design:29` and `:39` put unscheduled manual queued texts before every Waiting predicate. `design:256` adds both overlap fixtures. This covers the queue-only manual send supported by `src/app/(dashboard)/leads/actions.ts:2186` and `:2193`.

- **B4 — RESOLVED.** `design:37` removes the Broken exclusion and evaluates handling per inbound; `:38` reaches Broken only when no unhandled inbound remains. The initial failure, late failure, and late failure followed by Y fixtures are explicit at `design:257`–`:259`. This accommodates the independent delivery-failure updates at `src/lib/messaging/status-events.ts:94` and `:151`. The older “row 6 outranks row 5” wording at `design:154` and `:324` should follow the authoritative ordered table; it does not invalidate the corrected rule.

- **B7 — PARTLY.** `design:90` now defines supersession across submission keys and distinguishes definitive failures from unverified sends. Its reconciliation-only action agrees with `src/app/(dashboard)/my-leads/rep-sms-composer.tsx:433`–`:434`; its resolution predicate avoids treating `recovery_open` as failure resolution, consistent with `supabase/migrations/20260917160000_rep_sms_durable_draft_recovery.sql:50`. However, the separate `messages.status='failed'` predicate still bypasses that distinction for actual provider-unknown transport rows. See finding 16.

- **B9 — RESOLVED.** `design:179`–`:183` specifies evaluated membership/order revisions, clock-boundary refresh, retained-ID fact reads, conditional action removal, and the required concurrency fixtures. These address all 3 outstanding points, including the clock-driven behavior represented by `supabase/migrations/20261005121000_next_step_read_model.sql:65`.

- **14 — RESOLVED.** `design:27` excludes offer-chain tasks from callback classification; `:44` expressly selects the earlier commitment’s headline and chip when both exist. `design:252`–`:253` supplies the standard chained-offer and mixed-commitment fixtures. This correctly accounts for the appointment created at `supabase/migrations/20261005130000_offer_follow_up_chain.sql:58` and linked to the offer at `:65`.

- **15 — RESOLVED.** `design:27`, `:33`, `:36`, `:42`, and `:44` include snoozed callbacks and use their effective time consistently. `design:254`–`:255` covers future snoozes and expired snoozes overlapping healthy automation. This preserves the supported status/time semantics in `supabase/migrations/20261005121000_next_step_read_model.sql:46`–`:48`.

- **N13 — RESOLVED.** Search is explicitly illustrative at `mockup:40`, and the overlapping Due/New reply fixture uses `ico:'reply'` at `mockup:70`.

**New findings**

16. **BLOCKING — The transport-message fallback can offer Resend for a send whose outcome is unknown.**

    **Claim:** `design:84` treats a recent human `messages.status='failed'` row as a definitive failure with **Resend**. Actual code also uses that status for ambiguous provider outcomes. The ledger-specific **Check status** rule therefore does not fully protect the proposed classifier, particularly for manual sends without a ledger receipt. Offering a replacement submission can duplicate a text the provider already accepted.

    **Evidence:** `src/lib/messaging/send.ts:1194`–`:1208` persists ambiguous provider errors as `status: "failed"` with `metadata.providerOutcome: "provider_unknown"` and `retryable: false`. The ledger write immediately above is conditional on `input.repSmsReceipt` at `:1181`. The manual lead-send branch at `src/app/(dashboard)/leads/actions.ts:2186`–`:2195` calls this transport without that receipt. `src/lib/messaging/status-events.ts:82`–`:88` explicitly distinguishes this failed-status placeholder from a genuine terminal failure.

    **Concrete fix:** Normalize transport and ledger facts into one send outcome before selecting Broken’s action. Exclude `metadata.providerOutcome='provider_unknown'` from the definitive failed-message predicate. Unknown outcomes must remain **Check status / Review**, including messages without a ledger receipt; they must never receive the automatic new-key Resend path. Add fixtures for ambiguous manual sends with and without a ledger receipt, followed by reconciliation to delivered and to definitive failure.

V4 resolves the outstanding placement, callback, reply-ordering, refresh, and mockup concerns. Approval remains blocked by 1 concrete transport-state mismatch: a stored `failed` message does not always mean confirmed failure. Correct that predicate and its action mapping; the reviewed product decisions and rollout structure do not need reopening.