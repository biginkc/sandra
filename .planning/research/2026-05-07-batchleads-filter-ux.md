# BatchLeads Filter UX — Research Notes

**Date:** 2026-05-07
**Author:** Claude (research agent)
**Purpose:** Catalog Batchleads' (BatchService) filter UI, list-stacking, and post-filter actions so Sandra's Prospects filter panel can borrow the strongest patterns.

---

## TL;DR — Top 8 Ideas to Steal for Sandra's Prospects Panel

1. **Two-tier filter system: "quick filters" (chips) + "all filters" (deep panel).** BatchLeads keeps a short row of context-aware chips at the bottom of the results screen for one-click slicing (Vacant, Pre-foreclosure, Tax Default, High Equity, Tired Listing, etc.) and stashes the long tail behind an "All Filters" button that opens a full-height panel. The chip row counts update live as the underlying dataset changes — *this is the killer UX detail*. Sandra's existing 5 chips should stay (chips are good), but every chip count should be live, and an "All Filters" button next to them should pop open a right-side drawer with everything else. ([source](https://help.getbatch.co/en/articles/9777973-how-to-use-property-search), [source](https://help.getbatch.co/en/articles/9787306-using-quick-filters-within-my-lists))

2. **List-stacking via a "List Count" / "Tag Count" slider.** This is BatchLeads' single most-copied feature. Once a property has been saved into multiple lists/tags ("absentee", "high-equity", "pre-foreclosure"), users open My Lists, set a slider to "≥3 lists", and only properties on three or more stacked lists show. Sortable columns let you rank by overlap count. Trivial in concept, transformative in practice — wholesalers literally pay for BatchLeads because of this single slider. Sandra should ship it. ([source](https://help.getbatch.co/en/articles/9787321-how-to-list-stack-why-it-s-important), [source](https://batchleads.io/batch-tv/mastering-batchleads/list-stacking-real-estate-leads) — video timestamps 3:24, 4:03, 4:23)

