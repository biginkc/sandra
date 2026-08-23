import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../../_lib/auth";
import { parseTranscriptWritebackBody } from "../../../../_lib/artifact-writeback-payload";

type RouteContext = { params: Promise<{ attemptId: string }> };

function parentNotFound() {
  return NextResponse.json(
    { error: "not_found", error_code: "call_activity_not_found" },
    { status: 404 },
  );
}

function requireScopeId(request: Request): string | NextResponse {
  const scopeId = new URL(request.url).searchParams.get("scopeId")?.trim();
  if (!scopeId) {
    return NextResponse.json(
      {
        error: "validation_error",
        error_code: "scope_id_required",
        field: "scopeId",
      },
      { status: 400 },
    );
  }
  return scopeId;
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

    const scopeId = requireScopeId(request);
    if (scopeId instanceof NextResponse) return scopeId;

    const { attemptId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")!.trim();
    const parsedBody = parseTranscriptWritebackBody(auth.rawBody);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: "validation_error", field: parsedBody.field },
        { status: 422 },
      );
    }
    const body = parsedBody.body;

    const { data: activity, error: activityError } = await auth.serviceClient
      .from("call_activities")
      .select("id")
      .eq("org_id", auth.orgId)
      .eq("provider", "jitter")
      .eq("jitter_session_id", scopeId)
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
