APPROVE_PLAN: NO
BLOCKING: 6
NONBLOCKING: 1

Reviewed against `origin/main` at `011ac8a132ad2ea8ff0a5152a46a2108508e19bd`. Both supplied documents were read in full. `design` below means `my-leads-unified-queue-design-v3.md`; `mockup` means `index.html`. Counts include outstanding round-1 findings and new findings, without double-counting. No files were changed.

**Round-1 resolutions**

- **B1 — RESOLVED.** `design:100` explicitly excludes `norma_call` from healthy automation; `design:231`–`:233` cover completed callbacks, wrong numbers, and open requests. This matches the retained pauses and custom wrong-number tasks in `supabase/migrations/20261008090100_norma_retry_next_step_union_reviewed.sql:486` and `:533`.

- **B2 — PARTLY — BLOCKING.** The ordered table resolves the original completed-drip, campaign-text, and paused-by-reply contradictions. However, manual queued texts reach Your move only through the final fallback (`design:42`), after healthy automation and future callbacks have already matched (`design:37`–`:38`). A contacted lead with a queued manual text and a future callback therefore remains Waiting, contradicting `design:110`, `:186`, and `:248`. The existing send action supports this unscheduled queue-only path: `src/app/(dashboard)/leads/actions.ts:2186` passes `queueOnly` at `:2193`. **Fix:** Put unresolved manual queued work ahead of Waiting predicates, retaining the chosen Nothing planned label where appropriate. Add overlap fixtures with a future callback and healthy drip.

- **B3 — RESOLVED.** `design:146`–`:153` now distinguishes automatic templates from individually approved drafts and consistently proposes reached-only attempts. The source independently stamps `reply_source` and `approved_by_user_id`: `src/lib/ai-responder/dispatch.ts:5822` and `:5850`. The two defaults remain explicitly pending Jarrad; that is recorded product uncertainty, not an additional technical blocker.

- **B4 — PARTLY — BLOCKING.** Affirmative send evidence and accepted-then-failed handling are now specified. But the extra condition in decision row 5—“no row-6 Broken condition caused by the handling text itself” (`design:32`)—is broader than the required exception. If accepted text X later fails and a newer inbound Y arrives, Y is unhandled, yet the failed handling text can still suppress New reply. Initial-failure behavior is also ambiguous against `design:211`. Provider failures genuinely update these states independently: `src/lib/messaging/status-events.ts:94` and `:179`. **Fix:** Remove the extra Broken exclusion from row 5. Determine handling per inbound, preserving acceptance evidence for X; show Broken when no newer unhandled inbound exists. Test initial failure, late failure, and late failure followed by Y.

- **B5 — RESOLVED.** `design:155`–`:161` now specifies propagation, validation, durable replay, timestamp-based ordering, legacy behavior, missed calls, and concurrency tests. Those are concrete additions to the currently unstamped input and metadata construction at `src/lib/messaging/rep-sms.ts:593` and `:676`. This resolves the planning gap; implementation must still demonstrate those tests.

- **B6 — RESOLVED.** The transition boundary is consistently `now + 15 min`, and effective follow-up preserves chain resolution and the no-chain fallback (`design:35`, `:105`, `:229`–`:230`). This addresses the original window and chain-lifecycle finding. A separate overlap introduced by the ordered table is reported below.

- **B7 — PARTLY — BLOCKING.** The ledger and stale-send inventory are present, but recovery/supersession semantics remain absent. `design:77` treats any qualifying failed ledger row as Broken indefinitely. The ledger retains terminal failures, and a later retry can be a new submission: `supabase/migrations/20260917140000_rep_sms_delivery_ledger.sql:174`; `src/app/(dashboard)/my-leads/rep-sms-composer.tsx:547`. Thus a successful replacement text does not clear the old failure under the stated predicate. Simply filtering `recovery_open` would also be wrong: failure itself closes that marker in `supabase/migrations/20260917160000_rep_sms_durable_draft_recovery.sql:50`. Additionally, the blanket “Resend” action contradicts the existing reconciliation-only handling of unknown sends at `src/app/(dashboard)/my-leads/rep-sms-composer.tsx:433`. **Fix:** Define unresolved/superseded failure selection and state-specific actions. Preserve reconciliation for unknown/in-flight submissions; specify how a successful replacement or explicit resolution clears a definitive failure. Test recovery across separate submission keys.

- **B8 — RESOLVED.** Lead-page appointment/history parity and the thread-plus-composer composition are explicit Phase B deliverables (`design:134`, `:136`, `:282`). They directly address the existing paginated controls at `src/app/(dashboard)/my-leads/_components/detail-panel.tsx:178` versus the destination’s open-only query at `src/app/(dashboard)/leads/[id]/page.tsx:293`.

