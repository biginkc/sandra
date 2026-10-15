import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ viewer: vi.fn(), rpc: vi.fn() }));
vi.mock("./queries", async () => {
  class MyLeadsReadError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  const readRpc = async (client: { rpc: typeof mocks.rpc }, name: string, args: unknown) => {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      if (error.code === "42501") throw new MyLeadsReadError("FORBIDDEN", "no");
      if (error.code === "P0002") throw new MyLeadsReadError("NOT_FOUND", "no");
      if (error.code === "22023") throw new MyLeadsReadError("INVALID_INPUT", "no");
      throw new MyLeadsReadError("READ_FAILED", "no");
    }
    if (data === null) throw new MyLeadsReadError("READ_FAILED", "no data");
    return data;
  };
  return {
    MyLeadsReadError,
    myLeadsViewer: mocks.viewer,
    readRpc,
    readBadgeV2: async (client: unknown) => {
      const n = await readRpc(client as never, "fn_my_leads_badge_v2", {});
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new MyLeadsReadError("READ_FAILED", "bad");
      return n;
    },
    isQueueRowFor: (row: unknown, id: string) =>
      typeof row === "object" && row !== null && (row as { propertyId?: string }).propertyId === id,
  };
});

import {
  dismissBroken,
  getBadgeV2,
  getNeedsAttentionTopTen,
  getWorkFacts,
  getWorkPage,
  setPin,
} from "./work-queue";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SRC = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-15T15:00:00Z";
const QUERY = { tab: "needs_attention", chip: "all", stage: null, search: "", page: 1 } as const;

const facts = (id: string, extra: Record<string, unknown> = {}) => ({
  propertyId: id, stage: "contacted", place: "your_move", reason: "due", rowNo: "4", reasonAt: NOW,
  headline: { at: NOW, soon: false }, drip: null, nextStep: { callbackAt: NOW, offerFollowUpAt: null },
  lastTouchAt: null, attemptsCount: 1, assignedAt: null, latestInbound: null, hasPhone: true, contactDnc: false,
  broken: [], aiDraftId: null, labels: [],
  row: { propertyId: id, stage: "contacted", queueVersion: 1, assignmentEpisodeId: "ep", address: "1 Main" },
  ...extra,
});
const pagePayload = (ids: string[], extra: Record<string, unknown> = {}) => ({
  rows: ids.map((id) => facts(id)), ids, total: ids.length, page: 1, pageSize: 25,
  tabCounts: { needs_attention: ids.length, waiting: 0, all: ids.length },
  chipCounts: { due: ids.length }, stageCounts: { contacted: ids.length },
  revision: "abc", nextChangeAt: null, snapshotAt: NOW, ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockResolvedValue({ userId: A, orgId: "org-1", isOwner: false, client: { rpc: mocks.rpc } });
  mocks.rpc.mockResolvedValue({ data: pagePayload([A]), error: null });
});

