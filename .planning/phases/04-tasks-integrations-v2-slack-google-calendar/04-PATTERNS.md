# Phase 04: Tasks Integrations (V2 — Slack + Google Calendar) — Pattern Map

**Mapped:** 2026-05-06
**Files analyzed:** 16 (14 new, 2 modified)
**Analogs found:** 16 / 16 (every file maps to a real, recent codebase analog — even where the role is new, the data flow and conventions transfer cleanly)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `supabase/migrations/0NN_user_oauth_tokens.sql` | migration | DDL + RLS + SECURITY DEFINER fn | `supabase/migrations/049_metric_snapshots_table.sql` + `016_notifications.sql` | exact (combine the two) |
| `supabase/migrations/0NN_user_integration_prefs.sql` | migration | DDL + RLS | `supabase/migrations/049_metric_snapshots_table.sql` | exact |
| `src/lib/oauth/tokens.ts` | service / utility | request-response (DB read + RPC) | `src/lib/notifications/dispatch.ts:createNotification` (low-level DB helper, never throws) | role-match |
| `src/lib/oauth/slack.ts` | vendor adapter | request-response (HTTP) | `src/lib/messaging/providers/dialpad.ts` (HMAC + factory) + `src/lib/skip-trace/providers/tracerfy.ts` (Bearer + retry) | exact |
| `src/lib/oauth/google.ts` | vendor adapter | request-response (HTTP) | `src/lib/skip-trace/providers/tracerfy.ts` + factory pattern in `messaging/registry.ts` | exact |
| `src/lib/integrations/dispatch-slack.ts` | service / dispatcher | event-driven (best-effort) | `src/lib/notifications/dispatch.ts:dispatchTaskAssigned` | exact |
| `src/lib/integrations/dispatch-calendar.ts` | service / dispatcher | event-driven (best-effort) | `src/lib/notifications/dispatch.ts:dispatchTaskAssigned` | exact |
| `src/app/api/oauth/slack/start/route.ts` | route handler | request-response (redirect) | (no exact analog — model on the cron route handler shape + `googleapis`/Slack SDK URL builder) | role-match |
| `src/app/api/oauth/slack/callback/route.ts` | route handler | request-response (write) | `src/app/api/cron/notification-cleanup/route.ts` (service-role + NextResponse) | role-match |
| `src/app/api/oauth/google/start/route.ts` | route handler | request-response (redirect) | same as Slack/start | role-match |
| `src/app/api/oauth/google/callback/route.ts` | route handler | request-response (write) | same as Slack/callback | role-match |
| `src/app/api/slack/actions/route.ts` | webhook | request-response (HMAC verify) | `src/app/api/webhooks/dialpad/sms/route.ts` (raw body + HMAC + 401) | exact |
| `src/app/(dashboard)/settings/integrations/page.tsx` | server component | request-response | `src/app/(dashboard)/settings/ai-responder/page.tsx` | exact |
| `src/app/(dashboard)/settings/integrations/actions.ts` | server actions | CRUD + after() background | `src/app/(dashboard)/settings/ai-responder/actions.ts` + `src/lib/skip-trace/actions.ts` (after()) | exact |
| `src/lib/notifications/dispatch.ts:dispatchTaskAssigned` (modified) | service / dispatcher | event-driven (fan-out) | itself — extend in place; pattern already there | exact (in-file) |
| `src/lib/supabase/types.ts` (modified) | generated types | n/a | existing `notifications` + `tasks` blocks | exact |

---

## Pattern Assignments

### `supabase/migrations/0NN_user_oauth_tokens.sql` (migration)

**Analogs:**
- `supabase/migrations/049_metric_snapshots_table.sql` — table + RLS + helper fn + `reset_tenant_tables()` extension
- `supabase/migrations/016_notifications.sql` — table + RLS policy + reset extension
- `supabase/migrations/051_tasks_table.sql` — most recent template; combines all of the above plus a CHECK constraint widen pattern (useful if we ever extend `token_type`)

