# REISift Filter / List-Stacking UX — Deep Research

**Date:** 2026-05-07
**Subject:** REISift (rebranded "DataSift" 2026-Q1; product unchanged) Records-page filter & list-stacking UX
**Purpose:** Inform the Sandra Prospects right-side pop-out filter panel
**Companion docs:** `2026-05-07-resimpli-filter-ux.md`, `2026-05-07-propstream-filter-ux.md`, `2026-05-07-batchleads-filter-ux.md`, `2026-05-07-prospects-filter-synthesis.md`

> **Naming note:** REISift rebranded to **DataSift** in early 2026. `reisift.io` 301-redirects to `datasift.ai`. The Intercom help center URL still says `/reisift/`. I use "REISift" throughout because that's how every wholesaler still calls it and how the Sandra brief refers to it.

---

## TL;DR — Top 10 ideas Sandra's filter panel should steal from REISift

In rough order of "uniqueness × value":

1. **List Stacking as a first-class filter block with min/max operators (≥N, exactly N, between)** — not just a column. This is REISift's invented primitive. Stack count of 2+ is the canonical "high-motivation" segment in wholesaling. ([Filter Records Overview][fr], [Stacked Records][stacked])
2. **List membership tri-mode: All Lists (AND) / Any Lists (OR) / Do Not Include (NOT)** — distinct from a flat multiselect. The user picks the *combinator* before picking the lists. ([Filter by List][fbl])
3. **Tag tri-state with color (blue=include, red=exclude)** — visual encoding of the include/exclude state directly on the chip. ([Filter by Tag][fbt])
4. **"Filter blocks" as a stack of independent rows** — every category (Lists, Tags, Status, Phone Status, Last-Updated, etc.) is added as its own *block* that can be repeated, reordered, and individually combined with AND/OR within itself. The panel is a list of blocks, not a flat form. ([Filter Records Overview][fr])
5. **Searchable filter library** — when the panel has 60+ filters across 7 groups, REISift exposes a "Search for filter blocks" input above the group list. Users type "vacant" and only matching blocks surface. None of the other 3 tools does this. ([WebSearch result][ws-fr])
6. **Filter Presets with folders + per-user/per-role permissions** — saved filters live in named folders; folder ACL controls visibility. Quick Filters (starred presets) pin to the top of the records page per-user. ([Custom Presets][cp], [Quick Filters][qf])
7. **Compound "Phone Status Combination" block** — within the block, pick "All phones must X" vs "At least one phone must X." Same idea applies to Last-Updated (source + user + date range as a single compound row). REISift treats compound rows as the primary unit of filter composition. ([Phone Status][ps], [Last Updated][lu])
8. **"Exhausted Owner" as a derived/auto filter** — Sandra should generate a filter from a *rule over child records* (all phones for the owner are Wrong/DNC/Dead/NoAnswer). This unlocks segments without forcing the user to build five-block compounds. ([Exhausted Records][ex])
9. **Owner-Records page has its own filter panel** mirroring Records but with owner-specific blocks (Property Count, Phone Count, Email Count). Same component, different schema. ([Owner Filtering][own], [Multi-Property Owners][mpo])
10. **Last-Updated by source + user + date** — the most powerful filter REISift has. Lets you ask "show me records whose lead status was changed in the last 30 days by Sequences (not by humans)" — a compound nobody else exposes. ([Last Updated][lu])

**One callout:** REISift does **not** have true Smart Lists (auto-evaluating saved filters that fire alerts/notifications). It has saved presets + Sequences (event-driven automations on status/board/tag change) but no scheduled query. This is REsimpli's biggest filter-side advantage.

---

## 1. List Stacking — the mechanical model

REISift didn't just popularize list stacking; it productized it as a **filter operator**, not a UI overlay.

### How records get stacked
- **Lists** are user-created tags-with-context (Bankruptcy, High Equity, Code Violations, etc.). Recommended folder taxonomy: **Qualifying Data** (Adjustable Loans, Free & Clear, High Equity), **Vexation/Pain Points** (Arrests, Bankruptcy, Divorce, Foreclosure), **Property Type** (Commercial, Multi-Family, Vacant Land). ([Lists Page][lp])
- A property may belong to many lists. When two or more lists reference the same property, the system "automatically creates 'stacked records.'" Stacking is implicit — there is no "stack" object; stack-count is a derived value. ([Stacked Records][stacked])
- **Cross-list dedup** happens on upload via owner-name + property-address normalization. The article on uploading is silent on USPS validation specifics, but `Vacant Mailing` and `Vacant Property` filters exist as boolean fields populated by the data layer (not user-set). ([Uploading Base Data][upload])

