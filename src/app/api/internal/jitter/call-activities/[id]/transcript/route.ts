import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

const VALID_STATUS = new Set(["pending", "available", "failed"]);

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
    const body = JSON.parse(auth.rawBody || "{}") as {
      status?: string;
      text?: string | null;
      language?: string | null;
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
      idempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return NextResponse.json(idempotency.cachedPayload);
    }

    const row = {
      call_activity_id: id,
      status: body.status,
      text: body.text ?? null,
      language: body.language ?? null,
      error_code: body.error_code ?? null,
      error_message: body.error_message ?? null,
    };

    const { data: existing } = await (auth.serviceClient as any)
      .from("call_transcripts")
      .select("id")
      .eq("call_activity_id", id)
      .maybeSingle();

    const query = existing?.id
      ? (auth.serviceClient as any)
          .from("call_transcripts")
          .update(row)
          .eq("id", existing.id)
      : (auth.serviceClient as any).from("call_transcripts").insert(row);

    const { data: transcript, error } = await query
      .select("id, call_activity_id, status, text, language, error_code, error_message")
      .single();
    if (error) throw error;

    // Parent status + updated_at are handled by bump_call_activities_on_child_change.
    const payload = { transcript };
    await recordIdempotentResponse(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "call_transcript_writeback",
      idempotencyKey,
      payload,
    });

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_call_transcript_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
