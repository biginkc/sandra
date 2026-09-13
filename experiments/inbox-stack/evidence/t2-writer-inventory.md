# T2 writer coverage inventory — source-only

Inspected worktree `/Users/jarradhenry/Documents/ChatGPT/New project 2/tmp/inbox-stack-t1`, HEAD `bb0f8d3dbf1b5b741570f52c6a6e938a394f5c35`. Read applicable repository instructions and governing `artifacts/design/inbox-workspace/technical-specification.md`, `database-validation.md`, and `implementation-conditions.md` in the parent workspace. No credentials, database catalogs, production, migrations or application writes were accessed. This document is the only change for this task.

Status: sufficient evidence to divide the next isolated feasibility work; NOT complete deployed writer certification. File references below are relative to this worktree. Historical migrations can be superseded; referenced trigger definitions are source evidence until catalog verification confirms effective deployment.

## Governing contract reconciliation

The approved specification and its execution conditions govern. Use PostgreSQL AFTER capture, discriminating actual fields, across legacy writers; no new AI, Outbox changes or sequence management. Maintain transactional per-conversation inbound revision heads, never a sequence-as-commit watermark. Read flags may dirty list state but must not increment command conflict versions. Persistent dirty generation/acknowledgement plus projection revision CAS permits older-but-monotonic repair progress without discarding every hot-key candidate. The earlier database appendix is illustrative: its optional message projection is not necessary for first history delivery through Query, and its earlier strict generation-equality wording must not replace the approved starvation correction. The first shadow migration must not accidentally introduce a second implementation contract.

## Canonical field dependency map

| Source table | Fields requiring projection/eligibility consideration | Capture destinations |
|---|---|---|
| messages | id, org_id, conversation_id, contact_id, property_id, channel, direction, created_at, status, read_at, from_address, to_address, body, dismissed_at, metadata; delivery/error display fields only where surfaced | OLD/NEW conversation keys; OLD/NEW unknown sender buckets; inbound head allocation only on new inbound membership/explicitly defined unseen-content changes, never read_at alone |
| properties | org_id, id, address/city/state, status, outreach_dispo, assigned_user_id, follow_up_at, deleted_at, is_training, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at, is_dnc_locked, homeowner_contact_id, agent_contact_id, zip | All linked conversations via reverse lookup; command entity versions for relevant mutation dependencies; existing review trigger cascades |
| contacts | org_id, id, entity_name, first_name, last_name, phone_1/2/3 and their types, do_not_contact, sms_opted_out; generated search_text/phone_digits semantics | All linked conversations; route/safety dependencies; unknown matching changes ultimately move messages |
| message_threads | org_id, conversation_id, contact_id, property_id, ai_responder_status and displayed escalation state | OLD/NEW conversation keys and identity reconciliation; registry row id is distinct from conversation id |
| ai_disposition_reviews | id, org_id, property_id, conversation_id, status, disposition, ai_reason, source_inbound_message_id, created_at and resolution state | OLD/NEW conversations and older-review inclusion/removal |
| consent_events | org_id, contact_id, channel, event_type, occurred_at, id; deletes/corrections as well as inserts | Contact fan-out; latest event ordering must match existing query |
| sms_phone_suppressions | org_id, channel, phone_e164, suppressed_at and row existence | Phone-route fan-out, not merely contacts whose primary phone matches |
| global_phone_dnc_registry | Registry phone identity/entries; existing propagation writes contacts/properties/enrollments | Preserve propagation and capture downstream canonical mutations; separately enumerate direct authorization reads before deciding whether a registry change also needs direct version fan-out |
| memberships / auth lifecycle | user_id, org_id, role, access_status, access_expires_at, deletion_prepared_at, lifecycle changes | Authorization epoch/lease invalidation; not a message-summary rewrite per member |

Evidence for list fields: `supabase/migrations/20260909080000_messages_search.sql:68,212,243,278,295,307`. Detail fields/safety: `src/app/(dashboard)/messages/inbox-detail-data.ts:76,139,180`. Access: `src/lib/auth/access-state.ts:30`. Exact full current table definitions, generated columns, FK actions, constraints and role policies still require catalog reconstruction.

The specification's version-versus-projection distinction remains authoritative: created_at/read_at/delivery-only changes dirty display without automatically invalidating reply content; route/content/identity changes do invalidate. `src/lib/supabase/types.ts:2770` confirms property deleted_at, follow_up_at, is_training and last_ai_escalation_at in current generated types. Metadata key classification is still open: `src/lib/messaging/send.ts:1312` reads providerRetry and `:1479` describes sendOrigin. Until every safety-relevant metadata reader is classified, follow the approved conservative rule to version any metadata change; do not silently categorize all metadata as display-only. Template-dependent zip/name/address fields and suppression timestamp belong in the dependency tuple even when absent from the list row.

## Verified writer families

