# PropStream Filter UX — Research for Sandra Prospects Filter Panel

**Date:** 2026-05-07
**Purpose:** Pattern-match PropStream's filter taxonomy and UX for the right-side pop-out filter panel on Sandra's Prospects page. PropStream is the dominant prospecting tool in wholesale RE — its filter language is essentially the industry standard, and the user expects familiar categories.

---

## TL;DR — Top ideas to steal

1. **Lead the panel with a "Lead List" picker, not raw filters.** PropStream's biggest UX win is putting 20 named, pre-built Lead Lists (Vacant, Pre-Foreclosure, Cash Buyers, Tired Landlords, Zombie, Upside Down, etc.) at the top of the filter menu. Pick one, then stack filters on top. New users get instant value; power users layer 165+ filters underneath. ([source](https://www.propstream.com/news/propstreams-quick-lists))
2. **Live property count as the primary submit affordance.** PropStream's filter panel shows a "View (N) Properties" button that updates as you toggle filters — the count itself becomes feedback, telling you whether your funnel is too tight or too loose. ([source](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface))
3. **"Find a Filter" search box.** With 165+ filters, PropStream added a keyword search inside the filter panel so users can type "pool" or "equity" instead of hunting through accordions. Sandra will hit the same scale problem if filters keep growing. ([source](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface))
4. **"Show All Applied Filters" chip bar with per-chip remove.** Always-visible row of applied filters with `x` on each chip. Combats the "why am I getting zero results" mystery. ([source](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface))
5. **Three-state booleans (Any / Include / Exclude) instead of checkbox.** Pool, garage, basement, attic — every yes/no filter is tri-state. Crucial for "I want to exclude condos" without shuffling between two filters. ([source](https://www.propstream.com/news/propstream-announces-an-enhanced-interface-and-new-highly-requested-search-filters))
6. **Pre-built date ranges + custom calendar.** Last 3 / 6 / 12 months pills next to a date picker. Used for listing-expired-within, mortgage-origination, last-sale-date. ([source](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface))
7. **Saved Searches button lives inside the filter menu, not in a separate settings page.** One-click "Save Search" within the panel; saved searches show up in a dropdown alongside Lead Lists. ([source](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface))
8. **Lead Automator pattern: saved search auto-refreshes against new data.** New matches appear, stale ones drop off, no manual rebuild. Sandra can do this cheaply with a cron job + diff against last snapshot. ([source](https://realestaterankiq.com/propstream-2026-review-still-worth-it-for-wholesalers-my-honest-take/))
9. **Estimated Wholesale Value as a derived filter.** PropStream computes 70 % of AVM and exposes it as a searchable field. Pattern: derived/computed columns belong in the filter taxonomy alongside raw fields. ([source](https://www.propstream.com/news/propstream-announces-an-enhanced-interface-and-new-highly-requested-search-filters))
10. **Top-of-panel category usage counts.** Each category header shows how many filters within it are currently applied — fast scan for "where am I narrowing." ([source](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface))

### Quick Lists worth replicating in Sandra (priority order for v1)

1. **Vacant** — flagged vacant by USPS
2. **Pre-Foreclosure** — Notice of Default filed
3. **High Equity** — 50 %+ equity OR <50 % LTV OR $100k+ equity
4. **Cash Buyers** — non-owner-occupied, all-cash purchase history
5. **Absentee + Out-of-State** (Burton's #1 motivated-seller combo)
6. **Tired Landlords** — non-owner-occupied, owned 15+ years
7. **Tax Delinquent** — county-filed delinquency
8. **Failed/Expired Listings** — MLS expired or withdrawn within 30–90 days
9. **Zombie** — vacant AND pre-foreclosure
10. **Pre-Probate** — one owner deceased

---

## 1. Filter categories (9 top-level, ~165 filters)

PropStream's redesigned search menu groups filters into **nine categories**. Renames are post-2025 redesign; the underlying taxonomy is what every wholesaler is trained on.

| # | Category (current name) | Old name | Representative filters |
|---|---|---|---|
| 1 | **Lead Lists** | Quick Lists | The 20 pre-built lists (see §4) |
| 2 | **Property Details** | Property Characteristics | Beds, baths, sqft, lot size, year built, units, pool/garage/basement/attic (Any / Include / Exclude), property classification (SFR, condo, townhome, multi 2-4, multi 5+, vacant land, mobile, commercial) |
| 3 | **MLS** | MLS Status | Status (Active, Pending, Contingent, Failed, Sold, Never Listed, Active Under Contract, Coming Soon, Removed, Deleted, Canceled, Expired, Withdrawn), DOM, list price range, price reduction count, list date range |
| 4 | **Owner Information & Occupancy** | Owner Info | Owner-occupied / absentee / out-of-state, individual vs LLC vs trust, # of properties owned, years owned, mailing address vs site address mismatch, senior tax exemption, age estimate |
| 5 | **Lien, Bankruptcy & Divorce** | (split previously) | Lien type (mechanic, judgment, IRS, state tax, HOA), lien amount range, lien filed date, active Ch. 7 / Ch. 13 bankruptcy, divorce filing date range |
| 6 | **Pre-Foreclosure & Foreclosure** | (own category) | NOD filed date, NTS filed date, auction date, opening bid amount, lender name, default amount, judicial vs non-judicial |
| 7 | **Bank-Owned (REO)** | (own category) | REO status, REO listing date, holding bank |
| 8 | **Value & Equity** | Valuation & Equity Info | Estimated value range, estimated equity $, equity %, LTV %, Estimated Wholesale Value (70 % of AVM), tax-assessed value, last sale price, last sale date |
| 9 | **Mortgage** | (own category) | Loan amount, loan origination date, interest rate, loan type (conventional / FHA / VA / private), # of open loans, lender name, ARM vs fixed, due-on-sale flag |
| 10 | **PropStream Intelligence** | (new) | AI-derived signals — likelihood-to-sell scores, distress predictions |

Sources: [PropStream filter help](https://www.propstream.com/how-to-search-with-filters), [redesign announcement](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface), [features page](https://www.propstream.com/propstream-features).

---

## 2. Granularity inside each filter

Patterns observed across categories:

- **Range with min/max:** sqft, beds, baths, lot size, year built, equity %, LTV %, value, loan amount, days on market. Manual entry **and** dropdown presets.
- **Pre-built date ranges + calendar picker:** last 3 / 6 / 12 months pills, plus custom range. Applied to NOD date, listing date, divorce filed, lien filed.
- **Tri-state Any / Include / Exclude:** pool, garage, basement, attic, owner-occupied, vacant flag, MLS-listed.
- **Multi-select chips:** MLS status (13 values), property classification, lien type, loan type.
- **Single-select dropdowns:** state, county.
- **Free-text:** lender name, owner last name, APN.
- **Computed/derived as first-class filter:** Estimated Wholesale Value (= 0.70 × AVM) appears alongside raw fields, not buried in a calculator.

---

## 3. UI pattern

PropStream's filter UI is **a panel anchored to the search bar, opened via a "Filter" button to the right of the address/zip search**. It expands into a categorized menu. Inside the menu:

- Top-level **Lead List picker** appears first (20 buttons with icons + property counts per area).
- Below it, the **9 filter categories as accordion sections** — clicking expands a category to reveal its filters.
- A **"Find a Filter" keyword search** sits at the top of the panel, returning matching filters across all categories.
- A **"Show All Applied Filters"** view (chip bar) lists every active filter with an `x` to remove individually.
- A **"View (N) Properties" button** at the bottom (or floating) updates the result count live as filters change.
- A **"Save Search" button** lives inside the panel itself.

The search runs at the **county / city / ZIP / address / APN level first**, then filters narrow within the geographic envelope. The **Draw Map tool** is an alternative geographic primitive (see §7).

Sources: [filter help](https://www.propstream.com/how-to-search-with-filters), [redesign part 2](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface), [enhanced UI announcement](https://www.propstream.com/news/propstream-announces-an-enhanced-interface-and-new-highly-requested-search-filters).

---

## 4. The 20 Lead Lists (canned saved searches)

Every Lead List is a named filter recipe. Stack additional filters on top. Lead Lists live as the **first tab** inside the filter menu. ([Source](https://www.propstream.com/news/propstreams-quick-lists))

| # | Lead List | Underlying logic |
|---|---|---|
| 1 | **Auctions** | Notice of Sheriff's Sale OR Notice of Trustee's Sale filed |
| 2 | **Bank-Owned** | REO status (repossessed after failed auction) |
| 3 | **Bankruptcy** | Active Ch. 7 or Ch. 13 filing on owner |
| 4 | **Cash Buyers** | Non-owner-occupied AND most recent purchase = all-cash |
| 5 | **Divorce** | Active divorce filing on owner |
| 6 | **Failed Listings** | Previously listed on MLS, did not sell |
| 7 | **Flippers** | On-MLS now, purchased within last 24 months |
| 8 | **Free & Clear** | No open mortgages |
| 9 | **High Equity** | 50 %+ equity OR <50 % LTV OR $100k+ equity (any of the three) |
| 10 | **Liens** | Active lien filed against property |
| 11 | **On Market** | MLS status = Pending OR Contingent OR Active |
| 12 | **Pre-Foreclosure** | Default documents filed by lender |
| 13 | **Pre-Probate** | One owner is deceased |
| 14 | **Senior Owners** | Owned 25+ years OR senior tax exemption OR open reverse mortgage |
| 15 | **Tax Delinquency** | County-filed tax delinquency |
| 16 | **Tired Landlords** | Non-owner-occupied AND owned 15+ years |
| 17 | **Vacant** | USPS-flagged vacant |
| 18 | **Vacant Land** | Land with no physical structure |
| 19 | **Zombie Properties** | Vacant AND in pre-foreclosure (intersection of #17 + #12) |
| 20 | **Upside Down** | Negative equity (owe more than worth) |

---

## 5. Saved filters / List Builder / Smart Lists / scheduled alerts

- **Save Search** — button inside the filter panel; stores the full filter+geo combo by name. Re-runnable across new geographies or at later dates. ([source](https://www.propstream.com/how-to-search-with-filters))
- **Lead Automator** (paid add-on, included in Pro/Elite) — turns a saved search into a self-refreshing list. New matches appear automatically, stale ones drop off. Reduces skip-trace cost from 12¢ to 10¢. ([source](https://www.propstream.com/news/how-to-find-cash-buyers-using-propstreams-quick-list))
- **My Properties** page — destination for saved/exported lists. Customizable summary boxes at top stack additional filters on a list ("list within a list"). ([source](https://www.propstream.com/creating-lists-within-lists-with-list-automator))
- **No explicit "scheduled email alert"** found in sources — automation appears to be in-app refresh + notification rather than emailed daily digests.

---

## 6. Combination semantics

- **Within a Lead List + custom filters:** AND across categories ("View (N) Properties" updates as a single intersected count).
- **Within a multi-select filter (e.g., MLS Status with 13 values):** OR (any of the selected values).
- **Tri-state Any / Include / Exclude:** "Exclude" is true negation, not absence — important for honoring "no condos."
- **No documented OR-across-categories** (e.g., "high equity OR tax-delinquent") — power users work around this by running two saved searches and merging into one list manually.
- **"Is empty / not empty"** semantics implicit in tri-state booleans (Any = empty/either, Include = present, Exclude = absent).

---

## 7. Geographic filters — Draw Map + County/ZIP

- Geographic search supports: **address, APN, ZIP, city, county**. ([source](https://www.propstream.com/frequently-asked-questions-faq))
- **Draw Map Tool (relaunched April 2026)** — three modes: **Free Draw, Circle, Rectangle**. Searches up to **5,000 sq mi** (up from 250). Search auto-runs on shape complete; "Remove Boundary" button clears. ([source](https://www.propstream.com/news/propstream-launches-enhanced-draw-map-tool-with-unmatched-speed-and-precision))
- **No KML / shapefile upload** found in current sources.
- **No documented multi-county selector** — counties are picked one at a time from the geo search; multi-county requires multiple saved searches OR a draw-map shape that spans them.
- **Heat Maps** as a separate visualization layer for value, foreclosure rate, and rent. ([source](https://www.propstream.com/propstream-features))

---

## 8. Post-filter actions

After narrowing a result set, PropStream surfaces these actions on the result list:

1. **Save to Marketing List** — push filtered set into a named list under My Properties.
2. **Skip Trace** — phone + email lookup; built-in DNC scrub. 10–12¢ per trace.
3. **Export** — CSV. Essentials plan = 25,000 saves/exports per month.
4. **PropStream Campaigns** — postcards, targeted emails, custom landing pages.
5. **Click-to-Dial** + **Dialer Campaigns** — place calls inside PropStream; deeper integration with **BatchDialer** (20 % discount via PropStream).
6. **Lead Automator** — promote a one-time filter set into a self-refreshing list.

Sources: [features](https://www.propstream.com/propstream-features), [cash buyers walkthrough](https://www.propstream.com/news/how-to-find-cash-buyers-using-propstreams-quick-list), [wholesaler review](https://realestaterankiq.com/propstream-2026-review-still-worth-it-for-wholesalers-my-honest-take/).

---

## 9. Distinctive features worth noting

- **Estimated Wholesale Value (70 % rule baked in)** — derived metric promoted to first-class filter. ([source](https://www.propstream.com/news/propstream-announces-an-enhanced-interface-and-new-highly-requested-search-filters))
- **Property classification "Include / Exclude" tri-state** — same pattern across pool, garage, basement, attic, MLS-listed.
- **Burton's 5 motivated-seller filter recipes** (community canon among wholesalers): ([source](https://www.propstream.com/news/burtons-pick-5-propstream-filter-combinations-to-find-the-most-motivated-sellers))
  1. Absentee Owner + Vacant 6–12 mo + out-of-state
  2. Failed/Expired Listings within 30–90 days
  3. Tax Delinquent 2+ yrs + 40 %+ equity
  4. Tired Landlords (absentee, 10–15+ yrs owned, multi-property)
  5. Individual Owners with 2–5 properties, 5+ years held
- **AI-derived "PropStream Intelligence" category** — likelihood-to-sell, distress prediction. New 9th-category placement signals where AI fits in the taxonomy without disrupting traditional fields.
- **No per-county filter cap discovered** in current sources — older PropStream had a 5-county cap per saved list, but the 5,000 sq mi draw-map expansion appears to have superseded that.
- **"Fresh data" filters** — pre-built last-3/6/12-month presets on every date field; data refreshes daily for foreclosure / lien / bankruptcy / divorce.

---

## Recommendations for Sandra's panel (concrete)

- **Right-side pop-out, ~420 px wide, sticky.** Triggered by a "Filter" button next to the existing Prospects search.
- **Top section:** "Lead List" picker — start with 6 of the 20 (Vacant, Pre-Foreclosure, High Equity, Cash Buyers, Tired Landlords, Tax Delinquent). Add the rest as the data layer grows.
- **Find-a-filter input** — keyword search across all filter labels.
- **Accordion sections** in this order, mirroring PropStream's mental model: Property Details → Owner & Occupancy → Value & Equity → Mortgage → MLS → Distress (foreclosure / lien / bankruptcy / divorce / tax) → PropStream-style intelligence (Sandra's AI signals — vacancy confidence, contactability score) → Geography.
- **Live result-count button** at the bottom of the panel: "Show N Prospects."
- **Applied-filter chip bar** above the prospect list (always visible, even when panel collapsed).
- **Tri-state Any / Include / Exclude** for every boolean (Vacant, Verified, Contacted, etc. — the existing 5 chips become tri-state, not on/off).
- **"Save Search"** button inside the panel; saved searches appear in the Lead List dropdown alongside built-ins.
- **Defer for v2:** map drawing, scheduled alerts, list-within-a-list automator, multi-state.

---

## Sources

- [PropStream — How To Search With Filters](https://www.propstream.com/how-to-search-with-filters)
- [PropStream — Lead Lists overview (all 20)](https://www.propstream.com/news/propstreams-quick-lists)
- [PropStream — Future of PropStream Part 2: New Filters & Refreshed Interface](https://www.propstream.com/news/the-future-of-propstream-part-2-new-filters-refreshed-interface)
- [PropStream — Enhanced Interface & New Filters announcement](https://www.propstream.com/news/propstream-announces-an-enhanced-interface-and-new-highly-requested-search-filters)
- [PropStream — Enhanced Draw Map Tool (April 2026)](https://www.propstream.com/news/propstream-launches-enhanced-draw-map-tool-with-unmatched-speed-and-precision)
- [PropStream — Burton's 5 Filter Combinations for Motivated Sellers](https://www.propstream.com/news/burtons-pick-5-propstream-filter-combinations-to-find-the-most-motivated-sellers)
- [PropStream — Cash Buyers Lead List walkthrough](https://www.propstream.com/news/how-to-find-cash-buyers-using-propstreams-quick-list)
- [PropStream — Creating Lists within Lists with Lead Automator](https://www.propstream.com/creating-lists-within-lists-with-list-automator)
- [PropStream — Features page](https://www.propstream.com/propstream-features)
- [PropStream — FAQ](https://www.propstream.com/frequently-asked-questions-faq)
- [Real Estate Rank IQ — PropStream 2026 Wholesaler Review](https://realestaterankiq.com/propstream-2026-review-still-worth-it-for-wholesalers-my-honest-take/)
- [PropStream Academy](https://www.propstream.com/propstream-academy)
- [PropStream Help Video Library](https://www.propstream.com/propstream-help-video-library)
- [YouTube — Ultimate Guide To Getting Started With PropStream (Feb 2025)](https://www.youtube.com/watch?v=TRcKDLxtJzA) — referenced; transcript not directly fetchable, recommended for visual review of the filter panel layout.
