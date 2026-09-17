import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { getWebhookProvider } from "@/lib/messaging/registry";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

// `public.inbox_reply_reconcile_callback` (experiments/inbox-reply-send/
// callback.sql) is not yet reflected in the generated Database types —
// same overlay idiom as src/lib/inbox/reply-api.ts's ReplyDatabase.
type ReplyCallbackDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions"> & {
    Functions: Database["public"]["Functions"] & {
      inbox_reply_reconcile_callback: {
        Args: { in_provider: string; in_external_id: string; in_terminal: string; in_payload: Json };
        Returns: Json;
      };
    };
  };
};
type ReplyCallbackClient = Pick<SupabaseClient<ReplyCallbackDatabase>, "rpc">;

/**
 * Lane 1 PR-G: reply-specific Sendillo delivery-callback ingress. This is a
 * DISTINCT route and a DISTINCT reconciliation path from
 * `../status/route.ts` (the Outbox's own status webhook) — it drives
 * `inbox_reply_send.attempts` (`provider_accepted -> delivered |
 * delivery_failed`) via `public.inbox_reply_reconcile_callback`, and it
 * NEVER calls the Outbox's `reserveStatusWebhookEvent` /
 * `markStatusWebhookEventProcessed` / `markStatusWebhookEventError`
 * helpers (Astra #6 — those insert with no org_id and no lease-owner
 * fencing; org-scoping and lease fencing for this lane live entirely
 * inside the `inbox_reply_send.callback_receipts` table, reached only
 * through the service-role wrapper, in ONE atomic transaction with org
 * resolution — see experiments/inbox-reply-send/callback.sql).
 *
 * Dedup/out-of-order/idempotency is handled entirely by the wrapper (a
 * single RPC call), not by a separate reserve-then-complete round trip from
 * this route — that would reopen exactly the TOCTOU window (resolve org,
 * THEN reserve, as two separate statements) the wrapper was built to close.
 *
 * This route never calls the reply provider and never triggers a send —
 * it only ever reconciles a receipt that already exists, or stores one
 * durably for later reconciliation (Astra #5, callback-before-persist).
 */
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

type ParsedReplyStatus = { externalId: string; terminal: "delivered" | "delivery_failed" };

/**
 * Own bounded parser for the reply-status payload shape — deliberately NOT
 * `provider.parseStatusWebhook` (that parser feeds the Outbox's
 * `SmsStatusEvent`/`applyMessageStatusEvent` path, a different table and a
 * different dedup namespace entirely). Recognizes only the two terminal
 * events this ledger can apply; any other event name is ignored (returns
 * null — a clean 200 no-op), matching `parseStatusWebhook`'s own
 * unknown-event behavior.
 */
function parseReplyStatusEvent(rawBody: string): ParsedReplyStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const event = typeof root.event === "string" ? root.event : typeof root.eventType === "string" ? root.eventType : typeof root.type === "string" ? root.type : null;
  const dataRaw = root.data;
  const data = dataRaw && typeof dataRaw === "object" && !Array.isArray(dataRaw) ? (dataRaw as Record<string, unknown>) : root;
  const messageId = typeof data.messageId === "string" && data.messageId.length > 0 ? data.messageId : typeof data.id === "string" && data.id.length > 0 ? data.id : null;
  if (!messageId || messageId.length > 512) return null;

  if (event === "message.delivered") return { externalId: messageId, terminal: "delivered" };
  if (event === "message.failed") return { externalId: messageId, terminal: "delivery_failed" };
  return null;
}

export async function POST(request: Request) {
  try {
    const provider = getWebhookProvider("sendillo");
    if (!provider) {
      return NextResponse.json({ error: "Messaging provider not configured" }, { status: 503 });
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    const fullUrl = new URL(request.url, `https://${request.headers.get("host") ?? "example.invalid"}`).toString();

    if (!provider.verifyWebhookSignature(rawBody, request.headers, fullUrl)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const event = parseReplyStatusEvent(rawBody);
    if (!event) {
      // Unrecognized event name, or a malformed/oversized messageId. A
      // signature-verified but unrecognized event is a clean no-op, never
      // an error — this endpoint only ever cares about the two terminal
      // reply-delivery events.
      return NextResponse.json({ ok: true, ignored: true });
    }

    const supabase: ReplyCallbackClient = createAdminClient();
    const { data, error } = await supabase.rpc("inbox_reply_reconcile_callback", {
      in_provider: provider.providerId,
      in_external_id: event.externalId,
      in_terminal: event.terminal,
      in_payload: safeParseJson(rawBody) ?? {},
    });
    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "sendillo_reply_status_webhook_reconcile" },
        extra: { externalId: event.externalId, terminal: event.terminal },
      });
      return NextResponse.json({ error: "reconcile failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, result: data });
  } catch (error) {
    reportError(error, { tags: { surface: "sendillo_reply_status_webhook_unexpected" } });
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}

function safeParseJson(rawBody: string): Json | null {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return null;
  }
}
