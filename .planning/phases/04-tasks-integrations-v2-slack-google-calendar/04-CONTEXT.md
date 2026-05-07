# Phase 04: Tasks Integrations (V2 — Slack + Google Calendar) - Context

**Gathered:** 2026-05-06
**Status:** Ready for planning

<domain>
## Phase Boundary

V2 of the Tasks ecosystem. Adds two outbound delivery surfaces for the V1 Tasks substrate's `task_assigned` event:
1. **Slack DM** to the assignee with task title, property address, due date, and a one-click "Mark Done" button
2. **Google Calendar event** on the assignee's primary calendar at `due_at` (30-min block, property address as `location`)

Plus a `/settings/integrations` page where each user connects/disconnects their own Slack and Google accounts and toggles each delivery channel on/off independently.

**Strict scope:** one-way outbound only. CRM stays the source of truth. Slack inbound (slash commands, modals, message shortcuts) and two-way Calendar sync are deferred to V3+.

</domain>

<decisions>
## Implementation Decisions

### Slack OAuth + Token Storage

- **D-01: Per-user OAuth scope.** Each user connects their own Slack identity in `/settings/integrations`. No workspace-level admin install. Symmetric with Google Calendar OAuth (which has to be per-user — Google doesn't permit a service account to write to user calendars without domain-wide delegation, which is overkill here).
- **D-02: Slack needs BOTH bot AND user tokens.** Per Slack's docs and the OAuth research: bot tokens (workspace-scoped, do not expire) handle posting DMs as the Sandra app; user tokens (per-user, may expire) handle anything that needs to act AS the user. For V2 our outbound DMs use the bot token, but the schema must accommodate both — a `token_type CHECK (token_type IN ('user','bot'))` column on `user_oauth_tokens` with composite PK `(user_id, provider, token_type)`.
- **D-03: Default to bot token for outbound DMs.** Only request user scopes when the bot can't accomplish the task (Slack docs explicitly recommend this).

### Google Calendar OAuth + Behavior

- **D-04: Per-user OAuth.** Each user connects their own Google account. Refresh token stored encrypted in `user_oauth_tokens` (provider='google').
- **D-05: Calendar Events, not Google Tasks.** Events are visible on the timeline, support `location` (property address → mobile maps deep-link), support reminders, and match the wholesale-RE workflow (a VA needs to SEE the 2pm callback on their day). Tasks live in a sidebar panel and don't block time.
- **D-06: 30-minute event at `due_at` on the user's primary calendar.** In the user's stored timezone (per-user timezone resolution via the user_oauth_tokens / settings layer — V1 doesn't have per-user timezone, so this phase introduces it).
- **D-07: One-way sync.** Task create → write event. `due_at` change → update event. Task complete → **do nothing** (accept stale events; don't delete on completion). No two-way sync. Documented tradeoff.
- **D-08: `googleapis` SDK manages access-token rotation.** Wire the `oauth2Client.on('tokens', ...)` event to UPDATE the row whenever a new `access_token` (or rotated `refresh_token`) arrives. `access_type: 'offline'` + `prompt: 'consent'` on `generateAuthUrl` to ensure we get a refresh_token.

### OAuth Token Storage

- **D-09: Encrypted column in `user_oauth_tokens` table.** Columns: `(user_id, provider, token_type, access_token_encrypted bytea, refresh_token_encrypted bytea, access_token_expires_at, scopes text[], external_account_id, created_at, updated_at)`. Encryption via `pgcrypto`'s `pgp_sym_encrypt(plaintext, key)`. Key in `OAUTH_TOKEN_ENCRYPTION_KEY` Vercel env var — same trust boundary as Anthropic / Tracerfy / Twilio keys today, no new secret-management surface to learn.
- **D-10: SECURITY DEFINER decrypt function.** A server-side `get_oauth_token(user_id, provider, token_type)` SQL function that decrypts and returns plaintext. Never callable from the browser. Wrap in a TS helper that NEVER serializes through any logger — decrypted tokens never touch console.log / Sentry / structured logs.
- **D-11: RLS on `user_oauth_tokens`.** Each user can read their own row (encrypted). Decrypt is service-role only via the SECURITY DEFINER function.
- **D-12: Key rotation procedure.** Dual-key cutover: keep `OLD_KEY` and `NEW_KEY` in env during a migration that re-encrypts every row, then drop `OLD_KEY`. Documented in the migration file.
- **Rejected alternatives** (recorded so future-Claude doesn't re-litigate):
  - Supabase Vault — designed for workspace-level secrets, not N×M per-user-per-provider rows; no FK to app's users table; relational awkwardness for ~20 rows.
  - Hybrid (DB session_id + Vercel KV tokens) — refresh tokens are long-lived; KV TTL doesn't help; adds a second datastore + vendor.
  - External KMS (AWS/GCP) — overkill at 5-10 users; latency on every decrypt; cross-cloud dependency.
  - Supabase Auth `provider_refresh_token` piggyback — not viable: Sandra users sign in with email/password (not OAuth), AND Slack isn't a Supabase Auth provider.

### Dispatch Pattern

- **D-13: Fire-and-forget background dispatch.** Use Next 16's `after()` API (or a deferred promise chain) to call Slack + Calendar AFTER `setOutreachDispo` returns. User feedback stays fast (~150ms); a Slack outage doesn't block a dispo write. Failures logged via existing `reportError` (Sentry) but not user-visible — the task itself is in the DB regardless.
- **D-14: Same convention as existing dispatchers.** This matches `dispatchOwnerMessageAdded`, `dispatchPropertyAssigned`, `dispatchSkipTraceRequested` — they're all fire-and-forget best-effort. Slack and Calendar dispatchers slot into this established pattern.
- **D-15: Per-channel on/off toggle in `/settings/integrations`.** All-or-nothing per channel (Slack: on/off, Calendar: on/off). NOT per-event-type granularity for V2 — defer that to V3 if the demand emerges.
- **Rejected alternatives:**
  - Sync inline (block dispo-actions until vendor responds) — user-visible failures, defeats "Slack outage shouldn't break my CRM" goal.
  - Vercel Queues / job-queue table — overkill at 5-10 users; can graduate later if dispatch volume justifies it.

### Vendor Abstraction

- **D-16: Slack adapter via `@slack/web-api` directly, NOT Slack Bolt.** Bolt's built-in receiver expects Express-style req/res and is awkward in Next.js App Router. Use the Web API SDK in route handlers; verify HMAC signatures manually (existing pattern with Twilio/Dialpad).
- **D-17: Google Calendar via `googleapis` npm SDK.** Standard approach. Auto-handles access-token refresh given a stored refresh_token.

### Claude's Discretion

- **Schema details for `user_oauth_tokens`** — index strategy (probably `(user_id, provider, token_type)` PK is sufficient; add secondary index only if "which users have a valid Google token" becomes a hot query path).
- **`/settings/integrations` UI shape** — match the existing `/settings/ai-responder` page styling; one card per provider with connect/disconnect button + on/off toggle.
- **Slack message Block Kit formatting** — title + context block + "Mark Done" button. Exact blocks are an implementation detail; researcher will land on the spec.
- **Google Event description body** — title format like "Follow up: {address}", description includes a deep-link back to `/messages?property_id=…`, location is the property address.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### V1 Substrate (the foundation this phase extends)
- `supabase/migrations/051_tasks_table.sql` — tasks table schema; widens `notifications.entity_type` to include `'task'`
- `src/lib/tasks/index.ts` — `createTask`, `completeTask`, `snoozeTask`, `reassignTask` lib helpers
- `src/lib/notifications/dispatch.ts` — `dispatchTaskAssigned` (already exists for in-app bell); the new Slack/Calendar dispatchers slot in alongside this with the same shape
- `src/lib/notifications/types.ts` — `task_assigned` event type already in the EventType union
- `src/app/(dashboard)/messages/dispo-actions.ts` — call site that triggers `dispatchTaskAssigned`; the new Slack/Calendar paths fire from here too

### Vendor Abstraction Pattern (must follow)
- `src/lib/messaging/registry.ts` — provider registry pattern (Twilio + mock); new Slack adapter follows this shape
- `src/lib/messaging/providers/dialpad.ts` — webhook signature verification pattern; Slack interactivity webhook needs analogous HMAC verification
- `src/lib/skip-trace/providers/tracerfy.ts` — vendor adapter with Bearer auth + retry; calendar/slack adapters follow same conventions

### Notification Dispatch (the existing pattern)
- `src/lib/notifications/dispatch.ts:dispatchOwnerMessageAdded` — best-effort, never throws across the boundary, returns `{ inserted }` count
- `src/lib/notifications/dispatch.ts:dispatchPropertyAssigned` — suppresses self-assign at recipient resolution

### Settings Page Pattern
- `src/app/(dashboard)/settings/ai-responder/page.tsx` — closest analog to `/settings/integrations`. Server component, reads current config, passes to a client form.
- `src/app/(dashboard)/settings/ai-responder/actions.ts` — server-action pattern for settings updates (uses `supabase.auth.getUser()`)

### Migration Pipeline (mandatory)
- `.github/workflows/db-migrate.yml` — all migrations flow through CI; never `apply_migration` against prod via MCP

### Auth + RLS Reference
- `src/lib/supabase/admin.ts` — admin client for service-role operations
- `src/lib/supabase/server.ts` — server client used in server actions; RLS-aware

### Existing User Helpers
- `src/app/(dashboard)/leads/actions.ts:listOrgUsers` — already used by AssigneeSelect; the integrations page can use `supabase.auth.getUser()` for the current user

### Documentation (canonical OAuth references)
- Slack token types — https://docs.slack.dev/authentication/tokens/
- Slack auth best practices — https://api.slack.com/authentication/best-practices
- Google OAuth 2.0 (Web Server) — https://developers.google.com/identity/protocols/oauth2/web-server
- googleapis Node SDK (tokens event) — https://github.com/googleapis/google-api-nodejs-client
- Auth.js v5 refresh token rotation — https://authjs.dev/guides/refresh-token-rotation

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`dispatchTaskAssigned`** (already exists, in-app bell only) — refactor target: keep the in-app notification dispatch, add Slack and Calendar dispatch alongside. Same call signature.
- **Notification format helpers** — `humanDueDate` from `src/lib/notifications/format.ts` is already exported and used by both notifications and the dashboard panel; reuse for Slack message body and Calendar event title.
- **`reportError`** (`src/lib/errors/report.ts`) — used everywhere for best-effort dispatch failures; new dispatchers follow.
- **`pgcrypto` extension** — already enabled in Sandra's Postgres; `pgp_sym_encrypt` / `pgp_sym_decrypt` are available without a new migration step.

### Established Patterns
- **Vendor adapter via factory** — every external service goes through a registry-style getter; mock + real implementations behind the same interface.
- **Webhook signature verification** — raw body + provider HMAC check; 401 on mismatch (Dialpad pattern).
- **Best-effort dispatch** — try/catch around external calls, `reportError` on failure, never throw.
- **Server actions + revalidatePath** — every settings update is a `"use server"` action that calls `revalidatePath` on success.

### Integration Points
- **Dispatch site:** `dispo-actions.ts:setOutreachDispo` — when the dispo write succeeds and a task is created, the new code calls `await Promise.all([dispatchSlackDM(...), dispatchCalendarEvent(...)])` inside an `after()` block.
- **OAuth callback routes:** new `/api/oauth/slack/callback` and `/api/oauth/google/callback` route handlers — exchange auth code for tokens, encrypt + persist via the new helper.
- **Settings page:** new `/settings/integrations` route — connect/disconnect buttons + per-channel toggles. Reads connection status from `user_oauth_tokens` (presence = connected) plus a per-channel preference column on a new `user_integration_prefs` table or extension of an existing `user_settings` table (researcher's call).

</code_context>

<specifics>
## Specific Ideas

- **Slack message format** — Block Kit with header (task title, truncated to 60 chars), context block (property address, due date in user's timezone), action button "Mark Done" that updates the task status via Slack interactivity webhook. Same `humanDueDate` formatting as the in-app notification.
- **Calendar event format** — Title: "Follow up: {address}" (or "Callback: {address}" for callback dispo). Description: deep-link to `/messages?property_id=...` + property city/state. Location: full property address. Duration: 30 min default.
- **OAuth landmines surfaced by research** — must respect:
  1. Google `expires_in` is **seconds** — store as `now() + interval '1 second' * expires_in` not raw int
  2. Refresh-token rotation — `tokens` event fires with a `refresh_token` only when a new one is issued; UPDATE defensively
  3. Scope expansion — if a future feature adds Calendar write scope, existing users have read-only tokens; detect missing scope and re-prompt
  4. Slack token revocation — handle 401s by clearing the row and prompting re-install
  5. Never log decrypted tokens — wrap the decrypt helper in a non-loggable type

</specifics>

<deferred>
## Deferred Ideas

- **Slack inbound (`/follow-up` slash command, message shortcuts, modals)** — V3+. Outbound DM with action button is enough for V2 to deliver value.
- **Two-way Calendar sync** — V3+. Manual edits in Google Calendar don't propagate back to Sandra. Documented tradeoff.
- **Per-event-type notification preferences** — V3+. V2 ships all-or-nothing per channel; if VAs want fine-grained control later, schema can extend.
- **Recurring tasks** — V3+. The Tasks substrate doesn't support RRULE yet; integration timing follows once that lands.
- **Auto-create tasks from sequence completion / stale-conversation rules** — V3+. Requires the V1 substrate to bridge into the sequences/needs-attention surfaces.
- **Subsuming `needs_human_attention` into tasks** — V3+. Phase-2 cleanup of the escalation flow; too many touchpoints to migrate now.
- **External KMS / SOC2 compliance** — defer. If Sandra ever needs SOC2/HIPAA, revisit token storage to use AWS/GCP KMS envelope encryption.

</deferred>

---

*Phase: 04-Tasks Integrations (V2 — Slack + Google Calendar)*
*Context gathered: 2026-05-06*
