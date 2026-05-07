# Phase 04: Tasks Integrations (V2 — Slack + Google Calendar) - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-06
**Phase:** 04-tasks-integrations-v2-slack-google-calendar
**Areas discussed:** Slack OAuth scope, Calendar entity choice, OAuth token storage, Dispatch pattern

---

## Slack OAuth scope

| Option | Description | Selected |
|--------|-------------|----------|
| A | Per-user OAuth — each user connects their own Slack identity in `/settings/integrations`. Symmetric with Calendar OAuth. | ✓ |
| B | Workspace-level OAuth — Jarrad (admin) installs the Sandra app once into the BMH workspace. Sandra knows every user via `users:read`. | |

**User's choice:** A — "Independent."
**Notes:** User wanted per-user/independent. Matches the Calendar OAuth requirement (Google requires per-user grant). Symmetric pattern is cleaner.

---

## Calendar entity choice

| Option | Description | Selected |
|--------|-------------|----------|
| A | Google Calendar Events — visible 30-min blocks on the timeline at `due_at`, support `location` (property address → mobile maps deep-link), reminders, attendees. | ✓ |
| B | Google Tasks API — sidebar todo panel; doesn't block time on the calendar grid; no `location` support. | |

**User's choice:** A — "Walk."
**Notes:** Wholesale RE follow-ups are time-blocked work; VAs need to SEE callbacks on the calendar timeline. Property address as `location` gets free maps deep-linking on mobile.

---

## OAuth token storage

| Option | Description | Selected |
|--------|-------------|----------|
| A | Encrypted column in new `user_oauth_tokens` table — pgcrypto `pgp_sym_encrypt`, key in Vercel env (`OAUTH_TOKEN_ENCRYPTION_KEY`), SECURITY DEFINER decrypt fn. | ✓ |
| B | Supabase Vault (`vault.create_secret`, `vault.decrypted_secrets`) — per-user secret named like `oauth_<user_id>_<provider>`. | |
| C | Hybrid — opaque session_id in Postgres, tokens in Vercel KV / Upstash Redis. | |
| D | External KMS (AWS / GCP) for envelope encryption. | |
| E | Piggyback Supabase Auth `provider_refresh_token` from social login. | |

**User's choice:** A — confirmed by background research agent ("I want you to spawn a research agent to figure out the best way to do this.")
**Notes:** Research surfaced a critical detail: **Slack needs both bot AND user tokens**, requiring a `token_type` column with composite PK `(user_id, provider, token_type)`. Auth.js v5 (NextAuth) and Clerk both converge on the one-row-per-(user, provider) pattern. Supabase Vault is genuinely designed for workspace-level secrets, not per-user-per-provider rows — Supabase docs and forum discussions back this. Supabase Auth `provider_refresh_token` piggyback is not viable: Sandra users sign in with email/password (not OAuth), AND Slack isn't a Supabase Auth provider at all. External KMS is overkill at 5–10 users. Hybrid adds a second datastore for no proportional security gain.

---

## Dispatch pattern

| Option | Description | Selected |
|--------|-------------|----------|
| A | Fire-and-forget background dispatch via Next 16 `after()` — user feedback fast (~150ms); Slack outage doesn't block dispo write. | ✓ |
| B | Sync inline in `setOutreachDispo` — block on Slack + Calendar API responses; user sees loading spinner. | |
| C | Job queue (Vercel Queues / `task_dispatch_jobs` table + cron worker) — most robust but biggest infra. | |

**User's choice:** A — "Walk."
**Notes:** Sandra's existing pattern for non-blocking side effects (notifications dispatch, sequence pause on inbound) is fire-and-forget. Fits Vercel Fluid Compute's `after()` pattern naturally. C is overkill at 5–10 users; can graduate later if dispatch volume justifies.

---

## Claude's Discretion

- Schema details for `user_oauth_tokens` (index strategy beyond the composite PK).
- `/settings/integrations` UI shape — match `/settings/ai-responder` page styling.
- Slack message Block Kit formatting (header, context, action button) — exact blocks are an implementation detail.
- Google Event description body — title format, deep-link inclusion, etc.

## Deferred Ideas

- Slack inbound (slash commands, modals, message shortcuts) — V3+
- Two-way Calendar sync — V3+
- Per-event-type notification preferences — V3+ (V2 ships all-or-nothing per channel)
- Recurring tasks (RRULE) — V3+
- Auto-create tasks from sequence completion / stale-conversation rules — V3+
- Subsuming `needs_human_attention` into tasks — V3+
- External KMS / SOC2 compliance — deferred until compliance need emerges

---

**Total discussion: 4 gray areas resolved, 3 by user choice, 1 informed by background research agent.**
