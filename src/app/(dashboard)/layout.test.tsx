import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ memberships: vi.fn(), roster: vi.fn() }));
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
vi.mock("@/components/notifications-bell", () => ({ NotificationsBell: () => null }));

import { DashboardSidebar, DashboardMobileNav } from "@/components/dashboard-sidebar";
import DashboardLayout from "./layout";

function navigationProps(node: ReactNode): Array<Record<string, unknown>> {
  if (Array.isArray(node)) return node.flatMap(navigationProps);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === DashboardSidebar || node.type === DashboardMobileNav) return [node.props];
  return navigationProps(node.props.children);
}

beforeEach(() => {
  vi.clearAllMocks();
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
