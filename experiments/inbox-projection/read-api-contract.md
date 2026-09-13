# Post-render Inbox read API contract

2026-09-13 · Proposed contract, not implemented. Governing specification: parent workspace `artifacts/design/inbox-workspace/technical-specification.md`, “Concrete post-render read boundary,” plus `implementation-conditions.md`. Current AFTER allocator is the baseline; the sidecar experiment has not replaced it. No database mutations were performed for this document.

## Existing behavior and sources

- `src/app/(dashboard)/leads/actions.ts`, `markMessagesReadForThread` (2396 onward): resolve canonical conversation organization, inspect linked properties, call `assertPropertyDncUnlocked`, update only matching organization/conversation, SMS, inbound and null read_at. Property scope is a guard, not permission to acknowledge other conversations on that property.
- `markMessagesReadForProperty` (2367 onward) is a different broad property operation. Do not reuse it for the new Inbox read boundary.
- `src/app/(dashboard)/messages/inbox-detail-data.ts`, `fetchInboxDetail` (76 onward): organization resolution, latest100 messages, pending review, contact/property and phone/consent context. Current separate HTTP/SQL requests are not one snapshot; created_at ordering needs an id tie-breaker in the new path.
- `src/lib/messages/threading.ts:133`, `resolveSmsConversationOrg`; migration `20260816150000_sms_conversation_org_guard.sql`: reject cross-organization conversation ambiguity; require active, unexpired, non-deleting membership for authenticated callers. Service_role/postgres have a privileged branch.
- `src/lib/auth/memberships.ts` and `access-state.ts`: active Hugo lifecycle matters; membership existence alone is insufficient. Local E2E fallback is not a production API policy.
- `src/lib/dnc/property-lock.ts`: authoritative DNC RPC. Migration `20260815190000_true_dnc_property_lock.sql:369–405` preserves a row-level read_at guard that locks linked properties and rejects permanent DNC changes.
- Migration `20260908120000_training_lead_guards.sql:77–96`: existing message training guard rejects outbound customer actions, but returns early for inbound messages. Do not invent a blanket ban on inbound read acknowledgment merely from the training marker; preserve actual visibility and business guards. Existing opt-out/suppression is not itself permanent read-only DNC.
- Old `messages/page.tsx:199` marks read while constructing the server response. New Inbox must call only after the correct detail has rendered.

## 1. Detail snapshot endpoint

Proposed `GET /api/inbox/conversations/:conversationId/detail?limit=50` (server maximum100). It performs no mark-read mutation. Browser request generation is local UI state, not an authority claim.

Successful response:

```ts
type DecimalRevision = string; // canonical decimal integer, never JSON number
interface DetailSnapshot {
  conversationId: string;
  messages: Array<{
    id: string; createdAtRaw: string; inboundRevision: DecimalRevision;
    direction: 'inbound' | 'outbound'; readAtRaw: string | null;
    // Explicit approved display fields only; no select-star provider metadata.
  }>;
  olderCursor: string | null;
  readBoundary: string; // opaque signed token or recorded random identifier
  boundaryExpiresAt: string;
  snapshotId: string;
}
```

Use one database statement containing materialized head/history CTEs, or a single read-only REPEATABLE READ transaction for all components of this boundary. Head and history cannot be separate READ COMMITTED calls or independent Supabase requests. Do not lock the head merely to read it. The transaction returns committed `coalesce(head.revision,0)::text` plus bounded history in the same MVCC snapshot. Body/route context can be an independently refreshable panel, but must not alter the already returned read boundary.

History selection is organization+canonical conversation+SMS with stable `(created_at DESC,id DESC)` ordering, displayed chronologically if desired. Older cursors retain database timestamp precision and id; preserve the raw PostgreSQL text representation with all fractional digits and offset or an equivalent canonical UTC6-digit representation. Never Date.parse→toISOString a timestamp used in SQL pagination. Do not compare raw timestamps lexically unless a canonical format was specified; compare typed timestamptz and uuid in SQL. Cursors bind requester, scope and query/version and cannot be reused for another conversation.

The token is issued only after successful authorized database response. Preferred initial token: authenticated-encryption or signed opaque envelope with `{version,kid,boundaryId,requesterId,organizationId,conversationId,captureGeneration,headRevision,snapshotId,issuedAt,expiresAt}`. Initial expiry proposal5minutes; technical tuning value, not previously approved UX guarantee. Key IDs permit rotation; secrets stay server-only. A server-recorded boundary is also valid but introduces durable storage/expiry and must keep its captured values immutable. Do not sign arbitrary values supplied by the browser.

