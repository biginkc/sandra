import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureSendilloSmsHealthSnapshot,
  getStoredSendilloSmsHealth,
  SENDILLO_HEALTH_SNAPSHOT_KEY,
} from "./sendillo-health-snapshot";

const health = {
  smsRows: 7,
  outboundMessages: 3,
  inboundMessages: 2,
  conversations: 4,
  latestInboundMissingDisposition: 1,
  unreadMissingDisposition: 1,
  humanAttentionMissingDisposition: 1,
  anyInboundMissingDisposition: 2,
  firstMessageAt: "2026-08-10T10:00:00.000Z",
  latestMessageAt: "2026-08-10T11:00:00.000Z",
};

beforeEach(() => vi.restoreAllMocks());

describe("Sendillo health snapshots", () => {
  it("reads one stored row without scanning messages or properties", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { payload: health, captured_at: "2026-08-10T16:15:00.000Z" },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    await expect(
      getStoredSendilloSmsHealth(
        { from } as never,
        new Date("2026-08-10T16:20:00.000Z"),
      ),
    ).resolves.toEqual({
      status: "available",
      health,
      updatedAt: "2026-08-10T16:15:00.000Z",
      stale: false,
    });
    expect(from).toHaveBeenCalledWith("dashboard_snapshots");
    expect(select).toHaveBeenCalledWith("payload, captured_at");
    expect(eq).toHaveBeenCalledWith(
      "snapshot_key",
      SENDILLO_HEALTH_SNAPSHOT_KEY,
    );
  });

  it("marks an old snapshot stale only inside the operating window", async () => {
    const makeClient = () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                payload: health,
                captured_at: "2026-08-10T12:00:00.000Z",
              },
              error: null,
            }),
          }),
        }),
      }),
    });
    await expect(
      getStoredSendilloSmsHealth(
        makeClient() as never,
        new Date("2026-08-10T18:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ status: "available", stale: true });
    await expect(
      getStoredSendilloSmsHealth(
        makeClient() as never,
        new Date("2026-08-11T05:30:00.000Z"),
      ),
    ).resolves.toMatchObject({ status: "available", stale: false });
  });

  it("fails closed for a missing or malformed snapshot", async () => {
    const client = (data: unknown) => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
          }),
        }),
      }),
    });
    await expect(
      getStoredSendilloSmsHealth(client(null) as never),
    ).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      getStoredSendilloSmsHealth(
        client({
          payload: { ...health, smsRows: -1 },
          captured_at: new Date().toISOString(),
        }) as never,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
  });

  it("captures and returns the row persisted by the atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ payload: health, captured_at: "2026-08-10T16:15:00.000Z" }],
      error: null,
    });
    await expect(
      captureSendilloSmsHealthSnapshot(
        { rpc } as never,
        new Date("2026-08-10T16:15:00.000Z"),
      ),
    ).resolves.toEqual({
      status: "available",
      health,
      updatedAt: "2026-08-10T16:15:00.000Z",
      stale: false,
    });
    expect(rpc).toHaveBeenCalledWith("capture_sendillo_sms_health_snapshot", {
      p_captured_at: "2026-08-10T16:15:00.000Z",
    });
  });

  it("throws without replacing the prior snapshot on RPC failure", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });
    await expect(
      captureSendilloSmsHealthSnapshot({ rpc } as never),
    ).rejects.toThrow("database unavailable");
  });
});
