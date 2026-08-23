import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../_lib/auth";
import { parseTranscriptWritebackBody } from "../../../_lib/artifact-writeback-payload";

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(
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
      eventType: "call_transcript_writeback",
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

    const { data: payload, error: mutationError } =
      await auth.serviceClient.rpc("jitter_upsert_call_transcript", {
        p_call_activity_id: id,
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
      return NextResponse.json(
        { error: "validation_error", field: "call_activity_id" },
        { status: 422 },
      );
    }

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_call_transcript_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
