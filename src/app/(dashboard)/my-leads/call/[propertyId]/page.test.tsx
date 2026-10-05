import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getAcquisitionRoster: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
  loadCallScreen: vi.fn(),
  CallScreen: vi.fn(() => <div data-testid="call-screen-client" />),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.getCallerMembershipsOrThrow }));
vi.mock("@/lib/my-leads/queries", () => ({ getAcquisitionRoster: mocks.getAcquisitionRoster }));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("./loaders", () => ({ loadCallScreen: mocks.loadCallScreen }));
vi.mock("./call-screen", () => ({ CallScreen: mocks.CallScreen }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import CallScreenPage, { dynamic, maxDuration } from "./page";

const membership = { user_id: "user-1", org_id: "org-1", role: "member" as const, acquisitions_enabled: true, access_status: "active", access_expires_at: null, deletion_prepared_at: null };
const roster = {
  isOwner: false,
  members: [{ id: "user-1", label: "Rep", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true }],
  settings: { enabled: true, recipientId: null, recipient: null, revision: 1 },
};
const propertyId = "11111111-1111-4111-8111-111111111111";
const render = async () => renderToStaticMarkup((await CallScreenPage({ params: Promise.resolve({ propertyId }) })) as ReactElement);

describe("CallScreenPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([membership]);
    mocks.getAcquisitionRoster.mockResolvedValue({ viewer: { userId: "user-1", orgId: "org-1", isOwner: false }, roster });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockResolvedValue(true);
    mocks.loadCallScreen.mockResolvedValue({ status: "ok", data: { viewer: { userId: "user-1" } } });
  });

  it("exports the route segment config the plan requires", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(300);
  });

  it("renders the call screen when the flag is on and the schema is ready", async () => {
    const html = await render();
    expect(html).toContain("call-screen-client");
    expect(mocks.getMyLeadsFlag).toHaveBeenCalledWith("org-1", "call_screen");
    expect(mocks.loadCallScreen).toHaveBeenCalledWith(propertyId);
  });

  it("404s when the call_screen flag is off (missing row reads OFF) and never loads the lead", async () => {
    mocks.getMyLeadsFlag.mockResolvedValue(false);
    await expect(render()).rejects.toThrow("notFound");
    expect(mocks.loadCallScreen).not.toHaveBeenCalled();
  });

  it("still renders when the lead_comps schema is not ready (only the numbers card degrades)", async () => {
    mocks.schemaReady.mockResolvedValue(false);
    expect(await render()).toContain("call-screen-client");
    expect(mocks.loadCallScreen).toHaveBeenCalledWith(propertyId);
    expect((mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ clickToDial: false });
  });

  it("passes clickToDial only when the click_to_dial flag is on AND schemaReady('api_dial')", async () => {
    await render();
    expect(mocks.schemaReady).toHaveBeenCalledWith("api_dial");
    expect((mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ clickToDial: true });
    mocks.getMyLeadsFlag.mockImplementation(async (_org: string, flag: string) => flag === "call_screen");
    await render();
    expect((mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ clickToDial: false });
  });

  it("404s on a membership read failure, a multi-org caller and a roster failure, before any flag read", async () => {
    mocks.getCallerMembershipsOrThrow.mockRejectedValueOnce(new Error("boom"));
    await expect(render()).rejects.toThrow("notFound");
    mocks.getCallerMembershipsOrThrow.mockResolvedValueOnce([membership, { ...membership, org_id: "org-2" }]);
    await expect(render()).rejects.toThrow("notFound");
    mocks.getAcquisitionRoster.mockRejectedValueOnce(new Error("boom"));
    await expect(render()).rejects.toThrow("notFound");
    expect(mocks.getMyLeadsFlag).not.toHaveBeenCalled();
    expect(mocks.loadCallScreen).not.toHaveBeenCalled();
  });

  it("404s for a member who cannot view My Leads", async () => {
    mocks.getAcquisitionRoster.mockResolvedValue({ viewer: { userId: "user-1", orgId: "org-1", isOwner: false }, roster: { ...roster, members: [{ ...roster.members[0], acquisitionsEnabled: false }] } });
    await expect(render()).rejects.toThrow("notFound");
    expect(mocks.getMyLeadsFlag).not.toHaveBeenCalled();
  });

  it("404s for an invalid id and shows the shared reason copy for a lead outside the queue", async () => {
    mocks.loadCallScreen.mockResolvedValue({ status: "invalid" });
    await expect(render()).rejects.toThrow("notFound");
    mocks.loadCallScreen.mockResolvedValue({ status: "unavailable", reason: "other_rep" });
    expect(await render()).toContain("assigned to another rep");
  });
});