### The List Stacking filter block
- **Operators:** *minimum* and *maximum* count of lists. To find any stacked record, set min=2. To find records on exactly one list, min=1, max=1. To find orphans (records on zero lists), min=0, max=0. ([Stacked Records][stacked])
- This filter is purely numeric; it does **not** care which lists you're on. To constrain *which*, combine with the List filter block.

### Stack-depth visualization
The help center is mute on stack visualization (no chip count, no badge). My read: the user sees the *consequence* of stacking via the count operator, not via a numeric badge on the row. **This is a gap Sandra can improve on** — show "On 4 of your lists" inline.

### Cross-list opt-out / DNC propagation
- DNC is a *phone-level* status, not a list-level flag. It propagates automatically across all properties owned by the same owner because skip-trace results are stored on the owner record, not the property record. ([Skip Tracing][st])
- **"If an owner has multiple properties in your account, you will not be charged multiple times within the same skip tracing activity"** — same owner, same DNC, applied everywhere. ([Skip Tracing][st])
- "Do Not Mail Ever" is a *separate property-level toggle* with its own filter, distinct from DNC. ([Direct Mail Filters][dmf])

---

## 2. Filter taxonomy — full inventory

REISift groups blocks into 7 sections under "Add New Filter Block." All quotes are from the [Filter Records Overview][fr] article unless noted.

### General (the core dozen)
Lists, Tags, Phone Tags, Phone Types, **Phone Status** (compound), **List Stacking (Count)**, Last Skip Trace Date, Upload Date, Tag Count, **Params & Others** (Absentee, Vacant Mailing, Vacant Property, Property PO Box, Owner PO Box, Numbers, Phone Type, Owner Type, DNC, Opt Out, Skiptraced, Direct Mailed, Deceased)

### Property Filters
Property Street, City, State, County, Zip, **Property Status** (custom-defined sales-cycle states like New Lead/Cold/Warm/Hot/Dead/Not Interested), **Assignee (User)**, Last Vacant Date, **Lead Temperature** (Cold/Warm/Hot, range-draggable), Last Unvacant, Last Updated Date, **Last Updated Fields**, Last Updated By

### Owner Filters
Owner Street, City, State, Zip, Phone Count, Age, Email Count, Last Updated Date/Fields/By, **Exhausted Owners** (derived — all phone numbers are Wrong/DNC/Dead/NoAnswer/Wrong_DNC; "No Status" and "Correct" exclude). ([Exhausted Records][ex])

### Offer Filters
Offer Count, Offer Status, Deal Post Contract Status, Last Offer

### Marketing
Direct Mail Attempts, Call Attempts, RVM Attempts, SMS Attempts, Call/RVM/SMS Attempts (Owner), Last Offer, **Last Direct Mailed Date**, **Last Mail Status** (Scheduled, Processing, En Route, Delivered, Undeliverable, Returned, Failed), **Direct Mail Campaign Name**, **Do Not Mail Ever**

### Additional Fields (property facts)
Above Grade, Number of Units, Bathrooms, Bedrooms, Estimate Value, tax info, dates

### SiftLine Filters
SiftLine Boards (kanban pipeline). REISift's kanban does not have its own filter UI — it filters via the same Records panel using a "SiftLine Boards" block. ([SiftLine][sl])

### Task Filters (under General/Records)
**Task Count** (min/max — find leads with zero tasks), **Task Name** (exact match), **Task Assigned To** (user OR role), **Task Status** (Overdue / Due Today / To Do / Due Date custom range). Within a single "Task" block, fields combine **AND**; adding multiple separate Task-Name/Assignee/Status blocks combines them **OR**. ([Task Filters][tf])

**Total surface area:** ~60 distinct filter blocks. The "Search for filter blocks" input at the top of the panel is essential at this scale.

---

## 3. Granularity / operators

