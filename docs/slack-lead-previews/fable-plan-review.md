# Fable plan review

**Verdict: REQUEST_CHANGES**

The plan's security posture (fail-closed, org-bound installation, channel policy, no arbitrary fetch, pure renderer, flag off) is sound and I have no objection to the agreed preview content. The blocking items below are design gaps that would surface as outages or policy violations in production, not setup chores. Setup release gates (scopes, domain registration, event subscription, reinstall, channel approval, canary) are correctly separated and are not counted against the plan.

## Blocking findings

**B1. Fail-closed is underspecified at the HTTP layer and will get the app disabled.** Slack retries non-2xx/slow responses (`X-Slack-Retry-Num`) and auto-disables event subscriptions after sustained failures. Gate 4 says "fail closed" but does not say what a policy denial, unsupported link, unknown channel, or feature-flag-off returns. If those surface as 4xx/5xx, Slack will hammer the endpoint and eventually turn off events for the whole app, breaking the feature and any future event use.
*Fix:* Define explicit semantics: invalid/stale signature or malformed envelope → 4xx; everything else that passes signature (flag off, denied poster/channel/org, unsupported URL, duplicate event) → 200 no-op with a persisted denial reason. Only dispatch failures that are genuinely retriable (DB unavailable) may return 5xx, and only within the ack deadline. Add tests asserting the 200-no-op path for each denial class and the flag-off path.

**B2. Durable dispatch has no named executor.** "Dispatch to a durable retry mechanism using existing job infrastructure if suitable" leaves the single most durability-critical decision unresolved. A DB row with a lease is not durable unless something runs it; `after()` is explicitly ruled insufficient but nothing replaces it.
*Fix:* Before the goal is created, name the runner (cron-triggered worker, the `norma/slack-worker.ts` outbox pattern lifted into a generic table, or an explicit queue), the claim primitive (atomic `UPDATE … WHERE claimed_at IS NULL` or `FOR UPDATE SKIP LOCKED`), reclaim timeout, max attempts, and a hard TTL (e.g. 15 min from `event_time`) after which the event is abandoned—unfurling a stale message hours later is worse than no preview. Add a concurrency test: two workers claiming the same event produce exactly one `chat.unfurl` call.

**B3. Channel eligibility mechanism is deferred rather than designed.** Gate 2 requires server-side authoritative channel verification but the plan only says "include any necessary channel-read scopes." Without `channels:read`/`groups:read` and a `conversations.info` check, the app cannot distinguish an internal channel from a Slack Connect channel, and an approved channel can later become `is_ext_shared`/`is_org_shared` or convert to a shared channel after approval.
*Fix:* Specify: approval stores channel ID + team ID; at unfurl time call `conversations.info` and require `is_channel`/`is_group`, `is_shared=false`, `is_ext_shared=false`, `is_org_shared=false`, `is_im=false`, `is_mpim=false`, and that the channel is still in the approved set; any API error → deny. Subscribe to `channel_shared` (and ideally `channel_converted_to_shared`-class events) to revoke approval automatically. Add the sharing-policy caveat that Slack notifications, search, message forwarding and email digests can carry unfurl text beyond the channel view.

**B4. Installation revocation is stated as a state but has no trigger.** Gate 1 lists "reconnect/revocation state" but the plan subscribes only to `link_shared`.
*Fix:* Subscribe to `app_uninstalled` and `tokens_revoked` and mark the installation revoked; additionally treat `invalid_auth`, `token_revoked`, `account_inactive` API errors on `chat.unfurl` as revocation and stop retrying. Test that a revoked installation produces no preview and no retry loop.

## Required (non-blocking) fixes

- **R1. URL canonicalization.** Gate 5 should state the exact rule: scheme `https`, host equal to `sandra.bmhgroupkc.com` (lowercase, no port, no userinfo), path exact-matched, query/fragment ignored for lookup but the *original* string used as the `chat.unfurl` key. Reject anything else, including superdomain look-alikes. Cap links per event (e.g. 5) and unfurls per message; drop the event if exceeded.
- **R2. Open redirect on login continuation.** Gate 7 "preserve the link across login" must validate the post-login target as a same-origin relative path. Add a test with an absolute/protocol-relative URL.
- **R3. Poster identity.** State that the Slack user in the event must resolve to an active Sandra membership via the authenticated account link only; bot users, deactivated Slack users, and email-based matching are denied. Include a test for a Slack user whose linked Sandra account was deactivated.
- **R4. Data hygiene.** Add: never log rendered preview content or message excerpts; dedupe/attempt rows get a retention/cleanup rule; timestamps in the preview use the organization's timezone, not UTC or server local.
- **R5. Sequencing of Gate 7.** Selected-lead URL state plus login continuation, filter and ownership handling is a separate feature with its own risk. Sequence it as the first implementation step with its own tests, so the unfurl work can target a known-good deep link rather than both landing together.

## Non-issues confirmed

Signature-before-parse including `url_verification`, exclusion of composer events, snapshot-only rendering, `plain_text` for user content, reuse of `queries.ts` eligibility and `inbox-detail-data.ts` disposition, and the explicit refusal to infer owner-switching from the URL are all correct. The "both approvals" gate is honored: this is one review, not two.

Return a revised plan addressing B1–B4 (and ideally R1–R5) and I will re-review the changed sections only.

