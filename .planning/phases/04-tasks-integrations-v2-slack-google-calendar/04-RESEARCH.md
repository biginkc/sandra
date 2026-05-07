# Phase 04: Tasks Integrations (V2 — Slack + Google Calendar) - Research

**Researched:** 2026-05-06
**Domain:** OAuth 2.0 (per-user, two providers), Slack Web API + interactivity webhook, Google Calendar API, pgcrypto column encryption, fire-and-forget dispatch via Next 16 `after()`
**Confidence:** HIGH (all critical claims verified via Slack/Google official docs, Next.js docs in `node_modules`, Vercel official docs, npm registry)

## Summary

Phase 04 wires the existing `task_assigned` event into two outbound delivery channels — Slack DM and Google Calendar — both gated behind per-user OAuth and a pair of on/off toggles in `/settings/integrations`. The substrate (tasks table, dispatcher contract, fire-and-forget dispatch convention) already exists from V1 (PR #112). What's net-new is exclusively three things: (1) the OAuth handshake routes + encrypted token storage, (2) two new dispatchers (Slack DM with action button, Calendar event create/update), and (3) one settings surface plus one Slack interactivity webhook for the "Mark Done" button.

CONTEXT.md has already locked the major architectural decisions (D-01 through D-17). This research fills in the implementation-level details: exact Slack/Google API shapes, exact pgcrypto SQL, the precise `after()` semantics on Vercel Pro Fluid Compute, the canonical block_actions payload structure, and the signature-verification sequence for Slack. Several CONTEXT entries had `[ASSUMED]` framing — research either confirms them with an authoritative citation, or flags the few remaining assumptions in the **Assumptions Log** below.

**Primary recommendation:** Build it as four small surfaces in this order — (1) DB migration `053_user_oauth_tokens.sql` with composite PK + SECURITY DEFINER decrypt, (2) Slack OAuth route pair + bot adapter, (3) Calendar OAuth route pair + adapter, (4) `/settings/integrations` page wiring connect/disconnect + per-channel toggles. The dispatch wiring is a four-line change to `dispo-actions.ts` (wrap existing `dispatchTaskAssigned` plus two new dispatchers in a single `after()` block).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Slack OAuth + Token Storage**
- D-01: Per-user OAuth scope. Each user connects their own Slack identity. No workspace-level admin install.
- D-02: Slack needs BOTH bot AND user tokens. Schema must accommodate both via `token_type CHECK (token_type IN ('user','bot'))` with composite PK `(user_id, provider, token_type)`.
- D-03: Default to bot token for outbound DMs. Only request user scopes when the bot can't accomplish the task.

**Google Calendar OAuth + Behavior**
- D-04: Per-user OAuth. Refresh token stored encrypted in `user_oauth_tokens` (provider='google').
- D-05: Calendar Events, NOT Google Tasks. Visible 30-min blocks with `location` (property address).
- D-06: 30-minute event at `due_at` on the user's primary calendar in the user's stored timezone (introduces per-user timezone column this phase).
- D-07: One-way sync. Task create → write event. `due_at` change → update event. Task complete → do nothing (accept stale events). Documented tradeoff.
- D-08: `googleapis` SDK manages access-token rotation via `oauth2Client.on('tokens', ...)`. `access_type: 'offline'` + `prompt: 'consent'` to get refresh_token.

**OAuth Token Storage**
- D-09: Encrypted column in `user_oauth_tokens` table. pgcrypto `pgp_sym_encrypt`, key in `OAUTH_TOKEN_ENCRYPTION_KEY` Vercel env var.
- D-10: SECURITY DEFINER decrypt function `get_oauth_token(user_id, provider, token_type)`. Never callable from browser.
- D-11: RLS on `user_oauth_tokens`. Each user reads own row (encrypted). Decrypt is service-role only via SECURITY DEFINER.
- D-12: Key rotation: dual-key cutover (`OLD_KEY` + `NEW_KEY` in env, re-encrypt every row, drop `OLD_KEY`).

**Dispatch Pattern**
- D-13: Fire-and-forget background dispatch via Next 16 `after()`. ~150ms response. Slack outage doesn't block dispo write.
- D-14: Same convention as existing `dispatchOwnerMessageAdded` / `dispatchPropertyAssigned` / `dispatchSkipTraceRequested`.
- D-15: Per-channel on/off toggle in `/settings/integrations`. All-or-nothing per channel for V2.

**Vendor Abstraction**
- D-16: Slack adapter via `@slack/web-api` directly, NOT Slack Bolt.
- D-17: Google Calendar via `googleapis` npm SDK.

### Claude's Discretion

- Schema details for `user_oauth_tokens` — index strategy beyond composite PK
- `/settings/integrations` UI shape — match `/settings/ai-responder` styling; one card per provider with connect/disconnect + on/off toggle
- Slack message Block Kit formatting — exact blocks (header, context, action button)
- Google Event description body — title format, deep-link inclusion, etc.

### Deferred Ideas (OUT OF SCOPE)

- Slack inbound (slash commands, modals, message shortcuts) — V3+
- Two-way Calendar sync — V3+
- Per-event-type notification preferences — V3+ (V2 ships all-or-nothing per channel)
- Recurring tasks (RRULE) — V3+
- Auto-create tasks from sequence completion / stale-conversation rules — V3+
- Subsuming `needs_human_attention` into tasks — V3+
- External KMS / SOC2 compliance — deferred
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SLACK-01 | When a task is assigned to a user other than the actor, that user receives a Slack DM with task title, property address, due date, and a one-click "Mark Done" button. Clicking updates the task in the CRM and the Slack message reflects the new state. | (a) Slack OAuth v2 access exchange + bot token storage [VERIFIED: Slack docs]. (b) `chat.postMessage` with Block Kit (section + actions block + button with action_id/value) [VERIFIED: Slack docs]. (c) Slack interactivity webhook with HMAC-SHA256 signature verification + 5-min replay window [VERIFIED: Slack docs]. (d) `chat.update` with bot token + same channel/ts to reflect new state [VERIFIED: Slack docs]. |
| CAL-01 | When a task is created or its due_at changes, a corresponding 30-minute event lands on the assignee's Google Calendar. Task completion does not delete the event. | (a) Google OAuth 2.0 web-server flow with `access_type: 'offline'` + `prompt: 'consent'` [VERIFIED: Google docs]. (b) `calendar.events.insert` with `calendarId: 'primary'` + dateTime/timeZone fields [VERIFIED: Google Calendar API ref]. (c) `oauth2Client.on('tokens', ...)` for refresh-token rotation [VERIFIED: googleapis Node SDK docs]. (d) `calendar.events.update` keyed by stored eventId for due_at edits. |
| INTEG-01 | Each user can connect/disconnect Slack and Google Calendar in `/settings/integrations` and toggle each delivery channel on/off independently. OAuth refresh tokens are stored encrypted; never logged. | (a) `user_oauth_tokens` table with `pgp_sym_encrypt` columns + RLS + SECURITY DEFINER decrypt [VERIFIED: Postgres pgcrypto docs]. (b) `user_integration_prefs` (or extension) table with per-(user, provider) `enabled bool`. (c) Connect button → server action returns provider auth URL with state CSRF token → redirect → callback exchanges code → encrypts tokens → upsert row. (d) Reuse `/settings/ai-responder` Page + PageHeader + form pattern. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| OAuth start (build auth URL with state) | API / Backend (server action or route handler) | — | Holds client_id/client_secret; must NOT touch the browser. |
| OAuth callback (code → tokens, encrypt, persist) | API / Backend (route handler `/api/oauth/{provider}/callback`) | Database / Storage (write encrypted row) | Must run with service-role write access; redirect URI must be a backend route per Google/Slack security model. |
| Token storage at rest | Database / Storage | — | pgcrypto column-level encryption; SECURITY DEFINER decrypt. |
| Token decrypt for outbound dispatch | API / Backend (server-only helper) | Database / Storage | Decryption SQL function is `EXECUTE` granted to service_role only. |
| Outbound Slack DM dispatch | API / Backend (in `after()` from server action) | — | Bot token from DB → `@slack/web-api` `chat.postMessage`. |
| Outbound Calendar event dispatch | API / Backend (in `after()` from server action) | — | Refresh token from DB → `googleapis` `calendar.events.insert`. |
| Slack interactivity webhook (Mark Done) | API / Backend (`/api/slack/actions` route handler — or `/api/webhooks/slack/actions` to inherit middleware allowlist) | Database (task update) + API (chat.update) | Must HMAC-verify, ack within 3 seconds, do real work in `after()`. |
| Settings UI (connect/disconnect, toggles) | Frontend Server (RSC) | API / Backend (server actions) | Reads connection status from `user_oauth_tokens` presence + `user_integration_prefs.enabled`. |

**Why this matters:** Two pitfalls are easy to fall into here. (1) Putting the OAuth start step in a client-component button handler — that leaks `client_secret` if the code-exchange isn't moved server-side. (2) Putting the Slack interactivity webhook outside the `/api/webhooks/*` path — Sandra's middleware redirects un-authed traffic to `/login` for everything else, so the route would 302 instead of receiving Slack's POST. **Decision: place the interactivity route at `/api/webhooks/slack/actions`** to inherit the existing public-path allowlist from `src/lib/supabase/middleware.ts`. The existing OAuth callbacks similarly belong under `/api/webhooks/oauth/{provider}/callback` OR the middleware needs to be widened to also allowlist `/api/oauth/`. CONTEXT.md uses `/api/oauth/{provider}/callback`; recommend adding that prefix to the middleware `isPublic` check (one-line change) rather than relocating, because the OAuth callbacks are conceptually about user identity, not provider webhooks.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@slack/web-api` | `7.15.2` (latest, published 2026-05-04) | Slack OAuth v2 token exchange + `chat.postMessage` / `chat.update` / `conversations.open` | Official Slack SDK. Avoids hand-rolled fetches. Bolt explicitly rejected (D-16). [VERIFIED: npm view] |
| `googleapis` | `171.4.0` (latest) | Google Calendar API (`calendar.events.insert/update`) + OAuth2Client for token management | Official Google Node SDK. Manages refresh-token rotation natively via `tokens` event. [VERIFIED: npm view + Google docs] |
| `next` | `16.2.4` (already installed) | `after()` for fire-and-forget dispatch | Already in stack. `after()` stable since Next.js 15.1. [VERIFIED: node_modules/next/dist/docs] |
| `@supabase/supabase-js` + `@supabase/ssr` | already installed | DB client + session-aware server client | Already in stack |
| `pgcrypto` | already enabled (migration 001) | `pgp_sym_encrypt` / `pgp_sym_decrypt` for token columns | Already in stack — no new extension migration. [VERIFIED: codebase grep] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` (built-in) | — | HMAC-SHA256 signature verification on Slack webhooks; CSRF state token generation | Required for Slack interactivity. Already used in `dialpadFromEnv()` adapter. [VERIFIED: codebase] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff | Decision |
|------------|-----------|----------|----------|
| `@slack/web-api` directly | `@slack/bolt` | Bolt has built-in receivers but expects Express-style req/res; awkward in App Router | REJECTED in CONTEXT.md (D-16) |
| `@slack/web-api` directly | `@slack/oauth` (3.0.5) | Helper specifically for OAuth installer flow with state stores | NOT NEEDED — `WebClient.oauth.v2.access(...)` handles the exchange in 4 lines; the persisted store is our `user_oauth_tokens` table, not a state-store abstraction. [VERIFIED: Slack docs] |
| `googleapis` (full SDK, ~50MB tree-shaken) | `google-auth-library` (10.6.2) + raw fetch to Calendar REST API | Lighter bundle but reimplements event-shape types and refresh handling | KEEP `googleapis` — D-17 locked. Bundle hit is ~tree-shakeable to just `google.calendar('v3')`. |
| Inline `after()` from server action | `Promise.resolve().then(() => ...)` plus `void` | Works without Next 16 but loses guarantee that work runs after response is sent | KEEP `after()` — Vercel `waitUntil` integration ensures function instance survives. [VERIFIED: Vercel + Next.js docs] |
| Column-level pgcrypto | Supabase Vault | Vault designed for workspace-level secrets, not N×M per-user-per-provider rows | REJECTED in CONTEXT.md (alongside D-09) |

**Installation:**
```bash
npm install @slack/web-api@^7.15.2 googleapis@^171.4.0
```

**Version verification:**
```bash
npm view @slack/web-api version  # → 7.15.2 (published 2026-05-04)
npm view googleapis version      # → 171.4.0
```
[VERIFIED: 2026-05-06 npm registry]

## Architecture Patterns

### System Architecture Diagram

```
                    ┌──────────────────────────┐
                    │   /settings/integrations │ (RSC)
                    │   shows connection state │
                    └─────────────┬────────────┘
                                  │ click "Connect Slack"
                                  ▼
                    ┌──────────────────────────┐
                    │  server action           │
                    │  startSlackOAuth():      │  generates state
                    │  returns auth URL        │  signed with secret
                    └─────────────┬────────────┘
                                  │ window.location = url
                                  ▼
                    ┌──────────────────────────┐
                    │   slack.com/oauth/v2/    │
                    │   authorize  (consent)   │
                    └─────────────┬────────────┘
                                  │ redirect with ?code=&state=
                                  ▼
        ┌─────────────────────────────────────────────────┐
        │  /api/oauth/slack/callback  (route handler)     │
        │  1. verify state                                │
        │  2. WebClient.oauth.v2.access(code)             │
        │  3. encrypt access_token + refresh_token        │
        │  4. UPSERT user_oauth_tokens                    │
        │  5. redirect to /settings/integrations?ok=1     │
        └─────────────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────

  ┌─────────────────────┐         ┌─────────────────────────────┐
  │ /messages dispo     │ task    │  setOutreachDispo (server   │
  │ "callback_requested │ created │  action)                    │
  │  + assignee=VA1"    │ ──────▶ │                              │
  └─────────────────────┘         │  await createTask(...)       │
                                  │  return { ok: true }   ◀────┐│
                                  │  after(() => Promise.all([  ││ user gets
                                  │    dispatchTaskAssigned,    ││ ~150ms ack
                                  │    dispatchSlackDM,         ││
                                  │    dispatchCalendarEvent,   ││
                                  │  ]))                        ││
                                  └─────────────────────────────┘│
                                          │            │          │
                                          ▼            ▼          ▼
                              ┌──────────────┐ ┌──────────────┐
                              │ Slack DM     │ │ Calendar     │
                              │ (chat.post)  │ │ event.insert │
                              │ ┌──────────┐ │ │              │
                              │ │ Mark Done│ │ └──────────────┘
                              │ └─────┬────┘ │
                              └───────┼──────┘
                                      │ user clicks
                                      ▼
        ┌─────────────────────────────────────────────────┐
        │  POST /api/webhooks/slack/actions               │
        │  1. verify HMAC + 5min timestamp                │
        │  2. parse payload (action_id="mark_done")       │
        │  3. respond 200 within 3s                       │
        │  4. after(() => completeTask + chat.update)     │
        └─────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
src/
├── lib/
│   ├── integrations/                       # NEW
│   │   ├── slack/
│   │   │   ├── adapter.ts                  # SlackIntegrationAdapter class
│   │   │   ├── adapter.test.ts             # mocks @slack/web-api
│   │   │   ├── oauth.ts                    # buildAuthUrl, exchangeCode
│   │   │   ├── signature.ts                # verifySlackSignature
│   │   │   ├── signature.test.ts           # known-good HMAC fixtures
│   │   │   ├── blocks.ts                   # buildTaskAssignedBlocks(...)
│   │   │   └── dispatch.ts                 # dispatchTaskAssignedSlack(...)
│   │   ├── google/
│   │   │   ├── adapter.ts                  # GoogleCalendarAdapter class
│   │   │   ├── adapter.test.ts             # mocks googleapis
│   │   │   ├── oauth.ts                    # buildAuthUrl, exchangeCode
│   │   │   └── dispatch.ts                 # dispatchTaskCalendarEvent(...)
│   │   ├── tokens/
│   │   │   ├── store.ts                    # upsertOAuthToken / getDecryptedToken
│   │   │   ├── store.test.ts
│   │   │   └── store.integration.test.ts   # against Supabase test project
│   │   └── prefs.ts                        # loadIntegrationPrefs / setEnabled
│   └── notifications/
│       └── dispatch.ts                     # ADD dispatchTaskAssignedSlack/Calendar invoked from setOutreachDispo
├── app/
│   ├── api/
│   │   ├── oauth/
│   │   │   ├── slack/
│   │   │   │   ├── start/route.ts          # GET → 302 to slack.com/oauth/v2/authorize
│   │   │   │   └── callback/route.ts       # GET ?code= → exchange + persist
│   │   │   └── google/
│   │   │       ├── start/route.ts
│   │   │       └── callback/route.ts
│   │   └── webhooks/
│   │       └── slack/
│   │           └── actions/route.ts        # POST block_actions interactivity
│   └── (dashboard)/
│       └── settings/
│           └── integrations/
│               ├── page.tsx                # RSC — reads connections + prefs
│               ├── form.tsx                # client component — toggles + buttons
│               └── actions.ts              # server actions: setEnabled, disconnect
└── ...
supabase/migrations/
├── 053_user_oauth_tokens.sql               # table + RLS + decrypt fn
└── 054_user_integration_prefs.sql          # per-channel enabled toggle + per-user timezone
```

### Pattern 1: SECURITY DEFINER decrypt function

**What:** Decryption is gated through a Postgres function with elevated privileges; the encryption key is passed as a function argument from the Node service-role client.

**When to use:** Always. Direct `pgp_sym_decrypt` calls from app code would put plaintext keys into query strings (and PostgREST query traces); the function pattern keeps the key in the function body's scope.

**Example:**
```sql
-- Source: PostgreSQL pgcrypto docs + Sandra's existing SECURITY DEFINER pattern
-- (migration 049_metric_snapshots_table.sql)

create or replace function public.get_oauth_token(
  p_user_id    uuid,
  p_provider   text,
  p_token_type text,
  p_key        text          -- passed by Node service-role caller from env var
)
returns table(
  access_token             text,
  refresh_token            text,
  access_token_expires_at  timestamptz,
  scopes                   text[],
  external_account_id      text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    pgp_sym_decrypt(access_token_encrypted,  p_key) as access_token,
    pgp_sym_decrypt(refresh_token_encrypted, p_key) as refresh_token,
    access_token_expires_at,
    scopes,
    external_account_id
  from public.user_oauth_tokens
  where user_id    = p_user_id
    and provider   = p_provider
    and token_type = p_token_type;
$$;

revoke execute on function public.get_oauth_token(uuid, text, text, text) from public;
revoke execute on function public.get_oauth_token(uuid, text, text, text) from authenticated;
grant  execute on function public.get_oauth_token(uuid, text, text, text) to service_role;
```

The Node helper:
```typescript
// src/lib/integrations/tokens/store.ts
import { createAdminClient } from "@/lib/supabase/admin";
import { ConfigurationError } from "@/lib/errors/classes";

/**
 * Wraps the decrypted token in a non-enumerable property so JSON.stringify
 * can't accidentally surface it in logs or Sentry breadcrumbs.
 */
export class OAuthSecret {
  private readonly _value: string;
  constructor(value: string) {
    Object.defineProperty(this, "_value", { value, enumerable: false });
  }
  reveal(): string { return this._value; }
  toJSON() { return "[REDACTED]"; }
  toString() { return "[REDACTED]"; }
}

export async function getDecryptedToken(params: {
  userId: string;
  provider: "slack" | "google";
  tokenType: "bot" | "user";
}): Promise<{
  accessToken: OAuthSecret;
  refreshToken: OAuthSecret | null;
  expiresAt: string | null;
  scopes: string[];
  externalAccountId: string | null;
} | null> {
  const key = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new ConfigurationError("OAUTH_TOKEN_ENCRYPTION_KEY missing");

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_oauth_token", {
    p_user_id: params.userId,
    p_provider: params.provider,
    p_token_type: params.tokenType,
    p_key: key,
  });
  if (error || !data || data.length === 0) return null;
  const row = data[0];
  return {
    accessToken:  new OAuthSecret(row.access_token),
    refreshToken: row.refresh_token ? new OAuthSecret(row.refresh_token) : null,
    expiresAt:    row.access_token_expires_at,
    scopes:       row.scopes ?? [],
    externalAccountId: row.external_account_id,
  };
}
```

### Pattern 2: Slack OAuth v2 code exchange

**What:** Redirect user to Slack's consent page; on return, exchange `code` for both bot and user tokens (Slack returns both in one response when both scopes were requested).

**When to use:** Once per user, on initial connect; also re-prompted if user revokes or scopes expand.

**Example:**
```typescript
// src/lib/integrations/slack/oauth.ts
// Source: https://docs.slack.dev/reference/methods/oauth.v2.exchange
import { WebClient } from "@slack/web-api";
import { randomBytes } from "node:crypto";

const SLACK_AUTHORIZE = "https://slack.com/oauth/v2/authorize";

// Bot scopes — fulfill DM with action button
export const SLACK_BOT_SCOPES = [
  "chat:write",          // chat.postMessage / chat.update — bot or user, both supported
  "im:write",            // conversations.open with single user → DM channel id
  "users:read",          // users.lookupByEmail to map Sandra user -> Slack user
  "users:read.email",    // required by users.lookupByEmail
] as const;
// User scopes — V2 doesn't actually need any. Schema supports them; request none today.
export const SLACK_USER_SCOPES: readonly string[] = [];

export function buildSlackAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  signedState: string;
}): string {
  const params = new URLSearchParams({
    client_id:     opts.clientId,
    scope:         SLACK_BOT_SCOPES.join(","),
    user_scope:    SLACK_USER_SCOPES.join(","),
    redirect_uri:  opts.redirectUri,
    state:         opts.signedState,
  });
  return `${SLACK_AUTHORIZE}?${params.toString()}`;
}

