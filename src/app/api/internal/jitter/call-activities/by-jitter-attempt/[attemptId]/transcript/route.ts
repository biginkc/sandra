import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../../_lib/auth";

type RouteContext = { params: Promise<{ attemptId: string }> };

const VALID_STATUS = new Set(["pending", "available", "failed"]);
const VALID_SUMMARY_STATUS = new Set([
  "none",
  "pending",
  "available",
  "failed",
]);

function parentNotFound() {
  return NextResponse.json(
    { error: "not_found", error_code: "call_activity_not_found" },
    { status: 404 },
  );
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const missingKey = requireIdempotencyKey(request);
  if (missingKey) return missingKey;

  try {
    const auth = await authenticateJitterWriteback(request);
    if (!auth.ok) return auth.response;

    const { attemptId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")!.trim();
    const body = JSON.parse(auth.rawBody || "{}") as {
      status?: string;
      text?: string | null;
      language?: string | null;
      error_code?: string | null;
      error_message?: string | null;
      summary?: string | null;
      summary_status?: string;
      summary_error_code?: string | null;
      summary_error_message?: string | null;
    };

    if (!body.status || !VALID_STATUS.has(body.status)) {
      return NextResponse.json(
        { error: "validation_error", field: "status" },
        { status: 422 },
      );
    }
    if (
      body.summary_status !== undefined &&
      !VALID_SUMMARY_STATUS.has(body.summary_status)
    ) {
      return NextResponse.json(
        { error: "validation_error", field: "summary_status" },
        { status: 422 },
      );
    }

    const { data: activity, error: activityError } = await auth.serviceClient
      .from("call_activities")
      .select("id")
      .eq("org_id", auth.orgId)
      .eq("provider", "jitter")
      .eq("jitter_attempt_id", attemptId)
      .maybeSingle();
    if (activityError) throw activityError;
    if (!activity) return parentNotFound();

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "call_transcript_writeback",
      resourceId: activity.id,
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

    const { data: payload, error: mutationError } =
      await auth.serviceClient.rpc("jitter_upsert_call_transcript", {
        p_call_activity_id: activity.id,
        p_org_id: auth.orgId,
        p_status: body.status,
        p_text: body.text ?? null,
        p_language: body.language ?? null,
        p_error_code: body.error_code ?? null,
        p_error_message: body.error_message ?? null,
        p_summary: body.summary ?? null,
        p_summary_status: body.summary_status ?? "none",
        p_summary_error_code: body.summary_error_code ?? null,
        p_summary_error_message: body.summary_error_message ?? null,
        p_external_id: idempotencyKey,
        p_request_hash: idempotency.requestHash,
      });
    if (mutationError) throw mutationError;

    if ((payload as { outcome?: string } | null)?.outcome === "not_found") {
      return parentNotFound();
    }

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, {
      tags: { surface: "jitter_call_transcript_by_attempt_writeback" },
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
