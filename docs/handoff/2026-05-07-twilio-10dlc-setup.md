# Twilio 10DLC Setup + DialPad→Twilio Migration — Handoff

**Date:** 2026-05-07
**Worktree:** `/Users/jarradhenry/Sites/Sandra/.claude/worktrees/twilio-10dlc`
**Branch:** `worktree-twilio-10dlc`
**Status:** mid-execution — Customer Profile created, blocked on user clicks in Twilio Console

---

## What this is

Multi-step setup to register **The BMH Group LLC** for Twilio A2P 10DLC SMS, then migrate Sandra's outbound SMS provider from **DialPad → Twilio** under the new LLC.

The trigger: Jarrad just formed a Wyoming LLC specifically to handle the Twilio relationship cleanly under the business entity (rather than under his personal account that's been hosting the DialPad outbound for testing).

---

## Critical facts (load-bearing for TCR)

| Field | Value |
|---|---|
| Legal name | `The BMH Group LLC` |
| IRS spelling (CP-575) | `THE BMH GROUP LLC` |
| EIN | `42-2369546` |
| Name control | `THEB` |
| Formation state | Wyoming |
| Filed | **2026-05-06** (1 day old as of handoff) |
| Address | 30 N Gould St Ste N, Sheridan, WY 82801 |
| Wyoming Original ID | `2026-001970163` |
| Sole member | Jarrad Henry (jarrad@bmhgroupkc.com, 816-280-4181) |
| Website | https://bmhgroupkc.com |
| **Privacy policy URL** | **https://bmhgroupkc.com/privacy-policye01a0d67** |
| Twilio Account SID | `AC0838435b60db0dbaa07b6d7642046cb5` |
| Twilio test receiver (existing) | `+18148097074` (canary inbound only — DO NOT reuse for production) |

**Operating docs (formation PDFs, EIN letter):** `/Users/jarradhenry/Sites/Sandra/docs/operating/` — gitignored, contains PII.
**Tailor Brands credentials:** `/Users/jarradhenry/Sites/Sandra/.secrets/tailor-brands.env` — gitignored.

---

## What's done (chronological)

1. ✅ **Codebase audit** — confirmed Sandra's outbound is DialPad (`src/lib/messaging/providers/dialpad.ts`); Twilio is set up as inbound test-receiver only (`src/lib/messaging/providers/twilio-receiver.ts`). Vendor abstraction at `src/lib/messaging/registry.ts:26` has a commented-out `case "twilio"` waiting for a real `TwilioMessagingProvider`. Database `messages.provider` already accepts `'twilio'`.

2. ✅ **Research wave** — 4 research docs in `.planning/research/` (at main repo path):
   - `2026-05-07-twilio-10dlc-registration.md` — full registration playbook
   - `2026-05-07-10dlc-use-case-and-samples.md` — use-case category + samples
   - `2026-05-07-sendblue-vs-twilio.md` — analyzed iMessage alternative, recommended against
   - `2026-05-07-twilio-trust-hub-flow.md` — exact post-upgrade Trust Hub flow
   - `2026-05-07-tailor-brands-playwright.md` — Duda editor automation research (used for the privacy policy edits)

3. ✅ **Privacy policy compliance edits** at https://bmhgroupkc.com/privacy-policye01a0d67:
   - Header entity: `BMG Group` (typo!) → `The BMH Group LLC`
   - Third-party clause (×2 instances): rewritten to TCR-verbatim *"Mobile information will not be shared with third parties or affiliates for marketing or promotional purposes"*
   - SMS opt-in section: full TCPA disclosure with `The BMH Group LLC`, "automated technology", "Message frequency varies", Reply STOP, Reply HELP, contact phone
   - Contact placeholder `[Insert contact email]` → `info@bmhgroupkc.com`
   - **Verified live** via curl (multiple compliance phrases counted on live URL)
   - **Note:** The clean URL `/privacy-policy` is an orphan stale page in Tailor Brands that user couldn't find/delete. The compliant URL is the hashed `/privacy-policye01a0d67` — that's the URL TCR gets.

4. ✅ **Twilio account upgraded out of trial** — Persona KYC done (Jarrad personal), Customer Profile created with LLC info during upgrade, $50 balance loaded, status Active.

5. ✅ **Worktree created** — work isolated in `.claude/worktrees/twilio-10dlc` to avoid racing other agents on main.

6. ✅ **Gitignore protections committed to main** (`0ae25f6`):
   - `/.secrets/` — credentials, storage state, artifacts
   - `/docs/operating/` — formation docs, EIN letter, contracts (PII)

---

## What's pending — execution plan

### Today (immediately)

**A) Submit Customer Profile for review**
URL: `https://console.twilio.com/us1/account/trust-hub/customer-profiles`
Action: click into BMH profile → click `Submit for review`. Approval typically 30 min – 4 hr.

