const ARTIFACT_STATUSES = new Set(["pending", "available", "failed"]);
const SUMMARY_STATUSES = new Set(["none", "pending", "available", "failed"]);
const POSTGRES_INT4_MAX = 2_147_483_647;

export type RecordingWritebackBody = {
  status: string;
  storage_path?: string | null;
  duration_seconds?: number | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type TranscriptWritebackBody = {
  status: string;
  text?: string | null;
  language?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  summary?: string | null;
  summary_status?: string;
  summary_error_code?: string | null;
  summary_error_message?: string | null;
};

type Parsed<T> = { ok: true; body: T } | { ok: false; field: string };

function parseObject(rawBody: string): Parsed<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return { ok: false, field: "body" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, field: "body" };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validateNullableStrings(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    if (!isOptionalNullableString(body[field])) return field;
  }
  return null;
}

export function parseRecordingWritebackBody(
  rawBody: string,
): Parsed<RecordingWritebackBody> {
  const parsed = parseObject(rawBody);
  if (!parsed.ok) return parsed;
  const body = parsed.body;

  if (typeof body.status !== "string" || !ARTIFACT_STATUSES.has(body.status)) {
    return { ok: false, field: "status" };
  }
  const invalidString = validateNullableStrings(body, [
    "storage_path",
    "error_code",
    "error_message",
  ]);
  if (invalidString) return { ok: false, field: invalidString };
  if (
    body.duration_seconds !== undefined &&
    body.duration_seconds !== null &&
    (typeof body.duration_seconds !== "number" ||
      !Number.isSafeInteger(body.duration_seconds) ||
      body.duration_seconds < 0 ||
      body.duration_seconds > POSTGRES_INT4_MAX)
  ) {
    return { ok: false, field: "duration_seconds" };
  }

  return { ok: true, body: body as RecordingWritebackBody };
}

export function parseTranscriptWritebackBody(
  rawBody: string,
): Parsed<TranscriptWritebackBody> {
  const parsed = parseObject(rawBody);
  if (!parsed.ok) return parsed;
  const body = parsed.body;

  if (typeof body.status !== "string" || !ARTIFACT_STATUSES.has(body.status)) {
    return { ok: false, field: "status" };
  }
  if (
    body.summary_status !== undefined &&
    (typeof body.summary_status !== "string" ||
      !SUMMARY_STATUSES.has(body.summary_status))
  ) {
    return { ok: false, field: "summary_status" };
  }
  const invalidString = validateNullableStrings(body, [
    "text",
    "language",
    "error_code",
    "error_message",
    "summary",
    "summary_error_code",
    "summary_error_message",
  ]);
  if (invalidString) return { ok: false, field: invalidString };

  return { ok: true, body: body as TranscriptWritebackBody };
}
