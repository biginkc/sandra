import { createHash, createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const cryptoSpies = vi.hoisted(() => ({
  timingSafeEqual: vi.fn(),
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>(
    "node:crypto",
  );
  cryptoSpies.timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: cryptoSpies.timingSafeEqual };
});

type Row = Record<string, any>;

let webhookConsumers: Row[] = [];
let webhookEvents = new Map<string, Row>();
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function eventKey(row: Row): string {
  return `${row.org_id}:${row.provider}:${row.event_type}:${row.external_id}`;
}

function makeBuilder(table: string) {
  const filters: { key: string; value: unknown; op: "eq" | "is" }[] = [];

  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((key: string, value: unknown) => {
      filters.push({ key, value, op: "eq" });
      return builder;
    }),
    is: vi.fn((key: string, value: unknown) => {
      filters.push({ key, value, op: "is" });
      return builder;
    }),
    insert: vi.fn(async (payload: Row) => {
      if (table !== "webhook_events") return { error: null };
      const key = eventKey(payload);
      if (webhookEvents.has(key)) {
        return { error: { code: "23505", message: "duplicate key" } };
      }
      webhookEvents.set(key, payload);
      return { error: null };
    }),
    update: vi.fn((payload: Row) => {
      const updateChain = {
        eq: vi.fn((key: string, value: unknown) => {
          filters.push({ key, value, op: "eq" });
          if (table === "webhook_events") {
            for (const [eventMapKey, row] of webhookEvents.entries()) {
              const matches = filters.every((filter) => row[filter.key] === filter.value);
              if (matches) webhookEvents.set(eventMapKey, { ...row, ...payload });
            }
          }
          return updateChain;
        }),
        is: vi.fn((key: string, value: unknown) => {
          filters.push({ key, value, op: "is" });
          if (table === "webhook_events") {
            for (const [eventMapKey, row] of webhookEvents.entries()) {
              const matches = filters.every((filter) => row[filter.key] === filter.value);
              if (matches) webhookEvents.set(eventMapKey, { ...row, ...payload });
            }
          }
          return updateChain;
        }),
      };
      return updateChain;
    }),
    maybeSingle: vi.fn(async () => {
      const rows =
        table === "webhook_consumers"
          ? webhookConsumers
          : Array.from(webhookEvents.values());
      const matched = rows.find((row) =>
        filters.every((filter) =>
          filter.op === "is"
            ? row[filter.key] === filter.value
            : row[filter.key] === filter.value,
        ),
      );
      return { data: matched ?? null, error: null };
    }),
  };

  return builder;
}

const serviceClient = {
  from: vi.fn((table: string) => makeBuilder(table)),
};

vi.mock("./service-client", () => ({
  createJitterServiceClient: () => serviceClient,
}));

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  recordIdempotentResponse,
  requireIdempotencyKey,
} from "./auth";

const TOKEN = "test-jitter-service-token";
const BODY = JSON.stringify({ hello: "world" });

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function signature(token = TOKEN, body = BODY): string {
  return "sha256=" + createHmac("sha256", token).update(body).digest("hex");
}

function request(headers: Record<string, string> = {}, body = BODY): Request {
  return new Request("https://sandra.test/api/internal/jitter/test", {
    method: "POST",
    headers,
    body,
  });
}

function validHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "x-sandra-signature": signature(),
  };
}