export async function exchangeSlackCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}) {
  // The WebClient is unauthenticated here — oauth.v2.access doesn't need a token
  const client = new WebClient();
  const r = await client.oauth.v2.access({
    client_id:     opts.clientId,
    client_secret: opts.clientSecret,
    code:          opts.code,
    redirect_uri:  opts.redirectUri,
  });
  if (!r.ok) throw new Error(`oauth.v2.access failed: ${r.error}`);
  return {
    botToken:        r.access_token!,        // xoxb-...
    botUserId:       r.bot_user_id!,
    appId:           r.app_id!,
    teamId:          r.team!.id!,
    teamName:        r.team!.name,
    scopes:          (r.scope ?? "").split(",").filter(Boolean),
    userToken:       r.authed_user?.access_token ?? null,  // xoxp-... if user scopes requested
    userId:          r.authed_user?.id ?? null,
    userScopes:      (r.authed_user?.scope ?? "").split(",").filter(Boolean),
  };
}
```

### Pattern 3: Slack signature verification

**What:** HMAC-SHA256 over `v0:{timestamp}:{rawBody}`; reject if timestamp >5 minutes old.

**Example:**
```typescript
// src/lib/integrations/slack/signature.ts
// Source: https://docs.slack.dev/authentication/verifying-requests-from-slack
import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MINUTES_S = 60 * 5;