**Header comment + table block** (049 lines 1-19, 051 lines 1-39):
```sql
-- ============================================================================
-- Phase 04 — user_oauth_tokens
--
-- Per-user OAuth credentials for Slack + Google Calendar. Encrypted at rest
-- via pgcrypto's pgp_sym_encrypt; decrypt is gated behind a SECURITY DEFINER
-- function that's only callable from the service role.
--
-- Composite PK (user_id, provider, token_type) — Slack needs both 'user' and
-- 'bot' rows per (user_id, provider='slack'); Google has a single 'user' row.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml.
-- ============================================================================

create table user_oauth_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('slack', 'google')),
  token_type text not null check (token_type in ('user', 'bot')),
  access_token_encrypted bytea not null,
  refresh_token_encrypted bytea,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  external_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider, token_type)
);
```

**RLS pattern** (016 lines 52-61, 049 lines 32-38):
```sql
alter table user_oauth_tokens enable row level security;

-- Each user can SELECT their own row (encrypted blob — useless without the key).
-- INSERT/UPDATE/DELETE go through service-role only (callbacks, refresh handler).
create policy user_oauth_tokens_self_read on user_oauth_tokens
  for select
  to authenticated
  using (user_id = auth.uid());
```

**SECURITY DEFINER decrypt function** (049 lines 42-66 — adapt the `security definer` + `revoke from public` shape):
```sql
create or replace function public.get_oauth_token(
  p_user_id uuid,
  p_provider text,
  p_token_type text
)
returns table(
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  scopes text[],
  external_account_id text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    pgp_sym_decrypt(access_token_encrypted, current_setting('app.oauth_key'))::text,
    case when refresh_token_encrypted is null then null
         else pgp_sym_decrypt(refresh_token_encrypted, current_setting('app.oauth_key'))::text
    end,
    access_token_expires_at,
    scopes,
    external_account_id
  from user_oauth_tokens
  where user_id = p_user_id and provider = p_provider and token_type = p_token_type;
$$;

revoke execute on function public.get_oauth_token(uuid, text, text) from public;
revoke execute on function public.get_oauth_token(uuid, text, text) from authenticated;
grant  execute on function public.get_oauth_token(uuid, text, text) to service_role;
```

**Note for planner:** `current_setting('app.oauth_key')` is the **recommended** pattern (key passed via `SET LOCAL` from the TS helper at decrypt time so the key never lives in pg_proc bodies). RESEARCH.md will confirm; alternative is to pass the key as a 4th function arg — equivalent security, slightly noisier call site.

**`reset_tenant_tables()` extension** (049 lines 70-115, 051 lines 80-125 — append the new table to the truncate list):
```sql
-- Update reset_tenant_tables() to include user_oauth_tokens
create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate table
    user_oauth_tokens,
    user_integration_prefs,
    metric_snapshots,
    tasks,
    -- ... existing list from migration 051 ...
  restart identity cascade;
  -- ... existing system_managed deletes from 051 ...
end;
$$;
```

---

### `supabase/migrations/0NN_user_integration_prefs.sql` (migration)

**Analog:** `supabase/migrations/049_metric_snapshots_table.sql`

Single thin table — one row per `(user_id, channel)` with a `enabled` boolean. Same RLS shape as `user_oauth_tokens` (self-read, service-role write), same `reset_tenant_tables()` extension. No SECURITY DEFINER needed — this is non-sensitive UI state.

