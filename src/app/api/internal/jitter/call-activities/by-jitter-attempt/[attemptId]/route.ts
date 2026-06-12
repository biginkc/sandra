import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";
import { recordConsentEvent } from "@/lib/messaging/consent";

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

async function syncCallbackTask(serviceClient: any, body: WritebackBody, validation: ValidatedWriteback) {
  if (body.disposition !== "callback_requested") return null;

  const callbackAt = validTimestamp(body.callback_at);
  if (!callbackAt) {
    return { ok: false as const, response: unprocessable("callback_at_required", "callback_at") };
  }

  const assigneeId = await resolveCallbackAssignee(serviceClient, body);
  if (!assigneeId) {
    return { ok: false as const, response: unprocessable("callback_assignee_required", "callback_assignee_id") };
  }

  const title = `Callback ${validation.property.address ?? "property"}`;
  const now = new Date().toISOString();
  const { error: propertyError } = await serviceClient
    .from("properties")
    .update({
      outreach_dispo: "callback_requested",
      follow_up_at: callbackAt,
      updated_at: now,
    })
    .eq("id", validation.property.id);
  if (propertyError) throw propertyError;

  const { data: existing, error: existingError } = await serviceClient
    .from("tasks")
    .select("id")
    .eq("related_property_id", validation.property.id)
    .eq("type", "callback")
    .eq("status", "open")
    .eq("due_at", callbackAt)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) return { ok: true as const, taskId: existing.id as string };

  const { data: task, error: taskError } = await serviceClient
    .from("tasks")
    .insert({
      org_id: body.org_id,
      assignee_id: assigneeId,
      related_property_id: validation.property.id,
      type: "callback",
      title,
      due_at: callbackAt,
      created_by: assigneeId,
    })
    .select("id")
    .single();
  if (taskError) throw taskError;

  return { ok: true as const, taskId: task?.id as string };
}

async function applyDoNotCallOptOut(
  serviceClient: any,
  body: WritebackBody,
  attemptId: string,
) {
  if (body.do_not_call_requested !== true) return;

  // By this point validateOrgConsistency has resolved contact_id (deriving
  // it from dialer_batch_item_id if needed) or already returned 422.
  const contactId = body.contact_id!;
  const occurredAt = validTimestamp(body.ended_at);

  // Deliberately NOT wrapped in try/catch: recordConsentEvent already
  // handles duplicates internally (externalId pre-lookup + unique-index
  // conflict detection), so any error that escapes it is a real failure.
  // Swallowing it would return 200 — Jitter stops retrying and the contact
  // is flagged with no audit row. Let it throw: the route 500s and Jitter's
  // bounded writeback retry replays this fully replay-safe helper. (The
  // "best-effort audit" precedent in inbound.ts doesn't apply here —
  // inbound SMS senders don't retry; Jitter does.)
  await recordConsentEvent(serviceClient, {
    contactId,
    channel: "voice",
    eventType: "opt_out",
    source: "jitter_writeback",
    sourceDetail: {
      disposition: body.disposition ?? null,
      jitter_session_id: body.jitter_session_id ?? null,
    },
    occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
    // attemptId → source_external_id; the partial unique index on
    // (contact_id, channel, event_type, source, source_external_id)
    // keeps writeback replays from duplicating the audit row.
    idempotencyKey: attemptId,
  });

  // Also enforced: if this fails the route must 500 so Jitter's bounded
  // writeback retry replays the request.
  const { error } = await serviceClient
    .from("contacts")
    .update({ do_not_contact: true })
    .eq("id", contactId);
  if (error) throw error;
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

    // Tenant isolation: validateOrgConsistency only proves the body ids are
    // internally consistent with body.org_id — it never compares against the
    // AUTHENTICATED consumer's org. The writes below use the service-role
    // client, so without this check an org-A token could submit org-B ids
    // and mutate org-B rows (call_activities, contacts.do_not_contact,
    // consent_events).
    if (body.org_id !== auth.orgId) {
      return forbidden("org_consumer_mismatch");
    }

    const callbackTask = await syncCallbackTask(auth.serviceClient as any, body, validation);
    if (callbackTask && !callbackTask.ok) return callbackTask.response;

    // Must run BEFORE checkAndRecordIdempotency: the idempotency record is
    // written before processing, so anything after it that throws would be
    // skipped (cached) on Jitter's retry and never replayed.
    await applyDoNotCallOptOut(auth.serviceClient as any, body, attemptId);

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      orgId: auth.orgId,
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
        // Org-scoped (migration 083): a colliding attemptId from another
        // org inserts its own row instead of overwriting the existing one.
        { onConflict: "org_id,provider,jitter_attempt_id" },
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

    const payload = {
      call_activity: activity,
      ...(callbackTask?.ok ? { callback_task: { id: callbackTask.taskId } } : {}),
    };
    await recordIdempotentResponse(auth.serviceClient, {
      orgId: auth.orgId,
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
