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
    const body = JSON.parse(auth.rawBody || "{}") as { status?: string };
    if (!body.status || !VALID_STATUSES.has(body.status)) {
      return NextResponse.json(
        { error: "validation_error", field: "status" },
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

    const { data: item, error } = await (auth.serviceClient as any)
      .from("dialer_batch_items")
      .update({ status: body.status })
      .eq("id", id)
      .select("id, batch_id, property_id, contact_id, phone_e164, status")
      .single();

    if (error) throw error;

    const payload = { item };
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
