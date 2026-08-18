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

    // Atomic compare-and-swap claim, scoped to the authenticated org and
    // fenced by session id, with a 30-min TTL takeover for abandoned
    // claims (see migration 20260818120000_jitter_claim_fencing.sql).
    // Replaces the previous read-then-update, which let two concurrent
    // sessions both pass the "not already claimed" check.
    const { data: rpcResult, error: rpcError } = await (auth.serviceClient as any).rpc(
      "jitter_claim_dialer_batch",
      {
        p_batch_id: id,
        p_org_id: auth.orgId,
        p_session_id: jitterSessionId,
      },
    );
    if (rpcError) throw rpcError;

    const outcome = (rpcResult as { outcome?: string } | null)?.outcome;
    if (outcome === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (outcome === "conflict") {
      return NextResponse.json(
        { error: "conflict", error_code: "batch_already_claimed" },
        { status: 409 },
      );
    }

    const payload = { batch: (rpcResult as { batch: unknown }).batch };
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
