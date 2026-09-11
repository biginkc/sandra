# PR520 Mine / PR521 Refresh semantic resolution

Owner: Sandra — Reply & Conversation Refresh
Date: 2026-09-10
Refresh candidate: `e377d0d3e42dde7a100b00250a59d85aacb1b1b9` with sealed harness `c830ecc37507f6c0e06d0602adb4f43efa598ada81260c4fc13e5f6700518572`
Mine candidate: `f201466e38eb0f492871174b60a666bd22f26097`

## Owner statement

I find no direct changed-file intersection between Mine PR520 and Refresh PR521 when both are compared with base `8c7053e7024433f46791eac1b186c1b7a7cf10ec`. The only shared semantic contract is the Messages RPC `public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text)`.

Mine’s migration changes exactly the Mine row predicate and Mine count predicate to match any assigned status, including `prospect`; it leaves No owner leads-only. It preserves the eight-argument signature, search normalization and matching, full-window count keys, tenant/access checks, grants, and the 15-second timeout. The paired rollback restores the prior function definition.

Refresh’s `inbox-refresh` route calls `listThreadPage`, which passes the active filter, authenticated viewer id, unread pin, DNC toggle, page, and search to that same RPC. The route and client fetch both use private/no-store semantics. A send completion separately revalidates the selected thread detail and refreshes the current inbox snapshot; the refresh carries the current filter/search scope and therefore adopts Mine’s new assigned-status rows/counts when the operator is in Mine. This is compatible behavior, not a conflict.

The exact Refresh reproducer starts at `/messages?thread=<A>` and exercises A-send/B-switch; it does not set `filter=mine`, `search`, or `inboxPage`, and it observes `/api/messages/thread-detail` plus the inbox refresh path independently. No actual conflict or failing reproducer was found. A Mine assignment/status change while the operator remains in Mine would intentionally change the refreshed rows/counts; that is the required semantic result.

## Evidence and limits

- Changed-path intersection: empty.
- Mine migration SHA256: `911e207f129d3a34a4176a55d6a563f237da028449b3404685dc1dfe1d445dea`.
- Mine rollback SHA256: `0e694436cfc535b4bb8c991983309b5e22b846b7a6fcecddc67ffae326de01e3`.
- Mine’s committed static contract test asserts the two-predicate-only change, search signature/timeout, access boundaries, and rollback identity. Its committed integration evidence expects assigned `prospect` and `new_lead` rows in Mine, Mine count 2, No owner count 1, and search narrowing that preserves those scoped counts; it was not rerun against a shared DB here.
- Refresh’s sealed manual and Fable approvals remain exact-hash bound; private hook evidence is recorded in the final-candidate manifest.
- No shared physical-test-DB reservation, migration execution, push, shared CI, provider call, or customer send occurred.
- Remaining limits are unchanged: B completion while B detail is in flight is untested; a `route.fetch` exception can wait for timeout; provider-mock/quiet-hours proof requires the admitted browser lane.

## Owner disposition

Semantic resolution: **CLEAR — no direct path conflict and no Refresh reproducer conflict found.** This statement is evidence only. Controller full-lifecycle publication, physical DB reservation/cleanup ownership, authenticated acceptance admission, and push-triggered shared CI remain required.
