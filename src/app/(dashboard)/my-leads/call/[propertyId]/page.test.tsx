import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getAcquisitionRoster: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
  loadCallScreen: vi.fn(),
  dialpadRoute: vi.fn(),
  CallScreen: vi.fn(() => <div data-testid="call-screen-client" />),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: mocks.getCallerMembershipsOrThrow }));
vi.mock("@/lib/my-leads/queries", () => ({ getAcquisitionRoster: mocks.getAcquisitionRoster }));
vi.mock("@/lib/my-leads/flags", () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady: mocks.schemaReady }));
vi.mock("@/lib/dialpad-cti/call-route-server", () => ({ getDialpadCallRoute: mocks.dialpadRoute }));
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
    mocks.dialpadRoute.mockResolvedValue("dialpad");
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
    mocks.dialpadRoute.mockResolvedValue("softphone");
    expect(await render()).toContain("call-screen-client");
    expect(mocks.loadCallScreen).toHaveBeenCalledWith(propertyId);
    expect((mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ clickToDial: false });
  });

  it("derives clickToDial from the shared Dialpad route with the caller's Acquisitions designation", async () => {
    await render();
    expect(mocks.dialpadRoute).toHaveBeenCalledWith("org-1", "user-1", true);
    expect((mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ clickToDial: true });
    mocks.dialpadRoute.mockResolvedValue("softphone");
    await render();
    expect((mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({ clickToDial: false });
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([{ ...membership, acquisitions_enabled: false }]);
    await render();
    expect(mocks.dialpadRoute).toHaveBeenLastCalledWith("org-1", "user-1", false);
  });

  it("docks the post-call prompt only when call_screen AND post_call_prompt are on (and its schema is ready)", async () => {
    const lastProps = () => (mocks.CallScreen.mock.calls.at(-1) as unknown[] | undefined)?.[0];
    await render();
    expect(mocks.getMyLeadsFlag).toHaveBeenCalledWith("org-1", "post_call_prompt");
    expect(lastProps()).toMatchObject({ postCallPrompt: true });
    mocks.getMyLeadsFlag.mockImplementation(async (_org: string, flag: string) => flag !== "post_call_prompt");
    await render();
    expect(lastProps()).toMatchObject({ postCallPrompt: false });
    mocks.getMyLeadsFlag.mockResolvedValue(true);
    mocks.schemaReady.mockImplementation(async (feature: string) => feature !== "post_call_support");
    await render();
    expect(lastProps()).toMatchObject({ postCallPrompt: false });
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
