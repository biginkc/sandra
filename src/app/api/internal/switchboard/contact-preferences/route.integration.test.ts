import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  reportError: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  authenticateSwitchboardPreference: mocks.authenticate,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { POST } from "./route";

const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const TOKEN = "switchboard-test-token-000000000001";
const SESSION03_POSITIVE_FIXTURE =
  '{"event_id":"00000000-0000-4000-8000-000000000001","event_source":"provider_call","event_type":"contact_preference.explicit","source_event_id":"elevenlabs-event-001","provider_call_id":"CA00000000000000000000000000000001","intent_marker_id":"analysis:both","conversation_id":"conv-001","provider_timestamp":"2026-08-30T10:00:00.000Z","correlation_id":"corr-001","caller_phone_e164":"+18165550123","property_disposition":"not_interested","global_dnc_requested":true,"manual_review_required":false,"address":{"line1":"123 Main Street","city":"Kansas City","state":"MO","postal_code":"64108"},"intent_evidence":{"category":"explicit_not_interested_and_do_not_contact","intent_marker_id":"analysis:both","evidence_sha256":"be2b9b417a56dbaaaf08901c234c943d4b8f0bc996707d4bdc9f7054cd42e773"}}';
const SESSION03_DECLINE_DNC_FIXTURE =
  '{"event_id":"00000000-0000-4000-8000-000000000002","event_source":"provider_call","event_type":"contact_preference.explicit","source_event_id":"elevenlabs-event-002","provider_call_id":"CA00000000000000000000000000000002","intent_marker_id":"analysis:global_dnc_requested","provider_timestamp":"2026-08-30T10:00:00.000Z","correlation_id":"corr-002","caller_phone_e164":"+18165550124","global_dnc_requested":true,"manual_review_required":false,"intent_evidence":{"category":"explicit_do_not_contact","intent_marker_id":"analysis:global_dnc_requested","evidence_sha256":"16e274070438268a5ae4a420a3b3e9af8df0fcaa885bbedb907b49dc80aa9d4e"}}';

function evidence(
  eventId: string,
  category: string,
  intentMarkerId: string,
) {
  return {
    category,
    intent_marker_id: intentMarkerId,
    evidence_sha256: createHash("sha256")
      .update(
        `switchboard_contact_preference_v1\0${eventId}\0${category}\0${intentMarkerId}`,
        "utf8",
      )
      .digest("hex"),
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "event-1",
    event_source: "provider_call",
    event_type: "contact_preference.explicit",
    source_event_id: "source-event-1",
    provider_call_id: "call-1",
    intent_marker_id: "analysis:property_disposition",
    conversation_id: "conversation-1",
    provider_timestamp: new Date().toISOString(),
    correlation_id: "correlation-1",
    caller_phone_e164: "+18165550123",
    property_disposition: "not_interested",
    global_dnc_requested: false,
    manual_review_required: false,
    address: {
      line1: "123 Main Street",
      city: "Kansas City",
      state: "mo",
      postal_code: "64108",
    },
    intent_evidence: evidence(
      "event-1",
      "explicit_not_interested",
      "analysis:property_disposition",
    ),
    ...overrides,
  };
}

function request(
  value: unknown,
  headers: Record<string, string> = {},
): Request {
  const rawBody = typeof value === "string" ? value : JSON.stringify(value);
  return new Request(
    "https://sandra.test/api/internal/switchboard/contact-preferences",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "event-1",
        authorization: `Bearer ${TOKEN}`,
        "x-sandra-signature": `sha256=${createHmac("sha256", TOKEN)
          .update(rawBody)
          .digest("hex")}`,
        ...headers,
      },
      body: rawBody,
    },
  );
}