| Writer or job | Source evidence | Consequence for capture |
|---|---|---|
| Inbound receipt and disposition | `src/lib/messaging/inbound.ts:1044` inserts messages; `:113` updates disposition | New messages and same-transaction outcome changes cannot rely on new Inbox API callbacks. |
| Sender/provider lifecycle | `src/lib/messaging/send.ts:369,636,910,1643`; `src/lib/messaging/status-events.ts:61`; `src/lib/messaging/delivery.ts:574` | Queue/sent/failed/delivered transitions affect eligibility or display. Preserve old provider behavior. |
| Sequence cron | `src/app/api/cron/sequence-tick/route.ts:162,199,238,261` message accesses and updates | Existing worker activity must update projection; no sequence execution refactor is authorized. |
| Manual outcomes, ownership, read state | `src/app/(dashboard)/messages/dispo-actions.ts:97,132`; `src/app/(dashboard)/leads/actions.ts:2267,2396` | Property fan-out; read-only field change excluded from command-version invalidation. |
| Unknown merge/create/dismiss/restore | `src/lib/messages/triage.ts:94,197,321,392,426,446` | Capture both pre/post keys, sender buckets and null-contact transitions. |
| Known identity resolution and compensation | `src/lib/messages/resolve.ts:268,397,404,433,440,624` | A failed multi-write resolver can restore IDs/delete registry rows; tombstones and compensations must reconcile. |
| Consent and phone suppression | `src/lib/messaging/consent.ts:156`; `src/lib/messaging/opt-out-phone.ts:225` | Phone/contact fan-out needs coverage for old and new key values and deletes. |
| Existing AI thread state/review | `src/lib/messages/ai-responder-thread-state.ts:24,58,90`; `supabase/migrations/20260827110000_ai_disposition_reviews.sql:99,151` | Existing automation and nested property→review changes must be reflected. |
| CSV ingest/update/recovery | `src/lib/csv/ingest.ts:1055,1079,1091,1115,1130,1213,1272`; `src/lib/csv/update-operations/phones-shared.ts:153,192,224,261`; `update-property-status.ts:70,89`; `src/workflows/csv-import.ts:897,938` | Batched contact/property changes and consent RPCs can generate large fan-out. Capture at SQL boundary, not workflow UI. |
| Enrichment/skip trace | `src/lib/enrichment/cass-job.ts:158,260,299,332,354`; `src/lib/skip-trace/skip-trace-job.ts:446,1552` | These are verified access/RPC entrypoints; trace each RPC and downstream writer before declaring complete phone/address coverage. Some accesses are reads, not proof of mutation. |
| Duplicate merge/direct destructive RPC | `supabase/migrations/067_merge_duplicate_properties_batch_scope.sql:68,154,156`; `069_harden_destructive_rpcs.sql:44,50` | Messages can be relinked and property/contact rows deleted outside Messages UI. Cascades/SET NULL must be covered. |
| Cleanup direct SQL | `scripts/sql/sandra-cleanup-packet-a.sql:404,412,420,430` | Source includes direct property/contact deletions; not evidence the packet was executed now. |

## Existing trigger interactions that require real tests

- Identity stamp: `081_conversation_id_unify.sql:180,216` installs BEFORE INSERT/UPDATE OF contact_id; it may mint a registry entry and assign NEW.conversation_id. AFTER capture must observe the final identity, including nested writes, without re-minting or recursively dirtying revision-only updates.
- Critical UPDATE OF trap: `20260830092331_switchboard_contact_preferences.sql:95–110` explicitly notes that a phone-targeted BEFORE trigger can change NEW.do_not_contact without firing a trigger declared only UPDATE OF do_not_contact. Implement AFTER UPDATE capture with OLD/NEW field comparison, not only a column target-list trigger. Compare final NEW after all BEFORE transformations.
- Contact→property DNC propagation: `20260815190000_true_dnc_property_lock.sql:95,115,145`; further row barriers/guard installation at `20260816010000_backend_paid_safety.sql:61,165,227`. New capture must not invert existing contact/property locks or change guard outcomes.
- CSV safety serialization: `20260816020000_csv_import_recovery_safety.sql:182,206,225,250` adds contact/property/consent/phone safety triggers. These are concrete additional lock dependencies, not hypothetical contention.
- Property outcome→review supersession: `20260827110000_ai_disposition_reviews.sql:151` updates pending reviews and emits lead events. Capture must process both changed dependency families; duplicate dirty marking is coalesced rather than recursively rejected.
- Global DNC barriers/propagation: `20260830092331_switchboard_contact_preferences.sql:69,96,106,137,217,222,228`; training guards `20260908120000_training_lead_guards.sql:56,75,96,104`. Privileged/system writes can encounter or bypass distinct guard paths.
- Newer assignment hook: `20260912090100_acquisition_queue_episodes.sql:313` attaches `trg_my_leads_property_assignment`; any ownership benchmark must include its downstream work, not a bare fixture property UPDATE.

