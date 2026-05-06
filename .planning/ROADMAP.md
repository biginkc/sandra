# Roadmap — Sandra CRM

## Milestones

- ✅ **v1.x — Foundation** (archived) — see `.planning/milestones/v1.x-*`
- ✅ **v2.0 — Cross-table UX + market refactor** — Phases 1, 1.5, 2 (shipped 2026-05-06) — see `.planning/milestones/v2.0-ROADMAP.md`
- 🚧 **v2.1 — Operational Visibility** — Phase 03 (in progress)

## Phases

<details>
<summary>✅ v2.0 — Cross-table UX consistency + market refactor (3 phases) — SHIPPED 2026-05-06</summary>

- [x] Phase 1: Cross-Table UX Consistency (6/6 plans) — completed 2026-05-01
- [x] Phase 1.5: Sandra Design System Retrofit (5/5 plans) — completed 2026-05-04
- [x] Phase 2: Market Vocabulary Refactor (5/5 plans) — completed 2026-05-05

**Note:** Closed with audit gaps acknowledged as tech debt. See `.planning/milestones/v2.0-MILESTONE-AUDIT.md`:
- Phase 01 + Phase 02 shipped without VERIFICATION.md (process gap — both phases live in prod with green CI)
- MARKET-05 orphaned (intent satisfied via green CI, never mapped to a plan frontmatter)
- DS-05 visual regression check pending human sign-off

</details>

### 🚧 v2.1 — Operational Visibility (1 phase)

- [ ] **Phase 03: Operational Visibility Surfaces** — Three small visibility tweaks across `/dashboard`, the notification bell, and `/messages`

## Phase Details

### Phase 03: Operational Visibility Surfaces

**Goal:** Surface the right operational signals at a glance — accurate skip-trace coverage on the dashboard, SMS reply text in notifications, and an unread filter on the messages inbox.

**Depends on:** Nothing (clean start on top of v2.0)

**Requirements:** DASH-01, NOTIF-01, MSG-01

**Success Criteria** (what must be TRUE):
  1. Dashboard skip-trace coverage widget reports a count and percentage that includes every property regardless of pipeline status (prospects + leads combined), matching the underlying `properties` row count.
  2. Notification bell items for "New SMS reply" render a truncated preview of the actual reply body beneath the property address, with proper overflow handling.
  3. The `/messages` inbox exposes an "Unread" filter pill (alongside the existing All / Mine / Unassigned / Unknown / Dismissed pills) that, when active, shows only conversations with at least one unread inbound message.
  4. The Unread filter round-trips through the URL like the other inbox filters and clears cleanly when toggled off.
  5. CI is green: typecheck + unit + RTL + Playwright golden paths.

**Plans:** TBD

**UI hint**: yes

---

## Out of Scope (this milestone)

See REQUIREMENTS.md > Out of Scope for the full list and rationale.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 03. Operational Visibility Surfaces | 0/0 | Not started | — |