```sql
create table user_integration_prefs (
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('slack', 'google_calendar')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, channel)
);

alter table user_integration_prefs enable row level security;
create policy user_integration_prefs_self_all on user_integration_prefs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

---

### `src/lib/oauth/tokens.ts` (service / utility)

**Analog:** `src/lib/notifications/dispatch.ts` (low-level helper that never throws across boundary)

**Imports + non-loggable type** (mirrors dispatch.ts lines 1-12, with the security wrapper from `<specifics>` #5):
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

/**
 * Opaque wrapper — toString/JSON.stringify return a redaction marker so a
 * decrypted token can never accidentally be logged via reportError.extra,
 * console.log, or Sentry's structured-context serialization.
 */
export class OauthSecret {
  constructor(private readonly value: string) {}
  reveal(): string { return this.value; }
  toString() { return "[redacted-oauth-token]"; }
  toJSON() { return "[redacted-oauth-token]"; }
}
```

**Best-effort fetch helper** (mirrors `createNotification` lines 23-60 — never throws, returns null on miss):
```typescript
export async function getOauthToken(
  userId: string,
  provider: "slack" | "google",
  tokenType: "user" | "bot",
): Promise<{
  accessToken: OauthSecret;
  refreshToken: OauthSecret | null;
  expiresAt: string | null;
  scopes: string[];
  externalAccountId: string | null;
} | null> {
  const admin = createAdminClient();
  // SET LOCAL the encryption key for this transaction only — keeps the key
  // out of pg_proc bodies and out of any audit log that records function args.
  const { data, error } = await admin.rpc("get_oauth_token", {
    p_user_id: userId,
    p_provider: provider,
    p_token_type: tokenType,
  });
  if (error || !data || data.length === 0) {
    if (error) reportError(error, { tags: { surface: "oauth_get_token" } });
    return null;
  }
  // Wrap before returning — caller never sees a raw string.
  return { /* ...mapped row... */ };
}
```

**Encrypt + persist helper** (no direct analog — but the shape mirrors `createNotification` insert pattern lines 38-59):
```typescript
export async function persistOauthToken(input: { /* ... */ }): Promise<{ ok: boolean }> {
  const admin = createAdminClient();
  // pgp_sym_encrypt invoked via .rpc() OR a tiny SQL fn 'encrypt_oauth_token'
  // (researcher's call). Either way the plaintext lives only inside the DB
  // transaction; never serialize it elsewhere.
  // ...
  // On success: UPSERT on (user_id, provider, token_type).
}
```

---

### `src/lib/oauth/slack.ts` (vendor adapter)

**Analog:** `src/lib/messaging/providers/dialpad.ts` (HMAC verify + env-var factory) + `src/lib/skip-trace/providers/tracerfy.ts` (Bearer auth + ProviderError + ConfigurationError)

**Imports + class shape** (dialpad.ts lines 1-34):
```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";

const SLACK_API = "https://slack.com/api";

export class SlackOauthProvider {
  readonly providerId = "slack";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly signingSecret: string,
  ) {}

  // ... methods below ...
}
```

**OAuth code exchange** (mirrors tracerfy.ts:request lines 305-339 — shared `request<T>` helper, ProviderError on non-2xx):
```typescript
async exchangeCode(code: string, redirectUri: string): Promise<{
  botToken: string;
  userToken: string | null;
  scopes: string[];
  teamId: string;
  authedUserId: string;
}> {
  const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new ProviderError(`Slack ${res.status}: ${await res.text().catch(() => "")}`,
                           "slack", { status: res.status });
  }
  const json = await res.json() as { ok: boolean; error?: string; access_token?: string; /* ... */ };
  if (!json.ok) throw new ProviderError(`Slack oauth.v2.access error: ${json.error}`, "slack");
  // Map to internal shape.
}
```

**Webhook signature verification** (dialpad.ts lines 106-140 — Slack uses `v0=` HMAC over `v0:{ts}:{body}`):
```typescript
verifyInteractivitySignature(rawBody: string, headers: Headers): boolean {
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature"); // "v0=<hex>"
  if (!ts || !sig) return false;
  // Replay-attack guard: reject if older than 5 min.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;
  const base = `v0:${ts}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", this.signingSecret).update(base).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

