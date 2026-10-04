import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchNormaCall } from "./dispatch";
import { readNormaMaintenanceHold } from "./maintenance";
import { reconcileNormaCalls } from "./reconcile";
import { requestNormaCallCore } from "./request-call";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

function guardedClient() {
  const fail = vi.fn(() => { throw new Error("Held operation must not touch the database"); });
  const client = { from: fail, rpc: fail } as unknown as Parameters<typeof dispatchNormaCall>[1]["client"];
  return { client, fail };
}

describe("Norma maintenance hold", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("production calls without env overrides use the held process environment", async () => {
    vi.stubEnv("NORMA_MAINTENANCE_HOLD", "1");
    expect(readNormaMaintenanceHold()).toBe(true);
    const db = guardedClient(); const getUserId = vi.fn();
    expect(await requestNormaCallCore("55555555-5555-4555-8555-555555555555", null, { getUserId, sessionClient: db.client, adminClient: db.client })).toEqual({ ok: false, code: "gate_off", reason: "dispatch_disabled" });
    expect(getUserId).not.toHaveBeenCalled(); expect(db.fail).not.toHaveBeenCalled();
  });
  it.each([undefined, "0", "false", "OFF", " no "])("explicit release or unset %s preserves normal operation", (value) => {
    expect(readNormaMaintenanceHold({ NORMA_MAINTENANCE_HOLD: value })).toBe(false);
  });
  it.each(["1", "true", "yes", "on", "", "invalid"])("present hold or malformed %s holds safely", (value) => {
    expect(readNormaMaintenanceHold({ NORMA_MAINTENANCE_HOLD: value })).toBe(true);
  });
  it("prevents request creation before authentication/lead reads, RPC or dispatch", async () => {
    const db = guardedClient(); const getUserId = vi.fn(); const dispatch = vi.fn();
    expect(await requestNormaCallCore("55555555-5555-4555-8555-555555555555", null, {
      getUserId, dispatch, sessionClient: db.client, adminClient: db.client,
      env: { NORMA_MAINTENANCE_HOLD: "1", NORMA_DISPATCH_ENABLED: "true" },
    })).toEqual({ ok: false, code: "gate_off", reason: "dispatch_disabled" });
    expect(getUserId).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(db.fail).not.toHaveBeenCalled();
  });
  it("holds direct dispatch without claiming/rejecting/releasing or sending", async () => {
    const db = guardedClient(); const sendCall = vi.fn(); const getCall = vi.fn();
    expect(await dispatchNormaCall("existing-request", {
      client: db.client, env: { NORMA_MAINTENANCE_HOLD: "1" }, bland: { sendCall, getCall },
      gate: { dispatchEnabled: true, sellerRelease: true, allowedNumbers: [] },
    })).toEqual({ status: "not_claimed" });
    expect(db.fail).not.toHaveBeenCalled(); expect(sendCall).not.toHaveBeenCalled(); expect(getCall).not.toHaveBeenCalled();
  });
  it("holds all reconciliation, including old requested expiry and review recovery", async () => {
    const db = guardedClient(); const sendCall = vi.fn(); const getCall = vi.fn(); const dispatch = vi.fn();
    expect(await reconcileNormaCalls({
      client: db.client, bland: { sendCall, getCall }, dispatch,
      includeNeedsReview: true, env: { NORMA_MAINTENANCE_HOLD: "1" },
    })).toEqual({ maintenanceHeld: true, scanned: 0, dispatched: 0, completed: 0, rejected: 0, markedUnknown: 0, escalated: 0, waiting: 0, errors: 0 });
    expect(db.fail).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(sendCall).not.toHaveBeenCalled(); expect(getCall).not.toHaveBeenCalled();
  });
});
