import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  rpc: vi.fn(),
  flag: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("./queries", async () => {
  const actual = await vi.importActual<typeof import("./queries")>("./queries").catch(() => null);
  class MyLeadsReadError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    MyLeadsReadError,
    myLeadsViewer: mocks.viewer,
    // The real error mapping and row check, so a regression in either shows up here.
    readRpc: async (client: { rpc: typeof mocks.rpc }, name: string, args: unknown) => {
      const { data, error } = await client.rpc(name, args);
      if (error) {
        if (error.message?.includes("FEATURE_DISABLED")) throw new MyLeadsReadError("FEATURE_DISABLED", "My Leads is not enabled yet.");
        if (error.code === "42501") throw new MyLeadsReadError("FORBIDDEN", "You do not have access to this queue.");
        if (error.code === "P0002") throw new MyLeadsReadError("NOT_FOUND", "That queue or lead was not found.");
        if (error.code === "22023") throw new MyLeadsReadError("INVALID_INPUT", "Refresh the queue or check the selected filters.");
        throw new MyLeadsReadError("READ_FAILED", "My Leads could not load. Please retry.");
      }
      if (data === null) throw new MyLeadsReadError("READ_FAILED", "My Leads returned no data.");
      return data;
    },
    isQueueRowFor:
      actual?.isQueueRowFor ??
      ((row: unknown, id: string) =>
        typeof row === "object" && row !== null && (row as { propertyId?: string }).propertyId === id),
  };
});
vi.mock("./flags", () => ({ getMyLeadsFlag: mocks.flag }));
vi.mock("./schema-ready", () => ({ schemaReady: mocks.ready }));

import {
  callNextEnabled,
  getCallNext,
  getTriage,
  setCallNextOverride,
} from "./call-next";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ORG = "org-1";
const NOW = "2026-10-05T15:00:00Z";
const queueRow = (propertyId: string) => ({
  propertyId,
  stage: "contacted",
  queueVersion: 1,
  assignmentEpisodeId: "ep-1",
  address: "1 Main",
});
const strip = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
  rows,
  excluded: [],
  hiddenCount: 0,
  snapshotAt: NOW,
  ...extra,
});
const item = (propertyId: string, extra: Record<string, unknown> = {}) => ({
  propertyId,
  tier: 5,
  reason: "longest_since_touch",
  reasonAt: null,
  pinned: false,
  lastTouchAt: null,
  row: queueRow(propertyId),
  ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockResolvedValue({ userId: "rep", orgId: ORG, isOwner: false, client: { rpc: mocks.rpc } });
  mocks.flag.mockResolvedValue(true);
  mocks.ready.mockResolvedValue(true);
  mocks.rpc.mockResolvedValue({ data: strip([]), error: null });
});

describe("callNextEnabled", () => {
  it("needs the org flag AND the schema", async () => {
    expect(await callNextEnabled(ORG)).toBe(true);
    expect(mocks.flag).toHaveBeenCalledWith(ORG, "call_next_strip");
    expect(mocks.ready).toHaveBeenCalledWith("call_next");
    mocks.flag.mockResolvedValue(false);
    mocks.ready.mockClear();
    expect(await callNextEnabled(ORG)).toBe(false);
    expect(mocks.ready).not.toHaveBeenCalled();
    mocks.flag.mockResolvedValue(true);
    mocks.ready.mockResolvedValue(false);
    expect(await callNextEnabled(ORG)).toBe(false);
  });
});