The single-snapshot guarantee covers head/history. Authorization is independently rechecked before returning and again before each write batch. If a membership lifecycle changes while loading, reject or refetch rather than combining an old authorization scope with newly fetched data. New APIs must not depend on a dashboard-layout check that the full-screen route no longer mounts.

**Private head read privilege:** ordinary/service API roles cannot directly read the candidate head table. A narrowly granted SECURITY DEFINER RPC may read it, but must explicitly validate auth.uid, organization, active Hugo access and target visibility. Do not invoke the existing resolver inside an owner definer and assume it enforces end-user membership: its postgres/service-role branch intentionally bypasses that check. Alternatively, resolve under end-user context and use a private server-only query with equivalent explicit scope checks; document one approach before implementation.

## 2. Browser render acknowledgment

Only after the response's conversationId/snapshotId matches the current opened detail generation and content has committed to the visible pane may the browser submit its readBoundary. Selecting rows, prefetching, opening a hidden cache entry, skeleton rendering or receiving a superseded response must not acknowledge it. Schedule post-render acknowledgment after the component commits; a paint observation helps test behavior but cannot prove a human read the text.

The approved meaning is conversation acknowledgment through the captured arrival head, **including older eligible unread messages outside the rendered history page**. It is not “mark just the50 rendered IDs.” Only the boundary associated with the actually rendered page may initiate that acknowledgment. A later stream arrival requires a new authorized detail boundary before it may be acknowledged; never silently advance the old token's head.

Cached revisit: a still-valid boundary may be acknowledged if that exact content becomes visible. If expired, refresh a current snapshot and render it first; do not obtain a fresh head solely to acknowledge stale cached content. A response for A arriving after B opened is discarded without an acknowledgment call.

## 3. Accept acknowledgment command

Proposed `POST /api/inbox/read-acknowledgments`:

```ts
{ boundary: string; idempotencyKey: string }
// 202: { acknowledgmentId, state: 'accepted' | 'running' | 'completed' }
```

The client supplies no free-form timestamp, organization, message IDs, head revision or property scope. Authenticate, verify token signature/version/capture generation/expiry/requester and current scope; atomically persist an idempotency receipt bound to the canonical boundary hash. Same key+same input returns the same receipt. Same key+different boundary rejects409. After acceptance, operation execution has its own bounded lifetime; token expiry blocks new acceptance but must not imply already committed work is undone. Initial execution deadline proposal10minutes, fresh authorization per batch; expired/denied remaining work stops visibly and requires a freshly rendered snapshot for any new command.

A later head greater than the boundary is expected, not a conflict. A current head below a positive captured head, missing head for a positive boundary, or mismatched capture-generation indicates invalid/reset coverage: fail closed. Zero is valid only for the atomically installed pre-capture baseline. New imports, disabled trigger paths, TRUNCATE/restore and other capture bypasses invalidate the coverage assumption and must be handled by the installation/operation contract.

Responses:400 malformed boundary,401 missing session, indistinguishable404 inaccessible/not-found target,409 incompatible/reused input or coverage reset,410 expired boundary,429 admission limit. Do not leak other-tenant existence through receipt or error details.

## 4. Bounded execution transaction

Process at most200 rows per short transaction initially (benchmark/tune). Each batch:

1. Recheck requester active access, expiry, deletion lifecycle, current organization and conversation visibility. A privileged worker must act on behalf of the original requester; its service credential is not authorization to continue after revocation.
2. Select eligible unread candidates using **current** org+conversation+SMS+inbound, `inbox_inbound_revision <= capturedHead`, `read_at IS NULL`; lock candidate message rows in stable ID order. Use indexed bounded retrieval; absence of a suitable plan is a benchmark issue, not permission for an unbounded message-history scan on the first-open request.
3. Recheck membership while holding the applicable membership row lock for this short batch if needed to serialize revocation. Obtain current linked property guards and preserve canonical read_at trigger behavior. Source message locks prevent identity changes between final eligibility check and mutation. Do not trust property IDs saved at render time.
4. Set read_at from server statement time for those rows only; never overwrite an existing read_at. Commit changed count and batch/operation receipt atomically. A failed DNC guard rolls back the whole batch; earlier committed batches remain complete and results must say partial/stopped, not “nothing changed.”
5. Release all locks before fetching the next batch. Never hold the head row lock during reading/acknowledgment. Deterministic ordering reduces risk but cannot eliminate existing row→property/head cycles; retry40P01/40001 as a whole bounded transaction with the same operation identity, not a standalone failed statement.

