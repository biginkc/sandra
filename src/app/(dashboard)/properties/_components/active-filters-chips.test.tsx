import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeFilters, newBlockId } from "@/lib/prospects/filter-schema";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => "/properties",
}));

import { ActiveFiltersChips } from "./active-filters-chips";

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  window.history.replaceState({}, "", "/properties");
});

describe("ActiveFiltersChips", () => {
  it("renders nothing when blocks empty", () => {
    const { container } = render(<ActiveFiltersChips />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one chip per configured block with label+summary", () => {
    const filterState = {
      v: 1 as const,
      blocks: [
        { id: newBlockId(), kind: "vacancy" as const, tri: "yes" as const },
        { id: newBlockId(), kind: "list_count" as const, range: { min: 2, max: null } },
      ],
    };
    const encoded = encodeFilters(filterState);
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    render(<ActiveFiltersChips />);
    expect(screen.getByText(/Vacancy: Yes/i)).toBeInTheDocument();
    expect(screen.getByText(/List Count: ≥ 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear all/i })).toBeInTheDocument();
  });

  it("clicking × removes that block (router.replace called, block not in new URL)", async () => {
    const user = userEvent.setup();
    const id = newBlockId();
    const filterState = {
      v: 1 as const,
      blocks: [{ id, kind: "vacancy" as const, tri: "yes" as const }],
    };
    const encoded = encodeFilters(filterState);
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    render(<ActiveFiltersChips />);
    await user.click(screen.getByLabelText(/Remove Vacancy filter/i));
    expect(replace).toHaveBeenCalled();
    const [url] = replace.mock.calls[0] as [string, ...unknown[]];
    // single block removed → empty stack → strip param
    expect(url).not.toContain("filters=");
  });

  it("Clear all fires clearAll → URL strips ?filters=", async () => {
    const user = userEvent.setup();
    const filterState = {
      v: 1 as const,
      blocks: [
        { id: "a", kind: "vacancy" as const, tri: "yes" as const },
        { id: "b", kind: "absentee" as const, tri: "yes" as const },
      ],
    };
    const encoded = encodeFilters(filterState);
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    render(<ActiveFiltersChips />);
    await user.click(screen.getByRole("button", { name: /Clear all/i }));
    expect(replace).toHaveBeenCalled();
    const [url] = replace.mock.calls[0] as [string, ...unknown[]];
    expect(url).not.toContain("filters=");
  });
});
