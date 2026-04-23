import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import {
  parseTwilioInbound,
  verifyTwilioSignature,
} from "@/lib/messaging/providers/twilio-receiver";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * Twilio test-receiver webhook. NOT used in prod — only in dev/staging
 * where we've configured a Twilio number's Messaging Webhook to point
 * at this URL.
 *
 * Flow:
 *   1. Verify X-Twilio-Signature using TWILIO_AUTH_TOKEN.
 *   2. Parse the form-encoded body into a typed shape.
 *   3. Insert into `test_sms_log` so E2E tests can poll for expected
 *      messages. `on conflict (provider, external_id) do nothing`
 *      handles Twilio retries.
 *
 * Always returns 200 on authentic payloads (even on DB error — log it
 * and move on) so Twilio stops retrying. 401 on signature mismatch,
 * 400 on malformed payload, 503 when the feature isn't configured.
 */

function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "test-receiver needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function POST(request: Request) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      // Feature off — return 503 so a stray hook doesn't look like success.
      return NextResponse.json(
        { error: "TWILIO_AUTH_TOKEN not configured" },
        { status: 503 },
      );
    }

    const rawBody = await request.text();

    // Build the canonical URL exactly as Twilio saw it. Reverse proxies
    // can rewrite x-forwarded-* headers; we trust them here because the
    // signature fails anyway if any part of the URL is wrong.
    const fullUrl = new URL(
      request.url,
      `https://${request.headers.get("host") ?? "example.invalid"}`,
    ).toString();

    const params = new URLSearchParams(rawBody);
    const form: Record<string, string> = {};
    for (const [k, v] of params.entries()) form[k] = v;

    if (
      !verifyTwilioSignature({
        authToken,
        fullUrl,
        form,
        signatureHeader: request.headers.get("x-twilio-signature"),
      })
    ) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const parsed = parseTwilioInbound(rawBody);
    if (!parsed) {
      return NextResponse.json(
        { error: "Missing required Twilio fields" },
        { status: 400 },
      );
    }

    const supabase = createServiceRoleClient();
    const { error } = await supabase.from("test_sms_log").insert({
      provider: "twilio",
      external_id: parsed.messageSid,
      from_number: parsed.from,
      to_number: parsed.to,
      body: parsed.body,
      signature_verified: true,
      raw_payload: parsed.form as Json,
    });
    if (error) {
      // 23505 = unique_violation on (provider, external_id) — Twilio retry.
      if (error.code !== "23505") {
        reportError(new Error(error.message), {
          tags: { surface: "test_receiver_insert" },
          extra: { messageSid: parsed.messageSid },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { tags: { surface: "test_receiver_unexpected" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