| Block type | Operators |
|---|---|
| Multi-select (Lists, Tags, Status, Phone Type) | Tri-state: **All** (AND), **Any** (OR), **Do Not Include** (NOT) |
| Numeric (Stack Count, Task Count, Phone Count, Property Count, Attempts) | min, max, range |
| Date (Last Skip Trace, Upload, Last Mailed) | **Fixed** (locked dates), **Since** (date → today), **Prior** (rolling, e.g., "last 30 days") |
| Lead Temperature | Single value or **drag-to-range** (Warm + Hot) |
| Phone Status (compound) | "All phones" vs "At least one phone" + include/exclude per status value |
| Boolean (DNC, Skiptraced, Vacant) | Yes / No / Either |
| Last Updated Field (compound) | Field + Source (Integration/Bulk/Manual/Sequences/Upload) + User/Role + Date operator |

The **Prior** date operator is worth highlighting — it's a rolling window that re-evaluates when the preset is reloaded. Critical for "send to mailer monthly" workflows. ([Direct Mail Filters][dmf])

---

## 4. UI pattern — what does the panel actually look like?

This matters most because the user wants a right-side drawer specifically.

- **Trigger:** "Filter Records" button at the **top right** of the Records page. ([Filter Records Overview][fr])
- **Layout:** REISift uses a **modal/dialog** (not a true side-drawer) titled "Add New Filter Block." Inside the modal: a left-side category list (General / Property / Owner / Offer / Marketing / Additional / SiftLine), a top "Search for filter blocks" input, and the right side renders the chosen block's compound editor. ([WebSearch result][ws-fr])
- **Stacked blocks:** Once a block is configured and added, it appears as a row above the records table. Multiple blocks render as a vertical list. Each row has its own remove button.
- **Combination:** Blocks combine with **AND** across rows. Within a row, the operator (All/Any/Do Not Include) controls intra-row semantics. There is **no nested-group / boolean-builder** UI — REISift caps complexity at one level of nesting (intra-block) and AND-only across blocks.
- **Apply:** Bottom-right "Apply Filters" button.
- **Save:** "Save New" at top-right of the panel → name → folder pick.

> **This is NOT a right-side drawer.** It's a centered modal. So Sandra's "right pop-out" ambition is actually *better* than REISift's current pattern. The shadcn/Radix `Sheet` (right side, persistent, `vaul`-style) is the more modern equivalent of REISift's modal. The user can keep REISift's *information architecture* (block list + searchable library + tri-state operators) inside a right-drawer container.

### Quick Filters bar
Above the table (separate from the Filter Records modal), users see "Quick Filters" — pinned/starred saved presets rendered as chips. Click any chip → instant filter. Overflow → 3-dot menu. **Each user has their own Quick Filter set.** This is the workhorse for daily use; the modal is for ad-hoc construction. ([Quick Filters][qf])

---

## 5. Saved searches / presets / segments / scheduling

### Filter Presets
- **Save** via "Save New" → name → folder. ([Custom Presets][cp])
- **Folders** with ACL: "Everybody" or specific Users / Roles. Useful for VAs ("only see lead-management presets") vs principals. ([Custom Presets][cp])
- **Per-tier limits:**
  - Essentials: 3 custom presets
  - Professional: 8 custom presets ($149/mo)
  - Business: Unlimited ($299/mo)
  - Expert/AI: Unlimited ([Pricing][price])
- **Base Presets** ship with every account: **Stacked, Vacant, Ouchies (vexation lists), Equity** — and **don't count toward the custom limit**. ([Base Presets][bp])
- **Lead-Management presets** are also free of the custom-limit count. Recommended set: New Leads Due Today, New Leads Overdue, Lead Follow-Ups Due Today, Lead Follow-Ups Overdue, Leads with No Tasks. ([Lead Mgmt Presets][lmp])
- **Quick Filters:** star a preset → it pins as a chip above the table. Per-user. Unlimited. ([Quick Filters][qf])

### Smart Lists / scheduled alerts
**Not present.** REISift saved presets are *manual queries*; they do not auto-evaluate or fire alerts. There is no "notify me when a record matches X" or "email me a CSV every Monday." This is a real gap vs REsimpli (which has scheduled exports) and vs PropStream (which has saved-search alerts).

### Sequences (the closest substitute)
Sequences are event-driven automations with **Trigger → Condition → Action**:
- **Triggers:** status change, tag add, task completion, SiftLine board move
- **Conditions** (optional, filter-like): property status, assignee, tags, lists
- **Actions:** create task, change status, move card, delete, etc. ([Sequences][seq])

