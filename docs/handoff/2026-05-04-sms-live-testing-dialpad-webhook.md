# Handoff — 2026-05-04 SMS live testing + Dialpad webhook gap

## 1. Current state
- **Branch:** `main` (all work committed directly to main)
- **Working tree:** clean (only untracked .claude/, docs/, scripts/)
- **Prod URL:** `https://sandra-sooty.vercel.app`
- **Latest commit:** `a172e5f` — move SMS thread to top of detail page

## 2. What shipped this session

| Commit | Title | Effect |
|---|---|---|
| `81cd3d7` | feat(leads): template picker in Send SMS modal | Server-side renders SMS templates with property vars; select injects rendered body into textarea; picker resets after selection |
| `e77175b` | feat(sms): remove consent gate + add import attestation | send.ts now only blocks `opted_out` contacts (not `no_consent`); "Record written consent" button removed from composer UI; import confirm step has SMS consent attestation checkbox; workflow bulk-records consent after ingest |
| `a172e5f` | feat(leads): move SMS thread to top of detail page | SMS thread (MessagesThread + InlineReply) moved to right column beside Property; Identifiers section moved to bottom |

## 3. Key infrastructure changes
- **`src/lib/messaging/send.ts`**: Consent check changed from `!== "can_send_marketing"` to `=== "opted_out"` in both `sendSmsToContact` and `releaseQueuedMessage`. Only explicit opt-outs are blocked.
- **`src/app/(dashboard)/leads/[id]/sms-composer.tsx`**: Removed `captureConsent` import, `capturing` state, `capture()` function, and "Record written consent" button. Backend plumbing in `leads/actions.ts` untouched.
- **`src/app/(dashboard)/import/steps/step-confirm.tsx`**: Added SMS consent attestation checkbox (native `<input type="checkbox">`).
- **`src/app/(dashboard)/import/wizard.tsx`**: Added `smsConsent: boolean` to `WizardState`, `WizardAction`, reducer, and passed to `createImportJob`.
- **`src/app/(dashboard)/import/actions.ts`**: `CreateImportJobParams` now includes `smsConsent: boolean`; threaded into workflow start params.
- **`src/workflows/csv-import.ts`**: Added `recordConsentStep` — after finalize + CASS trigger, if `smsConsent=true`, bulk-inserts `opt_in_marketing_written` for all homeowner contacts in the import (skips opted-out contacts).
- **`src/app/(dashboard)/leads/[id]/page.tsx`**: Fetches templates + renders with `loadTemplateVars`; admin client moved to outer scope and shared; SMS thread moved into 2-col grid right column; Identifiers moved to bottom.

## 4. Memory updates
No memory files modified this session.

## 5. What's in flight — NEXT UP

**CRITICAL: Dialpad inbound SMS webhook is not configured.**

Real homeowner replies are going into Dialpad but never reaching Sandra. Confirmed by querying `webhook_events` — every entry has `CANARY-` prefix (all synthetic test events). No real inbound ever recorded.

**Root cause:** The Dialpad webhook + inbound SMS subscription was never created via API. Dialpad has **no admin UI** for webhooks — it's API-only.

**What needs to happen:**
1. Verify `DIALPAD_API_KEY` and `DIALPAD_WEBHOOK_SECRET` are set in Vercel prod env vars
2. Call `POST https://dialpad.com/api/v2/webhooks` with `hook_url=https://sandra-sooty.vercel.app/api/webhooks/dialpad/sms` and the shared secret
3. Call `POST https://dialpad.com/api/v2/sms_event_subscriptions` with the returned `webhook_id` and `sms_direction=inbound`

**Dialpad API docs:**
- Webhooks: `https://developers.dialpad.com/reference/webhookscreate`
- SMS event subscriptions: `https://developers.dialpad.com/docs/sms-events`

**To check env vars in Vercel:**
```bash
vercel env ls --environment=production
```

## 6. Known not-done
- Dialpad inbound webhook not yet registered (the #1 blocker — see above)
- 3 messages still in `queued` status in the outbox (2507 NE Quail Walk CT, 1528 NW 800TH RD, 1109 NE Quail Walk DR) — need Send Next / Auto-send
- E2E Playwright tests never run on direct-to-main pushes (workflow only triggers on PRs)
- Import attestation checkbox uses native `<input type="checkbox">` — no shadcn Checkbox component exists in this project yet

## 7. Test credentials
- **Jarrad's test phone:** +13107540662 (SMS smoke — never smoke real leads)
- **Twilio test receiver:** +18148097074 (inbound-only canary; never a sender)
- **Prod SMS number:** +18162804181 (BMH Group — the `from` number for all outbound)

## 8. Verification after webhook is registered
```bash
# 1. Confirm webhook events table starts receiving real inbound events
# (after a homeowner replies to one of today's sent messages):
# Check: messages table for direction='inbound' with non-555 from_address

# 2. Typecheck + tests
npm run verify

# 3. Manual: open any lead detail, confirm SMS thread is in right column beside Property
# open https://sandra-sooty.vercel.app/leads/<any-id>
```

## 9. Critical learnings
- **Dialpad webhooks are API-only** — no admin.dialpad.com UI for webhook configuration. Must use `POST /api/v2/webhooks` then `POST /api/v2/sms_event_subscriptions`.
- **All inbound webhook events so far are synthetic canary events** — `webhook_events` table has never received a real Dialpad inbound from a homeowner. This was the root cause of "no responses received."
- **Consent gate removed** — the send path no longer requires `can_send_marketing`; only `opted_out` blocks. Import attestation checkbox bulk-records consent at import time.
- **`@sandra/tokens` is a local file: reference** — never re-add to `package.json`. Warm-paper tokens live inline in `globals.css` `:root {}` block.