export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp:     string | null;
  signature:     string | null;
  rawBody:       string;
  now?:          number;  // default Date.now()/1000 — injectable for tests
}): boolean {
  if (!opts.timestamp || !opts.signature) return false;
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > FIVE_MINUTES_S) return false;       // replay window

  const base = `v0:${opts.timestamp}:${opts.rawBody}`;
  const expected = `v0=${createHmac("sha256", opts.signingSecret).update(base).digest("hex")}`;

  if (expected.length !== opts.signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(opts.signature));
}
```

### Pattern 4: Google Calendar event with timezone

**What:** Insert a 30-minute event at `due_at` on the user's primary calendar with the property address as `location`. Store the returned `event.id` for later updates.

**When to use:** On task create. Update on `due_at` change. Never on completion (D-07).

**Example:**
```typescript
// src/lib/integrations/google/dispatch.ts
// Source: https://developers.google.com/calendar/api/v3/reference/events/insert
import { google } from "googleapis";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";
import { upsertOAuthToken } from "@/lib/integrations/tokens/store";

export async function dispatchTaskCalendarEvent(params: {
  userId: string;
  taskId: string;
  taskTitle: string;
  propertyAddress: string;
  dueAt: string;        // ISO timestamptz
  timeZone: string;     // e.g. "America/Chicago" — from user_integration_prefs
  deepLink: string;     // e.g. "https://sandra-sooty.vercel.app/messages?property_id=..."
}): Promise<{ eventId: string } | { skipped: "no_token" | "disabled" }> {
  const tokens = await getDecryptedToken({
    userId:    params.userId,
    provider:  "google",
    tokenType: "user",  // Google has no bot/user split — using "user" by convention
  });
  if (!tokens) return { skipped: "no_token" };

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI,
  );
  oauth2Client.setCredentials({
    access_token:  tokens.accessToken.reveal(),
    refresh_token: tokens.refreshToken?.reveal(),
    expiry_date:   tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : undefined,
  });

  // Persist any rotated tokens back to the DB. The 'tokens' event fires
  // when the SDK auto-refreshes. refresh_token is only present on the
  // first authorization OR when Google rotates it; UPSERT defensively.
  oauth2Client.on("tokens", async (newTokens) => {
    await upsertOAuthToken({
      userId:    params.userId,
      provider:  "google",
      tokenType: "user",
      accessToken:           newTokens.access_token ?? tokens.accessToken.reveal(),
      refreshToken:          newTokens.refresh_token ?? tokens.refreshToken?.reveal() ?? null,
      accessTokenExpiresAt:  newTokens.expiry_date ? new Date(newTokens.expiry_date).toISOString() : null,
      scopes:                tokens.scopes,
      externalAccountId:     tokens.externalAccountId,
    });
  });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const start = new Date(params.dueAt);
  const end   = new Date(start.getTime() + 30 * 60 * 1000);

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary:     `Follow up: ${params.propertyAddress}`,
      description: `${params.taskTitle}\n\n${params.deepLink}`,
      location:    params.propertyAddress,
      start: { dateTime: start.toISOString(), timeZone: params.timeZone },
      end:   { dateTime: end.toISOString(),   timeZone: params.timeZone },
      // No reminders override — inherits the user's default reminders.
    },
  });
  return { eventId: res.data.id! };
}
```

### Pattern 5: Slack DM Block Kit with action button

```typescript
// src/lib/integrations/slack/blocks.ts
// Source: https://docs.slack.dev/reference/block-kit/block-elements/button-element
export function buildTaskAssignedBlocks(p: {
  taskTitle: string;       // already-truncated to <= 60 chars by caller
  propertyAddress: string;
  dueLabel: string;        // "today" / "tomorrow" / "Fri May 9" — from humanDueDate()
  taskTypeLabel: string;   // "Follow-up" / "Callback" / "Task"
  taskId: string;
  deepLink: string;
}) {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Task assigned: ${p.taskTitle}`, emoji: true },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `*${p.taskTypeLabel}* · Due ${p.dueLabel} · <${p.deepLink}|Open in Sandra>` },
        { type: "mrkdwn", text: p.propertyAddress },
      ],
    },
    {
      type: "actions",
      block_id: "task_actions",
      elements: [
        {
          type: "button",
          action_id: "mark_done",
          text: { type: "plain_text", text: "Mark Done", emoji: true },
          style: "primary",
          value: p.taskId,
        },
      ],
    },
  ];
}
```

### Pattern 6: Slack interactivity webhook (Mark Done)

```typescript
// src/app/api/webhooks/slack/actions/route.ts
// Sources: docs.slack.dev/interactivity/handling-user-interaction
//          docs.slack.dev/reference/interaction-payloads/block_actions-payload
import { NextResponse } from "next/server";
import { after } from "next/server";

import { reportError } from "@/lib/errors/report";
import { verifySlackSignature } from "@/lib/integrations/slack/signature";
import { completeTaskFromSlack, refreshSlackMessage } from "@/lib/integrations/slack/dispatch";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    timestamp:     request.headers.get("x-slack-request-timestamp"),
    signature:     request.headers.get("x-slack-signature"),
    rawBody,
  });
  if (!ok) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });

  // Slack sends payload as application/x-www-form-urlencoded with a single
  // `payload` field whose value is JSON. Parse here, do NOT await async work.
  const params = new URLSearchParams(rawBody);
  const payload = JSON.parse(params.get("payload") ?? "{}");

  if (payload.type !== "block_actions") {
    return NextResponse.json({ ok: true });   // acknowledge unknown types; no-op
  }
  const action = payload.actions?.[0];
  if (action?.action_id === "mark_done") {
    after(async () => {
      try {
        await completeTaskFromSlack({
          taskId:      String(action.value),
          slackUserId: payload.user.id,
          teamId:      payload.team.id,
          channel:     payload.channel.id,
          messageTs:   payload.message?.ts ?? payload.container?.message_ts,
        });
        await refreshSlackMessage({   // chat.update — replace blocks with "✓ Marked done"
          teamId:    payload.team.id,
          channel:   payload.channel.id,
          messageTs: payload.message?.ts ?? payload.container?.message_ts,
          taskId:    String(action.value),
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: "slack_action_mark_done" },
          extra: { taskId: action.value, slackUserId: payload.user?.id },
        });
      }
    });
  }

  // Slack requires HTTP 200 within 3 seconds; the after() above runs after.
  return NextResponse.json({ ok: true });
}
```

### Pattern 7: Fire-and-forget dispatch with `after()`

```typescript
// src/app/(dashboard)/messages/dispo-actions.ts (modified — illustrative diff)
import { after } from "next/server";
// ... existing imports ...
import { dispatchTaskAssignedSlack } from "@/lib/integrations/slack/dispatch";
import { dispatchTaskCalendarEvent } from "@/lib/integrations/google/dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";

// inside setOutreachDispo, after task creation succeeds and recipients are known:
if (resolvedAssignee !== user.id) {
  // Read prefs ONCE before scheduling — cookies/headers are safe here, after()
  // runs outside the request lifecycle in App Router server actions.
  const prefs = await loadIntegrationPrefs(supabase, resolvedAssignee);

  after(async () => {
    await Promise.allSettled([
      dispatchTaskAssigned(supabase, { taskId, orgId, assigneeId, taskTitle, taskType, dueAt, propertyAddress }),
      prefs.slackEnabled    ? dispatchTaskAssignedSlack({ /* ... */ })   : Promise.resolve(),
      prefs.calendarEnabled ? dispatchTaskCalendarEvent({ /* ... */ })   : Promise.resolve(),
    ]);
  });
}
```

### Anti-Patterns to Avoid

- **Decoded tokens in `console.log`** — use `OAuthSecret` wrapper class (Pattern 1) so `JSON.stringify` returns `"[REDACTED]"`. Never write `console.log(tokens)` even in dev.
- **Awaiting Slack/Calendar inside the server action** — defeats CONTEXT.md D-13. Always use `after()`.
- **Storing the encryption key in the migration file** — keys live in Vercel env vars. Migration body references `p_key` parameter only.
- **Calling `pgp_sym_decrypt` from the app's anon-key client** — RLS policy makes the encrypted columns unreadable to authenticated; only `service_role` calls `get_oauth_token`.
- **Building auth URL in client component** — `client_id` is fine in browser, but the redirect URI + state generation must be a server action so HMAC-signing the state with a server-only secret is possible.
- **Putting Slack interactivity at `/api/slack/actions`** — middleware redirects un-authed traffic to `/login`. Place under `/api/webhooks/slack/actions` to inherit existing public-path allowlist.
- **Ignoring Slack 3-second response window** — even verification logic must finish in <3s. All real work belongs in `after()`.
- **Trying to use `prompt=consent` for re-auth without revoking first** — Google issues a refresh_token only on `consent`-prompted flows; `prompt=none` won't yield one. CONTEXT.md D-08 mandates the `consent` prompt; document this in the dev notes so a future "make connect smoother" PR doesn't drop it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack OAuth v2 token exchange | `fetch('https://slack.com/api/oauth.v2.access', ...)` | `WebClient.oauth.v2.access(...)` from `@slack/web-api` | Handles form-encoding, error-classification, response shape across enterprise vs single-team installs |
| Slack chat.postMessage with retries | `fetch(...)` with custom retry loop | `WebClient.chat.postMessage(...)` | Built-in p-retry on 5xx + rate-limit handling per Slack's `Retry-After` |
| Google access-token refresh | Custom interval to refresh before expiry | `oauth2Client.setCredentials` + auto-refresh on first failed call + `'tokens'` event | SDK refreshes lazily on first 401, fires `'tokens'` so we capture rotated refresh_tokens |
| Google Calendar event resource construction | Hand-crafted JSON | `calendar.events.insert({ requestBody })` typed | Type checking on `Schema$Event` prevents the "wrong field name" silent failure |
| HMAC signature comparison | `===` string compare | `node:crypto.timingSafeEqual` | Constant-time compare resists timing attacks; existing pattern in `src/lib/messaging/providers/dialpad.ts` |
| OAuth state CSRF token | Random number / UUID alone | HMAC-signed state: `userId.timestamp.hmac(userId.timestamp, secret)` | Lets the callback verify the state didn't come from another user's session — UUID-only state is forgeable if storage is compromised |
| pgcrypto column encryption from app code | `INSERT ... pgp_sym_encrypt('...', '${key}')` from JS | SECURITY DEFINER function with key as `p_key` arg | Keeps key out of PostgREST query traces and SQL audit logs |
| Block Kit JSON | Raw JSON literals scattered across files | Centralized `buildTaskAssignedBlocks()` + zod-validated output | Block Kit is finicky; one builder enforces shape and lets us add validation/snapshot tests |

**Key insight:** Both `@slack/web-api` and `googleapis` package N years of edge-case handling that look trivial when ignored and become migraine when re-discovered. Bolt was rejected (D-16) because it bundles a request handler that fights App Router; the bare Web API client is the right amount of abstraction.

## Common Pitfalls

### Pitfall 1: Slack `chat:write` ≠ Slack DM-able by default
**What goes wrong:** Bot posts `chat.postMessage(channel: <user_dm_channel>)` and gets `not_in_channel`.
**Why it happens:** `chat:write` allows posting in channels where the app is a member; for DMs you also need `im:write` to first call `conversations.open(users: <user_id>)` to get the DM channel ID.
**How to avoid:** Request both `chat:write` AND `im:write` bot scopes (CONTEXT.md SLACK_BOT_SCOPES list above already does this). Pattern: lookup user → `conversations.open` → `chat.postMessage`.
**Warning signs:** `not_in_channel` or `channel_not_found` from `chat.postMessage`. [VERIFIED: docs.slack.dev/reference/scopes/im.write]

### Pitfall 2: Slack user lookup requires `users:read.email`
**What goes wrong:** `users.lookupByEmail` returns `missing_scope`.
**Why it happens:** `users:read` lets you list users; `users:read.email` is a separate scope for matching by email. [VERIFIED: Slack docs]
**How to avoid:** Include both. Sandra users sign in with `@bmhgroupkc.com` emails (per `isEmailAllowed`), and that email is what matches the Slack workspace.
**Warning signs:** First successful DM attempt fails on user lookup with `missing_scope`. Fix is a re-install (scopes are decided at install time).

### Pitfall 3: Google `expires_in` is **seconds**, not milliseconds
**What goes wrong:** Storing `Date.now() + expires_in` produces an expiry 50 years in the future; SDK never refreshes.
**Why it happens:** OAuth 2.0 spec uses seconds for `expires_in`; JavaScript `Date` uses ms.
**How to avoid:** `expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString()`. The googleapis SDK gives you `expiry_date` already in ms — prefer that field. [VERIFIED: CONTEXT.md "OAuth landmines" section + Google docs]
**Warning signs:** Calendar dispatch silently uses a never-refreshed token until it gets revoked, then `invalid_grant`.

### Pitfall 4: Google refresh_token only returned on first authorization (or with `prompt=consent`)
**What goes wrong:** User connects once, you get refresh_token. They re-authorize (e.g., to grant a new scope) without `prompt: 'consent'`, and Google returns no refresh_token. You overwrite the row with `null`. Background refresh stops.
**Why it happens:** Google's incremental authorization optimization. [VERIFIED: Google OAuth docs + googleapis SDK docs]
**How to avoid:** Always `prompt: 'consent'` on `generateAuthUrl` (CONTEXT.md D-08). On UPSERT, use `COALESCE` so a null refresh_token from a re-auth doesn't clobber the existing one.
**Warning signs:** "User can connect, but next day's calendar dispatch fails with invalid_grant."

### Pitfall 5: Slack bot tokens don't expire (by default), but token rotation if enabled changes everything
**What goes wrong:** Code path assumes infinite-lifetime bot token; rotation gets enabled at the App config level later; tokens silently start expiring.
**Why it happens:** Token rotation is opt-in per Slack app. Once enabled, `oauth.v2.access` returns `expires_in` and `refresh_token`. [CITED: docs.slack.dev/authentication/best-practices-for-security]
**How to avoid:** Always store `expires_in` and `refresh_token` if returned, even today (schema supports both). On 401 from `chat.postMessage`, attempt refresh via `oauth.v2.access` with `grant_type=refresh_token` before clearing the row.
**Warning signs:** Slack DMs start failing days/weeks after install with `token_expired`.

### Pitfall 6: Slack interactivity payload is form-encoded, not JSON
**What goes wrong:** `await request.json()` returns `{}` or throws.
**Why it happens:** Slack POSTs `application/x-www-form-urlencoded` with a single `payload` form field whose value is JSON. [VERIFIED: docs.slack.dev/interactivity/handling-user-interaction]
**How to avoid:** `const params = new URLSearchParams(rawBody); JSON.parse(params.get('payload')!)`. Same pattern used for signature verification — both need the raw body.
**Warning signs:** Empty payload object → `payload.type` undefined → silent no-op.

### Pitfall 7: Slack signature verification needs raw body BEFORE any framework parsing
**What goes wrong:** Read body via `request.json()` then re-stringify for HMAC; signature mismatch.
**Why it happens:** JSON re-stringify normalizes whitespace and key order; HMAC is over exact bytes Slack sent.
**How to avoid:** Always `await request.text()` first, then both verify-signature AND parse-payload work off that string. (Same pattern as Dialpad — see `src/app/api/webhooks/dialpad/sms/route.ts:78`.)
**Warning signs:** 401s on every request even though signing secret is correct.

### Pitfall 8: `chat.update` requires the same channel + ts the bot originally posted to
**What goes wrong:** Webhook handler tries `chat.update(channel: payload.channel.id, ts: ?)` but ts is null because the payload nesting was wrong.
**Why it happens:** Block Kit container types differ — `message_attachment` vs `message` containers put `message_ts` in different places. [VERIFIED: docs.slack.dev/reference/interaction-payloads/block_actions-payload]
**How to avoid:** `payload.message?.ts ?? payload.container?.message_ts` — fall back through both shapes. Snapshot-test with a real Slack-sent payload fixture.
**Warning signs:** "Mark Done" succeeds in DB but Slack message never updates.

### Pitfall 9: Vercel `after()` lifetime is bounded by route `maxDuration`, not infinite
**What goes wrong:** Long-running calendar batch dispatch in `after()` exceeds 300s default; function instance terminated mid-call.
**Why it happens:** `after()` is implemented via `waitUntil`, which keeps the instance alive — but only up to the route's `maxDuration`. Pro plan with Fluid Compute defaults to 300s, configurable up to 800s. [VERIFIED: Next.js docs + Vercel limits docs]
**How to avoid:** For our two outbound calls (~1-2s each, no fan-out), default 300s is fine. If we ever batch-dispatch >50 events, set `export const maxDuration = 60` on the route.
**Warning signs:** "Some Slack DMs send, others don't" — always the later ones in a batch.

### Pitfall 10: `pgp_sym_decrypt(bytea, password)` blows up on bytea encrypted via `_bytea` variant
**What goes wrong:** Mixing `pgp_sym_encrypt_bytea` and `pgp_sym_decrypt`; Postgres rejects.
**Why it happens:** Postgres explicitly disallows decrypting bytea-encrypted data via the text-decryption function to avoid invalid character output. [VERIFIED: PostgreSQL pgcrypto docs]
**How to avoid:** Always pair: `pgp_sym_encrypt(text, key) → bytea` + `pgp_sym_decrypt(bytea, key) → text`. Never use the `_bytea` variants for OAuth tokens (they're text).
**Warning signs:** SQL error: "decrypting bytea data with pgp_sym_decrypt is disallowed".

### Pitfall 11: Postgres SECURITY DEFINER + variable search_path = SQL injection vector
**What goes wrong:** A SECURITY DEFINER function without `SET search_path` is exploitable if the caller's search_path includes a writeable schema.
**Why it happens:** Functions run with the OWNER's privileges; if the body resolves an unqualified name, the caller can inject a malicious shadowing function.
**How to avoid:** Always `SET search_path = public, pg_temp` on SECURITY DEFINER fns. Sandra already follows this pattern (see migration 049). [VERIFIED: codebase grep]
**Warning signs:** Code review of new SQL functions; lint rule could enforce.

### Pitfall 12: Encryption-key rotation while in-flight requests are decrypting
**What goes wrong:** Mid-rotation, some rows are encrypted with `OLD_KEY`, some with `NEW_KEY`. A decrypt with the wrong key returns null/raises.
**How to avoid:** Dual-key cutover (CONTEXT.md D-12) — rewrite `get_oauth_token` to try `NEW_KEY` then fall back to `OLD_KEY`. After the migration re-encrypts every row to NEW_KEY, drop OLD_KEY support. Document in the migration file.
**Warning signs:** Calendar/Slack dispatch errors immediately after a key-rotation deploy.

## Code Examples

(See Patterns 1-7 above — those are the canonical, copy-pasteable examples for this phase.)

### Common operation: upsert OAuth token with COALESCE for refresh_token

```typescript
// src/lib/integrations/tokens/store.ts (excerpt)
// Source: Sandra's existing pgcrypto + admin-client pattern
export async function upsertOAuthToken(input: {
  userId: string;
  provider: "slack" | "google";
  tokenType: "bot" | "user";
  accessToken: string;
  refreshToken: string | null;       // null on Slack bot tokens, sometimes null on Google re-auth
  accessTokenExpiresAt: string | null;
  scopes: string[];
  externalAccountId: string | null;
}): Promise<void> {
  const key = process.env.OAUTH_TOKEN_ENCRYPTION_KEY!;
  const admin = createAdminClient();
  // Use a SQL helper rather than column-level upsert because we need
  // pgp_sym_encrypt at write time AND COALESCE-on-conflict semantics
  // for refresh_token (Google re-auth might omit it).
  const { error } = await admin.rpc("upsert_oauth_token", {
    p_user_id:      input.userId,
    p_provider:     input.provider,
    p_token_type:   input.tokenType,
    p_access:       input.accessToken,
    p_refresh:      input.refreshToken,
    p_expires_at:   input.accessTokenExpiresAt,
    p_scopes:       input.scopes,
    p_account:      input.externalAccountId,
    p_key:          key,
  });
  if (error) throw new DatabaseError(`upsert_oauth_token failed: ${error.message}`);
}
```

The corresponding migration:

```sql
create or replace function public.upsert_oauth_token(
  p_user_id    uuid,
  p_provider   text,
  p_token_type text,
  p_access     text,
  p_refresh    text,
  p_expires_at timestamptz,
  p_scopes     text[],
  p_account    text,
  p_key        text
) returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.user_oauth_tokens(
    user_id, provider, token_type,
    access_token_encrypted, refresh_token_encrypted,
    access_token_expires_at, scopes, external_account_id
  ) values (
    p_user_id, p_provider, p_token_type,
    pgp_sym_encrypt(p_access, p_key),
    case when p_refresh is null then null else pgp_sym_encrypt(p_refresh, p_key) end,
    p_expires_at, p_scopes, p_account
  )
  on conflict (user_id, provider, token_type) do update set
    access_token_encrypted  = excluded.access_token_encrypted,
    -- Defensive: if Google re-auth omits refresh_token, KEEP the existing one.
    refresh_token_encrypted = coalesce(excluded.refresh_token_encrypted, user_oauth_tokens.refresh_token_encrypted),
    access_token_expires_at = excluded.access_token_expires_at,
    scopes                  = excluded.scopes,
    external_account_id     = excluded.external_account_id,
    updated_at              = now();
$$;

revoke execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) from public;
revoke execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) from authenticated;
grant  execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) to service_role;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `unstable_after` from `next/server` | `after` (stable) | Next 15.1 | Now safe for production. [VERIFIED: Next docs] |
| Slack RTM (websocket) for bot interactivity | Events API + Interactivity webhook over HTTPS | Slack-wide deprecation; RTM can no longer be used for new bot installs | We're already on the modern path — request URL pattern only. |
| Google ServiceAccount with domain-wide delegation | Per-user OAuth | Google tightened DWD admin consent flows; per-user is the supported path for personal Calendars | CONTEXT.md D-04 reflects this. |
| Storing OAuth tokens plain-in-Postgres | Column-level encryption (pgcrypto) OR Vault | OWASP ASVS V6 + general industry hardening | This phase introduces it; no other Sandra integration has tokens-at-rest. |

**Deprecated/outdated:**
- `im.open` (replaced by `conversations.open`) — Slack Conversations API unified channels/IMs/MPIMs in 2018. Don't use `im.*` methods in new code.
- `OAuth v1` (`oauth.access` without `.v2`) — V2 unified bot/user token responses; V1 returns only one or the other.
- Hand-rolling Block Kit JSON without a builder — Slack's UI Kit Builder + typed builders eliminate the "missing required field" class of bug.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The interactivity webhook should live under `/api/webhooks/slack/actions` to inherit middleware allowlist (vs. `/api/oauth/slack/...`) | Architectural Responsibility Map | Low — alternative is to add `/api/oauth` to the middleware `isPublic` allowlist (one-line change). Either path works; pick at plan time. |
| A2 | Google has no bot/user token split; we use `token_type='user'` by convention for Google rows | Pattern 4 | Low — purely an internal naming convention. Schema supports it. Could alternatively use `token_type='primary'` or NULL but the CHECK constraint per D-02 forbids NULL. Plan should pick one. |
| A3 | We require `users:read.email` to map Sandra users → Slack users by email | Pitfall 2 | Medium — alternative is to ask the user to paste their Slack user ID during onboarding (worse UX). The lookup-by-email approach is the standard. |
| A4 | Per-user timezone column lives on `user_integration_prefs` (not on a separate `user_profiles` table) | Project Structure | Low — placement is a schema-design choice; CONTEXT.md is silent. Recommend `user_integration_prefs` since timezone is only USED by integrations today. |
| A5 | The `OAUTH_TOKEN_ENCRYPTION_KEY` env var is a single string passed as `p_key` to the SECURITY DEFINER fn, NOT a Postgres-side `current_setting` | Pattern 1 | Low — both work; passing as arg is simpler and matches CONTEXT.md D-09 wording ("key in OAUTH_TOKEN_ENCRYPTION_KEY Vercel env var"). |
| A6 | "Mark Done" button updates the message via `chat.update` to show "✓ Marked done" (vs. ephemeral message or replace with status block) | Pattern 6 | Low — UI choice. Block Kit allows either; `chat.update` keeps the original DM visible as a record. Plan should confirm visual treatment. |
| A7 | We use HMAC-signed state for OAuth CSRF (vs. session-stored nonce) | Pattern 2 / Don't Hand-Roll | Low — HMAC is stateless and matches Sandra's existing webhook signing patterns; session-stored is also fine if a nonce table is acceptable. |

**These assumptions are flagged so the planner can confirm with the user during plan-phase, or land defensible defaults.**

## Open Questions

1. **Slack workspace install — does Jarrad need to be a workspace admin, or do per-user installs work for non-admin users in BMH's workspace?**
   - What we know: V2 uses per-user OAuth (D-01). Slack's standard OAuth requires only that the *app* is approved for install in the workspace — usually a one-time admin approval, then any user can install for themselves.
   - What's unclear: whether BMH's Slack workspace has "approved apps only" enabled, which would require Jarrad to whitelist Sandra at the org level once.
   - Recommendation: ask Jarrad during plan-phase. If yes, document as a one-time setup step.

2. **Should we look up the assignee's Slack user via email at install time, or lazily on first dispatch?**
   - What we know: lookup-by-email needs `users:read.email` (Pitfall 2). Caching the Slack user_id in `user_oauth_tokens.external_account_id` avoids per-dispatch lookups.
   - What's unclear: whether Slack user emails change (rename) — if yes, cache invalidation is needed.
   - Recommendation: cache at OAuth install time (the `authed_user.id` from `oauth.v2.access` IS the user's Slack ID — no email lookup needed at all when the user is the one installing).

3. **Calendar event ID: where do we store it?**
   - What we know: `events.update(eventId, ...)` needs the ID returned by `events.insert`.
   - What's unclear: column on `tasks` (`google_calendar_event_id text`) or a separate `task_external_refs` table?
   - Recommendation: add `google_calendar_event_id text` directly on `tasks` for V2. If V3 adds Slack message ts tracking too, generalize then.

4. **Does Sandra's user table have a timezone column today?**
   - What we know: CONTEXT.md D-06 says "this phase introduces per-user timezone."
   - Recommendation: add `timezone text not null default 'America/Chicago'` on `user_integration_prefs`. The /settings/integrations page surfaces a dropdown.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js >=22 | Whole stack | ✓ (per package.json engines) | 22+ | — |
| Next.js 16 (after API) | Fire-and-forget dispatch | ✓ | 16.2.4 | — |
| pgcrypto | Token encryption | ✓ (migration 001) | bundled w/ Postgres 17 | — |
| @slack/web-api | New install required | ✗ (NOT in package.json) | — | `npm install @slack/web-api@^7.15.2` |
| googleapis | New install required | ✗ (NOT in package.json) | — | `npm install googleapis@^171.4.0` |
| Slack app + signing secret | Slack dispatch | ✗ (does not exist yet) | — | Create in Slack admin during plan-phase setup task |
| Google Cloud OAuth client | Calendar dispatch | ✗ (does not exist yet) | — | Create in Google Cloud Console during plan-phase setup task |
| `OAUTH_TOKEN_ENCRYPTION_KEY` env | All token decrypt | ✗ | — | Generate `openssl rand -hex 32`; add to Vercel prod + test |
| Vercel Pro plan | `after()` past 300s | ✓ | Pro | — |

**Missing dependencies with no fallback:** None — the missing items are (a) two npm installs (uncontroversial) and (b) provider app provisioning (a one-time setup task in the plan).

**Missing dependencies with fallback:** None.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 (already installed) + @testing-library/react 16.3.2 |
| Config files | `vitest.config.ts`, `vitest.integration.config.ts`, `vitest.rtl.config.ts` (RTL/component tests) |
| Quick run command | `npm test` |
| Full suite command | `npm run verify` (typecheck + test + RTL) |
| Integration suite | `npm run test:integration` (real Supabase test project) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTEG-01 | `pgp_sym_encrypt`/`pgp_sym_decrypt` round-trip preserves token bytes | unit (mocked) + integration (real DB) | `npm test -- src/lib/integrations/tokens/store.test.ts` AND `npm run test:integration -- src/lib/integrations/tokens/store.integration.test.ts` | ❌ Wave 0 |
| INTEG-01 | RLS: user can SELECT their own row only; cannot read another user's encrypted columns | integration | `npm run test:integration -- src/lib/integrations/tokens/rls.integration.test.ts` | ❌ Wave 0 |
| INTEG-01 | `OAuthSecret.toJSON()` returns `"[REDACTED]"`; `JSON.stringify({ token })` doesn't leak | unit | `npm test -- src/lib/integrations/tokens/oauth-secret.test.ts` | ❌ Wave 0 |
| INTEG-01 | OAuth state CSRF: tampered state returns 401 from callback | unit (route handler with mocked request) | `npm test -- src/app/api/oauth/slack/callback/route.test.ts` | ❌ Wave 0 |
| INTEG-01 | Settings page renders connect/disconnect + toggles based on row presence | RTL | `npm run test:rtl -- src/app/(dashboard)/settings/integrations/form.test.tsx` | ❌ Wave 0 |
| SLACK-01 | `verifySlackSignature` accepts valid HMAC, rejects tampered body, rejects timestamps >5min old | unit | `npm test -- src/lib/integrations/slack/signature.test.ts` | ❌ Wave 0 |
| SLACK-01 | `buildTaskAssignedBlocks` produces a Block Kit shape that snapshot-matches a known-good fixture | unit | `npm test -- src/lib/integrations/slack/blocks.test.ts` | ❌ Wave 0 |
| SLACK-01 | `dispatchTaskAssignedSlack` calls `conversations.open` then `chat.postMessage` (mock @slack/web-api) | unit | `npm test -- src/lib/integrations/slack/dispatch.test.ts` | ❌ Wave 0 |
| SLACK-01 | Webhook route ack within 3s; HMAC-rejected requests return 401 | unit (route handler) | `npm test -- src/app/api/webhooks/slack/actions/route.test.ts` | ❌ Wave 0 |
| SLACK-01 | Webhook completeTaskFromSlack updates `tasks.status='completed'` (integration) | integration | `npm run test:integration -- src/app/api/webhooks/slack/actions/route.integration.test.ts` | ❌ Wave 0 |
| CAL-01 | `dispatchTaskCalendarEvent` calls `calendar.events.insert` with primary calendar + correct timezone (mock googleapis) | unit | `npm test -- src/lib/integrations/google/dispatch.test.ts` | ❌ Wave 0 |
| CAL-01 | `oauth2Client.on('tokens', ...)` UPSERTs rotated tokens (mock SDK) | unit | `npm test -- src/lib/integrations/google/dispatch.test.ts` | ❌ Wave 0 |
| CAL-01 | due_at update calls `events.update` with stored eventId; completion does NOT delete | unit | `npm test -- src/lib/integrations/google/dispatch.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm test` (≈30s for unit suite)
- **Per wave merge:** `npm run verify` (typecheck + unit + RTL ≈90s)
- **Phase gate:** `npm run verify` AND `npm run test:integration` green before `/gsd-verify-work`

### Wave 0 Gaps

All test files for this phase are net-new — Wave 0 must scaffold:

- [ ] `src/lib/integrations/tokens/store.test.ts` — covers INTEG-01 round-trip
- [ ] `src/lib/integrations/tokens/store.integration.test.ts` — covers INTEG-01 + RLS
- [ ] `src/lib/integrations/tokens/oauth-secret.test.ts` — covers redaction
- [ ] `src/lib/integrations/slack/signature.test.ts` — fixture-based HMAC tests
- [ ] `src/lib/integrations/slack/blocks.test.ts` — Block Kit snapshot
- [ ] `src/lib/integrations/slack/dispatch.test.ts` — mock @slack/web-api
- [ ] `src/lib/integrations/google/dispatch.test.ts` — mock googleapis
- [ ] `src/app/api/oauth/slack/callback/route.test.ts` + Google sibling
- [ ] `src/app/api/webhooks/slack/actions/route.test.ts`
- [ ] `src/app/api/webhooks/slack/actions/route.integration.test.ts`
- [ ] `src/app/(dashboard)/settings/integrations/form.test.tsx`

No new test framework needed — vitest + RTL already wired.

**E2E tests (Playwright) are intentionally out of scope** for V2 — would require a Slack test workspace and a Google test account, plus tunneling localhost for the interactivity webhook. Document as a manual smoke test at the end of the phase: (1) connect Slack, (2) connect Google, (3) trigger a callback dispo on a test property, (4) verify DM lands, (5) verify event appears, (6) click Mark Done, (7) verify task completes + message updates.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | OAuth 2.0 per-provider; state token CSRF; signing-secret HMAC for webhook authenticity |
| V3 Session Management | partial | Existing Supabase session for `/settings/integrations`; OAuth flows are stateless across redirect via signed `state` |
| V4 Access Control | yes | RLS on `user_oauth_tokens` (read-own-row); SECURITY DEFINER decrypt restricted to `service_role` |
| V5 Input Validation | yes | Slack interactivity payload — validate `payload.type === 'block_actions'` before processing; validate `action_id` against allowlist (`mark_done` only); validate `value` (taskId) is a UUID before DB lookup |
| V6 Cryptography | yes | pgcrypto `pgp_sym_encrypt` (PGP CFB, never roll our own); `node:crypto.timingSafeEqual` for HMAC compare; `randomBytes(32)` for state nonce |
| V7 Error Handling & Logging | yes | `OAuthSecret` non-loggable wrapper; `reportError` strips `extra` containing tokens; never `console.log` decrypted tokens |
| V9 Communication | yes | All provider calls over HTTPS (SDK enforces); Vercel TLS for inbound webhooks |
| V10 Malicious Code | n/a | No dynamic code loading |
| V13 API & Web Service | yes | Slack 3-second ack contract; HMAC verification before any DB read |

### Known Threat Patterns for {Slack/Google OAuth + Vercel Functions}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Token theft from DB | Information Disclosure | pgcrypto column encryption + key in env var (separate trust boundary) + RLS prevents read by anon/authenticated |
| Token theft from logs | Information Disclosure | `OAuthSecret` wrapper class with `toJSON` + `toString` returning `"[REDACTED]"`; never include token in `reportError({ extra })` payload |
| OAuth CSRF (attacker-initiated authorize) | Spoofing | Signed state token: `<userId>.<timestamp>.<hmac(userId.timestamp, secret)>`; callback verifies HMAC and timestamp window |
| Slack webhook replay | Replay (Tampering) | 5-minute timestamp window check on `X-Slack-Request-Timestamp` (Pattern 3) |
| Slack webhook forgery | Spoofing | HMAC-SHA256 verification with `timingSafeEqual` (Pattern 3) |
| Action button forgery (user clicks attacker-crafted button) | Spoofing | Button only carries `taskId` as `value`; webhook checks `tasks.assignee_id === payload.user.id ↔ slack-user-id mapping` before mutating — DON'T trust the value blindly |
| OAuth code interception | Spoofing | TLS only; `redirect_uri` registered in Slack/Google console pinned to prod URL; state nonce binds the code to the originating session |
| Stale event after completion | Repudiation (mild) | Documented tradeoff (D-07) — calendar event NOT deleted on completion; reduces sync-loop complexity. Surfaced as a known limitation in /settings copy. |
| Service-account impersonation | Spoofing | N/A — per-user OAuth (D-04), no service account in scope |
| Key rotation gap (mid-rotation decrypt fails) | Denial of Service | Dual-key cutover (D-12) — `get_oauth_token` tries NEW_KEY then falls back to OLD_KEY during the rotation window |
| Revoked token | Denial of Service | On 401/`invalid_grant` from Slack/Google — clear the row, set `user_integration_prefs.{slack,calendar}_enabled = false`, surface "Reconnect" in UI; do NOT retry indefinitely |

## Sources

### Primary (HIGH confidence)
- `/websites/slack_dev_reference_methods` (Context7) — `oauth.v2.access`, `chat.postMessage`, `chat.update`
- `/websites/slack_dev` (Context7) — Block Kit shapes, signature verification spec, block_actions payload shape
- `/websites/googleapis_dev_nodejs_googleapis` (Context7) — OAuth2Client, `'tokens'` event, `generateAuthUrl`
- https://developers.google.com/calendar/api/v3/reference/events/insert — Event resource shape
- https://developers.google.com/identity/protocols/oauth2/web-server — Web server OAuth flow
- https://docs.slack.dev/authentication/verifying-requests-from-slack — Signature spec
- https://docs.slack.dev/reference/interaction-payloads/block_actions-payload — Webhook payload shape
- https://docs.slack.dev/reference/methods/chat.update — Update with bot token
- https://docs.slack.dev/reference/scopes/chat.write — Scope behavior
- https://docs.slack.dev/reference/scopes/im.write — DM open scope
- https://docs.slack.dev/authentication/best-practices-for-security — Token rotation guidance
- https://docs.slack.dev/interactivity/handling-user-interaction — 3s ack window
- https://www.postgresql.org/docs/current/pgcrypto.html — pgcrypto function signatures
- https://vercel.com/docs/functions/functions-api-reference — `waitUntil`, route segment config
- https://vercel.com/docs/functions/limitations — maxDuration on Pro Fluid Compute (300s default, 800s max)
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` — Next 16 `after()` semantics
- npm registry: `@slack/web-api@7.15.2` (pub 2026-05-04), `googleapis@171.4.0`
- Sandra codebase: `src/lib/messaging/providers/dialpad.ts` (HMAC pattern), `supabase/migrations/049` (SECURITY DEFINER pattern), `src/app/(dashboard)/settings/ai-responder/{page,actions,form}.tsx` (settings UI pattern), `src/lib/notifications/dispatch.ts` (dispatcher contract)

### Secondary (MEDIUM confidence)
- WebSearch result on `current_setting` pattern for pgcrypto keys — informed Assumption A5 (passing key as arg vs session config); chose arg-passing because it matches CONTEXT.md wording exactly.

### Tertiary (LOW confidence)
- None of the recommendations in this research rest on LOW-confidence sources alone.

## Project Constraints (from CLAUDE.md / AGENTS.md)

The repo's AGENTS.md explicitly warns: **"This is NOT the Next.js you know."** Sandra is on Next.js 16.2.4. Implementation work must consult `node_modules/next/dist/docs/` for any Next.js API rather than relying on training-data familiarity. Specifically:
- `after()` is now stable (Next 15.1+) — read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` before using.
- App Router server actions; route handlers in `app/api/.../route.ts`; cookies/headers are async (`await cookies()`).

From the user's global memory:
- **Vendor abstraction:** every external service goes through a common interface + swappable adapters. Slack and Google adapters here follow `src/lib/messaging/providers/dialpad.ts` shape.
- **Async everywhere:** the dispatch is fire-and-forget (`after()`) — already aligned with this constraint.
- **Sandra migrations CI-only:** migration 053 + 054 ship as `.sql` files; `db-migrate.yml` workflow auto-applies on merge. NEVER `apply_migration` against prod via MCP.
- **Cost-bearing actions need explicit opt-in:** N/A here — Slack/Calendar API calls are free at our scale.
- **No SQL in chat:** schema described in prose; SQL lives in plan/migration files.
- **Test every fix; TDD lite:** test cases listed before file changes — see Validation Architecture above.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — both libraries verified on npm registry, official docs cross-referenced
- Architecture: HIGH — Sandra's existing webhook + dispatcher patterns directly applicable; no novel architecture
- Pitfalls: HIGH — every pitfall in this list has a verified citation or codebase precedent (the `chat:write`/`im:write` distinction, the `prompt=consent` requirement, the 3-second Slack ack window, the form-encoded payload shape, the Postgres bytea-decrypt mismatch — all sourced from official docs)
- pgcrypto SECURITY DEFINER pattern: HIGH — Sandra has 8 existing SECURITY DEFINER migrations using identical `set search_path = public, pg_temp` shape

**Research date:** 2026-05-06
**Valid until:** 2026-06-05 (30 days for stable APIs); revisit if Slack rolls out token rotation by default or Next.js 17 changes `after()` semantics.
