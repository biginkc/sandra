# Sendillo Adapter Status

Date: 2026-06-08
Repo: `/Users/jarradhenry/Sites/BMH apps/Sandra`

## Scope Closed In Code

- `sendillo` was added behind Sandra's existing messaging-provider seam.
- Inbound webhook handling was factored into one shared provider-neutral core.
- Inbound routing no longer falls back to "latest outbound wins" for property selection.
- Inbox threading now prefers `messages.conversation_id` and falls back to a legacy `contact + property` thread id only for older rows.
- Dialpad, Twilio, and Sendillo webhook routes now resolve route-specific providers instead of reusing whichever outbound provider is configured globally.

Key files:

- `src/lib/messaging/providers/sendillo.ts`
- `src/lib/messaging/inbound.ts`
- `src/lib/messages/threading.ts`
- `src/lib/messages/list-threads.ts`
- `src/lib/messaging/send.ts`
- `src/app/api/webhooks/sendillo/sms/route.ts`

## Official-Docs Evidence Used

Public Sendillo sources checked during this lane:

- `https://www.sendillo.com/api/v1/openapi`
- `https://www.sendillo.com/developer/guides`
- `https://www.sendillo.com/api/developer/webhooks` (unauthenticated probe)

Confirmed from official public docs:

- bearer-auth outbound messaging API
- outbound endpoints under `/api/v1/messages`
- documented webhook event names:
  - `inbound.received`
  - `message.sent`
  - `message.delivered`
  - `message.failed`
- the authenticated webhook-management surface lives at `/api/developer/webhooks`
- unauthenticated access to `/api/developer/webhooks` returns `403` with:
  - `Only company users (Admin, Billing, or General) can configure webhooks.`

Still not proven from public docs:

- exact webhook signature verification contract
- exact production `inbound.received` payload schema
- whether recipient-number and any other routing-critical fields are always present in real deliveries

## Authenticated Evidence Gap

The missing Sendillo webhook details appear to be behind authenticated company-user access, not in the public API spec.

What was attempted:

- public OpenAPI inspection
- public developer-guide asset inspection
- unauthenticated probe of `/api/developer/webhooks`
- 1Password service-account search for a Sendillo login item in the currently accessible vault items

Current result:

- no accessible Sendillo credential item was found through the approved 1Password service-account path in this lane
- no public or unauthenticated endpoint exposed the signature contract or a concrete inbound payload example

Update after authenticated Sendillo access on 2026-06-08:

- a real Sendillo API key now exists in the approved `BMH Secrets` vault item `Sendillio - API`
- Sandra local `.env.local` now has `SENDILLO_API_KEY` and `SENDILLO_FROM_NUMBER` staged
- Sandra Vercel production env now has `SENDILLO_API_KEY` and `SENDILLO_FROM_NUMBER` staged
- `MESSAGING_PROVIDER` was intentionally left unchanged, so Sandra remains on the current live adapter until a deliberate flip
- preview env staging was not completed in this turn because the installed Vercel CLI required an explicit preview-branch target and should not be guessed silently

First authenticated Sendillo account checked in this lane:

- purchased number: `+18162939379`
- brand `Alignment Automated LLC`: `APPROVED`
- campaign `Homeowner Outreach`: `PENDING APPROVAL`
- purchased number `messagingStatus`: `Inactive`

That account proved outbound auth but was not ready to replace Dialpad in production.

Later on 2026-06-08, the API key in `Sendillio - API` was updated to a different Sendillo account and staging was refreshed to match it.

Second authenticated Sendillo account checked in this lane:

- purchased number: `+18164730750`
- brand `BMH Group`: `APPROVED`
- campaign `Kansas City Metro SMS Outreach`: `APPROVED`
- purchased number `messagingStatus`: `Active`

Later on 2026-06-08, the account added a replacement sender and the original `+18164730750` line was moved toward release.

Current Sendillo sender inventory for this same account:

- purchased number: `+12073049295`
- brand `BMH Group`: `APPROVED`
- campaign `Kansas City Metro SMS Outreach`: `APPROVED`
- purchased number `messagingStatus`: `Active`
- original number `+18164730750` now shows `messagingStatus: Inactive` and is no longer the correct Sandra sender

Later on 2026-06-08, sender inventory changed again:

- purchased number: `+18164876899`
- brand `BMH Group`: `APPROVED`
- campaign `Kansas City Metro SMS Outreach`: `APPROVED`
- purchased number `messagingStatus`: `Active`
- temporary sender `+12073049295` moved to `numberStatus: PENDING RELEASE`
- unassigned number `+18163780213` is `numberStatus: Active` but `messagingStatus: Inactive`, so it is not a valid Sandra sender

Current intended Sandra sender:

- `SENDILLO_FROM_NUMBER=+18164876899`

That means Sandra is now staged against a Sendillo account that appears outbound-ready. The live adapter still must not be flipped until inbound webhook proof is captured and reviewed.

