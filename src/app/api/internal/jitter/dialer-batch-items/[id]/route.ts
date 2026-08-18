import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../_lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

const VALID_STATUSES = new Set([
  "queued",
  "in_progress",
  "completed",
  "skipped",
  "canceled",
]);

export async function PATCH(
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
    const body = JSON.parse(auth.rawBody || "{}") as {
      status?: string;
      jitter_session_id?: string;
    };
    if (!body.status || !VALID_STATUSES.has(body.status)) {
      return NextResponse.json(
        { error: "validation_error", field: "status" },
        { status: 422 },
      );
    }

    // Required so the fenced RPC below can verify this caller is the
    // batch's CURRENT claim holder, not a superseded (TTL-expired or
    // reclaimed) worker still trying to report. No live callers exist yet
    // (the Jitter bridge is unbuilt), so this new requirement breaks
    // nothing in production.
    const jitterSessionId = body.jitter_session_id?.trim();
    if (!jitterSessionId) {
      return NextResponse.json(
        { error: "validation_error", field: "jitter_session_id" },
        { status: 422 },
      );
    }

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "dialer_batch_item_patch",
      idempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return NextResponse.json(idempotency.cachedPayload);
    }

    // Atomic, org-scoped, session-fenced update (see migration
    // 20260818120000_jitter_claim_fencing.sql). Succeeds only when the
    // item's batch belongs to the authenticated org AND is currently
    // claimed by this exact session.
    const { data: rpcResult, error: rpcError } = await (auth.serviceClient as any).rpc(
      "jitter_patch_dialer_batch_item",
      {
        p_item_id: id,
        p_org_id: auth.orgId,
        p_session_id: jitterSessionId,
        p_status: body.status,
      },
    );
    if (rpcError) throw rpcError;

    const outcome = (rpcResult as { outcome?: string } | null)?.outcome;
    if (outcome === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (outcome === "stale_claim") {
      return NextResponse.json(
        { error: "conflict", error_code: "stale_claim" },
        { status: 409 },
      );
    }

    const payload = { item: (rpcResult as { item: unknown }).item };
    await recordIdempotentResponse(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "dialer_batch_item_patch",
      idempotencyKey,
      payload,
    });

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_patch_dialer_batch_item" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
