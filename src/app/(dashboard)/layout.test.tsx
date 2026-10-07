import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memberships: vi.fn(), roster: vi.fn(), callingConfig: vi.fn(), dialpadRoute: vi.fn() }));
vi.mock("@/lib/dialpad-cti/call-route-server", () => ({ getDialpadCallRoute: mocks.dialpadRoute }));
vi.mock("@/components/dialpad/dialpad-call-provider", () => ({ DialpadCallProvider: () => null }));
vi.mock("@/lib/direct-calling/actions", () => ({ getCallingConfigForCurrentUser: mocks.callingConfig }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "rep", email: "rep@example.test" } } }) } }) }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships: mocks.memberships }));
vi.mock("@/lib/my-leads/queries", () => ({ getAcquisitionRoster: mocks.roster, getAcquisitionBadge: async () => null }));
vi.mock("@/lib/recordings/data", () => ({ recordingViewer: async () => null }));
vi.mock("@/lib/auth/allowlist", () => ({ isAdminEmail: () => false }));
vi.mock("./my-leads/nav-actions", () => ({ refreshMyLeadsBadge: vi.fn() }));
vi.mock("@/components/softphone/softphone-provider", () => ({ SoftphoneProvider: () => null, SoftphoneHeaderButton: () => null }));
vi.mock("@/components/search/global-search-provider", () => ({ GlobalSearchProvider: () => null }));
vi.mock("@/components/search/global-search-trigger", () => ({ GlobalSearchTrigger: () => null }));
vi.mock("@/components/connection-banner", () => ({ ConnectionBanner: () => null }));
vi.mock("@/components/dashboard-admin-nav", () => ({ DashboardAdminNav: () => null }));
vi.mock("@/components/dashboard-sidebar", () => ({ DashboardSidebar: () => null, DashboardMobileNav: () => null }));
vi.mock("@/components/error-boundary", () => ({ ErrorBoundary: () => null }));
vi.mock("@/components/job-failure-notifier", () => ({ JobFailureNotifier: () => null }));
vi.mock("@/components/norma-connected-notifier", () => ({ NormaConnectedNotifier: () => null }));
vi.mock("@/components/notifications-bell", () => ({ NotificationsBell: () => null }));

import { DashboardSidebar, DashboardMobileNav } from "@/components/dashboard-sidebar";
import { SoftphoneProvider } from "@/components/softphone/softphone-provider";
import { DialpadCallProvider } from "@/components/dialpad/dialpad-call-provider";
import DashboardLayout from "./layout";

function navigationProps(node: ReactNode): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(navigationProps);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === DashboardSidebar || node.type === DashboardMobileNav) return [node.props];
  return navigationProps(node.props.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callingConfig.mockResolvedValue({ transport: "default" });
  mocks.dialpadRoute.mockResolvedValue("softphone");
  mocks.memberships.mockResolvedValue([{ user_id: "rep", org_id: "org", role: "member", acquisitions_enabled: true, access_status: "active" }]);
});

it.each(["roster unavailable", "rollout disabled"])("retains My Leads in both navigation surfaces when %s", async (state) => {
  if (state === "roster unavailable") mocks.roster.mockRejectedValue(new Error("roster unavailable"));
  else mocks.roster.mockResolvedValue({ viewer: { userId: "rep", isOwner: false }, roster: { settings: { enabled: false }, members: [{ id: "rep", active: true, acquisitionsEnabled: true }] } });
  const nav = navigationProps(await DashboardLayout({ children: <div>Page</div> }));
  expect(nav).toHaveLength(2);
  for (const props of nav) expect(props).toMatchObject({ showMyLeads: true, showMessagesAndLeads: false });
});

it("does not infer Acquisitions access when both membership and roster lookups fail", async () => {
  mocks.memberships.mockRejectedValue(new Error("membership unavailable"));
  mocks.roster.mockRejectedValue(new Error("roster unavailable"));
  const nav = navigationProps(await DashboardLayout({ children: <div>Page</div> }));
  expect(nav).toHaveLength(2);
  for (const props of nav) expect(props).toMatchObject({ showMyLeads: false, showMessagesAndLeads: false });
});

function softphoneConfig(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(softphoneConfig).find((value) => value !== undefined);
  if (!isValidElement<{ children?: ReactNode; callingConfig?: unknown }>(node)) return undefined;
  if (node.type === SoftphoneProvider) return node.props.callingConfig;
  return softphoneConfig(node.props.children);
}

it("passes the server-resolved calling config to the softphone", async () => {
  mocks.roster.mockResolvedValue(null);
  mocks.callingConfig.mockResolvedValue({ transport: "telnyx_direct" });
  expect(softphoneConfig(await DashboardLayout({ children: <div>Page</div> }))).toEqual({ transport: "telnyx_direct" });
});

it("falls back to the default calling config when resolution fails", async () => {
  mocks.roster.mockResolvedValue(null);
  mocks.callingConfig.mockRejectedValue(new Error("config unavailable"));
  expect(softphoneConfig(await DashboardLayout({ children: <div>Page</div> }))).toEqual({ transport: "default" });
});

function dialpadEnabled(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(dialpadEnabled).find((value) => value !== undefined);
  if (!isValidElement<{ children?: ReactNode; enabled?: boolean }>(node)) return undefined;
  if (node.type === DialpadCallProvider) return node.props.enabled;
  return dialpadEnabled(node.props.children);
}

it.each([["softphone", false], ["dialpad", true]] as const)("derives the Call route on the server (%s)", async (route, enabled) => {
  mocks.dialpadRoute.mockResolvedValue(route);
  expect(dialpadEnabled(await DashboardLayout({ children: <div>Page</div> }))).toBe(enabled);
  expect(mocks.dialpadRoute).toHaveBeenCalledWith("org", "rep", true);
});

it("passes acquisitions membership to the route resolver (false for a non-acquisitions member)", async () => {
  mocks.memberships.mockResolvedValue([{ user_id: "rep", org_id: "org", role: "member", acquisitions_enabled: false, access_status: "active" }]);
  await DashboardLayout({ children: <div>Page</div> });
  expect(mocks.dialpadRoute).toHaveBeenCalledWith("org", "rep", false);
});

it.each([
  ["owner", true, true],
  ["owner", false, false],
  ["member", true, true],
] as const)("route resolver gets acquisitions=%s/%s -> %s", async (role, enabled, expected) => {
  mocks.memberships.mockResolvedValue([{ user_id: "rep", org_id: "org", role, acquisitions_enabled: enabled, access_status: "active" }]);
  await DashboardLayout({ children: <div>Page</div> });
  expect(mocks.dialpadRoute).toHaveBeenCalledWith("org", "rep", expected);
});

it("keeps the softphone route when the viewer has no single organization", async () => {
  mocks.memberships.mockResolvedValue([]);
  expect(dialpadEnabled(await DashboardLayout({ children: <div>Page</div> }))).toBe(false);
  expect(mocks.dialpadRoute).not.toHaveBeenCalled();
});
