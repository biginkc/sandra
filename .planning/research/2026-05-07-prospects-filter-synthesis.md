# Sandra Prospects Filter Panel — Synthesis

**Date:** 2026-05-07
**Inputs:** Research files for [PropStream](2026-05-07-propstream-filter-ux.md), [DataTree](2026-05-07-datatree-filter-ux.md) (mis-fetched — see note), [REsimpli](2026-05-07-resimpli-filter-ux.md), [REISift / DataSift](2026-05-07-reisift-filter-ux.md), [Batchleads](2026-05-07-batchleads-filter-ux.md), plus an inventory of Sandra's current Prospects schema + filter capability.
**Goal:** Lock the taxonomy + UX direction for a right-side pop-out filter panel on `/properties`, with much more granularity than the current 5 chips.

> **Naming note:** REISift rebranded to **DataSift** in 2026-Q1. `reisift.io` 301-redirects to `datasift.ai`. Jarrad's "DataSift" reference was correct; the first research pass mis-routed to DataTree and that file is kept only for the discrete-foreclosure-stages reference. **Treat REISift / DataSift as the centerpiece** per Jarrad's brief.

---

## 1. TL;DR — what each tool does best, and what Sandra should steal

| Tool | What it does best | Steal for Sandra |
|---|---|---|
| **REISift / DataSift** *(the reference)* | **Filter Blocks** as the unit of composition. **Tri-state combinator chosen before values** (All / Any / Do Not Include). **Searchable filter library** at 60+ blocks. **Quick Filters chip bar per user**. **Last-Updated Field** compound filter (field + source + user + date). **Phone Status Combination** (all phones / any phone). **Folders + ACL on saved presets**. **Bulk cold-calling preset chain.** | Almost everything: information architecture, combinator-first tri-state, searchable library, Quick Filters bar, compound-row blocks, folder/ACL preset scoping, preset chain workflow. |
| **REsimpli** | List Stacking as the central abstraction. **Auto List Builder** — saved filters re-run nightly with auto-dedupe + delta notifications. Cross-list opt-out propagation. Drip-on-filter-membership-change. | The auto-refresh / Smart-Lists primitive REISift lacks. Pair this with REISift's filter-block model = best of both. |
| **PropStream** | 20 named **Lead Lists** as on-ramps. **Find-a-filter** keyword search. **Live "View N Properties" button**. Estimated Wholesale Value as a derived first-class filter. | Lead-List on-ramp idea (Sandra's saved presets cover this). Live result count. Find-a-filter search confirmed at scale. Derived metrics (equity %, LTV, wholesale value) as first-class filters. |
| **Batchleads** | **List Count slider** ("on ≥ N lists"). Tri-state Lists & Tags (Include / Exclude / Exclusively). Live chip counts. BatchRank AI motivation slider. Inline "Save Search" checkbox. | List Count operator (REISift has it as min/max — same idea). Live chip counts on Quick Filters. Inline Save Search checkbox at the apply moment. |

### The architectural shift — what changed after REISift research

The earlier draft of this synthesis proposed a **fixed accordion** (Property Details · Owner & Occupancy · Value & Equity · …). REISift's research forces a different model:

> **The drawer body is a stack of configurable filter blocks the user adds from a searchable library, not a fixed set of accordion sections.**

This is closer to Notion / Airtable / Linear filter UX than to PropStream's accordion. It scales to 60+ filters without becoming a wall of inputs (irrelevant blocks are simply not added). Within a block, the user picks the combinator (All / Any / Do Not Include) before picking values. Across blocks, AND only.

The accordion *taxonomy* still matters — it's the categorization of blocks in the "Add New Filter Block" picker. But the user's working surface is the block stack they've assembled.

---

## 2. UI architecture (drawer anatomy)

```
PROSPECTS PAGE — TABLE VIEW
┌──────────────────────────────────────────────────────────────────────┐
│  Prospects                                          [+ Filters (3)]  │  ← drawer trigger
│                                                                      │
│  Quick Filters:                                                      │  ← per-user chip bar
│  [Vacant ⓘ] [Verified] [Replied] [Cold]   [+ All Quick Filters ▾]    │     (replaces existing 5 chips)
│                                                                      │
│  Active filters:                                                     │  ← applied-filter chip bar
│  [Vacant: Yes ✕]  [List Count: ≥ 3 ✕]  [State: KS, MO ✕]  Clear all │     (always visible)
│                                                                      │
│  Showing 412 prospects                                               │
│  ┌────┬─────────────────────────────────┬────────────┬───────────┐   │
│  │ ☐  │ Address                         │ Market     │ Last Msg  │   │
└──────────────────────────────────────────────────────────────────────┘

DRAWER (right side, ~440 px)
┌─────────────────────────────────────────────────────────┐
│  Filters                                            ✕   │
├─────────────────────────────────────────────────────────┤
│  Preset:  [▾ ⭐ My Saved + Base Presets]                 │
│           ─ Base ─                                       │
│           Stacked · Vacant · Engaged · Cold · High Equ.. │
│           ─ Mine ─                                       │
│           High-Equity Vacant · KC Out-of-State · …       │
├─────────────────────────────────────────────────────────┤
│  ┌─ Block 1 ──────────────────────────────── ⋮ ✕ ┐      │  ← configured block row
│  │ Vacancy                                        │     │
│  │ ◯ Any  ● Yes  ◯ No                             │     │
│  └────────────────────────────────────────────────┘     │
│  ┌─ Block 2 ──────────────────────────────── ⋮ ✕ ┐      │
│  │ Lists  [▾ All Lists ▾]                         │     │
│  │   Probate · Vacant Mailings · Code Violations  │     │  ← combinator first
│  └────────────────────────────────────────────────┘     │
│  ┌─ Block 3 ──────────────────────────────── ⋮ ✕ ┐      │
│  │ List Count                                     │     │
│  │ Min [ 3 ]   Max [    ]                         │     │
│  └────────────────────────────────────────────────┘     │
│  ┌─ Block 4 ──────────────────────────────── ⋮ ✕ ┐      │
│  │ Last Updated Field                             │     │
│  │ Field: Pipeline Status                         │     │
│  │ Source: ◯ Any  ● Sequences  ◯ Manual  ◯ Bulk  │     │
│  │ When:  ● Last [ 30 ] days                      │     │
│  └────────────────────────────────────────────────┘     │
│                                                          │
│  [ + Add Filter Block ]                                  │  ← opens block-picker overlay
├─────────────────────────────────────────────────────────┤
│  ☐ Save as new preset…   [ name ]   [ folder ▾ ]         │
│  [ Clear all ]                  [ Show 412 prospects ]   │
└─────────────────────────────────────────────────────────┘

ADD-BLOCK PICKER (overlay inside drawer or stacked panel)
┌─────────────────────────────────────────────────────────┐
│  Add Filter Block                                   ✕   │
├─────────────────────────────────────────────────────────┤
│  🔍 Search filters…                                      │
├─────────────────────────────────────────────────────────┤
│  General                                                 │
│    Lists · Tags · List Count · Tag Count · Vacancy       │
│    CASS · Outreach Disposition · DNC · Opted Out         │
│    Skip-Trace Status · Direct Mailed · Source            │
│  Property                                                │
│    Beds · Baths · Sq Ft · Year Built · Lot Size · Type   │
│    State · City · ZIP · Market · Neighborhood            │
│  Owner                                                   │
│    Absentee · Owner Moved · Owner Type · Owner Age       │
│    Multi-Property Owner · Length of Ownership            │
│  Value & Equity                                          │
│    Estimated Value · Equity $ · Equity % · LTV %         │
│    Mortgage Balance · Estimated Wholesale Value          │
│  Status & Engagement                                     │
│    Pipeline Status · Engagement · Last-Message Age       │
│    Assignee · Created Date · Last Updated Field          │
│  Phone & Skip Trace                                      │
│    Phone Status (compound) · Has Phone · Has Email       │
│  Distress (v2)                                           │
│    Foreclosure Stage · Tax Delinquent · Lien · …         │
└─────────────────────────────────────────────────────────┘
```

**Key UX rules:**

- **Right-side drawer, ~440 px**, persistent (does not block the table — table reflows). Built on the existing `Sheet` component (`src/components/ui/sheet.tsx`).
- **Quick Filters chip bar** above the table = per-user pinned presets. Replaces the existing 5 chips. Sandra ships 4 base Quick Filters as starter pins (Vacant · Engaged · Cold · High Equity); user can star/unstar any preset to manage their own bar.
- **Active filters chip bar** sits between Quick Filters and the table. Always visible — even when drawer closed. Each chip has × to remove individually. Solves "why am I getting zero results."
- **Add Filter Block picker** opens as an overlay inside the drawer (or pushes a second panel). Has a search input at top + categorized list. Same block can be added multiple times.
- **Within a block:** combinator-first. The combinator (All / Any / Do Not Include for multi-selects; Any/Yes/No for booleans; min/max for numerics; etc.) sits above the value picker.
- **Across blocks:** AND only. No nested groups, no boolean builder, no parentheses. (REISift, REsimpli, PropStream, Batchleads all made this same trade.)
- **Live result-count button** at the bottom of the drawer: "Show N prospects" updates as the user toggles. Debounced (~250 ms).
- **Inline Save Search** at the bottom of the drawer (Batchleads pattern) — checkbox + name field + folder dropdown.

---

## 3. Filter taxonomy (the block library)

Each row tagged with current Sandra capability per the inventory:
**FREE** = column exists today · **CHEAP** = small migration · **VENDOR** = needs enrichment data we don't have.

### General (the workhorse blocks)
| Block | Operator | Status |
|---|---|---|
| **Lists** | tri-state All / Any / Do Not Include + multi-select | FREE (`property_lists`) |
| **Tags** | tri-state All / Any / Do Not Include + multi-select | FREE (`property_tags`) |
| **List Count** | min / max (REISift's invented primitive) | FREE (count over `property_lists`) |
| **Tag Count** | min / max | FREE |
| **Vacancy** | tri-state Any / Yes / No + vacant-since range | FREE (`is_vacant`, `vacant_since`) |
| **CASS / Verification** | multi-select (verified / unverified / invalid / ambiguous) | FREE (`cass_status`) |
| **Outreach Disposition** | multi-select (opted-out / DNC / wrong number / nurture / callback) | FREE (`outreach_dispo`) |
| **DNC** | tri-state | FREE (derived from `outreach_dispo`) |
| **Opted Out** | tri-state | FREE (derived) |
| **Skip-Trace Status** | tri-state Has / No / Either | CHEAP (derived flag) |
| **Direct Mailed** | tri-state + last-mailed-date range | DEFER (no DM column today) |
| **Source / Import** | multi-select of `csv_imports` rows | FREE |

### Property
| Block | Operator | Status |
|---|---|---|
| Beds | min/max | FREE (`beds`) |
| Baths | min/max | FREE (`baths`) |
| Sq ft | min/max | FREE (`sqft`) |
| Year built | min/max + presets ("before 1990") | FREE (`year_built`) |
| Lot size | min/max | CHEAP |
| Property type | multi-select (SFR, duplex, multi 2-4, multi 5+, condo, mobile, land) | CHEAP |
| State | multi-select | FREE |
| City | multi-select | FREE |
| ZIP | multi-select / contains | FREE |
| Market (county) | multi-select | FREE |
| Neighborhood | multi-select | DEFER |

### Owner & Occupancy
| Block | Operator | Status |
|---|---|---|
| Absentee | tri-state | FREE (`absentee_flag`) |
| Owner Moved | date range + presets | FREE (`owner_moved_at`) |
| Owner Type (individual / LLC / trust) | multi-select | VENDOR |
| Owner Age | min/max | VENDOR |
| Length of Ownership | min/max years | VENDOR (last_sale_date) |
| Multi-Property Owner | min count | VENDOR |
| In-State / Out-of-State Owner | tri-state | VENDOR |

### Value & Equity (derived metrics promoted to first-class)
| Block | Operator | Status |
|---|---|---|
| Estimated Value (ARV) | min/max | FREE (`arv`) |
| Equity $ | min/max | FREE (`equity_estimate`) |
| Equity % | min/max | FREE (derived from `equity_estimate / arv`) |
| LTV % | min/max | FREE (derived) |
| Mortgage Balance | min/max | FREE (`mortgage_balance`) |
| **Estimated Wholesale Value** (70 % of ARV) | min/max | FREE (derived) |

### Status & Engagement
| Block | Operator | Status |
|---|---|---|
| Pipeline Status | multi-select | FREE (`status`) |
| Engagement | multi-select (Never contacted / Attempted / Replied / Opted out) | FREE (derived) |
| Last-Message Age | min/max days | FREE (derived) |
| Assignee | multi-select + Unassigned | FREE (`assigned_user_id`) |
| Created Date | range + presets | FREE (`created_at`) |
| **Last Updated Field** | field + source + user + date *(REISift's diagnostic killer)* | DEFER to v1.1 (needs audit-log infra) |

### Phone & Skip Trace
| Block | Operator | Status |
|---|---|---|
| **Phone Status (compound)** | "All phones" vs "At least one phone" + multi-select status | DEFER to v1.1 (per-phone status not yet persisted) |
| Has Phone | tri-state | DEFER until skip-trace per-property is tracked |
| Has Email | tri-state | DEFER |

### Distress (v2 — vendor enrichment)
Foreclosure stage (NOD / Lis Pendens / NTS / Auction / REO) · Tax Delinquent · Lien (mechanic / IRS / state / HOA / judgment) · Bankruptcy (Ch 7 / Ch 13) · Divorce · Probate · Code Violations · Eviction.

---

## 4. Combination semantics (locked)

| Combination | Semantics |
|---|---|
| Across blocks | **AND** only |
| Within a block | depends on block type — see below |
| Multi-select block (Lists, Tags, Status) | tri-state combinator chosen first: **All** = AND across selected · **Any** = OR · **Do Not Include** = NOT IN |
| Tri-state boolean (Vacant, CASS, Absentee) | `Any` = no predicate · `Yes` = `is true` · `No` = `is false OR null` |
| Numeric block (List Count, Equity, Sq Ft) | min / max / range |
| Date block (Created, Owner Moved) | Fixed range / Since (date → today) / **Prior** (rolling — re-evaluates on preset reload) |

**No OR-across-blocks.** ("Vacant OR Tax-Delinquent" not expressible.) PropStream / DataTree / REsimpli / REISift / Batchleads all make the same trade. Sandra users build two presets and switch.

---

## 5. Saved Presets — folders, ACL, base presets, Quick Filters

This is where REISift is genuinely best-in-class and where the synthesis got the most upgrade.

### Preset model
- **Custom Presets:** user-saved filter configurations. Stored per-user, sharable by folder (see ACL).
- **Folders:** named containers for presets. Each folder has visibility ACL: `Everybody` · `Specific Users` · `Specific Roles`. VAs see the lead-management folder, principals see the strategy folders.
- **Base Presets:** ship with every account, can't be deleted, don't count toward limits. Suggested set for Sandra: **Stacked** (List Count ≥ 2) · **Vacant** · **Engaged** (Replied within 30 days) · **Cold** (Never contacted, > 30 days old) · **High Equity** (Equity % ≥ 50).
- **Lead-Management Presets:** also free of limits, scoped to operational workflows. Suggested: *New Leads Due Today* · *New Leads Overdue* · *Lead Follow-Ups Due Today* · *Leads with No Tasks* · *Replied + Not Yet Qualified*.
- **Quick Filters (per-user):** star a preset → it pins as a chip in the Quick Filters bar above the table. Each user manages their own bar. This replaces the existing 5 fixed chips with a personalizable bar.

### Auto-refresh (REsimpli's gap-filler over REISift)
Each saved preset runs nightly via a cron job, diffs against the previous snapshot, and shows "N new matches" as a badge on the preset name. Auto-dedupe. Delta drives an optional notification or trigger.

This is the one place where Sandra explicitly diverges from REISift (which has no auto-refresh) by borrowing REsimpli's Auto List Builder — best of both tools.

### Schema
One new migration: `saved_filters` table.

```
saved_filters
  id              uuid pk
  org_id          uuid
  user_id         uuid           -- nullable if folder is org-wide
  folder_id       uuid           -- nullable
  name            text
  filters_json    jsonb          -- the block-stack representation
  starred         boolean        -- pinned to Quick Filters bar
  is_base         boolean        -- ships with account, can't delete
  last_run_at     timestamptz
  last_count      int
  last_diff       int            -- # new since previous run
  created_at, updated_at

saved_filter_folders
  id              uuid pk
  org_id          uuid
  name            text
  visibility      text           -- 'everybody' | 'users' | 'roles'
  visibility_ids  uuid[]
```

---

## 6. Post-filter bulk actions

The existing prospects table already wires Add-to-list / Apply-tag / Assign / Skip-trace / Start-sequence. **v1 verification:** confirm those operate on the filtered selection (or the entire filtered set when "select all matching" is chosen). Add **Export CSV** if not already present.

REISift's **bulk cold-calling preset chain** is a workflow pattern the filter system enables, not a feature to build:
1. *Not Skip Traced* preset → bulk send to skip trace
2. *Needs First Attempt* preset (has phone, 0 attempts) → bulk start sequence
3. *Attempts 1–6* preset → keep calling
4. *Attempts 6+* preset → switch to mail / drop

Sandra ships the filters; users compose the chain.

---

## 7. v1 / v1.1 / v2 phasing

### v1 — ship from existing schema (the meat)
**Drawer + Quick Filters bar + Active filters chip bar + Add-Block picker, fully wired.**

Blocks shipped in v1:
- **General:** Lists, Tags, List Count, Tag Count, Vacancy, CASS, Outreach Disposition, DNC, Opted Out, Skip-Trace Status (derived), Source
- **Property:** Beds, Baths, Sq Ft, Year Built, State, City, ZIP, Market
- **Owner:** Absentee, Owner Moved
- **Value & Equity:** Estimated Value, Equity $, Equity %, LTV %, Mortgage Balance, Estimated Wholesale Value
- **Status & Engagement:** Pipeline Status, Engagement, Last-Message Age, Assignee, Created Date

Saved Presets:
- 5 Base Presets (Stacked, Vacant, Engaged, Cold, High Equity) — pinned to Quick Filters bar by default
- Custom Presets with folders + ACL
- Inline Save-as-new-preset
- Star = pin to Quick Filters bar (per-user)
- Nightly auto-refresh + diff notification

Migrations: `saved_filters` + `saved_filter_folders` tables. Optional: derived `is_skip_traced` view or direct query against `skip_trace_cache`.

Existing UI primitives reused: `Sheet` (right drawer), `DropdownMenu` (combinators), `Dialog` (Save Search), `Checkbox`, `RadioGroup`, `Slider`, `Input`.

### v1.1 — cheap column adds + diagnostic blocks
- `lot_size`, `property_type`, `neighborhood` columns + corresponding blocks
- **Last-Updated Field block** (REISift's diagnostic killer — needs lightweight audit-log per-field)
- **Phone Status (compound)** + Has Phone / Has Email blocks (needs per-phone status persistence)
- **Direct-Mailed** block (needs DM history table)
- Drip-on-preset-membership-change trigger (REsimpli pattern)

### v2 — vendor enrichment (the big data work)
- Distress section in full: foreclosure stage, lien, tax-delinquent, bankruptcy, divorce, probate, code violations, eviction
- LLC/trust ownership, in-state vs out-of-state, length of ownership, multi-property owner, owner age
- Draw-on-map (polygon / radius)
- AI motivation score (once Sandra's responder data is rich enough)

---

## 8. Decisions for Jarrad to lock

To keep these light per Jarrad's "one decision at a time" rule, drip them across responses. Here's the queue, in priority order:

1. **Drawer model — Filter Blocks (REISift) vs Fixed Accordion (PropStream).** Recommended: **Filter Blocks**. ⭐
2. **Quick Filters bar replaces existing 5 chips with per-user pinned presets** — confirm or keep 5 chips static.
3. **Engagement multi-select buckets:** *Never contacted · Attempted · Replied · Opted out*. Confirm or revise.
4. **Saved-preset scope:** v1 per-user with folder ACL (REISift model), or simpler per-user-only?
5. **Base Presets to ship:** Stacked · Vacant · Engaged · Cold · High Equity. Add/remove?
6. **Auto-refresh:** ship in v1 (cron + diff notification) or defer to v1.1?
7. **Map-drawing in v2 — meaningful priority, or skip indefinitely?**
8. **Export CSV — already exists? Or add in v1?**

---

## 9. Recommended next steps

1. Walk Jarrad through Decision #1 (drawer model) — single ask, no stacking
2. Once locked, drip Decisions 2–8 across follow-up responses
3. Sketch the drawer mockup in Stitch / HTML at the locked architecture; open in Chrome
4. `/gsd-spec-phase` for falsifiable requirements
5. `/gsd-plan-phase` for executable plan
6. Migration first (`saved_filters` + `saved_filter_folders`), then drawer shell, then block library, then individual block components, then Quick Filters bar
