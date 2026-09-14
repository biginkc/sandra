# Canonical bulk reply recipient capture

This private, disabled candidate resolves current canonical Inbox recipients before a reviewed reply can be frozen. It depends on the reviewed reply context boundary (PR #587) and metadata authority/policy APIs (PR #586). It does not expose an authenticated RPC, accept a send, create a job, or call a provider.

`recipient.sql` locks canonical property/contact identity, captures inbound generation and purpose-specific content/policy versions, checks the saved normalized phone, opt-outs, suppression and active sender inventory, then captures sender/company/market context. Read receipts do not invalidate reply content. Arbitrary absent or foreign conversation IDs do not allocate persistent heads. Completion-time conversation expiry excludes a recipient even when versions have not changed.

## `inbox_reply_preparation.destination_policy()` — the sole eligibility authority

Eligibility went through three rounds of per-contact, per-caller fail-open
holes (a first-slot-only pick, then no cross-contact or global-DNC
awareness). Round 4 replaced all of that with ONE org-wide,
**destination-keyed** predicate — `destination_policy(o, destination,
canonical_contact, strict)` — so a future fix is "add a fact to the
predicate," not a new hole in a new caller. `recipient()` calls it once per
candidate; nothing else in this file (or any future caller) re-derives
eligibility on its own.

Evaluated in order, first hit wins (tie prefers opt-out) — steps 1-4 run
under **both** `strict` values:
1. `sms_phone_suppressions` exact E.164 match — parity with
   `src/lib/messaging/send.ts`'s `isSmsPhoneSuppressed`
   (`opt-out-phone.ts`).
2. `global_phone_dnc_registry` exact E.164 match — closes a real gap:
   production `src/` code never reads this table for send-eligibility today.
3. **Cross-contact bleed** — ANY contact in the org (not just the one tied to
   this conversation) with a phone slot normalizing to this destination that
   is `do_not_contact`/`sms_opted_out`, or whose latest sms consent event is
   an opt-out.
4. **Cross-contact landline** — ANY matching slot on ANY matching contact is
   `'landline'`.

`strict` (default `true`, fail-closed) additionally requires EVERY matching
slot across every matching contact to be `'mobile'` (else
`unclassified_phone`) and the CANONICAL contact's own latest sms consent
event to be an affirmative opt-in (else `no_consent`). Both are deliberately
**stricter** than the existing single-send/bulk-queue paths
(`src/lib/messaging/send.ts`, `suppression.ts`'s
`evaluateAutomatedSuppression` used by `bulk-queue.ts`), which let an
`'unknown'`-typed or no-consent contact through by default — bulk-reply has
no per-message human review at send time. Flipping `strict` to `false`
(production parity) is Jarrad's Lane-1 compliance call to make later, and is
a single argument, not a rewrite; `recipient()` currently always passes
`true`.

`recipient()` keeps two checks that are conversation/property identity, not
destination policy, and are unaffected by `strict`: the canonical contact
having this destination saved at all (`phone_not_saved`), and the property's
own `is_training`/`is_dnc_locked`/terminal-disposition suppression
(`property_suppressed`).

`destination_policy()` is `SECURITY DEFINER` (needs read access to
`global_phone_dnc_registry`, which is revoked from `authenticated`/
`service_role`), with explicit `org_id=o` filters on every table query, its
own `search_path=''`, and `lock_timeout`/`statement_timeout` matching the
other reply RPCs.

**Placement contract (E4), not built in this PR:** capture/freeze (this
file) calls the predicate once per candidate and freezes the result.
Acceptance (a future PR) MUST re-run it live per frozen item before commit —
a newly surfaced exclusion there is a 409 (stale review), with the 50-cap
recounted after removing newly-ineligible items. The dispatch worker's claim
step (a future PR) MUST re-run it again per item immediately before
`dispatch_started` — an exclusion there terminates that item as
`skipped_ineligible` with no provider attempt, never a silent send. Neither
of those call sites exists yet in this repo; `recipient.sql` documents this
contract inline at `destination_policy()`'s definition for whoever builds
them.

`inbox_reply_preparation.recipient_limit()` is the single source of truth for
the D5 bulk-reply cap (50); `batch.sql` and `inbox_reply_review.view()`
(`experiments/inbox-reply-review/setup.sql`) both call it instead of
repeating the literal, and `src/lib/inbox/reply-api-contract.ts`'s
`INBOX_REPLY_RECIPIENT_LIMIT` constant is checked against it by
`reply-api-contract.test.ts`.

`batch.sql` takes at most 500 explicit, unique conversation IDs in deterministic order. It retains exclusions for review, flags every conversation sharing a destination, and reports whether the distinct eligible recipient count exceeds the cap. This is a review signal, not an acceptance implementation. It never silently picks one duplicate conversation. The private quiet-hours helper preserves the application's exact state/timezone map and 08:00–21:00 local window; the batch uses the database clock, with no environment override. Earlier recipients are checked again for time-only expiry after the loop.

Run the actual rollback-only proof against the marked owned fixture:

```sh
python3 experiments/inbox-reply-preparation/recipient-test.py --run-owned-fixture
```

Eighteen groups cover canonical route/personalization, read-only versus content changes, foreign/missing identities, saved phone/landline/unclassified-phone, a conflicting duplicate save (mobile + landline on the same normalized destination) failing closed across every matching slot, inventory, consent opt-out AND no-consent, private grants, duplicate destinations, malformed target sets, winter/summer/territory quiet hours, 51 recipients becoming 50 only after a canonical exclusion, and the full `destination_policy()` E1-E4 convergence matrix.

Every fail-closed assertion in `recipient-test.py` compares `exclusion` with `IS DISTINCT FROM`, not `<>` — with `<>`, a broken guard that lets `exclusion` fall through as SQL `NULL` makes the comparison itself evaluate to `NULL`, and `IF NULL THEN RAISE` silently does not raise. `IS DISTINCT FROM` treats `NULL` as a real, comparable value, so the assertion actually fires when the guard is gone.

Every fail-closed guard in `destination_policy()` was mutation-checked by hand for real, not just insert/remove-the-fact within the test: each of the 6 guards (steps 1-4, plus the two strict-only checks) was fully removed from `recipient.sql`, the exact expected failure was confirmed, then the guard was restored. Round-3's three guards (line-type, consent, the single-contact multi-slot duplicate check) were re-confirmed the same way. Source hashes and limitations are in `recipient-evidence.json`. The runner removes the new schemas and all test data in the same rollback.

A separate real-connection proof in `recipient-concurrency.py` observes the reader waiting on a sender-context lock, crosses natural 90-day expiry while it waits, and verifies exclusion at completion. Temporary schemas/triggers are removed; uniquely marked synthetic source rows remain in the owned fixture. **Not re-run as part of this pass** — `recipient-concurrency-evidence.json` now declares a `stale_pending_rerun` marker on its `source_sha256` key (the only field affected by the `recipient.sql` fail-closed changes above); `verify.py` prints a warning for that specific declared key and still exits 0, rather than either hard-failing or silently dropping the binding. Any OTHER unexpected drift (the context source or the runner itself) still hard-fails `verify.py`. Re-run this proof and remove the marker once the Lane-2 isolated fixture rebuild lands, same as the `inbox-reply-review` concurrency proof.

Remaining gates: additional concurrent mapping/version and multi-recipient expiry waits; authenticated immutable personalized preview; cap enforcement and duplicate resolution at acceptance; current actor/dependency/time rechecks at dispatch; committed dispatch marker and account admission; receipt persistence and verified callback reconciliation. The caller must retry only an entirely aborted database transaction, never a potentially accepted provider request. Deterministic conversation order does not prove that legacy multi-row source writers cannot deadlock. No production schema or feature flag is changed by these files.