This is REISift's only "automation primitive" — it's reactive (fires on event) but not proactive (no schedule, no smart-list refresh). Per-tier: Professional 8, Business+ unlimited. ([Pricing][price])

---

## 6. Combination semantics

- **Within a block:** All / Any / Not (tri-state)
- **Across blocks:** AND only
- **No OR across blocks, no nested groups, no parentheses** — REISift consciously sacrifices boolean-builder power for simplicity. To express OR across categories (e.g., "Vacant OR High Equity"), users build two presets and switch between them.

This trade-off is well-chosen for wholesalers, who think in *segments* not in *boolean expressions*. Sandra should follow the same pattern: AND across blocks, tri-state within.

---

## 7. Post-filter bulk actions

Triggered from the action bar after row selection. Two top-level menus:

**Manage** ([Add/Remove Lists][alr], [Bulk Update][fr]):
- Add to Lists (multi-select, can create new inline)
- Remove Lists (multi-select)
- Add Tags / Remove Tags
- Update Property Status
- Update Lead Temperature
- Update Call/Mail/RVM/SMS Attempts (increment +1, set absolute, reset)
- Assign to User
- Export (CSV)
- Delete

**Send To** ([Skip Tracing][st], [Bulk Cold Calling][bcc]):
- **Skip Trace** (terms agreement → confirm cost — "$0 displayed for unlimited add-on, otherwise $0.15/contact at Professional, $0.12 at Business")
- **Direct Mail** (campaign picker)
- **Integrations → \[Dialer\]** (SmrtDialer, Mojo, etc. — OR via Zapier)
- **Integrations → SMS** (Launch Control, etc.)
- **RVM**

The recommended **bulk cold calling preset chain** is the canonical REISift workflow:
1. *Not Skip Traced* → Send to Skip Trace
2. *Needs First CC Attempt* (Numbers=Yes, Call Attempts min=0 max=0) → Send to Dialer → bulk-increment attempts +1
3. *Call Attempts 1–6* → continue calling
4. *Call Attempts 6+* → switch strategy (mail / drop)

Each stage *is* a preset. The cascade is the workflow. ([Bulk Cold Calling][bcc])

---

## 8. What REISift does that REsimpli, PropStream, Batchleads don't

1. **List Stacking as min/max numeric operator** — others have list "tags" you can multi-select but not "show me records on 3-or-more lists."
2. **Tri-state list/tag operators with color encoding** (blue/red) — others tend to use checkbox + a separate "exclude" toggle.
3. **Searchable filter library** — typing "vacant" filters the block menu to matching options. Critical at 60+ blocks.
4. **Folder-scoped preset ACL** — per-user/role visibility on saved searches.
5. **Quick Filters per user** — pinned chip bar above the table, personal to each team member.
6. **Compound "Last Updated Field" filter** — field + source + user + date in one block. Lets you ask "what changed via Sequences last week" — diagnostic power no other tool offers.
7. **Phone Status Combination** with "All phones / At least one phone" semantics — captures the difference between "has any DNC" vs "is fully DNC" (the latter = exhausted).
8. **Owner-records page mirrors property-records page** — same filter component, different schema. PropStream conflates owner and property; Batchleads emphasizes property; REsimpli has owner views but doesn't surface a parallel filter panel.

### Where REISift is *weaker*
- **No native list-pulling.** REISift makes you upload CSVs from PropStream/DataTree/etc. REsimpli has built-in nationwide property data; PropStream and Batchleads obviously do too. ([REsimpli vs REISift][rvr])
- **No built-in skip trace.** Pay-per-contact via REISift's vendor or BYO. REsimpli includes free skip trace. ([REsimpli vs REISift][rvr])
- **No dialer.** Integrations only.
- **No Smart Lists / scheduled alerts.** Presets are manual.
- **No AI scoring at non-AI tiers.** Investor AI Score gated to the $1,250/mo "AI" plan.
- **Customer support reputation:** the comparison post calls it "poor"; BiggerPockets thread is sparse but a user reports SmrtDialer integration data loss. ([REsimpli vs REISift][rvr], [BP forum][bp-forum])

---

## 9. REISift vs REsimpli — explicit matrix

