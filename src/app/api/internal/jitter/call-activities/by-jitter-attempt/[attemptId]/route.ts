import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ attemptId: string }> };

type WritebackBody = {
  org_id?: string;
  property_id?: string;
  contact_id?: string;
  dialer_batch_item_id?: string | null;
  jitter_session_id?: string | null;
  operator_user_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
  outcome?: string | null;
  disposition?: string | null;
  do_not_call_requested?: boolean;
  provider?: string;
  provider_call_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

function unprocessable(error_code: string, field?: string) {
  return NextResponse.json(
    { error: "validation_error", error_code, ...(field ? { field } : {}) },
    { status: 422 },
  );
}

async function validateOrgConsistency(serviceClient: any, body: WritebackBody) {
  if (!body.org_id || !body.property_id || !body.contact_id) {
    return { ok: false as const, response: unprocessable("missing_required_field") };
  }

  const { data: property, error: propertyError } = await serviceClient
    .from("properties")
    .select("id, org_id, deleted_at")
    .eq("id", body.property_id)
    .maybeSingle();
  if (propertyError) throw propertyError;
  if (!property || property.deleted_at) {
    return { ok: false as const, response: unprocessable("property_deleted", "property_id") };
  }
  if (property.org_id !== body.org_id) {
    return { ok: false as const, response: unprocessable("org_mismatch", "property_id") };
  }

  const { data: contact, error: contactError } = await serviceClient
    .from("contacts")
    .select("id, org_id")
    .eq("id", body.contact_id)
    .maybeSingle();
  if (contactError) throw contactError;
  if (!contact || contact.org_id !== body.org_id) {
    return { ok: false as const, response: unprocessable("org_mismatch", "contact_id") };
  }

  if (body.dialer_batch_item_id) {
    const { data: item, error: itemError } = await serviceClient
      .from("dialer_batch_items")
      .select("id, batch_id, property_id, contact_id")
      .eq("id", body.dialer_batch_item_id)
      .maybeSingle();
    if (itemError) throw itemError;
    if (
      !item ||
      item.property_id !== body.property_id ||
      item.contact_id !== body.contact_id
    ) {
      return {
        ok: false as const,
        response: unprocessable("org_mismatch", "dialer_batch_item_id"),
      };
    }

    const { data: batch, error: batchError } = await serviceClient
      .from("dialer_batches")
      .select("id, org_id")
      .eq("id", item.batch_id)
      .maybeSingle();
    if (batchError) throw batchError;
    if (!batch || batch.org_id !== body.org_id) {
      return {
        ok: false as const,
        response: unprocessable("org_mismatch", "dialer_batch_item_id"),
      };
    }
  }

  return { ok: true as const };
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
    const body = JSON.parse(auth.rawBody || "{}") as WritebackBody;

    const validation = await validateOrgConsistency(auth.serviceClient as any, body);
    if (!validation.ok) return validation.response;

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      eventType: "call_activity_writeback",
      idempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return NextResponse.json(idempotency.cachedPayload);
    }

    const provider = body.provider ?? "jitter";
    const { data: activity, error } = await (auth.serviceClient as any)
      .from("call_activities")
      .upsert(
        {
          org_id: body.org_id,
          property_id: body.property_id,
          contact_id: body.contact_id,
          dialer_batch_item_id: body.dialer_batch_item_id ?? null,
          jitter_attempt_id: attemptId,
          jitter_session_id: body.jitter_session_id ?? null,
          operator_user_id: body.operator_user_id ?? null,
          started_at: body.started_at ?? null,
          ended_at: body.ended_at ?? null,
          duration_seconds: body.duration_seconds ?? null,
          outcome: body.outcome ?? "unknown",
          disposition: body.disposition ?? null,
          do_not_call_requested: body.do_not_call_requested ?? false,
          provider,
          provider_call_id: body.provider_call_id ?? null,
          error_code: body.error_code ?? null,
          error_message: body.error_message ?? null,
          raw_event_count: 1,
        },
        { onConflict: "provider,jitter_attempt_id" },
      )
      .select("id, org_id, property_id, contact_id, dialer_batch_item_id, jitter_attempt_id, provider, outcome")
      .single();

    if (error) throw error;

    if (body.dialer_batch_item_id) {
      const { error: itemError } = await (auth.serviceClient as any)
        .from("dialer_batch_items")
        .update({ last_call_activity_id: activity.id })
        .eq("id", body.dialer_batch_item_id);
      if (itemError) throw itemError;
    }

    const payload = { call_activity: activity };
    await recordIdempotentResponse(auth.serviceClient, {
      eventType: "call_activity_writeback",
      idempotencyKey,
      payload,
    });

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_call_activity_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
