import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import type { Database } from "@/lib/supabase/types";

import { createSwitchboardServiceClient } from "./service-client";

type SwitchboardServiceClient = SupabaseClient<Database>;

const MAX_RAW_BODY_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

export type SwitchboardAuthResult =
  | {
      ok: true;
      consumerId: string;
      orgId: string;
      rawBody: string;
      serviceClient: SwitchboardServiceClient;
    }
  | { ok: false; response: NextResponse };

function errorResponse(error: "unauthorized" | "bad_request", status: 401 | 413) {
  return {
    ok: false as const,
    response: NextResponse.json({ error }, { status }),
  };
}

function unauthorized(): SwitchboardAuthResult {
  return errorResponse("unauthorized", 401);
}

export function isValidSwitchboardToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBoundedRawBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let rawBody = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RAW_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      rawBody += decoder.decode(value, { stream: true });
    }
    rawBody += decoder.decode();
    return rawBody;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The response remains generic even when stream cancellation also fails.
    }
    throw new Error("switchboard_request_body_unreadable");
  } finally {
    reader.releaseLock();
  }
}

export async function authenticateSwitchboardPreference(
  request: Request,
): Promise<SwitchboardAuthResult> {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.includes(",") || !authorization.startsWith("Bearer ")) {
    return unauthorized();
  }

  const token = authorization.slice("Bearer ".length);
  if (!isValidSwitchboardToken(token)) return unauthorized();

  const signature = request.headers.get("x-sandra-signature") ?? "";
  if (signature.includes(",") || !SIGNATURE_PATTERN.test(signature)) {
    return unauthorized();
  }

  const serviceClient = createSwitchboardServiceClient();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const { data: consumer, error } = await serviceClient
    .from("webhook_consumers")
    .select("id, org_id, secret_hash")
    .eq("secret_hash", tokenHash)
    .eq("consumer_type", "switchboard_contact_preference")
    .eq("enabled", true)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !consumer?.id || !consumer.org_id || !consumer.secret_hash) {
    return unauthorized();
  }
  if (!safeEqual(consumer.secret_hash, tokenHash)) return unauthorized();

  const rawBody = await readBoundedRawBody(request);
  if (rawBody === null) return errorResponse("bad_request", 413);

  const expected =
    "sha256=" + createHmac("sha256", token).update(rawBody).digest("hex");
  if (!safeEqual(signature, expected)) return unauthorized();

  void serviceClient
    .from("webhook_consumers")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", consumer.id);

  return {
    ok: true,
    consumerId: consumer.id,
    orgId: consumer.org_id,
    rawBody,
    serviceClient,
  };
}
