# Inbox action input boundary

This server-only library validates request shape and produces an immutable canonical input and SHA-256 identity. It performs no database/provider work and enables no route. `parseInboxActionIntent` is preparation intent; its reply step opens review after metadata results. `parseReviewedInboxReply` accepts only references to reviewed items, never browser-supplied recipients or consent flags. Both still require authoritative preparation/acceptance.

The route must impose a streaming body limit before reading the complete request; the parser also enforces 128 KiB. The 500-target and five-step limits are initial transport ceilings, not approved production capacity claims. Only the 50-recipient limit is the approved product limit. More than 50 selected conversations can enter preparation: after resolution/exclusions, at most 50 recipients may be previewed and accepted. The reviewed-item limit is an additional guard, not evidence of recipient count after expansion.

## Required database integration

- Authenticate the caller and derive organization/requester context server-side. Do not deserialize that context from request JSON.
- Resolve every typed target under current authorization. Preserve every requested target in the preparation response, including an explicit ineligible result for target/step mismatches. A conversation and unknown group with the same UUID remain distinct.
- For outcome, assignment and promotion, resolve current property IDs, deduplicate shared properties, check training/deletion/locked eligibility and all relevant revisions. Assignment additionally validates active eligible organization membership. Preserve existing outcome side effects, including consent/review/sequence-pausing behavior. Existing `needs_sequence` and `nurture` codes do not authorize sequence enrollment or scheduling.
- For unknown dismissal/restoration, capture actual eligible message IDs transactionally. Do not execute an address-wide update or let later arrivals enter an earlier accepted action. Client-supplied message IDs are deliberately unsupported.
- For replies, prepare and protect full personalized text and actual route, check per-recipient 1,600-character validation, consent/suppression/identity/current inbound dependencies, duplicate destinations and final recipient cap. Acceptance must revalidate snapshot ownership, expiry, approved item membership and current dependencies. No `review_reply` step sends automatically.
- Resolve saved-action snapshots from an authorized database lookup, then pass the exact stored version as the third argument. The returned definition is a detached frozen copy. A browser may provide only the reference, not the snapshot. Saved versions must be immutable in storage.
- In one acceptance transaction, materialize targets/dependencies/definition and receipts plus the dispatch outbox. Enforce UNIQUE(org, requester, idempotency key); same canonical hash reuses the existing operation, different hash returns HTTP 409. `compareInboxActionIdentity` alone does not implement deduplication. Step ordering is significant; selected target/item ordering is not. Canonical input contains reply text and is protected data, not a log field.

The library intentionally rejects callback/appointment dispositions (not client-settable in the existing server action), arbitrary status codes, AI, enrollment, identity changes and direct send/new-message steps. It does not create endpoints, authorize actions, implement transactions, or replace existing single-item workflows.


## Exact reply text

The actual immediate Inbox composer calls `sendSmsFromLead` in `src/app/(dashboard)/leads/actions.ts:2101`; that action trims surrounding whitespace before its 1,600 UTF-16-code-unit check. This parser follows that normalization (the similarly named Messages action handles queued edits and is not the source for this decision). Internal whitespace and valid Unicode are preserved. Reject NUL and unpaired surrogate code units before storage. After template personalization, normalize and validate each final recipient text **before** displaying and freezing the preview. Dispatch must use exactly that approved frozen text; no post-review trim, template expansion, or substitution is permitted.

`dnc` and `opted_out` outcomes require the existing SMS opt-out side effects, including suppression/consent and enrollment pausing where applicable. They are not merely display labels. The separate permanent-DNC workflow and apology-plus-permanent-DNC combination remain excluded.

JSON syntax is handled by native JSON.parse. A small subsequent token scan rejects duplicate decoded keys in each object, including escaped equivalent spellings; it permits whitespace and arbitrary member ordering. There is no new parser dependency. The read-boundary codec's byte-canonical rejection cannot be reused directly because these request bodies allow ordinary JSON formatting.
