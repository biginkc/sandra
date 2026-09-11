import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const usePathname = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ usePathname }));

import { DashboardMobileNav, DashboardSidebar } from "./dashboard-sidebar";

beforeEach(() => {
  usePathname.mockReturnValue("/dashboard");
});

describe("DashboardMobileNav", () => {
  it("keeps the Primary nav contract and gives every narrow link a 44px target", () => {
    render(<DashboardMobileNav />);

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("py-1");
    expect(nav.className).toContain("overflow-x-auto");

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(12);
    for (const link of links) {
      expect(link.className).toContain("shrink-0");
      expect(link.className).toContain("whitespace-nowrap");
      expect(link.className).toContain("min-h-11");
      expect(link.className).toContain("min-w-11");
    }

    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute(
      "href",
      "/messages",
    );
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute(
      "href",
      "/jobs",
    );
    expect(screen.getByRole("link", { name: "My Leads" })).toHaveAttribute(
      "href",
      "/my-leads",
    );
  });

  it("keeps the My Leads badge scoped to the signed-in user and hides the link when gated", () => {
    usePathname.mockReturnValue("/my-leads");
    const { rerender } = render(
      <DashboardSidebar initialAcquisitionBadge={7} />,
    );

    const myLeads = screen.getByRole("link", { name: "My Leads" });
    expect(myLeads).toHaveAttribute("href", "/my-leads");
    expect(myLeads).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("my-leads-badge")).toHaveTextContent("7");

    rerender(<DashboardSidebar showMyLeads={false} initialAcquisitionBadge={99} />);
    expect(screen.queryByRole("link", { name: "My Leads" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("my-leads-badge")).not.toBeInTheDocument();
  });
});
