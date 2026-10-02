import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { processDueCleanups } from "@/lib/direct-calling/cleanup";
import { readTelnyxDirectSettings } from "@/lib/direct-calling/config";
import { createSupabaseDirectCallStore } from "@/lib/direct-calling/store";

vi.mock("@/lib/direct-calling/cleanup", () => ({ processDueCleanups: vi.fn() }));
vi.mock("@/lib/direct-calling/config", () => ({ readTelnyxDirectSettings: vi.fn() }));
vi.mock("@/lib/direct-calling/store", () => ({ createSupabaseDirectCallStore: vi.fn() }));
vi.mock("@/lib/direct-calling/telnyx", () => ({
  telnyxGetCallAlive: vi.fn(),
  telnyxHangup: vi.fn(),
  telnyxListActiveCalls: vi.fn(),
}));

const SECRET = "watchdog-route-secret-012345678901";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const store = {
  findById: vi.fn(),
  updateIfStatus: vi.fn(),
  openCleanupsForCall: vi.fn(),
};
const activeRow = () => ({
  id: CALL_ID,
  operator_user_id: "33333333-3333-4333-8333-333333333333",
  status: "connected",
  browser_watchdog_session_id: SESSION_ID,
  browser_watchdog_claimed_at: "2026-10-02T00:00:00.000Z",
  browser_leg_id: "browser-leg",
  seller_leg_id: "seller-leg",
});
const signedRequest = (body: string, timestamp = String(Date.now()), signature = sign(body, timestamp)) =>
  new Request("http://localhost/api/internal/direct-call-watchdog", {
    method: "POST",
    headers: {
      "x-sandra-watchdog-timestamp": timestamp,
      "x-sandra-watchdog-signature": signature,
    },
    body,
  });
function sign(body: string, timestamp: string): string {
  return createHmac("sha256", SECRET).update(timestamp + "." + body).digest("base64url");
}
async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("direct-call watchdog cleanup callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DIRECT_WATCHDOG_CLEANUP_SECRET = SECRET;
    vi.mocked(readTelnyxDirectSettings).mockReturnValue({ apiKey: "key", appId: "app", connectionId: "connection", callerIdE164: "+15550000000" } as never);
    vi.mocked(createSupabaseDirectCallStore).mockReturnValue(store as never);
    store.findById.mockResolvedValue(activeRow());
    store.updateIfStatus.mockResolvedValue(activeRow());
    store.openCleanupsForCall.mockResolvedValue([]);
    vi.mocked(processDueCleanups).mockResolvedValue({ processed: 1, confirmed: 1, acknowledged: 0, failed: 0 });
  });

  it.each([
    ["missing signature", JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID }), String(Date.now()), ""],
    ["stale timestamp", JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID }), String(Date.now() - 31_000), undefined],
    ["wrong signature length", JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID }), String(Date.now()), "x"],
  ])("rejects %s before store access", async (_name, body, timestamp, signature) => {
    const response = await POST(signedRequest(body, timestamp, signature ?? sign(body, timestamp)));
    expect(response.status).toBe(401);
    expect(store.findById).not.toHaveBeenCalled();
  });

  it.each(["", "null", "[]", "{\"callId\":\"bad\"}"])("rejects invalid body %s", async (body) => {
    const response = await POST(signedRequest(body));
    expect(response.status).toBe(body === "" ? 400 : 400);
    expect(store.findById).not.toHaveBeenCalled();
  });

  it("ignores unknown, mismatched-session, unclaimed, and terminal rows", async () => {
    for (const row of [null, { ...activeRow(), browser_watchdog_session_id: "44444444-4444-4444-8444-444444444444" }, { ...activeRow(), browser_watchdog_claimed_at: null }, { ...activeRow(), status: "ended" }]) {
      store.findById.mockResolvedValueOnce(row);
      const response = await POST(signedRequest(JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID })));
      expect(response.status).toBe(200);
      expect((await json(response)).ignored).toBe(true);
    }
    expect(processDueCleanups).not.toHaveBeenCalled();
  });

  it("moves an active row to ending, works one bounded cleanup row, and finalizes only after the core confirms all obligations", async () => {
    store.openCleanupsForCall.mockResolvedValue([]);
    const response = await POST(signedRequest(JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID })));
    expect(response.status).toBe(200);
    expect(processDueCleanups).toHaveBeenCalledWith(expect.objectContaining({}), activeRow().operator_user_id, 1);
    expect(store.updateIfStatus).toHaveBeenNthCalledWith(1, CALL_ID, ["browser_connecting", "seller_dialing", "connected"], { status: "ending", failure_reason: "browser_watchdog_expired" }, [{ kind: "leg", legId: "browser-leg" }, { kind: "leg", legId: "seller-leg" }]);
    expect(store.updateIfStatus).toHaveBeenNthCalledWith(2, CALL_ID, ["ending"], expect.objectContaining({ status: "ended", ended_at: expect.any(String) }));
  });

  it("retries an already-ending row and leaves it durable while cleanup is still open", async () => {
    store.findById.mockResolvedValue({ ...activeRow(), status: "ending" });
    store.openCleanupsForCall.mockResolvedValue([{ id: "still-open" }]);
    const response = await POST(signedRequest(JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID })));
    expect(response.status).toBe(200);
    expect(store.updateIfStatus).not.toHaveBeenCalled();
    expect(processDueCleanups).toHaveBeenCalledTimes(1);
  });

  it("does not run cleanup when the concurrent status CAS loses", async () => {
    store.updateIfStatus.mockResolvedValue(null);
    const response = await POST(signedRequest(JSON.stringify({ callId: CALL_ID, sessionId: SESSION_ID })));
    expect(response.status).toBe(200);
    expect(processDueCleanups).not.toHaveBeenCalled();
  });
});
