import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeFilters, newBlockId } from "@/lib/prospects/filter-schema";

const { replace, refresh, mockCreateSavedFilter, toastError, toastSuccess } =
  vi.hoisted(() => ({
    replace: vi.fn(),
    refresh: vi.fn(),
    mockCreateSavedFilter: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => "/properties",
}));

vi.mock("@/app/(dashboard)/properties/_actions/saved-filters", () => ({
  createSavedFilter: mockCreateSavedFilter,
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

import { ActiveFiltersChips } from "./active-filters-chips";

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  mockCreateSavedFilter.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  window.history.replaceState({}, "", "/properties");
});

describe("ActiveFiltersChips", () => {
  it("renders nothing when blocks empty", () => {
    const { container } = render(<ActiveFiltersChips />);
    expect(container.firstChild).toBeNull();
  });

  it("does not render Save filter when blocks are empty even with save props", () => {
    const { container } = render(
      <ActiveFiltersChips orgId="org-1" currentBlocks={[]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Save filter/i }),
    ).not.toBeInTheDocument();
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
    render(
      <ActiveFiltersChips orgId="org-1" currentBlocks={filterState.blocks} />,
    );
    expect(screen.getByText(/Vacancy: Yes/i)).toBeInTheDocument();
    expect(screen.getByText(/List Count: ≥ 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clear all/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save filter/i })).toBeInTheDocument();
  });

  it("guards empty preset names without creating a saved filter", async () => {
    const user = userEvent.setup();
    const filterState = {
      v: 1 as const,
      blocks: [{ id: newBlockId(), kind: "vacancy" as const, tri: "yes" as const }],
    };
    const encoded = encodeFilters(filterState);
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    render(
      <ActiveFiltersChips orgId="org-1" currentBlocks={filterState.blocks} />,
    );

    await user.click(screen.getByRole("button", { name: /Save filter/i }));
    await user.click(screen.getByRole("button", { name: /^Save$/i }));

    expect(toastError).toHaveBeenCalledWith("Please enter a preset name.");
    expect(mockCreateSavedFilter).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("creates a starred preset and refreshes so Quick Filters can repaint", async () => {
    const user = userEvent.setup();
    mockCreateSavedFilter.mockResolvedValue({ ok: true, data: { id: "preset-1" } });
    const filterState = {
      v: 1 as const,
      blocks: [{ id: newBlockId(), kind: "vacancy" as const, tri: "yes" as const }],
    };
    const encoded = encodeFilters(filterState);
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    render(
      <ActiveFiltersChips orgId="org-1" currentBlocks={filterState.blocks} />,
    );

    await user.click(screen.getByRole("button", { name: /Save filter/i }));
    await user.type(screen.getByLabelText(/Filter preset name/i), "VA Hot List");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(mockCreateSavedFilter).toHaveBeenCalledWith({
        orgId: "org-1",
        name: "VA Hot List",
        filtersJson: { v: 1, blocks: filterState.blocks },
        starred: true,
      });
    });
    expect(toastSuccess).toHaveBeenCalledWith('Saved preset "VA Hot List".');
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Save filter/i })).toBeInTheDocument();
  });

  it("ignores rapid duplicate submits while a save is in flight", async () => {
    const user = userEvent.setup();
    mockCreateSavedFilter.mockImplementation(
      () => new Promise(() => undefined),
    );
    const filterState = {
      v: 1 as const,
      blocks: [{ id: newBlockId(), kind: "vacancy" as const, tri: "yes" as const }],
    };
    const encoded = encodeFilters(filterState);
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    render(
      <ActiveFiltersChips orgId="org-1" currentBlocks={filterState.blocks} />,
    );

    await user.click(screen.getByRole("button", { name: /Save filter/i }));
    await user.type(screen.getByLabelText(/Filter preset name/i), "No Dupes");
    const form = screen.getByTestId("save-filter-form");
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(mockCreateSavedFilter).toHaveBeenCalledTimes(1);
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
