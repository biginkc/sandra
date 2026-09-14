# Remaining canonical membership implementation

Evidence inspected: `supabase/migrations/20260909080000_messages_search.sql` and `experiments/inbox-projection/summary-contract/compute.sql`. The view-only bridge is an integration increment, not acceptance parity.

## Exact predicates to preserve

Known filters are all, mine, unassigned, unread, escalated, dispo and needs_outcome. Ordinary visibility uses has_recent and optional noise removal. Mine/unassigned additionally require a linked non-prospect property. Mine binds to the authenticated requester; do not accept a browser-supplied requester ID. Disposition-review visibility ignores the ordinary recency predicate but excludes test traffic. Existing unread has a current-open conversation inclusion exception; the new selection freeze must not accidentally use this to expand authorization or assign unread semantics to unknown senders.

The maintained summary already contains has_recent, is_noise, property_status, assigned_user_id, unread_count, ai_responder_status, ai_disposition_review_id, is_test_traffic and needs_outcome. These are worker-private data. Add the necessary narrow server query columns or server-private filter metadata rather than exposing the complete JSON through Electric. Current four booleans are insufficient for mine/unassigned/hide-noise toggles.

Known search uses trimmed 3–100 characters, literal escaped case-insensitive contact search_text, digits of at least length three against contact phone_digits, OR canonical SMS message FTS using search_prefix_tsquery. It searches conversation history without restricting to the synchronized 500 IDs. Do not replace it with preview substring matching. Unknown search must be mapped against its actual legacy loader before implementing; no guessed search predicate is justified.

## Cursor contract

Use an opaque random server cursor tied to requester/session/org/access epoch, canonical normalized filter JSON and schema version. Persist the last ordering tuple from the same SQL snapshot that materializes the immutable membership. A cursor may only continue its exact filter and authorization context, with an expiry at most the scope expiry. Reject unknown/expired/mismatched cursor IDs.

For order `(latest_at DESC NULLS LAST, target_kind ASC, target_id ASC)`, continuation after a non-null timestamp is timestamp less-than, OR equal timestamp and greater kind/ID, OR null timestamp. After a null timestamp it is only null timestamp and greater kind/ID. Fetch at most requested limit plus one for has-more; do not fall back to OFFSET. A next workset is a fresh snapshot; client must identify it as refreshed membership and preserve selection separately.

Changing the wrapper to accept cursor and returning next_cursor needs a coordinated versioned repository interface update. Do not silently ignore a supplied cursor. Until that change is implemented and tested, the concrete repository correctly rejects non-null cursors.

## Acceptance evidence still needed

Exercise each legacy filter against canonical records and assert exact ordered IDs, including linked prospect versus lead, no assignee, opted-out/test traffic, review-only old conversations, unknown dismissed and equal/null timestamps. Search must find a match beyond the resident set and deep in history. Test wildcard literals, three-character threshold, 100-character cap, cross-tenant rows, cursor tampering, filter mismatch and arrival between pages. Explain plans and realistic volume are required before treating a correct predicate as a fast query.
