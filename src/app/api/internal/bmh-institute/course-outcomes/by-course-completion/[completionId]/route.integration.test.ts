import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  jsonRequest,
  resetInstituteIntegration,
} from "../../../_lib/test-helpers.integration";
import { PUT } from "./route";

const testClient = createTestClient();

function completionContext(completionId: string) {
  return { params: Promise.resolve({ completionId }) };
}

function requestUrl(completionId: string) {
  return `https://sandra.test/api/internal/bmh-institute/course-outcomes/by-course-completion/${completionId}`;
}

function outcomeBody(overrides: Record<string, unknown> = {}) {
  return {
    org_id: BMH_ORG_ID,
    institute_user_id: "institute-user-1",
    learner_email: "learner@example.test",
    learner_name: "Learner Example",
    course_id: "course-bmh-v1",
    course_title: "BMH V1 Training",
    status: "completed",
    completed_at: "2026-06-02T14:14:00.000Z",
    certificate_number: "BMH-C-2026-0001",
    certificate_url: "https://bmh-institute.test/certificates/cert-1",
    ...overrides,
  };
}

describe("internal.bmh-institute.course-outcomes writeback PUT", () => {
  beforeEach(async () => {
    await resetInstituteIntegration(testClient);
  });

  it("returns 401 without Authorization header", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const response = await PUT(
      new Request(requestUrl(completionId), {
        method: "PUT",
        headers: { "idempotency-key": "institute-no-auth" },
        body: "{}",
      }),
      completionContext(completionId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const raw = JSON.stringify(outcomeBody());
    const response = await PUT(
      new Request(requestUrl(completionId), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...authHeaders(raw, {
            "x-sandra-signature": "sha256=bad",
            "idempotency-key": "institute-bad-hmac",
          }),
        },
        body: raw,
      }),
      completionContext(completionId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when Idempotency-Key is missing", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(requestUrl(completionId), "PUT", outcomeBody()),
      completionContext(completionId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 400 when the signed body is not a valid JSON object", async () => {
    for (const raw of ["{not json", "null", "[]"]) {
      const completionId = `completion-${crypto.randomUUID()}`;
      const response = await PUT(
        new Request(requestUrl(completionId), {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, {
              "idempotency-key": `institute-bad-json-${completionId}`,
            }),
          },
          body: raw,
        }),
        completionContext(completionId),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error_code: "invalid_json",
      });
    }
  });

  it("returns 422 for required fields and invalid timestamp/status values", async () => {
    const invalidCases = [
      { body: { institute_user_id: "" }, field: "institute_user_id", error_code: "missing_required_field" },
      { body: { course_id: "" }, field: "course_id", error_code: "missing_required_field" },
      { body: { learner_email: 123 }, field: "learner_email", error_code: "invalid_type" },
      { body: { completed_at: "not-a-date" }, field: "completed_at", error_code: "invalid_timestamp" },
      { body: { status: "failed" }, field: "status", error_code: "invalid_status" },
    ];

    for (const invalid of invalidCases) {
      const completionId = `completion-${crypto.randomUUID()}`;
      const response = await PUT(
        jsonRequest(requestUrl(completionId), "PUT", outcomeBody(invalid.body), {
          "idempotency-key": `institute-invalid-${invalid.error_code}-${completionId}`,
        }),
        completionContext(completionId),
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error_code: invalid.error_code,
        field: invalid.field,
      });
    }
  });

  it("returns 422 when the signed consumer org does not match payload org", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        requestUrl(completionId),
        "PUT",
        outcomeBody({ org_id: TEST_ORG_B_ID }),
        { "idempotency-key": "institute-consumer-org-mismatch" },
      ),
      completionContext(completionId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "org_mismatch",
      field: "org_id",
    });
  });

  it("upserts a course completion outcome", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(requestUrl(completionId), "PUT", outcomeBody(), {
        "idempotency-key": "institute-insert-course",
      }),
      completionContext(completionId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.course_outcome).toMatchObject({
      org_id: BMH_ORG_ID,
      institute_user_id: "institute-user-1",
      course_id: "course-bmh-v1",
      status: "completed",
    });
  });

  it("dedupes via Idempotency-Key and returns the cached body", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const first = await PUT(
      jsonRequest(requestUrl(completionId), "PUT", outcomeBody(), {
        "idempotency-key": "institute-replay",
      }),
      completionContext(completionId),
    );
    const retry = await PUT(
      jsonRequest(requestUrl(completionId), "PUT", outcomeBody(), {
        "idempotency-key": "institute-replay",
      }),
      completionContext(completionId),
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toStrictEqual(await first.json());
  });

  it("returns 409 when the same Idempotency-Key is still pending", async () => {
    const completionId = `completion-${crypto.randomUUID()}`;
    const idempotencyKey = "institute-replay-pending";
    const { error } = await testClient.from("webhook_events").insert({
      provider: "bmh_institute",
      event_type: "course_completed",
      external_id: idempotencyKey,
      signature_verified: true,
      processing_status: "pending",
      payload: { request: true },
    });
    if (error) throw error;

    const response = await PUT(
      jsonRequest(requestUrl(completionId), "PUT", outcomeBody(), {
        "idempotency-key": idempotencyKey,
      }),
      completionContext(completionId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_in_progress",
    });
  });
});
