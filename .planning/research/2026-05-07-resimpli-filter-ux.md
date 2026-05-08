# REsimpli Filter UX — Research Notes

**Date:** 2026-05-07
**Purpose:** Inform design of Sandra's right-side prospect-filter panel by documenting how REsimpli (a wholesale-RE CRM Jarrad named specifically) handles list/lead/prospect filtering today.

---

## TL;DR — what's worth stealing

After reading every REsimpli help-page, feature-page, and review I could find publicly, these are the 5–7 ideas that jumped off the page as more than "yet another filter chip":

1. **List Stacking as the central abstraction, not a side feature.** REsimpli's filter UX is built around overlaying multiple uploaded lists (probate, tax-delinquent, vacant, D4D, etc.) and finding the *intersection*. The user is explicitly thinking "absentee + tax-delinquent + 5+ years owned + 50%+ equity" — not "give me everything, then narrow." Sandra's filter panel should treat **stacking** (multi-criteria overlap) as a first-class affordance, not a side effect of AND'ing chips ([List Stacking guide](https://resimpli.com/blog/list-stacking/)).
2. **AND/OR toggle on the filter itself, with explicit Include vs. Exclude lists.** Every list/tag filter in REsimpli has a visible toggle that switches between "match ANY" and "match ALL," plus a parallel **List to Exclude** filter that subtracts records (NOT semantics) ([list-stacking blog](https://resimpli.com/blog/list-stacking/)). This is a much sharper mental model than a single AND-only filter bar — wholesalers genuinely think in unions, intersections, and exclusions, and the UI makes that explicit.
3. **Saved filter templates, named by the user, scoped to the user.** From `Buyers Database → Filter → Templates`, you can save a filter set as e.g. *"Only Mobile and No Email"* and one-click reapply later ([buyer-filter-option](https://resimpli.com/blog/buyer-filter-option/)). REsimpli also lets you save List Builder searches and re-pull them later — so the daily workflow is "open my saved filter, see what's new since last time" rather than rebuilding the query each morning ([List Builder](https://resimpli.com/features/list-builder/), [biggerpockets review](https://www.biggerpockets.com/blog/how-i-stopped-wasting-hours-hunting-for-real-estate-leads)).
4. **Auto List Builder — saved filters that re-run nightly and only surface deltas.** REsimpli's "Auto List Builder" automatically adds new matching records to a saved list every day ([List Builder](https://resimpli.com/features/list-builder/)). This makes a saved filter behave like a smart-list / segment that's always current, with zero rebuild effort. The platform also de-dupes automatically — "if you already added 500 records and now there are 510, it only adds the 10 new ones" ([biggerpockets review](https://www.biggerpockets.com/blog/how-i-stopped-wasting-hours-hunting-for-real-estate-leads)).
5. **Post-filter bulk actions are wired into the filtered set, not the whole table.** Once filtered, the user can multi-select (checkbox) and do: skip-trace, add/remove tags, add/remove from lists, push to drip campaign, export CSV, delete ([List Stacking complete guide](https://resimpli.com/blog/list-stacking/), [features overview](https://resimpli.com/features/)). The filter panel and the bulk-action bar feel like one tool, not two.
6. **Map-based geographic filter as a primary entry point.** List Builder leads with "search by city, ZIP, or county on an interactive map" — geography isn't buried on row 7 of a form, it's the entry experience ([List Builder](https://resimpli.com/features/list-builder/), [find-vacant-properties](https://resimpli.com/blog/how-can-i-find-vacant-properties-in-my-city/)). No public confirmation of polygon/draw-on-map (the search came back empty), so call it "ZIP/city/county on a map" rather than freehand.
7. **Bidirectional sync between Lists and Leads.** If a property gets tagged in Leads, the same tag appears in List Stacking and vice versa ([list-stacking-and-leads-integration](https://resimpli.com/blog/how-list-stacking-and-leads-integration-works/)). Filters and segments aren't a dead-end view — they're the same data the rest of the CRM operates on. Worth replicating so a saved filter on Prospects can drive a Sequence on the same set.

---

## 1. Filter categories REsimpli exposes

Grouped per Jarrad's request. Sources cited inline.

**Property attributes** ([List Builder](https://resimpli.com/features/list-builder/), [seller-list-combinations](https://resimpli.com/blog/best-seller-list-combinations-for-real-estate-investors/), [how-to-build-targeted-seller-lists](https://resimpli.com/blog/how-to-build-targeted-seller-lists/)):
- Bedrooms, bathrooms, square footage, lot size
- Property type (single-family, duplex, multi-family)
- House Type characteristics (mentioned in list-stacking ([guide](https://resimpli.com/blog/list-stacking/)) but not enumerated)
- Year built — *not explicitly confirmed* in public pages

**Ownership** ([List Builder](https://resimpli.com/features/list-builder/), [list-stacking](https://resimpli.com/blog/list-stacking/)):
- Absentee owner / Homeowner / Unknown (Owner Type)
- Out-of-state vs in-state owner
- Ownership Type (individual, corporate, trust, LLC)
- Years of ownership
- Owners with multiple properties (repeat-owner detection — distinctive)

**Financial** ([List Builder](https://resimpli.com/features/list-builder/), [seller-list-combinations](https://resimpli.com/blog/best-seller-list-combinations-for-real-estate-investors/)):
- Estimated property value (range)
- Equity percentage (e.g., "50%+ equity")
- Open mortgage balance, loan type
- Tax delinquent status
- Lien status
- Underwater (mentioned alongside lien/distress)

**Distress signals** ([find-vacant-properties](https://resimpli.com/blog/how-can-i-find-vacant-properties-in-my-city/), [seller-list-combinations](https://resimpli.com/blog/best-seller-list-combinations-for-real-estate-investors/), [how-to-build-targeted-seller-lists](https://resimpli.com/blog/how-to-build-targeted-seller-lists/)):
- Vacant (with vacant *date*)
- Pre-foreclosure / Notice of default
- Code violations
- Probate / inherited
- Divorce
- Bankruptcy — *implied via distress filters* but not enumerated as its own field publicly
- Tax delinquent

**Geographic** ([List Builder](https://resimpli.com/features/list-builder/), [find-vacant-properties](https://resimpli.com/blog/how-can-i-find-vacant-properties-in-my-city/)):
- State, county, city, ZIP — all surfaced via the map-based interactive interface
- Neighborhood / school district — *not confirmed* in public docs (assume not exposed)
- Polygon/draw-on-map — *not confirmed*; search returned no REsimpli-specific result

**Demographics**:
- Owner age, marital status — *not surfaced* in any public REsimpli page I reviewed. Treat as absent.

**List/source** ([list-stacking](https://resimpli.com/blog/list-stacking/), [list-stacking-and-leads-integration](https://resimpli.com/blog/how-list-stacking-and-leads-integration-works/)):
- List to Include (which uploaded lists count)
- List to Exclude (NOT this list)
- List Count: "is exactly N", "is between X and Y", "is more than N" (range/comparison operators on stack-depth)
- Marketing Type & Date (which campaign the lead came from)
- Direct Mail Sent + DM Type (Postcard, Yellow Letter, etc.)
- Skip Traced (Yes/No, with date and source)

**Engagement / status** ([how-to-filter-my-leads-in-resimpli](https://resimpli.com/blog/how-to-filter-my-leads-in-resimpli/), [list-stacking](https://resimpli.com/blog/list-stacking/)):
- Lead Assignment: market, role, user
- Tags, Drip Campaign membership
- Tasks: pending tasks / no pending tasks
- Lead age (start date / end date)
- Lead Status (Hot, Warm, Dead, etc.)
- In Leads / Lead Status (whether a list-stacking record has crossed over into a Lead)
- Phone Status (Busy, Correct, Disconnected)
- Phone Type (cell vs. business)
- Litigator + DNC flags
- Opted Out, Returned Mail
- Record Type (complete/incomplete with reason), Mailing Address Status (Valid/Invalid/Vacant/Missing)

## 2. Granularity inside each category

- **Numeric ranges with three operators**: List Count exposes "is exactly", "is between X and Y", "is more than" — same pattern likely applies to value/equity/sqft/year built, though only List Count is documented this way ([list-stacking](https://resimpli.com/blog/list-stacking/)).
- **Multi-select (in-list)**: tags, lists, lead assignees, markets — checkbox dropdowns ([how-to-filter-my-leads-in-resimpli](https://resimpli.com/blog/how-to-filter-my-leads-in-resimpli/)).
- **Date ranges**: start date / end date for lead age, vacant date, marketing date, skip-trace date.
- **Compound clever ones called out by REsimpli's own playbooks** ([seller-list-combinations](https://resimpli.com/blog/best-seller-list-combinations-for-real-estate-investors/)):
  - Absentee + High Equity + Long-Term Ownership (10+ yrs)
  - Vacant + Absentee + Out-of-State
  - Pre-Foreclosure + High Equity
  - Tax Delinquent + Long-Term Ownership + No Recent Sale
  - Code Violation + Absentee + High Equity

## 3. UI pattern

- **Trigger**: a filter icon in the **upper-right corner** of the screen ([how-to-filter-my-leads-in-resimpli](https://resimpli.com/blog/how-to-filter-my-leads-in-resimpli/), [list-stacking-and-leads-integration](https://resimpli.com/blog/how-list-stacking-and-leads-integration-works/)). No public docs confirm whether this opens a right-side drawer, modal, or expanded inline panel — REsimpli's own writing just calls it "the filter panel," and screenshots aren't reproduced in the marketing pages I could fetch. Reasonable inference from the language and from the Buyer-Filter article ([buyer-filter-option](https://resimpli.com/blog/buyer-filter-option/)) is a **right-side drawer/panel** that overlays the table — but treat as inference, not confirmed.
- **Layout inside the panel**: grouped by category. The Leads filter is documented as three groups: *Lead Assignment*, *Tags / Drips / Tasks*, *Lead Age & Status* ([how-to-filter-my-leads-in-resimpli](https://resimpli.com/blog/how-to-filter-my-leads-in-resimpli/)). List Stacking has many more groups (Property, Contact, Marketing, Data Quality). Looks like a flat-list-with-section-headers, not tabbed — accordion behavior unconfirmed.
- **Persistence across navigation**: not explicitly documented. The bidirectional Leads↔List-Stacking sync ([list-stacking-and-leads-integration](https://resimpli.com/blog/how-list-stacking-and-leads-integration-works/)) suggests state lives with the list, not the page.
- **Saved filter sets / named segments**: yes — Buyer filters have explicit **Templates** with custom names, user-scoped (not team-shared) ([buyer-filter-option](https://resimpli.com/blog/buyer-filter-option/)). List Builder supports save-and-rerun ([biggerpockets review](https://www.biggerpockets.com/blog/how-i-stopped-wasting-hours-hunting-for-real-estate-leads)). Auto List Builder takes saved filters and runs them daily ([List Builder](https://resimpli.com/features/list-builder/)).

## 4. Combination semantics

- **AND vs OR**: explicit toggle on the List Include and Tags filters — user picks "match ANY" or "match ALL" per filter group ([list-stacking](https://resimpli.com/blog/list-stacking/)).
- **NOT clauses**: implemented as a parallel *Exclude* filter (List to Exclude, exclude-tags) rather than a per-row negate. Cleaner UX than a NOT checkbox.
- **Nested groups**: not documented publicly. Likely implicit-AND across category groups, with the AND/OR toggle scoped to within a single multi-select.

## 5. Mobile/responsive treatment

REsimpli's iOS app supports filtering by Tags, Drips, Tasks, Lead Age, and Lead Status from the Lead List screen, with the same Active/Warm/Dead lead navigation as desktop ([App Store listing](https://apps.apple.com/us/app/resimpli/id1503295381), [how-to-use-resimpli](https://resimpli.com/blog/how-to-use-resimpli/)). The deeper List Stacking filters (phone status, ownership type, etc.) are not called out as mobile features — the field UX is biased toward driving-for-dollars and lead triage, not list-building. Real-time sync with desktop is the headline mobile claim. **No public detail on whether mobile uses the same drawer or a full-screen filter sheet** — assume bottom-sheet or full-screen modal on small viewports.

## 6. Bulk actions wired to the filtered set

After filtering and multi-selecting in List Stacking, available actions include ([list-stacking](https://resimpli.com/blog/list-stacking/), [features overview](https://resimpli.com/features/), [how-to-use-list-stacking-with-resimpli](https://resimpli.com/blog/how-to-use-list-stacking-with-resimpli/)):
- Delete records
- Skip trace (batch)
- Add / remove tags
- Add / remove from lists
- Push to marketing campaign (drip: SMS / email / RVM / direct mail)
- Export CSV (with an Export Log audit trail — Pro/Enterprise plans only)

On the Leads page, individual-card actions dominate (Call, SMS, Email, Drip, Hot-Lead toggle, drag-and-drop between pipeline stages) — true bulk operations live in List Stacking, not Leads ([what-actions-can-i-perform-from-main-leads-page](https://resimpli.com/blog/what-actions-can-i-perform-from-main-leads-page/)).

## 7. Genuinely distinctive

Beyond the TL;DR list:

- **Auto-tagging on skip-trace**: skip-traced records get auto-tagged so they're trivially filterable later ([features](https://resimpli.com/features/)).
- **Cross-list opt-out**: when a contact opts out of one list, they're flagged across every list ([list-stacking-review](https://resimpli.com/blog/list-stacking/)) — TCPA-friendly default that Sandra should mirror.
- **List Count operator**: filter on *how many* of your lists a property appears across (`is more than 3` = on 4+ lists = highest-priority overlap). Direct expression of stacking depth.
- **Owners with Multiple Properties** as a filter — surfaces "this person owns 7 doors in the same county" without manual SQL.
- **Drip + tag automations triggered by filter membership change** ([drip-and-tag-automations](https://resimpli.com/blog/new-drip-and-tag-automations-for-real-estate-investors/)) — once a record matches a filter, the system can auto-fire a drip. This is the natural pairing for Sandra's saved-filter feature: saved filter → auto-sequence.

---

## Confidence + gaps

- **High confidence** on filter category list, AND/OR toggle, save-templates, post-filter bulk actions — these are documented in REsimpli's own help-articles and feature pages.
- **Low confidence** on the literal UI pattern (right drawer vs modal vs sidebar) — REsimpli's marketing pages describe behavior, not chrome, and the public YouTube transcripts I fetched were empty boilerplate. A 30-min hands-on demo would lock this. Best inference: right-side drawer/overlay panel triggered from a filter icon top-right.
- **Confirmed-absent**: draw-on-map polygons, owner age/marital status filters, school-district filter, NOT-clause as per-filter negate. If we want any of these, we're going past REsimpli, not copying.
- **Mobile UX**: not deeply documented publicly.

## Sources

- https://resimpli.com/features/list-builder/
- https://resimpli.com/features/list-stacking/
- https://resimpli.com/features/
- https://resimpli.com/blog/list-stacking/
- https://resimpli.com/blog/what-is-list-stacking/
- https://resimpli.com/blog/how-to-use-list-stacking-with-resimpli/
- https://resimpli.com/blog/how-to-filter-my-leads-in-resimpli/
- https://resimpli.com/blog/how-list-stacking-and-leads-integration-works/
- https://resimpli.com/blog/best-seller-list-combinations-for-real-estate-investors/
- https://resimpli.com/blog/how-to-build-targeted-seller-lists/
- https://resimpli.com/blog/how-can-i-find-vacant-properties-in-my-city/
- https://resimpli.com/blog/buyer-filter-option/
- https://resimpli.com/blog/what-actions-can-i-perform-from-main-leads-page/
- https://resimpli.com/blog/wholesalers-guide-to-list-stacking/
- https://resimpli.com/blog/smartest-features-in-resimpli/
- https://resimpli.com/blog/new-drip-and-tag-automations-for-real-estate-investors/
- https://resimpli.com/blog/how-to-filter-dead-leads-by-the-reason/
- https://resimpli.com/blog/how-to-use-resimpli/
- https://resimpli.com/blog/resimpli-vs-reisift-list-stacking-and-crm-in-one-place/
- https://www.biggerpockets.com/blog/how-i-stopped-wasting-hours-hunting-for-real-estate-leads
- https://apps.apple.com/us/app/resimpli/id1503295381
