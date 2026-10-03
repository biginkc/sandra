import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getAcquisitionRoster: vi.fn(),
  getAcquisitionQueue: vi.fn(),
  getAcquisitionKpis: vi.fn(),
  listMyLeadsInDrip: vi.fn(),
  MyLeadsClient: vi.fn(() => <div data-testid="my-leads-client" />),
  loadDialpadPanelBootstrap: vi.fn(),
  reportError: vi.fn(),
  property: { data: null as unknown, error: null as unknown },
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
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const chain = {
      from: () => chain,
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      maybeSingle: async () => mocks.property,
    };
    return chain;
  }),
}));
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

    const html = renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("My Leads is disabled for this organization.");
    expect(html).not.toContain("my-leads-client");
    expect(mocks.getAcquisitionQueue).not.toHaveBeenCalled();
    expect(mocks.getAcquisitionKpis).not.toHaveBeenCalled();
  });

  it("renders a retryable unavailable state for a known Acquisitions roster failure", async () => {
    const internalMessage = "database connection details";
    mocks.getAcquisitionRoster.mockRejectedValue(new Error(internalMessage));

    const html = renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

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

    const html = renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("My Leads is disabled for this organization.");
    expect(html).not.toContain("internal detail");
    expect(html).not.toContain('href="/my-leads"');
  });

  it("renders unavailable when a membership lookup has multiple active organizations", async () => {
    mocks.getCallerMembershipsOrThrow.mockResolvedValue([
      activeAcquisitionsMembership,
      { ...activeAcquisitionsMembership, org_id: "org-2" },
    ]);

    const html = renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

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

    await expect(MyLeadsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("notFound");
    expect(mocks.getAcquisitionQueue).not.toHaveBeenCalled();
  });

  it("keeps the authorized queue path for an active Acquisitions member", async () => {
    const html = renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

    expect(mocks.getAcquisitionQueue).toHaveBeenCalledWith({
      memberId: "user-1",
    });
    expect(mocks.getAcquisitionKpis).toHaveBeenCalledWith({
      memberId: "user-1",
      period: "today",
    });
    expect(html).toContain("my-leads-client");
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

    expect(renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }))).toContain("my-leads-client");

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

    renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

    expect(mocks.loadDialpadPanelBootstrap).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      userId: "user-1",
    });
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({ dialpad: bootstrap });
  });

  it("keeps the existing calling flow when the Dialpad bootstrap fails", async () => {
    mocks.loadDialpadPanelBootstrap.mockRejectedValue(new Error("db down"));

    const html = renderPage(await MyLeadsPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("my-leads-client");
    expect((mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({ dialpad: null });
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  describe("lead deep link", () => {
    const leadId = "11111111-1111-4111-8111-111111111111";
    const clientProps = () => (mocks.MyLeadsClient.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0];

    it("leaves the rep's queue unfiltered and focuses the lead", async () => {
      mocks.property = { data: { id: leadId, address: " 12 Oak St ", assigned_user_id: "user-1" }, error: null };

      renderPage(await MyLeadsPage({ searchParams: Promise.resolve({ lead: leadId }) }));

      expect(mocks.getAcquisitionQueue).toHaveBeenCalledWith({ memberId: "user-1" });
      expect(clientProps()).toMatchObject({
        initialMemberId: "user-1",
        focus: { propertyId: leadId, memberId: "user-1", notice: null },
      });
      expect(clientProps()?.initialSearch).toBeUndefined();
    });

    it("opens an owner on the assigned rep's queue", async () => {
      mocks.getAcquisitionRoster.mockResolvedValue({
        viewer: { ...viewer, userId: "owner-1", isOwner: true },
        roster: { ...baseRoster, isOwner: true, members: [...baseRoster.members, { ...baseRoster.members[0], id: "owner-1", role: "owner" }] },
      });
      mocks.property = { data: { id: leadId, address: "12 Oak St", assigned_user_id: "user-1" }, error: null };

      renderPage(await MyLeadsPage({ searchParams: Promise.resolve({ lead: leadId }) }));

      expect(clientProps()).toMatchObject({ initialMemberId: "user-1", focus: { propertyId: leadId, memberId: "user-1" } });
    });

    it("explains when a rep opens a lead assigned to someone else", async () => {
      mocks.property = { data: { id: leadId, address: "12 Oak St", assigned_user_id: "user-2" }, error: null };

      renderPage(await MyLeadsPage({ searchParams: Promise.resolve({ lead: leadId }) }));

      expect(mocks.getAcquisitionQueue).toHaveBeenCalledWith({ memberId: "user-1" });
      expect(clientProps()).toMatchObject({ focus: { propertyId: null, notice: expect.stringContaining("another rep") } });
    });

    it("ignores a malformed lead id", async () => {
      renderPage(await MyLeadsPage({ searchParams: Promise.resolve({ lead: "not-a-uuid" }) }));

      expect(clientProps()).toMatchObject({ focus: null });
    });
  });
});
