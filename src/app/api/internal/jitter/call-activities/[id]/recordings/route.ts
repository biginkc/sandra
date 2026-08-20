import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

const VALID_STATUS = new Set(["pending", "available", "failed"]);

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
      storage_path?: string | null;
      duration_seconds?: number | null;
      error_code?: string | null;
      error_message?: string | null;
    };

    if (!body.status || !VALID_STATUS.has(body.status)) {
      return NextResponse.json(
        { error: "validation_error", field: "status" },
        { status: 422 },
      );
    }

    const { data: activity, error: activityError } = await (auth.serviceClient as any)
      .from("call_activities")
      .select("id")
      .eq("id", id)
      .eq("org_id", auth.orgId)
      .maybeSingle();
    if (activityError) throw activityError;
    if (!activity) {
      return NextResponse.json(
        { error: "validation_error", field: "call_activity_id" },
        { status: 422 },
      );
    }

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "call_recording_writeback",
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

    const { data: payload, error: mutationError } = await (auth.serviceClient as any).rpc(
      "jitter_upsert_call_recording",
      {
        p_call_activity_id: id,
        p_org_id: auth.orgId,
        p_status: body.status,
        p_storage_path: body.storage_path ?? null,
        p_duration_seconds: body.duration_seconds ?? null,
        p_error_code: body.error_code ?? null,
        p_error_message: body.error_message ?? null,
        p_external_id: idempotencyKey,
        p_request_hash: idempotency.requestHash,
      },
    );
    if (mutationError) throw mutationError;

    if ((payload as { outcome?: string } | null)?.outcome === "not_found") {
      return NextResponse.json(
        { error: "validation_error", field: "call_activity_id" },
        { status: 422 },
      );
    }

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_call_recording_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
