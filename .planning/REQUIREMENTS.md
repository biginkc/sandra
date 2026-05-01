# Requirements — Milestone v2.0

**Goal:** Apply the search/sort/filter pattern shipped on `/properties` to the remaining CRM tables, and rename the market vocabulary from city-shaped to county-shaped.

---

## v2.0 Requirements

### Cross-Table UX Consistency

- [ ] **TABLE-01**: User sees a unified rounded-card toolbar (search input + filter pills) on every CRM index page (`/lists`, `/jobs`, `/templates`), matching the pattern on `/properties` and `/leads`
- [ ] **TABLE-02**: User can free-text search the primary identifier column on `/lists` (list name), `/jobs` (job title or id), `/templates` (template name)
- [ ] **TABLE-03**: User can click any column header to sort ascending; clicking again flips to descending; an arrow icon shows current sort + direction
- [ ] **TABLE-04**: Sort and search state lives in URL params (shareable, back-button correct, survives refresh)
- [ ] **TABLE-05**: Pagination links preserve sort + search state across pages
- [ ] **TABLE-06**: A skeleton loader replaces table rows during URL-driven navigation (search, sort, filter changes)
- [ ] **TABLE-07**: A reusable `<TableToolbar>` + `<SortableHeader>` component pair extracted into `src/components/ui/` so future tables can opt in without duplicating the implementation

### Market Vocabulary Refactor

- [ ] **MARKET-01**: All four market values rename from city-shaped to county-shaped (specific names locked during phase 2 SPEC step — needs Jarrad's input on the operational mapping)
- [ ] **MARKET-02**: `WizardMarket` type, `KNOWN_MARKETS` const, validation logic, and Wizard UI dropdowns all reference the new vocabulary
- [ ] **MARKET-03**: Existing `properties.market` rows are updated via a migration that maps old → new values 1-to-1 (no data loss, no orphan rows)
- [ ] **MARKET-04**: Existing prod data shows the new market labels everywhere they're rendered (filters, dashboards, lead cards, prospects table)
- [ ] **MARKET-05**: All tests referencing market values are updated; CI is green

---

## Future Requirements (deferred from v2.0 scope)

- `/leads` kanban sort/search alignment (different UX surface — current pattern works; revisit only if friction shows up)
- `/messages` cockpit search beyond what already exists
- Cross-table column-set customization (show/hide, reorder)
- Saved filter presets ("My open leads", "Vacant verified KCK")

---

## Out of Scope

- 46-property CASS recovery (operational, not a code change)
- Playwright retries `1 → 2` (one-line bump, `/gsd-fast` later)
- `/admin/skip-trace-settings` page (`/gsd-quick` later if not too coupled)
- Replacing the kanban with a table view on `/leads` (kanban is intentional UX)

---

## Traceability (filled by roadmap)

| REQ-ID    | Phase  |
|-----------|--------|
| TABLE-01  | Phase 1 |
| TABLE-02  | Phase 1 |
| TABLE-03  | Phase 1 |
| TABLE-04  | Phase 1 |
| TABLE-05  | Phase 1 |
| TABLE-06  | Phase 1 |
| TABLE-07  | Phase 1 |
| MARKET-01 | Phase 2 |
| MARKET-02 | Phase 2 |
| MARKET-03 | Phase 2 |
| MARKET-04 | Phase 2 |
| MARKET-05 | Phase 2 |