Do not report completion because SKIP LOCKED returned no candidates: locked eligible messages can remain unread. Either do not skip locks and use bounded timeout/retry, or distinguish skipped/pending and run a final authoritative existence check. Keep scanning currently eligible unread rows with the fixed boundary, rather than relying on an ID cursor that can permanently skip a temporarily locked row. Completion means no remaining eligible rows in a fresh authorized check; another explicit mark-unread after completion is a separate user action and must not resurrect this completed acknowledgment on retry.

Persisted receipts make lost responses recoverable. Polling status must reauthorize the requester. UI displays read-pending/error until acknowledged; sync eventually adjusts unread counts. Read changes dirty the summary but do not allocate another inbound arrival or invalidate reply-content preparation.

## 5. Identity, safety and precision cases

- Move into the conversation after the snapshot: allocator assigns destination revision above captured head; excluded even if created_at is old. Move out and back similarly gets a new destination revision.
- Move out before the batch: current scope excludes the row. Do not follow it to another conversation/property or mark property-wide history.
- Delete/reinsert same ID: new allocation excludes it from an earlier boundary. Deleted old messages are not a failure requiring resurrection.
- Permanent DNC acquired after rendering: deny remaining mutation using current property locks. SMS opt-out alone retains existing read semantics; never conflate it with permanent DNC.
- Body/route corrections do not automatically create new inbound arrivals under the approved spec. This boundary is not the bulk reply safety snapshot; separate dependency revisions govern send preparation.
- Revision wire values are canonical nonnegative decimal strings (range0..9223372036854775807). SQL compares bigint, JS uses BigInt only where needed. Reject signs, exponents, whitespace and out-of-range input at token decoding. Preserve raw database timestamps through cursor encoding.
- Current allocator stamps via AFTER self-update. INSERT/UPDATE RETURNING can contain0/old revision; never generate a boundary or authoritative stamp from it. A subsequent select inside the same transaction observes final stamps, while the read endpoint gets committed values from its own single snapshot.
- Sidecar arrival mapping may later change the SQL source of the revision, but not these API semantics. It requires separate approval/equivalent proofs before replacing the current messages column.

## 6. Proposed implementation locations

New route handlers under `src/app/api/inbox/conversations/[conversationId]/detail/route.ts` and `src/app/api/inbox/read-acknowledgments/route.ts`; runtime DTO/signing/query helpers under `src/lib/inbox/`; full-screen generation/post-render coordinator under `src/features/inbox/data/`. Add narrowly scoped database read/ack routines through the repository migration process only after the T2 candidate decision. Preserve old `leads/actions.ts` and old Inbox behavior during rollout; do not globally change Outbox or property-detail semantics. Existing history, DNC, resolver and access-state modules above supply domain behavior but their multi-request implementation is not copied as the new snapshot protocol.

## 7. Meaningful verification

- Head allocation held open while detail reads: snapshot either sees neither committed row/head or both; later commit remains unread under old boundary. Reverse commit timing and rollback cases.
- Insert100+ older inbound rows, render latest50, acknowledge fixed boundary in multiple batches; eligible older rows become read while later/backdated arrivals remain unread.
- A→B response race, cache prefetch, selection-only, render failure and expired cached revisit: only actually rendered valid boundary acknowledged.
- Timestamp pairs differing only beyond milliseconds paginate with no loss/duplication; equal timestamp/id tie-break; revisions above2^53 transport exactly.
- Token tamper, other requester, org/conversation swap, expired token, rotated key, capture reset and duplicate idempotency key with changed input reject without writes.
- Membership revocation/expiry and DNC lock between render/acceptance/batches; identity move out/back and delete/reinsert during batching; no cross-scope write and accurate partial status.
- Lock timeout/deadlock and response lost after commit: bounded whole-transaction retry; completed retry does not re-mark rows subsequently marked unread.
- Private head RPC cannot exploit owner/service-role resolver bypass; current Hugo enforcement and missing-schema handling fail closed.
- Existing training inbound read behavior, canonical DNC triggers and old individual/property read actions remain unchanged.
- Query plan and WAL/lock measurements at realistic unread cardinality; no unexplained whole-history scan on first-open path and no head lock during browser acknowledgment.

No tests in this document have been executed for this API because the API is not implemented. Existing head proofs establish only their recorded isolated behavior.
