# Purpose-scoped action dependency versions

Worker-private capture of the approved source fields. This is a dependency building block, not an action acceptance endpoint, complete authorization tuple or permission to send messages. No production migration or prior capture source was changed.

The exact field/identity mapping is in `field-map.json`. AFTER triggers compare actual OLD/NEW fields with `IS DISTINCT FROM`, construct only bounded identity events and increment counters in sorted organization/namespace/key order. No trigger expands child conversations, queries history or serializes full source rows. A source event contributes at most two scoped keys per purpose, deduplicated within that event. Counter rows have no canonical foreign key and survive source deletion. Delete/reinsert increments the existing revision, preventing an old dependency token from matching a recreated entity. Revision is returned as decimal text, preserving bigint precision.

| Namespace | Key within organization | Changes represented |
| --- | --- | --- |
| `property_identity` | property UUID | entity/org identity, deleted state, homeowner/agent references |
| `property_policy` | property UUID | status, permanent DNC lock, training eligibility |
| `property_outcome` | property UUID | outcome |
| `property_assignment` | property UUID | owner and follow-up time |
| `property_reply_content` | property UUID | address, city, state, ZIP |
| `contact_identity` | contact UUID | entity/org identity |
| `contact_policy` | contact UUID | DNC/opt-out and all three phone slots/types |
| `contact_reply_content` | contact UUID | first/last/entity name |
| `contact_channel_consent` | contact UUID + channel | event identity, type, ordering and old/new contact/channel |
| `route_policy` | channel + exact E164 phone | suppression identity/existence and suppressed-at time |
| `conversation_identity` | conversation UUID | thread entity/org/conversation/contact/property/channel mapping |
| `review_action` | review UUID | review target/status/disposition/source-message identity |
| `property_reviews` | property UUID | the same review changes, allowing a property action to detect review changes without source fanout |
| `membership_access` | user UUID | member identity/role/access lifecycle, acquisitions eligibility and conservative whole Hugo configuration/deletion-operation changes |

INSERT and DELETE advance every purpose associated with that source. Old and new organizations/identities are distinct keys. Multiple changes to one purpose in one row event increment it once. Conservative captures beyond the minimum spec include suppression ID, membership deletion-operation ID and all consent event types/channels; narrowing requires a proven consumer contract. Whole `hugo_config` changes may include unrelated content and are deliberately conservative until its permission fields are classified.

State is also used by `src/lib/messaging/send.ts:326` and `:891` for quiet-hours policy. Therefore reply acceptance must include `property_reply_content` even for plain text without address personalization; the namespace name must not be interpreted as permission to omit this safety dependency. Current time still requires live revalidation.

`conversation_identity` intentionally excludes `ai_responder_status`, matching the approved source classification. It is not a responder-state or reply-eligibility dependency. This slice has not established whether the new bulk-send policy should consume responder status; if it does, that field needs a separately specified/versioned dependency before enabling replies. No field expansion is inferred solely from the namespace name.

These do not replace the earlier message-content/known-reply/unknown-action counters, nor the projection/parent generations. Message read/status/time display changes do not touch these new counters. Review and responder display changes do not invalidate unrelated reply content. `suppressed_at` advances route policy even though it does not change the current summary, which illustrates why projection dirtiness cannot substitute for action versions.

## Actual consumer alignment

The approved specification's source table is the baseline. `src/app/(dashboard)/messages/dispo-actions.ts:130` updates outcome and clears `follow_up_at`, so that real outcome operation can advance both outcome and assignment namespaces. A dependent assignment must carry forward the revisions returned by the preceding committed step; it cannot blindly reuse its original vector. `src/app/(dashboard)/leads/actions.ts:2271` checks the DNC lock and validates the active assignee before updating owner. Therefore an assignment dependency set needs property identity/policy/assignment and the requester plus selected assignee's relevant access dependencies, alongside actual current eligibility checks. Contact flags and consent side effects for restrictive outcomes are separate source revisions, not proof that an outcome alone completed all those effects.

The fixture's immutable training guard rejects changing the marker. The test now verifies that rejection leaves policy revision unchanged and uses a permitted status change for the successful eligibility flip. `initial-training-guard-failure.txt` preserves the initial incorrect fixture assumption; no guard was disabled.

## Snapshot and missing baselines

`snapshot(org, requirements)` strictly validates namespace and canonical typed key shape, rejects SQL NULL, malformed objects and unexpected fields, and returns up to 50 explicitly requested seeded counters in one stable database snapshot. It rejects duplicate or missing requirements. It does not choose an action's required dependencies, read canonical action values, acquire execution locks, check authorization or atomically accept an operation. The test's property/requester vector illustrates version grouping; it is not advertised as the complete outcome/assignment tuple.

Historical entities and absence dependencies require authoritative baseline seeding before use. For example, a contact that has never had a consent event or a route that has never been suppressed still needs an initialized negative-dependency baseline. Missing counters are rejected rather than silently treated as zero or unchanged. No historical baseline or absent-policy seeding is implemented by this slice. Execution must lock/revalidate the appropriate canonical and dependency state and commit its result/receipt atomically. A standalone version read does not eliminate the race between checking and applying.

## Verification

`run.py` passes ten grouped runtime cases for initial vectors, missing baseline rejection, no-op/display exclusions, property purpose separation, contact phone/name/policy separation, consent ordering/audit/channel transitions, suppression time versus audit noise, thread/review purpose separation, membership restrictions/configuration, tenant moves/delete-reinsert/rollback, and private privileges.

`concurrency.py` runs three real independent-session cases with observed `pg_blocking_pids`. Two different review rows contend on their shared property review dependency. Both commits produce two increments; rolling back the first allocation leaves exactly one committed source row/revision; a stale REPEATABLE READ insertion fails with `40001`, leaves no source row, and a whole-transaction retry commits exactly once. This demonstrates the counter's serialization contract for these paths, not universal deadlock freedom or application retry integration.

`input-validation.py` adds five focused groups covering malformed input rejection, supported key shapes, no partial batch writes, explicit bump/snapshot denial for anon/authenticated/service roles, and catalog verification of all seven enabled source trigger attachments plus function definer/search-path/ACL metadata. It applied the helper/bump/snapshot validation patch only after verifying the previous installed bodies; no canonical rows were changed for these input tests. Original setup and original receipts are preserved as `*-before-input-validation.*`.

Both source runners enforce explicit owned-fixture opt-in, immutable container validation, fixture marker and disabled cron. The primary runner refuses installation over an existing schema. Explicit `--continue-installed` verifies every installed function body and then uses new synthetic identities, preserving prior data. Receipts contain setup/runner hashes, and the main receipt also records the field-map hash. SQL installation succeeded on the first attempt; the retained failure was a later fixture mutation rejected by an existing canonical guard.

```sh
python3 experiments/inbox-projection/policy-versions/run.py --run-owned-fixture
python3 experiments/inbox-projection/policy-versions/concurrency.py --run-owned-fixture
```

## Remaining acceptance gates

Provider/business-line configuration, reply templates and additional personalized variables, global permission configuration, privileged bypass/restore repair, historical/negative dependency baselines, memberships beyond the enumerated effective configuration and identity/link sources not represented here need explicit mapping. Access expiry can change with time without a revision event: acceptance must still check current time and authorization. The private counters do not certify revocation leases or sync access.

Source trigger overhead, all writer deadlock/serialization retries, lock ordering with legacy side effects, command receipts and durable provider ambiguity handling still require integration. No bulk appointment, sequence management/enrollment, new AI, customer sends or Outbox behavior was added. No production data or services were changed.