describe("getWorkPage", () => {
  it("passes the query through to the RPC, 'all' included", async () => {
    const page = await getWorkPage({ memberId: A, query: { ...QUERY, chip: "all", search: "  oak " } });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_my_leads_work_page", {
      p_org_id: "org-1", p_member_id: A, p_tab: "needs_attention", p_chip: "all", p_stage: null,
      p_search: "oak", p_page: 1, p_size: 25, p_at: null,
    });
    expect(page.ids).toEqual([A]);
    expect(page.rows[0].row.propertyId).toBe(A);
    expect(page.tabCounts).toEqual({ needs_attention: 1, waiting: 0, all: 1 });
  });

  it("lets an owner read a rep but blocks a rep reading someone else", async () => {
    await expect(getWorkPage({ memberId: B, query: QUERY })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.viewer.mockResolvedValue({ userId: A, orgId: "org-1", isOwner: true, client: { rpc: mocks.rpc } });
    await getWorkPage({ memberId: B, query: QUERY });
    expect(mocks.rpc.mock.calls[0][1].p_member_id).toBe(B);
  });

  it.each([
    ["page 0", { ...QUERY, page: 0 }],
    ["bad tab", { ...QUERY, tab: "x" }],
    ["bad chip", { ...QUERY, chip: "nope" }],
    ["bad stage", { ...QUERY, stage: "nope" }],
    ["long search", { ...QUERY, search: "a".repeat(201) }],
  ])("rejects %s before any RPC", async (_n, query) => {
    await expect(getWorkPage({ memberId: A, query: query as never })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a bad size", async () => {
    await expect(getWorkPage({ memberId: A, query: QUERY, size: 51 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([
    ["not an object", "oops"],
    ["rows missing", { ...pagePayload([A]), rows: undefined }],
    ["ids disagree with rows", pagePayload([A], { ids: [B] })],
    ["total not a number", pagePayload([A], { total: "1" })],
    ["tab count missing", pagePayload([A], { tabCounts: { needs_attention: 1 } })],
    ["unknown chip count key", pagePayload([A], { chipCounts: { mystery: 1 } })],
    ["bad snapshotAt", pagePayload([A], { snapshotAt: "never" })],
    ["row with wrong reason", { ...pagePayload([A]), rows: [facts(A, { reason: "mystery" })] }],
    ["row whose id differs from its queue row", { ...pagePayload([A]), rows: [facts(A, { row: { propertyId: B } })] }],
    ["row with bad broken item", { ...pagePayload([A]), rows: [facts(A, { broken: [{ kind: "x", action: "resend", at: null, refId: null }] })] }],
  ])("throws READ_FAILED for a malformed payload: %s", async (_n, data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(getWorkPage({ memberId: A, query: QUERY })).rejects.toMatchObject({ code: "READ_FAILED" });
  });

  it("maps RPC errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(getWorkPage({ memberId: A, query: QUERY })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps a valid drip, inbound, broken item and null optional fields", async () => {
    const rich = facts(A, {
      reasonAt: null, nextStep: null, aiDraftId: SRC,
      drip: { enrollmentId: "e", status: "active", pauseReason: null, name: "N", step: 2, stepsTotal: 5, nextRunAt: NOW, completedAt: null, lastSentAt: null, healthy: true },
      latestInbound: { at: NOW, kind: "text", messageId: "m", handled: false, contactOnly: false },
      broken: [{ kind: "text_blocked", action: "review", at: NOW, refId: SRC }],
      labels: ["broken", "no_phone"],
    });
    mocks.rpc.mockResolvedValue({ data: { ...pagePayload([A]), rows: [rich] }, error: null });
    const page = await getWorkPage({ memberId: A, query: QUERY });
    expect(page.rows[0]).toMatchObject({ drip: { step: 2 }, latestInbound: { kind: "text" }, broken: [{ refId: SRC }], aiDraftId: SRC });
  });
});

describe("new facts fields (zip, contractSignedAt, lastTouch)", () => {
  const read = async (extra: Record<string, unknown>) => {
    mocks.rpc.mockResolvedValue({ data: { ...pagePayload([A]), rows: [facts(A, extra)] }, error: null });
    return getWorkPage({ memberId: A, query: QUERY });
  };
  it("defaults them to null when the payload predates the migration", async () => {
    const page = await read({});
    expect(page.rows[0]).toMatchObject({ zip: null, contractSignedAt: null, lastTouch: null });
  });
  it("keeps valid values and trims a blank zip to null", async () => {
    const page = await read({ zip: "64111", contractSignedAt: NOW, lastTouch: { kind: "drip_text", at: NOW } });
    expect(page.rows[0]).toMatchObject({ zip: "64111", contractSignedAt: NOW, lastTouch: { kind: "drip_text", at: NOW } });
    expect((await read({ zip: "  " })).rows[0].zip).toBeNull();
  });
  it("rejects an unknown last-touch kind, a bad time or a non-text zip", async () => {
    await expect(read({ lastTouch: { kind: "carrier_pigeon", at: NOW } })).rejects.toMatchObject({ code: "READ_FAILED" });
    await expect(read({ lastTouch: { kind: "note", at: "nope" } })).rejects.toMatchObject({ code: "READ_FAILED" });
    await expect(read({ zip: 64111 })).rejects.toMatchObject({ code: "READ_FAILED" });
    await expect(read({ contractSignedAt: "nope" })).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});

describe("getWorkFacts", () => {
  it("returns rows and missing ids", async () => {
    mocks.rpc.mockResolvedValue({ data: { rows: [facts(A)], missing: [B], snapshotAt: NOW }, error: null });
    const result = await getWorkFacts(A, [A, B]);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_my_leads_work_facts", { p_org_id: "org-1", p_member_id: A, p_ids: [A, B], p_at: null });
    expect(result.rows).toHaveLength(1);
    expect(result.missing).toEqual([B]);
  });

  it("rejects more than 50 ids or a bad id before the RPC", async () => {
    await expect(getWorkFacts(A, Array(51).fill(A))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(getWorkFacts(A, ["nope"])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("throws READ_FAILED on a malformed payload", async () => {
    mocks.rpc.mockResolvedValue({ data: { rows: [{}], missing: [], snapshotAt: NOW }, error: null });
    await expect(getWorkFacts(A, [A])).rejects.toMatchObject({ code: "READ_FAILED" });
    mocks.rpc.mockResolvedValue({ data: { rows: [], missing: ["x"], snapshotAt: NOW }, error: null });
    await expect(getWorkFacts(A, [A])).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});

describe("setPin", () => {
  it("pins and clears for the viewer", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, pinnedAt: NOW }, error: null });
    expect(await setPin(A, B, "pin")).toEqual({ pinnedAt: NOW });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_set_my_leads_pin", { p_org_id: "org-1", p_member_id: A, p_property_id: B, p_action: "pin" });
    mocks.rpc.mockResolvedValue({ data: { ok: true, pinnedAt: null }, error: null });
    expect(await setPin(A, B, "clear")).toEqual({ pinnedAt: null });
  });

  it("is member-only, even for an owner", async () => {
    mocks.viewer.mockResolvedValue({ userId: A, orgId: "org-1", isOwner: true, client: { rpc: mocks.rpc } });
    await expect(setPin(B, A, "pin")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects bad input and unconfirmed results", async () => {
    await expect(setPin(A, "x", "pin")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(setPin(A, B, "snooze" as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    mocks.rpc.mockResolvedValue({ data: { ok: true, pinnedAt: null }, error: null });
    await expect(setPin(A, B, "pin")).rejects.toMatchObject({ code: "READ_FAILED" });
    mocks.rpc.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(setPin(A, B, "clear")).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});

describe("dismissBroken", () => {
  it("calls the RPC for the viewer", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await dismissBroken(A, B, SRC);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_dismiss_my_leads_broken", { p_org_id: "org-1", p_member_id: A, p_property_id: B, p_source_id: SRC });
  });

  it("is member-only and validates ids", async () => {
    await expect(dismissBroken(B, A, SRC)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(dismissBroken(A, B, "nope")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValue({ data: { ok: false }, error: null });
    await expect(dismissBroken(A, B, SRC)).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});

describe("getBadgeV2", () => {
  it("returns the count and rejects a non-count", async () => {
    mocks.rpc.mockResolvedValue({ data: 4, error: null });
    expect(await getBadgeV2()).toBe(4);
    expect(mocks.rpc).toHaveBeenCalledWith("fn_my_leads_badge_v2", {});
    mocks.rpc.mockResolvedValue({ data: "4", error: null });
    await expect(getBadgeV2()).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});

describe("getNeedsAttentionTopTen", () => {
  it("reads page 1, size 10, Needs attention, no filters", async () => {
    mocks.rpc.mockResolvedValue({ data: pagePayload([A, B]), error: null });
    expect(await getNeedsAttentionTopTen(A)).toEqual([A, B]);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_tab: "needs_attention", p_chip: "all", p_stage: null, p_search: "", p_page: 1, p_size: 10 });
  });
});

describe("homeowner houses on queue rows", () => {
  const C1 = "44444444-4444-4444-8444-444444444444";
  const C2 = "55555555-5555-4555-8555-555555555555";
  const withContact = (id: string, contactId: string, extra: Record<string, unknown> = {}) =>
    facts(id, { row: { propertyId: id, stage: "contacted", queueVersion: 1, assignmentEpisodeId: "ep", address: "1 Main", contactId }, ...extra });

  function housesClient(rows: Record<string, unknown>[], error: unknown = null) {
    const from = vi.fn(() => {
      const query = {
        select: () => query, eq: () => query, in: vi.fn(() => query), is: () => query, order: () => query,
        limit: async () => ({ data: error ? null : rows, error }),
      };
      return query;
    });
    mocks.viewer.mockResolvedValue({ userId: A, orgId: "org-1", isOwner: false, client: { rpc: mocks.rpc, from } });
    return from;
  }
  const house = (id: string, contact: string, assigned: string) =>
    ({ id, address: `${id} Oak`, city: "KC", state: "MO", assigned_user_id: assigned, homeowner_contact_id: contact });

  it("adds every house per homeowner with one read for the whole page", async () => {
    const from = housesClient([house("h1", C1, A), house("h2", C1, B), house("h3", C2, A)]);
    mocks.rpc.mockResolvedValue({
      data: { ...pagePayload([A, B]), rows: [withContact(A, C1), withContact(B, C2)] },
      error: null,
    });
    const page = await getWorkPage({ memberId: A, query: QUERY });
    expect(from).toHaveBeenCalledTimes(1);
    expect(page.rows[0].homeownerHouses).toEqual({
      count: 2,
      houses: [
        { propertyId: "h1", address: "h1 Oak, KC, MO", assignedUserId: A, isMine: true },
        { propertyId: "h2", address: "h2 Oak, KC, MO", assignedUserId: B, isMine: false },
      ],
    });
    expect(page.rows[1].homeownerHouses?.count).toBe(1);
  });

  it("adds houses to refreshed facts too", async () => {
    housesClient([house("h1", C1, A), house("h2", C1, A)]);
    mocks.rpc.mockResolvedValue({ data: { rows: [withContact(A, C1)], missing: [], snapshotAt: NOW }, error: null });
    const result = await getWorkFacts(A, [A]);
    expect(result.rows[0].homeownerHouses?.count).toBe(2);
  });

  it("skips the read when the classifier already says every homeowner has one house", async () => {
    const from = housesClient([]);
    const { withHomeownerHouses } = await import("./work-queue");
    const rows = [{ ...withContact(A, C1), homeownerPropertyCount: 1 }] as never;
    await withHomeownerHouses(rows, { client: { from } as never, orgId: "org-1", userId: A });
    expect(from).not.toHaveBeenCalled();
  });

  it("still shows the queue when the houses read fails", async () => {
    housesClient([], { message: "boom" });
    mocks.rpc.mockResolvedValue({ data: { ...pagePayload([A]), rows: [withContact(A, C1)] }, error: null });
    const page = await getWorkPage({ memberId: A, query: QUERY });
    expect(page.rows[0].homeownerHouses).toBeUndefined();
    expect(page.rows[0].propertyId).toBe(A);
  });
});
