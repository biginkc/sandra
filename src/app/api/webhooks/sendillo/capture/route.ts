import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database, Json } from "@/lib/supabase/types";

function createServiceRoleClient() {
  const useTestEnv =
    process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const url = useTestEnv
    ? (process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)
    : process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = useTestEnv
    ? (process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
        process.env.SUPABASE_SERVICE_ROLE_KEY)
    : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Sendillo capture webhook needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function safeParseJson(rawBody: string): Json | null {
  try {
    return JSON.parse(rawBody) as Json;
  } catch {
    return null;
  }
}

function readString(value: unknown, ...path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of headers.entries()) normalized[key] = value;
  return normalized;
}

function captureSecret(): string | null {
  return process.env.SENDILLO_CAPTURE_SECRET ?? null;
}

function captureEnabled(): boolean {
  return process.env.SENDILLO_CAPTURE_ENABLED === "true";
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("secret");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function redactHeaders(headers: Headers): Record<string, string> {
  const normalized = normalizeHeaders(headers);
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    const lower = key.toLowerCase();
    redacted[key] =
      lower === "authorization" ||
      lower.includes("secret") ||
      lower.includes("token")
        ? "[redacted]"
        : value;
  }
  return redacted;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readCaptureCredential(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return headers.get("x-sendillo-capture-secret")?.trim() ?? null;
}

async function authorizeCaptureRequest(request: Request) {
  if (!captureEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const expectedSecret = captureSecret();
  if (!expectedSecret) {
    return NextResponse.json(
      { error: "Sendillo capture secret not configured" },
      { status: 503 },
    );
  }

  const providedSecret = readCaptureCredential(request.headers);
  if (!providedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  return null;
}

export async function GET(request: Request) {
  try {
    const authError = await authorizeCaptureRequest(request);
    if (authError) return authError;

    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from("webhook_events")
      .select(
        "provider, event_type, external_id, signature_verified, processing_status, received_at, payload",
      )
      .eq("provider", "sendillo_capture")
      .order("received_at", { ascending: false })
      .limit(10);

    if (error) {
      reportError(new Error(error.message), {
        tags: { surface: "sendillo_capture_list" },
      });
      return NextResponse.json({ error: "Capture read failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, events: data ?? [] });
  } catch (e) {
    reportError(e, { tags: { surface: "sendillo_capture_list_unexpected" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const authError = await authorizeCaptureRequest(request);
    if (authError) return authError;

    const rawBody = await request.text();
    const parsed = safeParseJson(rawBody);
    const eventType =
      readString(parsed, "event") ??
      readString(parsed, "eventType") ??
      readString(parsed, "type") ??
      "unknown";
    const externalId =
      readString(parsed, "data", "messageId") ??
      readString(parsed, "messageId") ??
      readString(parsed, "data", "id") ??
      readString(parsed, "id") ??
      readString(parsed, "data", "eventId") ??
      createHash("sha256").update(rawBody).digest("hex");

    const supabase = createServiceRoleClient();
    const payload: Json = {
      capturedAt: new Date().toISOString(),
      url: redactUrl(request.url),
      method: request.method,
      headers: redactHeaders(request.headers),
      rawBody,
      parsed,
    };

    const { error } = await supabase.from("webhook_events").insert({
      provider: "sendillo_capture",
      event_type: eventType,
      external_id: externalId,
      payload,
      signature_verified: false,
      processing_status: "ignored",
    });

    if (error && error.code !== "23505") {
      reportError(new Error(error.message), {
        tags: { surface: "sendillo_capture_insert" },
        extra: { eventType, externalId },
      });
      return NextResponse.json({ error: "Capture insert failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      captured: true,
      eventType,
      externalId,
      duplicate: error?.code === "23505",
    });
  } catch (e) {
    reportError(e, { tags: { surface: "sendillo_capture_unexpected" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
