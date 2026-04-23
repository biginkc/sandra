# REsimpli Feature Inventory & Sandra Gap Analysis

**Source**: `https://help.resimpli.com/en/` (REsimpli's public Intercom-hosted help center)
**Captured**: 2026-04-22 via Firecrawl scrape of 12 collection landing pages (~75% of total help-center coverage by article count, focused on CRM-relevant collections; skipped Mastermind Calls, Office Hours Recordings, FAQs, generic Settings/Getting Started).
**Purpose**: catalog REsimpli's surface area so we can cherry-pick features into Sandra without re-researching.

> Note: there's no platform called "DataSift" hosting REsimpli — REsimpli is its own standalone CRM at `resimpli.com`. DataSift was a defunct social-data API; safe to ignore.

---

## How to use this doc

Each feature below has a **Status vs Sandra** flag:

- 🟢 **Have it** — Sandra already ships this (don't re-research).
- 🟡 **Partial** — Sandra has the foundation; REsimpli has more depth.
- 🔴 **Gap** — not in Sandra at all; candidate to build.
- ⚪ **Skip** — known-out-of-scope for BMH wholesale workflow.

The "Build effort" estimates assume Sandra's existing patterns (jobs queue, vendor adapters, Result<T> server actions, shadcn UI, RLS).

---

## 1. Leads / pipeline

REsimpli help-center collection: `3427455-leads` (32 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Kanban + custom columns/statuses | 🟡 Partial | Sandra has 8-status kanban; REsimpli lets users add columns. We chose flat enum deliberately — leave alone. |
| Lead detail page with tabs (Details, Dispo, Files, Tasks/Appts, Portfolio, Teams, Action button) | 🟡 Partial | Sandra has the page. Need: Files, Tasks, Activity Log tabs. |
| Lead Exit Type (granular reason on dead/closed) | 🔴 Gap | Add `lead_exit_type` enum column (e.g., `not_motivated`, `price_too_high`, `sold_to_other`, `unreachable`, `wrong_number`). |
| SOW (Scope of Work) field | 🔴 Gap | Rehab estimate field on lead. Could be a free-text or a structured sub-table (line items × cost). Start with free text. |
| Manual tasks + appointments with kept/not-kept marking | 🔴 Gap | New `tasks` table linked to property + assignee + due date + outcome. Calendar view later. |
| Seller meeting reminder templates | 🔴 Gap | Templated SMS/email auto-sent N hours before appointment. |
| Bulk assign/unassign by role/campaign | 🟡 Partial | Sandra's open seam — single-lead assign already in plan; bulk variant is +30 min once assignment exists. |
| Active + Dead lead exports (CSV) | 🔴 Gap | Server action returning CSV stream. ~1 hr. |
| Web-form lead intake (custom intake forms) | 🔴 **Gap (high value)** | Today Sandra is CSV-only. Add signed POST endpoint + minimal form-builder. Maps to `properties` + `homeowner_contact`. ~3 hr for the API + form-builder later. |
| Contingency tracking on transactions | 🔴 Gap | Sub-table of contingency items per under-contract deal. Defer until offers feature lands (Risk #7). |
| Transaction Management pipeline (separate from sales pipeline) | 🔴 Gap | Sandra collapses both into the property status enum. Risk #7 already documents this trade-off; revisit when first deal closes through Sandra. |

---

## 2. Drip campaigns

REsimpli collection: `3427465-drip-campaign` (8 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Triggered drip on new lead arrival | 🔴 **Gap (highest ROI)** | Sandra's queue is manual ("Send Next"). Add `drip_campaign` + `drip_step` + `drip_enrollment` tables; cron worker advances step by step; respects existing TCPA + quiet hours. ~4–6 hr. |
| Audience-specific flows (Sellers / Buyers / Vendors / Sold) | 🔴 Gap | Same tables, different `audience` field. |
| Multi-contact-per-lead drip | 🔴 Gap | Step targets a specific role (homeowner / agent / buyer). |
| Status-change triggers | 🔴 Gap | Hook into `properties.status` change → enroll/unenroll. |
| Pause/resume on inbound reply | 🟡 Partial | Sandra opt-out flips `sms_opted_out`; need a softer "pause drip on any inbound" rule. |

---

## 3. AI Agents (REsimpli's newest tier)

REsimpli collection: `13188492-resimpli-ai-agents` (9 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Call Answer AI (inbound AI receptionist) | ⚪ Skip / 🔴 Gap | Replaces voicemail with a voice agent that qualifies callers. Low priority unless inbound volume justifies it; Dialpad handles calls today. |
| Voice Follow AI (outbound AI calling, plugs into drips) | 🔴 Gap | A drip step that triggers an outbound voice agent (ElevenLabs / Vapi / Bland.ai). Big lift; defer. |
| Speed To Lead AI (instant AI callback to web-form leads) | 🔴 Gap | Sub-minute callback when a web form fires. Pairs naturally with the web-form intake. |
| Call Grade AI (call-quality scoring on recordings) | 🔴 Gap | Useful once you have multiple VAs making calls. Whisper transcript + LLM rubric. |

---

## 4. KPI dashboards

REsimpli collection: `13188518-kpi-dashboards` (7 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Goal setting + Goal tracker | 🔴 Gap | Per-VA + team-level numeric goals (calls, SMS, leads worked, deals). |
| CEO dashboard | 🔴 Gap | Top-line: pipeline value by stage, deals YTD, marketing spend vs deals. |
| Individual + Individual comparison dashboards | 🔴 Gap | Per-VA leaderboard. |
| Lead-source comparison | 🔴 Gap | ROI per source (PropStream, DealMachine, web, D4$). |
| Campaign comparison | 🔴 Gap | If campaigns become a first-class concept (they aren't yet in Sandra). |

Build approach: a `metrics` view layer on top of `properties`, `messages`, `consent_events`, `jobs`. Recharts/visx for charts. Defer until 2 VAs have been on the system for ~30 days so there's data to chart.

---

## 5. Buyers & Disposition Management ⭐

REsimpli collection: `12918628-buyers-disposition-management` (21 articles). **The single biggest gap in Sandra.**

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Buyers/Agents database with import | 🔴 **Gap (high value)** | Add `buyer_details` sidecar (already in deferred list) + CSV import wizard branch. |
| Cash Buyers feature (match buyers to listings) | 🔴 Gap | Buyer profile has buy-box (markets, price range, beds, condition); listings auto-match. |
| Bulk SMS to buyers from local-area-code numbers | 🔴 Gap | Sandra's queue is per-property; need a buyer-segment send. |
| Bulk email to buyers | 🔴 Gap | New email vendor adapter (Resend/Postmark/SES). |
| Email marketing module | 🔴 Gap | Templates, segments, unsubscribe handling. |
| Buyers' Inbox + filter options | 🔴 Gap | Threaded buyer comms separate from seller comms. |
| Dispo website per market (theme/font/photo customization) | 🔴 Gap | Public Next.js route per market; CMS-light editing. |
| Listing tab on lead → publish to dispo site | 🔴 Gap | "Mark ready for disposition" → creates a listing record → appears on public site. |
| Offer submission form on dispo site (captures buyer offers) | 🔴 Gap | Form on public listing page → creates offer record → notifies acquisition agent. |
| Video embeds on listings | 🔴 Gap | YouTube/Vimeo embed field. |
| Bulk listing publish/unpublish | 🔴 Gap | Status toggle on listing. |
| Acquisition vs Dispo agent permissions | 🔴 Gap | Tie to RBAC (Risk #14). |

**Effort**: realistic 1–2 days for v1 (buyer model + listing model + public route + bulk SMS reuse). The polish (theming, video embeds, offer-submission flow) adds another day.

---

## 6. Seller marketing website builder

REsimpli collection: `12563484-resimpli-seller-website` (15 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Multi-page public site (hero, city pages, blocks, forms, testimonials) | ⚪ Skip | Sandra is internal CRM, not a marketing site. BMH already has external sites; if you want a builder, use Webflow/Carrot, not us. The web-form intake (Section 1) is the integration point. |

---

## 7. List Stacking + Dialer

REsimpli collections: `3521146-list-stacking` (6 articles), `12864709-list-stacking-dialer` (6 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Upload skip-trace lists, dedupe across lists | 🟡 Partial | Sandra's dedup cascade (FIPS+APN → ZPID → cass-normalized address → fuzzy) likely covers this. List Stacking adds a "list provenance" concept (which list/source the record came from). |
| Transfer record from list → Active Lead | 🔴 Gap | Lightweight gesture: a "stage" of records that aren't yet leads. Could just be a `is_lead` boolean. |
| Direct mail orders from list | ⚪ Skip | BMH uses other vendors for mail; integration not worth building. |
| Power dialer with call scripts visible to agents | 🔴 Gap | Dialpad has a dialer; the value-add is the Sandra-side script + per-call disposition + voicemail-drop. Defer until VAs are doing serious cold-calling. |
| DNC removal on dialer campaigns | 🔴 Gap | Litigator-list / DNC scrub before any outbound. Required for compliance once cold-calling at scale. |
| Notifications on list events | ⚪ Skip | Edge case. |

---

## 8. REsimpli List Builder

REsimpli collection: `13188649-resimpli-list-builder` (1 article — minimal).

⚪ Skip — REsimpli's own data product (their PropStream-equivalent). Out of scope; per memory `project_propstream_plan_tier.md` we use PropStream and DealMachine as data sources.

---

## 9. Phone / messaging infrastructure

REsimpli collection: `3427454-manage-numbers` (14 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Number assignment by role/agent | 🟡 Partial | Sandra fetches Dialpad number owners dynamically. Sandra-side role mapping not stored. |
| Call Flow with Whisper Message (warns agent before connect) | ⚪ Skip | Belongs in Dialpad, not Sandra. |
| Repeat-caller routing by role | ⚪ Skip | Dialpad-side. |
| Spam-display checks (is my number flagged?) | 🔴 Gap | Optional: integrate with Numeracle/FreeCallerRegistry to check sender-rep. Low priority. |
| 10DLC + toll-free + iMessage numbers | 🟡 Partial | Sandra uses Dialpad office line. iMessage (Apple Business Chat) is a separate channel — interesting future addition for higher-trust seller comms. |
| Voicemail-per-number setup | ⚪ Skip | Dialpad-side. |

---

## 10. Driving for Dollars

REsimpli collection: `3493891-driving-for-dollar` (5 articles).

| Feature | Status vs Sandra | Notes |
|---|---|---|
| Mobile app — pin mode / tap-to-add to drop properties on a map while driving | 🔴 Gap | If BMH does serious D4$. PWA + Mapbox + camera + reverse-geocode → CASS. ~1 day. Defer. |

---

## 11. Other modules (skim)

| Module | Status | Notes |
|---|---|---|
| Calendar (3 articles) | 🔴 Gap | Appointments tied to leads. Useful once tasks/appts ship (Section 1). |
| eSign (1 article) | ⚪ Skip | DocuSign already in BMH stack (per offboarding skill). Don't rebuild. |
| Accounting (1 article) | ⚪ Skip | Use Wise + QBO. |
| Financials (1 article) | ⚪ Skip | Same. |
| iMessage (1 article) | 🔴 Gap | See section 9. |

---

## 12. Integrations (REsimpli's connected ecosystem)

For reference — apps wholesalers commonly bolt onto a CRM:

- **Dialers**: Xencall/ReadyMode, CallTools, Mojo, BatchDialer
- **SMS blast platforms**: Launch Control, Smarter Contact, REIreply
- **Data/list**: BatchLeads (Sandra already uses DealMachine/PropStream)
- **Lead-gen marketplaces (via Zapier)**: MotivatedSellers, iSpeedToLead, PropertyLeads
- **Marketing sites**: Carrot

Sandra equivalent strategy: keep Dialpad as the single voice/SMS provider, expose webhook endpoints (already done for Dialpad inbound) so any of the above can post leads in via the planned web-form intake endpoint.

---

## Prioritized build order (recommendation)

**Tier A — ship next (high ROI, leverages existing primitives)**
1. Open VA seams already in plan (lead assignment, inline reply, unread indicator, activity notes) — half-day.
2. **Drip campaigns** — section 2 — turns each lead into N scheduled touches automatically. ~4–6 hr.
3. **Web-form lead intake** — section 1 — unblocks pay-per-lead vendors and Carrot integrations. ~3 hr.
4. **Lead detail polish** — Files tab, Tasks/Appts, Activity Log, Lead Exit Type, SOW. ~half-day.

**Tier B — strategic (real new module)**
5. **Buyers + Dispo** — section 5 — biggest functional gap for a wholesaler-CRM. 1–2 days for v1.
6. **KPI dashboards** — section 4 — once 2 VAs have been on for 30 days.
7. **Speed-to-Lead AI** — section 3 — pairs with web-form intake.

**Tier C — defer or skip**
- Voice Follow AI, Call Answer AI, D4$ mobile, eSign, Accounting, marketing-site builder, Mastermind/Office Hours content, REsimpli's own List Builder.

---

## Cherry-pick checklist (use this in future sessions)

Copy a row's checkbox into a session when you want to scope it:

- [ ] Drip campaigns (sequences, audience-aware, status-change triggers)
- [ ] Web-form lead intake (signed POST + form-builder)
- [ ] Buyers database + bulk SMS/email
- [ ] Dispo website (public route per market)
- [ ] Listing model + offer submission form
- [ ] Cash Buyers matching (buy-box ↔ listings)
- [ ] Lead detail: Files tab
- [ ] Lead detail: Tasks/Appointments + kept marking
- [ ] Lead detail: Activity log
- [ ] Lead detail: SOW field
- [ ] Lead detail: Lead Exit Type enum + UI
- [ ] Lead detail: Action menu (assign / merge / mark dead with reason)
- [ ] Bulk lead assignment by role/campaign
- [ ] CSV export (Active + Dead leads)
- [ ] KPI dashboards (Goal, CEO, Individual, Source, Campaign)
- [ ] Call Grade AI on Dialpad recordings
- [ ] Speed-to-Lead AI (web form → outbound voice in <60s)
- [ ] Voice Follow AI (drip step → outbound voice agent)
- [ ] Email vendor adapter (Resend/Postmark/SES) + opt-out handling
- [ ] iMessage channel (Apple Business Chat)
- [ ] DNC scrub before outbound campaigns
- [ ] D4$ mobile PWA
- [ ] Seller meeting reminder templates
- [ ] Contingency tracking on under-contract deals
- [ ] Transaction Management pipeline split (Risk #7)
