import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  reconcileStoredStatusEvents: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/messaging/status-events", () => ({
  reconcileStoredStatusEvents: mocks.reconcileStoredStatusEvents,
  statusWebhookEventType: (kind: string) => `sms_status_${kind}`,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { GET, POST } from "./route";

const priorSecret = process.env.CRON_SECRET;

function request(token = "cron-test-secret") {
  return new Request("https://sandra.test/api/cron/sendillo-status-reconciliation", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function queryResult(
  rows: Array<{ external_id: string }>,
  error: { message: string } | null = null,
) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(async () => ({ data: rows, error })),
  };
  return builder;
}

function adminClient(
  retryable: Array<{ external_id: string }>,
  staleProcessing: Array<{ external_id: string }>,
  retryableError: { message: string } | null = null,
  staleError: { message: string } | null = null,
) {
  let queryNumber = 0;
  return {
    from: vi.fn(() => {
      queryNumber += 1;
      return queryNumber === 1
        ? queryResult(retryable, retryableError)
        : queryResult(staleProcessing, staleError);
    }),
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-test-secret";
  vi.clearAllMocks();
  mocks.reconcileStoredStatusEvents.mockResolvedValue(undefined);
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = priorSecret;
});

describe("Sendillo status reconciliation cron", () => {
  it("rejects invalid or missing cron configuration", async () => {
    expect((await GET(request("wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request())).status).toBe(500);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("sweeps pending, error, and stale processing events through the service client", async () => {
    const admin = adminClient(
      [{ external_id: "provider-1" }, { external_id: "provider-2" }],
      [{ external_id: "provider-2" }, { external_id: "provider-3" }],
    );
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      candidates: 3,
      reconciled: 3,
      failed: 0,
    });
    expect(mocks.createAdminClient).toHaveBeenCalledOnce();
    expect(mocks.reconcileStoredStatusEvents).toHaveBeenCalledTimes(3);
    expect(mocks.reconcileStoredStatusEvents).toHaveBeenNthCalledWith(
      1,
      admin,
      "sendillo",
      "provider-1",
    );
    expect(mocks.reconcileStoredStatusEvents).toHaveBeenNthCalledWith(
      2,
      admin,
      "sendillo",
      "provider-2",
    );
    expect(mocks.reconcileStoredStatusEvents).toHaveBeenNthCalledWith(
      3,
      admin,
      "sendillo",
      "provider-3",
    );
  });

  it("keeps a top-level reconciliation failure retryable for the next cron run", async () => {
    const admin = adminClient([{ external_id: "provider-failed" }], []);
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.reconcileStoredStatusEvents.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      candidates: 1,
      reconciled: 0,
      failed: 1,
    });
    expect(mocks.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: "cron_sendillo_status_reconciliation" },
      extra: { externalId: "provider-failed" },
    });
  });

  it("returns 500 when the durable candidate scan fails", async () => {
    mocks.createAdminClient.mockReturnValue(
      adminClient([], [], { message: "read failed" }),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "fetch retryable Sendillo status events failed: read failed" });
    expect(mocks.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: "cron_sendillo_status_reconciliation" },
    });
  });
});
