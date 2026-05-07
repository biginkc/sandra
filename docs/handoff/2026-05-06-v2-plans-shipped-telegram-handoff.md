# Session Handoff — 2026-05-06 — V2 Plans Shipped, Ready for Execute (Telegram)

> **Continuing via Telegram / remote mode.** Use `--text` on every interactive GSD command — Telegram doesn't render TUI menus.

---

## Copy-paste prompt for new Telegram session

```
Sandra session handoff — 2026-05-06 (Telegram continuation).

Phase 04 (V2 Tasks Integrations — Slack + Google Calendar) is fully
PLANNED and committed to main. 10 PLAN.md files across 7 waves. Need
to execute now.

Read docs/handoff/2026-05-06-v2-plans-shipped-telegram-handoff.md for
full context. Then run:

/gsd-execute-phase 04 --text

The --text flag is mandatory for Telegram (TUI menus don't render).
Two human checkpoints will pause execution: Plan 04 (CI schema-push
verification, ~Wave 2) and Plan 10 (manual Slack + Calendar smoke,
~Wave 6).

Model: executor on Opus, verifier on Sonnet (configured in .planning/config.json).
```

---

## Current State

- **Branch:** `main` — clean, all V2 planning artifacts committed
- **Open PRs:** 0
- **Last commit:** plans + roadmap + state for Phase 04
- **What's done:** discuss-phase, research, pattern-mapping, planner, plan-checker (narrowed PASS)
- **What's next:** `/gsd-execute-phase 04 --text`

## Phase 04 Locked Decisions

All in `.planning/phases/04-tasks-integrations-v2-slack-google-calendar/04-CONTEXT.md` (D-01 through D-17). Highlights:

- **D-01:** Per-user OAuth (Slack)
- **D-02:** `user_oauth_tokens` table with composite PK `(user_id, provider, token_type)` — Slack needs both bot AND user tokens
- **D-05:** Google Calendar Events (NOT Tasks API), 30-min blocks at `due_at`, property address as `location`
- **D-07:** One-way sync — task complete is no-op (accept stale events)
- **D-09:** pgcrypto column encryption, key in `OAUTH_TOKEN_ENCRYPTION_KEY` Vercel env
- **D-13:** Fire-and-forget background dispatch via Next 16 `after()` API
- **D-16:** `@slack/web-api` SDK directly, NOT Slack Bolt

## 10 Plans / 7 Waves

| Wave | Plans | Concern | Autonomous? |
|---|---|---|---|
| 0 | 04-01 | npm install `@slack/web-api` + `googleapis`, test scaffolds, env vars | yes |
| 1 | 04-02, 04-03 (parallel) | Migration 052 (token store) + 053 (prefs/timezone/tasks columns) | yes |
| 2 | 04-04 | **[BLOCKING] schema-push checkpoint** — confirm CI applied 052+053 to prod+test | **no — human gate** |
| 3 | 04-05, 04-06 (parallel) | Slack OAuth handshake routes + Google OAuth handshake routes | yes |
| 4 | 04-07, 04-08 (parallel) | Slack DM + Mark Done webhook + Calendar dispatcher | yes |
| 5 | 04-09 | `/settings/integrations` page + actions | yes |
| 6 | 04-10 | Wire dispatchers into `setOutreachDispo` via `after()` + **manual smoke** | **no — human gate** |

## Two human checkpoints to expect

### Checkpoint 1 (Plan 04, after Wave 1)

After migrations 052 + 053 land in PR + merge to main, you'll need to confirm:
1. `db-migrate.yml` workflow ran green
2. Both prod (copflsklaefwzipsrjqz) and test (ncsngxlcyxylaeskiteu) Supabase projects show the new tables
3. Run `npx supabase gen types typescript ...` to regenerate `src/lib/supabase/types.ts`

### Checkpoint 2 (Plan 10, after Wave 6)

Final smoke before declaring V2 shipped:
1. `/dashboard` → empty My Tasks panel still renders (V1 untouched)
2. `/settings/integrations` → connect Slack, then connect Google Calendar
3. Open a thread, set Nurture with date + assignee = a different user
4. That user receives Slack DM with "Mark Done" button
5. That user's Google Calendar shows the 30-min event at `due_at`
6. Click Slack "Mark Done" → task disappears from dashboard panel
7. Toggle one channel off in `/settings/integrations` → verify subsequent assignments respect the toggle

## Telegram-specific gotchas

- **Always pass `--text`** on GSD commands — TUI menus break in Telegram
- **Short messages** — Telegram's UI cuts off long responses; ask for shorter explanations if needed
- **Open URLs by tapping** — phone-friendly. Use `open <url>` carefully (might not work over Telegram)
- **No browser-based Playwright** — defer Playwright runs to a desktop session

## Files committed (reference)

```
.planning/phases/04-tasks-integrations-v2-slack-google-calendar/
├── 04-CONTEXT.md           (decisions D-01..D-17, canonical refs, code context)
├── 04-DISCUSSION-LOG.md    (audit trail)
├── 04-RESEARCH.md          (12 pitfalls, validation arch, threat model)
├── 04-PATTERNS.md          (16 files, 100% analog coverage)
├── 04-01-PLAN.md           (Wave 0)
├── 04-02-PLAN.md           (Wave 1 — migration 052)
├── 04-03-PLAN.md           (Wave 1 — migration 053)
├── 04-04-PLAN.md           (Wave 2 — [BLOCKING] schema-push)
├── 04-05-PLAN.md           (Wave 3 — Slack OAuth)
├── 04-06-PLAN.md           (Wave 3 — Google OAuth)
├── 04-07-PLAN.md           (Wave 4 — Slack DM + Mark Done webhook)
├── 04-08-PLAN.md           (Wave 4 — Calendar dispatcher)
├── 04-09-PLAN.md           (Wave 5 — settings page)
└── 04-10-PLAN.md           (Wave 6 — wire + smoke)
```

## V1 status (already shipped this session)

- PRs #111, #112, #113 all merged 2026-05-06
- Migration 051 (tasks table) live in prod + test
- V1 features verified live via Playwright (My Tasks panel + dispo assignee selector)
- See `docs/handoff/2026-05-06-tasks-substrate-shipped.md` for V1 details

## What's queued AFTER V2 ships

- **46-property CASS recovery** — operational
- **`/admin/skip-trace-settings`** page — `/gsd-quick`
- **`/admin/counties`** page — `/gsd-quick`
- V3+ task ecosystem extensions (recurring tasks, bulk reassign, slash commands, two-way Calendar sync, etc.)

---

*Generated 2026-05-06 — V2 plans approved, awaiting execute. Resume via `/gsd-execute-phase 04 --text` from a fresh Telegram session.*
