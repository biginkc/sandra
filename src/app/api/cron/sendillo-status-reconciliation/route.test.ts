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
    is: vi.fn(() => builder),
    lte: vi.fn(() => builder),
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
  freshPending: Array<{ external_id: string }> = [],
) {
  let queryNumber = 0;
  return {
    from: vi.fn(() => {
      queryNumber += 1;
      if (queryNumber === 1) return queryResult(retryable, retryableError);
      if (queryNumber === 2) return queryResult(freshPending);
      return queryResult(staleProcessing, staleError);
    }),
    rpc: vi.fn(async () => ({ data: { ok: true, matched: true }, error: null })),
  };
}

function successfulReconciliation(candidates = 1) {
  return { candidates, processed: candidates, failed: 0, failures: [] };
}

beforeEach(() => {
  process.env.CRON_SECRET = "cron-test-secret";
  vi.clearAllMocks();
  mocks.reconcileStoredStatusEvents.mockResolvedValue(successfulReconciliation());
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
      groups: 3,
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
      groups: 1,
      reconciled: 0,
      failed: 1,
    });
    expect(mocks.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { surface: "cron_sendillo_status_reconciliation" },
      extra: { externalId: "provider-failed" },
    });
  });

  it("keeps a fresh callback in the sweep when an old poison backlog exceeds the due lane", async () => {
    const oldPoison = Array.from({ length: 100 }, (_, index) => ({
      external_id: `old-poison-${index}`,
    }));
    const admin = adminClient(oldPoison, [], null, null, [{ external_id: "new-resolvable" }]);
    mocks.createAdminClient.mockReturnValue(admin);

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      candidates: 101,
      groups: 101,
      reconciled: 101,
      failed: 0,
    });
    expect(mocks.reconcileStoredStatusEvents).toHaveBeenCalledWith(
      admin,
      "sendillo",
      "new-resolvable",
    );
    expect(admin.from).toHaveBeenCalledTimes(3);
  });

  it("reports row failures returned by the reconciliation helper and schedules their retry", async () => {
    const admin = adminClient([{ external_id: "provider-row-failed" }], []);
    mocks.createAdminClient.mockReturnValue(admin);
    mocks.reconcileStoredStatusEvents.mockResolvedValueOnce({
      candidates: 2,
      processed: 1,
      failed: 1,
      failures: [{
        eventType: "sms_status_delivered",
        externalId: "provider-row-failed",
        message: "message not found",
      }],
    });

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      candidates: 2,
      groups: 1,
      reconciled: 1,
      failed: 1,
    });
    expect(admin.rpc).toHaveBeenCalledWith(
      "fn_schedule_webhook_event_reconciliation_retry",
      {
        p_provider: "sendillo",
        p_event_type: "sms_status_delivered",
        p_external_id: "provider-row-failed",
        p_error_message: "message not found",
      },
    );
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