## Revision 2 review

**Verdict: REQUEST_CHANGES** (narrow; B1–B4 and R1–R5 are otherwise resolved, and the at-least-once statement is accurate — do not add stronger guarantees).

**Blocking residual defects**

1. **Receipt/enqueue atomicity (B1↔B2 gap, can lose work).** Rev 2 defines unique `(team_id,event_id)` receipts and "commit durable enqueue before 200" but not that they are one atomic write. If the receipt commits and the job insert fails, Slack's retry hits the duplicate path and gets 200 no-op → permanent loss, violating gate 4.
   *Fix:* make the receipt row and the job row a single transaction (or make the receipt the job row); return 503 only when that single commit fails; add a test for "receipt inserted, job insert fails, retry re-enqueues."

2. **"Per-URL successes without repeating unrelated successful URLs" contradicts chat.unfurl semantics.** chat.unfurl is one call per message (`channel`/`ts` or `unfurl_id`) with a map of URLs; success/failure is per call, not per URL, and a later call with a subset may replace the earlier set. Partial resends risk dropping already-rendered previews or retrying nothing.
   *Fix:* define the delivery unit as the message; every attempt (including recovered claims) sends the full map of currently-authorized/resolvable URLs from a fresh snapshot; per-URL state records only lookup/authorization outcome, never partial delivery. Verify against the chat.unfurl docs listed and test "retry resends complete map."

3. **R3 poster binding mechanism unspecified.** The plan requires an authenticated account link bound to team/app and forbids email matching, but names no flow or storage; the existing `users:read.email`-based connection is exactly the shortcut being prohibited, so the rule is currently unenforceable.
   *Fix:* specify the link flow (initiated from an authenticated Sandra session, state bound to that session, stores `team_id` + `app_id` + Slack `user_id` + Sandra user/org, versioned with the installation) and state that pre-existing email-derived links are not valid for preview authorization until re-linked.

**Non-blocking (no change required):** confirm the Vercel plan supports `*/1` cron before relying on it as the durability path; define `/my-leads` lead query param name and trailing-slash/UUID-case canonicalization in gate 7's implementation.

## Revision 3 review

Reviewed plan SHA-256: `1e816220466730d7bf5ada4879184c9dafa6a1e90ef592bab6a847241e5d3e53`.

**APPROVE**

All three residual blockers from my second review are resolved in Revision 3, and I found no unresolved contradictions once Revision 3's explicit supersession is applied.

**1. Receipt/enqueue atomicity — resolved.** Single SQL RPC transaction inserting the unique `(team_id, event_id)` receipt and the message job together, with full rollback on failure; no success receipt is ever recorded before the job exists; duplicates are acknowledged only when the durable job exists or the receipt is a terminal no-op; inconsistent legacy receipts are repaired/enqueued transactionally rather than causing Slack's retry to be swallowed. The test list (injected job-insert failure after receipt insert → rollback → successful re-enqueue on Slack retry) covers the failure mode I raised. This composes correctly with Revision 2's B1 rule that denial-logging failure must not produce a 5xx, since denial receipts are terminal no-ops, not success receipts.

**2. Message-wide delivery vs. partial per-URL state — resolved.** The delivery unit is now the whole posted message: one `chat.unfurl` call per attempt with the complete map of currently authorized/resolvable supported URLs from a fresh snapshot; per-URL state holds only lookup/authorization results; success completes the job; transient failure retries the whole map; all-denied finishes as a no-op; retry tests assert every eligible URL key remains present. This eliminates the partial-map overwrite hazard and stays consistent with Revision 2's at-least-once and snapshot semantics. Revision 2's "per-URL delivery state" and "handle per-URL successes without repeating unrelated successful URLs" language is superseded by this section per the stated override rule.

**3. Explicit authenticated OAuth account-link flow — resolved.** Initiated only by a signed-in Sandra user selecting an active org they're authorized for; signed, expiring, single-use state bound to session user, org, and flow purpose; callback re-verifies user and active membership before exchange; stores Slack-returned `team_id`/`app_id`/`authed_user.id` with the Sandra user/org atomically against the encrypted bot-token installation version; refuses absent/ambiguous identity or mismatched app; legacy links (including email-derived) carry no preview authority until re-linked; email is never a binding key. Test coverage (identity/session/org mismatch, replay/expiry, missing IDs, cross-org, reconnection version change) matches the gap.

**4. Added operational rule — consistent.** Proving the Vercel plan actually executes the one-minute cron before enabling is a correct precondition for the Revision 2 durability claims. Canonical CTA `/my-leads?lead=<lowercase UUID>`, no trailing slash on strict posted paths, case-insensitive UUID acceptance with normalization, and same-origin-only login continuation are all consistent with R1 and gate 7.

**Non-blocking editorial notes (no plan change required):**
- When consolidating into the final goal text, strike Revision 2's "per-URL delivery state" / "per-URL successes" phrases so implementers don't read a stale alternative.
- Revision 3 §3 ties each account link to "the encrypted bot-token installation version." Implementers should confirm during the installation/policy step that a user re-linking does not itself mint a new installation version (which, under B4, would cancel pending jobs); this is an implementation-time verification, not a plan defect.

Gate satisfied from Fable's side. Astra's approval is still required before creating the implementation goal.