**Env-var factory** (dialpad.ts lines 325-335, tracerfy.ts lines 381-387):
```typescript
export function slackFromEnv(): SlackOauthProvider {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!clientId || !clientSecret || !signingSecret) {
    throw new ConfigurationError(
      "Slack OAuth credentials missing. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET.",
    );
  }
  return new SlackOauthProvider(clientId, clientSecret, signingSecret);
}
```

---

### `src/lib/oauth/google.ts` (vendor adapter)

**Analog:** `src/lib/skip-trace/providers/tracerfy.ts` (Bearer auth + factory) — but the actual SDK is `googleapis` (D-17), so most of the body is `oauth2Client.getToken()` / `oauth2Client.setCredentials()` / `calendar.events.insert()`. Pattern below shows where the codebase shape applies.

**Class + env factory** (tracerfy.ts lines 110-117 + 381-387):
```typescript
import { google } from "googleapis";

import { ConfigurationError, ProviderError } from "@/lib/errors/classes";

export class GoogleOauthProvider {
  readonly providerId = "google";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  buildOauthClient(redirectUri: string) {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, redirectUri);
  }

  // generateAuthUrl, exchangeCode, listenForRotatedTokens, insertEvent, patchEvent ...
}

export function googleFromEnv(): GoogleOauthProvider {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ConfigurationError("Google OAuth credentials missing.");
  }
  return new GoogleOauthProvider(clientId, clientSecret);
}
```

**Token-rotation listener** (D-08 — wire `oauth2Client.on('tokens', ...)` to UPDATE `user_oauth_tokens`). No direct codebase analog; cite the Google `googleapis` SDK docs in canonical_refs.

---

### `src/lib/integrations/dispatch-slack.ts` (service / dispatcher)

**Analog:** `src/lib/notifications/dispatch.ts:dispatchTaskAssigned` (lines 200-227)

**Function signature + best-effort wrap** (mirrors dispatchTaskAssigned exactly):
```typescript
import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { humanDueDate } from "@/lib/notifications/format";
import { getOauthToken } from "@/lib/oauth/tokens";
import { slackFromEnv } from "@/lib/oauth/slack";
import type { Database } from "@/lib/supabase/types";

/**
 * Best-effort Slack DM to the task assignee. Same shape as
 * dispatchTaskAssigned (in-app bell) — never throws across the
 * boundary; logs via reportError on failure.
 */
export async function dispatchSlackTaskAssigned(
  supabase: SupabaseClient<Database>,
  params: {
    taskId: string;
    assigneeId: string;
    taskTitle: string;
    taskType: string;
    dueAt: string;
    propertyAddress?: string | null;
  },
): Promise<{ sent: boolean }> {
  try {
    // 1. Check user pref — short-circuit if disabled.
    const { data: pref } = await supabase
      .from("user_integration_prefs")
      .select("enabled")
      .eq("user_id", params.assigneeId)
      .eq("channel", "slack")
      .maybeSingle();
    if (pref && !pref.enabled) return { sent: false };

    // 2. Look up bot token (D-03).
    const token = await getOauthToken(params.assigneeId, "slack", "bot");
    if (!token) return { sent: false };

    // 3. Post DM via Slack Web API. Block Kit body composed from humanDueDate.
    // ... (researcher to land exact Block Kit spec) ...
    return { sent: true };
  } catch (e) {
    reportError(e, {
      tags: { surface: "dispatch_slack_task_assigned" },
      extra: { taskId: params.taskId, assigneeId: params.assigneeId },
    });
    return { sent: false };
  }
}
```

---

### `src/lib/integrations/dispatch-calendar.ts` (service / dispatcher)

**Analog:** Same as `dispatch-slack.ts` — the `dispatchTaskAssigned` shape repeats.