- **B9 — PARTLY — BLOCKING.** Single-statement results, request sequencing, page clamping, and retained membership are specified. The revision/reconciliation contract at `design:170` remains insufficient:
  - A maximum update/event watermark does not change when a callback crosses its due threshold or a text reaches 3 business days.
  - Refetching only the current offset page cannot refresh retained rows that have moved outside that page.
  - Unconditionally removing a row after any action conflicts with actions that leave it actionable, such as logging no answer while New reply remains.
  
  Existing code already models time-driven changes through `nextWarningAt`: `src/app/(dashboard)/my-leads/client.tsx:605`; SQL computes future warning transitions at `supabase/migrations/20261005121000_next_step_read_model.sql:65`. **Fix:** Use a revision of evaluated membership/order that accounts for time boundaries; fetch current facts for retained IDs separately from candidate membership. Remove an acted-on row only after its new classification excludes it from the active view. Add clock-only transitions and no-answer action fixtures.

- **B10 — RESOLVED.** The constraint migration, new pin RPC, flag-gated page/badge/comp reads, rollback rehearsal, and observation period are explicit (`design:173`, `:284`, `:288`). Nullable persistent pins can remain invisible to the existing flag-off predicate, which requires `pinned_until > p_at`: `supabase/migrations/20261005150000_my_leads_call_next.sql:163`.

- **N11 — RESOLVED.** `design:149`–`:152` names attempt timestamps, user workflow events, user-origin next-step events, and enrollment attribution. The next-step source confirms why `actor_type` matters: `supabase/migrations/20261006111000_fn_create_next_step_replay_location.sql:329`. Contact-only inbound attribution is explicitly retained at `design:142`.

- **N12 — RESOLVED.** Scope wrappers, member-only writes, bounded inputs, negative tests, business-day/DST fixtures, and distinct-primary-reason badge counting are now stated (`design:172`–`:174`, `:236`–`:238`, `:278`). The episode-based first-call condition is preserved rather than replaced.

- **N13 — PARTLY — NONBLOCKING.** Chevron behavior, disabled no-phone calling, Waiting headline prefixes, and illustrative stage/pagination controls are corrected (`mockup:41`, `:66`, `:76`, `:84`). Search still appears functional without a filtering handler or illustrative label (`mockup:40`, `:87`–`:88`). The added overlapping-reason fixture has an unanswered reply but `ico:'drip'` (`mockup:70`), contradicting the reply-first icon rule at `design:119`. **Fix:** Mark search illustrative or implement it, and change that fixture’s icon to reply.

**New findings**

14. **BLOCKING — Future offer-chain tasks are classified as Callback booked before Offer out.**  
    **Claim:** Decision row 11 matches any future open appointment before row 12 can classify a pending offer (`design:38`–`:39`). Consequently, the standard chained offer-follow-up path fails the Offer out fixture at `design:240`.  
    **Evidence:** `supabase/migrations/20261005130000_offer_follow_up_chain.sql:55` creates the follow-up using `p_kind := 'appointment'` at `:58`, then links its chain to the offer at `:65`. The current Call next classifier explicitly identifies offer-chain appointments separately at `supabase/migrations/20261005150000_my_leads_call_next.sql:146`.  
    **Concrete fix:** Exclude pending-offer-chain tasks from Callback booked, as row 4 already does for Due. Define precedence when a lead has both a separate callback and an offer follow-up; test both alongside the ordinary chained-offer fixture.

15. **BLOCKING — Snoozed callbacks remain supported actions but disappear from commitment classification.**  
    **Claim:** Phase B preserves Snooze and snoozed appointment access (`design:134`), yet the placement table recognizes only open appointments (`design:28`, `:31`, `:36`, `:38`). A valid snoozed callback can become Nothing planned; with a healthy drip, its callback deadline can pass without overriding Waiting.  
    **Evidence:** The current next-step projection explicitly includes `status in ('open','snoozed')` and computes effective time with `greatest(due_at, snoozed_until)`: `supabase/migrations/20261005121000_next_step_read_model.sql:46`. Its callback controls remain actionable for both statuses at `:105`.  
    **Concrete fix:** Define one effective commitment predicate/time for supported open and snoozed appointments, then use it consistently for Due, Callback booked, and the under-contract exception. Add fixtures before, at, and after snooze expiry, including overlap with a healthy drip.

V3 resolves most round-1 integration concerns, including Norma holds, provenance, stamp propagation, destination-page parity, and rollback planning. Approval remains blocked by 4 incomplete prior resolutions and 2 new decision-table gaps. These require targeted predicate, recovery, and refresh-contract corrections—not a different product direction or additional rollout ceremony.