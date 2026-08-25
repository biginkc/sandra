import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../../_lib/auth";
import { parseRecordingWritebackBody } from "../../../../_lib/artifact-writeback-payload";
import { callActivityAttemptProviderFilter } from "../../../../_lib/call-activity-lookup";
import { responseForWritebackPayload } from "../../../../_lib/writeback-response";

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

export async function POST(
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
    const parsedBody = parseRecordingWritebackBody(auth.rawBody);
    if (!parsedBody.ok) {
      return NextResponse.json(
        { error: "validation_error", field: parsedBody.field },
        { status: 422 },
      );
    }
    const body = parsedBody.body;
    const effectiveIdempotencyKey = `${scopeId.length}:${scopeId}:${idempotencyKey}`;

    const { data: activity, error: activityError } = await auth.serviceClient
      .from("call_activities")
      .select("id")
      .eq("org_id", auth.orgId)
      .eq("jitter_attempt_id", attemptId)
      .or(callActivityAttemptProviderFilter(scopeId))
      .maybeSingle();
    if (activityError) throw activityError;
    if (!activity) return parentNotFound();

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "call_recording_writeback",
      resourceId: activity.id,
      idempotencyKey: effectiveIdempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return responseForWritebackPayload(idempotency.cachedPayload);
    }
    if (idempotency.state === "conflict") {
      return NextResponse.json(
        { error: "conflict", error_code: "idempotency_key_reused" },
        { status: 409 },
      );
    }

    const { data: payload, error: mutationError } =
      await auth.serviceClient.rpc("jitter_upsert_call_recording", {
        p_call_activity_id: activity.id,
        p_org_id: auth.orgId,
        p_status: body.status,
        p_storage_path: body.storage_path ?? null,
        p_duration_seconds: body.duration_seconds ?? null,
        p_error_code: body.error_code ?? null,
        p_error_message: body.error_message ?? null,
        p_external_id: effectiveIdempotencyKey,
        p_request_hash: idempotency.requestHash,
      });
    if (mutationError) throw mutationError;

    if ((payload as { outcome?: string } | null)?.outcome === "not_found") {
      return parentNotFound();
    }

    return responseForWritebackPayload(payload);
  } catch (e) {
    reportError(e, {
      tags: { surface: "jitter_call_recording_by_attempt_writeback" },
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
