import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../_lib/auth";
import { responseForWritebackPayload } from "../../../_lib/writeback-response";

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
  notes?: string | null;
  recording_path?: string | null;
};

type ValidatedWriteback = {
  property: {
    id: string;
    org_id: string;
    address: string | null;
  };
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OUTCOMES = new Set([
  "connected_human",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "canceled",
  "unknown",
]);

const UUID_FIELDS = [
  "org_id",
  "property_id",
  "contact_id",
  "dialer_batch_item_id",
  "operator_user_id",
  "callback_assignee_id",
] as const;
const TIMESTAMP_FIELDS = ["started_at", "ended_at", "callback_at"] as const;
const NOTES_MAX_LENGTH = 10000;
const RECORDING_PATH_MAX_LENGTH = 2048;
const JITTER_SESSION_ID_MAX_LENGTH = 512;
const POSTGRES_INT4_MAX = 2_147_483_647;

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
  if (
    (!body.org_id || !body.property_id || !body.contact_id) &&
    !body.dialer_batch_item_id
  ) {
    return {
      ok: false as const,
      response: unprocessable("missing_required_field"),
    };
  }

  if (
    body.dialer_batch_item_id &&
    (!body.org_id || !body.property_id || !body.contact_id)
  ) {
    const { data: item, error: itemError } = await serviceClient
      .from("dialer_batch_items")
      .select(
        `
        id,
        property_id,
        contact_id,
        batch:dialer_batches!dialer_batch_items_batch_id_fkey(org_id)
      `,
      )
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
    return {
      ok: false as const,
      response: unprocessable("missing_required_field"),
    };
  }

  const { data: property, error: propertyError } = await serviceClient
    .from("properties")
    .select("id, org_id, address, deleted_at")
    .eq("id", body.property_id)
    .maybeSingle();
  if (propertyError) throw propertyError;
  if (!property || property.deleted_at) {
    return {
      ok: false as const,
      response: unprocessable("property_deleted", "property_id"),
    };
  }
  if (property.org_id !== body.org_id) {
    return {
      ok: false as const,
      response: unprocessable("org_mismatch", "property_id"),
    };
  }

  const { data: contact, error: contactError } = await serviceClient
    .from("contacts")
    .select("id, org_id")
    .eq("id", body.contact_id)
    .maybeSingle();
  if (contactError) throw contactError;
  if (!contact || contact.org_id !== body.org_id) {
    return {
      ok: false as const,
      response: unprocessable("org_mismatch", "contact_id"),
    };
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

  return { ok: true as const, property } satisfies {
    ok: true;
    property: ValidatedWriteback["property"];
  };
}

function validTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function validatePayloadSyntax(body: WritebackBody): NextResponse | null {
  if (
    typeof body.jitter_session_id !== "string" ||
    body.jitter_session_id.trim() === "" ||
    body.jitter_session_id.length > JITTER_SESSION_ID_MAX_LENGTH
  ) {
    return unprocessable("invalid_jitter_session_id", "jitter_session_id");
  }
  body.jitter_session_id = body.jitter_session_id.trim();

  for (const field of UUID_FIELDS) {
    const value = body[field];
    if (
      value !== undefined &&
      value !== null &&
      value !== "" &&
      (typeof value !== "string" || !UUID_PATTERN.test(value))
    ) {
      return unprocessable("invalid_uuid", field);
    }
  }

  if (
    body.duration_seconds !== undefined &&
    body.duration_seconds !== null &&
    (typeof body.duration_seconds !== "number" ||
      !Number.isSafeInteger(body.duration_seconds) ||
      body.duration_seconds < 0 ||
      body.duration_seconds > POSTGRES_INT4_MAX)
  ) {
    return unprocessable("invalid_duration", "duration_seconds");
  }

  if (
    body.do_not_call_requested !== undefined &&
    typeof body.do_not_call_requested !== "boolean"
  ) {
    return unprocessable("invalid_boolean", "do_not_call_requested");
  }

  if (
    body.outcome !== undefined &&
    body.outcome !== null &&
    body.outcome !== "" &&
    (typeof body.outcome !== "string" || !VALID_OUTCOMES.has(body.outcome))
  ) {
    return unprocessable("invalid_outcome", "outcome");
  }

  for (const field of TIMESTAMP_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string")
      return unprocessable("invalid_timestamp", field);
    const normalized = validTimestamp(value);
    if (!normalized) return unprocessable("invalid_timestamp", field);
    body[field] = normalized;
  }

  if (
    body.notes !== undefined &&
    body.notes !== null &&
    (typeof body.notes !== "string" || body.notes.length > NOTES_MAX_LENGTH)
  ) {
    return unprocessable("invalid_notes", "notes");
  }

  if (
    body.recording_path !== undefined &&
    body.recording_path !== null &&
    (typeof body.recording_path !== "string" ||
      body.recording_path.length > RECORDING_PATH_MAX_LENGTH)
  ) {
    return unprocessable("invalid_recording_path", "recording_path");
  }

  return null;
}

async function resolveCallbackAssignee(
  serviceClient: any,
  body: WritebackBody,
): Promise<string | null> {
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
    const parsedBody: unknown = JSON.parse(auth.rawBody || "{}");
    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    ) {
      return unprocessable("invalid_body");
    }
    const body = parsedBody as WritebackBody;

    const initialPayloadValidation = validatePayloadSyntax(body);
    if (initialPayloadValidation) return initialPayloadValidation;

    const validation = await validateOrgConsistency(
      auth.serviceClient as any,
      body,
    );
    if (!validation.ok) return validation.response;

    // validateOrgConsistency may derive the three tenant ids from a batch
    // item. Re-run syntax validation so those values are also proven safe
    // before the idempotency reservation below.
    const derivedPayloadValidation = validatePayloadSyntax(body);
    if (derivedPayloadValidation) return derivedPayloadValidation;

    if (body.provider !== "jitter") {
      return unprocessable("provider_mismatch", "provider");
    }
    const effectiveIdempotencyKey = `${body.jitter_session_id!.length}:${body.jitter_session_id}:${idempotencyKey}`;

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
      callbackAssigneeId = await resolveCallbackAssignee(
        auth.serviceClient as any,
        body,
      );
      if (!callbackAssigneeId) {
        return unprocessable(
          "callback_assignee_required",
          "callback_assignee_id",
        );
      }
    }

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
      eventType: "call_activity_writeback",
      resourceId: attemptId,
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

    const { data: payload, error: mutationError } = await (
      auth.serviceClient as any
    ).rpc("jitter_writeback_call_activity", {
      p_attempt_id: attemptId,
      p_body: body,
      p_callback_assignee_id: callbackAssigneeId,
      p_external_id: effectiveIdempotencyKey,
      p_notes: body.notes ?? null,
      p_org_id: auth.orgId,
      p_recording_path: body.recording_path ?? null,
      p_request_hash: idempotency.requestHash,
    });
    if (mutationError) throw mutationError;

    if ((payload as { outcome?: string } | null)?.outcome === "not_found") {
      return NextResponse.json(
        { error: "validation_error", field: "call_activity_id" },
        { status: 422 },
      );
    }
    return responseForWritebackPayload(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_call_activity_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
