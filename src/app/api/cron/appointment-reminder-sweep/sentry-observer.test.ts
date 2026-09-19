import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportError: vi.fn(),
  getClient: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("@sentry/nextjs", () => ({ getClient: mocks.getClient, flush: mocks.flush }));

import { observeExhaustedReminders } from "./handlers";

function observerClient(input: {
  candidateIds?: string[];
  ledgerIds?: string[];
  rows?: Record<string, { status: string; attempts: number } | null>;
  decision?: "new" | "repeat" | "recovered";
}) {
  const rows = input.rows ?? {};
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "scan_exhausted_reminder_deliveries") {
      return { data: input.candidateIds ?? [], error: null };
    }
    if (name === "observe_sentry_anomaly") {
      return { data: { decision: input.decision ?? "new", claim_token: "claim-secret" }, error: null };
    }
    if (name === "ack_sentry_anomaly") {
      return { data: true, error: null };
    }
    throw new Error(`unexpected RPC: ${name} ${JSON.stringify(args)}`);
  });
  const from = vi.fn((table: string) => {
    if (table === "sentry_anomaly_ledger") {
      const q = {
        eq: vi.fn(() => q),
        order: vi.fn(() => q),
        limit: vi.fn(async () => ({
          data: (input.ledgerIds ?? []).map((source_id) => ({ source_id })), error: null,
        })),
      };
      return { select: vi.fn(() => q) };
    }
    if (table === "task_reminder_deliveries") {
      return { select: vi.fn(() => ({
        eq: vi.fn((_column: string, id: string) => ({
          maybeSingle: vi.fn(async () => ({ data: rows[id] ?? null, error: null })),
        })),
      })) };
    }
    throw new Error(`unexpected table: ${table}`);
  });
  return { rpc, from };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClient.mockReturnValue({});
  mocks.flush.mockResolvedValue(true);
});

describe("exhausted reminder observer", () => {
  it("emits safe active signal and acknowledges only after flush", async () => {
    const client = observerClient({
      candidateIds: ["private-delivery-id"],
      rows: { "private-delivery-id": { status: "failed", attempts: 3 } },
    });
    await observeExhaustedReminders(client as never);
    expect(client.rpc).toHaveBeenCalledWith("scan_exhausted_reminder_deliveries", { p_limit: 4 });
    expect(mocks.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: {
        surface: "cron_appointment_reminder_exhaustion_observer",
        kind: "state", operation: "reminder_retry_exhausted", outcome: "active",
      },
    });
    expect(JSON.stringify(mocks.reportError.mock.calls)).not.toContain("private-delivery-id");
    expect(mocks.flush).toHaveBeenCalledWith(2_000);
    expect(client.rpc).toHaveBeenCalledWith("ack_sentry_anomaly", {
      p_signal_kind: "reminder_retry_exhausted",
      p_source_id: "private-delivery-id",
      p_claim_token: "claim-secret",
      p_delivered: true,
    });
  });

  it("point-verifies recovery and leaves delivery unacknowledged when flush fails", async () => {
    mocks.flush.mockResolvedValue(false);
    const client = observerClient({
      ledgerIds: ["old-delivery"],
      rows: { "old-delivery": { status: "sent", attempts: 3 } },
      decision: "recovered",
    });
    await observeExhaustedReminders(client as never);
    expect(mocks.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: expect.objectContaining({ outcome: "recovered" }),
    });
    expect(client.rpc).toHaveBeenCalledWith("ack_sentry_anomaly", expect.objectContaining({
      p_source_id: "old-delivery", p_delivered: false,
    }));
  });

  it("never acknowledges delivery without an initialized SDK", async () => {
    mocks.getClient.mockReturnValue(null);
    const client = observerClient({
      candidateIds: ["no-sdk"], rows: { "no-sdk": { status: "failed", attempts: 4 } },
    });
    await observeExhaustedReminders(client as never);
    expect(mocks.reportError).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("ack_sentry_anomaly", expect.objectContaining({
      p_delivered: false,
    }));
  });
});
