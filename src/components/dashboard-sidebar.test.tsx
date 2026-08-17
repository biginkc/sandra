import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const usePathname = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ usePathname }));

import { DashboardMobileNav } from "./dashboard-sidebar";

beforeEach(() => {
  usePathname.mockReturnValue("/dashboard");
});

describe("DashboardMobileNav", () => {
  it("keeps the Primary nav contract and gives every narrow link a 44px target", () => {
    render(<DashboardMobileNav />);

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).toContain("py-1");

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(11);
    for (const link of links) {
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
  });
});
