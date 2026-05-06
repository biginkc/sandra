# Roadmap — Sandra CRM

## Milestones

- ✅ **v1.x — Foundation** (archived) — see `.planning/milestones/v1.x-*`
- ✅ **v2.0 — Cross-table UX + market refactor** — Phases 1, 1.5, 2 (shipped 2026-05-06) — see `.planning/milestones/v2.0-ROADMAP.md`
- 🚧 **v2.1 — Operational Visibility + Integrations** — Phase 03 shipped, Phase 04 next

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

### 🚧 v2.1 — Operational Visibility + Integrations (2 phases)

- [x] **Phase 03: Operational Visibility Surfaces** — NOTIF-01 + DASH-01 + MSG-01 (shipped outside GSD on 2026-05-06, commit e461156). Tasks substrate (V1) also shipped 2026-05-06 via PR #112 (FOLL-01 / FOLL-02 covered).
- [ ] **Phase 04: Tasks Integrations (V2 — Slack + Google Calendar)** — Outbound delivery surfaces for the V1 Tasks substrate

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

**Plans:** Shipped outside GSD (commit e461156 on 2026-05-06)

**UI hint**: yes

---

### Phase 04: Tasks Integrations (V2 — Slack + Google Calendar)

**Goal:** Make the Tasks substrate's `task_assigned` events visible where VAs and the owner already work — Slack DMs and Google Calendar — so they don't need to camp on the Sandra dashboard. One-way outbound; CRM stays the source of truth.

**Depends on:** Phase 03 (V1 Tasks substrate — shipped via PR #112; provides `tasks` table, `dispatchTaskAssigned`, and the `task_assigned` notification event type that this phase hooks into).

**Requirements:** SLACK-01, CAL-01, INTEG-01

**Success Criteria** (what must be TRUE):
  1. When a task is assigned (via the dispo popover) to a user other than the actor, that user receives a Slack DM with task title, property address, due date, and a one-click "Mark Done" button. Clicking the button updates the task in the CRM and the Slack message reflects the new state.
  2. When a task is created or its due_at changes, a corresponding 30-minute event lands on the assignee's Google Calendar (their primary calendar, in their stored timezone). Task completion does NOT delete the event — accept stale events as the documented tradeoff.
  3. Each user can connect / disconnect Slack and Google Calendar in `/settings/integrations` and toggle each delivery channel on/off independently. OAuth refresh tokens are stored encrypted; never logged.
  4. Existing in-app dashboard panel + bell notification continue to work — the Slack and Calendar paths are additive, not replacements.
  5. CI is green: typecheck + unit + RTL + Playwright golden paths.

**Plans:** TBD (run `/gsd-plan-phase 04` after `/gsd-discuss-phase 04` lands CONTEXT.md).

**UI hint**: yes — `/settings/integrations` connection UI is new; existing dashboard panel + notifications bell are unchanged.

**Notes / open architectural questions for discuss-phase:**
- Slack workspace-level vs per-user OAuth scope
- `@slack/web-api` vs Slack Bolt framework on Next.js App Router
- Google Calendar event vs Google Tasks API (events = visible/blocking; tasks = sidebar todos)
- Encrypted token storage shape (`user_oauth_tokens` table with column-level encryption vs Supabase Vault)
- Async dispatch worker pattern (synchronous in webhook? background queue? Vercel cron?)
- Slack inbound (`/follow-up` slash command) — defer to V3 or include in V2?
- Notification preferences UI granularity (all-or-nothing per channel, or per-event-type?)

---

## Out of Scope (this milestone)

See REQUIREMENTS.md > Out of Scope for the full list and rationale.

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 03. Operational Visibility Surfaces | — | Shipped (outside GSD) + V1 Tasks via PR #112 | 2026-05-06 |
| 04. Tasks Integrations (V2 — Slack + Calendar) | 0/0 | Not started — awaiting `/gsd-discuss-phase 04` | — |
