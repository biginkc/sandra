import { NextResponse } from "next/server";

import { reportError } from "@/lib/errors/report";

import {
  authenticateInstituteCourse,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../../_lib/auth";

type RouteContext = { params: Promise<{ completionId: string }> };

type CourseOutcomeBody = {
  org_id?: string;
  institute_user_id?: string;
  learner_email?: string | null;
  learner_name?: string | null;
  course_id?: string;
  course_title?: string | null;
  status?: string | null;
  completed_at?: string | null;
  certificate_number?: string | null;
  certificate_url?: string | null;
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

function parseBody(rawBody: string): CourseOutcomeBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as CourseOutcomeBody;
}

function normalizeTimestamp(value: string | null | undefined): {
  ok: true;
  value: string;
} | {
  ok: false;
} {
  if (!value) return { ok: false };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date.toISOString() };
}

function invalidOptionalString(value: unknown) {
  return value !== null && value !== undefined && typeof value !== "string";
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const missingKey = requireIdempotencyKey(request);
  if (missingKey) return missingKey;

  try {
    const auth = await authenticateInstituteCourse(request);
    if (!auth.ok) return auth.response;

    const { completionId } = await context.params;
    const idempotencyKey = request.headers.get("idempotency-key")!.trim();
    const body = parseBody(auth.rawBody);
    if (!body) {
      return badRequest("invalid_json");
    }

    if (body.org_id !== auth.orgId) return unprocessable("org_mismatch", "org_id");
    if (!requiredString(body.institute_user_id)) {
      return unprocessable("missing_required_field", "institute_user_id");
    }
    if (!requiredString(body.course_id)) {
      return unprocessable("missing_required_field", "course_id");
    }
    const instituteUserId = body.institute_user_id.trim();
    const courseId = body.course_id.trim();
    if (invalidOptionalString(body.learner_email)) return unprocessable("invalid_type", "learner_email");
    if (invalidOptionalString(body.learner_name)) return unprocessable("invalid_type", "learner_name");
    if (invalidOptionalString(body.course_title)) return unprocessable("invalid_type", "course_title");
    if (invalidOptionalString(body.completed_at)) return unprocessable("invalid_type", "completed_at");
    if (invalidOptionalString(body.certificate_number)) return unprocessable("invalid_type", "certificate_number");
    if (invalidOptionalString(body.certificate_url)) return unprocessable("invalid_type", "certificate_url");
    if (body.status && body.status !== "completed") {
      return unprocessable("invalid_status", "status");
    }
    const completedAt = normalizeTimestamp(body.completed_at);
    if (!completedAt.ok) return unprocessable("invalid_timestamp", "completed_at");

    const idempotency = await checkAndRecordIdempotency(auth.serviceClient, {
      eventType: "course_completed",
      idempotencyKey,
      payload: { completion_id: completionId, ...body },
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
      .from("institute_course_outcomes")
      .upsert(
        {
          org_id: body.org_id,
          institute_user_id: instituteUserId,
          learner_email: body.learner_email ?? null,
          learner_name: body.learner_name ?? null,
          course_id: courseId,
          course_title: body.course_title ?? null,
          status: "completed",
          completed_at: completedAt.value,
          certificate_number: body.certificate_number ?? null,
          certificate_url: body.certificate_url ?? null,
          raw_payload: { completion_id: completionId, ...body },
        },
        { onConflict: "org_id,institute_user_id,course_id" },
      )
      .select("id, org_id, institute_user_id, course_id, status, completed_at")
      .single();

    if (error) throw error;

    const payload = { course_outcome: outcome };
    await recordIdempotentResponse(auth.serviceClient, {
      eventType: "course_completed",
      idempotencyKey,
      payload,
    });

    return NextResponse.json(payload);
  } catch (e) {
    reportError(e, { tags: { surface: "bmh_institute_course_writeback" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