| Dimension | REISift | REsimpli | Winner |
|---|---|---|---|
| Filter taxonomy depth | ~60 blocks across 7 groups | Comparable depth | **Tie** |
| List Stacking operator (min/max) | Yes, native filter block | Yes, but typically as Stack column + filter | **REISift** (slightly cleaner UX) |
| Tri-state include/exclude | Yes (visual blue/red) | Yes (separate exclude toggle) | **REISift** (clearer) |
| Saved presets | Folders + ACL, per-tier limits | Folders, no ACL | **REISift** |
| Quick Filters (pinned chips) | Yes, per user | Limited | **REISift** |
| Smart Lists / auto-refresh | No | Yes (some support) | **REsimpli** |
| Built-in property data / list pulling | No (BYO CSV) | Yes | **REsimpli** |
| Built-in skip trace | No (vendor add-on) | Yes (free, plan-based) | **REsimpli** |
| Built-in dialer | No | Yes | **REsimpli** |
| Drip campaigns (SMS/email/RVM/DM) | Sequences (event-based) only | Full drip + scheduling | **REsimpli** |
| AI agents | Only at $1,250 AI tier | 8 AI agents on standard plans | **REsimpli** |
| Mobile app | No | Yes | **REsimpli** |
| Kanban pipeline | Yes (SiftLine) | Yes (deal pipeline) | **Tie** |
| Sequences / automations | Trigger-condition-action | Comparable | **Tie** |
| Last-Updated by source/user | Yes (compound block) | Less granular | **REISift** |
| Exhausted-Owner filter | Native | No equivalent | **REISift** |
| Owner-records mirror filter panel | Yes | Yes but less surfaced | **REISift** |
| Pricing entry | $149/mo Pro | ~$99/mo entry | **REsimpli** |
| Reviews | ~360 | 2,330+ | **REsimpli** |

**Net read:** REISift wins on **filter sophistication and segmentation precision** for users who already have data and want surgical control. REsimpli wins on **everything else that touches the rest of the workflow** (data, dialer, skip trace, AI, mobile). For Sandra's *filter panel specifically* — REISift is the correct reference. For the broader CRM, REsimpli is the broader benchmark.

