# Session handoff — 2026-04-28: Overview build, dashboard hardening, D4D import prep

This is a snapshot of an in-flight session captured for resumption in a fresh tab.

## Current state

Branch: `main` (all work merged). Working tree clean except for untracked `docs/research/transcripts/`, `docs/onboarding.pdf`, `docs/design/screenshots*` (Jarrad's local-only design refs).

Live at `https://sandra-sooty.vercel.app`.

## What shipped this session (PRs in order)

| PR | Title | Effect |
|---|---|---|
| #27 | Dashboard — Overview landing page with KPIs, alerts, donuts | New `/dashboard` route, sidebar Overview entry, `dashboard_summary` RPC |
| #29 | Fix dashboard_summary RPC — wrap union all branches in parens | SQL syntax fix in migration 025 |
| #30 | Fix dashboard_summary RPC — jobs.completed_at, not jobs.updated_at | Column name fix; RPC was throwing on every call |
| #31 | Fix login redirect — default to /dashboard, not /properties | Bare `/login` POSTs now land on Overview |
| #32 | Fix dashboard RPC for authenticated callers — drop auth.users join | RPC threw under `security invoker` because authenticated users lack GRANT on auth schema; emails resolve in TS via admin client |
| #33 | Filter activity-feed noise — URL-only bodies and system-error escalations | URL-only inbound bodies render `[link]`; `generate_error` / `safety:*` / `send_blocked:*` excluded from feed (still in threads rail) |
| #34 | Rename Leads filter chip "Unset" → "Not set" | Less ambiguous label |
| #35 | CSV import: auto-detect Skip Genie / DataTree (D4D) headers | 14 new aliases for PROP/PH-prefixed columns |

PR #26 ("Page + PageHeader components") was opened by Jarrad pre-session. Superseded by #27's squash-merge (commented but not closed — Jarrad's call).

## Key infrastructure changes

### Database (sandra-crm prod, project `copflsklaefwzipsrjqz`)

- **Migration 025** applied: `dashboard_summary()` RPC. Updated several times this session (RLS fix, jobs column fix, feed filters). Repo file matches what's running.
- **Test data wiped**: 65 of 66 properties soft-deleted on 2026-04-28T~19:50Z. Kept the canary at "1 Roundtrip Test Ln, HI" so the daily prod canary keeps its history.
- Active enrollments on the deleted properties were marked `completed` first (none were active in practice).

### Code

- New page: `src/app/(dashboard)/dashboard/page.tsx` + components in `_components/`
- New module: `src/lib/skip-trace/balance.ts` (60s-cached vendor-agnostic credit balance reader)
- Sidebar: "Overview" entry at index 0 (above Import) with `Gauge` icon
- Login redirect: root `/`, auth callback default, and signIn fallback all point to `/dashboard`
- Filter wiring on `/leads`: `?status=hot`, `?assignee=me|<id>`, `?unassigned=true`, `?no_active_sequence=true`, `?skip_traced=false` — server-side. `?stale=true` and `?sequence_ended=true` show a banner only (full filter is TODO).
- Verification scripts: `scripts/verify-dashboard-deploy.ts`, `scripts/verify-dashboard-authed.ts`, `scripts/verify-dashboard-localhost.ts` — Playwright probes against prod and localhost.

### CSV importer

- 14 new aliases in `src/lib/csv/aliases.ts` for Skip Genie / DataTree D4D format:
  - `prop: address full` → `address_full`
  - `prop: city/state/zip` → `city/state/zip`
  - `prop: parcel id number` / `prop: pid` → `apn`
  - `prop: first name/last name` → `homeowner_first_name/last_name`
  - `ph: phone1/phone2/phone3` → `homeowner_phone_1/2/3`
  - `prop: mail address full/city/state/zip` → `homeowner_mailing_*`
- INPUT-prefixed headers stay unmapped (PROP is verified; INPUT is user-submitted)

## Memory updates

Saved this session:

- `feedback_verify_with_playwright.md` — never ask Jarrad to refresh; verify with Playwright first
- `project_dashboard_shipped.md` — PR #27 + sub-PRs through PR #35 summary
- `feedback_vendor_abstraction.md` — appended note that UI labels also stay vendor-agnostic ("Skip-Trace Credits", never "Tracerfy Credits")

## What's in flight (next-tab pickup)

### 1. Manual D4D import

Jarrad is about to run the import wizard manually in the prod UI:

- File: `/Users/jarradhenry/Downloads/D4D_June_2021 - D4D_June_2021.csv`
- 1,854 rows (after header), 2.4 MB
- 955 MO + 736 KS + small smattering of other states
- 76% phone coverage (1,416 of 1,854 have at least one phone)
- Vintage: June 2021 — phones are ~5 years stale, expect dead/reassigned
- Header style: Skip Genie (`INPUT:`, `PROP:`, `PH:`, `REL1-5:`)

**Choices Jarrad will make in the wizard:**
- Target: **Prospects**, not Leads (these need vetting before pipeline)
- Address column: `PROP: Address Full` (auto-detected as `address_full`)
- Don't auto-enroll in any sequence — skip-trace first, decide later

**Watch-fors during import:**
- INPUT columns will appear unmapped (intentional)
- First two rows are commercial CA properties (`John Property Management Llc` etc.) — anomalies in an otherwise residential MO/KS file
- REL1–REL5 relative-contact data won't import (Sandra has no related-person model)

### 2. Bulk skip-trace after import

- ~1,854 prospects × $0.02/credit = ~$37
- Current balance: 4,990 credits — easily affordable
- Run before any sequence enrollment to refresh stale 2021 phones
- TCPA risk: these are 5-year-old contacts with no recent consent — don't blast on day one

### 3. VA handoff checklist

Saved at `docs/design/va-handoff-checklist.md`. 20 numbered flows across 5 tiers. Must-pass-five subset:
1. Sign-in → Overview → first action
4. Clear an AI escalation
5. Move a lead through the pipeline
10. Inbound reply hits the cockpit
13. STOP keyword stops the bot

All five must pass with real data + real phone before the VA gets the keys.

## Known not-done

- `?stale=true` and `?sequence_ended=true` filter wiring on `/leads` — banner only, no actual filter applied
- Stitch dashboard redesign was attempted, generation came back ugly, abandoned (not blocking)
- PR #26 still open — same diff as #27's squash; Jarrad's call to close
- Test DB (sandra-crm-test, project `ncsngxlcyxylaeskiteu`) has migration 025 applied as of this session — local dev works
- Activity feed shows promotional / agent-pitch inbounds (e.g. "Hello! Wanted to send you an invite to my broker open"). Filter requires tagging contacts as agent vs seller — V2 work.

## Test credentials

- Test-suite user: shared E2E account / `test12345` (stored in `e2e/fixtures.ts`)
- Test phone for outbound smoke: **+13107540662** (Jarrad's test phone)
- Twilio test receiver (inbound only): **+18148097074** — never a sender

## Verification scripts

```bash
# Prod, anonymous
npx tsx scripts/verify-dashboard-deploy.ts

# Prod, authenticated as test user (will fail if dashboard breaks)
npx tsx scripts/verify-dashboard-authed.ts

# Localhost (after npm run dev)
npx tsx scripts/verify-dashboard-localhost.ts
```

## Critical learnings (already in memory but worth re-stating)

- **Verify UI changes via Playwright before reporting done.** Don't ask Jarrad to refresh — run a probe first.
- **Vendor names never appear in dashboard UI.** Capability labels only ("Skip-Trace Credits"). Vendor names live in `/admin/skip-trace-settings`.
- **`security invoker` RPCs cannot reach the `auth` schema.** If you need user emails in an RPC result, return user_ids and resolve emails in TS via `createAdminClient()`.
- **`PostgrestError` stringifies to `{}`.** Always log message + code + details + hint explicitly when an RPC fails.
- **Soft-delete (`deleted_at = now()`) is reversible.** Use it for any prod cleanup unless the user explicitly wants a hard delete.
