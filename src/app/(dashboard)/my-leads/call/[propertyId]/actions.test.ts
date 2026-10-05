import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  myLeadsViewer: vi.fn(),
  getMyLeadsQueueRow: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
  rpc: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/my-leads/queries", () => ({
  myLeadsViewer: mocks.myLeadsViewer,
  getMyLeadsQueueRow: mocks.getMyLeadsQueueRow,
  MyLeadsReadError: class MyLeadsReadError extends Error {},
}));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("@/lib/comps", () => ({ compLead: vi.fn() }));

import { setValuationInputsAction } from "./actions";

const propertyId = "11111111-1111-4111-8111-111111111111";
const input = { propertyId, arv: 250000, rehab: 40000 };

describe("setValuationInputsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.myLeadsViewer.mockResolvedValue({ userId: "user-1", orgId: "org-1", client: { rpc: mocks.rpc } });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "found", row: {}, snapshotAt: "2026-10-04T00:00:00Z" });
    mocks.schemaReady.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({ data: { arv: 250000, rehab: 40000 }, error: null });
  });

  it("saves when the flag is on and the lead is in the caller's own queue", async () => {
    expect(await setValuationInputsAction(input)).toEqual({ ok: true, arv: 250000, rehab: 40000 });
    expect(mocks.getMyLeadsFlag).toHaveBeenCalledWith("org-1", "call_screen");
    expect(mocks.getMyLeadsQueueRow).toHaveBeenCalledWith({ memberId: "user-1", propertyId });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("refuses without calling the RPC when the call_screen flag is off", async () => {
    mocks.getMyLeadsFlag.mockResolvedValue(false);
    expect((await setValuationInputsAction(input)).ok).toBe(false);
    expect(mocks.getMyLeadsQueueRow).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses without calling the RPC when the lead is not in the caller's queue", async () => {
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "unavailable", reason: "other_rep" });
    expect(await setValuationInputsAction(input)).toEqual({ ok: false, message: "That lead could not be found." });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
