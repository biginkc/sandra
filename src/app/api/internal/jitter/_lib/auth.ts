import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import type { Database, Json } from "@/lib/supabase/types";

import { createJitterServiceClient } from "./service-client";

type JitterServiceClient = SupabaseClient<Database>;

export type JitterAuthOk = {
  ok: true;
  consumerId: string;
  orgId: string;
  serviceClient: JitterServiceClient;
  rawBody: string;
};

export type JitterAuthResult =
  | JitterAuthOk
  | { ok: false; response: NextResponse };

export type IdempotencyResult =
  | { state: "fresh"; idempotencyKey: string; requestHash: string }
  // A prior request reserved this key but did not commit its response. The
  // mutation must be retried; the original request body is never a success
  // response.
  | { state: "retry"; idempotencyKey: string; requestHash: string }
  | { state: "conflict"; idempotencyKey: string }
  | { state: "cached"; cachedPayload: unknown };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function computeJitterRequestHash(args: {
  route: string;
  resourceId: string;
  payload: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        payload: args.payload,
        resource_id: args.resourceId,
        route: args.route,
      }),
    )
    .digest("hex");
}

function unauthorized(): JitterAuthResult {
  return {
    ok: false,
    response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function authenticateJitterWriteback(
  request: Request,
): Promise<JitterAuthResult> {
  const rawBody = await request.text();
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return unauthorized();

  const token = auth.slice("Bearer ".length).trim();
  if (!token) return unauthorized();

  const serviceClient = createJitterServiceClient();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: consumer, error } = await (serviceClient as any)
    .from("webhook_consumers")
    .select("id, org_id, secret_hash")
    .eq("secret_hash", tokenHash)
    .eq("consumer_type", "jitter_writeback")
    .eq("enabled", true)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !consumer?.id || !consumer?.org_id || !consumer?.secret_hash) {
    return unauthorized();
  }

  if (!safeEqual(String(consumer.secret_hash), tokenHash)) {
    return unauthorized();
  }

  const signature = request.headers.get("x-sandra-signature") ?? "";
  const expected =
    "sha256=" + createHmac("sha256", token).update(rawBody).digest("hex");
  if (!safeEqual(signature, expected)) return unauthorized();

  void (serviceClient as any)
    .from("webhook_consumers")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", consumer.id);

  return {
    ok: true,
    consumerId: consumer.id as string,
    orgId: consumer.org_id as string,
    serviceClient,
    rawBody,
  };
}

export function requireIdempotencyKey(request: Request): NextResponse | null {
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.trim() === "") {
    return NextResponse.json(
      { error: "bad_request", error_code: "idempotency_key_required" },
      { status: 400 },
    );
  }
  return null;
}

export async function checkAndRecordIdempotency(
  serviceClient: JitterServiceClient,
  args: {
    orgId: string;
    eventType: string;
    resourceId: string;
    idempotencyKey: string;
    payload: unknown;
  },
): Promise<IdempotencyResult> {
  const idempotencyKey = args.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new Error("checkAndRecordIdempotency requires a non-empty key");
  }
  const hash = computeJitterRequestHash({
    route: args.eventType,
    resourceId: args.resourceId,
    payload: args.payload,
  });

  const { error } = await (serviceClient as any).from("webhook_events").insert({
    org_id: args.orgId,
    provider: "jitter",
    event_type: args.eventType,
    external_id: idempotencyKey,
    signature_verified: true,
    payload: args.payload as Json,
    request_hash: hash,
    processing_status: "pending",
  });

  if (!error) return { state: "fresh", idempotencyKey, requestHash: hash };

  if (error.code !== "23505") throw error;

  const { data: existing, error: existingError } = await (serviceClient as any)
    .from("webhook_events")
    .select("payload, processing_status, request_hash")
    .eq("org_id", args.orgId)
    .eq("provider", "jitter")
    .eq("event_type", args.eventType)
    .eq("external_id", idempotencyKey)
    .maybeSingle();

  if (existingError) throw existingError;

  if (existing?.processing_status === "pending" && existing.request_hash === null) {
    // Rows created before route/resource-bound hashes were introduced have no
    // trustworthy request identity. Claim the first retry's hash atomically;
    // a concurrent different retry must then observe the adopted hash and
    // become a conflict instead of mutating the legacy request.
    const { error: adoptError } = await (serviceClient as any)
      .from("webhook_events")
      .update({ request_hash: hash })
      .eq("org_id", args.orgId)
      .eq("provider", "jitter")
      .eq("event_type", args.eventType)
      .eq("external_id", idempotencyKey)
      .eq("processing_status", "pending")
      .is("request_hash", null);
    if (adoptError) throw adoptError;

    const { data: adopted, error: adoptedError } = await (serviceClient as any)
      .from("webhook_events")
      .select("payload, processing_status, request_hash")
      .eq("org_id", args.orgId)
      .eq("provider", "jitter")
      .eq("event_type", args.eventType)
      .eq("external_id", idempotencyKey)
      .maybeSingle();
    if (adoptedError) throw adoptedError;
    if (adopted?.request_hash !== hash) {
      return { state: "conflict", idempotencyKey };
    }
    return { state: "retry", idempotencyKey, requestHash: hash };
  }

  // A processed response is only reusable for the exact same route,
  // resource, and body. Never return a cached payload for a reused key.
  if (existing?.request_hash !== hash) {
    return { state: "conflict", idempotencyKey };
  }

  if (existing?.processing_status !== "processed") {
    return { state: "retry", idempotencyKey, requestHash: hash };
  }

  return { state: "cached", cachedPayload: existing?.payload ?? null };
}

export async function recordIdempotentResponse(
  serviceClient: JitterServiceClient,
  args: { orgId: string; eventType: string; idempotencyKey: string; payload: unknown },
): Promise<void> {
  const { error } = await (serviceClient as any)
    .from("webhook_events")
    .update({
      payload: args.payload as Json,
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    })
    .eq("org_id", args.orgId)
    .eq("provider", "jitter")
    .eq("event_type", args.eventType)
    .eq("external_id", args.idempotencyKey);

  if (error) {
    throw new Error(error.message ?? JSON.stringify(error));
  }
}