**B) Buy a Kansas City 816 phone number**
URL: `https://console.twilio.com/us1/develop/phone-numbers/manage/search`
Action: filter to area code 816, capabilities SMS+MMS only (uncheck Voice + Fax), buy 1 number ($1.15/mo).
Why 816: matches BMH's actual KC operating market; better local-presence on outbound.
Why not the trial test receiver `+18148097074`: keep that as canary inbound only.

**C) Register Standard Brand**
URL: `https://console.twilio.com/us1/develop/sms/regulatory-compliance/a2p-onboarding`
Tab: `Brand` → `Register a new Brand` → pick **Low-Volume Standard** ($4, no $40 vetting needed at sub-200/day). Will queue behind Customer Profile approval.

**D) Register Low Volume Mixed Campaign** — see paste-ready content below.

### Code work (parallel, doesn't need Twilio approval)

**E) Implement `TwilioMessagingProvider`**
- File: `src/lib/messaging/providers/twilio.ts`
- Mirror the shape of `src/lib/messaging/providers/dialpad.ts`
- Implement the `MessagingProvider` interface from `src/lib/messaging/types.ts`
- Outbound: Twilio REST API `POST /2010-04-01/Accounts/{AccountSid}/Messages.json`
- Inbound webhook signature verification: already exists in `src/lib/messaging/providers/twilio-receiver.ts` — extract those helpers
- Inbound payload parser: already exists in `twilio-receiver.ts`

**F) Un-comment registry case**
- `src/lib/messaging/registry.ts:26` — currently `// case "twilio": return twilioFromEnv();`

**G) Add env vars**
- `.env.example`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (or `TWILIO_MESSAGING_SERVICE_SID` once the messaging service is created)
- Vercel preview env: real Twilio credentials for integration testing
- Vercel prod: do NOT set yet — keep `MESSAGING_PROVIDER=dialpad` until brand+campaign approved

**H) Inbound webhook route**
- New route at `src/app/api/webhooks/twilio/sms/route.ts` (mirror the DialPad webhook route at `src/app/api/webhooks/dialpad/sms/route.ts`)
- Twilio webhooks are form-encoded with `X-Twilio-Signature` HMAC-SHA1 header

**I) Tests**
- Unit tests for `TwilioMessagingProvider` (mirror `dialpad.test.ts`)
- Integration test: send-receive round-trip via Twilio test number `+18148097074`

### Cutover (later, when brand+campaign approved)

**J) Flip env var in Vercel prod:** `MESSAGING_PROVIDER=dialpad` → `MESSAGING_PROVIDER=twilio`
**K) Run smoke tests** in prod (existing scripts: `smoke-sequences-prod.ts`, `smoke-ai-responder-*.ts` — will need Twilio variants)
**L) Sunset DialPad** — keep credentials around for ~30 days as rollback option

---

## Paste-ready content for Twilio forms

### Brand registration — Low-Volume Standard

| Field | Value |
|---|---|
| Brand type | Low-Volume Standard |
| Legal business name | `The BMH Group LLC` |
| DBA / Brand name | `BMH Group` |
| Country of registration | United States |
| EIN | `42-2369546` |
| Business identity | Direct Customer |
| Vertical | Real Estate |
| Business type | Limited Liability Company (LLC) |
| Stock exchange | (skip — private) |
| Website | `https://bmhgroupkc.com` |
| Brand support email | `jarrad@bmhgroupkc.com` |
| Brand support phone | `+18162804181` (your operating BMH number, not the Twilio one) |
| Address | 30 N Gould St Ste N, Sheridan, WY 82801 |

### Campaign — Low Volume Mixed

**Campaign description** (paste-ready):
> The BMH Group LLC, a Kansas City–based real estate investment company, sends customer-care messages to property owners who responded to outreach (mail, web form, or referral) and to opted-in licensed real estate agents about active investment opportunities. Messages include lead-response replies, follow-ups on prior conversations, appointment confirmations, and B2B deal alerts to agent partners. All recipients have either initiated contact, opted in via the company website, or are licensed agents in an established business relationship.

**Sample messages** (5 — all under 160 chars, all include brand + STOP + HELP-where-applicable):

1. *(Inbound response):*
   `Hi {first_name}, this is {agent} with BMH Group. Thanks for your reply on {address}. When's a good time for a quick call? Reply STOP to opt out, HELP for help.`

2. *(Follow-up to prior conversation):*
   `Hi {first_name}, BMH Group here following up on {address}. Still interested in a cash offer? Reply STOP to opt out.`

