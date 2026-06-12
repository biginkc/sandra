import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID } from "@tests/integration/fixtures/multi-user";

import {
  authHeaders,
  jsonRequest,
  resetCloserIntegration,
  seedLead,
} from "../../../_lib/test-helpers.integration";
import { PUT } from "./route";

const testClient = createTestClient();

function attemptContext(attemptId: string) {
  return { params: Promise.resolve({ attemptId }) };
}

function requestUrl(attemptId: string) {
  return `https://sandra.test/api/internal/closer/practice-outcomes/by-closer-attempt/${attemptId}`;
}

function outcomeBody(overrides: Record<string, unknown> = {}) {
  return {
    org_id: BMH_ORG_ID,
    role_play_id: "rp-closer-test",
    role_play_title: "Closer Lab Test Role Play",
    status: "ready",
    score: 92,
    duration_seconds: 84,
    completed_at: "2026-06-02T12:14:00.000Z",
    recording_url: "/recordings/attempt-closer-test",
    ...overrides,
  };
}

describe("internal.closer.practice-outcomes writeback PUT", () => {
  beforeEach(async () => {
    await resetCloserIntegration(testClient);
  });

  it("returns 401 without Authorization header", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      new Request(requestUrl(attemptId), {
        method: "PUT",
        headers: { "idempotency-key": "closer-no-auth" },
        body: "{}",
      }),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with mismatched HMAC signature", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const raw = JSON.stringify(outcomeBody());
    const response = await PUT(
      new Request(requestUrl(attemptId), {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...authHeaders(raw, {
            "x-sandra-signature": "sha256=bad",
            "idempotency-key": "closer-bad-hmac",
          }),
        },
        body: raw,
      }),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 when Idempotency-Key is missing", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(requestUrl(attemptId), "PUT", outcomeBody()),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("returns 400 when the signed body is not a valid JSON object", async () => {
    const invalidBodies = ["{not json", "null", "[]"];

    for (const raw of invalidBodies) {
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const response = await PUT(
        new Request(requestUrl(attemptId), {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...authHeaders(raw, { "idempotency-key": `closer-bad-json-${attemptId}` }),
          },
          body: raw,
        }),
        attemptContext(attemptId),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error_code: "invalid_json",
      });
    }
  });

  it("returns 422 for invalid linked-field, score, duration, and timestamp values", async () => {
    const invalidCases = [
      { body: { property_id: 123 }, field: "property_id", error_code: "invalid_type" },
      { body: { score: 101 }, field: "score", error_code: "invalid_score" },
      { body: { score: 50.5 }, field: "score", error_code: "invalid_score" },
      {
        body: { duration_seconds: -1 },
        field: "duration_seconds",
        error_code: "invalid_duration",
      },
      {
        body: { duration_seconds: "84" },
        field: "duration_seconds",
        error_code: "invalid_duration",
      },
      {
        body: { completed_at: "not-a-date" },
        field: "completed_at",
        error_code: "invalid_timestamp",
      },
    ];

    for (const invalid of invalidCases) {
      const attemptId = `attempt-${crypto.randomUUID()}`;
      const response = await PUT(
        jsonRequest(requestUrl(attemptId), "PUT", outcomeBody(invalid.body), {
          "idempotency-key": `closer-invalid-${invalid.error_code}`,
        }),
        attemptContext(attemptId),
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error_code: invalid.error_code,
        field: invalid.field,
      });
    }
  });

  it("returns 422 when the signed consumer org does not match payload org", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        requestUrl(attemptId),
        "PUT",
        outcomeBody({ org_id: TEST_ORG_B_ID }),
        { "idempotency-key": "closer-consumer-org-mismatch" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "org_mismatch",
      field: "org_id",
    });
  });

  it("inserts an org-scoped practice outcome without property/contact linkage", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(requestUrl(attemptId), "PUT", outcomeBody(), {
        "idempotency-key": "closer-insert-org",
      }),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.practice_outcome).toMatchObject({
      closer_attempt_id: attemptId,
      org_id: BMH_ORG_ID,
      property_id: null,
      contact_id: null,
      status: "ready",
      score: 92,
    });
  });

  it("accepts optional Sandra property/contact linkage when orgs match", async () => {
    const lead = await seedLead(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const response = await PUT(
      jsonRequest(
        requestUrl(attemptId),
        "PUT",
        outcomeBody({
          property_id: lead.propertyId,
          contact_id: lead.contactId,
        }),
        { "idempotency-key": "closer-insert-linked" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.practice_outcome).toMatchObject({
      closer_attempt_id: attemptId,
      property_id: lead.propertyId,
      contact_id: lead.contactId,
    });
  });

  it("dedupes via Idempotency-Key and returns the cached body", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const first = await PUT(
      jsonRequest(requestUrl(attemptId), "PUT", outcomeBody(), {
        "idempotency-key": "closer-replay",
      }),
      attemptContext(attemptId),
    );
    const retry = await PUT(
      jsonRequest(requestUrl(attemptId), "PUT", outcomeBody(), {
        "idempotency-key": "closer-replay",
      }),
      attemptContext(attemptId),
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toStrictEqual(await first.json());
  });

  it("returns 409 when the same Idempotency-Key is still pending", async () => {
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const idempotencyKey = "closer-replay-pending";
    const { error } = await testClient.from("webhook_events").insert({
      provider: "closer_lab",
      event_type: "closer_practice_outcome",
      external_id: idempotencyKey,
      signature_verified: true,
      processing_status: "pending",
      payload: { request: true },
    });
    if (error) throw error;

    const response = await PUT(
      jsonRequest(requestUrl(attemptId), "PUT", outcomeBody(), {
        "idempotency-key": idempotencyKey,
      }),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "idempotency_in_progress",
    });
  });

  it("returns 422 when property/contact org mismatches the payload org", async () => {
    const lead = await seedLead(testClient);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    const { data: otherContact, error: otherContactError } = await testClient
      .from("contacts")
      .insert({
        org_id: TEST_ORG_B_ID,
        first_name: "Closer",
        last_name: "Other Org",
        phone_1: `+1816888${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
        phone_1_type: "mobile",
      })
      .select("id")
      .single();
    if (otherContactError || !otherContact) throw otherContactError;
    const { data: otherProperty, error: otherPropertyError } = await testClient
      .from("properties")
      .insert({
        org_id: TEST_ORG_B_ID,
        address: `Closer Other Org ${crypto.randomUUID()}`,
        state: "MO",
        status: "prospect",
        homeowner_contact_id: otherContact.id,
      })
      .select("id")
      .single();
    if (otherPropertyError || !otherProperty) throw otherPropertyError;

    const response = await PUT(
      jsonRequest(
        requestUrl(attemptId),
        "PUT",
        outcomeBody({
          property_id: otherProperty.id,
          contact_id: lead.contactId,
        }),
        { "idempotency-key": "closer-org-mismatch" },
      ),
      attemptContext(attemptId),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "org_mismatch",
      field: "property_id",
    });
  });
});
