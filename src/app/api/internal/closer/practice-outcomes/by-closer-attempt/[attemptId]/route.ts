import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateCloserPractice,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ attemptId: string }> };

type PracticeOutcomeBody = {
  org_id?: string;
  property_id?: string | null;
  contact_id?: string | null;
  closer_user_id?: string | null;
  learner_email?: string | null;
  role_play_id?: string | null;
  role_play_title?: string | null;
  status?: string | null;
  score?: number | null;
  duration_seconds?: number | null;
  completed_at?: string | null;
  recording_url?: string | null;
};

function unprocessable(error_code: string, field?: string) {
  return NextResponse.json(
    { error: "validation_error", error_code, ...(field ? { field } : {}) },
    { status: 422 },
  );
}

function badRequest(error_code: string) {
  return NextResponse.json({ error: "bad_request", error_code }, { status: 400 });
}

function parseBody(rawBody: string): PracticeOutcomeBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as PracticeOutcomeBody;
}

function normalizeTimestamp(value: string | null | undefined): {
  ok: true;
  value: string | null;
} | {
  ok: false;
} {
  if (!value) return { ok: true, value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date.toISOString() };
}

function invalidOptionalString(value: unknown) {
  return value !== null && value !== undefined && typeof value !== "string";
}

async function validateOrgConsistency(serviceClient: any, body: PracticeOutcomeBody) {
  if (!body.org_id) {
    return { ok: false as const, response: unprocessable("missing_required_field", "org_id") };
  }

  const { data: org, error: orgError } = await serviceClient
    .from("organizations")
    .select("id")
    .eq("id", body.org_id)
    .maybeSingle();
  if (orgError) throw orgError;
  if (!org?.id) {
    return { ok: false as const, response: unprocessable("org_mismatch", "org_id") };
  }

  if (body.property_id) {
    const { data: property, error: propertyError } = await serviceClient
      .from("properties")
      .select("id, org_id, deleted_at")
      .eq("id", body.property_id)
      .maybeSingle();
    if (propertyError) throw propertyError;
    if (!property || property.deleted_at || property.org_id !== body.org_id) {
      return { ok: false as const, response: unprocessable("org_mismatch", "property_id") };
    }
  }

  if (body.contact_id) {
    const { data: contact, error: contactError } = await serviceClient
      .from("contacts")
      .select("id, org_id")
      .eq("id", body.contact_id)
      .maybeSingle();
    if (contactError) throw contactError;
    if (!contact || contact.org_id !== body.org_id) {
      return { ok: false as const, response: unprocessable("org_mismatch", "contact_id") };
    }
  }

  return { ok: true as const };
}

function validStatus(value: string | null | undefined) {
  if (!value) return "ready";
  if (value === "ready" || value === "failed" || value === "completed") return value;
  return null;
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const missingKey = requireIdempotencyKey(request);
  if (missingKey) return missingKey;

  try {
    const auth = await authenticateCloserPractice(request);
    if (!auth.ok) return auth.response;

    const { attemptId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")!.trim();
    const body = parseBody(auth.rawBody);
    if (!body) {
      return badRequest("invalid_json");
    }

    if (body.org_id !== auth.orgId) return unprocessable("org_mismatch", "org_id");
    if (invalidOptionalString(body.property_id)) return unprocessable("invalid_type", "property_id");
    if (invalidOptionalString(body.contact_id)) return unprocessable("invalid_type", "contact_id");
    if (invalidOptionalString(body.closer_user_id)) return unprocessable("invalid_type", "closer_user_id");
    if (invalidOptionalString(body.learner_email)) return unprocessable("invalid_type", "learner_email");
    if (invalidOptionalString(body.role_play_id)) return unprocessable("invalid_type", "role_play_id");
    if (invalidOptionalString(body.role_play_title)) return unprocessable("invalid_type", "role_play_title");
    if (invalidOptionalString(body.completed_at)) return unprocessable("invalid_type", "completed_at");
    if (invalidOptionalString(body.recording_url)) return unprocessable("invalid_type", "recording_url");

    const status = validStatus(body.status);
    if (!status) return unprocessable("invalid_status", "status");
    if (
      body.score !== null &&
      body.score !== undefined &&
      (!Number.isInteger(body.score) || body.score < 0 || body.score > 100)
    ) {
      return unprocessable("invalid_score", "score");
    }
    if (
      body.duration_seconds !== null &&
      body.duration_seconds !== undefined &&
      (!Number.isInteger(body.duration_seconds) || body.duration_seconds < 0)
    ) {
      return unprocessable("invalid_duration", "duration_seconds");
    }
    const completedAt = normalizeTimestamp(body.completed_at);
    if (!completedAt.ok) return unprocessable("invalid_timestamp", "completed_at");

    const validation = await validateOrgConsistency(auth.serviceClient as any, body);
    if (!validation.ok) return validation.response;

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      eventType: "closer_practice_outcome",
      idempotencyKey,
      payload: body,
    });
    if (idempotency.state === "cached") {
      return NextResponse.json(idempotency.cachedPayload);
    }
    if (idempotency.state === "in_progress") {
      return NextResponse.json(
        { error: "conflict", error_code: "idempotency_in_progress" },
        { status: 409 },
      );
    }

    const { data: outcome, error } = await (auth.serviceClient as any)
      .from("closer_practice_outcomes")
      .upsert(
        {
          org_id: body.org_id,
          property_id: body.property_id ?? null,
          contact_id: body.contact_id ?? null,
          closer_attempt_id: attemptId,
          closer_user_id: body.closer_user_id ?? null,
          learner_email: body.learner_email ?? null,
          role_play_id: body.role_play_id ?? null,
          role_play_title: body.role_play_title ?? null,
          status,
          score: body.score ?? null,
          duration_seconds: body.duration_seconds ?? null,
          completed_at: completedAt.value,
          recording_url: body.recording_url ?? null,
          raw_payload: body,
        },
        { onConflict: "org_id,closer_attempt_id" },
      )
      .select("id, org_id, property_id, contact_id, closer_attempt_id, status, score")
      .single();

    if (error) throw error;

    const payload = { practice_outcome: outcome };
    await recordIdempotentResponse(auth.serviceClient, {
      eventType: "closer_practice_outcome",
      idempotencyKey,
      payload,
    });

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "closer_practice_outcome_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
