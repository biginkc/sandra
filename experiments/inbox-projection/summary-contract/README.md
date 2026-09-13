# Known-conversation summary compute candidate

Status: **21 offline runtime checks passed** after compiling the worker-private function against the canonical fixture. This is the next T2 slice, separate from the completed lab PR. Only the owned fixture received the private schema and unique synthetic organizations/records; no application route or production migration was changed. `fixture-cases.csv` records the broader21-case plan with completed/partial coverage explicitly marked; its cases are not a one-to-one count of runtime assertions.

The function takes explicit organization, conversation UUID and as-of timestamp. It computes one canonical known-conversation summary in a single statement. It never groups conversations by property or phone. The private schema and execution revocations deny ordinary callers; invoking it as a trusted worker is not user authorization. Missing eligible work returns a keyed exists=false tombstone candidate. SQL installation requires the owned fixture marker, but the caller must additionally use the shared Docker/image/offline/cron guard and obtain the exclusive database window. Do not execute it directly against another database.

## Source mapping

References below are relative to the repository root. The exact source migration hash/revision is recorded in source-provenance.json.

| Summary semantics | Authoritative source |
| --- | --- |
| 90-day elapsed window | src/lib/messages/list-threads.ts:452 and :464; subtract2160hours, not timezone-sensitive calendar days |
| Pending review membership | supabase/migrations/20260909080000_messages_search.sql:50; uniqueness enforced by20260827110000_ai_disposition_reviews.sql:58 |
| Eligible known messages | 20260909080000_messages_search.sql:68; SMS, contact/conversation nonnull, status NOT IN queued/paused; SQL NULLstatus excluded |
| LatestID/contact/time, recent unread, latestnonnullproperty or reviewfallback | same migration:95 |
| Old pending-review exception | same migration:135 and :160; when no recent eligible row exists, aggregate old eligible history; reviewproperty governs |
| Contactname/property/owner/status/route, consent and suppression | same migration:212 |
| Optout/testtraffic/noise and needs_outcome | same migration:295 and :307 |
| Assignment eligibility and filter visibility | same migration:329 and :343; property_status nonnull and not prospect; reviewfilter ignores ordinary noise but excludes testtraffic |
| API contact/route presentation mapping | src/lib/messages/list-threads.ts:833 |

The source CTE bodies are retained with only worker identity scoping, explicit cutoff, removal of search/multi-conversation ambiguity logic, and narrow output changes. Long review/escalation reasons and full message bodies are excluded. A120-character preview is a proposed narrow-summary limit, not existing UI truncation parity. Latest message status is returned separately from property status; outcome remains the raw outreach_dispo. Existing outcome/status values are never rewritten or expanded.

The compute returns has_recent, unread_count, has_inbound, needs_outcome, owner and property status, review identity/status/disposition/source-message metadata, optout/noise/test flags and basic visibility flags. No new AI recommendations are introduced; existing pending-review state is preserved as legacy workflow data. Mine/No owner require the requesting user and are evaluated downstream from owner plus assignment_eligible. Unread's include-selected-conversation override is also requester/view state, not stored global summary state. Show-noise variants derive from has_recent plus the same filter predicate. Search remains authoritative history search and is intentionally outside this compute.

## Expiry and projection integration

As-of is the reference clock for the activity window, not a historical database snapshot. Current canonical data/consent/reviews are read; future-dated messages are not excluded because the existing source has no upper timestamp bound. The exact cutoff comparison is inclusive. next_window_expiry is the earliest current eligible message time plus2160hours; schedule recompute just after that instant (1microsecond at PostgreSQL precision). Recomputing every expiring message is necessary because unread count or selected property may change before the last message expires. An old-review-only summary has no time deadline and relies on review/source dirty events.

The output is only a compute candidate. Persistent generation/CAS application must capture this data with G/R in the same statement/snapshot, as the approved projection protocol requires. Calling this function and reading dirty generation in a later statement would be incorrect. No projection revision/source version, dirty fanout, worker, checkpoint or publication table is installed here.

## Concrete gaps before execution/acceptance

- Compilation and source parity passed in the owned fixture. Twenty-eight RPC rows plus exact visibility sets were compared across All/Review with hide-noise enabled/disabled. Direct compute permission failures require42501. The RPC comparison uses simulated database auth claims; this is not real token or application API authorization testing.
- Existing status NULL behavior, empty entity-name behavior and property-mismatched pending review behavior are deliberately retained even where surprising. Change only after an explicit semantic decision.
- Current RPC aggregation can scan an entire known conversation, especially old-review-only history. This candidate preserves semantics, not bounded source work. Query plans and realistic history volume remain a gate; the completed index proof already shows a scoped index alone may not bound the chosen history plan.
- Dirty capture must include message status/contact/property/address changes and property/contact/consent/suppression/thread/review fanout. The earlier minimal projection trigger does not cover all of this compute's dependencies. Expiry requires scheduled recomputation independently of CDC.
- Review/property/thread uniqueness assumptions must be verified in fixture tests. A cardinality violation intentionally errors instead of selecting an arbitrary joined row.
- Canonical deleted/training property handling follows current joins; no extra visibility exclusion was invented. Worker output must not be exposed until membership/access epoch and the approved reader authorization contract are implemented.
- This draft includes neither unknown/dismissed summaries nor search/count endpoint behavior, command receipts, reply dependencies or sequence management.

## Runtime execution and retained evidence

After an exclusive database grant, execute `python3 experiments/inbox-projection/summary-contract/run.py --run-owned-fixture`. The shared fixture guard verifies pinned image/container, resources, network isolation, disabled cron and the ready marker. Fresh mode refuses an existing schema; `--continue-installed` compares the installed compute function body with the unchanged local SQL before using fresh unique fixture IDs. It never resets or replaces the function automatically. Continuation validates the function body only; source/canonical catalog equivalence and privilege drift require separate review. SQL has20-second statement/two-second lock limits and each subprocess has a30-second deadline.

`evidence.json` records the final21 checks and exact setup/runner hashes. `evidence-initial.json` preserves the earlier18-check result. `attempts.jsonl` preserves the initial DNC_LOCKED fixture failure: modifying a contact linked to a permanently locked property was correctly rejected. The fixture was corrected to create separate unlocked test traffic instead; no guard was disabled. Membership fixtures use an owner and do not remove memberships, avoiding the final-owner guard. Successful synthetic records and the private schema remain for inspection.

The final assertions include exact90-day cutoff and+1microsecond expiry, a DST-spanning2160-hour window in UTC/America-Chicago, older pending review with close-to-tombstone behavior, recent unread isolation, mismatched/fallback review property, source message exclusions, timestamp/UUID tie breaking, display route, preview cap, shared-property separation, cross-org conversation UUID collision, raw assignment/status/outcome rules, consent ordering, normalized tenant-scoped suppression and noise/review visibility. Source parity compares existing row fields and exact visible conversation-ID sets, preventing false passes that check only returned rows.

Outstanding planned edge coverage includes NULL message-status handling where allowed by canonical constraints, blank entity names, unsupported phone forms, all owner/status combinations, explicit mark-read/status-transition recomputation, expiry altering the selected property while newer history remains, and synthetic canary/property-address variants beyond the tested name case. These gaps do not change the observed passing cases and must not be advertised as completed. No latency/capacity measurement was taken for this full summary computation.

Fixture-label clarification: recent-old-unread used a recent **unread** row and asserted count1, excluding the older unread row. Runtime NULL validation tested organization only; NULL conversation and as-of checks remain planned.
