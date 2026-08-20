import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
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
  callback_at?: string | null;
  callback_assignee_id?: string | null;
  do_not_call_requested?: boolean;
  provider?: string;
  provider_call_id?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

type ValidatedWriteback = {
  property: {
    id: string;
    org_id: string;
    address: string | null;
  };
};

function unprocessable(error_code: string, field?: string) {
  return NextResponse.json(
    { error: "validation_error", error_code, ...(field ? { field } : {}) },
    { status: 422 },
  );
}

function forbidden(error_code: string) {
  return NextResponse.json({ error: "forbidden", error_code }, { status: 403 });
}

async function validateOrgConsistency(serviceClient: any, body: WritebackBody) {
  if ((!body.org_id || !body.property_id || !body.contact_id) && !body.dialer_batch_item_id) {
    return { ok: false as const, response: unprocessable("missing_required_field") };
  }

  if (body.dialer_batch_item_id && (!body.org_id || !body.property_id || !body.contact_id)) {
    const { data: item, error: itemError } = await serviceClient
      .from("dialer_batch_items")
      .select(`
        id,
        property_id,
        contact_id,
        batch:dialer_batches!dialer_batch_items_batch_id_fkey(org_id)
      `)
      .eq("id", body.dialer_batch_item_id)
      .maybeSingle();
    if (itemError) throw itemError;
    const batch = Array.isArray(item?.batch) ? item.batch[0] : item?.batch;
    if (!item || !batch?.org_id || !item.property_id || !item.contact_id) {
      return {
        ok: false as const,
        response: unprocessable("org_mismatch", "dialer_batch_item_id"),
      };
    }

    body.org_id ??= batch.org_id;
    body.property_id ??= item.property_id;
    body.contact_id ??= item.contact_id;
  }

  if (!body.org_id || !body.property_id || !body.contact_id) {
    return { ok: false as const, response: unprocessable("missing_required_field") };
  }

  const { data: property, error: propertyError } = await serviceClient
    .from("properties")
    .select("id, org_id, address, deleted_at")
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

  return { ok: true as const, property } satisfies { ok: true; property: ValidatedWriteback["property"] };
}

function validTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function resolveCallbackAssignee(serviceClient: any, body: WritebackBody): Promise<string | null> {
  const preferred = body.callback_assignee_id ?? body.operator_user_id ?? null;
  if (preferred && body.org_id) {
    const { data: membership, error } = await serviceClient
      .from("memberships")
      .select("user_id")
      .eq("org_id", body.org_id)
      .eq("user_id", preferred)
      .maybeSingle();
    if (error) throw error;
    if (membership?.user_id) return membership.user_id;
  }

  const { data: fallback, error } = await serviceClient
    .from("memberships")
    .select("user_id")
    .eq("org_id", body.org_id)
    .order("role", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return fallback?.user_id ?? null;
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

    if (body.provider !== "jitter") {
      return unprocessable("provider_mismatch", "provider");
    }

    // Tenant isolation: validateOrgConsistency only proves the body ids are
    // internally consistent with body.org_id — it never compares against the
    // AUTHENTICATED consumer's org. The writes below use the service-role
    // client, so without this check an org-A token could submit org-B ids
    // and mutate org-B rows (call_activities, contacts.do_not_contact,
    // consent_events).
    if (body.org_id !== auth.orgId) {
      return forbidden("org_consumer_mismatch");
    }

    let callbackAssigneeId: string | null = null;
    if (body.disposition === "callback_requested") {
      if (!validTimestamp(body.callback_at)) {
        return unprocessable("callback_at_required", "callback_at");
      }
      callbackAssigneeId = await resolveCallbackAssignee(auth.serviceClient as any, body);
      if (!callbackAssigneeId) {
        return unprocessable("callback_assignee_required", "callback_assignee_id");
      }
    }

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "call_activity_writeback",
      resourceId: attemptId,
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
      "jitter_writeback_call_activity",
      {
        p_attempt_id: attemptId,
        p_body: body,
        p_callback_assignee_id: callbackAssigneeId,
        p_external_id: idempotencyKey,
        p_org_id: auth.orgId,
        p_request_hash: idempotency.requestHash,
      },
    );
    if (mutationError) throw mutationError;

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_call_activity_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
