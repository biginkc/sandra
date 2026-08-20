import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

const VALID_STATUSES = new Set(["completed", "completed_with_pending_outcomes"]);

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
    const body = JSON.parse(auth.rawBody || "{}") as {
      status?: string;
      jitter_session_id?: unknown;
      claim_generation?: number;
    };

    if (!body.status || !VALID_STATUSES.has(body.status)) {
      return NextResponse.json(
        { error: "validation_error", field: "status" },
        { status: 422 },
      );
    }

    const jitterSessionId =
      typeof body.jitter_session_id === "string"
        ? body.jitter_session_id.trim()
        : undefined;
    if (!jitterSessionId) {
      return NextResponse.json(
        { error: "validation_error", field: "jitter_session_id" },
        { status: 422 },
      );
    }

    if (
      !Number.isSafeInteger(body.claim_generation) ||
      (body.claim_generation as number) < 1
    ) {
      return NextResponse.json(
        { error: "validation_error", field: "claim_generation" },
        { status: 422 },
      );
    }

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "dialer_batch_complete",
      resourceId: id,
      idempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return NextResponse.json(idempotency.cachedPayload);
    }
    if (idempotency.state === "conflict") {
      return NextResponse.json(
        { error: "conflict", error_code: "idempotency_key_reused" },
        { status: 409 },
      );
    }

    const { data: completeResult, error: completeError } = await (
      auth.serviceClient as any
    ).rpc("jitter_complete_dialer_batch", {
      p_batch_id: id,
      p_org_id: auth.orgId,
      p_session_id: jitterSessionId,
      p_claim_generation: body.claim_generation,
      p_status: body.status,
      p_external_id: idempotencyKey,
      p_request_hash: idempotency.requestHash,
    });
    if (completeError) throw completeError;

    const outcome = (completeResult as { outcome?: string } | null)?.outcome;
    if (outcome === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (outcome === "stale_claim") {
      return NextResponse.json(
        { error: "conflict", error_code: "stale_claim" },
        { status: 409 },
      );
    }

    const payload = {
      batch: (completeResult as { batch: unknown }).batch,
    };
    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_complete_dialer_batch" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
