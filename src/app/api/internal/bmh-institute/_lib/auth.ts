import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import type { Database, Json } from "@/lib/supabase/types";

import { createInstituteServiceClient } from "./service-client";

type InstituteServiceClient = SupabaseClient<Database>;

export type InstituteAuthOk = {
  ok: true;
  consumerId: string;
  orgId: string;
  serviceClient: InstituteServiceClient;
  rawBody: string;
};

export type InstituteAuthResult =
  | InstituteAuthOk
  | { ok: false; response: NextResponse };

export type IdempotencyResult =
  | { state: "fresh"; idempotencyKey: string }
  | { state: "cached"; cachedPayload: unknown }
  | { state: "in_progress" };

function unauthorized(): InstituteAuthResult {
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

export async function authenticateInstituteCourse(
  request: Request,
): Promise<InstituteAuthResult> {
  const rawBody = await request.text();
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return unauthorized();

  const token = auth.slice("Bearer ".length).trim();
  if (!token) return unauthorized();

  const serviceClient = createInstituteServiceClient();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: consumer, error } = await (serviceClient as any)
    .from("webhook_consumers")
    .select("id, org_id, secret_hash")
    .eq("secret_hash", tokenHash)
    .eq("consumer_type", "bmh_institute_course")
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

  const { error: lastUsedError } = await (serviceClient as any)
    .from("webhook_consumers")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", consumer.id);
  if (lastUsedError) {
    console.warn("[authenticateInstituteCourse] last_used_at update failed", {
      consumerId: consumer.id,
      error: lastUsedError.message,
    });
  }

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
  serviceClient: InstituteServiceClient,
  args: { eventType: string; idempotencyKey: string; payload: unknown },
): Promise<IdempotencyResult> {
  const idempotencyKey = args.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new Error("checkAndRecordIdempotency requires a non-empty key");
  }

  const { error } = await (serviceClient as any).from("webhook_events").insert({
    provider: "bmh_institute",
    event_type: args.eventType,
    external_id: idempotencyKey,
    signature_verified: true,
    payload: args.payload as Json,
    processing_status: "pending",
  });

  if (!error) return { state: "fresh", idempotencyKey };
  if (error.code !== "23505") throw error;

  const { data: existing } = await (serviceClient as any)
    .from("webhook_events")
    .select("payload, processing_status")
    .eq("provider", "bmh_institute")
    .eq("event_type", args.eventType)
    .eq("external_id", idempotencyKey)
    .maybeSingle();

  if (existing?.processing_status !== "processed") {
    return { state: "in_progress" };
  }

  return { state: "cached", cachedPayload: existing?.payload ?? null };
}

export async function recordIdempotentResponse(
  serviceClient: InstituteServiceClient,
  args: { eventType: string; idempotencyKey: string; payload: unknown },
): Promise<void> {
  const { error } = await (serviceClient as any)
    .from("webhook_events")
    .update({ payload: args.payload as Json, processing_status: "processed" })
    .eq("provider", "bmh_institute")
    .eq("event_type", args.eventType)
    .eq("external_id", args.idempotencyKey);
  if (error) throw error;
}
