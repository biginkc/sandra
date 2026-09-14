# Canonical Inbox property effects

Depends on workset bridge PR #571 (stacked parent), policy-version PR #565 (its parent), and acceptance PR #568 (merged). The child branch integrates these reviewed sources; no production migration or public execution grants exist.

`apply_property_step` holds the durable step fence, canonical membership/property locks, and required policy-counter locks through the property update, canonical triggers, lead event and immutable receipt. It derives requester from the accepted operation. Current requester/assignee expiry is checked using wall-clock time, including after the effect. The shared global access-epoch row is locked, and the requester must have exactly one current active global membership in the accepted organization; accepted work does not compare the original session epoch. Browser-session closure is not a reason to discard accepted work.

The implemented outcomes are wrong_number, bad_number, not_interested, needs_sequence and nurture. They update the actual `properties.outreach_dispo` and clear `follow_up_at`; the existing canonical trigger supersedes pending AI reviews and appends their event. Assign/unassign modifies `assigned_user_id` and appends its actual lead event. Returned property outcome/assignment/review revisions replace only those same dependencies for the succeeding step, retaining unaffected original requirements. External edits cause conflicts. SMS opted_out deliberately throws until its entire SMS-consent/enrollment side effects are implemented. Permanent dnc remains separately disabled under approved inventory A07: the canonical trigger ratchets a permanent property lock for that outcome, so it is not ordinary SMS suppression.

Run only with the explicit T2 ownership guard:

```sh
python3 experiments/inbox-operation-domain/run.py --run-owned-fixture --continue-installed
```

The initial run installs absent private core/domain schemas. Explicit continued runs compare installed core/domain function bodies and policy snapshot/key-validation helpers to source before creating fresh fixture identities. Each run preserves prior evidence and rows. No shared workset functions or tables are changed.

The current runtime suite runs separately for recent conversations and old-review-only conversations. It proves actual outcome/follow-up/review supersession plus dependent assignment, external revision conflict, transaction rollback of canonical effect/event/receipt together, requester revocation, completed-step replay retaining one event, missing item mappings rejection, message reparent/order conflict, independent canonical target recomputation, display-only exclusions and global membership ambiguity denial. Trusted fixture preparations/operations are seeded directly: the actual public preparation adapter remains fail-closed. These tests do not establish HTTP authorization, complete message-to-property resolution, distributed concurrency, worker retry integration or production performance. Initial revocation fixture used the only owner and was rejected by FINAL_OWNER_GUARD; the corrected fixture creates a separate owner before the ordinary requester without disabling that guard.

Remaining required work: authoritative bounded preparation and historical target-counter baselines; independent concurrent legacy-writer tests and whole-transaction retries; assignee notification delivery where required; failed/partial step receipts, retry/cancellation and Restate dispatch; complete restrictive outcome effects. The current property adapter must remain private until these applicable boundaries are resolved. The `changed` field currently denotes the outcome/assignment value change; clearing follow-up may still alter a same-outcome property.


## Target resolution capture

The new private `target_versions` counter captures message ID/tenant/conversation/contact/property/channel, queue eligibility and created-at changes, plus review resolution ID/tenant/conversation/property/status/created-at/source-message changes. It excludes ordinary read/delivery changes. This is a metadata-target dependency: a reply-content counter alone would miss created-at reordering that changes the selected property. Each source event advances at most its distinct old/new scoped keys, with no history scan. Counters survive source deletion. Historical rows are not silently assigned revision zero; absence fails closed until an authoritative baseline procedure exists.

Every effect now requires at least one exact nonexcluded mapped conversation and one unique matching target revision. The first step locks those counters and recomputes the actual canonical summary property. Its receipt returns the post-effect target revisions. A dependent assignment validates these revisions rather than demanding that its own prior outcome leave a review-only conversation visible; the old-review-only runtime proves this case. External reparenting and timestamp reordering fail, and even a fixture-rebased target revision cannot make a first step accept the wrong canonical property.

`upgrade-mappings.py` preserves the prior installed function and records its hash before a one-time guarded fixture upgrade; it does not modify root workset/read functions. New capture tables/triggers remain private and unpromoted. The retained prior five-group evidence was produced before mapping capture; current receipt hashes bind the updated source. Initial baseline source lacks these counters for earlier fixture identities, intentionally requiring explicit repair before they can be consumed.


## Time-bounded resolution

Source revisions cannot detect the moving 90-day window. The first effect therefore obtains `next_window_expiry` from the authoritative summary computation and carries that deadline in every post-effect target receipt. A dependent step requires the field, rejects an elapsed deadline, and rechecks before committing its receipt. Null is permitted only for a canonical resolution without a time-window deadline. Existing receipts without the field fail closed after upgrade. This conservatively rejects even a window expiry that would happen to keep the same property; the operator must prepare again. It avoids reintroducing the old-review-only disappearance caused by the operation's own review supersession.

`run.py --target-expiry` waits through an actual source-message cutoff without changing its target revision, proves the canonical summary disappears, then checks assignment and its receipt are absent while the completed outcome remains. `upgrade-expiry.py` compares both installed function bodies to the preserved, previously tested source hash before changing only the two owned private functions. Nullable organization/conversation keys are excluded from target capture; scoped old/new keys still advance when a record crosses the scope boundary.

The separate restrictive scope/effect SQL candidates are intentionally excluded from this PR and are not installed. Permanent DNC remains gated; only SMS opt-out is planned for that follow-up.
