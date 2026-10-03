import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getAcquisitionRoster: vi.fn(),
  getAcquisitionQueue: vi.fn(),
  getAcquisitionKpis: vi.fn(),
  getMyLeadsQueueRow: vi.fn(),
  listMyLeadsInDrip: vi.fn(),
  MyLeadsClient: vi.fn(() => <div data-testid="my-leads-client" />),
  loadDialpadPanelBootstrap: vi.fn(),
  reportError: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/lib/auth/memberships", () => ({
  getCallerMembershipsOrThrow: mocks.getCallerMembershipsOrThrow,
}));
vi.mock("@/lib/my-leads/queries", () => ({
  getAcquisitionRoster: mocks.getAcquisitionRoster,
  getAcquisitionQueue: mocks.getAcquisitionQueue,
  getAcquisitionKpis: mocks.getAcquisitionKpis,
  getMyLeadsQueueRow: mocks.getMyLeadsQueueRow,
  MyLeadsReadError: class MockMyLeadsReadError extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('@/lib/my-leads/drip-queries', () => ({listMyLeadsInDrip: mocks.listMyLeadsInDrip}));
vi.mock("@/lib/dialpad-cti/dispatch", () => ({
  loadDialpadPanelBootstrap: mocks.loadDialpadPanelBootstrap,
  createSupabaseDialpadDispatchDb: vi.fn(() => ({})),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));
vi.mock("./client", () => ({ MyLeadsClient: mocks.MyLeadsClient }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

import type { AcquisitionRoster } from "@/lib/my-leads/queries";
import MyLeadsPage from "./page";

const activeAcquisitionsMembership = {
  user_id: "user-1",
  org_id: "org-1",
  role: "member" as const,
  acquisitions_enabled: true,
  access_status: "active",
  access_expires_at: null,
  deletion_prepared_at: null,
};

const baseRoster: AcquisitionRoster = {
  isOwner: false,
  members: [
    {
      id: "user-1",
      label: "Acquisitions rep",
      role: "member",
      acquisitionsEnabled: true,
      active: true,
      hasHistory: true,
    },
  ],
  settings: {
    enabled: true,
    recipientId: null,
    recipient: null,
    revision: 1,
  },
};

const viewer = { userId: "user-1", orgId: "org-1", isOwner: false };

function renderPage(element: Awaited<ReturnType<typeof MyLeadsPage>>) {
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCallerMembershipsOrThrow.mockResolvedValue([
    activeAcquisitionsMembership,
  ]);
  mocks.getAcquisitionRoster.mockResolvedValue({ viewer, roster: baseRoster });
  mocks.getAcquisitionQueue.mockResolvedValue({});
  mocks.getAcquisitionKpis.mockResolvedValue({});
  mocks.getMyLeadsQueueRow.mockReset();
  mocks.listMyLeadsInDrip.mockResolvedValue({active:[],replied:[],repliedCount:0,counts:{}});
  mocks.loadDialpadPanelBootstrap.mockResolvedValue(null);
});

describe("MyLeadsPage availability boundary", () => {
  it("renders an explicit disabled state for a known Acquisitions member when rollout is off", async () => {
    mocks.getAcquisitionRoster.mockResolvedValue({
      viewer,
      roster: {
        ...baseRoster,
        settings: { ...baseRoster.settings, enabled: false },
      },
    });

    const html = renderPage(await MyLeadsPage());

    expect(html).toContain("My Leads is disabled for this organization.");
    expect(html).not.toContain("my-leads-client");
    expect(mocks.getAcquisitionQueue).not.toHaveBeenCalled();
    expect(mocks.getAcquisitionKpis).not.toHaveBeenCalled();
  });

  it("renders a retryable unavailable state for a known Acquisitions roster failure", async () => {
    const internalMessage = "database connection details";
    mocks.getAcquisitionRoster.mockRejectedValue(new Error(internalMessage));

    const html = renderPage(await MyLeadsPage());

    expect(html).toContain("My Leads is temporarily unavailable.");
    expect(html).toContain('href="/my-leads"');
    expect(html).toContain("Retry");
    expect(html).not.toContain(internalMessage);
    expect(mocks.getAcquisitionQueue).not.toHaveBeenCalled();
  });

  it("maps the rollout error to a disabled state without exposing the RPC message", async () => {
    const { MyLeadsReadError } = await import("@/lib/my-leads/queries");
    mocks.getAcquisitionRoster.mockRejectedValue(
      new MyLeadsReadError("FEATURE_DISABLED", "FEATURE_DISABLED: internal detail"),
    );

    const html = renderPage(await MyLeadsPage());

    expect(html).toContain("My Leads is disabled for this organization.");
    expect(html).not.toContain("internal detail");
    expect(html).not.toContain('href="/my-leads"');
  });

  it("renders unavailable when a membership lookup has multiple active organizations", async () => {
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      activeAcquisitionsMembership,
      { ...activeAcquisitionsMembership, org_id: "org-2" },
    ]);

    const html = renderPage(await MyLeadsPage());

    expect(html).toContain("My Leads is temporarily unavailable.");
    expect(html).toContain("Retry");
    expect(mocks.getAcquisitionRoster).not.toHaveBeenCalled();
    expect(mocks.getAcquisitionQueue).not.toHaveBeenCalled();
  });

  it("keeps an unauthorized non-Acquisitions member behind the existing not-found boundary", async () => {
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      { ...activeAcquisitionsMembership, acquisitions_enabled: false },
    ]);
    mocks.getAcquisitionRoster.mockResolvedValue({
      viewer: { ...viewer, isOwner: false },
      roster: {
        ...baseRoster,
        members: [],
      },
    });

    await expect(MyLeadsPage()).rejects.toThrow("notFound");
    expect(mocks.getAcquisitionQueue).not.toHaveBeenCalled();
  });

  it("keeps the authorized queue path for an active Acquisitions member", async () => {
    const html = renderPage(await MyLeadsPage());

    expect(mocks.getAcquisitionQueue).toHaveBeenCalledWith({
      memberId: "user-1",
    });
    expect(mocks.getAcquisitionKpis).toHaveBeenCalledWith({
      memberId: "user-1",
      period: "today",
    });
    expect(html).toContain("my-leads-client");
  });

  it("looks up an exact deep-linked lead for the signed-in member and canonicalizes its UUID", async () => {
    const uppercase = "AABBCCDD-EEFF-4011-8223-445566778899";
    const propertyId = uppercase.toLowerCase();
    const row = { propertyId };
    mocks.getMyLeadsQueueRow.mockResolvedValue({
      status: "found",
      row,
      snapshotAt: "2026-10-03T12:00:00.000Z",
    });

    renderPage(await MyLeadsPage({ searchParams: Promise.resolve({ lead: uppercase }) }));

    expect(mocks.getMyLeadsQueueRow).toHaveBeenCalledWith({
      memberId: "user-1",
      propertyId,
    });
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({ selectedLead: { status: "found", propertyId, row } });
  });

  it("keeps the queue usable when a linked lead read fails and preserves the retry URL", async () => {
    const { MyLeadsReadError } = await import("@/lib/my-leads/queries");
    const propertyId = "aabbccdd-eeff-4011-8223-445566778899";
    mocks.getMyLeadsQueueRow.mockRejectedValue(
      new MyLeadsReadError("READ_FAILED", "internal database detail"),
    );

    renderPage(await MyLeadsPage({ searchParams: Promise.resolve({ lead: propertyId }) }));

    expect(mocks.getAcquisitionQueue).toHaveBeenCalledWith({ memberId: "user-1" });
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({
        selectedLead: {
          status: "error",
          message: "We couldn't check this lead right now.",
          retryHref: `/my-leads?lead=${propertyId}`,
        },
      });
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .not.toMatchObject({ selectedLead: { message: "internal database detail" } });
  });

  it("skips a linked lead lookup while the owner sees rollout disabled", async () => {
    const ownerViewer = { ...viewer, userId: "owner-1", isOwner: true };
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      { ...activeAcquisitionsMembership, user_id: "owner-1", role: "owner" },
    ]);
    mocks.getAcquisitionRoster.mockResolvedValue({
      viewer: ownerViewer,
      roster: { ...baseRoster, isOwner: true, settings: { ...baseRoster.settings, enabled: false } },
    });

    renderPage(await MyLeadsPage({
      searchParams: Promise.resolve({ lead: "aabbccdd-eeff-4011-8223-445566778899" }),
    }));

    expect(mocks.getMyLeadsQueueRow).not.toHaveBeenCalled();
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({ selectedLead: { status: "unavailable", message: "My Leads is disabled for this organization." } });
  });

  it.each([
    { lead: ["aabbccdd-eeff-4011-8223-445566778899", "aabbccdd-eeff-4011-8223-445566778899"] },
    { lead: "not-a-uuid" },
  ])("rejects malformed or duplicate deep links without querying a lead", async (searchParams) => {
    renderPage(await MyLeadsPage({ searchParams: Promise.resolve(searchParams) }));

    expect(mocks.getMyLeadsQueueRow).not.toHaveBeenCalled();
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({ selectedLead: { status: "invalid" } });
  });

  it("keeps an owner on their own queue when a deep-linked lead belongs to another rep", async () => {
    const ownerViewer = { ...viewer, userId: "owner-1", isOwner: true };
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      { ...activeAcquisitionsMembership, user_id: "owner-1", role: "owner" },
    ]);
    mocks.getAcquisitionRoster.mockResolvedValue({
      viewer: ownerViewer,
      roster: { ...baseRoster, isOwner: true },
    });
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "unavailable", reason: "other_rep" });

    renderPage(await MyLeadsPage({
      searchParams: Promise.resolve({ lead: "aabbccdd-eeff-4011-8223-445566778899" }),
    }));

    expect(mocks.getMyLeadsQueueRow).toHaveBeenCalledWith({
      memberId: "owner-1",
      propertyId: "aabbccdd-eeff-4011-8223-445566778899",
    });
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({ initialMemberId: "owner-1", selectedLead: { status: "unavailable" } });
  });

  it("keeps an archived deep-linked lead in a neutral terminal state after reload", async () => {
    mocks.getMyLeadsQueueRow.mockResolvedValue({ status: "unavailable", reason: "archived" });

    renderPage(await MyLeadsPage({
      searchParams: Promise.resolve({ lead: "aabbccdd-eeff-4011-8223-445566778899" }),
    }));

    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({
        selectedLead: {
          status: "terminal",
          message: "This lead is archived and is unavailable in My Leads.",
        },
      });
  });

  it.each([true, false])("defaults an owner to their own profile when Acquisitions enabled is %s", async (acquisitionsEnabled) => {
    const ownerViewer = { ...viewer, userId: "owner-1", isOwner: true };
    const ownerRoster: AcquisitionRoster = {
      ...baseRoster,
      isOwner: true,
      members: [
        ...baseRoster.members,
        { id: "owner-1", label: "Owner", role: "owner", acquisitionsEnabled, active: true, hasHistory: false },
      ],
    };
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      { ...activeAcquisitionsMembership, user_id: "owner-1", role: "owner", acquisitions_enabled: acquisitionsEnabled },
    ]);
    mocks.getAcquisitionRoster.mockResolvedValue({ viewer: ownerViewer, roster: ownerRoster });

    expect(renderPage(await MyLeadsPage())).toContain("my-leads-client");

    expect(mocks.getAcquisitionQueue).toHaveBeenCalledWith({ memberId: "owner-1" });
    expect(mocks.getAcquisitionKpis).toHaveBeenCalledWith({ memberId: "owner-1", period: "today" });
    expect(mocks.listMyLeadsInDrip).toHaveBeenCalledWith("owner-1");
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0])
      .toMatchObject({ initialMemberId: "owner-1", viewer: ownerViewer });
  });

  it("passes the Dialpad panel bootstrap to the client only for the session's own org and rep", async () => {
    const bootstrap = {
      connectionId: "c-1",
      allowedOrigins: ["https://dialpad.com"],
      binding: { status: "none" },
      grants: [],
    };
    mocks.loadDialpadPanelBootstrap.mockResolvedValue(bootstrap);

    renderPage(await MyLeadsPage());

    expect(mocks.loadDialpadPanelBootstrap).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      userId: "user-1",
    });
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({ dialpad: bootstrap });
  });

  it("keeps the existing calling flow when the Dialpad bootstrap fails", async () => {
    mocks.loadDialpadPanelBootstrap.mockRejectedValue(new Error("db down"));

    const html = renderPage(await MyLeadsPage());

    expect(html).toContain("my-leads-client");
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({ dialpad: null });
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });
});
