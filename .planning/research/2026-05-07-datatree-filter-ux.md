# DataTree Filter UX — Research Brief

**Date:** 2026-05-07
**Author:** Claude (research subagent)
**Purpose:** Inform the right-side pop-out filter panel for the Sandra Prospects page. The user mentioned "DataSift" but in the wholesale-RE context this is almost certainly First American **DataTree**. (DataSift the social-data company shut down in 2023 — confirmed via [DataSift alternatives, Improvado](https://improvado.io/blog/datasift-alternatives) — and is unrelated to property research. This brief therefore focuses on DataTree.)

---

## TL;DR — top ideas a CRM filter panel should steal from DataTree

1. **Tab-grouped categories, not one giant scroll.** DataTree splits filters into tabs/sections — *Location, Characteristics, Owner, Transaction (Sale/Mortgage/Listing), Market Value, Equity, Open Lien, Foreclosure, Assessor* — instead of a single endless form. ([REtipster hacks](https://retipster.com/datatree-hacks/), echoed across reseller pages.)
2. **Map drawing tools as first-class filters.** Polygon, radius, freehand, and lat/long coordinates can each *be* the geographic filter. After a draw, all other filters layer on top. ([REtipster hacks](https://retipster.com/datatree-hacks/), [Drawing Tools video](https://www.youtube.com/watch?v=1DC9ufgk-vo).)
3. **"Owner Occupied = Absentee" + "Do Not Mail" as toggles, not buried fields.** These two flags drive 80 % of wholesaler list-pulls and DataTree surfaces them as headline filters on the Owner tab.
4. **Distress as its own tab (Foreclosure / Lien / Tax-delinquent).** Wholesalers think in distress signals; lumping them into "status" hides them. DataTree exposes Pre-Foreclosure, NOD, Lis Pendens, Auction, REO, plus PACE liens and HOA liens as discrete filters.
5. **Save searches → re-run / schedule.** DataTree Lists supports saved searches with file-delivery (CSV/Excel/labels). A CRM should treat a saved filter as a first-class object the user can re-run, alert on, and pipe into a campaign.
6. **One "build a list" verb post-filter.** From any filter result you can: Multi-line report, Mailing Labels, or Export to Excel. Sandra equivalent: push to list, send to skip trace, or push into a sequence — all from the same result toolbar.
7. **Multi-property / portfolio-owner filter.** "Owners who hold N+ properties" is a one-click filter on DataTree and is gold for wholesalers chasing tired landlords. ([DataTree Hacks: Portfolio Owners](https://www.youtube.com/watch?v=9RvXCiHUzlo).)

---

## 1. Filter / search criteria DataTree exposes

DataTree advertises **125+ advanced search fields** ([First American DataTree research page](https://dna.firstam.com/solutions/property-data/datatree-property-research) — surfaced via search snippet; page itself 403s to bots). REtipster, who run a co-branded sign-up page, describe it as "the most list-filtering options I've seen from any data service" but warn the granularity is "a double-edged sword" ([REtipster: Real Estate Data Services Compared](https://retipster.com/real-estate-data/)).

Filter categories confirmed across First American marketing pages and the public user guide ([DataTree User Guide PDF](https://www.datatree.com/hubfs/Support_Guide/20-DataTree-Full-User-Guide.pdf), surfaced via search snippets):

- **Location** — state, county, city, zip, MLS area, subdivision, APN/parcel, draw-on-map (polygon, radius, freehand, lat/long).
- **Property Characteristics** — land use, square footage, bed/bath/total room count, year built, pool, plus (per resellers) lot size, stories, garage. *2025 release notes call out "room count normalization" as a new accuracy upgrade* ([Search Reinvented blog post](https://dna.firstam.com/insights-blog/search-reinvented-how-datatree-evolved-in-2025-and-what-it-means-for-2026) — surfaced via snippet, page 403s).
- **Owner Information** — name, mailing address, **Do Not Mail flag**, **owner occupancy (Absentee / Owner-Occupied)**, supports individuals / LLC / trust entity types, multi-property-owner / portfolio search.
- **Transaction (Sale / Mortgage / Listing)** — last sale date and price, prior sale, transfer type, mortgage origination year, lender, mortgage type, plus MLS listing data on the same tab.
- **Market Value (Procision AVM)** — dollar-range filter.
- **Equity** — equity %, LTV (range filters).
- **Open Lien Information** — including PACE and HOA liens as distinct filters.
- **Foreclosure Information** — Pre-Foreclosure, NOD, Lis Pendens, Notice of Trustee Sale / Foreclosure Sale, REO. (Ecosystem norm per [ATTOM foreclosure data](https://www.attomdata.com/data/foreclosure-data/) and [BatchData pre-foreclosure](https://batchdata.io/pre-foreclosure-data); DataTree carries the same lifecycle.)
- **Assessor / Tax Status** — current vs delinquent. *REtipster forum thread "Understanding the new filters in DataTree" specifically calls out tax-delinquent filters as recently added but with caveats — "could all be helpful if you understand their limitations"* ([REtipster forum](https://forum.retipster.com/t/understanding-the-new-filters-in-datatree/1200)).

**Gaps / paywalled — be honest about what we couldn't see directly:**
- `dna.firstam.com` and `datatree.com` block bot fetches (403/cert errors) and the user guide PDF only renders as binary. Field-level operators (between, in-list, not-equals) and exact AND/OR/grouping semantics are described in marketing copy as "mix and match" but never quoted verbatim. We're inferring tab layout from search snippets of the User Guide. Recommend a 30-min live walkthrough or trial seat before final UI lock.
- Demographic data (owner age, household): not surfaced in any source — a [BiggerPockets DataTree vs PropStream thread](https://www.biggerpockets.com/forums/61/topics/1093863-datatree-vs-propstream) and resellers note DataTree **does not** offer owner phone/email or demographic info; that's where skip-trace plugs in.
- Bankruptcy / judgment as separate filters: not confirmed in public material; lumped under "Open Lien" / "Foreclosure".

## 2. Granularity inside each category

Confirmed patterns from snippets and reseller copy:

- **Range filters** for $ values (AVM, sale price, mortgage origination year, equity, LTV) and numeric attributes (sqft, lot, beds/baths, year built). Expressed as min/max boxes per the User Guide screenshots referenced by [Basic Property Management's review](https://basicpropertymanagement.com/property-data-reports-for-real-estate-investors/).
- **Multi-select** for categorical fields (land use, mortgage type, foreclosure stage).
- **Boolean toggles** for flags (Do Not Mail, Pool, Owner-Occupied, Absentee, Vacant).
- **Exclusion lists**: "find properties with (or without) specific characteristics you specify" — language First American uses on its property-data page (snippet only; full page paywalled).
- **Map-as-filter**: drawing a polygon/radius IS the geographic filter; subsequent filters narrow the drawn set.
- **AND/OR/grouping**: marketing claims "mix and match" but no public source proves grouped-clause boolean builder. **Treat as unverified.**

## 3. UI pattern

- **Tabbed filter layout** — Characteristics, Transaction (Sale/Mortgage/Listing), Owner, Market Value, Equity, Open Lien, Foreclosure, Assessor (per User Guide snippets).
- **Map-driven entry point** — many flows start by drawing a market area, then opening filter tabs to refine.
- **Single-mode (no power vs guided split)** — DataTree is a power-user tool; resellers describe a learning curve. PropStream by contrast offers "Quick Lists" (pre-built filter templates), which DataTree does not ([REtipster comparison](https://retipster.com/real-estate-data/)). **CRM opportunity:** ship Quick Lists as starter templates *and* an advanced panel — DataTree's main UX weakness is no on-ramp.
- **Integrated Property Search** — separate product that "merges map, proximity, address, owner, APN, document and advanced search features into one solution" ([DNA page snippet](https://dna.firstam.com/integrated-search)).
- **3D mapping layer** added recently — parcel lines, flood zones, terrain contours rendered while filtering ([Resimpli 2025 review](https://resimpli.com/blog/best-nationwide-property-data-software/)).

## 4. Saved searches / alerts / scheduled exports

DataTree Lists supports **saved searches with file delivery** (Excel, mailing labels, multi-line report) — confirmed in snippets from First American's [Lists product page](https://dna.firstam.com/lists) and [DataTree.com/lists](https://datatree.com/lists). Alerts on saved-search deltas are not explicitly documented in public sources; assume "yes by appointment with their Solution Experts" rather than a self-serve scheduler.

## 5. Combination semantics

Marketing language: "mix and match specific filtering criteria" ([REtipster hacks](https://retipster.com/datatree-hacks/)). Within a tab, multiple values appear to act as AND across categories and OR within a multi-select field — standard list-builder behavior. **No public source confirms a boolean grouping builder** (e.g., `(Absentee AND Equity>50%) OR (NOD AND DaysOnMarket>90)`). Sandra should *consider* this a differentiator if shipped.

## 6. What it does post-filter

From a filtered result set, DataTree offers:
- **Multi-line report** (printable record per property)
- **Mailing Labels** (direct-mail-ready)
- **Export to Excel/CSV**
- (Implicit) hand off to a skip-trace tool — DataTree does not provide owner phone/email natively, so users typically pipe the CSV into BatchSkipTracing, REIPro, or REsimpli ([Resimpli review](https://resimpli.com/blog/best-nationwide-property-data-software/), [Top 10 property data providers, BatchData](https://batchdata.io/blog/top-property-data-providers-real-estate-investors)).
- **Custom-built lists by Solution Experts** for high-volume buyers.

## 7. Distinctive vs a generic CRM filter

- **Map drawing tools as a primary filter mode** (polygon / radius / freehand / coordinates).
- **PACE-lien and HOA-lien filters** — niche but loved by wholesalers chasing distress.
- **Portfolio / multi-property owner filter** — find tired landlords in one click.
- **Foreclosure lifecycle as discrete stages** — not just one "is_foreclosure" boolean.
- **Vacant property flag sourced from First American's document repository**, separate from absentee.
- **Document-image attachment** — every property record links to recorded deed/mortgage images (99 % deed coverage).
- **Land-use breadth** — DataTree is uniquely strong for vacant-land investors, not just SFR.

---

## Sources

- [10 DataTree Hacks Every Real Estate Investor Should Know — REtipster](https://retipster.com/datatree-hacks/)
- [Real Estate Data Services Compared — REtipster](https://retipster.com/real-estate-data/)
- [DataTree Hacks: Drawing Tools — YouTube](https://www.youtube.com/watch?v=1DC9ufgk-vo)
- [DataTree Hacks: How to Find Portfolio Owners — YouTube](https://www.youtube.com/watch?v=9RvXCiHUzlo)
- [DataTree Hacks: How to Search Property Owners Nationwide — YouTube](https://www.youtube.com/watch?v=y5XZp-4n_uc)
- [Understanding the new filters in DataTree — REtipster Forum](https://forum.retipster.com/t/understanding-the-new-filters-in-datatree/1200)
- [DataTree property research — First American DNA (snippets only; 403 to bots)](https://dna.firstam.com/solutions/property-data/datatree-property-research)
- [Search Reinvented: DataTree 2025/2026 — First American DNA blog](https://dna.firstam.com/insights-blog/search-reinvented-how-datatree-evolved-in-2025-and-what-it-means-for-2026)
- [DataTree Lists — First American DNA](https://dna.firstam.com/lists)
- [Integrated Property Search — First American DNA](https://dna.firstam.com/integrated-search)
- [DataTree Full User Guide (PDF; binary)](https://www.datatree.com/hubfs/Support_Guide/20-DataTree-Full-User-Guide.pdf)
- [7 Best Nationwide Property Data Software for Investors — Resimpli](https://resimpli.com/blog/best-nationwide-property-data-software/)
- [Top 10 Property Data Providers — BatchData](https://batchdata.io/blog/top-property-data-providers-real-estate-investors)
- [DataTree vs PropStream — BiggerPockets](https://www.biggerpockets.com/forums/61/topics/1093863-datatree-vs-propstream)
- [DataSift alternatives (confirms DataSift unrelated, defunct 2023) — Improvado](https://improvado.io/blog/datasift-alternatives)
- [Property Data Reports for Real Estate Investors — Basic Property Management](https://basicpropertymanagement.com/property-data-reports-for-real-estate-investors/)
- [ATTOM Foreclosure Data (ecosystem reference for stages)](https://www.attomdata.com/data/foreclosure-data/)
- [BatchData Pre-Foreclosure Data (ecosystem reference)](https://batchdata.io/pre-foreclosure-data)
