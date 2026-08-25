import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticateJitterWriteback,
  checkAndRecordIdempotency,
  requireIdempotencyKey,
} from "../../../_lib/auth";
import type { JitterAuthOk } from "../../../_lib/auth";
import {
  isSupportedJitterWritebackProvider,
  PUT,
} from "./route";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

vi.mock("../../../_lib/auth", () => ({
  authenticateJitterWriteback: vi.fn(),
  checkAndRecordIdempotency: vi.fn(),
  requireIdempotencyKey: vi.fn(),
}));

const ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const PROPERTY_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";

const authMock = vi.mocked(authenticateJitterWriteback);
const idempotencyMock = vi.mocked(checkAndRecordIdempotency);
const missingKeyMock = vi.mocked(requireIdempotencyKey);

type TestBuilder = {
  select: () => TestBuilder;
  eq: (_column: string, _value: unknown) => TestBuilder;
  or: (_expression: string) => TestBuilder;
  limit: (_count: number) => TestBuilder;
  maybeSingle: () => Promise<{
    data: Record<string, unknown> | null;
    error: null;
  }>;
};

function context(attemptId: string) {
  return { params: Promise.resolve({ attemptId }) };
}

function body(
  provider: string | null | undefined,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    org_id: ORG_ID,
    property_id: PROPERTY_ID,
    contact_id: CONTACT_ID,
    jitter_session_id: "sandra-softphone-scope",
    provider,
    outcome: "connected_human",
    ...overrides,
  };
}

function request(payload: Record<string, unknown>) {
  return new Request(
    "https://sandra.test/api/internal/jitter/call-activities/by-jitter-attempt/sandra-00000000-0000-4000-8000-000000000003",
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "activity-1",
      },
      body: JSON.stringify(payload),
    },
  );
}

function serviceClient(existingActivity: Record<string, unknown> | null = null) {
  const rpc = vi.fn().mockResolvedValue({
    data: {
      call_activity: {
        id: "activity-1",
        provider: "sandra_softphone",
      },
    },
    error: null,
  });

  return {
    from: vi.fn((table: string) => {
      const builder: TestBuilder = {
        select: () => builder,
        eq: () => builder,
        or: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (table === "properties") {
            return {
              data: { id: PROPERTY_ID, org_id: ORG_ID, address: "1 Main St", deleted_at: null },
              error: null,
            };
          }
          if (table === "contacts") {
            return { data: { id: CONTACT_ID, org_id: ORG_ID }, error: null };
          }
          if (table === "call_activities") {
            return { data: existingActivity, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    }),
    rpc,
  };
}

describe("Jitter attempt call-activity provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    missingKeyMock.mockReturnValue(null);
    idempotencyMock.mockResolvedValue({
      state: "fresh",
      idempotencyKey: "activity-1",
      requestHash: "request-hash",
    });
  });

  it.each(["jitter", "sandra_softphone"])(
    "accepts the %s provider and reaches the writeback RPC",
    async (provider) => {
      const client = serviceClient();
      authMock.mockResolvedValue({
        ok: true,
        consumerId: "consumer-1",
        orgId: ORG_ID,
        serviceClient: client as unknown as JitterAuthOk["serviceClient"],
        rawBody: JSON.stringify(body(provider)),
      });

      const response = await PUT(
        request(body(provider)),
        context("sandra-00000000-0000-4000-8000-000000000003"),
      );

      expect(response.status).toBe(200);
      expect(client.rpc).toHaveBeenCalledWith(
        "jitter_writeback_call_activity",
        expect.objectContaining({
          p_attempt_id: "sandra-00000000-0000-4000-8000-000000000003",
          p_body: expect.objectContaining({ provider }),
        }),
      );
    },
  );

  it.each([undefined, null, "twilio", "sendillo"])(
    "rejects unsupported provider %s before reserving idempotency",
    async (provider) => {
      const client = serviceClient();
      const payload = body(provider);
      if (provider === undefined) delete payload.provider;
      authMock.mockResolvedValue({
        ok: true,
        consumerId: "consumer-1",
        orgId: ORG_ID,
        serviceClient: client as unknown as JitterAuthOk["serviceClient"],
        rawBody: JSON.stringify(payload),
      });

      const response = await PUT(
        request(payload),
        context("sandra-00000000-0000-4000-8000-000000000003"),
      );

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error_code: "provider_mismatch",
        field: "provider",
      });
      expect(idempotencyMock).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it("allows a softphone artifact to omit lead ids for an existing-row match", async () => {
    const client = serviceClient({
      property_id: PROPERTY_ID,
      contact_id: CONTACT_ID,
    });
    const payload = body("sandra_softphone");
    delete payload.property_id;
    delete payload.contact_id;
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as unknown as JitterAuthOk["serviceClient"],
      rawBody: JSON.stringify(payload),
    });

    const response = await PUT(
      request(payload),
      context("sandra-00000000-0000-4000-8000-000000000003"),
    );

    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith(
      "jitter_writeback_call_activity",
      expect.objectContaining({
        p_body: expect.objectContaining({
          property_id: PROPERTY_ID,
          contact_id: CONTACT_ID,
        }),
      }),
    );
  });

  it("keeps lead ids required for a batch Jitter payload", async () => {
    const client = serviceClient();
    const payload = body("jitter");
    delete payload.property_id;
    delete payload.contact_id;
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as unknown as JitterAuthOk["serviceClient"],
      rawBody: JSON.stringify(payload),
    });

    const response = await PUT(
      request(payload),
      context("attempt-1"),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "missing_required_field",
    });
    expect(idempotencyMock).not.toHaveBeenCalled();
  });

  it("defaults an omitted org_id to the authenticated consumer org", async () => {
    const client = serviceClient();
    const payload = body("sandra_softphone");
    delete payload.org_id;
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as unknown as JitterAuthOk["serviceClient"],
      rawBody: JSON.stringify(payload),
    });

    const response = await PUT(
      request(payload),
      context("sandra-00000000-0000-4000-8000-000000000003"),
    );

    expect(response.status).toBe(200);
    expect(client.rpc).toHaveBeenCalledWith(
      "jitter_writeback_call_activity",
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_body: expect.objectContaining({ org_id: ORG_ID }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      call_activity: { provider: "sandra_softphone" },
    });
  });

  it("rejects a cross-tenant softphone payload before matching its activity", async () => {
    const client = serviceClient({
      property_id: PROPERTY_ID,
      contact_id: CONTACT_ID,
    });
    const payload = body("sandra_softphone", { org_id: "00000000-0000-4000-8000-000000000099" });
    authMock.mockResolvedValue({
      ok: true,
      consumerId: "consumer-1",
      orgId: ORG_ID,
      serviceClient: client as unknown as JitterAuthOk["serviceClient"],
      rawBody: JSON.stringify(payload),
    });

    const response = await PUT(
      request(payload),
      context("sandra-00000000-0000-4000-8000-000000000003"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error_code: "org_consumer_mismatch",
    });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("keeps the provider predicate exact rather than accepting arbitrary strings", () => {
    expect(isSupportedJitterWritebackProvider("jitter")).toBe(true);
    expect(isSupportedJitterWritebackProvider("sandra_softphone")).toBe(true);
    expect(isSupportedJitterWritebackProvider("jitterish")).toBe(false);
    expect(isSupportedJitterWritebackProvider(null)).toBe(false);
  });
});