describe("getCallNext", () => {
  it("never calls the strip RPC and returns null when the flag is off (or the flags table is missing)", async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await getCallNext({ memberId: "rep" })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never calls the strip RPC when the migration has not landed", async () => {
    mocks.ready.mockResolvedValue(false);
    expect(await getCallNext({ memberId: "rep" })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("asks for ten rows for this org and member", async () => {
    mocks.rpc.mockResolvedValue({ data: strip([item(A), item(B, { tier: 1, reason: "appointment_overdue", pinned: false })]), error: null });
    const result = await getCallNext({ memberId: "rep" });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_get_my_leads_call_next", { p_org_id: ORG, p_member_id: "rep", p_limit: 10 });
    expect(result?.rows.map((r) => r.propertyId)).toEqual([A, B]);
    expect(result?.snapshotAt).toBe(NOW);
  });

  it("drops malformed rows instead of rendering them", async () => {
    mocks.rpc.mockResolvedValue({
      data: strip([
        item(A),
        item(B, { reason: "not_a_reason" }),
        item(B, { tier: 9 }),
        item(B, { row: { propertyId: A } }),
        item(B, { reasonAt: "not a date" }),
        { propertyId: "not-a-uuid", tier: 1 },
        "junk",
        null,
      ]),
      error: null,
    });
    expect((await getCallNext({ memberId: "rep" }))?.rows.map((r) => r.propertyId)).toEqual([A]);
  });

  it("keeps well-formed excluded entries and counts hidden", async () => {
    mocks.rpc.mockResolvedValue({
      data: strip([], {
        excluded: [{ propertyId: A, address: "1 Main", reason: "no_phone" }, { propertyId: B, address: "x", reason: "other" }],
        hiddenCount: 3,
      }),
      error: null,
    });
    const result = await getCallNext({ memberId: "rep" });
    expect(result?.excluded).toEqual([{ propertyId: A, address: "1 Main", reason: "no_phone" }]);
    expect(result?.hiddenCount).toBe(3);
  });

  it.each([
    [{ message: "FEATURE_DISABLED" }, "FEATURE_DISABLED"],
    [{ code: "42501", message: "x" }, "FORBIDDEN"],
    [{ code: "P0002", message: "x" }, "NOT_FOUND"],
    [{ code: "22023", message: "x" }, "INVALID_INPUT"],
    [{ message: "boom" }, "READ_FAILED"],
  ])("maps RPC error %j to %s", async (error, code) => {
    mocks.rpc.mockResolvedValue({ data: null, error });
    await expect(getCallNext({ memberId: "rep" })).rejects.toMatchObject({ code });
  });

  it("rejects a response with the wrong shape", async () => {
    mocks.rpc.mockResolvedValue({ data: { rows: "no", snapshotAt: NOW }, error: null });
    await expect(getCallNext({ memberId: "rep" })).rejects.toMatchObject({ code: "READ_FAILED" });
    mocks.rpc.mockResolvedValue({ data: { rows: [], snapshotAt: "nope" }, error: null });
    await expect(getCallNext({ memberId: "rep" })).rejects.toMatchObject({ code: "READ_FAILED" });
  });

  it("lets only an owner read another member's strip", async () => {
    await expect(getCallNext({ memberId: "someone-else" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.viewer.mockResolvedValue({ userId: "boss", orgId: ORG, isOwner: true, client: { rpc: mocks.rpc } });
    await getCallNext({ memberId: "someone-else" });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_get_my_leads_call_next", expect.objectContaining({ p_member_id: "someone-else" }));
  });
});

describe("getTriage", () => {
  it("is null and silent when the strip is off", async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await getTriage({ memberId: "rep" })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("passes the keyset cursor and returns the next cursor", async () => {
    mocks.rpc.mockResolvedValue({
      data: { rows: [{ propertyId: A, lastTouchAt: null, row: queueRow(A) }, { propertyId: B, lastTouchAt: "bad", row: queueRow(B) }], totalCount: 7, cursor: { touch: null, property: A } },
      error: null,
    });
    const result = await getTriage({ memberId: "rep", cursor: { touch: NOW, property: B } });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_get_my_leads_triage", { p_org_id: ORG, p_member_id: "rep", p_days: 14, p_limit: 25, p_after_touch: NOW, p_after_property: B });
    expect(result).toEqual({ rows: [{ propertyId: A, lastTouchAt: null, row: queueRow(A) }], totalCount: 7, cursor: { touch: null, property: A } });
  });

  it("rejects a cursor that is not a lead id before the RPC", async () => {
    await expect(getTriage({ memberId: "rep", cursor: { touch: null, property: "nope" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("setCallNextOverride", () => {
  it("rejects an unknown action before any RPC", async () => {
    await expect(setCallNextOverride({ memberId: "rep", propertyId: A, action: "snooze" as never })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.viewer).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a bad lead id, another member, and a disabled strip before the RPC", async () => {
    await expect(setCallNextOverride({ memberId: "rep", propertyId: "x", action: "clear" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(setCallNextOverride({ memberId: "other", propertyId: A, action: "clear" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.flag.mockResolvedValue(false);
    await expect(setCallNextOverride({ memberId: "rep", propertyId: A, action: "clear" })).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("calls the override function and returns the database-computed expiry", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, until: "2026-10-06T05:00:00Z" }, error: null });
    expect(await setCallNextOverride({ memberId: "rep", propertyId: A, action: "call_today" })).toEqual({ until: "2026-10-06T05:00:00Z" });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_set_my_leads_strip_override", { p_org_id: ORG, p_member_id: "rep", p_property_id: A, p_action: "call_today" });
  });

  it("treats an unconfirmed response as a failure", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(setCallNextOverride({ memberId: "rep", propertyId: A, action: "clear" })).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});