3. *(Offer update):*
   `Hi {first_name}, BMH Group sent your offer for {address} to your email. Let us know if you have questions. Reply STOP to opt out.`

4. *(Appointment confirmation):*
   `Hi {first_name}, confirming your walkthrough at {address} on {date} at {time} with BMH Group. Reply STOP to opt out, HELP for help.`

5. *(B2B agent alert):*
   `Hi {first_name}, BMH Group has a cash offer ready for {address}. Active local buyer, close fast, full co-op. Reply STOP to opt out.`

**Opt-in description** (paste-ready):
> Recipients opt in through three documented paths: (1) submitting the contact form at bmhgroupkc.com which includes explicit SMS consent language and a checkbox; (2) replying to direct mail with the BMH phone number, indicating intent to engage; (3) licensed real estate agents in established business relationships with BMH for deal coordination. Privacy policy: https://bmhgroupkc.com/privacy-policye01a0d67

**HELP auto-response:**
> BMH Group: For help, contact 816-280-4181 or info@bmhgroupkc.com. Reply STOP to unsubscribe. Msg & data rates may apply.

**STOP auto-response:**
> You are unsubscribed from BMH Group messages. No further messages will be sent. Reply HELP for help.

---

## Known issues / blockers

### 🚩 1-day-old EIN — TCR verification will likely fail first submission

TCR's verification database lags the IRS Business Master File by 14-30 days. EIN was issued 2026-05-06; today is 2026-05-07. Brand registration will probably fail with `TAX_ID_MISMATCH`.

**Recovery path:**
1. Submit brand registration anyway today (keeps the queue position)
2. When/if it fails, immediately open a Twilio support ticket
3. Attach: `docs/operating/TheBMHGroupLLC_ein_federal.pdf` (CP-575 letter) + `docs/operating/TheBMHGroupLLC_form-a-company_wyoming.pdf` (Articles)
4. Request: "Identity Status Appeal" — 5-7 business day turnaround
5. Twilio will manually re-verify against the documents

This is documented behavior, not a real failure. Plan around it.

### 🚩 Privacy policy lives at hashed URL

The clean `/privacy-policy` is an orphan stale page in Tailor Brands. The compliant policy lives at `/privacy-policye01a0d67`. Submit the hashed URL to TCR. Don't fight Tailor Brands today — orphan cleanup is a future task.

### 🚩 Brand-website name match

Website footer + privacy policy header use "The BMH Group LLC" or "BMH Group" — verified. Homepage hero shows "BMH" logo. Should pass TCR's brand-name match, but flag if reviewer is strict.

---

## File map

| Path | Purpose |
|---|---|
| `.claude/worktrees/twilio-10dlc/` | This worktree |
| `.claude/worktrees/twilio-10dlc/scripts/edit-tailor-brands-privacy.ts` | Playwright script for Tailor Brands edits (reference; user did edits manually in the end) |
| `.claude/worktrees/twilio-10dlc/docs/handoff/2026-05-07-twilio-10dlc-setup.md` | This handoff doc |
| `/Users/jarradhenry/Sites/Sandra/.planning/research/2026-05-07-*.md` | 5 research docs (at main path, not worktree) |
| `/Users/jarradhenry/Sites/Sandra/docs/operating/` | LLC formation docs + EIN letter (gitignored) |
| `/Users/jarradhenry/Sites/Sandra/.secrets/tailor-brands.env` | Tailor Brands login (gitignored) |
| `/Users/jarradhenry/Sites/Sandra/.secrets/tailor-brands-state.json` | Playwright session state (gitignored) |

---

## Decision history (locked)

| Decision | Choice | Why |
|---|---|---|
| SMS provider | Twilio (vs SendBlue) | Research showed SendBlue $100 tier doesn't support cold outbound; Enterprise tier $250-300/line; Apple-ban risk; no community adoption among wholesalers |
| Brand tier | Low-Volume Standard ($4) vs full Standard ($44) | Volume sub-200/day; LV-Standard same trust-class brand at lower cost; can upgrade later |
| Campaign use case | Low Volume Mixed (NOT Marketing) | Marketing category is highest rejection rate for cold outreach; Low Volume Mixed is broader, $2/mo, 75 segments/min throughput |
| Sole Prop vs Standard Brand | Standard Brand (EIN-based) | Sole Prop limits to 1 number, ~3000 msgs/day; LLC submitted as Sole Prop is auto-reject |
| Phone area code | 816 (KC) | Matches BMH's actual operating market; better local-presence on outbound; trial number 814 (PA) is canary-only |
| Migration strategy | Build adapter today; flip env var when registered | Unregistered Twilio sending is filtered to oblivion by carriers; DialPad stays live until Twilio brand+campaign approved |
| Worktree isolation | Yes | Other agents working on main; avoids .git/index races |
