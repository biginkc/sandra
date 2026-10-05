import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const usePathname = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ usePathname }));

import { DashboardMobileNav, DashboardSidebar } from "./dashboard-sidebar";
import { SOFTPHONE_DISPOSITIONS } from "@/lib/dialer/dispositions";
import { OUTREACH_DISPOSITION_LABELS } from "@/lib/presentation/system-labels";

beforeEach(() => {
  usePathname.mockReturnValue("/dashboard");
});

describe("DashboardMobileNav", () => {
  it("calls the sequence route Drips in both navigation variants", () => {
    const { unmount } = render(<DashboardSidebar />);
    expect(screen.getByRole("link", { name: "Drips" })).toHaveAttribute("href", "/sequences");
    expect(screen.queryByRole("link", { name: /sequences/i })).not.toBeInTheDocument();
    unmount();
    render(<DashboardMobileNav />);
    expect(screen.getByRole("link", { name: "Drips" })).toHaveAttribute("href", "/sequences");
  });

  it("hides callbacks with the restricted shared workspace",()=>{
    render(<DashboardSidebar showMessagesAndLeads={false}/>);
    expect(screen.queryByRole("link",{name:"Norma callbacks"})).not.toBeInTheDocument();
  });
  it("keeps disposition display labels on drip wording", () => {
    expect(SOFTPHONE_DISPOSITIONS.find((item) => item.value === "needs_sequence")?.label).toBe("Needs drip");
    expect(OUTREACH_DISPOSITION_LABELS.needs_sequence).toBe("Needs drip");
  });
  it("keeps the Primary nav contract and gives every narrow link a 44px target", () => {
    render(<DashboardMobileNav />);

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("py-1");
    expect(nav.className).toContain("overflow-x-auto");

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(13);
    expect(screen.getByRole("link", { name: "Norma callbacks" })).toHaveAttribute("href", "/norma/callbacks");
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

  it("hides Messages and the Leads board together for restricted members", () => {
    render(<DashboardSidebar showMessagesAndLeads={false} />);

    expect(screen.queryByRole("link", { name: "Messages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Leads" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "My Leads" })).toHaveAttribute(
      "href",
      "/my-leads",
    );
  });
});