Key differences from Slack:
- Token type is always `'user'` (Google has no bot concept here)
- Uses `googleapis` `calendar.events.insert()` for create, `calendar.events.patch()` for update
- D-07: task-complete is a **no-op** (don't delete event); only create + update (when `due_at` changes)
- 30-min duration, `location: propertyAddress`, `summary: \`Follow up: ${address}\``

---

### `src/app/api/oauth/slack/start/route.ts` (route handler — redirect)

**No exact analog** for OAuth-initiate routes in the codebase. Closest patterns:
- `src/app/api/cron/notification-cleanup/route.ts` (lines 1-69) for the GET handler shell + NextResponse
- The route generates a `state` nonce, persists it briefly (cookie), and returns `NextResponse.redirect(authorizeUrl)`

Shape (no excerpt — net-new pattern):
```typescript
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const state = randomBytes(32).toString("hex");
  // Persist state in an httpOnly cookie for callback verification.
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", "chat:write,im:write,users:read"); // bot scopes
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `${process.env.APP_URL}/api/oauth/slack/callback`);
  const res = NextResponse.redirect(url.toString());
  res.cookies.set("slack_oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
  return res;
}
```

---

### `src/app/api/oauth/slack/callback/route.ts` (route handler — write)

**Analog:** `src/app/api/cron/notification-cleanup/route.ts` (NextResponse + service-role + try/catch shape, lines 35-59)

**Header + service-role + flow** (mirrors the cron route):
```typescript
import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { slackFromEnv } from "@/lib/oauth/slack";
import { persistOauthToken } from "@/lib/oauth/tokens";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateCookie = request.headers.get("cookie")?.match(/slack_oauth_state=([^;]+)/)?.[1];
    if (!code || !state || state !== stateCookie) {
      return NextResponse.redirect(new URL("/settings/integrations?error=state", request.url));
    }
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.redirect(new URL("/login", request.url));

    const slack = slackFromEnv();
    const tokens = await slack.exchangeCode(code, `${process.env.APP_URL}/api/oauth/slack/callback`);
    await persistOauthToken({ userId: user.id, provider: "slack", tokenType: "bot", /* ... */ });
    if (tokens.userToken) {
      await persistOauthToken({ userId: user.id, provider: "slack", tokenType: "user", /* ... */ });
    }
    return NextResponse.redirect(new URL("/settings/integrations?connected=slack", request.url));
  } catch (e) {
    reportError(e, { tags: { surface: "oauth_slack_callback" } });
    return NextResponse.redirect(new URL("/settings/integrations?error=callback", request.url));
  }
}
```

---

### `src/app/api/slack/actions/route.ts` (webhook — Mark Done button)

**Analog:** `src/app/api/webhooks/dialpad/sms/route.ts` (raw body + provider HMAC verify + 401 mismatch, lines 68-100)

**Shape** (mirrors dialpad webhook header + flow):
```typescript
import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { slackFromEnv } from "@/lib/oauth/slack";
import { createAdminClient } from "@/lib/supabase/admin";
import { completeTask } from "@/lib/tasks";

export async function POST(request: Request) {
  try {
    const slack = slackFromEnv();
    const rawBody = await request.text();

    // 1. Verify Slack signature on the raw body.
    if (!slack.verifyInteractivitySignature(rawBody, request.headers)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // 2. Parse Slack interactivity payload (form-encoded `payload=<json>`).
    const params = new URLSearchParams(rawBody);
    const payload = JSON.parse(params.get("payload") ?? "{}");
    // payload.actions[0].action_id === "mark_done", value === taskId

    // 3. Look up Sandra user by Slack user_id (external_account_id on user_oauth_tokens).
    const admin = createAdminClient();
    // ... resolve, completeTask, return 200 within 3s (Slack timeout) ...
    return NextResponse.json({ /* ack body or chat.update */ });
  } catch (e) {
    reportError(e, { tags: { surface: "slack_actions_webhook" } });
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
```

**Critical detail:** middleware (`src/lib/supabase/middleware.ts`) whitelists `/api/webhooks` as public — `/api/slack/actions` either needs the same whitelist treatment OR moves under `/api/webhooks/slack/actions/route.ts` for free auth bypass. Recommend the latter for consistency.

---

### `src/app/(dashboard)/settings/integrations/page.tsx` (server component)

**Analog:** `src/app/(dashboard)/settings/ai-responder/page.tsx` (lines 1-52)

**Imports + auth gate + Page/PageHeader** (copy verbatim, swap labels):
```typescript
import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";

import { getIntegrationStatus } from "./actions";
import { IntegrationsForm } from "./form";

export default async function IntegrationsSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // Note: NOT admin-gated. Each user manages their OWN integrations
  // (D-01, D-04 — per-user OAuth, not workspace-level).

  const status = await getIntegrationStatus();
  if (!status.ok) {
    return (
      <Page>
        <div className="text-destructive text-sm">
          Failed to load integration status: {status.error.message}
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Integrations" }]}
        title="Integrations"
        description="Connect Slack and Google Calendar to receive task notifications outside Sandra. One-way outbound — Sandra remains the source of truth."
      />
      <IntegrationsForm initial={status.data} />
    </Page>
  );
}
```

---

### `src/app/(dashboard)/settings/integrations/actions.ts` (server actions)

**Analog:** `src/app/(dashboard)/settings/ai-responder/actions.ts` (lines 1-157) — Result shape, auth check, revalidatePath

**Function pattern** (mirrors `getAiResponderConfig` + `updateAiResponderConfig`):
```typescript
"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

export type IntegrationStatus = {
  slack: { connected: boolean; enabled: boolean; teamName?: string | null };
  google: { connected: boolean; enabled: boolean; email?: string | null };
};

export async function getIntegrationStatus(): Promise<Result<IntegrationStatus>> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "AUTH", message: "Sign in required." } };

    // Connected = a row exists in user_oauth_tokens for this (user, provider).
    // Enabled = user_integration_prefs.enabled (defaults true on first connect).
    // ...
    return ok(/* ... */);
  } catch (e) {
    reportError(e, { tags: { surface: "get_integration_status" } });
    return errFromUnknown(e, "INTEGRATION_STATUS_FAILED");
  }
}

export async function setChannelEnabled(
  channel: "slack" | "google_calendar",
  enabled: boolean,
): Promise<Result<null>> {
  // ... auth.getUser, upsert into user_integration_prefs, revalidatePath ...
  revalidatePath("/settings/integrations");
  return ok(null);
}

export async function disconnectIntegration(
  provider: "slack" | "google",
): Promise<Result<null>> {
  // ... delete row(s) from user_oauth_tokens via service role,
  //     revoke at provider via Slack/Google revoke endpoints (best-effort) ...
}
```

---

### `src/lib/notifications/dispatch.ts:dispatchTaskAssigned` (modified)

**Analog:** itself — extend in place with parallel best-effort fan-out via `after()`.

**Modification pattern** (extends lines 200-227 — keep current notification insert, add Slack + Calendar dispatchers fired in `after()` from the **caller** in `dispo-actions.ts`, NOT inside dispatchTaskAssigned itself):

The cleanest split is to leave `dispatchTaskAssigned` untouched (it stays focused on the bell-icon insert) and have `dispo-actions.ts:setOutreachDispo` (lines 121-132 of that file) fan out to the two new dispatchers via `after()`. This matches `src/lib/skip-trace/actions.ts:requestSkipTrace` which fires `after(async () => { ... })` for the heavy work after returning to the caller.

**Caller-side change in `dispo-actions.ts`** (mirrors skip-trace `actions.ts` lines 184-190):
```typescript
import { after } from "next/server";
// ... existing imports ...
import { dispatchSlackTaskAssigned } from "@/lib/integrations/dispatch-slack";
import { dispatchCalendarTaskEvent } from "@/lib/integrations/dispatch-calendar";

// inside setOutreachDispo, in the resolvedAssignee !== user.id branch:
after(async () => {
  await dispatchTaskAssigned(supabase, { /* existing args */ });
  await Promise.all([
    dispatchSlackTaskAssigned(supabase, { /* args */ }),
    dispatchCalendarTaskEvent(supabase, { /* args */ }),
  ]);
});
```

This keeps `dispatchTaskAssigned`'s contract identical and follows D-13 (fire-and-forget background dispatch via `after()`).

---

### `src/lib/supabase/types.ts` (modified — generated types)

**Analog:** the existing `notifications` block (lines 835-881) and `tasks` block (lines 1625-1690).

This file is **autogenerated** by `supabase gen types typescript ...`. Once migrations 0NN_user_oauth_tokens and 0NN_user_integration_prefs land in CI, the planner should add a step to regenerate types and commit. Don't hand-edit; the regen will produce the same shape as the analog blocks.

Expected shape (illustrative, do not hand-write):
```typescript
user_oauth_tokens: {
  Row: {
    user_id: string
    provider: string
    token_type: string
    access_token_encrypted: unknown // bytea — comes through as Uint8Array-ish
    refresh_token_encrypted: unknown | null
    access_token_expires_at: string | null
    scopes: string[]
    external_account_id: string | null
    created_at: string
    updated_at: string
  }
  // Insert + Update + Relationships ...
}
```

---

## Shared Patterns

### Best-effort dispatch (try/catch + reportError, never throw across boundary)
**Source:** `src/lib/notifications/dispatch.ts` (entire file, especially lines 47-59 and 200-227)
**Apply to:** `dispatch-slack.ts`, `dispatch-calendar.ts`, both OAuth callback routes, the Slack actions webhook
```typescript
try {
  // external call
} catch (e) {
  reportError(e, {
    tags: { surface: "<dispatcher_or_route_name>" },
    extra: { /* ids, but NEVER tokens */ },
  });
  return { sent: false }; // or NextResponse with 200 — webhooks especially must not retry-loop
}
```

### Service-role client construction (cron + webhook)
**Source:** `src/app/api/cron/notification-cleanup/route.ts` (lines 20-33) — also used by `src/app/api/webhooks/dialpad/sms/route.ts:createServiceRoleClient` (lines 53-66) and `src/app/api/webhooks/skip-trace/[secret]/route.ts` (lines 97-101)
**Apply to:** Slack actions webhook, OAuth callbacks (when persisting tokens past RLS)
```typescript
const supabase = createSupabaseClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
```
Or use the existing `createAdminClient()` helper from `src/lib/supabase/admin.ts` (lines 15-26).

### HMAC signature verification (raw body + timing-safe compare + 401)
**Source:** `src/lib/messaging/providers/dialpad.ts:decodeSignedJwt` (lines 116-140) and the route handler call site `src/app/api/webhooks/dialpad/sms/route.ts` (lines 78-85)
**Apply to:** `src/lib/oauth/slack.ts:verifyInteractivitySignature` and the Slack actions route
- Read `await request.text()` (NOT `.json()`) — signature is over bytes
- `timingSafeEqual` from `node:crypto` for the compare
- 401 + JSON `{ error: "Invalid signature" }` on mismatch

### Vendor adapter env-var factory
**Source:** `src/lib/messaging/providers/dialpad.ts:dialpadFromEnv` (lines 325-335) + `src/lib/skip-trace/providers/tracerfy.ts:tracerfyFromEnv` (lines 381-387)
**Apply to:** `slackFromEnv`, `googleFromEnv`
- Read env vars at the top of the factory
- Throw `ConfigurationError` (from `@/lib/errors/classes`) on missing — NOT a generic `Error`
- Return a configured class instance

### Settings-page server action (Result type + auth.getUser + revalidatePath)
**Source:** `src/app/(dashboard)/settings/ai-responder/actions.ts` (lines 28-59 for read, 76-157 for write)
**Apply to:** `src/app/(dashboard)/settings/integrations/actions.ts`
- `"use server"` at top
- Wrap body in try/catch → `errFromUnknown(e, "<CODE>")`
- `await supabase.auth.getUser()` for ownership/auth
- `revalidatePath("/settings/integrations")` after every successful write
- Return `Result<T>` (from `@/lib/errors/result`)

### Background work via `after()` (Next 16 fire-and-forget after server action returns)
**Source:** `src/lib/skip-trace/actions.ts` (lines 1-3 import, 184-190 + 296 call sites)
**Apply to:** the modified `dispo-actions.ts:setOutreachDispo` for fanning out to Slack + Calendar
- Import: `import { after } from "next/server";`
- Don't `await` — return immediately after queueing the `after()` block
- Re-create the supabase client inside `after()` if the request lifecycle has ended (see `actions.ts:185 — const bg = await createClient();`)

### Migration file conventions (CI-only, not via MCP)
**Source:** `supabase/migrations/051_tasks_table.sql` (header comment lines 1-19, structure: 1. Table, 2. RLS, 3. Constraints/Functions, 4. reset_tenant_tables() update)
**Apply to:** both new migrations
- File-naming: `0NN_<snake_case_description>.sql` — pick the next sequential number after the latest applied (currently `051`); the test-Supabase sync as of 2026-04-30 means BOTH prod and test now share the same versioning, so don't skip a number
- Always extend `reset_tenant_tables()` to include the new table (otherwise integration tests leak rows)
- Header comment block explaining what + why + that it's CI-only

### Format helpers (reuse, don't duplicate)
**Source:** `src/lib/notifications/format.ts:humanDueDate` (lines 44-62) and `formatNotification` (lines 70-128)
**Apply to:** Slack message body, Google Calendar event title — both should pull from the same `humanDueDate` so the in-app bell, Slack DM, and calendar event all say "Due tomorrow" identically.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/app/api/oauth/{slack,google}/start/route.ts` | route handler — redirect | OAuth-initiate | No existing route in the codebase performs an OAuth-initiate redirect; net-new pattern. Closest cron/webhook routes give the NextResponse + auth gate shape, but the redirect-to-vendor-with-state-cookie flow is novel. Researcher should validate with Slack OAuth v2 docs + Google OAuth Web Server flow docs. |
| `src/lib/oauth/google.ts` token-rotation listener | service / event handler | event-driven (SDK callback) | No existing code uses the `googleapis` SDK; the `oauth2Client.on('tokens', ...)` event-handler pattern is novel. Reference the SDK README in canonical_refs. |
| `pgcrypto` `pgp_sym_encrypt` SQL usage | DDL | n/a | `pgcrypto` is enabled in `001_initial.sql:6` but no current migration uses `pgp_sym_encrypt` / `pgp_sym_decrypt`. The SECURITY DEFINER function shape is borrowed from `049_metric_snapshots_table.sql:43-66`; the encrypt/decrypt body is net-new. Consider adding a 1-line example test in the migration's accompanying `.integration.test.ts`. |

---

## Metadata

**Analog search scope:**
- `supabase/migrations/` (52 files — focused on 016, 049, 051)
- `src/lib/notifications/` (all files)
- `src/lib/messaging/` (all files, focused on `providers/dialpad.ts`)
- `src/lib/skip-trace/` (focused on `providers/tracerfy.ts`, `actions.ts`, `registry.ts`)
- `src/lib/tasks/index.ts`
- `src/lib/supabase/{admin,server,types}.ts`
- `src/app/api/webhooks/{dialpad/sms,skip-trace/[secret]}/route.ts`
- `src/app/api/cron/notification-cleanup/route.ts`
- `src/app/(dashboard)/settings/ai-responder/{page,form,actions}.tsx`
- `src/app/(dashboard)/messages/dispo-actions.ts`
- `src/lib/errors/report.ts`

**Files scanned:** ~30 (focused — analogs were strong enough that broader search wasn't needed)
**Pattern extraction date:** 2026-05-06
