import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCallerMembershipsOrThrow: vi.fn(),
  getAcquisitionRoster: vi.fn(),
  getAcquisitionQueue: vi.fn(),
  getAcquisitionKpis: vi.fn(),
  MyLeadsClient: vi.fn(() => <div data-testid="my-leads-client" />),
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
});