AFTER row capture is the governing baseline. Batch deduplication or statement-transition-table optimization is a later bounded correction if row-level overhead fails; document compatibility and retry behavior before changing placement. Updating multiple source keys in one legacy transaction can still deadlock despite sorting head locks. Identify actual transaction boundaries/isolation and retry behavior per writer.

## Privileged bypass, restore and delete coverage

A real bypass exists in source: `scripts/restore-sandra-cleanup-packet.mjs:218` defines an isolated round-trip restore; groups include contacts/properties (`:227–238`), then `:263–276` disables all user triggers while inserting those groups and temporarily disables membership triggers. This is an isolated-test path, not evidence production capture has been bypassed. Nevertheless replaying it into a projection-enabled environment would bypass new capture too. Require explicit rebuild/reconciliation before opening the Inbox after such restore operations.

`scripts/seed-jordan-training-rehearsal.mjs:45` disables one named training-message trigger, not all capture triggers. Do not mislabel every trigger-disabled operation as equivalent. Direct cleanup and merge deletions remain normal capture paths when triggers are enabled.

Searches found no explicit `session_replication_role` setting or actual TRUNCATE of the canonical dependency tables in searched `scripts/`, `supabase/`, and `src/` non-test code; two comments mention truncation. This is an absence in the searched source, not proof that administrator tools, restore utilities or deployed jobs cannot use them. Decide TRUNCATE prohibition or an explicit rebuild-required marker with statement-level handling. Row DELETE capture is not TRUNCATE handling. Privileged disabled-trigger/replica-session bypass needs an operational reconciliation contract; a user trigger cannot detect its own absence.

## Exact time and filter semantics to preserve

`list-threads.ts:448` defaults to 90 days; SQL clamps requested cutoff no older than 365 days (`20260909080000_messages_search.sql:27`). Recent eligibility requires SMS, nonnull contact/conversation, status not queued/paused, and created_at at/after cutoff (`:68–94`). Unread count and has_inbound are derived inside that recent set (`:112–117`), not lifetime totals. Old pending-review conversations get a separate history grouping (`:125–177`). A lifetime unread counter or one last-message timestamp alone cannot reproduce those rules.

A message aging past cutoff can change unread/has_inbound, latest nonnull property choice, visibility and filter counts without any write. Schedule `next_recompute_at` from relevant message expiry boundaries, not just conversation expiry. Pending review removal can drop an old conversation immediately. Unread view pins the selected conversation (`:336`); Mine/Unassigned exclude prospects (`:321–322`); DNC/test hiding and disposition-review exceptions differ (`:295–350`). Exact counts should not block history paint.

Unknown sender grouping has no 90-day limit: `list-unknown-senders.ts:95` pages the complete unmatched inbound set; latest-row dismissal determines the bucket's dismissed state, while counts include the full group. Preserve literal grouping unless normalization has an explicit migration decision. Membership expiration and fixed workset lease expiration also happen without source updates and require time-aware authorization, not only CDC.

## Separate proposed migration units

1. **Canonical version/head schema and semantics:** add heads/entity versions, baseline rules and discriminating AFTER capture. Local concurrency proof with real stamping/guards, multiple rows/keys, move/return and rollback; no projection publication yet.
2. **Dirty capture and narrow summary schema:** persistent generation/ack/revision invariants; dependency fan-out including OLD/NEW keys, review and unknown paths. No source-table ownership transfer; keep source locks out of repair commit.
3. **Recompute and expiry workers:** bounded leases/checkpoints, monotonic snapshot CAS, parent fan-out acknowledgement only after durable child enqueue, time-driven expiry and repair. Explicit failure visibility.
4. **Backfill plus parity verifier:** capture first, resumable tenant/key batches, stable-snapshot comparisons, restore-bypass rebuild procedure, cross-writer fixture matrix. Do not publish incomplete rows as complete lists.
5. **Measured indexes and Electric publication:** choose indexes from real query plans/selectivity, least-privilege projection-only role, replica identity/WAL measurement, isolated sync tests. No production change inferred from design approval.

## Query costs and next blockers

Costs to measure: per-inbound head lock hold time; trigger-added round trips/nested cascades; hot-conversation source scans; large contact/property/phone fan-out; latest-consent lookup; 90-day expiry churn; read-flag burst volume; dirty queue growth/replay; backfill WAL; summary FULL replica identity write amplification. Source already has list composite and FTS/trigram indexes; don't blindly duplicate them.

Next feasibility blockers are concrete: (a) catalog reconstruction of effective functions/triggers/enabled modes/FKs/RLS/publications; (b) full downstream trace of CSV/CASS/skip-trace RPC entrypoints and actual external writer inventory; (c) real-schema isolated concurrency and retry matrix covering existing safety/assignment triggers; (d) explicit bypass/TRUNCATE restoration policy; (e) parity queries for expiry, unknown buckets, review exceptions and deleted identities; (f) benchmark fixture dimensions derived from separately authorized volume evidence. No credentials or production inspection was performed to close these gates, and no migration is ready to deploy from this document alone.