Sources for the comparison: [REsimpli's REISift-alternative page][rvr] (REsimpli-authored, biased), [resimpli vs reisift blog][rvr-blog] (also REsimpli-authored), [softwaretestingmaterial][stm] (third-party, lighter detail), [BP forum thread][bp-forum] (one user, asks-rather-than-answers — limited signal).

---

## 10. Pricing / tier-gating of filters

From [datasift.ai/pricing][price]:

| Feature | Professional $149 | Business $299 | Expert $499 | AI $1,250 |
|---|---|---|---|---|
| Custom filter presets | 8 | Unlimited | Unlimited | Unlimited |
| SiftLine boards | 8 | Unlimited | Unlimited | Unlimited |
| Custom statuses | 8 | Unlimited | Unlimited | Unlimited |
| Sequences | 8 | Unlimited | Unlimited | Unlimited |
| Users | 3 | 5 | 15 | 30 |
| Monthly new properties | 10k | 25k | 50k | 100k |
| Skip-trace cost | $0.15/contact | $0.12/contact | Unlimited | Unlimited |
| Bulk-marketing integrations | Outbound only | Inbound + Outbound | Inbound + Outbound | + AI |
| SiftMap Pro (distress overlay) | — | — | Included | Included |
| Investor/Realtor AI Score | — | — | — | Included |

**No advanced filter is paywalled by category** — Last Updated, Stacking, Phone Status are all available at Professional. The paywall is on **count limits** (presets, sequences, users) and on **AI scoring** (which is ranking, not filtering). This is healthier than PropStream's tier-locked filter set.

---

## Sources

[fr]: https://intercom.help/reisift/en/articles/6209588-filter-records-overview "Filter Records Overview"
[stacked]: https://intercom.help/reisift/en/articles/4364638-how-to-find-stacked-property-records "How to Find Stacked Property Records"
[fbl]: https://intercom.help/reisift/en/articles/5201803-how-to-filter-by-list "How to Filter by List"
[fbt]: https://intercom.help/reisift/en/articles/7960474-how-to-filter-by-tag "How to Filter by Tag"
[lp]: https://intercom.help/reisift/en/articles/4364644-lists-page-and-properly-managing-lists "Lists Page and Properly Managing Lists"
[upload]: https://intercom.help/reisift/en/articles/7925320-uploading-and-organizing-base-data "Uploading and Organizing Base Data"
[ps]: https://intercom.help/reisift/en/articles/7239707-filtering-by-phone-status "Filtering by Phone Status"
[lu]: https://intercom.help/reisift/en/articles/8298580-last-updated-field-filter "Last Updated Field Filter"
[ex]: https://intercom.help/reisift/en/articles/4998415-exhausted-records-from-marketing-money "Exhausted Records"
[own]: https://intercom.help/reisift/en/articles/6559207-filtering-owner-records "Filtering Owner Records"
[mpo]: https://intercom.help/reisift/en/articles/5530134-how-to-find-owners-with-multiple-properties "Multi-Property Owners"
[tf]: https://intercom.help/reisift/en/articles/6500062-task-filters-overview "Task Filters Overview"
[dmf]: https://intercom.help/reisift/en/articles/10035633-direct-mail-filters "Direct Mail Filters"
[cp]: https://intercom.help/reisift/en/articles/5942095-creating-custom-filter-presets "Creating Custom Filter Presets"
[bp]: https://intercom.help/reisift/en/articles/6620232-reisift-base-presets "REISift Base Presets"
[qf]: https://intercom.help/reisift/en/articles/12696639-speed-up-your-workflow-with-quick-filters "Quick Filters"
[lmp]: https://intercom.help/reisift/en/articles/9675521-setting-up-lead-management-filter-presets "Lead Management Presets"
[bcc]: https://intercom.help/reisift/en/articles/8381230-setting-up-filter-presets-for-bulk-cold-calling-flow-in-reisift "Bulk Cold Calling Preset Chain"
[st]: https://intercom.help/reisift/en/articles/4637016-skip-tracing-records-in-reisift "Skip Tracing Records"
[alr]: https://intercom.help/reisift/en/articles/11385774-adding-and-removing-lists "Adding and Removing Lists"
[sl]: https://intercom.help/reisift/en/articles/7733998-siftline-filters "SiftLine Filters"
[seq]: https://intercom.help/reisift/en/articles/6027453-how-to-create-sequences "How to Create Sequences"
[price]: https://www.datasift.ai/pricing "DataSift Pricing"
[blog-stack]: https://www.datasift.ai/blog-posts/list-stacking "REISift blog: List Stacking"
[rvr]: https://resimpli.com/reisift-alternative/ "REsimpli's REISift-alternative page"
[rvr-blog]: https://resimpli.com/blog/resimpli-vs-reisift/ "REsimpli vs REISift blog"
[stm]: https://www.softwaretestingmaterial.com/choosing-the-best-real-estate-investment-tools/ "Software Testing Material — REsimpli vs REIsift"
[bp-forum]: https://www.biggerpockets.com/forums/80/topics/1191685-reisift-vs-resimpli "BiggerPockets forum thread"
[ws-fr]: https://intercom.help/reisift/en/articles/6209588-filter-records-overview "Filter Records Overview (search-result snippet, 'Search for filter blocks' input)"
[realestateskills]: https://www.realestateskills.com/blog/reisift-review "Real Estate Skills — REISift Review"

### Conflicts and gaps the research surfaced
- **Skip-trace quality:** REsimpli's page calls REISift skip-trace "wrong information"; REISift describes it as paid-per-contact via its vendor. This is a marketing-source conflict — treat the negative claim with skepticism (it's REsimpli's own comparison page).
- **Smart Lists:** No REISift article mentions auto-refreshing saved searches. Multiple secondary sources say REISift has "Smart Filters" but the help center never uses that term — likely a marketing label for the saved-preset + Quick-Filter combo, **not** a true smart-list (auto-evaluating, alert-firing) primitive. I've called this a gap honestly.
- **Filter panel UI:** No public screenshot of REISift's filter modal could be retrieved via web fetch (Intercom articles include images that don't render through markdown conversion). The structural description (left category list, top search input, right block editor, AND-stacked rows above the table) is reconstructed from text descriptions across the [Filter Records Overview][fr], [Quick Filters][qf], and [Custom Presets][cp] articles. Treat layout details as text-derived, not visually verified.
- **Stack-depth visualization:** Help center is silent on whether stack count appears as a per-row badge. I noted this as a Sandra-can-improve gap.
