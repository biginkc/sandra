# Canonical bulk reply recipient capture

This private, disabled candidate resolves current canonical Inbox recipients before a reviewed reply can be frozen. It depends on the reviewed reply context boundary (PR #587) and metadata authority/policy APIs (PR #586). It does not expose an authenticated RPC, accept a send, create a job, or call a provider.

`recipient.sql` locks canonical property/contact identity, captures inbound generation and purpose-specific content/policy versions, checks the saved normalized phone, opt-outs, suppression and active sender inventory, then captures sender/company/market context. Read receipts do not invalidate reply content. Arbitrary absent or foreign conversation IDs do not allocate persistent heads. Completion-time conversation expiry excludes a recipient even when versions have not changed.

Eligibility fails closed on two axes, both deliberately **stricter** than the
existing single-send/bulk-queue paths (`src/lib/messaging/send.ts`,
`suppression.ts`'s `evaluateAutomatedSuppression` used by `bulk-queue.ts`),
because bulk-reply has no per-message human review at send time:
- **Line type** — only an affirmatively saved `'mobile'` slot is eligible,
  checked across **every** saved slot that normalizes to the reply
  destination, not just whichever slot comes first by ordinal. A contact can
  have the same number saved twice (e.g. after a re-import or manual
  correction) with conflicting types; if ANY matching slot is `'landline'`
  the recipient excludes with `landline`, else if any matching slot is
  anything but `'mobile'` (i.e. `'unknown'`, never classified) it excludes
  with `unclassified_phone`. The existing paths let `'unknown'` through by
  default (bulk-queue only gates it behind an operator opt-in toggle this
  feature doesn't have yet), and neither existing path has ever needed a
  multi-slot conflict rule since they never had this duplicate-save case.
- **Consent** — an affirmative opt-in event
  (`opt_in_marketing_written`/`opt_in_confirmed`/`opt_in_informational`) must
  be on file; its absence excludes with `no_consent`. The existing paths only
  hard-block explicit `opt_out`/`provider_auto_opt_out` and let a contact with
  zero consent history through.

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

Seventeen groups cover canonical route/personalization, read-only versus content changes, foreign/missing identities, saved phone/landline/unclassified-phone, a conflicting duplicate save (mobile + landline on the same normalized destination) failing closed across every matching slot, inventory, consent opt-out AND no-consent, private grants, duplicate destinations, malformed target sets, winter/summer/territory quiet hours, and 51 recipients becoming 50 only after a canonical exclusion.

Every fail-closed assertion in `recipient-test.py` compares `exclusion` with `IS DISTINCT FROM`, not `<>` — with `<>`, a broken guard that lets `exclusion` fall through as SQL `NULL` makes the comparison itself evaluate to `NULL`, and `IF NULL THEN RAISE` silently does not raise. `IS DISTINCT FROM` treats `NULL` as a real, comparable value, so the assertion actually fires when the guard is gone. All three fail-closed guards (line-type, consent, the multi-slot duplicate check) were mutation-checked by hand for real: each guard was fully removed from `recipient.sql`, the suite was run and confirmed to fail with the exact expected error, then the guard was restored and the suite re-confirmed green. Source hashes and limitations are in `recipient-evidence.json`. The runner removes the new schemas and all test data in the same rollback.

A separate real-connection proof in `recipient-concurrency.py` observes the reader waiting on a sender-context lock, crosses natural 90-day expiry while it waits, and verifies exclusion at completion. Temporary schemas/triggers are removed; uniquely marked synthetic source rows remain in the owned fixture. **Not re-run as part of this pass** — `recipient-concurrency-evidence.json` now declares a `stale_pending_rerun` marker on its `source_sha256` key (the only field affected by the `recipient.sql` fail-closed changes above); `verify.py` prints a warning for that specific declared key and still exits 0, rather than either hard-failing or silently dropping the binding. Any OTHER unexpected drift (the context source or the runner itself) still hard-fails `verify.py`. Re-run this proof and remove the marker once the Lane-2 isolated fixture rebuild lands, same as the `inbox-reply-review` concurrency proof.

Remaining gates: additional concurrent mapping/version and multi-recipient expiry waits; authenticated immutable personalized preview; cap enforcement and duplicate resolution at acceptance; current actor/dependency/time rechecks at dispatch; committed dispatch marker and account admission; receipt persistence and verified callback reconciliation. The caller must retry only an entirely aborted database transaction, never a potentially accepted provider request. Deterministic conversation order does not prove that legacy multi-row source writers cannot deadlock. No production schema or feature flag is changed by these files.