describe("authenticateJitterWriteback", () => {
  beforeEach(() => {
    webhookConsumers = [
      {
        id: "consumer-1",
        org_id: ORG_ID,
        secret_hash: hash(TOKEN),
        consumer_type: "jitter_writeback",
        enabled: true,
        revoked_at: null,
      },
    ];
    webhookEvents = new Map();
    serviceClient.from.mockClear();
    cryptoSpies.timingSafeEqual.mockClear();
  });

  it("returns 401 when Authorization header missing", async () => {
    const result = await authenticateJitterWriteback(
      request({ "x-sandra-signature": signature() }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 when token does not match any webhook_consumers row", async () => {
    const result = await authenticateJitterWriteback(
      request({
        authorization: "Bearer wrong",
        "x-sandra-signature": signature("wrong"),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 when consumer is disabled", async () => {
    webhookConsumers[0].enabled = false;

    const result = await authenticateJitterWriteback(request(validHeaders()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 when consumer is revoked", async () => {
    webhookConsumers[0].revoked_at = new Date().toISOString();

    const result = await authenticateJitterWriteback(request(validHeaders()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 when consumer_type is not jitter_writeback", async () => {
    webhookConsumers[0].consumer_type = "lead";

    const result = await authenticateJitterWriteback(request(validHeaders()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 when X-Sandra-Signature missing", async () => {
    const result = await authenticateJitterWriteback(
      request({ authorization: `Bearer ${TOKEN}` }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns 401 when HMAC signature does not match canonical body", async () => {
    const result = await authenticateJitterWriteback(
      request({
        authorization: `Bearer ${TOKEN}`,
        "x-sandra-signature": signature(TOKEN, "different-body"),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("returns ok with consumerId + serviceClient when token + signature valid", async () => {
    const result = await authenticateJitterWriteback(request(validHeaders()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.consumerId).toBe("consumer-1");
    expect(result.orgId).toBe(ORG_ID);
    expect(result.serviceClient).toBe(serviceClient);
    expect(result.rawBody).toBe(BODY);
  });

  it("uses timingSafeEqual for equal-length signature compares", async () => {
    await authenticateJitterWriteback(request(validHeaders()));

    expect(cryptoSpies.timingSafeEqual).toHaveBeenCalled();
    for (const call of cryptoSpies.timingSafeEqual.mock.calls) {
      expect(call[0]).toHaveLength(call[1].length);
    }
  });

  it("does not log bearer token, signature, or raw body", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await authenticateJitterWriteback(request(validHeaders()));

    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(signature());
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(BODY);
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });
});

describe("Jitter writeback idempotency helpers", () => {
  beforeEach(() => {
    webhookEvents = new Map();
  });

  it("checkAndRecordIdempotency inserts new webhook_events row and returns fresh", async () => {
    const result = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-1",
      payload: { request: true },
    });

    expect(result).toMatchObject({ state: "fresh", idempotencyKey: "key-1" });
    expect((result as { requestHash: string }).requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      webhookEvents.get(`${ORG_ID}:jitter:dialer_batch_claim:key-1`)?.payload,
    ).toEqual({
      request: true,
    });
  });

  it("checkAndRecordIdempotency on duplicate Idempotency-Key returns cached payload", async () => {
    await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-1",
      payload: { request: true },
    });
    await recordIdempotentResponse(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      idempotencyKey: "key-1",
      payload: { ok: true },
    });

    const result = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-1",
      payload: { request: true },
    });

    expect(result).toEqual({ state: "cached", cachedPayload: { ok: true } });
  });

  it("never treats an unprocessed reservation as a cached success after a crash", async () => {
    await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-crash",
      payload: { request: true },
    });

    const replay = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-crash",
      payload: { request: true },
    });

    expect(replay).toMatchObject({ state: "retry", idempotencyKey: "key-crash" });
  });

  it("rejects reusing a key with a different request payload", async () => {
    await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-reused",
      payload: { jitter_session_id: "session-a" },
    });

    const replay = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-reused",
      payload: { jitter_session_id: "session-b" },
    });

    expect(replay).toEqual({ state: "conflict", idempotencyKey: "key-reused" });
  });

  it("rejects a processed key when route or resource identity changes", async () => {
    await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-route-bound",
      payload: { request: true },
    });
    await recordIdempotentResponse(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      idempotencyKey: "key-route-bound",
      payload: { ok: true },
    });

    const differentResource = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-2",
      idempotencyKey: "key-route-bound",
      payload: { request: true },
    });
    expect(differentResource).toEqual({ state: "conflict", idempotencyKey: "key-route-bound" });
  });

  it("lets the first retry adopt a legacy pending row, then rejects a different retry", async () => {
    webhookEvents.set(`${ORG_ID}:jitter:dialer_batch_claim:key-legacy`, {
      org_id: ORG_ID,
      provider: "jitter",
      event_type: "dialer_batch_claim",
      external_id: "key-legacy",
      payload: { request: true },
      processing_status: "pending",
      request_hash: null,
    });

    const first = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-1",
      idempotencyKey: "key-legacy",
      payload: { request: true },
    });
    const second = await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_claim",
      resourceId: "batch-2",
      idempotencyKey: "key-legacy",
      payload: { request: true },
    });

    expect(first.state).toBe("retry");
    expect(second.state).toBe("conflict");
  });

  it("checkAndRecordIdempotency uses event_type matching route name", async () => {
    await checkAndRecordIdempotency(serviceClient as any, {
      orgId: ORG_ID,
      eventType: "dialer_batch_item_patch",
      resourceId: "item-1",
      idempotencyKey: "key-2",
      payload: {},
    });

    expect(webhookEvents.has(`${ORG_ID}:jitter:dialer_batch_item_patch:key-2`)).toBe(true);
  });

  it("checkAndRecordIdempotency throws when called with an empty key", async () => {
    await expect(
      checkAndRecordIdempotency(serviceClient as any, {
        orgId: ORG_ID,
        eventType: "dialer_batch_claim",
        resourceId: "batch-1",
        idempotencyKey: " ",
        payload: {},
      }),
    ).rejects.toThrow(/non-empty key/);
  });

  it("requireIdempotencyKey returns 400 with error_code='idempotency_key_required' when header is missing", async () => {
    const response = requireIdempotencyKey(request(validHeaders()));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("requireIdempotencyKey returns 400 with error_code='idempotency_key_required' when header is empty", async () => {
    const response = requireIdempotencyKey(
      request({ ...validHeaders(), "idempotency-key": " " }),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      error_code: "idempotency_key_required",
    });
  });

  it("requireIdempotencyKey returns null when header is present and non-empty", () => {
    const response = requireIdempotencyKey(
      request({ ...validHeaders(), "idempotency-key": "key-1" }),
    );

    expect(response).toBeNull();
  });
});
