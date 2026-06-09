import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const missingKey = requireIdempotencyKey(request);
  if (missingKey) return missingKey;

  try {
    const auth = await authenticateJitterWriteback(request);
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")!.trim();
    const body = JSON.parse(auth.rawBody || "{}") as { jitter_session_id?: string };
    const jitterSessionId = body.jitter_session_id?.trim();
    if (!jitterSessionId) {
      return NextResponse.json(
        { error: "validation_error", field: "jitter_session_id" },
        { status: 422 },
      );
    }

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "dialer_batch_claim",
      idempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return NextResponse.json(idempotency.cachedPayload);
    }

    const { data: existing, error: existingError } = await (auth.serviceClient as any)
      .from("dialer_batches")
      .select("id, status, jitter_session_id")
      .eq("id", id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    if (
      existing.jitter_session_id &&
      existing.jitter_session_id !== jitterSessionId
    ) {
      return NextResponse.json(
        { error: "conflict", error_code: "batch_already_claimed" },
        { status: 409 },
      );
    }

    const { data: batch, error: updateError } = await (auth.serviceClient as any)
      .from("dialer_batches")
      .update({
        status: "claimed",
        jitter_session_id: jitterSessionId,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id, org_id, status, jitter_session_id, claimed_at")
      .single();

    if (updateError) throw updateError;

    const payload = { batch };
    await recordIdempotentResponse(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "dialer_batch_claim",
      idempotencyKey,
      payload,
    });

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_claim_dialer_batch" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