describe("POST /api/internal/switchboard/contact-preferences", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: { outcome: "applied" }, error: null });
    mocks.authenticate.mockReset();
    mocks.authenticate.mockImplementation(async (incoming: Request) => ({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      rawBody: await incoming.text(),
      serviceClient: { rpc: mocks.rpc },
    }));
    mocks.reportError.mockReset();
  });

  it("authenticates before returning 400 when Idempotency-Key is absent", async () => {
    const response = await POST(
      request(body(), { "idempotency-key": "" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.authenticate).toHaveBeenCalledOnce();
  });

  it("passes through a generic 401 authentication response", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    });
    const response = await POST(request(body()));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("accepts Session03 canonical serialized fixtures byte-for-byte", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:01:00.000Z"));
    try {
      const positive = await POST(
        request(SESSION03_POSITIVE_FIXTURE, {
          "idempotency-key": "00000000-0000-4000-8000-000000000001",
        }),
      );
      expect(positive.status).toBe(200);
      expect(mocks.rpc).toHaveBeenLastCalledWith(
        "apply_switchboard_contact_preferences",
        expect.objectContaining({
          p_idempotency_key: "00000000-0000-4000-8000-000000000001",
          p_intent_marker_id: "analysis:both",
          p_property_disposition: "not_interested",
          p_global_dnc_requested: true,
        }),
      );

      const decline = await POST(
        request(SESSION03_DECLINE_DNC_FIXTURE, {
          "idempotency-key": "00000000-0000-4000-8000-000000000002",
        }),
      );
      expect(decline.status).toBe(200);
      expect(mocks.rpc).toHaveBeenLastCalledWith(
        "apply_switchboard_contact_preferences",
        expect.objectContaining({
          p_idempotency_key: "00000000-0000-4000-8000-000000000002",
          p_intent_marker_id: "analysis:global_dnc_requested",
          p_property_disposition: null,
          p_global_dnc_requested: true,
          p_address_normalized: null,
        }),
      );
      expect(SESSION03_DECLINE_DNC_FIXTURE).not.toContain(
        "property_disposition",
      );
      expect(SESSION03_DECLINE_DNC_FIXTURE).not.toContain('"address"');
      expect(SESSION03_POSITIVE_FIXTURE).not.toMatch(
        /transcript|excerpt|audio|sip/i,
      );
      expect(SESSION03_DECLINE_DNC_FIXTURE).not.toMatch(
        /transcript|excerpt|audio|sip/i,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["malformed JSON", "{"],
    ["mismatched event identity", body({ event_id: "other-event" })],
    ["non-E164 caller", body({ caller_phone_e164: "8165550123" })],
    ["missing explicit preference", body({ property_disposition: null })],
    ["null conversation instead of omission", body({ conversation_id: null })],
    ["null address instead of omission", body({ address: null })],
    ["unknown event source", body({ event_source: "model_guess" })],
    ["unknown event type", body({ event_type: "contact_preference" })],
    [
      "stale provider timestamp",
      body({ provider_timestamp: new Date(Date.now() - 8 * 86_400_000).toISOString() }),
    ],
    [
      "future provider timestamp",
      body({ provider_timestamp: new Date(Date.now() + 6 * 60_000).toISOString() }),
    ],
    [
      "evidence marker mismatch",
      body({
        intent_evidence: evidence(
          "event-1",
          "explicit_not_interested",
          "analysis:global_dnc_requested",
        ),
      }),
    ],
    [
      "incorrect evidence digest",
      body({
        intent_evidence: {
          category: "explicit_not_interested",
          intent_marker_id: "analysis:property_disposition",
          evidence_sha256: "a".repeat(64),
        },
      }),
    ],
    [
      "both evidence without global DNC",
      body({
        intent_marker_id: "analysis:both",
        intent_evidence: evidence(
          "event-1",
          "explicit_not_interested_and_do_not_contact",
          "analysis:both",
        ),
      }),
    ],
    [
      "both evidence without property disposition",
      body({
        property_disposition: undefined,
        global_dnc_requested: true,
        intent_marker_id: "analysis:both",
        intent_evidence: evidence(
          "event-1",
          "explicit_not_interested_and_do_not_contact",
          "analysis:both",
        ),
      }),
    ],
    [
      "DNC without matching explicit evidence",
      body({ global_dnc_requested: true }),
    ],
  ])("returns 400 for %s", async (_label, value) => {
    const response = await POST(request(value));
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("blocks manual-review property mutation but preserves explicit global DNC", async () => {
    const propertyOnly = await POST(
      request(body({ manual_review_required: true })),
    );
    expect(propertyOnly.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();

    const global = await POST(
      request(
        body({
          manual_review_required: true,
          global_dnc_requested: true,
          intent_marker_id: "analysis:both",
          intent_evidence: evidence(
            "event-1",
            "explicit_not_interested_and_do_not_contact",
            "analysis:both",
          ),
        }),
      ),
    );
    expect(global.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "apply_switchboard_contact_preferences",
      expect.objectContaining({
        p_property_disposition: null,
        p_global_dnc_requested: true,
        p_manual_review_required: true,
      }),
    );
  });

  it("binds organization, raw-body hash, address match, and independent preferences into one RPC", async () => {
    const payload = body({
      global_dnc_requested: true,
      intent_marker_id: "analysis:both",
      intent_evidence: evidence(
        "event-1",
        "explicit_not_interested_and_do_not_contact",
        "analysis:both",
      ),
    });
    const rawBody = JSON.stringify(payload);
    const response = await POST(request(payload));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "applied" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "apply_switchboard_contact_preferences",
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_consumer_id: "consumer-1",
        p_idempotency_key: "event-1",
        p_request_hash: createHash("sha256")
          .update("switchboard_contact_preferences\0")
          .update(rawBody)
          .digest("hex"),
        p_caller_phone_e164: "+18165550123",
        p_property_disposition: "not_interested",
        p_global_dnc_requested: true,
        p_address_normalized: "123 main st",
        p_address_city: "Kansas City",
        p_address_state: "MO",
        p_address_postal_code: "64108",
        p_evidence_sha256: evidence(
          "event-1",
          "explicit_not_interested_and_do_not_contact",
          "analysis:both",
        ).evidence_sha256,
      }),
    );
  });

  it.each([
    ["idempotency_conflict", 409, { error: "conflict" }],
    [
      "preference_not_applied",
      422,
      { error: "preference_not_applied" },
    ],
    ["replayed", 200, { status: "applied" }],
  ])("maps %s to a generic response", async (outcome, status, expected) => {
    mocks.rpc.mockResolvedValue({ data: { outcome }, error: null });
    const response = await POST(request(body()));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it("returns a generic 500 and does not echo PII or database detail", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "row for +18165550123 at 123 Main St failed" },
    });
    const response = await POST(request(body()));
    expect(response.status).toBe(500);
    const responseBody = await response.text();
    expect(responseBody).toBe('{"error":"internal_error"}');
    expect(responseBody).not.toContain("+18165550123");
    expect(responseBody).not.toContain("123 Main");
    expect(mocks.reportError).toHaveBeenCalledOnce();
    const [reportedError, reportedContext] = mocks.reportError.mock.calls[0];
    expect(reportedError).toBeInstanceOf(Error);
    expect((reportedError as Error).message).toBe(
      "switchboard_contact_preference_internal_error",
    );
    expect(Object.keys(reportedError as Error)).toEqual([]);
    const telemetry = JSON.stringify({
      message: (reportedError as Error).message,
      context: reportedContext,
    });
    expect(telemetry).not.toContain("+18165550123");
    expect(telemetry).not.toContain("123 Main");
    expect(telemetry).not.toContain("row for");
    expect(telemetry).not.toContain("call-1");
    expect(telemetry).not.toContain("analysis:property_disposition");
    expect(telemetry).not.toContain("source-event-1");
    expect(telemetry).not.toContain("correlation-1");
    expect(telemetry).not.toContain(JSON.stringify(body()));
  });

  it("returns a generic PII-free 500 when authenticated body streaming fails", async () => {
    mocks.authenticate.mockRejectedValue(
      new Error("switchboard_request_body_unreadable"),
    );
    const response = await POST(request(body()));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal_error"}');
  });
});
