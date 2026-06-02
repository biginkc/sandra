import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateInstituteCourse,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "../../../_lib/auth";
import { PUT } from "./route";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

vi.mock("../../../_lib/auth", () => ({
  authenticateInstituteCourse: vi.fn(),
  checkAndRecordIdempotency: vi.fn(),
  recordIdempotentResponse: vi.fn(),
  requireIdempotencyKey: vi.fn(),
}));

const ORG_ID = "00000000-0000-0000-0000-000000000bbb";

const authMock = vi.mocked(authenticateInstituteCourse);
const idempotencyMock = vi.mocked(checkAndRecordIdempotency);
const recordMock = vi.mocked(recordIdempotentResponse);
const missingKeyMock = vi.mocked(requireIdempotencyKey);

function context(completionId: string) {
  return { params: Promise.resolve({ completionId }) };
}

function request(body: unknown) {
  return new Request("https://sandra.test/api/internal/bmh-institute/course-outcomes/by-course-completion/u1%3Ac1", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "bmh-institute-course:u1:c1:completed",
    },
    body: JSON.stringify(body),
  });
}

function serviceClient(outcome: Record<string, unknown> = {}) {
  const single = vi.fn().mockResolvedValue({
    data: {
      id: "outcome-1",
      org_id: ORG_ID,
      institute_user_id: "user-1",
      course_id: "course-1",
      status: "completed",
      completed_at: "2026-06-02T14:00:00.000Z",
      ...outcome,
    },
    error: null,
  });
  const select = vi.fn(() => ({ single }));
  const upsert = vi.fn(() => ({ select }));
  return {
    from: vi.fn(() => ({ upsert })),
    _spies: { upsert },
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    org_id: ORG_ID,
    institute_user_id: "user-1",
    learner_email: "learner@example.test",
    learner_name: "Learner Example",
    course_id: "course-1",
    course_title: "Course 1",
    status: "completed",
    completed_at: "2026-06-02T14:00:00.000Z",
    certificate_number: "BMH-C-2026-0001",
    certificate_url: "/certificates/cert-1",
    ...overrides,
  };
}

describe("BMH Institute course outcome route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    missingKeyMock.mockReturnValue(null);
    idempotencyMock.mockResolvedValue({ state: "fresh", idempotencyKey: "key" });
    recordMock.mockResolvedValue(undefined);
  });

  it("stores a signed course completion outcome", async () => {
    const client = serviceClient();
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as any,
      rawBody: JSON.stringify(body()),
    });

    const response = await PUT(request(body()), context("user-1:course-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      course_outcome: {
        org_id: ORG_ID,
        institute_user_id: "user-1",
        course_id: "course-1",
      },
    });
    expect(client._spies.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ORG_ID,
        institute_user_id: "user-1",
        course_id: "course-1",
        status: "completed",
        certificate_number: "BMH-C-2026-0001",
      }),
      { onConflict: "org_id,institute_user_id,course_id" },
    );
    expect(recordMock).toHaveBeenCalledWith(client, expect.objectContaining({
      eventType: "course_completed",
    }));
  });

  it("rejects an org mismatch before writing", async () => {
    const client = serviceClient();
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as any,
      rawBody: JSON.stringify(body({ org_id: "00000000-0000-0000-0000-000000000ccc" })),
    });

    const response = await PUT(
      request(body({ org_id: "00000000-0000-0000-0000-000000000ccc" })),
      context("user-1:course-1"),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "org_mismatch",
      field: "org_id",
    });
    expect(client._spies.upsert).not.toHaveBeenCalled();
  });

  it("returns cached idempotent responses without upserting again", async () => {
    const client = serviceClient();
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as any,
      rawBody: JSON.stringify(body()),
    });
    idempotencyMock.mockResolvedValue({
      state: "cached",
      cachedPayload: { course_outcome: { id: "cached-outcome" } },
    });

    const response = await PUT(request(body()), context("user-1:course-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      course_outcome: { id: "cached-outcome" },
    });
    expect(client._spies.upsert).not.toHaveBeenCalled();
  });
});