## Inbound Cutover Gate

**Sendillo inbound is intentionally NOT cut over.**

The adapter keeps `verifyWebhookSignature()` hard-false until the real Sendillo webhook verification contract is confirmed from authenticated docs or a captured live delivery. That means the Sendillo webhook route exists, but production inbound should be treated as gated proof-only work until the following are captured:

1. signature/header contract
2. exact inbound payload body
3. recipient-number field needed for property routing
4. stable provider message id semantics for replay/idempotency

Do not remove that gate just because the route exists.

## PR Review Rule For This Lane

Every PR that advances this Sendillo replacement lane must end with manual code review before merge readiness is claimed.

Minimum review focus for each PR:

- provider/route isolation
- inbound routing correctness
- consent/STOP/DNC behavior
- idempotent webhook replay handling
- inbox thread separation for one contact across multiple properties
- regression coverage for any changed adapter or webhook surface

## Verification Already Run

- `npm run typecheck`
- `npm run test -- 'src/lib/messages/list-threads.test.ts' 'src/lib/messaging/providers/sendillo.test.ts'`
- `npm run test:rtl -- 'src/app/(dashboard)/messages/cockpit-view.test.tsx' 'src/app/(dashboard)/messages/inbox-detail.test.tsx'`
- `npm run test:integration -- 'src/lib/messages/list-threads.integration.test.ts' 'src/lib/messaging/send.integration.test.ts' 'src/app/api/webhooks/dialpad/sms/route.integration.test.ts'`

Follow-up reruns after route/provider isolation fixes:

- `npm run test -- 'src/lib/messaging/providers/sendillo.test.ts'`
- `npm run test:integration -- 'src/app/api/webhooks/dialpad/sms/route.integration.test.ts'`

## 2026-06-08 Manual Review Closeout

Review-driven hardening completed after the first Claude review packet and a second local manual review pass.

What changed after the earlier handoff:

- real Sendillo inbound now runs behind a shared-secret gate instead of the earlier hard-false block
- inbound message retries now reserve `webhook_events` as `pending`, mark `processed` only after work completes, and use a unique inbound `(provider, external_id)` message index to stop duplicate message rows
- STOP/DNC now opt out every matching contact phone even when property/contact threading is ambiguous
- recipient-number routing now resolves the property thread from the actual `to` number instead of "latest outbound wins"
- queued-message release now refuses provider flips and obsolete Sendillo sender numbers
- queued-message release claim is now atomic at the `queued -> pending` update step, so two workers cannot both send the same queued row
- resumed duplicate inbound rows now short-circuit before owner notifications or AI replies can fire twice
- non-duplicate inbound insert failures now return `500` instead of `200`, so provider retries remain possible instead of silently losing the inbound
- outbound and inbound address fields are normalized on write so recipient-number routing is not dependent on one env var already being in E.164 format

Test-project schema state repaired for this lane:

- `sandra-crm-test` had drifted: the live test schema still rejected `provider='sendillo'` and lacked the inbound unique index even though remote migration history had already recorded `062`
- the lane was unblocked by applying the corrected SQL packet from `supabase/migrations/062_sendillo_provider_and_inbound_idempotency.sql` directly to `sandra-crm-test`
- local migration `062` was corrected before that apply so `jobs_provider_check` preserved existing `mock` and `tracerfy` values while adding `sendillo`

Manual review findings that were accepted and fixed:

- migration `062` initially dropped valid existing `jobs.provider` values
- `releaseQueuedMessage()` could let two workers both think they claimed the same queued row
- inbound write failures were ACKed with `200`, which could silently lose inbound SMS

Manual review findings left as explicit residual gaps:

- Sendillo still has no verified provider-primary signing contract; query-param shared secret remains a fallback and leaks into access logs
- if a webhook attempt inserts the inbound row and then crashes during downstream side effects, a resumed retry now favors "do not double-send notifications/AI" over "re-run every side effect"; that tradeoff is intentional for now but not a perfect exactly-once design
- keyword branches can still append duplicate audit rows on a resumed STOP/DNC replay because compliance-side opt-out is intentionally applied before the message insert branch decides whether the inbound row is a duplicate
- migration `062` assumes the target DB does not already contain duplicate inbound `(provider, external_id)` rows; if prod already has duplicates, the unique index creation would need a cleanup step first

Latest focused verification after the review fixes:

- `npm run test -- 'src/lib/messaging/providers/sendillo.test.ts'`
- `npm run typecheck`
- `npm run test:integration -- 'src/app/api/webhooks/sendillo/sms/route.integration.test.ts' 'src/app/api/webhooks/dialpad/sms/route.integration.test.ts' 'src/lib/messaging/send.integration.test.ts'`

Latest result:

- 28/28 focused integration tests passed
- 13/13 Sendillo unit tests passed
- typecheck passed