3. **Lists & Tags filter has three modes: Include / Exclude / Exclusively.** Multi-select with a tri-state operator. "Exclusively" = AND across all selected lists (must be on every one). "Include" = OR. "Exclude" = NOT IN. This single tri-state control replaces what would otherwise be a separate AND/OR toggle and is far more legible than radio buttons. ([source](https://help.getbatch.co/en/articles/9774412-how-to-filter-your-saved-properties))

4. **"Save Search" checkbox at the moment of execution.** When the user hits "See N Properties", a checkbox lets them save the current filter combo as a named, reusable chip that pins next to the default Map Quick Filters. Up to 5 custom Quick Filters + unlimited regular saved filters. Don't make users hunt through a menu after the fact — let them save inline. ([source](https://help.getbatch.co/en/articles/9787464-how-to-stack-quick-filters))

5. **Conditional / compound filter blocks with a blue "+" add button.** Some filter rows (date added, owner name, address, phone numbers) support multiple conditions stacked vertically, each with its own operator. This lets a user say "address contains X AND address contains Y" without writing SQL. Useful for skip-trace-result filters in Sandra. ([source](https://help.getbatch.co/en/articles/9774412-how-to-filter-your-saved-properties))

6. **AI-rank slider as a foundational filter.** "BatchRank AI" is a 0-100 score with a Low/Medium/High slider that gates everything else. Available to higher-tier plans only — gating is a real upsell. Sandra's equivalent could be a motivation-score filter once the AI responder accumulates enough reply data to predict it. ([source](https://help.batchservice.com/en/articles/10968831-batchrank-faq-and-details), [source](https://batchleads.io/blog/ai-in-real-estate-find-motivated-seller-leads-faster-with-batchleads))

7. **Strategy selector at the top of the filter panel changes which filters are shown.** Picking "Off Market" vs "On Market" rearranges the rest of the panel — the Quick Filter chip row swaps out, and irrelevant filters get hidden. Cuts decision fatigue. Sandra could borrow this with "Seller leads" vs "Cash buyers" vs "Agent outreach" modes. ([source](https://help.getbatch.co/en/articles/9777973-how-to-use-property-search))

8. **Dynamic chip counts under live filter state.** Every chip shows "(N)" — and N updates as you stack filters. "Pre-foreclosure (1,847) → after applying High Equity → Pre-foreclosure (412)". The user sees the funnel collapse in real time. This is the single biggest UX win versus a static chip row. ([source](https://help.getbatch.co/en/articles/9787306-using-quick-filters-within-my-lists))

---

## 1. Filter Categories (Exhaustive Taxonomy)

BatchLeads advertises **140+ filters** ([source](https://resimpli.com/blog/batchleads-review/)) across 300+ data points. The full canonical list lives in their downloadable "BatchLeads Filter Dictionary 2025.pdf" which is gated and could not be fetched directly ([source](https://help.getbatch.co/en/articles/9787399-batchleads-filter-definitions)). The categories below are reconstructed from public help articles, BatchTV walkthroughs, and third-party reviews.

### 1a. Property Characteristics
- Property Type (residential, commercial, land, multi-family) — multi-select dropdown
- Property Sub-Type (single-family, duplex, triplex, mobile home, condo) — multi-select
- Beds — min/max range
- Baths — min/max range
- Square Footage — min/max range (e.g., 2,000–2,500+)
- Lot Size — min/max range
- Year Built — min/max range (e.g., "before 1990")
- Stories — minimum integer
- Pool / Garage / HOA — boolean toggles ("No HOA fees" called out specifically)

### 1b. Ownership
- Occupancy Status: **Absentee Owned / Owner-Occupied / Vacant** — multi-select
- Absentee sub-classifications: **In-State Absentee / Out-of-State Absentee** — boolean
- Ownership Duration ("Years Owned") — min/max (common values: 5+, 7+, 10+ years)
- Owner Type: Individual / Company (LLC/Trust) — toggle
- Multi-Property Owner / Portfolio Size — minimum integer ("min 3 properties owned")
- Mailing Address ≠ Property Address — boolean (used heavily for cash-buyer detection)
- Self-Managed (boolean, surfaces tired landlords)

### 1c. Valuation & Equity
- Estimated Value — min/max
- Equity % — min/max (common: 30%+, 50%+)
- Loan-to-Value (LTV) — min/max
- Assessed Value — min/max
- ARV % — min/max (used for on-market deal hunting)

### 1d. Mortgage / Lender
- Interest Rate — min/max
- Loan Origination Date — date range
- Lender Name — text match
- Number of Loans — integer

### 1e. MLS / Listing Status
- Strategy toggle: **On-Market / Off-Market** (foundational; rearranges the panel)
- Listing Status: New (≤15 days), Tired (45+ days), Cancelled, Expired, Failed Listings
- Days on Market — min/max
- List Price — min/max
- Price-to-Value Spread — % range
- MLS Description text-match filter (separate help article — full-text search inside listing descriptions) ([source](https://help.getbatch.co/en/articles/9854046-how-to-use-the-mls-description-filter))

### 1f. Distress
- Pre-Foreclosure / Auction — boolean (with sub-stages)
- Foreclosure — boolean
- Tax Default / Tax Delinquent — boolean
- Lien (involuntary) — boolean
- Bankruptcy (Chapter 7 / Chapter 13) — boolean
- Probate / Pre-Probate (deceased owner on title) — boolean
- Divorce — boolean
- Eviction — boolean (referenced as "future premium leads" in some sources — may be tier-gated)
- Code Violation — boolean
- Vacant — boolean (USPS-backed, monthly refresh; sub-toggle "Newly Vacant")
- Mailing Vacant — separate boolean

### 1g. Demographic
- Owner Age — min/max
- Marital Status — multi-select
- Household Size — integer
- Income — min/max
- Presence of Children — boolean

### 1h. Geographic
- Search by Address / City / Zip / County (text input)
- **Boundary tool** — draw a polygon directly on the map (click-to-start, click-to-end)
- Map / Satellite toggle (gear icon, bottom right)
- Radius search (implied — common in this category)

### 1i. Engagement / Sandra-relevant operational filters
- Skip Traced — boolean
- Has Phone Numbers — boolean
- Opted Out — boolean
- Lead Status — dropdown, customizable categories, default "New"
- Date Added — range
- Tag / List membership — multi-select with Include/Exclude/Exclusively

### 1j. Cash-Buyer-Specific
- Purchased with Cash — boolean
- Purchase Date — date range (last 3 / 6 / 12 months)
- Portfolio Size — minimum
- Mailing ≠ Property (auto-applied to filter out homeowners pretending to be investors)

Sources for §1: ([help center](https://help.getbatch.co/en/articles/9774412-how-to-filter-your-saved-properties)), ([motivated-seller walkthrough](https://batchleads.io/batch-tv/mastering-batchleads/how-to-create-quality-lists-of-motivated-sellers-and-cash-buyers)), ([resimpli review](https://resimpli.com/blog/batchleads-review/)), ([realestateskills review](https://www.realestateskills.com/blog/batch-leads-review)).

---

## 2. Granularity / Operators

| Operator | Filter examples |
|---|---|
| **Range (min/max)** | Beds, Baths, SqFt, Year Built, Equity %, Owner Age, Days on Market, List Price |
| **Boolean toggle** | Vacant, Skip Traced, Has Phone, Opted Out, Pre-Foreclosure, Probate, Divorce |
| **Multi-select** | Property Type, Property Sub-Type, Listing Status, Marital Status |
| **Tri-state (Include / Exclude / Exclusively)** | Lists & Tags |
| **Text search** | Owner Name, Address, Lender Name, MLS Description |
| **Slider with threshold** | BatchRank AI (Low/Med/High), List Count, Tag Count |
| **Date range** | Date Added, Purchase Date, Loan Origination Date |
| **Compound (stacked rows w/ "+" button)** | Date Added, Owner Name, Address, Phone Numbers |

---

## 3. UI Pattern

- **Sidebar / panel + bottom chip row** — the main results layout has the map on the left, properties listed on the right, **Quick Filter chips along the bottom** of the property bar, and an **"All Filters" button at the top** that opens a full filter panel.
- The full filter panel is **accordion-organized by category** (Lists & Tags, List/Tag Count, Lead Score, Property Vacant, Lead Status, Conditional Filters, Quick Filters). Each section is collapsible.
- A **filter count badge at the top** of the panel tells you how many filters are currently applied.
- A **"Save"** button preserves filter sets; a **"Save Search" checkbox** appears next to the apply action.
- Strategy toggle (Off Market / On Market) sits at the top and rearranges the rest of the panel.
- Trigger: clicking "All Filters" at the top of the property results, OR the lightning-bolt icon for quick filters.

Source: ([Property Search help article](https://help.getbatch.co/en/articles/9777973-how-to-use-property-search)), ([Quick Filters within My Lists](https://help.getbatch.co/en/articles/9787306-using-quick-filters-within-my-lists)).

---

## 4. Saved Filters / Smart Lists / Scheduled Alerts / Stacking

- **Saved Searches** — limit of 5 custom Quick Filter pins + unlimited regular saved filters. Pinned chips live next to the default Map Quick Filters at the bottom of the property search bar. ([source](https://help.getbatch.co/en/articles/9787464-how-to-stack-quick-filters))
- **Smart Lists** — BatchLeads does not appear to ship a feature explicitly named "Smart Lists" (in the Mailchimp/Segment sense of always-fresh dynamic lists). My Lists + saved filters approximates it: you save a filter, hit it again later, and the live data refreshes. The chip counts auto-recalculate as data updates ("The numbers will always been changing as your data is being automatically updated").
- **Scheduled Search Alerts** — no documented feature for email/SMS notifications when new properties match a saved filter. This is a gap and a real opportunity for Sandra.
- **List Stacking** — the killer feature, two distinct flavors:
  - **Quick-filter stacking inside Property Search**: select multiple Quick Filters (Absentee + Vacant + Failed Listings); they apply with AND semantics. ([source](https://help.getbatch.co/en/articles/9787464-how-to-stack-quick-filters))
  - **List Count slider inside My Lists**: properties accumulate list/tag membership over time as you save them under different campaigns; the slider lets you filter to "on ≥N lists". Sortable columns rank by overlap. ([source](https://help.getbatch.co/en/articles/9787321-how-to-list-stack-why-it-s-important), video at [batchleads.io/batch-tv/mastering-batchleads/list-stacking-real-estate-leads](https://batchleads.io/batch-tv/mastering-batchleads/list-stacking-real-estate-leads), key timestamps 3:24, 4:03, 4:23 — going from 68k properties down to 613 by setting "≥3 lists")

---

## 5. Combination Semantics

- **Within a single filter category** (e.g., Property Type: SFH + Duplex): **OR**
- **Across categories** (Property Type AND Equity > 30% AND Vacant): **AND**
- **Lists & Tags Include**: OR across selected lists ("on any of these lists")
- **Lists & Tags Exclusively**: AND across selected lists ("on all of these lists")
- **Lists & Tags Exclude**: NOT IN
- **List Count slider**: AND-of-N — "on at least N of any list"
- Quick filter stacking inside Property Search: **AND** (a property must match all selected chips)

Source: ([Lists & Tags filter modes](https://help.getbatch.co/en/articles/9774412-how-to-filter-your-saved-properties)), ([list stacking semantics](https://help.getbatch.co/en/articles/9787321-how-to-list-stack-why-it-s-important)).

---

## 6. Post-Filter Actions

After a list is built and selected, the following actions are available (some require add-on subscriptions or skip-traced data):

| Action | Notes |
|---|---|
| **Skip Trace** | Up to 5 phone numbers + 3 emails per property; ~70% RPC rate; ~$0.04/record beyond plan. ([source](https://www.realestateskills.com/blog/batch-leads-review)) |
| **Add to List / Tag** | "ADD" button → save selected to a list with custom tags (market + date + notes). |
| **Direct Mail Campaign** | 11 postcard styles + 2 letter styles; scheduling. |
| **SMS Campaign** | Requires Twilio / Plivo / SignalWire BYO carrier. |
| **Ringless Voicemail** | Native channel option. |
| **Click-to-Dial** | Inline dialer; full BatchDialer integration (Pro plan+). |
| **Dialer-AI** | Real-time AI prompts during call (Professional+). |
| **CRM Export** | CSV. |
| **Push to Driving for Dollars** | Add to mobile-app canvassing route. |
| **Comping** | Built-in ARV calculator on each property card. |

---

## 7. Distinctive Features

- **BatchRank AI** — 0-100 motivation score, ML on 800+ data points, trained to predict which properties sell in the next 6-12 months. Found to identify ~64% of properties that eventually sell. Surfaced as a **Low / Medium / High slider with a fire icon**. Tier-gated (Growth = Medium ceiling; Professional = full range). ([source](https://help.batchservice.com/en/articles/10968831-batchrank-faq-and-details))
- **Quick Filter library** — Vacant, Pre-Foreclosure, Tax Default, High Equity, Low Equity, Tired Landlord, Failed Listing, New Listing (≤15 days), Tired Listing (45+ days), Virtual Driving for Dollars hits.
- **Driving for Dollars** — virtual (Google Street View) + physical (mobile app with route tracking, distance, time, properties saved); pinned properties auto-tagged green.
- **APN Search** — direct parcel lookup.
- **Skip Tracing pricing** — "lowest price per record in the industry"; 250 credits/mo on Personal Basic, 1,000 on Personal Plus; 4¢ per additional. Re-skip-trace allowed (charged again).
- **155M+ properties across 3,100+ counties.**
- **Lead Scoring (user-defined)** — separate from BatchRank AI; users assign their own points to build year, property type, equity, mortgage rate, marital status. Personal Plus+ only.

Pricing tiers (third-party-reported):
- Growth: $119/mo · 10k leads · 3 users
- Professional: $349/mo · 30k leads · 8 users · full BatchRank AI
- Scale: $749/mo · 75k leads · 26 users
- 7-day free trial. ([source](https://www.realestateskills.com/blog/batch-leads-review))

---

## Sources

- BatchLeads help center collection: https://help.getbatch.co/en/collections/10253999-batchleads
- How to Use Property Search: https://help.getbatch.co/en/articles/9777973-how-to-use-property-search
- How to Filter your Saved Properties: https://help.getbatch.co/en/articles/9774412-how-to-filter-your-saved-properties
- How to Stack Quick Filters: https://help.getbatch.co/en/articles/9787464-how-to-stack-quick-filters
- How to List Stack & Why It's Important: https://help.getbatch.co/en/articles/9787321-how-to-list-stack-why-it-s-important
- Using Quick Filters within My Lists: https://help.getbatch.co/en/articles/9787306-using-quick-filters-within-my-lists
- BatchLeads Filter Definitions (gated PDF index): https://help.getbatch.co/en/articles/9787399-batchleads-filter-definitions
- MLS Description Filter: https://help.getbatch.co/en/articles/9854046-how-to-use-the-mls-description-filter
- Common Lists to Pull: https://help.getbatch.co/en/articles/9967664-common-lists-to-pull-in-batchleads
- BatchRank FAQ: https://help.batchservice.com/en/articles/10968831-batchrank-faq-and-details
- BatchTV — List Stacking video (timestamps 3:24, 4:03, 4:23): https://batchleads.io/batch-tv/mastering-batchleads/list-stacking-real-estate-leads
- BatchTV — Motivated Sellers & Cash Buyers walkthrough: https://batchleads.io/batch-tv/mastering-batchleads/how-to-create-quality-lists-of-motivated-sellers-and-cash-buyers
- BatchTV — Complete Guide 2024: https://batchleads.io/batch-tv/complete-guide-for-batchleads-2024
- BatchLeads Lead Generation page: https://batchleads.io/lead-generation
- BatchLeads Wholesaler page: https://batchleads.io/real-estate-wholesaler
- AI in Real Estate (BatchRank): https://batchleads.io/blog/ai-in-real-estate-find-motivated-seller-leads-faster-with-batchleads
- Resimpli review (140+ filters, pricing): https://resimpli.com/blog/batchleads-review/
- RealEstateSkills review (distress filter list, pricing tiers): https://www.realestateskills.com/blog/batch-leads-review
- Dealrun review: https://dealrun.ai/blog/batchleads-review
- BatchLeads Master Walkthrough 2025 (YouTube — chapters not extractable via WebFetch): https://www.youtube.com/watch?v=ERoSEWqtdaQ
- BatchLeads Tutorial 2023 (YouTube): https://www.youtube.com/watch?v=fF2MHmCToJc
- User Suggestions feedback board (filter requests, 403 from WebFetch but reachable in browser): https://feedback.batchleads.io/suggestions/540821/new-property-search-filter-ideas
